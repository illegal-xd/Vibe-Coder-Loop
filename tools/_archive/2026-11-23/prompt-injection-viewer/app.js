/* 提示词注入时间轴：从本地 Node 服务实时读取 JSONL 归档，按对话分组渲染。
   - 数据源：GET api/injections（server.mjs 每次请求重新读取归档）
   - 页面加载时读取一次；清除记录后重新读取，不做定时轮询
   - 内容一律通过 textContent 写入，避免注入内容被当作 HTML 执行。 */

(function (global) {
  'use strict';

  var UNKNOWN_SESSION = '__unknown__';
  var STORAGE_KEY = 'vibe.promptInjection.selectedSession';
  var SIDEBAR_KEY = 'vibe.promptInjection.sidebarCollapsed';
  var STRIP_ZOOM_MIN = 1;
  var STRIP_ZOOM_MAX = 6;
  var STRIP_ZOOM_STEP = 0.3;

  var KIND_LABELS = {
    checkpoint_full: '完整 TASK 区',
    checkpoint_pointer: '指针',
    user_input: '用户输入',
    tool: '工具调用',
    mcp: 'MCP 调用',
    skill: '技能调用',
    system_prompt: '系统提示词',
    unknown: '未知类型'
  };

  var KIND_CLASS = {
    checkpoint_full: 'kind-full',
    checkpoint_pointer: 'kind-pointer',
    user_input: 'kind-user',
    tool: 'kind-tool',
    mcp: 'kind-mcp',
    skill: 'kind-skill',
    system_prompt: 'kind-context'
  };

  var CATEGORY_LABELS = {
    user_input: '用户输入',
    injection: '注入',
    tool: '工具调用',
    mcp: 'MCP 调用',
    skill: '技能调用',
    context: '系统提示词'
  };

  var TAG_LABELS = {
    user_input: '用户',
    injection: '注入',
    tool: '工具',
    mcp: 'MCP',
    skill: '技能',
    context: '系统'
  };

  var TAG_CLASSES = {
    user_input: 'tag-user',
    injection: 'tag-inject',
    tool: 'tag-tool',
    mcp: 'tag-mcp',
    skill: 'tag-skill',
    context: 'tag-context'
  };

  var CATEGORY_CLASSES = {
    user_input: 'kind-user',
    injection: 'chip-muted',
    tool: 'kind-tool',
    mcp: 'kind-mcp',
    skill: 'kind-skill',
    context: 'kind-context'
  };

  var TRIGGER_LABELS = {
    resume: '会话恢复',
    compacted: '压缩后',
    hot_pointer: '常态请求',
    compaction: '压缩前',
    user_message: '用户消息',
    tool_call: '调用完成',
    session_start: '会话开始'
  };

  var state = {
    data: null,
    signature: null,
    selected: null,
    preferred: null,
    loading: false,
    clearPending: null,
    timelineSession: null,
    timelineGroup: null,
    selectedEntry: null,
    selectedEntryKey: null,
    stripRange: null,
    stripCount: 0,
    stripDrag: null,
    stripZoom: 1
  };

  function byId(id) {
    return document.getElementById(id);
  }

  function fmtDateTime(iso) {
    var date = new Date(iso);
    if (isNaN(date.getTime())) return iso || '—';
    return date.toLocaleString('zh-CN', {
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hour12: false
    });
  }

  function fmtTime(iso) {
    var date = new Date(iso);
    if (isNaN(date.getTime())) return '—';
    return date.toLocaleTimeString('zh-CN', {
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hour12: false
    });
  }

  function fmtDay(iso) {
    var date = new Date(iso);
    if (isNaN(date.getTime())) return '—';
    return date.toLocaleDateString('zh-CN', {
      year: 'numeric',
      month: '2-digit',
      day: '2-digit'
    });
  }

  function fmtNumber(value) {
    var number = Number(value);
    if (!isFinite(number)) return '0';
    return number.toLocaleString('zh-CN');
  }

  function shortId(id) {
    if (!id || id === UNKNOWN_SESSION) return '未知对话';
    if (id.length <= 18) return id;
    return id.slice(0, 10) + '…' + id.slice(-4);
  }

  function baseName(value) {
    if (typeof value !== 'string' || value === '') return '';
    var parts = value.split(/[\\/]/);
    return parts[parts.length - 1] || value;
  }

  function kindLabel(kind) {
    return KIND_LABELS[kind] || kind || '未知类型';
  }

  function triggerLabel(trigger) {
    if (!trigger) return '—';
    return TRIGGER_LABELS[trigger] || trigger;
  }

  function modelLabel(model) {
    if (!model) return '';
    if (model.provider_id && model.model_id) return model.provider_id + ' / ' + model.model_id;
    return model.model_id || model.provider_id || '';
  }

  function buildChip(text, className) {
    var chip = document.createElement('span');
    chip.className = 'chip' + (className ? ' ' + className : '');
    chip.textContent = text;
    return chip;
  }

  // ------------------------------------------------------ normalization

  /* Assign each event a user turn number so the timeline can keep system
     context (system prompt / full checkpoint) ahead of the user message that
     triggered the same request. */
  function normalizePayload(payload) {
    var sessions = Array.isArray(payload.sessions) ? payload.sessions : [];
    sessions.forEach(function (session) {
      var turn = 0;
      session.entries
        .slice()
        .sort(function (left, right) {
          var delta = Date.parse(left.timestamp) - Date.parse(right.timestamp);
          if (delta !== 0) return delta;
          return (left.sequence || 0) - (right.sequence || 0);
        })
        .forEach(function (entry) {
          if (entry.category === 'user_input') turn += 1;
          entry.turn = turn;
        });
    });
    return payload;
  }

  function signatureOf(payload) {
    var stats = payload.stats || {};
    var diagnostics = payload.diagnostics || {};
    var sessions = Array.isArray(payload.sessions) ? payload.sessions : [];
    var last = sessions[0] || null;
    return [
      stats.sessions || 0,
      stats.injections || 0,
      stats.userInputs || 0,
      stats.toolCalls || 0,
      stats.mcpCalls || 0,
      stats.skillCalls || 0,
      stats.systemPrompts || 0,
      last ? last.session_id : '',
      last ? last.last_at : '',
      last && last.entries ? last.entries.length : 0,
      diagnostics.records || 0,
      diagnostics.invalidLines || 0,
      diagnostics.invalidTruncated ? 1 : 0
    ].join('|');
  }

  function filteredSessions() {
    if (!state.data) return [];
    return state.data.sessions
      .filter(function (session) {
        return Array.isArray(session.entries) && session.entries.length > 0;
      })
      .map(function (session) {
        return { session: session, entries: session.entries };
      });
  }

  // -------------------------------------------------------------- rendering

  function ensureSelection(groups) {
    if (groups.length === 0) {
      state.selected = null;
      return;
    }
    var ids = groups.map(function (group) {
      return group.session.session_id;
    });
    // A temporary empty result must not erase the user's explicit choice;
    // when that session is visible again, restore it.
    if (state.preferred && ids.indexOf(state.preferred) >= 0) {
      state.selected = state.preferred;
      return;
    }
    if (state.selected && ids.indexOf(state.selected) >= 0) return;
    var stored = null;
    try {
      stored = global.sessionStorage ? global.sessionStorage.getItem(STORAGE_KEY) : null;
    } catch (error) {
      stored = null;
    }
    if (stored && ids.indexOf(stored) >= 0) {
      state.selected = stored;
      state.preferred = stored;
      return;
    }
    state.selected = ids[0];
  }

  function renderSessionList(groups) {
    var list = byId('sessionList');
    var fragment = document.createDocumentFragment();
    var count = byId('sessionCount');
    count.textContent = String(groups.length);
    byId('railCount').textContent = String(groups.length);
    byId('sessionEmpty').hidden = groups.length !== 0;

    groups.forEach(function (group) {
      var session = group.session;
      var item = document.createElement('li');
      var button = document.createElement('button');
      button.type = 'button';
      button.className = 'session-item' + (session.session_id === state.selected ? ' is-active' : '');
      button.setAttribute('aria-pressed', session.session_id === state.selected ? 'true' : 'false');
      button.dataset.sessionId = session.session_id;

      var title = document.createElement('span');
      title.className = 'session-title';
      title.textContent = shortId(session.session_id);
      title.title = session.session_id;

      var meta = document.createElement('span');
      meta.className = 'session-meta';
      var metaParts = [];
      metaParts.push(group.entries.length + ' 条记录');
      if (group.entries.length !== session.count) metaParts.push('共 ' + session.count);
      metaParts.push(fmtTime(session.last_at));
      var project = session.projects.length > 0 ? baseName(session.projects[0]) : '';
      if (project) metaParts.push(project);
      meta.textContent = metaParts.join(' · ');

      var dot = document.createElement('span');
      dot.className = 'session-dot';
      dot.setAttribute('aria-hidden', 'true');

      button.appendChild(dot);
      var text = document.createElement('span');
      text.className = 'session-text';
      text.appendChild(title);
      text.appendChild(meta);
      button.appendChild(text);
      item.appendChild(button);
      fragment.appendChild(item);
    });

    list.textContent = '';
    list.appendChild(fragment);
  }

  function entryKey(entry) {
    return String(entry.timestamp || '') + '|' + String(entry.sequence || 0);
  }

  function applyStripZoom(zoom) {
    var lanes = byId('stripLanes');
    var scroll = byId('stripScroll');
    var badge = byId('stripZoom');
    if (lanes) lanes.style.width = zoom * 100 + '%';
    if (scroll) scroll.classList.toggle('is-zoomed', zoom > STRIP_ZOOM_MIN + 0.001);
    if (badge) {
      badge.hidden = zoom <= STRIP_ZOOM_MIN + 0.001;
      badge.textContent = zoom.toFixed(1).replace(/\.0$/, '') + '×';
    }
  }

  function setStripZoom(next, anchorClientX) {
    var scroll = byId('stripScroll');
    var lanes = byId('stripLanes');
    if (!scroll || !lanes) return;
    var zoom = Math.max(STRIP_ZOOM_MIN, Math.min(STRIP_ZOOM_MAX, next));
    if (Math.abs(zoom - state.stripZoom) < 0.001) return;

    var lanesRect = lanes.getBoundingClientRect();
    var scrollRect = scroll.getBoundingClientRect();
    var width = lanesRect.width || 1;
    var anchorX = anchorClientX == null ? scrollRect.left + scroll.clientWidth / 2 : anchorClientX;
    var fraction = Math.max(0, Math.min(1, (anchorX - lanesRect.left) / width));
    var viewportOffset = anchorX - scrollRect.left;

    state.stripZoom = zoom;
    applyStripZoom(zoom);
    requestAnimationFrame(function () {
      scroll.scrollLeft = fraction * lanes.offsetWidth - viewportOffset;
    });
  }

  function handleStripWheel(event) {
    if (!event.deltaY) return;
    // The overview is a control surface: never let a wheel gesture over it
    // scroll the timeline or document, even when zoom is already at a bound.
    event.preventDefault();
    if (event.shiftKey) {
      byId('stripScroll').scrollLeft += event.deltaY;
      return;
    }
    var next =
      state.stripZoom + (event.deltaY < 0 ? STRIP_ZOOM_STEP : -STRIP_ZOOM_STEP);
    if (next < STRIP_ZOOM_MIN || next > STRIP_ZOOM_MAX) return;
    setStripZoom(next, event.clientX);
  }

  function renderStrip(entries) {
    var root = byId('stripLanes');
    var total = entries.length;
    var lanes = [
      { key: 'input', match: ['user_input', 'context'] },
      { key: 'inject', match: ['injection'] },
      { key: 'tool', match: ['tool', 'mcp', 'skill'] }
    ];
    root.textContent = '';
    state.stripCount = total;

    var windowEl = document.createElement('span');
    windowEl.className = 'strip-window';
    windowEl.id = 'stripWindow';
    windowEl.hidden = true;
    root.appendChild(windowEl);

    if (total > 0) {
      lanes.forEach(function (lane) {
        var track = document.createElement('div');
        track.className = 'strip-track';
        track.dataset.lane = lane.key;
        entries.forEach(function (entry, index) {
          if (lane.match.indexOf(entry.category) < 0) return;
          var segment = document.createElement('span');
          segment.className = 'strip-segment ' + lane.key;
          segment.dataset.index = String(index);
          segment.style.left = (index / total) * 100 + '%';
          segment.style.width = 'calc(' + 100 / total + '% - 1px)';
          segment.title =
            (TAG_LABELS[entry.category] || entry.category) +
            ' · ' +
            fmtTime(entry.timestamp) +
            ' · 第 ' +
            (index + 1) +
            ' / ' +
            total +
            ' 条';
          track.appendChild(segment);
        });
        if (track.children.length === 0) track.classList.add('is-empty');
        root.appendChild(track);
      });
    }
    byId('stripCard').hidden = total === 0;
    applyStripZoom(state.stripZoom);
    paintStripSelection();
  }

  function stripIndexAt(clientX) {
    var root = byId('stripLanes');
    var rect = root.getBoundingClientRect();
    var total = state.stripCount;
    if (total <= 0 || rect.width <= 0) return 0;
    var x = Math.max(0, Math.min(rect.width - 0.001, clientX - rect.left));
    return Math.floor((x / rect.width) * total);
  }

  function paintStripSelection() {
    var root = byId('stripLanes');
    var windowEl = byId('stripWindow');
    var range = state.stripRange;
    if (!windowEl) return;
    var segments = root.querySelectorAll('.strip-segment');
    segments.forEach(function (segment) {
      segment.classList.remove('is-selected');
    });
    if (!range || state.stripCount <= 0) {
      windowEl.hidden = true;
      return;
    }
    var start = Math.max(0, Math.min(range[0], range[1]));
    var end = Math.min(state.stripCount - 1, Math.max(range[0], range[1]));
    windowEl.hidden = false;
    windowEl.style.left = (start / state.stripCount) * 100 + '%';
    windowEl.style.width = ((end - start + 1) / state.stripCount) * 100 + '%';
    segments.forEach(function (segment) {
      var index = Number(segment.dataset.index);
      if (index >= start && index <= end) segment.classList.add('is-selected');
    });
  }

  function normalizeStripRange(range, total) {
    if (!range || total <= 0) return null;
    var start = Math.max(0, Math.min(range[0], range[1]));
    var end = Math.min(total - 1, Math.max(range[0], range[1]));
    if (start > end) return null;
    return [start, end];
  }

  function beginStripDrag(event) {
    if (event.button !== undefined && event.button !== 0) return;
    if (state.stripCount <= 0) return;
    var index = stripIndexAt(event.clientX);
    state.stripDrag = {
      start: index,
      end: index,
      moved: false,
      wasSingle:
        !!state.stripRange &&
        state.stripRange[0] === index &&
        state.stripRange[1] === index
    };
    state.stripRange = [index, index];
    paintStripSelection();
    var root = byId('stripLanes');
    if (root.setPointerCapture) {
      try {
        root.setPointerCapture(event.pointerId);
      } catch (error) {
        // Pointer capture is optional.
      }
    }
    event.preventDefault();
  }

  function moveStripDrag(event) {
    var drag = state.stripDrag;
    if (!drag) return;
    var index = stripIndexAt(event.clientX);
    if (index === drag.end) return;
    drag.end = index;
    drag.moved = true;
    state.stripRange = [Math.min(drag.start, index), Math.max(drag.start, index)];
    paintStripSelection();
  }

  function endStripDrag(event) {
    var drag = state.stripDrag;
    if (!drag) return;
    state.stripDrag = null;
    var root = byId('stripLanes');
    if (root.releasePointerCapture) {
      try {
        root.releasePointerCapture(event.pointerId);
      } catch (error) {
        // Pointer capture is optional.
      }
    }
    if (!drag.moved && drag.wasSingle) {
      state.stripRange = null;
    } else {
      state.stripRange = [Math.min(drag.start, drag.end), Math.max(drag.start, drag.end)];
    }
    renderTimeline(state.timelineGroup);
  }

  function eventOrderRank(entry) {
    if (entry.category === 'context' || entry.kind === 'checkpoint_full') return 0;
    if (entry.category === 'user_input') return 1;
    return 2;
  }

  function updateStripSelectionHint(range, count, total) {
    var hint = byId('stripSelectionHint');
    if (!range) {
      hint.hidden = true;
      byId('stripSelectionText').textContent = '';
      return;
    }
    hint.hidden = false;
    var position =
      range[0] === range[1]
        ? '第 ' + (range[0] + 1)
        : '第 ' + (range[0] + 1) + '–' + (range[1] + 1);
    byId('stripSelectionText').textContent =
      '概览已选 ' + count + ' 条（' + position + ' / ' + total + ' 条）';
  }

  function renderTimeline(group) {
    var head = byId('timelineHead');
    var timeline = byId('timeline');
    var empty = byId('timelineEmpty');
    timeline.textContent = '';

    if (!group) {
      head.hidden = true;
      empty.hidden = false;
      byId('stripCard').hidden = true;
      byId('stripSelectionHint').hidden = true;
      state.timelineSession = null;
      state.timelineGroup = null;
      state.stripRange = null;
      closeDetail();
      updateScrollActions();
      return;
    }
    head.hidden = false;
    empty.hidden = true;

    var session = group.session;
    state.timelineGroup = group;
    if (state.timelineSession !== session.session_id) {
      state.timelineSession = session.session_id;
      state.stripRange = null;
      closeDetail();
    }
    byId('sessionTitle').textContent = shortId(session.session_id);
    byId('sessionTitle').title = session.session_id;

    var metaParts = [session.session_id];
    if (session.projects.length > 0) metaParts.push(session.projects.join(' · '));
    metaParts.push(fmtDateTime(session.first_at) + ' → ' + fmtDateTime(session.last_at));
    byId('sessionMeta').textContent = metaParts.join('  ·  ');

    var ordered = group.entries.slice().sort(function (left, right) {
      var leftTurn = left.turn || 0;
      var rightTurn = right.turn || 0;
      if (leftTurn !== rightTurn) return leftTurn - rightTurn;
      var leftRank = eventOrderRank(left);
      var rightRank = eventOrderRank(right);
      if (leftRank !== rightRank) return leftRank - rightRank;
      var delta = Date.parse(left.timestamp) - Date.parse(right.timestamp);
      if (delta !== 0) return delta;
      return (left.sequence || 0) - (right.sequence || 0);
    });

    var fullCount = 0;
    var pointerCount = 0;
    var userInputCount = 0;
    var toolCount = 0;
    var mcpCount = 0;
    var skillCount = 0;
    var systemCount = 0;
    ordered.forEach(function (entry) {
      if (entry.kind === 'checkpoint_full') fullCount += 1;
      if (entry.kind === 'checkpoint_pointer') pointerCount += 1;
      if (entry.category === 'user_input') userInputCount += 1;
      if (entry.category === 'tool') toolCount += 1;
      if (entry.category === 'mcp') mcpCount += 1;
      if (entry.category === 'skill') skillCount += 1;
      if (entry.category === 'context') systemCount += 1;
    });
    var stats = byId('sessionStats');
    stats.textContent = '';
    stats.appendChild(buildChip(ordered.length + ' 条记录', 'chip-strong'));
    if (fullCount > 0) stats.appendChild(buildChip('完整 ' + fullCount, 'chip-full'));
    if (pointerCount > 0) stats.appendChild(buildChip('指针 ' + pointerCount, 'chip-pointer'));
    if (userInputCount > 0) stats.appendChild(buildChip('用户 ' + userInputCount, 'kind-user'));
    if (toolCount > 0) stats.appendChild(buildChip('工具 ' + toolCount, 'kind-tool'));
    if (mcpCount > 0) stats.appendChild(buildChip('MCP ' + mcpCount, 'kind-mcp'));
    if (skillCount > 0) stats.appendChild(buildChip('技能 ' + skillCount, 'kind-skill'));
    if (systemCount > 0) stats.appendChild(buildChip('系统 ' + systemCount, 'kind-context'));

    state.stripRange = normalizeStripRange(state.stripRange, ordered.length);
    var range = state.stripRange;
    var visibleEntries = range
      ? ordered.slice(range[0], range[1] + 1)
      : ordered;

    renderStrip(ordered);
    updateStripSelectionHint(range, visibleEntries.length, ordered.length);

    var fragment = document.createDocumentFragment();
    var lastDay = null;
    visibleEntries.forEach(function (entry) {
      var day = fmtDay(entry.timestamp);
      if (day !== lastDay) {
        lastDay = day;
        var divider = document.createElement('li');
        divider.className = 'day-divider';
        var marker = document.createElement('span');
        divider.appendChild(marker);
        var label = document.createElement('span');
        label.className = 'day-label';
        label.textContent = day;
        divider.appendChild(label);
        fragment.appendChild(divider);
      }
      fragment.appendChild(renderRow(entry));
    });
    timeline.appendChild(fragment);

    if (
      state.selectedEntryKey &&
      !visibleEntries.some(function (entry) {
        return entryKey(entry) === state.selectedEntryKey;
      })
    ) {
      closeDetail();
    }
    updateScrollActions();
  }

  function scrollContext() {
    var pane = byId('trajectoryScroll');
    if (pane) {
      var overflow = getComputedStyle(pane).overflowY;
      if (overflow === 'auto' || overflow === 'scroll') {
        return {
          element: pane,
          max: Math.max(0, pane.scrollHeight - pane.clientHeight),
          y: pane.scrollTop
        };
      }
    }
    var doc = document.documentElement;
    return {
      element: null,
      max: Math.max(0, doc.scrollHeight - window.innerHeight),
      y: window.scrollY || doc.scrollTop || 0
    };
  }

  function updateScrollActions() {
    var actions = byId('scrollActions');
    var top = byId('scrollTopButton');
    var bottom = byId('scrollBottomButton');
    var context = scrollContext();
    actions.hidden = context.max <= 80;
    top.disabled = context.y <= 20;
    bottom.disabled = context.y >= context.max - 20;
  }

  function scrollToEdge(edge) {
    var context = scrollContext();
    var top = edge === 'top' ? 0 : context.max;
    if (context.element) {
      context.element.scrollTo({ top: top, behavior: 'smooth' });
    } else {
      window.scrollTo({ top: top, behavior: 'smooth' });
    }
  }

  function readSidebarCollapsed() {
    try {
      return !!global.localStorage && global.localStorage.getItem(SIDEBAR_KEY) === '1';
    } catch (error) {
      return false;
    }
  }

  function setSidebarCollapsed(collapsed, persist) {
    var layout = byId('layout');
    if (!layout) return;
    layout.classList.toggle('is-sidebar-collapsed', collapsed);
    var button = byId('sidebarToggle');
    if (button) {
      button.setAttribute('aria-expanded', collapsed ? 'false' : 'true');
      button.setAttribute('aria-label', collapsed ? '展开对话栏' : '收起对话栏');
      button.title = collapsed ? '展开对话栏' : '收起对话栏';
    }
    if (persist) {
      try {
        if (global.localStorage) {
          global.localStorage.setItem(SIDEBAR_KEY, collapsed ? '1' : '0');
        }
      } catch (error) {
        // localStorage is optional.
      }
    }
    updateScrollActions();
    global.setTimeout(updateScrollActions, 240);
  }

  function renderRow(entry) {
    var key = entryKey(entry);
    var item = document.createElement('li');
    item.className = 'trajectory-item';

    var dot = document.createElement('span');
    dot.className = 'trajectory-dot';
    dot.setAttribute('aria-hidden', 'true');
    item.appendChild(dot);

    var row = document.createElement('div');
    row.className = 'trajectory-row';
    row.dataset.key = key;
    row.tabIndex = 0;
    row.setAttribute('role', 'button');
    if (state.selectedEntryKey === key) row.classList.add('is-active');

    var tag = document.createElement('span');
    tag.className = 'trajectory-tag ' + (TAG_CLASSES[entry.category] || '');
    tag.textContent = TAG_LABELS[entry.category] || '事件';
    row.appendChild(tag);

    var previewText = String(entry.content || '')
      .replace(/\s+/g, ' ')
      .trim();
    if (previewText.length > 200) previewText = previewText.slice(0, 200) + '…';
    var text = document.createElement('span');
    text.className = 'trajectory-text';
    text.textContent = previewText || '（无内容）';
    text.title = previewText || '（无内容）';
    row.appendChild(text);

    var time = document.createElement('time');
    time.className = 'trajectory-time';
    time.dateTime = entry.timestamp;
    time.title = fmtDateTime(entry.timestamp);
    time.textContent = fmtTime(entry.timestamp);
    row.appendChild(time);

    var chevron = document.createElement('span');
    chevron.className = 'trajectory-chevron';
    chevron.setAttribute('aria-hidden', 'true');
    chevron.textContent = '›';
    row.appendChild(chevron);

    row.addEventListener('click', function () {
      openDetail(entry);
    });
    row.addEventListener('keydown', function (event) {
      if (event.key === 'Enter' || event.key === ' ') {
        event.preventDefault();
        openDetail(entry);
      }
    });

    item.appendChild(row);
    return item;
  }

  function openDetail(entry) {
    state.selectedEntry = entry;
    state.selectedEntryKey = entryKey(entry);
    var panel = byId('detailPanel');
    panel.hidden = false;
    renderDetail(entry);
    document.querySelectorAll('.trajectory-row').forEach(function (row) {
      row.classList.toggle('is-active', row.dataset.key === state.selectedEntryKey);
    });
  }

  function closeDetail() {
    var panel = byId('detailPanel');
    if (!panel) return;
    panel.hidden = true;
    state.selectedEntry = null;
    state.selectedEntryKey = null;
    document.querySelectorAll('.trajectory-row.is-active').forEach(function (row) {
      row.classList.remove('is-active');
    });
  }

  function appendKv(parent, key, value) {
    var row = document.createElement('div');
    row.className = 'detail-kv';
    var k = document.createElement('span');
    k.className = 'detail-key';
    k.textContent = key;
    var v = document.createElement('span');
    v.className = 'detail-value';
    v.textContent = value || '—';
    row.appendChild(k);
    row.appendChild(v);
    parent.appendChild(row);
  }

  var PREVIEW_LIMIT = 2000;
  var URL_PATTERN = /https?:\/\/[^\s<>"']+/g;

  function truncatePreview(content) {
    if (content.length <= PREVIEW_LIMIT) return { text: content, truncated: false };
    return { text: content.slice(0, PREVIEW_LIMIT), truncated: true };
  }

  function cleanUrl(raw) {
    return raw.replace(/[.,;:!?，。；：！？、)\]}]+$/, '');
  }

  function extractUrls(content) {
    var seen = {};
    var urls = [];
    var match;
    URL_PATTERN.lastIndex = 0;
    while ((match = URL_PATTERN.exec(content))) {
      var url = cleanUrl(match[0]);
      if (!/^https?:\/\//.test(url) || seen[url]) continue;
      seen[url] = true;
      urls.push(url);
    }
    return urls;
  }

  function appendLinkified(parent, text) {
    var last = 0;
    var match;
    URL_PATTERN.lastIndex = 0;
    while ((match = URL_PATTERN.exec(text))) {
      if (match.index > last) {
        parent.appendChild(document.createTextNode(text.slice(last, match.index)));
      }
      var raw = match[0];
      var url = cleanUrl(raw);
      var trailing = raw.slice(url.length);
      var link = document.createElement('a');
      link.href = url;
      link.textContent = url;
      link.target = '_blank';
      link.rel = 'noreferrer noopener';
      parent.appendChild(link);
      if (trailing) parent.appendChild(document.createTextNode(trailing));
      last = match.index + raw.length;
    }
    if (last < text.length) {
      parent.appendChild(document.createTextNode(text.slice(last)));
    }
  }

  function appendInlineMarkdown(parent, text) {
    var token = /(`[^`\n]+`|\*\*[^*\n]+\*\*|\[[^\]\n]+\]\(https?:\/\/[^)\s]+\))/g;
    var last = 0;
    var match;
    while ((match = token.exec(text))) {
      if (match.index > last) appendLinkified(parent, text.slice(last, match.index));
      var value = match[0];
      if (value.charAt(0) === '`') {
        var code = document.createElement('code');
        code.textContent = value.slice(1, -1);
        parent.appendChild(code);
      } else if (value.slice(0, 2) === '**') {
        var strong = document.createElement('strong');
        strong.textContent = value.slice(2, -2);
        parent.appendChild(strong);
      } else {
        var label = value.slice(1, value.indexOf(']'));
        var url = value.slice(value.indexOf('](') + 2, -1);
        var link = document.createElement('a');
        link.href = url;
        link.textContent = label;
        link.target = '_blank';
        link.rel = 'noreferrer noopener';
        parent.appendChild(link);
      }
      last = match.index + value.length;
    }
    if (last < text.length) appendLinkified(parent, text.slice(last));
  }

  function renderMarkdownPreview(container, text) {
    var root = document.createElement('div');
    root.className = 'preview-text';
    var lines = text.split(/\r?\n/);
    var paragraph = [];
    var list = null;
    var listType = '';
    var index = 0;

    function flushParagraph() {
      if (paragraph.length === 0) return;
      var p = document.createElement('p');
      appendInlineMarkdown(p, paragraph.join(' '));
      root.appendChild(p);
      paragraph = [];
    }

    function flushList() {
      if (list) root.appendChild(list);
      list = null;
      listType = '';
    }

    while (index < lines.length) {
      var line = lines[index];
      if (/^\s*```/.test(line)) {
        flushParagraph();
        flushList();
        var fence = [];
        index += 1;
        while (index < lines.length && !/^\s*```/.test(lines[index])) {
          fence.push(lines[index]);
          index += 1;
        }
        index += 1;
        var pre = document.createElement('pre');
        pre.className = 'preview-code';
        pre.textContent = fence.join('\n');
        root.appendChild(pre);
        continue;
      }
      if (/^\s*$/.test(line)) {
        flushParagraph();
        flushList();
        index += 1;
        continue;
      }
      var heading = line.match(/^(#{1,6})\s+(.*)$/);
      if (heading) {
        flushParagraph();
        flushList();
        var h = document.createElement(heading[1].length <= 2 ? 'h3' : 'h4');
        appendInlineMarkdown(h, heading[2]);
        root.appendChild(h);
        index += 1;
        continue;
      }
      var bullet = line.match(/^\s*[-*+]\s+(.*)$/);
      if (bullet) {
        flushParagraph();
        if (listType !== 'ul') {
          flushList();
          list = document.createElement('ul');
          listType = 'ul';
        }
        var li = document.createElement('li');
        appendInlineMarkdown(li, bullet[1]);
        list.appendChild(li);
        index += 1;
        continue;
      }
      var ordered = line.match(/^\s*\d+[.)]\s+(.*)$/);
      if (ordered) {
        flushParagraph();
        if (listType !== 'ol') {
          flushList();
          list = document.createElement('ol');
          listType = 'ol';
        }
        var oli = document.createElement('li');
        appendInlineMarkdown(oli, ordered[1]);
        list.appendChild(oli);
        index += 1;
        continue;
      }
      var quote = line.match(/^>\s?(.*)$/);
      if (quote) {
        flushParagraph();
        flushList();
        var blockquote = document.createElement('blockquote');
        appendInlineMarkdown(blockquote, quote[1]);
        root.appendChild(blockquote);
        index += 1;
        continue;
      }
      if (/^\s*([-*_])\1{2,}\s*$/.test(line)) {
        flushParagraph();
        flushList();
        root.appendChild(document.createElement('hr'));
        index += 1;
        continue;
      }
      if (list) flushList();
      paragraph.push(line.trim());
      index += 1;
    }
    flushParagraph();
    flushList();
    container.appendChild(root);
    return root;
  }

  function looksLikeMarkdown(text) {
    return /(^|\n)\s{0,3}#{1,6}\s/.test(text) ||
      /(^|\n)\s*[-*+]\s/.test(text) ||
      /(^|\n)\s*\d+[.)]\s/.test(text) ||
      /```/.test(text) ||
      /\[[^\]]+\]\(https?:\/\//.test(text);
  }

  function parseToolContent(content) {
    var fields = { tool: '', args: '', title: '', result: '', extra: '' };
    var current = '';
    content.split(/\r?\n/).forEach(function (line) {
      var match = line.match(/^(tool|args|title|result):\s?(.*)$/);
      if (match) {
        current = match[1];
        fields[current] = match[2];
      } else if (current) {
        fields[current] += '\n' + line;
      } else {
        fields.extra += (fields.extra ? '\n' : '') + line;
      }
    });
    return fields;
  }

  function prettyJson(value) {
    var text = String(value || '').trim();
    if (!text) return '';
    try {
      return JSON.stringify(JSON.parse(text), null, 2);
    } catch (error) {
      return text;
    }
  }

  function appendPreviewSection(container, title, body, mono) {
    if (!body) return;
    var section = document.createElement('div');
    section.className = 'preview-section';
    var heading = document.createElement('div');
    heading.className = 'preview-section-title';
    heading.textContent = title;
    section.appendChild(heading);
    if (mono) {
      var pre = document.createElement('pre');
      pre.className = 'preview-code';
      pre.textContent = body;
      section.appendChild(pre);
    } else {
      var text = document.createElement('div');
      text.className = 'preview-text';
      appendInlineMarkdown(text, body);
      section.appendChild(text);
    }
    container.appendChild(section);
  }

  function appendPreviewLinks(container, urls) {
    if (!urls.length) return;
    var section = document.createElement('div');
    section.className = 'preview-section';
    var heading = document.createElement('div');
    heading.className = 'preview-section-title';
    heading.textContent = '相关链接';
    section.appendChild(heading);
    var links = document.createElement('div');
    links.className = 'preview-links';
    urls.slice(0, 8).forEach(function (url) {
      var link = document.createElement('a');
      link.className = 'preview-link';
      link.href = url;
      link.target = '_blank';
      link.rel = 'noreferrer noopener';
      link.title = url;
      var label = document.createElement('span');
      label.textContent = url;
      link.appendChild(label);
      links.appendChild(link);
    });
    section.appendChild(links);
    container.appendChild(section);
  }

  function buildPreviewHead(container, title, badge, accent) {
    var head = document.createElement('div');
    head.className = 'preview-head';
    var name = document.createElement('span');
    name.className = 'preview-title';
    name.textContent = title;
    head.appendChild(name);
    if (badge) {
      var tag = document.createElement('span');
      tag.className = 'preview-badge' + (accent ? ' is-accent' : '');
      tag.textContent = badge;
      head.appendChild(tag);
    }
    container.appendChild(head);
  }

  function renderToolPreview(container, entry, content, urls) {
    var fields = parseToolContent(content);
    if (!fields.tool && !fields.args && !fields.result) {
      buildPreviewHead(container, CATEGORY_LABELS[entry.category] || '工具调用', '文本');
      appendPreviewSection(container, '内容', content, true);
      appendPreviewLinks(container, urls);
      return;
    }
    buildPreviewHead(
      container,
      CATEGORY_LABELS[entry.category] || '工具调用',
      '结构化',
      true
    );
    if (fields.tool) {
      var name = document.createElement('div');
      name.className = 'preview-tool-name';
      name.textContent = fields.tool;
      container.appendChild(name);
    }
    appendPreviewSection(container, '参数', prettyJson(fields.args), true);
    if (fields.title) appendPreviewSection(container, '标题', fields.title, false);
    appendPreviewSection(container, '结果', prettyJson(fields.result), true);
    if (fields.extra) appendPreviewSection(container, '其他', fields.extra, true);
    appendPreviewLinks(container, urls);
  }

  function renderRichPreview(container, entry, content) {
    var isContext = entry.category === 'context' || entry.kind === 'system_prompt';
    var isUser = entry.category === 'user_input';
    var title = isContext ? '系统提示词' : isUser ? '用户输入' : '内容';
    buildPreviewHead(container, title, looksLikeMarkdown(content) ? 'Markdown' : '文本', isContext);
    renderMarkdownPreview(container, content);
  }

  function renderInjectionPreview(container, entry, content, urls) {
    buildPreviewHead(container, '注入内容', entry.kind === 'checkpoint_pointer' ? '指针' : '完整', true);
    appendPreviewSection(container, '注入正文', content, true);
    appendPreviewLinks(container, urls);
  }

  function renderPreview(entry, content) {
    var box = byId('detailPreview');
    box.textContent = '';
    var preview = truncatePreview(content);
    var urls = extractUrls(content);
    var category = entry.category;

    if (!preview.text) {
      var empty = document.createElement('div');
      empty.className = 'preview-empty';
      empty.textContent = '（无内容）';
      box.appendChild(empty);
      return;
    }

    if (category === 'tool' || category === 'mcp' || category === 'skill') {
      renderToolPreview(box, entry, preview.text, urls);
    } else if (category === 'injection') {
      renderInjectionPreview(box, entry, preview.text, urls);
    } else {
      renderRichPreview(box, entry, preview.text);
    }

    if (preview.truncated) {
      var note = document.createElement('p');
      note.className = 'preview-note';
      note.textContent = '仅预览前 2,000 字符，完整内容见「原始内容」。';
      box.appendChild(note);
    }
  }

  function renderDetail(entry) {
    var category = TAG_LABELS[entry.category] || entry.category || '事件';
    var turn = entry.turn ? ' · 第 ' + entry.turn + ' 轮' : '';
    byId('detailKicker').textContent = category + turn + ' · ' + fmtTime(entry.timestamp);
    byId('detailTitle').textContent = kindLabel(entry.kind);

    var overview = byId('detailOverview');
    overview.textContent = '';
    appendKv(overview, '类型', CATEGORY_LABELS[entry.category] || category);
    appendKv(overview, '触发', triggerLabel(entry.trigger));
    appendKv(overview, '目标', entry.target);
    appendKv(overview, '模型', modelLabel(entry.model));
    appendKv(overview, '项目', entry.project);
    appendKv(overview, '时间', fmtDateTime(entry.timestamp));
    appendKv(
      overview,
      '字符',
      fmtNumber(entry.content_chars) +
        (entry.content_truncated
          ? '（已截断，原 ' + fmtNumber(entry.original_content_chars) + '）'
          : '')
    );

    var content = entry.content || '';
    renderPreview(entry, content);
    byId('detailRaw').textContent = content;

    var source = byId('detailSource');
    source.textContent = '';
    appendKv(source, '事件', entry.event);
    appendKv(source, 'Hook', entry.hook);
    appendKv(source, '来源', entry.source);
    appendKv(source, '会话', entry.session_id);
    appendKv(source, '消息 ID', entry.message_id);
    appendKv(source, '序号', String(entry.sequence || 0));
    appendKv(source, '类别', entry.category);
    appendKv(source, 'kind', entry.kind);

    setDetailTab('overview');
  }

  function setDetailTab(name) {
    var panels = {
      overview: 'detailOverview',
      preview: 'detailPreview',
      raw: 'detailRaw',
      source: 'detailSource'
    };
    document.querySelectorAll('.detail-tab').forEach(function (tab) {
      var active = tab.dataset.tab === name;
      tab.classList.toggle('is-active', active);
      tab.setAttribute('aria-selected', active ? 'true' : 'false');
    });
    Object.keys(panels).forEach(function (key) {
      byId(panels[key]).hidden = key !== name;
    });
  }

  function render() {
    const groups = filteredSessions();
    ensureSelection(groups);
    renderSessionList(groups);

    let active = null;
    for (let index = 0; index < groups.length; index += 1) {
      if (groups[index].session.session_id === state.selected) {
        active = groups[index];
        break;
      }
    }
    renderTimeline(active);
  }

  // ------------------------------------------------------------- data/load

  function setLoading(loading) {
    state.loading = loading;
  }

  function showNotice(message) {
    var notice = byId('notice');
    var text = notice.querySelector('.notice-text');
    if (message) text.textContent = message;
    notice.hidden = false;
  }

  function hideNotice() {
    byId('notice').hidden = true;
  }

  function fetchData() {
    if (state.loading) return Promise.resolve();
    setLoading(true);
    return fetch('api/injections', { cache: 'no-store' })
      .then(function (response) {
        if (!response.ok) throw new Error('HTTP ' + response.status);
        return response.json();
      })
      .then(function (payload) {
        var signature = signatureOf(payload);
        if (signature !== state.signature) {
          state.signature = signature;
          state.data = normalizePayload(payload);
          // Archive changed: selection indices are no longer stable.
          state.stripRange = null;
          render();
        }
        hideNotice();
      })
      .catch(function (error) {
        showNotice('无法读取注入记录：' + error.message + '。启动本地服务后访问：node tools/prompt-injection-viewer/server.mjs');
      })
      .then(function () {
        setLoading(false);
      });
  }

  function closeClearModal() {
    byId('clearModal').hidden = true;
    byId('clearConfirm').hidden = true;
    state.clearPending = null;
  }

  function openClearModal() {
    state.clearPending = null;
    byId('clearConfirm').hidden = true;
    var hasSession = !!state.selected;
    var sessionOption = byId('clearSessionOption');
    sessionOption.disabled = !hasSession;
    byId('clearSessionHint').textContent = hasSession
      ? '会话：' + shortId(state.selected)
      : '选择左侧对话后可用';
    byId('clearModal').hidden = false;
    byId('clearClose').focus();
  }

  function chooseClearScope(scope) {
    if (scope === 'session' && !state.selected) return;
    state.clearPending = { scope: scope, session: scope === 'session' ? state.selected : null };
    byId('clearConfirmText').textContent =
      scope === 'all'
        ? '即将清空全部对话的上下文记录。此操作不可撤销。'
        : '即将清空当前对话（' + shortId(state.selected) + '）的记录。此操作不可撤销。';
    byId('clearConfirm').hidden = false;
    byId('clearConfirmButton').focus();
  }

  function confirmClear() {
    var pending = state.clearPending;
    if (!pending) return;
    var button = byId('clearConfirmButton');
    button.disabled = true;
    button.textContent = '清空中…';
    var body = { scope: pending.scope };
    if (pending.scope === 'session') body.session = pending.session;
    fetch('api/clear', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Requested-With': 'prompt-injection-viewer'
      },
      body: JSON.stringify(body)
    })
      .then(function (response) {
        if (!response.ok) {
          return response
            .json()
            .catch(function () {
              return {};
            })
            .then(function (payload) {
              throw new Error(payload.error || 'HTTP ' + response.status);
            });
        }
        return response.json();
      })
      .then(function (result) {
        closeClearModal();
        return fetchData().then(function () {
          var label = result.scope === 'all' ? '全部记录' : '当前对话';
          showNotice('已清空' + label + '（移除 ' + (result.removed || 0) + ' 条）');
        });
      })
      .catch(function (error) {
        byId('clearConfirmText').textContent =
          '清空失败：' + error.message + '。可重试或关闭后检查服务。';
      })
      .then(function () {
        button.disabled = false;
        button.textContent = '确认清空';
      });
  }

  function bind() {
    byId('stripCard').addEventListener('wheel', handleStripWheel, { passive: false });
    byId('stripZoom').addEventListener('click', function () {
      setStripZoom(STRIP_ZOOM_MIN);
    });
    byId('stripLanes').addEventListener('pointerdown', beginStripDrag);
    byId('stripLanes').addEventListener('pointermove', moveStripDrag);
    byId('stripLanes').addEventListener('pointerup', endStripDrag);
    byId('stripLanes').addEventListener('pointercancel', endStripDrag);
    byId('stripClearButton').addEventListener('click', function () {
      state.stripRange = null;
      renderTimeline(state.timelineGroup);
    });
    byId('detailClose').addEventListener('click', closeDetail);
    document.querySelectorAll('.detail-tab').forEach(function (tab) {
      tab.addEventListener('click', function () {
        setDetailTab(tab.dataset.tab);
      });
    });

    byId('sidebarToggle').addEventListener('click', function () {
      setSidebarCollapsed(!byId('layout').classList.contains('is-sidebar-collapsed'), true);
    });

    byId('scrollTopButton').addEventListener('click', function () {
      scrollToEdge('top');
    });
    byId('scrollBottomButton').addEventListener('click', function () {
      scrollToEdge('bottom');
    });
    byId('trajectoryScroll').addEventListener('scroll', updateScrollActions, { passive: true });
    window.addEventListener('scroll', updateScrollActions, { passive: true });
    window.addEventListener('resize', updateScrollActions);

    byId('clearButton').addEventListener('click', openClearModal);
    byId('clearClose').addEventListener('click', closeClearModal);
    byId('clearCancel').addEventListener('click', closeClearModal);
    byId('clearSessionOption').addEventListener('click', function () {
      chooseClearScope('session');
    });
    byId('clearAllOption').addEventListener('click', function () {
      chooseClearScope('all');
    });
    byId('clearConfirmButton').addEventListener('click', confirmClear);
    byId('clearModal').addEventListener('click', function (event) {
      if (event.target === byId('clearModal')) closeClearModal();
    });
    document.addEventListener('keydown', function (event) {
      if (event.key !== 'Escape') return;
      if (!byId('clearModal').hidden) {
        closeClearModal();
      } else if (!byId('detailPanel').hidden) {
        closeDetail();
      } else if (state.stripRange) {
        state.stripRange = null;
        renderTimeline(state.timelineGroup);
      }
    });

    byId('sessionList').addEventListener('click', function (event) {
      var button = event.target.closest('.session-item');
      if (!button) return;
      state.selected = button.dataset.sessionId;
      state.preferred = state.selected;
      state.stripRange = null;
      try {
        if (global.sessionStorage) global.sessionStorage.setItem(STORAGE_KEY, state.selected);
      } catch (error) {
        // sessionStorage is optional.
      }
      render();
    });
  }

  function start() {
    setSidebarCollapsed(readSidebarCollapsed(), false);
    bind();
    fetchData();
    // Expose a tiny read-only view for tests / debugging.
    global.PromptInjectionViewer = {
      state: state,
      filteredSessions: filteredSessions
    };
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', start);
  } else {
    start();
  }
})(window);
