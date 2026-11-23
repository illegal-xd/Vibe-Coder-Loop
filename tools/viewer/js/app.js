/* 统一查看器壳层：左侧「用量 / 记忆 / 对话」菜单与右侧视图切换。
   - 三个视图共用同一页面与同一 Node 服务
   - 路由：#usage（默认）/ #memory / #timeline；切换时广播 vibe:view，
     由各视图自行决定是否刷新（时间轴每次重读，记忆首次/按需读取，用量静默刷新）
   - 对话列表只在「对话」菜单下显示；壳层不处理业务数据，只管视图可见性与导航状态 */

(function (global) {
  'use strict';

  var VIEWS = {
    usage: { label: 'Token 用量' },
    memory: { label: '记忆' },
    timeline: { label: '对话 · 上下文轨迹' },
  };
  var DEFAULT_VIEW = 'usage';

  function $(id) {
    return document.getElementById(id);
  }

  function normalizeView(name) {
    return Object.prototype.hasOwnProperty.call(VIEWS, name) ? name : null;
  }

  function viewFromHash() {
    return normalizeView(String(global.location.hash || '').replace(/^#\/?/, ''));
  }

  function updateTitle(view) {
    document.title = 'Vibe Kernel · ' + VIEWS[view].label;
  }

  function setView(view, options) {
    var next = normalizeView(view) || DEFAULT_VIEW;
    var changed = false;
    var names = Object.keys(VIEWS);

    for (var index = 0; index < names.length; index += 1) {
      var name = names[index];
      var section = $('view-' + name);
      if (!section) continue;
      var active = name === next;
      if (section.classList.contains('is-active') !== active) {
        section.classList.toggle('is-active', active);
        changed = true;
      }
      section.setAttribute('aria-hidden', active ? 'false' : 'true');
    }

    var buttons = document.querySelectorAll('[data-view]');
    for (var b = 0; b < buttons.length; b += 1) {
      var button = buttons[b];
      var activeButton = button.dataset.view === next;
      button.classList.toggle('is-active', activeButton);
      if (button.getAttribute('role') === 'tab') {
        button.setAttribute('aria-selected', activeButton ? 'true' : 'false');
      }
    }

    var layout = $('layout');
    if (layout) layout.dataset.view = next;

    // 对话列表属于「对话」菜单：其它视图下隐藏，避免误以为列表仍可操作。
    var sessions = $('paneSessions');
    if (sessions) sessions.hidden = next !== 'timeline';

    updateTitle(next);

    if (changed || (options && options.force)) {
      document.dispatchEvent(new CustomEvent('vibe:view', { detail: { view: next } }));
    }
  }

  function navigate(view) {
    var next = normalizeView(view) || DEFAULT_VIEW;
    try {
      global.history.replaceState(null, '', '#' + next);
    } catch (error) {
      global.location.hash = next;
    }
    setView(next, { force: true });
  }

  function bind() {
    document.addEventListener('click', function (event) {
      var button = event.target.closest('[data-view]');
      if (!button) return;
      navigate(button.dataset.view);
    });

    global.addEventListener('hashchange', function () {
      setView(viewFromHash());
    });
  }

  function start() {
    bind();
    var initial = viewFromHash() || DEFAULT_VIEW;
    setView(initial, { force: true });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', start);
  } else {
    start();
  }

  global.VibeViewer = { setView: setView, navigate: navigate, views: VIEWS };
})(window);
