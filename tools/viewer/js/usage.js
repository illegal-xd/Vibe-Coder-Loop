/* 用量视图：从统一 Node 服务实时读取用量归档，并按本地自然日切换统计维度。
   - 数据源：GET api/usage（tools/viewer/server.mjs 每次请求都重新读取 JSONL 归档）
   - 每 15 秒静默刷新；视图不可见或页面隐藏时暂停，重新可见时立即刷新
   输入含缓存、输出含 reasoning 的口径已在服务端归一，这里只做窗口聚合与渲染。 */

(function (global) {
  'use strict';

  var REFRESH_MS = 15000;

  // Canonical rows mirrored from server.mjs. Older snapshots only list the
  // first three strategies; append the missing rows so a stale snapshot still
  // renders the new strategies at zero instead of hiding them.
  var DEFAULT_STRATEGIES = [
    { key: 'deduplication', label: 'Deduplication' },
    { key: 'error_purge', label: 'Error Purge' },
    { key: 'supersede_writes', label: 'Supersede Writes' },
    { key: 'tool_descriptions', label: 'Tool Descriptions' },
    { key: 'compact_read', label: 'Compact Read' },
    { key: 'line_range_edit', label: 'Line Range Edit' }
  ];

  /* Prompt region each strategy's removals live in. Mirrors server.mjs so a
     stale snapshot without `scope` still groups correctly. */
  var SCOPE_OF = {
    deduplication: 'messages',
    error_purge: 'messages',
    supersede_writes: 'messages',
    tool_descriptions: 'tool_schema',
    compact_read: 'tool_result',
    line_range_edit: 'model_output'
  };

  /* Scopes are grouped, never summed into one share: `tool_schema` is a
     constant discount re-applied to every request, the rest are events. */
  var SCOPE_GROUPS = {
    tool_schema: 'prefix'
  };

  /* Relative price of a cache-read input token (未缓存输入 = 1). Used only for
     the optional bill-weighted estimate; the token counts stay unweighted. */
  var CACHE_READ_RATIO = 0.1;

  function groupOf(strategy) {
    var scope = (strategy && strategy.scope) || SCOPE_OF[strategy && strategy.key] || 'messages';
    return SCOPE_GROUPS[scope] === 'prefix' ? 'prefix' : 'event';
  }

  /* Discount `removed` by the measured cache-read share: a saving taken out of
     the cached prefix is billed at the cache-read price, not the full price.
     This is an approximation — it assumes the removed tokens sit in the same
     cached/uncached proportion as the whole request. */
  function billWeighted(result) {
    if (!result || !(result.input > 0) || !(result.removed > 0)) return 0;
    var ratio = Math.min(1, Math.max(0, (result.cached || 0) / result.input));
    return result.removed * ((1 - ratio) + ratio * CACHE_READ_RATIO);
  }

  // 策略标题后的简短中文说明；只用于展示，不参与聚合。
  var STRATEGY_NOTES = {
    deduplication: '重复只读结果去重',
    error_purge: '过期工具错误裁剪',
    supersede_writes: '写操作上下文覆盖',
    tool_descriptions: '内置工具描述压缩',
    compact_read: 'read 输出压缩',
    line_range_edit: 'edit 行区间展开'
  };

  // 固定颜色与稳定排序的兜底顺序；展示顺序另按贡献度动态排序。
  var STRATEGY_ORDER = {};
  DEFAULT_STRATEGIES.forEach(function (item, index) {
    STRATEGY_ORDER[item.key] = index;
  });

  function sortStrategies(strategies) {
    return (Array.isArray(strategies) ? strategies.slice() : []).sort(function (left, right) {
      var byTokens = (right.tokens || 0) - (left.tokens || 0);
      if (byTokens !== 0) return byTokens;
      var byItems = (right.removedItems || 0) - (left.removedItems || 0);
      if (byItems !== 0) return byItems;
      var leftOrder = STRATEGY_ORDER[left.key];
      var rightOrder = STRATEGY_ORDER[right.key];
      return (leftOrder === undefined ? 99 : leftOrder) -
        (rightOrder === undefined ? 99 : rightOrder);
    });
  }

  function resolveStrategies(dataStrategies) {
    var list = Array.isArray(dataStrategies) ? dataStrategies.slice() : [];
    DEFAULT_STRATEGIES.forEach(function (item) {
      var exists = list.some(function (candidate) {
        return candidate && candidate.key === item.key;
      });
      if (!exists) list.push({ key: item.key, label: item.label });
    });
    list.forEach(function (item) {
      if (item && (typeof item.scope !== 'string' || item.scope.length === 0)) {
        item.scope = SCOPE_OF[item.key] || 'messages';
      }
    });
    return list;
  }

  function boundsFor(mode, now) {
    var year = now.getFullYear();
    var month = now.getMonth();
    var date = now.getDate();
    var todayStart = new Date(year, month, date).getTime();

    if (mode === 'yesterday') {
      return { from: new Date(year, month, date - 1).getTime(), to: todayStart };
    }
    if (mode === 'today') {
      return { from: todayStart, to: now.getTime() + 1 };
    }
    return { from: new Date(year, month, date - 6).getTime(), to: now.getTime() + 1 };
  }

  /* Equal-length window immediately before `bounds`, used by the compare
     toggle. Same local-day arithmetic as boundsFor, so DST stays consistent. */
  function previousBounds(bounds) {
    var length = bounds.to - bounds.from;
    return { from: bounds.from - length, to: bounds.from };
  }

  /* Time buckets for the trend chart: 24 hours for a single day, one bucket
     per local day for the 7-day window. */
  function bucketsFor(mode, bounds, now) {
    var buckets = [];
    var day;
    var start;
    var end;
    var base;
    var hour;
    var hourStart;
    var hourEnd;
    if (mode === 'last7') {
      for (day = 0; day < 7; day += 1) {
        start = new Date(bounds.from);
        start.setDate(start.getDate() + day);
        end = new Date(start);
        end.setDate(end.getDate() + 1);
        buckets.push({
          from: start.getTime(),
          to: end.getTime(),
          label: (start.getMonth() + 1) + '-' + pad(start.getDate())
        });
      }
      return buckets;
    }
    base = new Date(bounds.from);
    base.setHours(0, 0, 0, 0);
    for (hour = 0; hour < 24; hour += 1) {
      hourStart = new Date(base);
      hourStart.setHours(hour, 0, 0, 0);
      hourEnd = new Date(base);
      hourEnd.setHours(hour + 1, 0, 0, 0);
      buckets.push({
        from: hourStart.getTime(),
        to: hourEnd.getTime(),
        label: pad(hour) + ':00'
      });
    }
    return buckets;
  }

  function aggregate(data, mode, now, boundsOverride) {
    var bounds = boundsOverride || boundsFor(mode, now);
    var strategies = resolveStrategies(data.strategies);
    var result = {
      from: bounds.from,
      to: bounds.to,
      requests: 0,
      input: 0,
      output: 0,
      cached: 0,
      removed: 0,
      // Per-scope subtotals: a schema-side saving is not comparable to a
      // message-side one, so the card never charts them as one share.
      scopes: { messages: 0, tool_schema: 0, tool_result: 0, model_output: 0 },
      strategies: strategies.map(function (strategy) {
        return {
          key: strategy.key,
          label: strategy.label,
          scope: strategy.scope || SCOPE_OF[strategy.key] || 'messages',
          tokens: 0,
          removedItems: 0,
          scanned: 0,
          candidates: 0,
          eligible: 0,
          marked: 0,
          requests: 0
        };
      }),
      rows: []
    };

    (data.records || []).forEach(function (record) {
      var timestamp = record[0];
      if (timestamp < bounds.from || timestamp >= bounds.to) return;

      result.rows.push(record);
      result.requests += 1;
      result.input += record[1] || 0;
      result.output += record[2] || 0;
      result.cached += record[3] || 0;
      result.removed += record[4] || 0;
      result.strategies.forEach(function (strategy, index) {
        var row = record[5] && record[5][index];
        if (!row) return;
        strategy.requests += 1;
        strategy.tokens += row[0] || 0;
        strategy.scanned += row[1] || 0;
        strategy.candidates += row[2] || 0;
        strategy.removedItems += row[3] || 0;
        // Older snapshots only have four columns: eligible/marked fall back to
        // the candidate/removed values so the card never invents numbers.
        strategy.eligible += row.length >= 6 ? row[4] || 0 : row[2] || 0;
        strategy.marked += row.length >= 6 ? row[5] || 0 : row[3] || 0;
        result.scopes[strategy.scope] = (result.scopes[strategy.scope] || 0) + (row[0] || 0);
      });
    });

    return result;
  }

  /* One compact row: [at, input, output, cached, removed, strategyRows,
     model, session_id, project]. Older snapshots only carry the first six. */
  function rowField(row, index) {
    return row && typeof row[index] === 'string' ? row[index] : '';
  }

  function shortSession(value) {
    if (!value) return '';
    return value.length > 14 ? value.slice(0, 12) + '…' : value;
  }

  function projectName(value) {
    var parts;
    if (!value) return '';
    parts = String(value).replace(/\/+$/, '').split('/');
    return parts[parts.length - 1] || value;
  }

  /* Group compact rows by model / session / project. The project label comes
     from the injection archive via the server; rows without one are kept as an
     explicit "未关联项目" bucket instead of being dropped. */
  function dimensionRows(rows, dimension) {
    var groups = {};
    var order = [];
    (rows || []).forEach(function (row) {
      var key = dimension === 'model'
        ? (rowField(row, 6) || '未知模型')
        : dimension === 'session'
          ? (rowField(row, 7) || '未知会话')
          : (rowField(row, 8) || '未关联项目');
      var group = groups[key];
      if (!group) {
        group = {
          key: key,
          requests: 0,
          input: 0,
          output: 0,
          cached: 0,
          removed: 0,
          sessionId: ''
        };
        groups[key] = group;
        order.push(key);
      }
      group.requests += 1;
      group.input += row[1] || 0;
      group.output += row[2] || 0;
      group.cached += row[3] || 0;
      group.removed += row[4] || 0;
      if (!group.sessionId && rowField(row, 7)) group.sessionId = row[7];
    });
    return order
      .map(function (key) {
        return groups[key];
      })
      .sort(function (left, right) {
        return right.input - left.input;
      });
  }

  /* Sum rows into fixed time buckets for the trend chart. */
  function bucketTotals(rows, buckets) {
    var totals = buckets.map(function (bucket) {
      return {
        from: bucket.from,
        to: bucket.to,
        label: bucket.label,
        requests: 0,
        input: 0,
        output: 0
      };
    });
    var index;
    (rows || []).forEach(function (row) {
      var at = row[0];
      for (index = 0; index < totals.length; index += 1) {
        if (at >= totals[index].from && at < totals[index].to) {
          totals[index].requests += 1;
          totals[index].input += row[1] || 0;
          totals[index].output += row[2] || 0;
          return;
        }
      }
    });
    return totals;
  }

  /* Compare a metric with the previous window. `betterWhen` decides whether an
     increase reads as an improvement, so a rising cache-hit rate is not shown
     in the same red as a rising token count. */
  function deltaFor(current, previous, betterWhen, kind) {
    var change;
    var tone;
    if (previous === null || previous === undefined || !isFinite(previous)) return null;
    if (kind === 'pp') {
      change = (current - previous) * 100;
      if (!isFinite(change)) return null;
      tone = Math.abs(change) < 0.05 ? 'flat' : (change > 0 ? 'up' : 'down');
      return {
        text: tone === 'flat' ? '持平' : (change > 0 ? '+' : '') + change.toFixed(1) + ' pp',
        tone: tone === 'flat' ? 'flat' : (tone === 'up') === (betterWhen === 'higher') ? 'good' : 'bad'
      };
    }
    if (!(previous > 0)) return null;
    change = (current - previous) / previous;
    if (!isFinite(change)) return null;
    if (Math.abs(change) < 0.005) return { text: '持平', tone: 'flat' };
    return {
      text: (change > 0 ? '+' : '') + (change * 100).toFixed(1) + '%',
      tone: (change > 0) === (betterWhen === 'higher') ? 'good' : 'bad'
    };
  }

  function compactNumber(value, digits) {
    return value.toFixed(digits).replace(/\.0+$|(\.\d*[1-9])0+$/, '$1');
  }

  function formatCompact(value) {
    var thousands;
    if (!isFinite(value)) return '—';
    if (value <= 0) return '0';
    if (value >= 1e9) return compactNumber(value / 1e9, 2) + 'B';
    if (value >= 1e6) return compactNumber(value / 1e6, 2) + 'M';
    if (value >= 1e3) {
      thousands = value / 1e3;
      // Keep one decimal below 10K so 1.2K and 12K both read naturally.
      return (thousands >= 10 ? String(Math.round(thousands)) : compactNumber(thousands, 1)) + 'K';
    }
    return String(Math.round(value));
  }

  function formatPercent(ratio) {
    var text = (ratio * 100).toFixed(1);
    return text.replace(/\.0$/, '') + '%';
  }

  function formatAverage(total, count) {
    if (!count) return '0';
    var average = total / count;
    if (average >= 100) return String(Math.round(average));
    return average.toFixed(1).replace(/\.0$/, '');
  }

  function pad(value) {
    return value < 10 ? '0' + value : String(value);
  }

  function formatTime(ms) {
    var date = new Date(ms);
    return (
      date.getMonth() + 1 + '-' + pad(date.getDate()) + ' ' +
      pad(date.getHours()) + ':' + pad(date.getMinutes())
    );
  }

  function formatClock(ms) {
    var date = ms instanceof Date ? ms : new Date(ms);
    return (
      pad(date.getHours()) + ':' + pad(date.getMinutes()) + ':' + pad(date.getSeconds())
    );
  }

  /**
   * Read the live payload from the unified server.
   * Never throws; returns a discriminated result so the caller can show a
   * precise notice instead of silently rendering an empty card.
   */
  async function loadData() {
    if (typeof global.fetch !== 'function') return { ok: false, data: null, source: 'none' };
    try {
      const response = await global.fetch('api/usage', {
        cache: 'no-store',
        headers: { Accept: 'application/json' }
      });
      if (response.ok) {
        const payload = await response.json();
        if (payload && Array.isArray(payload.records)) {
          return { ok: true, data: payload, source: 'api' };
        }
      }
    } catch (error) {
      // Server stopped or request aborted.
    }
    return { ok: false, data: null, source: 'none' };
  }

  var api = {
    boundsFor: boundsFor,
    previousBounds: previousBounds,
    bucketsFor: bucketsFor,
    bucketTotals: bucketTotals,
    dimensionRows: dimensionRows,
    rowField: rowField,
    shortSession: shortSession,
    projectName: projectName,
    deltaFor: deltaFor,
    aggregate: aggregate,
    sortStrategies: sortStrategies,
    groupOf: groupOf,
    billWeighted: billWeighted,
    CACHE_READ_RATIO: CACHE_READ_RATIO,
    formatCompact: formatCompact,
    formatPercent: formatPercent,
    formatAverage: formatAverage,
    formatTime: formatTime,
    formatClock: formatClock,
    loadData: loadData
  };

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
  }
  if (typeof document === 'undefined') return;

  var notice = document.getElementById('notice');
  var caption = document.getElementById('rangeCaption');
  var strategyList = document.getElementById('strategyList');
  var strategyHint = document.getElementById('strategyHint');
  var strategyTotal = document.getElementById('strategyTotal');
  var inputNote = document.getElementById('mInputNote');
  var rateNote = document.getElementById('mRateNote');
  var removedNote = document.getElementById('mRemovedNote');
  var snapshot = document.getElementById('snapshot');
  var refreshButton = document.getElementById('refreshButton');
  var buttons = Array.prototype.slice.call(document.querySelectorAll('[data-range]'));
  var segmented = document.querySelector('.segmented');
  var thumb = segmented ? segmented.querySelector('.segmented-thumb') : null;
  var metricsEl = document.getElementById('metrics');
  var trendSvg = document.getElementById('trendSvg');
  var trendTip = document.getElementById('trendTip');
  var trendEmpty = document.getElementById('trendEmpty');
  var trendCaption = document.getElementById('trendCaption');
  var trendFocus = document.getElementById('trendFocus');
  var trendFocusText = document.getElementById('trendFocusText');
  var trendClearButton = document.getElementById('trendClearButton');
  var dimensionTabs = document.getElementById('dimensionTabs');
  var dimensionButtons = dimensionTabs
    ? Array.prototype.slice.call(dimensionTabs.querySelectorAll('[data-dim]'))
    : [];
  var breakdownRows = document.getElementById('breakdownRows');
  var breakdownEmpty = document.getElementById('breakdownEmpty');
  var compareToggle = document.getElementById('compareToggle');
  var healthButton = document.getElementById('healthButton');
  var healthPopover = document.getElementById('healthPopover');

  var SVG_NS = 'http://www.w3.org/2000/svg';

  var state = {
    mode: 'today',
    now: new Date(),
    data: null,
    loadedAt: null,
    loading: false,
    timer: null,
    source: 'none',
    compare: false,
    dimension: 'model',
    // A clicked trend bucket narrows the metrics and breakdown to that slice;
    // the trend chart itself always shows the full window.
    focusBucket: null,
    trendTotals: [],
    renderSignature: null,
    initialLoading: true
  };

  function svgEl(name, attrs) {
    var node = document.createElementNS(SVG_NS, name);
    Object.keys(attrs || {}).forEach(function (key) {
      node.setAttribute(key, attrs[key]);
    });
    return node;
  }

  /* Trend chart: input/output stacked bars per hour (single day) or per day
     (7-day window). Clicking a bucket narrows the metrics and breakdown to it;
     the chart itself keeps showing the full window. */
  function renderTrend(totals) {
    var width = 100;
    var height = 40;
    var max = 0;
    var focusFrom = state.focusBucket ? state.focusBucket.from : null;
    var count = totals.length;
    var slot;
    var barWidth;

    if (!trendSvg) return;

    totals.forEach(function (total) {
      max = Math.max(max, total.input + total.output);
    });
    state.trendCount = count;

    trendSvg.setAttribute('viewBox', '0 0 ' + width + ' ' + height);
    trendSvg.setAttribute('preserveAspectRatio', 'none');
    trendSvg.textContent = '';
    trendSvg.classList.toggle('is-empty', max <= 0);
    if (trendEmpty) trendEmpty.hidden = max > 0;

    // Hairlines as thin rects: preserveAspectRatio="none" would warp strokes.
    [0, 0.5].forEach(function (ratio) {
      trendSvg.appendChild(
        svgEl('rect', {
          x: 0,
          y: height - 1 - ratio * (height - 2),
          width: width,
          height: 0.35,
          class: 'trend-grid'
        })
      );
    });

    slot = count > 0 ? width / count : width;
    barWidth = Math.max(0.4, Math.min(slot * 0.62, 4));

    totals.forEach(function (total, index) {
      var inputH = max > 0 ? (total.input / max) * (height - 3) : 0;
      var outputH = max > 0 ? (total.output / max) * (height - 3) : 0;
      var x = slot * index + (slot - barWidth) / 2;
      var baseY = height - 1;
      var hit;

      if (focusFrom === total.from) {
        trendSvg.appendChild(
          svgEl('rect', {
            x: slot * index,
            y: 0,
            width: slot,
            height: height,
            class: 'trend-focus-band'
          })
        );
      }
      if (total.input > 0) {
        trendSvg.appendChild(
          svgEl('rect', {
            x: x,
            y: baseY - inputH,
            width: barWidth,
            height: Math.max(0.3, inputH),
            class: 'trend-bar trend-bar-input'
          })
        );
      }
      if (total.output > 0) {
        trendSvg.appendChild(
          svgEl('rect', {
            x: x,
            y: baseY - inputH - outputH,
            width: barWidth,
            height: Math.max(0.3, outputH),
            class: 'trend-bar trend-bar-output'
          })
        );
      }

      hit = svgEl('rect', {
        x: slot * index,
        y: 0,
        width: slot,
        height: height,
        class: 'trend-hit'
      });
      hit.setAttribute('data-index', String(index));
      trendSvg.appendChild(hit);
    });
    // Hover/click is delegated on the SVG root (bound once): three listeners
    // per bucket would be torn down and rebuilt on every refresh.
    state.trendTotals = totals;

    trendSvg.setAttribute(
      'aria-label',
      '时间分布：' + count + ' 个时段，' + (max > 0 ? '峰值 ' + formatCompact(max) + ' token' : '无记录')
    );
    if (trendCaption) {
      trendCaption.textContent = max > 0
        ? '峰值 ' + formatCompact(max) + ' token / ' + (state.mode === 'last7' ? '日' : '时')
        : '该区间没有记录';
    }
  }

  function showTrendTip(total, index) {
    var count;
    var left;
    var line;
    var detail;
    if (!trendTip) return;
    count = state.trendCount || 1;
    left = ((index + 0.5) / count) * 100;
    trendTip.hidden = false;
    trendTip.textContent = '';
    line = document.createElement('strong');
    line.textContent = total.label + ' · ' + total.requests + ' 次';
    detail = document.createElement('span');
    detail.textContent =
      '输入 ' + formatCompact(total.input) + ' · 输出 ' + formatCompact(total.output);
    trendTip.appendChild(line);
    trendTip.appendChild(detail);
    trendTip.style.left = Math.min(86, Math.max(14, left)) + '%';
  }

  function hideTrendTip() {
    if (trendTip) trendTip.hidden = true;
  }

  /* Resolve the bucket index from a delegated event inside the trend SVG. */
  function trendHitIndex(event) {
    var node = event.target;
    while (node && node !== trendSvg) {
      if (node.nodeType === 1 && node.getAttribute && node.getAttribute('data-index') !== null) {
        return Number(node.getAttribute('data-index'));
      }
      node = node.parentNode;
    }
    return -1;
  }

  function toggleFocusBucket(total) {
    if (state.focusBucket && state.focusBucket.from === total.from) {
      state.focusBucket = null;
    } else {
      state.focusBucket = { from: total.from, to: total.to, label: total.label };
    }
    hideTrendTip();
    render();
  }

  function drillToSession(sessionId) {
    if (!sessionId) return;
    if (global.VibeViewer && typeof global.VibeViewer.navigate === 'function') {
      global.VibeViewer.navigate('timeline');
    }
    if (
      global.PromptInjectionViewer &&
      typeof global.PromptInjectionViewer.selectSession === 'function'
    ) {
      global.PromptInjectionViewer.selectSession(sessionId);
    }
  }

  function numberCell(value, text) {
    var cell = document.createElement('td');
    cell.className = 'num';
    cell.textContent = text;
    if (value > 0) cell.title = Math.round(value).toLocaleString('en-US');
    return cell;
  }

  function buildBreakdownRow(group, totalInput) {
    var row = document.createElement('tr');
    var nameCell = document.createElement('td');
    var display = group.key;
    var share = totalInput > 0 ? group.input / totalInput : 0;
    var shareCell;
    var bar;
    var fill;
    var text;

    nameCell.className = 'bd-name';
    if (state.dimension === 'session') display = shortSession(group.key);
    if (state.dimension === 'project' && group.key !== '未关联项目') {
      display = projectName(group.key);
    }

    if (state.dimension === 'session' && group.sessionId) {
      var button = document.createElement('button');
      button.type = 'button';
      button.className = 'bd-drill';
      button.textContent = display;
      button.title = '在对话视图中打开 ' + group.sessionId;
      button.addEventListener('click', function () {
        drillToSession(group.sessionId);
      });
      nameCell.appendChild(button);
    } else {
      nameCell.textContent = display;
      nameCell.title = group.key;
    }
    row.appendChild(nameCell);
    row.appendChild(numberCell(group.requests, String(group.requests)));
    row.appendChild(numberCell(group.input, formatCompact(group.input)));
    row.appendChild(numberCell(group.output, formatCompact(group.output)));
    row.appendChild(
      numberCell(group.cached, group.input > 0 ? formatPercent(group.cached / group.input) : '—')
    );
    row.appendChild(numberCell(group.removed, formatCompact(group.removed)));

    shareCell = document.createElement('td');
    shareCell.className = 'num bd-share';
    bar = document.createElement('span');
    bar.className = 'bd-bar';
    fill = document.createElement('i');
    fill.style.width = Math.max(1, Math.min(100, share * 100)) + '%';
    bar.appendChild(fill);
    text = document.createElement('span');
    text.className = 'bd-share-text';
    text.textContent = formatPercent(share);
    shareCell.appendChild(bar);
    shareCell.appendChild(text);
    row.appendChild(shareCell);
    return row;
  }

  function renderBreakdown(result) {
    var groups;
    var totalInput;
    var limit;
    var index;
    if (!breakdownRows) return;
    groups = dimensionRows(result.rows, state.dimension);
    breakdownRows.textContent = '';
    if (!groups.length) {
      if (breakdownEmpty) {
        breakdownEmpty.hidden = false;
        breakdownEmpty.textContent = state.dimension === 'project'
          ? '该区间没有记录，或用量归档里没有可关联的项目。'
          : '该区间没有记录。';
      }
      return;
    }
    totalInput = groups.reduce(function (sum, group) {
      return sum + group.input;
    }, 0);
    limit = Math.min(groups.length, 40);
    for (index = 0; index < limit; index += 1) {
      breakdownRows.appendChild(buildBreakdownRow(groups[index], totalInput));
    }
    if (breakdownEmpty) {
      if (groups.length > limit) {
        breakdownEmpty.hidden = false;
        breakdownEmpty.textContent =
          '按输入排序，仅显示前 ' + limit + ' 项（共 ' + groups.length + ' 项）。';
      } else {
        breakdownEmpty.hidden = true;
      }
    }
  }

  function setDeltaText(id, delta) {
    var node = document.getElementById(id);
    if (!node) return;
    if (!delta) {
      node.hidden = true;
      node.textContent = '';
      node.removeAttribute('data-tone');
      node.removeAttribute('title');
      return;
    }
    node.hidden = false;
    node.textContent = delta.plain ? delta.text : '较上期 ' + delta.text;
    node.dataset.tone = delta.tone;
    node.title = '与上一个等长区间比较';
  }

  function renderDeltas(result, previous) {
    var has = !!(state.compare && previous);
    var noPrev = has && previous.requests === 0;
    var currentRate = result.input > 0 ? result.cached / result.input : 0;
    var previousRate =
      has && previous.input > 0 ? previous.cached / previous.input : 0;

    function pick(delta) {
      if (!has) return null;
      if (noPrev) return { text: '上期无数据', tone: 'flat', plain: true };
      return delta;
    }

    setDeltaText('mInputDelta', pick(deltaFor(result.input, previous && previous.input, 'lower')));
    setDeltaText('mOutputDelta', pick(deltaFor(result.output, previous && previous.output, 'lower')));
    setDeltaText(
      'mRateDelta',
      pick(deltaFor(currentRate, previousRate, 'higher', 'pp'))
    );
    setDeltaText(
      'mRemovedDelta',
      pick(deltaFor(result.removed, previous && previous.removed, 'lower'))
    );
  }

  function renderHealth(health) {
    var rows = [];
    var stats;
    var updated;
    if (!healthPopover) return;
    healthPopover.textContent = '';

    var title = document.createElement('p');
    title.className = 'health-title';
    title.textContent = health && health.ok ? '数据健康' : '数据健康 · 服务不可用';
    healthPopover.appendChild(title);

    if (health && health.checks) {
      rows.push(['用量归档', health.checks.usage]);
      rows.push(['对话归档', health.checks.injection]);
      rows.push(['记忆库', health.checks.memory]);
    }
    rows.forEach(function (entry) {
      var check = entry[1];
      var item = document.createElement('div');
      item.className = 'health-row';
      var name = document.createElement('span');
      name.className = 'health-name';
      name.textContent = entry[0];
      var value = document.createElement('span');
      value.className = 'health-value';
      value.dataset.ok = check && check.exists ? 'yes' : 'no';
      value.textContent = !check
        ? '—'
        : check.exists
          ? (check.isDirectory
            ? '存在'
            : '存在 · ' + Math.max(1, Math.round((check.bytes || 0) / 1024)) + ' KB')
          : '未找到';
      var pathEl = document.createElement('code');
      pathEl.className = 'health-path';
      pathEl.textContent = check ? check.path : '—';
      pathEl.title = check ? check.path : '';
      item.appendChild(name);
      item.appendChild(value);
      item.appendChild(pathEl);
      healthPopover.appendChild(item);
    });

    stats = state.data && state.data.diagnostics;
    updated = document.createElement('p');
    updated.className = 'health-meta';
    var parts = [];
    parts.push('记录 ' + (stats ? stats.records || 0 : 0));
    parts.push('损坏行 ' + (stats ? stats.invalidLines || 0 : 0));
    if (state.data && state.data.sourceFiles) {
      parts.push('源文件 ' + state.data.sourceFiles.length);
    }
    if (state.loadedAt) parts.push('更新 ' + formatClock(state.loadedAt));
    updated.textContent = parts.join(' · ');
    healthPopover.appendChild(updated);

    var hint = document.createElement('p');
    hint.className = 'health-hint';
    hint.textContent = '只读：页面不会写入归档；路径来自本地服务。';
    healthPopover.appendChild(hint);
  }

  async function toggleHealth() {
    var health = null;
    if (!healthPopover || !healthButton) return;
    if (!healthPopover.hidden) {
      closeHealth();
      return;
    }
    healthPopover.hidden = false;
    healthButton.setAttribute('aria-expanded', 'true');
    healthPopover.textContent = '读取中…';
    try {
      var response = await global.fetch('api/health', { cache: 'no-store' });
      if (response.ok) health = await response.json();
    } catch (error) {
      // The popover already shows the unavailable state.
    }
    renderHealth(health);
  }

  function closeHealth() {
    if (!healthPopover || !healthButton) return;
    healthPopover.hidden = true;
    healthButton.setAttribute('aria-expanded', 'false');
  }

  function setSkeleton(loading) {
    if (metricsEl) metricsEl.classList.toggle('is-loading', loading);
    var page = document.querySelector('#view-usage .page');
    if (page) page.classList.toggle('is-initial-loading', loading);
  }

  function setMetric(id, text) {
    var node = document.getElementById(id);
    if (!node) return;
    node.textContent = text;
    node.classList.toggle('is-placeholder', text === '—');
  }

  function setNote(node, text) {
    if (node) node.textContent = text;
  }

  /** Exact value on hover; the visible number stays compact. */
  function setExactTitle(id, value, enabled, suffix) {
    var node = document.getElementById(id);
    if (!node) return;
    if (!enabled || !isFinite(value) || value <= 0) {
      node.removeAttribute('title');
      return;
    }
    node.title =
      Math.round(value).toLocaleString('en-US') + ' token' + (suffix ? '（' + suffix + '）' : '');
  }

  function setNotice(visible) {
    if (!notice) return;
    if (visible) {
      var text = notice.querySelector('.notice-text');
      if (text) {
        text.textContent =
          '无法读取用量数据。启动本地服务后访问：node tools/viewer/server.mjs';
      }
    }
    notice.hidden = !visible;
  }

  function isUsageActive() {
    var view = document.getElementById('view-usage');
    return !!view && view.classList.contains('is-active');
  }

  // Slide the selected pill behind the segmented buttons (Apple-style control).
  // The static `.is-active` background stays as the no-JS fallback; `has-thumb`
  // hands the visual over to the sliding thumb once its geometry is measured.
  function syncSegmentThumb(quiet) {
    if (!segmented || !thumb) return;
    var active = null;
    buttons.forEach(function (button) {
      if (button.dataset.range === state.mode) active = button;
    });
    if (!active || !active.offsetWidth) {
      segmented.classList.remove('has-thumb');
      return;
    }
    // `quiet` applies the first geometry (and resize/refont geometry) without
    // animating: the pill must not grow out of the left edge on page load.
    if (quiet) thumb.style.transition = 'none';
    thumb.style.width = active.offsetWidth + 'px';
    thumb.style.transform = 'translateX(' + active.offsetLeft + 'px)';
    segmented.classList.add('has-thumb');
    if (quiet) {
      void thumb.offsetWidth; // commit this frame, then re-enable motion
      thumb.style.transition = '';
    }
  }

  function renderEmptyState(titleText, noteText) {
    if (!strategyList) return;
    strategyList.textContent = '';
    var box = document.createElement('div');
    box.className = 'strategy-empty';
    var title = document.createElement('p');
    title.className = 'empty-title';
    title.textContent = titleText;
    var note = document.createElement('p');
    note.className = 'empty-note';
    note.textContent = noteText;
    box.appendChild(title);
    box.appendChild(note);
    strategyList.appendChild(box);
  }

  // Flipped faces survive the 15s silent refresh: the grid is rebuilt on every
  // render, so the open/closed state has to live outside the DOM.
  var flippedStrategies = {};

  function applyFlipped(card, strategy, on) {
    flippedStrategies[strategy.key] = on;
    card.classList.toggle('is-flipped', on);
    card.setAttribute('aria-pressed', String(on));
    card.setAttribute(
      'aria-label',
      strategy.label + (on ? '：统计明细，点按查看贡献概览' : '：贡献概览，点按查看统计明细')
    );
    var front = card.querySelector('.scard-front');
    var back = card.querySelector('.scard-back');
    if (front) front.setAttribute('aria-hidden', String(on));
    if (back) back.setAttribute('aria-hidden', String(!on));
  }

  function statRow(label, value, unit, total) {
    var row = document.createElement('div');
    row.className = 'scard-stat' + (total ? ' is-total' : '');
    var term = document.createElement('span');
    term.className = 'scard-stat-label';
    term.textContent = label;
    var detail = document.createElement('span');
    detail.className = 'scard-stat-value';
    detail.textContent = value;
    if (unit) {
      var small = document.createElement('small');
      small.textContent = unit;
      detail.appendChild(small);
    }
    row.appendChild(term);
    row.appendChild(detail);
    return row;
  }

  function createStrategyCard(strategy, index, result, shareBase) {
    var group = groupOf(strategy);
    var colorIndex = STRATEGY_ORDER[strategy.key];
    var color = colorIndex === undefined ? ((index % 6) + 1) : ((colorIndex % 6) + 1);
    // Prefix strategies are a per-request discount, so their ratio is measured
    // against the input they were cut from; event strategies share a base with
    // each other only. Never one denominator for both.
    var prefixRatio = result.input > 0 ? strategy.tokens / result.input : 0;
    var eventRatio = shareBase > 0 ? strategy.tokens / shareBase : 0;
    var sharePercent = group === 'prefix' ? prefixRatio * 100 : eventRatio * 100;
    var shareText = group === 'prefix'
      ? formatPercent(prefixRatio)
      : Math.round(eventRatio * 100) + '%';
    var perRequest = strategy.requests > 0 ? strategy.tokens / strategy.requests : 0;

    var card = document.createElement('article');
    card.className = 'scard s' + color;
    card.tabIndex = 0;
    card.setAttribute('role', 'button');

    var inner = document.createElement('div');
    inner.className = 'scard-inner';

    // Front: title, description, tracked tokens, and share of the total.
    var front = document.createElement('div');
    front.className = 'scard-face scard-front';

    var top = document.createElement('div');
    top.className = 'scard-top';
    var name = document.createElement('span');
    name.className = 'scard-name';
    name.textContent = strategy.label;
    var share = document.createElement('span');
    share.className = 'scard-share';
    share.textContent = shareText;
    share.title = group === 'prefix'
      ? '占输入：该策略的估算节省 ÷ 区间总输入；前缀折扣不参与事件型策略的占比'
      : '该策略在事件型策略合计中的占比';
    top.appendChild(name);
    top.appendChild(share);
    front.appendChild(top);

    // The group tag gets its own line: next to the label it competed with the
    // share value for width, and it is a property of the card, not of the name.
    var chip = document.createElement('p');
    chip.className = 'scard-chip';
    chip.textContent = group === 'prefix' ? '每请求' : '区间累计';
    chip.title = group === 'prefix'
      ? '每次请求都会重复生效的固定前缀折扣，不与其他策略共享占比'
      : '按实际发生的裁剪累计，占比在同组内计算';
    front.appendChild(chip);

    var value = document.createElement('p');
    value.className = 'scard-value';
    var tokens = document.createElement('span');
    tokens.className = 'scard-tokens';
    // The prefix strategy shows the per-request value: that is the number a
    // reader can compare, while the window total only grows with request count.
    tokens.textContent = formatCompact(group === 'prefix' ? perRequest : strategy.tokens);
    if (strategy.tokens > 0) {
      tokens.title = Math.round(strategy.tokens).toLocaleString('en-US') +
        ' token（区间累计，估算）';
    }
    var unit = document.createElement('span');
    unit.className = 'scard-unit';
    unit.textContent = group === 'prefix' ? '/ 请求' : 'token';
    value.appendChild(tokens);
    value.appendChild(unit);
    front.appendChild(value);

    var bar = document.createElement('div');
    bar.className = 'bar';
    bar.setAttribute('role', 'progressbar');
    bar.setAttribute('aria-label', strategy.label + ' 贡献');
    bar.setAttribute('aria-valuemin', '0');
    bar.setAttribute('aria-valuemax', '100');
    bar.setAttribute('aria-valuenow', String(Math.min(100, sharePercent)));

    var fill = document.createElement('span');
    fill.style.width = Math.min(100, sharePercent) + '%';
    bar.appendChild(fill);
    front.appendChild(bar);

    var noteText = STRATEGY_NOTES[strategy.key];
    if (noteText) {
      var note = document.createElement('p');
      note.className = 'scard-note';
      note.textContent = noteText;
      front.appendChild(note);
    }

    // Back: the scan funnel. Scanned/eligible/candidate/marked are per-request
    // averages; the verdict count is the range total, as on the footnote.
    var back = document.createElement('div');
    back.className = 'scard-face scard-back';

    var backHead = document.createElement('p');
    backHead.className = 'scard-back-head';
    var backName = document.createElement('span');
    backName.className = 'scard-name';
    backName.textContent = strategy.label;
    var scope = document.createElement('span');
    scope.className = 'scard-scope';
    scope.textContent = strategy.requests > 0
      ? strategy.requests + '/' + result.requests + ' 次'
      : '无记录';
    scope.title = '该策略采集到的请求数 / 区间请求数';
    backHead.appendChild(backName);
    backHead.appendChild(scope);
    back.appendChild(backHead);

    var stats = document.createElement('div');
    stats.className = 'scard-stats';
    if (strategy.requests > 0) {
      stats.appendChild(statRow('扫描', formatAverage(strategy.scanned, strategy.requests)));
      stats.appendChild(statRow('合格', formatAverage(strategy.eligible, strategy.requests)));
      stats.appendChild(statRow('候选', formatAverage(strategy.candidates, strategy.requests)));
      stats.appendChild(statRow('标记', formatAverage(strategy.marked, strategy.requests)));
      stats.appendChild(
        statRow(group === 'prefix' ? '每请求' : '裁决',
          group === 'prefix' ? formatCompact(perRequest) : String(strategy.removedItems),
          group === 'prefix' ? 'token' : '项',
          true)
      );
      stats.title =
        '扫描/合格/候选/标记为每请求均值（仅统计已采集该策略的请求）。' +
        (group === 'prefix'
          ? '合格=描述可精简；候选=收益为正；标记=通过检查；每请求=平均每次请求省下的 token。' +
            '窗口累计：' + strategy.removedItems + ' 次改写'
          : '裁决为区间累计项数；合格=通过安全校验；候选=真正可裁剪；标记=通过全部守卫；裁决=内容确实被改动。' +
            '窗口累计：扫描 ' + strategy.scanned + ' / 合格 ' + strategy.eligible +
            ' / 候选 ' + strategy.candidates + ' / 标记 ' + strategy.marked +
            ' / 裁决 ' + strategy.removedItems + ' 条');
    } else {
      var empty = document.createElement('p');
      empty.className = 'scard-empty';
      empty.textContent = '该策略在本区间无记录';
      stats.appendChild(empty);
    }
    back.appendChild(stats);

    inner.appendChild(front);
    inner.appendChild(back);
    card.appendChild(inner);
    applyFlipped(card, strategy, !!flippedStrategies[strategy.key]);

    card.addEventListener('click', function () {
      applyFlipped(card, strategy, !flippedStrategies[strategy.key]);
    });
    card.addEventListener('keydown', function (event) {
      if (event.key !== 'Enter' && event.key !== ' ' && event.key !== 'Spacebar') return;
      event.preventDefault();
      applyFlipped(card, strategy, !flippedStrategies[strategy.key]);
    });

    return card;
  }

  function renderStrategies(result) {
    if (!strategyList) return;
    strategyList.textContent = '';

    // A day with one request would otherwise render six cards of zeros. Show
    // only strategies that did something; the footnote says so explicitly.
    var active = sortStrategies(result.strategies).filter(function (strategy) {
      return (
        strategy.tokens > 0 ||
        strategy.removedItems > 0 ||
        strategy.candidates > 0 ||
        strategy.eligible > 0
      );
    });
    if (active.length === 0) {
      renderEmptyState('该区间没有活动策略', '策略没有扫描到可处理记录。');
      return;
    }

    // Event strategies first (their contribution depends on what happened in
    // the window); the constant per-request prefix discount closes the grid so
    // it cannot dominate the first screen.
    var eventShare = active.reduce(function (total, strategy) {
      return groupOf(strategy) === 'event' ? total + (strategy.tokens || 0) : total;
    }, 0);
    var ordered = active
      .filter(function (strategy) {
        return groupOf(strategy) === 'event';
      })
      .concat(
        active.filter(function (strategy) {
          return groupOf(strategy) === 'prefix';
        })
      );

    ordered.forEach(function (strategy, index) {
      strategyList.appendChild(createStrategyCard(strategy, index, result, eventShare));
    });
  }


  function updateSnapshot() {
    if (!snapshot) return;
    var parts = [];
    parts.push(state.source === 'api' ? '数据源 本地服务（实时）' : '数据源 不可用');
    if (state.data && state.data.archive) parts.push(state.data.archive);
    if (state.data && state.data.generatedAt) {
      const generated = Date.parse(state.data.generatedAt);
      if (isFinite(generated)) parts.push('采集 ' + formatClock(generated));
    }
    if (state.loadedAt) parts.push('更新 ' + formatClock(state.loadedAt));
    var invalid = state.data && state.data.diagnostics
      ? state.data.diagnostics.invalidLines || 0
      : 0;
    if (invalid > 0) parts.push('损坏行 ' + invalid);
    if (snapshot) {
      if (state.source === 'api') {
        snapshot.dataset.source = state.source;
      } else {
        delete snapshot.dataset.source;
      }
    }
    snapshot.textContent = parts.join(' · ');
  }

  /* A silent refresh fires every 15s; rebuilding the trend, table and flip
     cards when nothing visible changed caused needless layout and animation
     work. The signature captures everything render() reads. */
  function renderSignature() {
    var records = state.data && Array.isArray(state.data.records) ? state.data.records : null;
    var first = records && records.length ? records[0][0] : '';
    var last = records && records.length ? records[records.length - 1][0] : '';
    var focus = state.focusBucket;
    return [
      state.mode,
      state.dimension,
      state.compare ? 1 : 0,
      focus ? focus.from : '',
      records ? records.length : -1,
      first,
      last,
      Math.floor(state.now.getTime() / 60000)
    ].join('|');
  }

  function render() {
    // The control must respond to a range click even while the archive is
    // unreadable, so the pressed state is committed before any data check.
    buttons.forEach(function (button) {
      var active = button.dataset.range === state.mode;
      button.classList.toggle('is-active', active);
      button.setAttribute('aria-pressed', String(active));
    });
    if (!state.data) {
      state.renderSignature = null;
      syncSegmentThumb();
      return;
    }

    var signature = renderSignature();
    if (signature === state.renderSignature) return;
    state.renderSignature = signature;
    // Measured only when something is about to change: offsetWidth reads
    // force layout, and a silent refresh usually changes nothing.
    syncSegmentThumb();

    var bounds = boundsFor(state.mode, state.now);
    var focus = state.focusBucket;
    var focusBounds = focus ? { from: focus.from, to: focus.to } : null;
    var result = aggregate(state.data, state.mode, state.now, focusBounds || bounds);
    var previous = state.compare
      ? aggregate(state.data, state.mode, state.now, previousBounds(focusBounds || bounds))
      : null;
    var trendTotals = bucketTotals(
      state.data.records,
      bucketsFor(state.mode, bounds, state.now)
    );
    var hasData = result.requests > 0;
    var cachedLabel = '含缓存前缀';
    var rateLabel = '缓存读 ÷ 总输入';
    var removedItems = result.strategies.reduce(function (total, strategy) {
      return total + strategy.removedItems;
    }, 0);

    setMetric('mInput', hasData ? formatCompact(result.input) : '—');
    setMetric('mOutput', hasData ? formatCompact(result.output) : '—');
    setMetric('mRate', hasData && result.input > 0 ? formatPercent(result.cached / result.input) : '—');
    setMetric('mRemoved', hasData ? formatCompact(result.removed) : '—');
    setExactTitle('mInput', result.input, hasData);
    setExactTitle('mOutput', result.output, hasData);
    setExactTitle('mRemoved', result.removed, hasData, '估算');

    if (hasData) {
      cachedLabel = result.cached > 0 ? '含缓存 ' + formatCompact(result.cached) : '无缓存命中';
    }
    if (hasData && result.input > 0) {
      rateLabel = result.cached > 0
        ? '缓存 ' + formatCompact(result.cached) + ' / 输入 ' + formatCompact(result.input)
        : '无缓存命中';
    }
    setNote(inputNote, cachedLabel);
    setNote(rateNote, rateLabel);
    var bill = billWeighted(result);
    if (!hasData) {
      setNote(removedNote, '估算值，不等于账单节省');
    } else if (result.removed > 0) {
      // Token 口径与账单口径分开：前缀节省大多落在缓存读，按 0.1× 折价后才接近账单。
      setNote(removedNote, '缓存加权 ≈ ' + formatCompact(bill));
      if (removedNote) {
        removedNote.title =
          'token 口径为未加权估算；缓存加权按缓存读 ' + CACHE_READ_RATIO +
          '× 折算（本区间缓存读 ÷ 输入 = ' +
          formatPercent(result.input > 0 ? result.cached / result.input : 0) + '）。' +
          '占输入 ' + formatPercent(result.input > 0 ? result.removed / result.input : 0) + '，仍是估算。';
      }
    } else {
      setNote(removedNote, '本区间无估算裁剪');
      if (removedNote) removedNote.removeAttribute('title');
    }

    if (caption) {
      caption.textContent = hasData
        ? formatTime(result.from) + ' → ' + formatTime(result.to) + ' · ' + result.requests + ' 次请求'
        : '该区间没有记录';
    }

    if (strategyTotal) {
      // Split by prompt region instead of one misleading sum: the prefix value
      // is a constant per-request discount, the rest are event-driven cuts.
      var prefixTokens = result.scopes.tool_schema || 0;
      var messageTokens = result.scopes.messages || 0;
      var otherTokens =
        (result.scopes.tool_result || 0) + (result.scopes.model_output || 0);
      strategyTotal.textContent = hasData
        ? '前缀 ' + formatCompact(prefixTokens) + ' · 消息 ' + formatCompact(messageTokens) +
          ' · 其他 ' + formatCompact(otherTokens) + ' · 裁剪 ' + removedItems + ' 项'
        : '';
      strategyTotal.title = hasData
        ? '按提示词区域拆分估算节省（前缀=tool schema，每请求重复；消息=消息数组裁剪；其他=工具结果与输出侧）。' +
          '各域不可直接比较。'
        : '';
    }

    if (hasData) {
      renderStrategies(result);
    } else {
      renderEmptyState('该区间没有记录', '切换统计维度，或发一次请求后再回来。');
    }

    renderTrend(trendTotals);
    renderBreakdown(result);
    renderDeltas(result, previous);
    if (trendFocus) {
      trendFocus.hidden = !focus;
      if (focus && trendFocusText) {
        trendFocusText.textContent =
          '已聚焦 ' + focus.label + ' · ' + result.requests + ' 次请求；指标与拆分已切到该时段。';
      }
    }

    if (strategyHint) strategyHint.hidden = !(hasData && result.removed === 0 && removedItems === 0);
  }

  function setRefreshing(refreshing) {
    if (!refreshButton) return;
    refreshButton.disabled = refreshing;
    refreshButton.setAttribute('aria-busy', String(refreshing));
    refreshButton.setAttribute('aria-label', refreshing ? '正在刷新数据' : '刷新数据');
    refreshButton.title = refreshing ? '正在刷新…' : '刷新数据';
    refreshButton.classList.toggle('is-loading', refreshing);
  }

  async function refresh(options) {
    if (state.loading) return;
    const initial = options && options.initial === true;
    const silent = options && options.silent === true;
    state.loading = true;
    if (!initial && !silent) setRefreshing(true);
    try {
      const result = await loadData();
      if (result.ok) {
        state.data = result.data;
        state.source = result.source;
        state.loadedAt = new Date();
        // Keep the "today"/"last 7 days" windows anchored to the fetch time,
        // otherwise an auto-refresh would exclude records newer than page load.
        state.now = new Date();
        setNotice(false);
        setSkeleton(false);
        render();
        updateSnapshot();
      } else {
        state.data = null;
        state.source = 'none';
        state.renderSignature = null;
        setNotice(true);
        if (caption) caption.textContent = '无法读取数据';
        setMetric('mInput', '—');
        setMetric('mOutput', '—');
        setMetric('mRate', '—');
        setMetric('mRemoved', '—');
        setExactTitle('mInput', 0, false);
        setExactTitle('mOutput', 0, false);
        setExactTitle('mRemoved', 0, false);
        setNote(inputNote, '含缓存前缀');
        setNote(rateNote, '缓存读 ÷ 总输入');
        setNote(removedNote, '估算值，不等于账单节省');
        if (strategyTotal) strategyTotal.textContent = '';
        if (strategyHint) strategyHint.hidden = true;
        renderEmptyState('暂无可展示的策略数据', '启动本地服务后点击刷新。');
        if (snapshot) {
          snapshot.textContent = '';
          delete snapshot.dataset.source;
        }
        setSkeleton(false);
        if (trendSvg) {
          trendSvg.textContent = '';
          trendSvg.classList.add('is-empty');
        }
        if (trendEmpty) trendEmpty.hidden = true;
        if (trendCaption) trendCaption.textContent = '';
        if (breakdownRows) breakdownRows.textContent = '';
        if (breakdownEmpty) breakdownEmpty.hidden = true;
        if (trendFocus) trendFocus.hidden = true;
        renderDeltas({ input: 0, output: 0, cached: 0, removed: 0 }, null);
      }
    } finally {
      state.loading = false;
      if (!initial && !silent) setRefreshing(false);
    }
  }

  function syncDimensionThumb() {
    var thumbEl;
    var activeEl;
    if (!dimensionTabs) return;
    thumbEl = dimensionTabs.querySelector('.segmented-thumb');
    activeEl = dimensionTabs.querySelector('[data-dim].is-active');
    if (!thumbEl || !activeEl || !activeEl.offsetWidth) {
      dimensionTabs.classList.remove('has-thumb');
      return;
    }
    thumbEl.style.width = activeEl.offsetWidth + 'px';
    thumbEl.style.transform = 'translateX(' + activeEl.offsetLeft + 'px)';
    dimensionTabs.classList.add('has-thumb');
  }

  function setDimension(dimension) {
    state.dimension = dimension;
    dimensionButtons.forEach(function (button) {
      var active = button.dataset.dim === dimension;
      button.classList.toggle('is-active', active);
      button.setAttribute('aria-selected', String(active));
    });
    syncDimensionThumb();
  }

  buttons.forEach(function (button) {
    button.addEventListener('click', function () {
      if (state.mode === button.dataset.range) return;
      state.mode = button.dataset.range;
      state.now = new Date();
      state.focusBucket = null;
      render();
    });
  });

  dimensionButtons.forEach(function (button) {
    button.addEventListener('click', function () {
      if (state.dimension === button.dataset.dim) return;
      setDimension(button.dataset.dim);
      render();
    });
  });

  if (compareToggle) {
    compareToggle.addEventListener('click', function () {
      state.compare = !state.compare;
      compareToggle.classList.toggle('is-active', state.compare);
      compareToggle.setAttribute('aria-pressed', String(state.compare));
      render();
    });
  }

  if (healthButton) {
    healthButton.addEventListener('click', toggleHealth);
  }
  document.addEventListener('click', function (event) {
    if (!healthPopover || healthPopover.hidden) return;
    if (event.target === healthButton) return;
    var wrap = healthPopover.parentElement;
    if (wrap && wrap.contains(event.target)) return;
    closeHealth();
  });

  if (trendClearButton) {
    trendClearButton.addEventListener('click', function () {
      state.focusBucket = null;
      render();
    });
  }

  if (trendSvg) {
    trendSvg.addEventListener('click', function (event) {
      var index = trendHitIndex(event);
      var totals = state.trendTotals || [];
      if (index >= 0 && totals[index]) toggleFocusBucket(totals[index]);
    });
    trendSvg.addEventListener('pointermove', function (event) {
      var index = trendHitIndex(event);
      var totals = state.trendTotals || [];
      if (index >= 0 && totals[index]) showTrendTip(totals[index], index);
      else hideTrendTip();
    });
    trendSvg.addEventListener('pointerleave', hideTrendTip);
  }

  if (refreshButton) {
    refreshButton.addEventListener('click', function () {
      state.now = new Date();
      refresh();
    });
  }

  // The pill has to be measured after layout, and re-measured when the control
  // reflows (viewport change) or when the system font finishes loading.
  syncSegmentThumb(true);
  syncDimensionThumb();
  if (document.fonts && document.fonts.ready) {
    document.fonts.ready
      .then(function () {
        syncSegmentThumb(true);
        syncDimensionThumb();
      })
      .catch(function () {});
  }
  var resizeFrame = 0;
  global.addEventListener('resize', function () {
    if (resizeFrame) return;
    var schedule = global.requestAnimationFrame || function (task) {
      return global.setTimeout(task, 16);
    };
    resizeFrame = schedule(function () {
      resizeFrame = 0;
      syncSegmentThumb(true);
      syncDimensionThumb();
    });
  });

  // 视图第一次显示时才测量分段控件并读取数据（隐藏容器宽度为 0）。
  document.addEventListener('vibe:view', function (event) {
    if (!event.detail || event.detail.view !== 'usage') return;
    syncSegmentThumb(true);
    syncDimensionThumb();
    refresh({ silent: true });
  });

  refresh({ initial: true });
  state.timer = global.setInterval(function () {
    if (!document.hidden && isUsageActive()) refresh({ silent: true });
  }, REFRESH_MS);
  document.addEventListener('visibilitychange', function () {
    if (!document.hidden && isUsageActive()) refresh({ silent: true });
  });
})(typeof window !== 'undefined' ? window : globalThis);
