/* 记忆视图：从统一 Node 服务读取本机 delx-memory SQLite（只读），
   支持搜索 / 筛选 / 排序 / 详情抽屉 / CSV 导出。
   - 数据源：GET api/memory（server.mjs 每次请求只读打开数据库）
   - 首次进入视图时加载；点刷新重新读取，不做定时轮询
   - 正文与 metadata 一律通过 textContent 写入，避免记忆内容被当作 HTML 执行。 */

(function (global) {
  'use strict';

  const $ = (id) => document.getElementById(id);
  const els = {
    stats: $('memStats'), count: $('memCount'), source: $('memSource'),
    refresh: $('memRefresh'), exportCsv: $('memExportCsv'),
    search: $('search'), type: $('typeFilter'), weight: $('weightFilter'),
    layer: $('layerFilter'), status: $('statusFilter'), frag: $('fragFilter'),
    ttl: $('ttlFilter'), minSize: $('minSize'), sortBy: $('sortBy'), pageSize: $('pageSize'),
    chips: $('activeFilters'), rows: $('rows'), empty: $('empty'),
    pagerInfo: $('pagerInfo'), pagerPages: $('pagerPages'), pageJump: $('pageJump'),
    drawer: $('drawer'), mask: $('drawerMask'), drawerTitle: $('drawerTitle'),
    drawerBadges: $('drawerBadges'), closeDrawer: $('closeDrawer'),
    copyKey: $('copyKey'), copyValue: $('copyValue'),
    relations: $('drawerRelations'), drawerText: $('drawerText'), drawerMeta: $('drawerMeta'),
    tabs: Array.from(document.querySelectorAll('#view-memory .tab')),
  };

  const SORTS = [
    ['updated_at', '更新时间'], ['created_at', '创建时间'], ['size', '字符数'],
    ['key', '键名'], ['type', '类型'], ['status', '状态'],
  ];
  const PAGE_SIZES = [15, 25, 50, 100, 200, 0]; // 0 = 全部

  const state = {
    entries: [],
    source: '',
    generatedAt: 0,
    available: false,
    loaded: false,
    loading: false,
    query: {
      q: '', type: '', weight: '', layer: '', status: '', frag: '', ttl: '',
      minSize: '', sortBy: 'updated_at', sortDir: 'desc', pageSize: 15,
    },
    filtered: [],
    page: 1,
    selectedKey: null,
    tab: 'text',
  };

  /* ---------------- utils ---------------- */

  const esc = (s) => String(s ?? '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');

  const pad = (n) => String(n).padStart(2, '0');

  function fmtTime(ms) {
    if (!ms) return '—';
    const d = new Date(ms);
    if (isNaN(d.getTime())) return '—';
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
  }

  function fmtNum(n) {
    return Number(n || 0).toLocaleString('zh-CN');
  }

  function excerpt(text, n = 130) {
    return String(text || '').replace(/\s+/g, ' ').trim().slice(0, n);
  }

  const prefersReducedMotion = () =>
    typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;

  function debounce(fn, wait) {
    let t = 0;
    return (...args) => {
      clearTimeout(t);
      t = setTimeout(() => fn(...args), wait);
    };
  }

  /** 把 terms 命中处包 <mark>，输入已转义文本 */
  function mark(escaped, terms) {
    if (!terms.length) return escaped;
    const pattern = terms
      .filter(Boolean)
      .map((t) => t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
      .sort((a, b) => b.length - a.length)
      .join('|');
    if (!pattern) return escaped;
    return escaped.replace(new RegExp(`(${pattern})`, 'gi'), '<mark>$1</mark>');
  }

  /** 正文命中处上下文 */
  function snippet(value, terms, n = 150) {
    const flat = String(value || '').replace(/\s+/g, ' ');
    if (!terms.length) return excerpt(flat, n);
    const lower = flat.toLowerCase();
    let at = -1;
    for (const t of terms) {
      const i = lower.indexOf(t.toLowerCase());
      if (i >= 0 && (at < 0 || i < at)) at = i;
    }
    if (at < 0) return excerpt(flat, n);
    const start = Math.max(0, at - 50);
    return (start > 0 ? '…' : '') + flat.slice(start, start + n) + (flat.length > start + n ? '…' : '');
  }

  function showNotice(message) {
    const notice = $('notice');
    if (!notice) return;
    const text = notice.querySelector('.notice-text');
    if (text) text.textContent = message;
    notice.hidden = false;
  }

  /* ---------------- query parsing ---------------- */

  const FIELD_ALIASES = {
    type: 'type', tag: 'tag', tags: 'tag', status: 'status', layer: 'layer',
    frag: 'frag', fragment: 'frag', weight: 'weight', p: 'weight',
  };

  function parseQuery(raw) {
    const terms = [];
    const fields = [];
    for (const token of String(raw || '').trim().split(/\s+/).filter(Boolean)) {
      const m = token.match(/^([a-zA-Z]+):(.+)$/);
      if (m && FIELD_ALIASES[m[1].toLowerCase()]) {
        fields.push({ field: FIELD_ALIASES[m[1].toLowerCase()], value: m[2].toLowerCase() });
      } else {
        terms.push(token.toLowerCase());
      }
    }
    return { terms, fields };
  }

  /* ---------------- filtering / sorting ---------------- */

  function matches(entry, parsed) {
    const q = state.query;
    if (q.type && entry.type !== q.type) return false;
    if (q.weight && entry.weight !== q.weight) return false;
    if (q.layer && (entry.layer || '') !== q.layer) return false;
    if (q.status && (entry.status || '') !== q.status) return false;
    if (q.frag === 'frag' && !entry.fragment) return false;
    if (q.frag === 'parent' && entry.fragment) return false;
    if (q.ttl === 'yes' && !entry.ttl_expires_at) return false;
    if (q.ttl === 'no' && entry.ttl_expires_at) return false;
    if (q.minSize && entry.size < Number(q.minSize)) return false;

    for (const f of parsed.fields) {
      if (f.field === 'tag' && !entry.tags.some((t) => t.toLowerCase() === f.value)) return false;
      if (f.field === 'type' && entry.type !== f.value) return false;
      if (f.field === 'status' && String(entry.status || '').toLowerCase() !== f.value) return false;
      if (f.field === 'layer' && String(entry.layer || '').toLowerCase() !== f.value) return false;
      if (f.field === 'weight' && String(entry.weight || '').toLowerCase() !== f.value) return false;
      if (f.field === 'frag') {
        const want = ['1', 'true', 'yes', '是'].includes(f.value);
        if (entry.fragment !== want) return false;
      }
    }

    if (!parsed.terms.length) return true;
    const haystack = entry.haystack;
    return parsed.terms.every((t) => haystack.includes(t));
  }

  function compare(a, b, field) {
    if (field === 'size') return a.size - b.size;
    if (field === 'updated_at') return a.updated_at - b.updated_at;
    if (field === 'created_at') return a.created_at - b.created_at;
    return String(a[field] ?? '').localeCompare(String(b[field] ?? ''), 'zh-CN');
  }

  function recompute() {
    const parsed = parseQuery(state.query.q);
    const dir = state.query.sortDir === 'asc' ? 1 : -1;
    state.filtered = state.entries
      .filter((e) => matches(e, parsed))
      .sort((a, b) => compare(a, b, state.query.sortBy) * dir || a.key.localeCompare(b.key));
    state.terms = parsed.terms;
    state.page = 1;
    state.animateRows = true;
    render();
  }

  /* ---------------- render ---------------- */

  function renderStats() {
    const total = state.entries.length;
    const chars = state.entries.reduce((n, e) => n + e.size, 0);
    const shown = state.filtered.length;
    const shownChars = state.filtered.reduce((n, e) => n + e.size, 0);
    if (els.count) els.count.textContent = `${fmtNum(total)} 条`;
    els.stats.innerHTML = [
      `筛选命中 <b>${fmtNum(shown)}</b> 条 / ${fmtNum(shownChars)} 字符`,
      `全库 ${fmtNum(chars)} 字符`,
      state.generatedAt ? `读取 ${esc(fmtTime(state.generatedAt))}` : '',
    ].filter(Boolean).join(' · ');
    if (els.source) {
      els.source.textContent = state.source
        ? `只读 · ${state.source}${state.available ? '' : '（不可用）'}`
        : '只读数据库';
      els.source.title = state.source || '';
    }
  }

  function renderChips() {
    const q = state.query;
    const chips = [];
    const add = (label, key) => chips.push(`<button class="chip" type="button" data-clear="${key}">${esc(label)}</button>`);
    if (q.q) add(`搜索：${q.q}`, 'q');
    if (q.type) add(`类型：${q.type}`, 'type');
    if (q.weight) add(`权重：${q.weight}`, 'weight');
    if (q.layer) add(`层级：${q.layer}`, 'layer');
    if (q.status) add(`状态：${q.status}`, 'status');
    if (q.frag) add(`分片：${q.frag === 'frag' ? '仅分片' : '仅父条目'}`, 'frag');
    if (q.ttl) add(`TTL：${q.ttl === 'yes' ? '有' : '无'}`, 'ttl');
    if (q.minSize) add(`≥ ${q.minSize} 字符`, 'minSize');
    els.chips.innerHTML = chips.join('');
  }

  function renderSortHeaders() {
    for (const th of document.querySelectorAll('#view-memory .grid thead th[data-sort]')) {
      const active = th.dataset.sort === state.query.sortBy;
      th.classList.toggle('is-sorted', active);
      th.dataset.arrow = state.query.sortDir === 'asc' ? '▲' : '▼';
    }
  }

  function pageOf(total, size) {
    return size > 0 ? Math.max(1, Math.ceil(total / size)) : 1;
  }

  function pageWindow(current, total) {
    if (total <= 7) {
      return Array.from({ length: total }, (_, index) => index + 1);
    }
    const wanted = new Set([1, total, current - 1, current, current + 1]);
    if (current <= 3) [2, 3, 4].forEach((page) => wanted.add(page));
    if (current >= total - 2) [total - 3, total - 2, total - 1].forEach((page) => wanted.add(page));
    const pages = [...wanted].filter((page) => page >= 1 && page <= total).sort((a, b) => a - b);
    const out = [];
    pages.forEach((page, index) => {
      if (index > 0 && page - pages[index - 1] > 1) out.push('…');
      out.push(page);
    });
    return out;
  }

  function renderPager(totalPages) {
    if (!els.pagerPages) return;
    const button = (page, label, extra, disabled, aria, current) =>
      `<button type="button" class="mem-page-btn${extra ? ' ' + extra : ''}" data-page="${page}"` +
      `${aria ? ` aria-label="${aria}"` : ''}${current ? ' aria-current="page"' : ''}` +
      `${disabled ? ' disabled' : ''}>${label}</button>`;
    const parts = [
      button(Math.max(1, state.page - 1), '‹', '', state.page <= 1, '上一页', false),
    ];
    for (const page of pageWindow(state.page, totalPages)) {
      if (page === '…') {
        parts.push('<span class="mem-page-gap">…</span>');
      } else {
        parts.push(
          button(page, String(page), page === state.page ? 'is-active' : '', false, `第 ${page} 页`, page === state.page)
        );
      }
    }
    parts.push(
      button(Math.min(totalPages, state.page + 1), '›', '', state.page >= totalPages, '下一页', false)
    );
    els.pagerPages.innerHTML = parts.join('');
  }

  function scrollToListTop() {
    const view = $('view-memory');
    const list = $('memScroll');
    if (!view || !list) return;
    if (list.scrollHeight > list.clientHeight + 4) {
      list.scrollTop = 0;
      return;
    }
    const top =
      list.getBoundingClientRect().top - view.getBoundingClientRect().top + view.scrollTop - 8;
    view.scrollTop = Math.max(0, top);
  }

  function renderRows() {
    const terms = state.terms || [];
    const size = state.query.pageSize;
    const total = state.filtered.length;
    const totalPages = pageOf(total, size);
    state.page = Math.min(Math.max(1, state.page), totalPages);
    const start = size > 0 ? (state.page - 1) * size : 0;
    const slice = size > 0 ? state.filtered.slice(start, start + size) : state.filtered;
    const animate = state.animateRows !== false;
    state.animateRows = false;
    els.rows.innerHTML = slice.map((e, idx) => {
      const ordered = [
        ...(e.weight ? [e.weight] : []),
        ...(e.tags.includes('fragment') ? ['fragment'] : []),
        ...e.tags.filter((t) => t !== e.weight && t !== 'fragment'),
      ];
      const shown = ordered.slice(0, 3);
      const tagHtml = shown.map((t) => {
        const cls = t === e.weight ? `tag w-${e.weight}` : (t === 'fragment' ? 'tag frag' : 'tag');
        return `<span class="${cls}">${esc(t)}</span>`;
      }).join('') + (ordered.length > shown.length
        ? `<span class="tag" title="${esc(ordered.slice(3).join(' '))}">+${ordered.length - shown.length}</span>`
        : '');

      const keyHtml = e.fragment
        ? `${mark(esc(e.parent || ''), terms)}<span class="frag">#${mark(esc(e.key.split('#')[1] || ''), terms)}</span>`
        : mark(esc(e.key), terms);

      const cls = [
        e.key === state.selectedKey ? 'is-selected' : '',
        animate ? 'animate' : '',
      ].filter(Boolean).join(' ');
      return `<tr data-key="${esc(e.key)}"${cls ? ` class="${cls}"` : ''} style="--i:${Math.min(idx, 12)}">
        <td>
          <div class="cell-key" title="${esc(e.key)}">${keyHtml}</div>
          <span class="cell-excerpt">${mark(esc(snippet(e.value, terms)), terms)}</span>
        </td>
        <td><span class="type-badge">${esc(e.type)}</span></td>
        <td class="num cell-size">${fmtNum(e.size)}</td>
        <td>${tagHtml}</td>
        <td class="cell-time">${esc(fmtTime(e.updated_at))}</td>
        <td><span class="status st-${esc(e.status || 'none')}">${esc(e.status || '—')}</span></td>
      </tr>`;
    }).join('');

    els.empty.hidden = total > 0;
    if (els.pagerInfo) {
      els.pagerInfo.textContent = total
        ? `共 ${fmtNum(total)} 条 · 第 ${state.page} / ${totalPages} 页`
        : '共 0 条';
    }
    if (els.pageJump) {
      els.pageJump.max = String(totalPages);
      if (document.activeElement !== els.pageJump) els.pageJump.value = String(state.page);
    }
    renderPager(totalPages);
    renderSortHeaders();
  }

  function render() {
    renderStats();
    renderChips();
    renderRows();
  }

  /* ---------------- drawer ---------------- */

  function findByKey(key) {
    return state.entries.find((e) => e.key === key) || null;
  }

  function openDrawer(key) {
    const entry = findByKey(key);
    if (!entry) return;
    state.selectedKey = key;

    els.drawerTitle.textContent = entry.key;
    const badges = [
      `<span class="type-badge">${esc(entry.type)}</span>`,
      `<span class="status st-${esc(entry.status || 'none')}">${esc(entry.status || '—')}</span>`,
    ];
    if (entry.layer) badges.push(`<span class="tag">layer ${esc(entry.layer)}</span>`);
    if (entry.weight) badges.push(`<span class="tag w-${esc(entry.weight)}">${esc(entry.weight)}</span>`);
    badges.push(`<span class="tag">${fmtNum(entry.size)} 字符</span>`);
    badges.push(`<span class="tag">创建 ${esc(fmtTime(entry.created_at))}</span>`);
    badges.push(`<span class="tag">更新 ${esc(fmtTime(entry.updated_at))}</span>`);
    badges.push(`<span class="tag">TTL ${entry.ttl_expires_at ? esc(fmtTime(entry.ttl_expires_at)) : '永久'}</span>`);
    els.drawerBadges.innerHTML = badges.join('');

    const rels = [];
    if (entry.fragment && entry.parent) {
      rels.push(`<button class="link-btn" type="button" data-open="${esc(entry.parent)}">← 父条目 ${esc(entry.parent)}</button>`);
    }
    const kids = Array.isArray(entry.metadata?.fragments) ? entry.metadata.fragments : [];
    for (const k of kids) {
      rels.push(`<button class="link-btn" type="button" data-open="${esc(k)}">分片 ${esc(k)}</button>`);
    }
    els.relations.innerHTML = rels.join('');

    els.drawerText.textContent = entry.value;
    els.drawerMeta.textContent = JSON.stringify(entry.metadata || {}, null, 2);
    setTab('text');
    if (els.drawer.classList.contains('is-open') && !prefersReducedMotion()) {
      els.drawerText.animate(
        [{ opacity: 0.3, transform: 'translateY(3px)' }, { opacity: 1, transform: 'none' }],
        { duration: 180, easing: 'cubic-bezier(.23,1,.32,1)' }
      );
    }

    showDrawer();
    renderRows();
  }

  let lastFocused = null;

  function showDrawer() {
    if (els.drawer.classList.contains('is-open')) return;
    lastFocused = document.activeElement;
    els.mask.classList.add('is-open');
    els.drawer.classList.add('is-open');
    els.drawer.setAttribute('aria-hidden', 'false');
    el_bodyNoScroll(true);
    els.closeDrawer.focus({ preventScroll: true });
  }

  function closeDrawer() {
    if (!els.drawer.classList.contains('is-open')) return;
    els.drawer.classList.remove('is-open');
    els.mask.classList.remove('is-open');
    els.drawer.setAttribute('aria-hidden', 'true');
    el_bodyNoScroll(false);
    state.selectedKey = null;
    renderRows();
    if (lastFocused && lastFocused.focus) lastFocused.focus({ preventScroll: true });
    lastFocused = null;
  }

  function el_bodyNoScroll(on) {
    document.body.classList.toggle('no-scroll', on);
  }

  function setTab(name) {
    state.tab = name;
    for (const tab of els.tabs) {
      tab.classList.toggle('is-active', tab.dataset.tab === name);
      tab.setAttribute('aria-selected', tab.dataset.tab === name ? 'true' : 'false');
    }
    els.drawerText.hidden = name !== 'text';
    els.drawerMeta.hidden = name !== 'meta';
  }

  /* ---------------- copy / csv ---------------- */

  function copy(text, label) {
    const done = () => flash(`已复制${label}`);
    if (global.navigator?.clipboard?.writeText) {
      global.navigator.clipboard.writeText(text).then(done, () => fallbackCopy(text, done));
    } else {
      fallbackCopy(text, done);
    }
  }

  function fallbackCopy(text, done) {
    const area = document.createElement('textarea');
    area.value = text;
    area.setAttribute('readonly', '');
    area.style.position = 'fixed';
    area.style.opacity = '0';
    document.body.appendChild(area);
    area.select();
    try { document.execCommand('copy'); done(); } catch { /* ignore */ }
    document.body.removeChild(area);
  }

  function flash(message) {
    const notice = $('notice');
    if (!notice) return;
    const text = notice.querySelector('.notice-text');
    if (text) text.textContent = message;
    notice.hidden = false;
    clearTimeout(flash.timer);
    flash.timer = setTimeout(() => { notice.hidden = true; }, 1800);
  }

  function exportCsv() {
    const head = ['key', 'type', 'size', 'status', 'layer', 'weight', 'created_at', 'updated_at', 'tags'];
    const cell = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;
    const lines = [head.join(',')];
    for (const e of state.filtered) {
      lines.push([
        e.key, e.type, e.size, e.status || '', e.layer || '', e.weight || '',
        new Date(e.created_at || 0).toISOString(), new Date(e.updated_at || 0).toISOString(),
        e.tags.join(' '),
      ].map(cell).join(','));
    }
    const blob = new Blob([`\ufeff${lines.join('\n')}`], { type: 'text/csv;charset=utf-8' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `delx-memory-${new Date().toISOString().slice(0, 10)}.csv`;
    a.click();
    URL.revokeObjectURL(a.href);
    flash(`已导出 ${state.filtered.length} 条`);
  }

  /* ---------------- payload ---------------- */

  function normalize(payload) {
    const list = Array.isArray(payload?.entries) ? payload.entries : [];
    return list.map((e) => {
      const entry = {
        key: String(e.key ?? ''),
        type: e.type || String(e.key || '').split(':')[0],
        fragment: typeof e.fragment === 'boolean' ? e.fragment : String(e.key).includes('#'),
        parent: e.parent ?? (String(e.key).includes('#') ? String(e.key).split('#')[0] : null),
        value: e.value ?? '',
        tags: Array.isArray(e.tags) ? e.tags : String(e.tags || '').split(',').filter(Boolean),
        metadata: e.metadata && typeof e.metadata === 'object' ? e.metadata : {},
        size: Number(e.size) || String(e.value || '').length,
        created_at: Number(e.created_at) || 0,
        updated_at: Number(e.updated_at) || 0,
        ttl_expires_at: e.ttl_expires_at ? Number(e.ttl_expires_at) : null,
        status: e.status || e.metadata?.status || null,
        layer: e.layer || e.metadata?.layer || null,
        weight: e.weight || (Array.isArray(e.tags) ? e.tags.find((t) => t.startsWith('p_')) : null) || null,
      };
      // Built once per payload: rebuilding this string for every entry on
      // every keystroke was the dominant cost of the search filter.
      entry.haystack =
        `${entry.key}\n${entry.value}\n${entry.tags.join(' ')}\n${entry.status || ''}\n${entry.layer || ''}`
          .toLowerCase();
      return entry;
    });
  }

  function applyPayload(payload) {
    state.entries = normalize(payload);
    state.source = payload?.source || '';
    state.generatedAt = Number(payload?.generated_at) || 0;
    state.available = payload?.available !== false;
    state.loaded = true;
    buildFilters();
    recompute();
    if (!state.available) {
      showNotice('记忆数据库不可用：' + (payload?.error || 'unknown') + '。请确认 delx-memory 已初始化。');
    }
  }

  function buildFilters() {
    const fill = (select, items, allLabel) => {
      const prev = select.value;
      select.innerHTML = `<option value="">${allLabel}</option>` +
        items.map(([v, label, count]) =>
          `<option value="${esc(v)}">${esc(label)}${count != null ? `（${count}）` : ''}</option>`).join('');
      if (items.some(([v]) => v === prev)) select.value = prev;
    };

    const count = (getter) => {
      const map = new Map();
      for (const e of state.entries) {
        const k = getter(e);
        if (!k) continue;
        map.set(k, (map.get(k) || 0) + 1);
      }
      return [...map.entries()].sort((a, b) => b[1] - a[1] || String(a[0]).localeCompare(String(b[0])))
        .map(([k, n]) => [k, k, n]);
    };

    fill(els.type, count((e) => e.type), '全部类型');
    fill(els.weight, count((e) => e.weight), '全部权重');
    fill(els.layer, count((e) => e.layer), '全部层级');
    fill(els.status, count((e) => e.status), '全部状态');

    if (!els.frag.dataset.ready) {
      els.frag.innerHTML = '<option value="">全部</option><option value="parent">仅父条目</option><option value="frag">仅分片</option>';
      els.ttl.innerHTML = '<option value="">全部</option><option value="yes">有 TTL</option><option value="no">无 TTL（永久）</option>';
      els.sortBy.innerHTML = SORTS.map(([v, l]) => `<option value="${v}">${l}</option>`).join('');
      els.pageSize.innerHTML = PAGE_SIZES.map((n) => `<option value="${n}">${n || '全部'}</option>`).join('');
      els.frag.dataset.ready = '1';
      els.sortBy.value = state.query.sortBy;
      els.pageSize.value = String(state.query.pageSize);
    }
    syncControls();
  }

  function syncControls() {
    const q = state.query;
    els.search.value = q.q;
    els.type.value = q.type;
    els.weight.value = q.weight;
    els.layer.value = q.layer;
    els.status.value = q.status;
    els.frag.value = q.frag;
    els.ttl.value = q.ttl;
    els.minSize.value = q.minSize;
    els.sortBy.value = q.sortBy;
    els.pageSize.value = String(q.pageSize);
  }

  function onFilterChange() {
    state.query.q = els.search.value;
    state.query.type = els.type.value;
    state.query.weight = els.weight.value;
    state.query.layer = els.layer.value;
    state.query.status = els.status.value;
    state.query.frag = els.frag.value;
    state.query.ttl = els.ttl.value;
    state.query.minSize = els.minSize.value.trim();
    state.query.sortBy = els.sortBy.value;
    state.query.pageSize = Number(els.pageSize.value);
    recompute();
  }

  /* ---------------- events ---------------- */

  function jumpToPage() {
    if (!els.pageJump) return;
    const totalPages = pageOf(state.filtered.length, state.query.pageSize);
    if (String(els.pageJump.value).trim() === '') {
      els.pageJump.value = String(state.page);
      return;
    }
    const value = Number(els.pageJump.value);
    if (!Number.isFinite(value)) {
      els.pageJump.value = String(state.page);
      return;
    }
    const page = Math.min(Math.max(1, Math.trunc(value)), totalPages);
    els.pageJump.value = String(page);
    if (page === state.page) return;
    state.page = page;
    state.animateRows = true;
    renderRows();
    scrollToListTop();
  }

  function bind() {
    els.search.addEventListener('input', debounce(onFilterChange, 180));
    for (const el of [els.type, els.weight, els.layer, els.status, els.frag, els.ttl, els.sortBy, els.pageSize]) {
      el.addEventListener('change', onFilterChange);
    }
    els.minSize.addEventListener('input', debounce(onFilterChange, 250));

    els.chips.addEventListener('click', (ev) => {
      const btn = ev.target.closest('[data-clear]');
      if (!btn) return;
      const key = btn.dataset.clear;
      state.query[key] = key === 'pageSize' ? 15 : '';
      syncControls();
      recompute();
    });

    for (const th of document.querySelectorAll('#view-memory .grid thead th[data-sort]')) {
      th.addEventListener('click', () => {
        const field = th.dataset.sort;
        if (state.query.sortBy === field) {
          state.query.sortDir = state.query.sortDir === 'asc' ? 'desc' : 'asc';
        } else {
          state.query.sortBy = field;
          state.query.sortDir = field === 'key' || field === 'type' || field === 'status' ? 'asc' : 'desc';
        }
        els.sortBy.value = field;
        recompute();
      });
    }

    els.rows.addEventListener('click', (ev) => {
      const tr = ev.target.closest('tr[data-key]');
      if (tr) openDrawer(tr.dataset.key);
    });

    els.relations.addEventListener('click', (ev) => {
      const btn = ev.target.closest('[data-open]');
      if (btn) openDrawer(btn.dataset.open);
    });

    els.closeDrawer.addEventListener('click', closeDrawer);
    els.mask.addEventListener('click', closeDrawer);
    els.copyKey.addEventListener('click', () => state.selectedKey && copy(state.selectedKey, 'key'));
    els.copyValue.addEventListener('click', () => {
      const entry = state.selectedKey && findByKey(state.selectedKey);
      if (entry) copy(entry.value, '正文');
    });
    for (const tab of els.tabs) tab.addEventListener('click', () => setTab(tab.dataset.tab));

    if (els.pageJump) {
      els.pageJump.addEventListener('keydown', (ev) => {
        if (ev.key !== 'Enter') return;
        ev.preventDefault();
        jumpToPage();
        els.pageJump.blur();
      });
      els.pageJump.addEventListener('change', jumpToPage);
    }

    if (els.pagerPages) {
      els.pagerPages.addEventListener('click', (ev) => {
        const button = ev.target.closest('[data-page]');
        if (!button || button.disabled) return;
        const page = Number(button.dataset.page);
        if (!Number.isFinite(page) || page === state.page) return;
        state.page = page;
        state.animateRows = true;
        renderRows();
        scrollToListTop();
      });
    }

    els.exportCsv.addEventListener('click', exportCsv);
    els.refresh.addEventListener('click', () => load({ force: true }));

    document.addEventListener('keydown', (ev) => {
      if (ev.key === 'Escape' && els.drawer.classList.contains('is-open')) closeDrawer();
      if (ev.key === '/' && !/^(INPUT|SELECT|TEXTAREA)$/.test(document.activeElement.tagName)) {
        const view = $('view-memory');
        if (!view || !view.classList.contains('is-active')) return;
        ev.preventDefault();
        els.search.focus();
      }
    });
  }

  /* ---------------- data ---------------- */

  async function load(options) {
    const force = !!options?.force;
    if (state.loading) return;
    if (state.loaded && !force) return;
    state.loading = true;
    els.refresh.disabled = true;
    try {
      const response = await fetch('api/memory', {
        cache: 'no-store',
        headers: { Accept: 'application/json' },
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      applyPayload(await response.json());
    } catch (error) {
      state.loaded = true;
      state.available = false;
      state.entries = [];
      state.source = '';
      state.generatedAt = 0;
      showNotice('无法读取记忆数据：' + error.message + '。启动本地服务后访问：node tools/viewer/server.mjs');
      buildFilters();
      recompute();
    } finally {
      state.loading = false;
      els.refresh.disabled = false;
    }
  }

  function start() {
    bind();
    document.addEventListener('vibe:view', (event) => {
      if (event.detail && event.detail.view === 'memory') {
        load();
      } else {
        closeDrawer();
      }
    });
    global.MemoryViewer = {
      state,
      load,
      openDrawer,
      filtered: () => state.filtered,
    };
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', start);
  } else {
    start();
  }
})(window);
