/* delx-memory 记忆查看器：无依赖静态页（数据来自 export_viewer_data.py 导出的 memory-data.json） */
(() => {
  'use strict';

  const $ = (id) => document.getElementById(id);
  const els = {
    stats: $('stats'), notice: $('notice'), fileInput: $('fileInput'),
    exportCsv: $('exportCsv'), resetBtn: $('resetBtn'),
    search: $('search'), type: $('typeFilter'), weight: $('weightFilter'),
    layer: $('layerFilter'), status: $('statusFilter'), frag: $('fragFilter'),
    ttl: $('ttlFilter'), minSize: $('minSize'), sortBy: $('sortBy'), pageSize: $('pageSize'),
    chips: $('activeFilters'), rows: $('rows'), empty: $('empty'),
    loadMore: $('loadMore'), pagerInfo: $('pagerInfo'),
    drawer: $('drawer'), mask: $('drawerMask'), drawerTitle: $('drawerTitle'), drawerBadges: $('drawerBadges'),
    closeDrawer: $('closeDrawer'), copyKey: $('copyKey'), copyValue: $('copyValue'),
    relations: $('drawerRelations'), drawerText: $('drawerText'), drawerMeta: $('drawerMeta'),
    tabs: Array.from(document.querySelectorAll('.tab')),
  };

  const SORTS = [
    ['updated_at', '更新时间'], ['created_at', '创建时间'], ['size', '字符数'],
    ['key', '键名'], ['type', '类型'], ['status', '状态'],
  ];
  const PAGE_SIZES = [25, 50, 100, 200, 0]; // 0 = 全部

  const state = {
    entries: [],
    source: '',
    generatedAt: 0,
    query: {
      q: '', type: '', weight: '', layer: '', status: '', frag: '', ttl: '',
      minSize: '', sortBy: 'updated_at', sortDir: 'desc', pageSize: 50,
    },
    filtered: [],
    visible: 0,
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
    const haystack = `${entry.key}\n${entry.value}\n${entry.tags.join(' ')}\n${entry.status || ''}\n${entry.layer || ''}`
      .toLowerCase();
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
    state.visible = state.query.pageSize || state.filtered.length;
    state.animateRows = true;
    render();
  }

  /* ---------------- render ---------------- */

  function renderStats() {
    const total = state.entries.length;
    const chars = state.entries.reduce((n, e) => n + e.size, 0);
    const shown = state.filtered.length;
    const shownChars = state.filtered.reduce((n, e) => n + e.size, 0);
    els.stats.innerHTML = [
      `共 <b>${fmtNum(total)}</b> 条`,
      `筛选命中 <b>${fmtNum(shown)}</b> 条 / ${fmtNum(shownChars)} 字符`,
      `全库 ${fmtNum(chars)} 字符`,
      state.generatedAt ? `数据时间 ${esc(fmtTime(state.generatedAt))}` : '',
    ].filter(Boolean).join(' · ');
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
    for (const th of document.querySelectorAll('.grid thead th[data-sort]')) {
      const active = th.dataset.sort === state.query.sortBy;
      th.classList.toggle('is-sorted', active);
      th.dataset.arrow = state.query.sortDir === 'asc' ? '▲' : '▼';
    }
  }

  function renderRows() {
    const terms = state.terms || [];
    const slice = state.filtered.slice(0, state.visible);
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

    els.empty.hidden = state.filtered.length > 0;
    const remaining = state.filtered.length - state.visible;
    els.loadMore.hidden = remaining <= 0;
    els.loadMore.textContent = `加载更多（剩 ${fmtNum(remaining)} 条）`;
    els.pagerInfo.textContent = state.filtered.length
      ? `显示 ${fmtNum(Math.min(state.visible, state.filtered.length))} / ${fmtNum(state.filtered.length)} 条`
      : '';
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
    document.body.classList.add('no-scroll');
    els.drawer.focus({ preventScroll: true });
  }

  function closeDrawer() {
    if (!els.drawer.classList.contains('is-open')) return;
    els.mask.classList.remove('is-open');
    els.drawer.classList.remove('is-open');
    els.drawer.setAttribute('aria-hidden', 'true');
    document.body.classList.remove('no-scroll');
    state.selectedKey = null;
    renderRows();
    if (lastFocused && typeof lastFocused.focus === 'function') lastFocused.focus({ preventScroll: true });
    lastFocused = null;
  }

  function setTab(tab) {
    state.tab = tab;
    for (const btn of els.tabs) btn.classList.toggle('is-active', btn.dataset.tab === tab);
    els.drawerText.hidden = tab !== 'text';
    els.drawerMeta.hidden = tab !== 'meta';
  }

  async function copy(text, label) {
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      const ta = document.createElement('textarea');
      ta.value = text;
      ta.style.position = 'fixed';
      ta.style.opacity = '0';
      document.body.appendChild(ta);
      ta.select();
      document.execCommand('copy');
      ta.remove();
    }
    flash(`${label}已复制`);
  }

  let flashTimer = 0;
  function flash(msg) {
    els.pagerInfo.textContent = msg;
    clearTimeout(flashTimer);
    flashTimer = setTimeout(() => {
      els.pagerInfo.textContent = state.filtered.length
        ? `显示 ${fmtNum(Math.min(state.visible, state.filtered.length))} / ${fmtNum(state.filtered.length)} 条`
        : '';
    }, 1600);
  }

  /* ---------------- data loading ---------------- */

  function normalize(payload) {
    if (!payload || !Array.isArray(payload.entries)) {
      throw new Error('JSON 结构不符：缺少 entries 数组（应由 export_viewer_data.py 生成）');
    }
    return payload.entries.map((e) => ({
      key: String(e.key),
      type: e.type || String(e.key).split(':')[0],
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
    }));
  }

  function applyPayload(payload, sourceLabel) {
    state.entries = normalize(payload);
    state.source = sourceLabel;
    state.generatedAt = Number(payload.generated_at) || 0;
    els.notice.hidden = true;
    buildFilters();
    recompute();
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
      // 默认值
      els.sortBy.value = state.query.sortBy;
      els.pageSize.value = String(state.query.pageSize);
    }
    restoreFromUrl();
    syncControls();
  }

  /* ---------------- URL state ---------------- */

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

  function writeUrl() {
    const q = state.query;
    const params = new URLSearchParams();
    for (const [k, v] of Object.entries(q)) {
      if (v !== '' && v != null && !((k === 'sortBy' && v === 'updated_at') || (k === 'sortDir' && v === 'desc') || (k === 'pageSize' && String(v) === '50'))) {
        params.set(k, String(v));
      }
    }
    const hash = params.toString();
    history.replaceState(null, '', hash ? `#${hash}` : location.pathname + location.search);
  }

  function restoreFromUrl() {
    const params = new URLSearchParams(location.hash.replace(/^#/, ''));
    const q = state.query;
    for (const key of Object.keys(q)) {
      if (!params.has(key)) continue;
      const v = params.get(key);
      q[key] = key === 'pageSize' ? Number(v) : v;
    }
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
    writeUrl();
    recompute();
  }

  /* ---------------- csv export ---------------- */

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

  /* ---------------- events ---------------- */

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
      state.query[key] = key === 'pageSize' ? 50 : '';
      if (key === 'q') els.search.value = '';
      syncControls();
      writeUrl();
      recompute();
    });

    for (const th of document.querySelectorAll('.grid thead th[data-sort]')) {
      th.addEventListener('click', () => {
        const field = th.dataset.sort;
        if (state.query.sortBy === field) {
          state.query.sortDir = state.query.sortDir === 'asc' ? 'desc' : 'asc';
        } else {
          state.query.sortBy = field;
          state.query.sortDir = field === 'key' || field === 'type' || field === 'status' ? 'asc' : 'desc';
        }
        els.sortBy.value = field;
        writeUrl();
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
    els.copyKey.addEventListener('click', () => state.selectedKey && copy(state.selectedKey, 'key '));
    els.copyValue.addEventListener('click', () => {
      const entry = state.selectedKey && findByKey(state.selectedKey);
      if (entry) copy(entry.value, '正文');
    });
    for (const tab of els.tabs) tab.addEventListener('click', () => setTab(tab.dataset.tab));

    els.loadMore.addEventListener('click', () => {
      state.visible += state.query.pageSize || state.filtered.length;
      state.animateRows = false;
      renderRows();
    });

    els.exportCsv.addEventListener('click', exportCsv);
    els.resetBtn.addEventListener('click', () => {
      state.query = {
        q: '', type: '', weight: '', layer: '', status: '', frag: '', ttl: '',
        minSize: '', sortBy: 'updated_at', sortDir: 'desc', pageSize: 50,
      };
      syncControls();
      writeUrl();
      recompute();
    });

    els.fileInput.addEventListener('change', async (ev) => {
      const file = ev.target.files && ev.target.files[0];
      if (!file) return;
      try {
        applyPayload(JSON.parse(await file.text()), file.name);
      } catch (err) {
        showNotice(`载入失败：${esc(err.message)}`);
      }
      ev.target.value = '';
    });

    document.addEventListener('keydown', (ev) => {
      if (ev.key === 'Escape' && els.drawer.classList.contains('is-open')) closeDrawer();
      if (ev.key === '/' && !/^(INPUT|SELECT|TEXTAREA)$/.test(document.activeElement.tagName)) {
        ev.preventDefault();
        els.search.focus();
      }
    });
  }

  function showNotice(html) {
    els.notice.innerHTML = html;
    els.notice.hidden = false;
  }

  /** 表头 sticky 偏移 = 实际页头高度（页头会换行，固定 60px 会错位） */
  /** 页头滚动后加深阴影，形成层次（classList.toggle 幂等，直接监听即可） */
  function trackHeaderScroll() {
    const header = document.querySelector('.app-header');
    if (!header) return;
    const apply = () => header.classList.toggle('is-scrolled', window.scrollY > 4);
    apply();
    window.addEventListener('scroll', apply, { passive: true });
  }

  function trackHeaderHeight() {
    const header = document.querySelector('.app-header');
    if (!header) return;
    const apply = () => document.documentElement.style.setProperty('--header-h', `${header.offsetHeight}px`);
    apply();
    if (typeof ResizeObserver === 'function') new ResizeObserver(apply).observe(header);
    else window.addEventListener('resize', apply);
  }

  async function boot() {
    bind();
    trackHeaderHeight();
    trackHeaderScroll();
    try {
      const res = await fetch('memory-data.json', { cache: 'no-cache' });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      applyPayload(await res.json(), 'memory-data.json');
    } catch {
      const fileMode = location.protocol === 'file:';
      showNotice(fileMode
        ? '当前以 <code>file://</code> 打开，浏览器禁止读取同目录 JSON。两种打开方式：<br>' +
          '① 点右上「载入 JSON」，选择 <code>tools/memory-viewer/memory-data.json</code>；<br>' +
          '② 在本目录运行 <code>python3 -m http.server 8765</code>，访问 <code>http://localhost:8765/</code>。'
        : '未找到 <code>memory-data.json</code>。生成方式：<br>' +
          '<code>python3 scripts/memory/export_viewer_data.py</code><br>' +
          '也可点右上「载入 JSON」直接选择已导出的文件。');
      
      els.stats.textContent = '等待数据…';
      els.empty.hidden = false;
      els.empty.textContent = '尚无数据';
      return;
    }
    showNotice(
      '这是本机记忆快照（含项目路径与正文），静态页不发起任何网络请求；数据文件已在 .gitignore 中。' +
      '刷新数据：重新运行 <code>python3 scripts/memory/export_viewer_data.py</code> 后刷新页面。'
    );
    setTimeout(() => { els.notice.hidden = true; }, 8000);
  }

  document.addEventListener('DOMContentLoaded', boot);
})();
