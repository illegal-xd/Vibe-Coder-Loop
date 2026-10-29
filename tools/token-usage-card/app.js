/* Token 用量卡片：读取 token-usage-data.js 的快照，按本地自然日切换三个统计维度。
   数据口径（输入含缓存、输出含 reasoning）已在导出脚本中归一，这里只做窗口聚合与渲染。 */

(function (global) {
  'use strict';

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

  var api = {
    boundsFor: boundsFor,
    aggregate: aggregate,
    formatCompact: formatCompact,
    formatPercent: formatPercent,
    formatAverage: formatAverage,
    formatTime: formatTime
  };

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
  }
  if (typeof document === 'undefined') return;

  var data = global.TOKEN_USAGE_DATA;
  var notice = document.getElementById('notice');
  var caption = document.getElementById('rangeCaption');
  var strategyList = document.getElementById('strategyList');
  var strategyHint = document.getElementById('strategyHint');
  var snapshot = document.getElementById('snapshot');
  var buttons = Array.prototype.slice.call(document.querySelectorAll('[data-range]'));

  if (!data || !Array.isArray(data.records)) {
    if (notice) notice.hidden = false;
    return;
  }

  var state = { mode: 'last7', now: new Date() };

  function setText(id, text) {
    var node = document.getElementById(id);
    if (node) node.textContent = text;
  }

  function renderStrategies(result) {
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
            '候选 ' + formatAverage(strategy.candidates, strategy.requests) + '/次 · ' +
            '实际裁剪 ' + strategy.removedItems + ' 项' + coverage
          : '该策略在本区间无记录';
      if (strategy.requests > 0) {
        counts.title =
          '扫描/候选为每请求均值（仅统计已采集该策略的请求）；实际裁剪为区间累计项数。' +
          '窗口累计：扫描 ' + strategy.scanned + ' 条 / 候选 ' + strategy.candidates + ' 条';
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

  function render() {
    var result = aggregate(data, state.mode, state.now);
    var hasData = result.requests > 0;

    setText('mInput', hasData ? formatCompact(result.input) : '—');
    setText('mOutput', hasData ? formatCompact(result.output) : '—');
    setText('mRate', hasData && result.input > 0 ? formatPercent(result.cached / result.input) : '—');
    setText('mRemoved', hasData ? formatCompact(result.removed) : '—');

    caption.textContent = hasData
      ? formatTime(result.from) + ' → ' + formatTime(result.to) + ' · ' + result.requests + ' 次请求'
      : '该区间没有记录';

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

  buttons.forEach(function (button) {
    button.addEventListener('click', function () {
      if (state.mode === button.dataset.range) return;
      state.mode = button.dataset.range;
      state.now = new Date();
      render();
    });
  });

  if (snapshot) {
    snapshot.textContent = '数据快照 ' + data.generatedAt + ' · 来源 data/token-usage*.jsonl';
  }

  render();
})(typeof window !== 'undefined' ? window : globalThis);
