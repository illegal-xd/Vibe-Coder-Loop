/* Token 用量卡片：从本地 Node 服务实时读取用量归档，并按本地自然日切换统计维度。
   - 默认数据源：GET api/usage（server.mjs 每次请求都重新读取 JSONL 归档）
   - 兼容回退：window.TOKEN_USAGE_DATA（由 export_card_data.py 生成的离线快照）
   - 每 15 秒静默刷新；页面隐藏时暂停，重新可见时立即刷新
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

  function aggregate(data, mode, now) {
    var bounds = boundsFor(mode, now);
    var strategies = resolveStrategies(data.strategies);
    var result = {
      from: bounds.from,
      to: bounds.to,
      requests: 0,
      input: 0,
      output: 0,
      cached: 0,
      removed: 0,
      strategies: strategies.map(function (strategy) {
        return {
          key: strategy.key,
          label: strategy.label,
          tokens: 0,
          removedItems: 0,
          scanned: 0,
          candidates: 0,
          eligible: 0,
          marked: 0,
          requests: 0
        };
      })
    };

    (data.records || []).forEach(function (record) {
      var timestamp = record[0];
      if (timestamp < bounds.from || timestamp >= bounds.to) return;

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
      });
    });

    return result;
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
   * Resolve the data source: the live server first, then an injected snapshot.
   * Never throws; returns a discriminated result so the caller can show a
   * precise notice instead of silently rendering an empty card.
   */
  async function loadData() {
    if (typeof global.fetch === 'function') {
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
        // Fall through to the snapshot (file:// or server stopped).
      }
    }
    if (global.TOKEN_USAGE_DATA && Array.isArray(global.TOKEN_USAGE_DATA.records)) {
      return { ok: true, data: global.TOKEN_USAGE_DATA, source: 'snapshot' };
    }
    return { ok: false, data: null, source: 'none' };
  }

  var api = {
    boundsFor: boundsFor,
    aggregate: aggregate,
    sortStrategies: sortStrategies,
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

  var state = {
    mode: 'today',
    now: new Date(),
    data: null,
    loadedAt: null,
    loading: false,
    timer: null,
    source: 'none'
  };

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
    if (notice) notice.hidden = !visible;
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

  function createStrategyCard(strategy, index, result) {
    var colorIndex = STRATEGY_ORDER[strategy.key];
    var color = colorIndex === undefined ? ((index % 6) + 1) : ((colorIndex % 6) + 1);
    var sharePercent = result.removed > 0
      ? Math.round((strategy.tokens / result.removed) * 100)
      : 0;

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
    share.textContent = sharePercent + '%';
    top.appendChild(name);
    top.appendChild(share);
    front.appendChild(top);

    var value = document.createElement('p');
    value.className = 'scard-value';
    var tokens = document.createElement('span');
    tokens.className = 'scard-tokens';
    tokens.textContent = formatCompact(strategy.tokens);
    if (strategy.tokens > 0) {
      tokens.title = Math.round(strategy.tokens).toLocaleString('en-US') + ' token（估算）';
    }
    var unit = document.createElement('span');
    unit.className = 'scard-unit';
    unit.textContent = 'token';
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
      stats.appendChild(statRow('裁决', String(strategy.removedItems), '项', true));
      stats.title =
        '扫描/合格/候选/标记为每请求均值（仅统计已采集该策略的请求）；裁决为区间累计项数。' +
        '合格=通过安全校验；候选=真正可裁剪；标记=通过全部守卫；裁决=消息内容确实被改动。' +
        '窗口累计：扫描 ' + strategy.scanned + ' / 合格 ' + strategy.eligible +
        ' / 候选 ' + strategy.candidates + ' / 标记 ' + strategy.marked +
        ' / 裁决 ' + strategy.removedItems + ' 条';
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

    active.forEach(function (strategy, index) {
      strategyList.appendChild(createStrategyCard(strategy, index, result));
    });
  }


  function updateSnapshot() {
    if (!snapshot) return;
    var parts = [];
    parts.push(state.source === 'api' ? '数据源 本地服务（实时）' : '数据源 离线快照');
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
      if (state.source === 'api' || state.source === 'snapshot') {
        snapshot.dataset.source = state.source;
      } else {
        delete snapshot.dataset.source;
      }
    }
    snapshot.textContent = parts.join(' · ');
  }

  function render() {
    // The control must respond to a range click even while the archive is
    // unreadable, so the pressed state is committed before any data check.
    buttons.forEach(function (button) {
      var active = button.dataset.range === state.mode;
      button.classList.toggle('is-active', active);
      button.setAttribute('aria-pressed', String(active));
    });
    syncSegmentThumb();
    if (!state.data) return;

    var result = aggregate(state.data, state.mode, state.now);
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
    if (!hasData) {
      setNote(removedNote, '估算值，不等于账单节省');
    } else if (result.removed > 0 && result.input > 0) {
      setNote(removedNote, '占输入 ' + formatPercent(result.removed / result.input) + ' · 估算');
    } else if (result.removed > 0) {
      setNote(removedNote, '估算值，不等于账单节省');
    } else {
      setNote(removedNote, '本区间无估算裁剪');
    }

    if (caption) {
      caption.textContent = hasData
        ? formatTime(result.from) + ' → ' + formatTime(result.to) + ' · ' + result.requests + ' 次请求'
        : '该区间没有记录';
    }

    if (strategyTotal) {
      strategyTotal.textContent = hasData
        ? '估算 ' + formatCompact(result.removed) + ' token · 裁剪 ' + removedItems + ' 项'
        : '';
    }

    if (hasData) {
      renderStrategies(result);
    } else {
      renderEmptyState('该区间没有记录', '切换统计维度，或发一次请求后再回来。');
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
        render();
        updateSnapshot();
      } else {
        state.data = null;
        state.source = 'none';
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
      }
    } finally {
      state.loading = false;
      if (!initial && !silent) setRefreshing(false);
    }
  }

  buttons.forEach(function (button) {
    button.addEventListener('click', function () {
      if (state.mode === button.dataset.range) return;
      state.mode = button.dataset.range;
      state.now = new Date();
      render();
    });
  });

  if (refreshButton) {
    refreshButton.addEventListener('click', function () {
      state.now = new Date();
      refresh();
    });
  }

  // The pill has to be measured after layout, and re-measured when the control
  // reflows (viewport change) or when the system font finishes loading.
  syncSegmentThumb(true);
  if (document.fonts && document.fonts.ready) {
    document.fonts.ready
      .then(function () {
        syncSegmentThumb(true);
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
    });
  });

  refresh({ initial: true });
  state.timer = global.setInterval(function () {
    if (!document.hidden) refresh({ silent: true });
  }, REFRESH_MS);
  document.addEventListener('visibilitychange', function () {
    if (!document.hidden) refresh({ silent: true });
  });
})(typeof window !== 'undefined' ? window : globalThis);
