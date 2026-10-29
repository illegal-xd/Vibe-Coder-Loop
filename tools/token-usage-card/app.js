/* Token 用量卡片：从本地 Node 服务实时读取用量归档，并按本地自然日切换统计维度。
   - 默认数据源：GET api/usage（server.mjs 每次请求都重新读取 JSONL 归档）
   - 兼容回退：window.TOKEN_USAGE_DATA（由 export_card_data.py 生成的离线快照）
   - 每 15 秒静默刷新；页面隐藏时暂停，重新可见时立即刷新
   输入含缓存、输出含 reasoning 的口径已在服务端归一，这里只做窗口聚合与渲染。 */

(function (global) {
  'use strict';

  var REFRESH_MS = 15000;

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
    var strategies = data.strategies || [];
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

  function formatCompact(value) {
    if (!isFinite(value)) return '—';
    if (value <= 0) return '0';
    if (value >= 1e9) return (value / 1e9).toFixed(2) + 'B';
    if (value >= 1e6) return (value / 1e6).toFixed(2) + 'M';
    if (value >= 1e3) return Math.round(value / 1e3) + 'K';
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
  var snapshot = document.getElementById('snapshot');
  var refreshButton = document.getElementById('refreshButton');
  var buttons = Array.prototype.slice.call(document.querySelectorAll('[data-range]'));

  var state = {
    mode: 'last7',
    now: new Date(),
    data: null,
    loadedAt: null,
    loading: false,
    timer: null,
    source: 'none'
  };

  function setText(id, text) {
    var node = document.getElementById(id);
    if (node) node.textContent = text;
  }

  function setNotice(visible) {
    if (notice) notice.hidden = !visible;
  }

  function renderStrategies(result) {
    if (!strategyList) return;
    strategyList.textContent = '';
    result.strategies.forEach(function (strategy, index) {
      var row = document.createElement('div');
      row.className = 'strategy';

      var head = document.createElement('div');
      head.className = 'strategy-head';

      var name = document.createElement('span');
      name.className = 'strategy-name';
      name.textContent = strategy.label;

      var value = document.createElement('span');
      value.className = 'strategy-value';
      value.textContent = formatCompact(strategy.tokens);

      var counts = document.createElement('p');
      counts.className = 'strategy-counts';
      var coverage =
        strategy.requests > 0 && strategy.requests < result.requests
          ? ' · 覆盖 ' + strategy.requests + '/' + result.requests + ' 次'
          : '';
      var countsText =
        strategy.requests > 0
          ? '扫描 ' + formatAverage(strategy.scanned, strategy.requests) + '/次 · ' +
            '合格 ' + formatAverage(strategy.eligible, strategy.requests) + '/次 · ' +
            '候选 ' + formatAverage(strategy.candidates, strategy.requests) + '/次 · ' +
            '标记 ' + formatAverage(strategy.marked, strategy.requests) + '/次 · ' +
            '实际裁剪 ' + strategy.removedItems + ' 项' + coverage
          : '该策略在本区间无记录';
      if (strategy.requests > 0) {
        counts.title =
          '扫描/合格/候选/标记为每请求均值（仅统计已采集该策略的请求）；实际裁剪为区间累计项数。' +
          '合格=通过安全校验；候选=真正可裁剪；标记=通过全部守卫；实际裁剪=消息内容确实被改动。' +
          '窗口累计：扫描 ' + strategy.scanned + ' / 合格 ' + strategy.eligible +
          ' / 候选 ' + strategy.candidates + ' / 标记 ' + strategy.marked +
          ' / 裁剪 ' + strategy.removedItems + ' 条';
      }
      counts.textContent = countsText;

      var bar = document.createElement('div');
      bar.className = 'bar s' + ((index % 3) + 1);
      bar.setAttribute('role', 'progressbar');
      bar.setAttribute('aria-label', strategy.label + ' 贡献');
      bar.setAttribute('aria-valuemin', '0');
      bar.setAttribute('aria-valuemax', '100');
      bar.setAttribute(
        'aria-valuenow',
        result.removed > 0 ? String(Math.round((strategy.tokens / result.removed) * 1000) / 10) : '0'
      );

      var fill = document.createElement('span');
      fill.style.width =
        result.removed > 0
          ? Math.min(100, (strategy.tokens / result.removed) * 100).toFixed(2) + '%'
          : '0%';

      head.appendChild(name);
      head.appendChild(value);
      bar.appendChild(fill);
      row.appendChild(head);
      row.appendChild(counts);
      row.appendChild(bar);
      strategyList.appendChild(row);
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
    snapshot.textContent = parts.join(' · ');
  }

  function render() {
    if (!state.data) return;
    var result = aggregate(state.data, state.mode, state.now);
    var hasData = result.requests > 0;

    setText('mInput', hasData ? formatCompact(result.input) : '—');
    setText('mOutput', hasData ? formatCompact(result.output) : '—');
    setText('mRate', hasData && result.input > 0 ? formatPercent(result.cached / result.input) : '—');
    setText('mRemoved', hasData ? formatCompact(result.removed) : '—');

    if (caption) {
      caption.textContent = hasData
        ? formatTime(result.from) + ' → ' + formatTime(result.to) + ' · ' + result.requests + ' 次请求'
        : '该区间没有记录';
    }

    renderStrategies(result);

    var removedItems = result.strategies.reduce(function (total, strategy) {
      return total + strategy.removedItems;
    }, 0);
    if (strategyHint) strategyHint.hidden = !(hasData && result.removed === 0 && removedItems === 0);

    buttons.forEach(function (button) {
      var active = button.dataset.range === state.mode;
      button.classList.toggle('is-active', active);
      button.setAttribute('aria-pressed', String(active));
    });
  }

  function setRefreshing(refreshing) {
    if (!refreshButton) return;
    refreshButton.disabled = refreshing;
    refreshButton.setAttribute('aria-busy', String(refreshing));
    refreshButton.textContent = refreshing ? '刷新中…' : '刷新';
  }

  async function refresh(options) {
    if (state.loading) return;
    const initial = options && options.initial === true;
    state.loading = true;
    if (!initial) setRefreshing(true);
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
        setText('mInput', '—');
        setText('mOutput', '—');
        setText('mRate', '—');
        setText('mRemoved', '—');
        if (strategyList) strategyList.textContent = '';
        if (snapshot) snapshot.textContent = '';
      }
    } finally {
      state.loading = false;
      if (!initial) setRefreshing(false);
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

  refresh({ initial: true });
  state.timer = global.setInterval(function () {
    if (!document.hidden) refresh();
  }, REFRESH_MS);
  document.addEventListener('visibilitychange', function () {
    if (!document.hidden) refresh();
  });
})(typeof window !== 'undefined' ? window : globalThis);
