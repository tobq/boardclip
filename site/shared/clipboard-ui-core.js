(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.BoardClipCore = factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  // The shared search engine (site/shared/clip-search.js). Browser: it's loaded as a
  // <script> BEFORE this file (globalThis.BoardClipSearch). Node/tests: require it. ONE
  // authority for query syntax + filtering + ranking, reused by the app popup, the demo,
  // and the MCP search_clips tool.
  var Search = (typeof require === 'function')
    ? require('./clip-search')
    : (typeof globalThis !== 'undefined' ? globalThis.BoardClipSearch : undefined);

  function isPinned(item) { return item && item.pin != null; }
  function numpadOf(item) { return item && item.pin && typeof item.pin.number === 'number' ? item.pin.number : null; }
  function groupsOf(item) {
    return item && item.pin && Array.isArray(item.pin.groups) ? [...new Set(item.pin.groups)] : [];
  }
  function isInGroup(item, group) { return groupsOf(item).includes(group); }
  function cleanTitle(value) { return String(value == null ? '' : value).replace(/\s+/g, ' ').trim(); }
  function titleOf(item) { return cleanTitle(item && item.title); }
  function itemId(item) { return item && item.id; }
  function ensurePin(item) {
    if (!item.pin) item.pin = {};
    return item.pin;
  }
  function idForText(text, now) {
    let hash = 2166136261;
    const input = String(text || '');
    for (let i = 0; i < input.length; i += 1) {
      hash ^= input.charCodeAt(i);
      hash = Math.imul(hash, 16777619);
    }
    return `txt:${(hash >>> 0).toString(16)}:${now || 0}`;
  }
  function createTextItem(text, extra) {
    const now = Math.floor(Date.now() / 1000);
    const item = {
      id: idForText(text, now),
      type: 'text',
      text: String(text || ''),
      ts: now,
      updatedAt: now,
      pin: null,
      ...(extra || {}),
    };
    if (!item.id) item.id = idForText(item.text, item.ts);
    return item;
  }
  function ago(ts, now) {
    const s = Math.max(0, Math.floor((now || Date.now() / 1000) - (ts || 0)));
    if (s < 3) return 'now';
    if (s < 60) return `${s}s`;
    if (s < 3600) return `${Math.floor(s / 60)}m`;
    if (s < 86400) return `${Math.floor(s / 3600)}h`;
    return `${Math.floor(s / 86400)}d`;
  }
  function nextAgoDelayMs(ts, now) {
    const current = now || Date.now() / 1000;
    const age = Math.max(0, Math.floor(current - (ts || 0)));
    if (age < 60) return 1000;
    if (age < 3600) return (60 - age % 60) * 1000 + 50;
    if (age < 86400) return (3600 - age % 3600) * 1000 + 50;
    return 3600000;
  }
  function updateRelativeTimes(root, selector) {
    const scope = root && root.querySelectorAll ? root : document;
    const nodes = Array.from(scope.querySelectorAll(selector || '[data-relative-ts]'));
    let nextDelay = 3600000;
    const now = Date.now() / 1000;
    for (const node of nodes) {
      const ts = Number(node.dataset.relativeTs);
      if (!Number.isFinite(ts)) continue;
      const label = ago(ts, now);
      if (node.textContent !== label) node.textContent = label;
      nextDelay = Math.min(nextDelay, nextAgoDelayMs(ts, now));
    }
    return nodes.length ? nextDelay : 0;
  }
  function numpadMap(items) {
    const map = {};
    (items || []).forEach((item) => {
      const slot = numpadOf(item);
      if (slot) map[slot] = itemId(item);
    });
    return map;
  }
  const BUILTIN_FILTERS = [
    { id: '__pinned__', icon: 'star', label: 'Pinned', ariaLabel: 'Pinned' },
    { id: '__numbered__', icon: 'numpad', label: 'Numpad', ariaLabel: 'Numpad' },
    { id: '__images__', icon: 'image', label: 'Images', ariaLabel: 'Images' },
  ];
  function builtinFilterCount(items, id) {
    if (id === '__pinned__') return (items || []).filter(isPinned).length;
    if (id === '__numbered__') return (items || []).filter((item) => numpadOf(item) != null).length;
    if (id === '__images__') return (items || []).filter((item) => item && item.type === 'image').length;
    return 0;
  }
  function builtinFilters(items, activeFilters) {
    return BUILTIN_FILTERS
      .map((filter) => {
        const count = builtinFilterCount(items, filter.id);
        return { ...filter, count, active: !!(activeFilters && activeFilters.has(filter.id)) };
      })
      .filter((filter) => filter.count > 0);
  }
  function itemSearchText(item) {
    if (!item) return '';
    return [
      titleOf(item),
      item.type === 'image' ? 'image' : item.text || '',
      item.type || '',
      ...groupsOf(item),
    ].join(' ');
  }
  function normalizeTagName(group) {
    return String(group || '').split('/').map(part => part.trim()).filter(Boolean).join('/');
  }
  function tagParentPaths(group) {
    const name = normalizeTagName(group);
    if (!name) return [];
    const parts = name.split('/');
    const paths = [];
    for (let i = 1; i <= parts.length; i += 1) paths.push(parts.slice(0, i).join('/'));
    return paths;
  }
  function tagMatchesFilter(group, filter) {
    const tag = normalizeTagName(group);
    const parent = normalizeTagName(filter);
    return !!parent && (tag === parent || tag.startsWith(`${parent}/`));
  }
  function itemMatchesGroupFilter(item, filter) {
    return groupsOf(item).some(group => tagMatchesFilter(group, filter));
  }
  function groupFilterCount(items, filter) {
    const key = normalizeTagName(filter);
    if (!key) return 0;
    return (items || []).filter(item => itemMatchesGroupFilter(item, key)).length;
  }
  function sourceGroupsFromFilters(filters) {
    return [...asFilterSet(filters)]
      .map(normalizeTagName)
      .filter(group => group && !group.startsWith('__'));
  }
  function buildTagTree(groups) {
    const roots = [];
    const byName = new Map();
    const sourceGroups = [...new Set((groups || []).map(normalizeTagName).filter(Boolean))];
    function ensureNode(name, stored) {
      const tag = normalizeTagName(name);
      if (!tag) return null;
      let node = byName.get(tag);
      if (!node) {
        node = { name: tag, label: tag.split('/').pop(), depth: tag.split('/').length - 1, stored: false, children: [] };
        byName.set(tag, node);
        const slash = tag.lastIndexOf('/');
        if (slash >= 0) {
          const parent = ensureNode(tag.slice(0, slash), false);
          if (parent && !parent.children.includes(node)) parent.children.push(node);
        } else if (!roots.includes(node)) roots.push(node);
      }
      if (stored) node.stored = true;
      return node;
    }
    for (const group of sourceGroups) {
      for (const path of tagParentPaths(group)) ensureNode(path, path === group);
    }
    const sortNodes = (nodes) => {
      nodes.sort((a, b) => a.label.localeCompare(b.label, undefined, { sensitivity: 'base', numeric: true }));
      nodes.forEach(node => sortNodes(node.children));
    };
    sortNodes(roots);
    return roots;
  }
  function renderTagTreeMenu(nodes, options, depth) {
    const opts = options || {};
    const level = Number(depth) || 0;
    return (nodes || []).map((node) => renderTagTreeMenuNode(node, opts, level)).join('');
  }
  function renderTagTreeMenuNode(node, options, depth) {
    const opts = options || {};
    const mode = opts.mode || 'filter';
    const isFilter = mode === 'filter';
    const group = normalizeTagName(node && node.name);
    if (!group) return '';
    // Picker mode (a clip's group checklist) is the shared menu row tree.
    if (!isFilter) {
      const itemGroups = asFilterSet(opts.itemGroups);
      return renderGroupChecklist([node], (g) => (itemGroups.has(g) ? 'all' : 'none'), 'toggle-group');
    }
    const activeFilters = asFilterSet(opts.activeFilters || opts.filters);
    const excludedFilters = asFilterSet(opts.excludedFilters);
    const text = escapeHtml(node.label || group);
    const hasChildren = !!(node.children && node.children.length);
    const treeClass = `${hasChildren ? ' has-children' : ''}${node.stored ? '' : ' virtual'}`;
    // opts.verdict(group): the availability census's word on this chip (its
    // count under the other filters; greyed + inert when it would show nothing).
    const v = opts.verdict ? opts.verdict({ kind: 'group', value: group }) : null;
    const count = v ? v.count : groupFilterCount(opts.items || [], group);
    const disabled = !!(v && !v.enabled);
    const title = excludedFilters.has(group)
      ? `Excluding ${group}`
      : disabled ? `${group} - ${v.reason}` : `${group} - ${count} item${count !== 1 ? 's' : ''}`;
    const state = activeFilters.has(group) ? 'include' : excludedFilters.has(group) ? 'exclude' : '';
    // Inside a chip's dropdown a group is the shared menu row (menuRowHtml):
    // the include check / exclude glyph in the icon column, the count as its
    // hint, the label struck through while excluded. Click includes and
    // right-click excludes (the controller's FILTER_TARGET); a greyed row is
    // inert like a greyed chip (aria-disabled, never `disabled`, which would
    // swallow the events the guard reads).
    if (depth > 0) {
      const row = {
        icon: state === 'include' ? 'check' : state === 'exclude' ? 'block' : '',
        check: state === 'include',
        label: node.label || group,
        hint: disabled ? '' : String(count),
        cls: `group-filter-row${state === 'exclude' ? ' excluded' : ''}${disabled ? ` is-disabled${v.kind === 'structural' ? ' dis-structural' : ''}` : ''}`,
        attrs: { 'data-group': group, title, 'aria-disabled': disabled ? 'true' : null },
      };
      return hasChildren
        ? `<div class="tag-menu-node has-children">${menuRowHtml({ ...row, caret: true })}<div class="tag-submenu" role="menu">${renderTagTreeMenu(node.children, opts, depth + 1)}</div></div>`
        : menuRowHtml(row);
    }
    const caret = hasChildren ? '<span class="tag-caret mi" aria-hidden="true">expand_more</span>' : '';
    // A filter chip only filters: deleting a group lives in Settings > Groups
    // (a hover x here deleted the whole group, 14 px from the filter toggle).
    const control = renderChip({
      cls: `group-tag${treeClass}${disabledChipClass(disabled ? { disabled, disabledKind: v.kind } : null)}`,
      state,
      attrs: { 'data-group': group, title, 'aria-label': group, 'aria-disabled': disabled ? 'true' : null },
      html: `<span class="tag-label">${text}</span>${caret}`,
    });
    // popover="manual": the chip row is a one-line strip that scrolls under a
    // mask, which would clip a nested submenu; installSubmenuAutoflip shows it
    // in the top layer instead, beside its chip.
    const children = hasChildren
      ? `<div class="tag-submenu" role="menu" popover="manual">${renderTagTreeMenu(node.children, opts, depth + 1)}</div>`
      : '';
    return `<span class="tag-menu-node${hasChildren ? ' has-children' : ''}">${control}${children}</span>`;
  }
  function prepareQuery(query, regex) {
    const q = String(query || '').trim();
    if (!q) return { kind: 'none' };
    if (regex) {
      try { return { kind: 'regex', regex: new RegExp(q, 'i') }; } catch { return { kind: 'invalid' }; }
    }
    return { kind: 'text', needle: q.toLowerCase() };
  }
  function matchesPreparedQuery(text, prepared, lowerText) {
    if (!prepared || prepared.kind === 'none') return true;
    if (prepared.kind === 'invalid') return false;
    if (prepared.kind === 'regex') return prepared.regex.test(String(text || ''));
    if (lowerText != null) return String(lowerText).includes(prepared.needle);
    return String(text || '').toLowerCase().includes(prepared.needle);
  }
  function matchesQuery(text, query, regex) {
    return matchesPreparedQuery(text, prepareQuery(query, regex));
  }
  function asFilterSet(value) {
    if (value instanceof Set) return value;
    if (Array.isArray(value)) return new Set(value);
    return new Set();
  }
  function filterStateFrom(stateOrFilters) {
    if (stateOrFilters instanceof Set || Array.isArray(stateOrFilters)) {
      return { filters: asFilterSet(stateOrFilters), excludedFilters: new Set() };
    }
    const state = stateOrFilters || {};
    return {
      filters: asFilterSet(state.filters || state.activeFilters),
      excludedFilters: asFilterSet(state.excludedFilters),
    };
  }
  function ensureFilterState(state) {
    if (!state) return { filters: new Set(), excludedFilters: new Set() };
    if (!(state.filters instanceof Set)) state.filters = asFilterSet(state.filters);
    if (!(state.excludedFilters instanceof Set)) state.excludedFilters = asFilterSet(state.excludedFilters);
    return state;
  }
  function hasActiveFilters(stateOrFilters) {
    const state = filterStateFrom(stateOrFilters);
    if (state.filters.size || state.excludedFilters.size) return true;
    const q = stateOrFilters && stateOrFilters.query;
    return !!(q && Search && Search.anyFilterActive(Search.parseQuery(q)));
  }
  function filterTokenMatches(item, filter) {
    const key = String(filter || '');
    if (key === '__pinned__') return isPinned(item);
    if (key === '__numbered__') return numpadOf(item) != null;
    if (key === '__images__') return item && item.type === 'image';
    if (key.startsWith('__')) return false;
    return itemMatchesGroupFilter(item, key);
  }
  function matchesFilter(item, stateOrFilters) {
    const state = filterStateFrom(stateOrFilters);
    for (const filter of state.filters) {
      if (!filterTokenMatches(item, filter)) return false;
    }
    for (const filter of state.excludedFilters) {
      if (filterTokenMatches(item, filter)) return false;
    }
    return true;
  }
  function applyFilterIntent(state, filter, intent) {
    const key = String(filter || '');
    if (!key) return false;
    const next = ensureFilterState(state);
    const exclude = intent === 'exclude';
    if (exclude) {
      if (next.excludedFilters.has(key)) {
        next.excludedFilters.delete(key);
      } else {
        next.filters.delete(key);
        next.excludedFilters.add(key);
      }
      return true;
    }
    if (next.filters.has(key)) {
      next.filters.delete(key);
    } else if (next.excludedFilters.has(key)) {
      next.excludedFilters.delete(key);
    } else {
      next.excludedFilters.delete(key);
      next.filters.add(key);
    }
    return true;
  }
  function clearFilterState(state) {
    const next = ensureFilterState(state);
    next.filters.clear();
    next.excludedFilters.clear();
  }
  // Build the engine's parsed query from a UI state object. The search-bar TEXT is the
  // source of truth (facets live as `group:`/`is:`/… tokens in it); legacy `filters`/
  // `excludedFilters` Sets are still accepted (tests + any old caller) and folded into the
  // same parsed model so there is ONE matcher.
  function parsedFromState(state) {
    const s = state || {};
    const parsed = Search.parseQuery(s.query || '');
    const fold = (set, exclude) => {
      for (const f of asFilterSet(set)) {
        const key = String(f);
        if (key.startsWith('__')) { const isv = Search.BUILTIN_TO_IS[key]; if (isv) (exclude ? parsed.negIs : parsed.is).push(isv); }
        else if (key) (exclude ? parsed.negGroups : parsed.groups).push(Search.normalizeTagName(key));
      }
    };
    fold(s.filters, false);
    fold(s.excludedFilters, true);
    return parsed;
  }
  // Ranked, filtered ORIGINAL indexes (relevance when searching, history order when idle).
  // Forward window 'error' + 'unhandledrejection' to `report({type, message, stack,
  // source, line})`. Shared so every renderer (popup, editor, viewer, demo) can log
  // exceptions the same way; a no-op outside a browser.
  function installRendererErrorReporting(report) {
    if (typeof window === 'undefined' || typeof report !== 'function') return () => {};
    const onError = (e) => {
      try {
        report({ type: 'error', message: String(e.message || ''), stack: e.error && e.error.stack ? String(e.error.stack).slice(0, 2000) : '', source: e.filename || '', line: e.lineno || 0 });
      } catch {}
    };
    const onRejection = (e) => {
      try {
        const r = e.reason;
        report({ type: 'unhandledrejection', message: r && r.message ? String(r.message) : String(r), stack: r && r.stack ? String(r.stack).slice(0, 2000) : '' });
      } catch {}
    };
    window.addEventListener('error', onError);
    window.addEventListener('unhandledrejection', onRejection);
    return () => { window.removeEventListener('error', onError); window.removeEventListener('unhandledrejection', onRejection); };
  }

  function filterItemIndexes(items, state) {
    const s = state || {};
    return Search.filterRankIndexes(items, parsedFromState(s), {
      regex: !!s.regex,
      now: s.now,
      sortMode: s.sortMode,
      docs: s.docs,
      searchTextLower: s.searchTextLower,
      cache: s.cache, // a caller-owned object: lets the next keystroke refine the last result
    });
  }
  function filterItems(items, state) {
    const list = items || [];
    return filterItemIndexes(list, state).map((i) => list[i]);
  }
  function itemCountLabel(total, visible, state) {
    const count = Number(total) || 0;
    const shown = Number(visible) || 0;
    const label = count === 1 ? 'item' : 'items';
    return state && (state.query || hasActiveFilters(state)) ? `${shown} of ${count} ${label}` : `${count} ${label}`;
  }
  function escapeHtml(value) {
    return String(value == null ? '' : value).replace(/[&<>"']/g, (char) => ({
      '&': '&amp;',
      '<': '&lt;',
      '>': '&gt;',
      '"': '&quot;',
      "'": '&#39;',
    }[char]));
  }
  function builtinFilterTitle(filter) {
    if (!filter) return '';
    if (filter.id === '__numbered__') return `${filter.count} macro${filter.count !== 1 ? 's' : ''} set for numpad`;
    if (filter.id === '__pinned__') return `${filter.count} pinned item${filter.count !== 1 ? 's' : ''}`;
    if (filter.id === '__images__') return `${filter.count} image clip${filter.count !== 1 ? 's' : ''}`;
    return `${filter.count} ${filter.label.toLowerCase()}`;
  }
  // ONE chip for every filter control: the chip bar's icon facets and group
  // chips and the options panel's facet chips. Idle = dim text, no fill; hover
  // = text + the hover overlay; include = accent tint (+ a filled glyph);
  // exclude = struck through. o: { tag ('span' | 'button'), cls, state
  // ('include' | 'exclude' | ''), attrs {name: value, true = bare}, html }.
  function renderChip(o) {
    const tag = o.tag === 'button' ? 'button' : 'span';
    const state = o.state === 'include' ? ' active' : o.state === 'exclude' ? ' excluded' : '';
    let attrs = tag === 'button' ? ' type="button"' : '';
    for (const [name, value] of Object.entries(o.attrs || {})) {
      if (value == null || value === false) continue;
      attrs += value === true ? ` ${name}` : ` ${name}="${escapeHtml(value)}"`;
    }
    return `<${tag} class="filter-tag${o.cls ? ` ${o.cls}` : ''}${state}"${attrs}>${o.html || ''}</${tag}>`;
  }
  function builtinFilterIconHtml(filter, options) {
    const iconMode = options && options.iconMode || 'material';
    if (!filter) return '';
    if (filter.icon === 'numpad') return iconMode === 'unicode' ? '#' : '<span class="mi">tag</span>';
    if (filter.icon === 'star') {
      if (iconMode === 'unicode') return '&#9734;';
      return '<span class="mi">star</span>';
    }
    if (filter.icon === 'image') {
      if (iconMode === 'svg') {
        return '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 5.5A2.5 2.5 0 0 1 7.5 3h9A2.5 2.5 0 0 1 19 5.5v13A2.5 2.5 0 0 1 16.5 21h-9A2.5 2.5 0 0 1 5 18.5v-13Zm2 9.9 3.1-3.1a1.2 1.2 0 0 1 1.7 0l1.7 1.7.8-.8a1.2 1.2 0 0 1 1.7 0l1 1V5.5a.5.5 0 0 0-.5-.5h-9a.5.5 0 0 0-.5.5v9.9Zm0 2.8v.3c0 .3.2.5.5.5h9a.5.5 0 0 0 .5-.5v-1.5l-1.9-1.9-.8.8a1.2 1.2 0 0 1-1.7 0l-1.7-1.7L7 18.2ZM9 8.2a1.2 1.2 0 1 1 2.4 0A1.2 1.2 0 0 1 9 8.2Z"/></svg>';
      }
      return '<span class="mi">image</span>';
    }
    return escapeHtml(filter.label);
  }
  function renderFilterBar(params) {
    const options = params || {};
    const items = options.items || [];
    const groups = options.groups || [];
    const activeFilters = asFilterSet(options.activeFilters || options.filters);
    const excludedFilters = asFilterSet(options.excludedFilters);
    const query = options.query || '';
    const builtinCounts = options.builtinCounts || null;
    const groupCounts = options.groupCounts || null;
    let html = '';
    const filters = builtinCounts
      ? BUILTIN_FILTERS
        .map((filter) => ({
          ...filter,
          count: builtinCounts[filter.id] || 0,
          active: activeFilters.has(filter.id),
          excluded: excludedFilters.has(filter.id),
        }))
        .filter((filter) => filter.count > 0)
      : builtinFilters(items, activeFilters)
        .map((filter) => ({ ...filter, excluded: excludedFilters.has(filter.id) }));
    // options.census (Search.facetCensus for this query): every chip's count is
    // the clips it would show under the OTHER active filters; one that would
    // show none is greyed + inert with the reason as its tooltip (the current
    // selection never is). No census = every chip enabled.
    const census = options.census || null;
    const parsed = census ? Search.parseQuery(query) : null;
    const verdict = census ? (token) => Search.facetOptionVerdict(census, parsed, token) : null;
    for (const filter of filters) {
      const v = census ? Search.facetOptionVerdict(census, parsed, { kind: 'builtin', value: filter.id }, { selected: !!(filter.active || filter.excluded) }) : null;
      if (v && v.hidden) continue;
      const disabled = !!(v && !v.enabled);
      const counted = v ? { ...filter, count: v.count } : filter;
      const title = filter.excluded ? `Excluding ${filter.label}` : disabled ? `${filter.label} - ${v.reason}` : builtinFilterTitle(counted);
      html += renderChip({
        cls: `builtin icon-filter${disabledChipClass(disabled ? { disabled, disabledKind: v.kind } : null)}`,
        state: filter.active ? 'include' : filter.excluded ? 'exclude' : '',
        attrs: { 'data-filter': filter.id, title, 'aria-label': filter.ariaLabel, 'aria-disabled': disabled ? 'true' : null },
        html: builtinFilterIconHtml(filter, options),
      });
    }
    html += renderTagTreeMenu(buildTagTree(groups), {
      mode: 'filter',
      items,
      activeFilters,
      excludedFilters,
      groupCounts,
      verdict,
    });
    if ((activeFilters.size || excludedFilters.size) && !query) {
      html += '<span class="filter-tag clear-filter icon-filter" data-action="clear-search-filters" title="Clear filters" aria-label="Clear filters"><span class="mi">close</span></span>';
    }
    return html;
  }
  // An image preview: the picture in a wrapper the size of the picture, so the
  // row's buttons can float over its top-right corner (actionsHtml) instead of
  // taking a column. Known pixel size: width/height reserve the row's space
  // before the image loads (no layout jump under a kept scroll place) and
  // --ar/--nw let the shared CSS size the wrapper from --clip-img-h (the
  // zoomable preview height) without ever widening past the row or past the
  // image's real size.
  function imagePreviewHtml(item, options) {
    const opts = options || {};
    const src = typeof opts.imageSrc === 'function' ? opts.imageSrc(item) : item.imageSrc || item.image || '';
    const w = Math.round(Number(item.width));
    const h = Math.round(Number(item.height));
    const known = w > 0 && h > 0;
    const vars = known ? ` style="--ar:${+(w / h).toFixed(4)};--nw:${w}px"` : '';
    const dims = known ? ` width="${w}" height="${h}"` : '';
    // Decoded synchronously (no async decoding hint): every list rebuild re-creates the rows, and an async
    // decode painted image rows blank for a frame (the "opens twice" flicker).
    const actions = opts.actionsHtml ? `<span class="img-actions-anchor"><span class="img-actions">${opts.actionsHtml}</span></span>` : '';
    return `<span class="preview-img"${vars}><img src="${escapeHtml(src)}" alt="image"${dims}>${actions}</span>`;
  }
  // Row text anatomy (one for every text row). The primary line is the clip's
  // real title or, untitled, its first non-empty line (derived); the preview is
  // the rest of the text (all of it under a real title, minus a first line that
  // only repeats the title), one line, windowed around the first match.
  // Bounded for huge clips: the first non-empty line is looked for within
  // ROW_LINE_SCAN chars (no newline there = the rest is one line), and every
  // part goes through the match-centred window, so nothing here scans,
  // flattens or lowercases a whole body.
  //   opts: { query, regex, matchIndex (where the match sits in item.text) }
  // Returns { primary, derived, rest } ('' rest = no preview line).
  const ROW_BLANK_LINES_MAX = 200;
  const ROW_LINE_SCAN = 65536;
  // Every row line is ONE line: a ROW_LINE_CHARS window (wider than any popup
  // shows) keeps the text a row lays out small, and keeps the match
  // ROW_LINE_LEAD chars in, so a highlighted match is on screen.
  const ROW_LINE_CHARS = 320;
  const ROW_LINE_LEAD = 24;
  // The first non-empty line of text: { start, end, next } (end = its newline
  // or the text's end, next = where the rest starts), or null when the text is
  // blank. Past ROW_BLANK_LINES_MAX blank lines the line is empty and the rest
  // starts there.
  function rowFirstLine(text) {
    let start = 0;
    for (let k = 0; k < ROW_BLANK_LINES_MAX && start < text.length; k += 1) {
      const scanEnd = Math.min(text.length, start + ROW_LINE_SCAN);
      const nl = text.slice(start, scanEnd).indexOf('\n');
      const end = nl < 0 ? text.length : start + nl;
      if (/\S/.test(text.slice(start, Math.min(end, scanEnd)))) return { start, end, next: Math.min(text.length, end + 1) };
      if (nl < 0) return null;
      start = end + 1;
    }
    return start < text.length ? { start, end: start, next: start } : null;
  }
  function clipRowText(item, options) {
    const o = options || {};
    const text = String(item && item.text || '');
    const mi = Number.isFinite(o.matchIndex) ? o.matchIndex : null;
    const windowed = (part, at) => collapsedPreviewText(part, o.query, o.regex, { max: ROW_LINE_CHARS, lead: ROW_LINE_LEAD, ...(at != null ? { matchIndex: at } : {}) });
    // The part of text from `from` on, with the match index made relative to it.
    const restFrom = (from) => {
      const restText = text.slice(from);
      if (!/\S/.test(restText)) return '';
      const at = mi != null && mi >= from ? mi - from : (mi != null ? -1 : null);
      return windowed(restText, at).replace(/^\s+/, '');
    };
    const title = titleOf(item);
    const line = rowFirstLine(text);
    if (title) {
      // A first line that only repeats the title is not shown twice.
      const repeats = line && line.end - line.start <= title.length + 64
        && text.slice(line.start, line.end).trim().toLowerCase() === String(title).trim().toLowerCase();
      if (!repeats) return { primary: title, derived: false, rest: windowed(text, mi) };
      return { primary: title, derived: false, rest: restFrom(line.next) };
    }
    if (!line) return { primary: '', derived: true, rest: '' };
    const { start, end } = line;
    const lineAt = mi != null && mi >= start && mi < end ? mi - start : (mi != null ? -1 : null);
    const primary = windowed(text.slice(start, end), lineAt).trim();
    return { primary, derived: true, rest: restFrom(line.next) };
  }
  // Meta line: time, size, the numpad badge, the clip's groups as plain text
  // (each still a filter: click includes, right-click excludes) and, at its
  // end, the hover-only ghost # (assign a numpad key; only when none is set,
  // else the badge itself opens the keypad) and + (add to a group) on the
  // shared reveal. The line never wraps: group names that no longer fit (as
  // the ghosts slide in) drop out whole, never as fragments, so no row ever
  // changes height, and nothing is reserved when unset.
  function renderClipMeta(item) {
    const isImage = item && item.type === 'image';
    let html = `<span class="meta-time" data-relative-ts="${item.ts || 0}">${ago(item.ts)}</span>`;
    html += isImage
      ? `<span class="meta-size">${escapeHtml(`${item.width || '?'}x${item.height || '?'}`)}</span>`
      : `<span class="meta-size">${String(item && item.text || '').length.toLocaleString()} chars</span>`;
    return html + renderClipKeys(item);
  }
  // A clip's keys: the numpad badge, its group names and the hover ghosts #
  // and + on the shared reveal. ONE renderer for a row's meta line AND a clip
  // window's title bar (opts.inWindow), so a clip's pin / key / groups read
  // and work the same everywhere. In a window there is no list to filter: a
  // name opens the group picker (where it is checked, so a click removes it).
  // `item` null = a new note, not a clip yet: just the ghosts (commit-on-add).
  function renderClipKeys(item, opts) {
    const inWindow = !!(opts && opts.inWindow);
    const np = item ? numpadOf(item) : null;
    let html = '';
    if (np) html += `<button class="meta-np" type="button" data-action="numpad-open" title="Numpad key ${np}: change or remove" aria-label="Numpad key ${np}">#${np}</button>`;
    const groups = item ? groupsOf(item) : [];
    if (groups.length) {
      html += '<span class="meta-tags">';
      for (const group of groups) {
        const g = escapeHtml(group);
        html += inWindow
          ? `<button class="meta-tag" type="button" data-action="tag-add" title="In ${g}: change groups">${g}</button>`
          : `<button class="meta-tag" type="button" data-group="${g}" title="Filter by ${g} (right-click to exclude)">${g}</button>`;
      }
      html += '</span>';
    }
    const ghosts = (np ? '' : '<button class="meta-ghost" type="button" data-action="numpad-open" title="Assign a numpad key" aria-label="Assign a numpad key"><span class="mi">tag</span></button>')
      + '<button class="meta-ghost" type="button" data-action="tag-add" title="Add to group" aria-label="Add to group"><span class="mi">add</span></button>';
    return `${html}<span class="bc-reveal meta-reveal"><span class="bc-reveal-inner">${ghosts}</span></span>`;
  }
  // The meta line's group names when a row opens its ghosts (# / +, the
  // reveal at the line's end): a wrapping names box keeps the width it had, so
  // the + would sit at its far edge with a gap after the last name that still
  // shows. Instead the names that would not fit beside the open ghosts are
  // marked .meta-cut (hidden whole only while the reveal is open, CSS) and the
  // box shrinks to the rest. Worked out from the closed row (the ghosts' open
  // width is the meta line's height per ghost plus the gaps), one row per
  // hover, so it costs nothing on the typing path. The first name is never set
  // aside (alone on the line it ellipsizes).
  function fitMetaTags(row) {
    const box = row && row.querySelector ? row.querySelector('.meta-tags') : null;
    if (!box || typeof getComputedStyle !== 'function') return;
    const tags = Array.from(box.children);
    for (const t of tags) t.classList.remove('meta-cut');
    const meta = box.parentElement;
    const inner = meta && meta.querySelector('.meta-reveal > .bc-reveal-inner');
    if (!inner || tags.length < 2) return;
    const ghosts = Array.from(inner.children);
    const metaStyle = getComputedStyle(meta);
    const metaRect = meta.getBoundingClientRect();
    const px = (v) => parseFloat(v) || 0;
    // Room the open reveal takes after the names box: its own gap (the line's
    // gap is cancelled by the reveal's negative margin) and the ghosts.
    const revealStyle = getComputedStyle(inner.parentElement);
    const ghostGap = px(getComputedStyle(inner).columnGap);
    const open = px(metaStyle.columnGap) + px(revealStyle.marginLeft) + (ghosts.length ? px(getComputedStyle(ghosts[0]).marginInlineStart) : 0)
      + ghosts.length * metaRect.height + Math.max(0, ghosts.length - 1) * ghostGap;
    const boxStyle = getComputedStyle(box);
    const limit = metaRect.right - open;
    const tagMargin = px(getComputedStyle(tags[0]).marginLeft) + px(getComputedStyle(tags[0]).marginRight);
    const nameGap = px(boxStyle.columnGap);
    let x = box.getBoundingClientRect().left + px(boxStyle.paddingLeft);
    tags.forEach((t, i) => {
      const right = x + t.getBoundingClientRect().width + tagMargin;
      if (i > 0 && right > limit + 0.5) { for (const rest of tags.slice(i)) rest.classList.add('meta-cut'); x = Infinity; }
      else x = right + nameGap;
    });
  }
  // One row. opts: { query, regex, matchIndex, highlight(text), highlightTitle(text),
  // imageSrc(item), actionsHtml (Core.renderClipActions), selection (the
  // controller's selection(): paints the cursor, checked, held and similar
  // states) or the legacy selected / multiSelected booleans }.
  function renderClipItem(item, options) {
    const opts = options || {};
    const id = itemId(item) || '';
    const pinned = isPinned(item);
    const isImage = item && item.type === 'image';
    const sel = opts.selection || null;
    const hl = typeof opts.highlight === 'function' ? opts.highlight : (s) => highlight(s, opts.query, opts.regex);
    const hlTitle = typeof opts.highlightTitle === 'function' ? opts.highlightTitle : hl;
    let primaryHtml = '';
    let previewHtml = '';
    if (isImage) {
      // Both text and images can carry a title (images are named so they're searchable).
      const title = titleOf(item);
      if (title) primaryHtml = `<div class="clip-title">${hlTitle(title)}</div>`;
      previewHtml = `<div class="preview image">${imagePreviewHtml(item, opts)}</div>`;
    } else if (opts.expanded) {
      const title = titleOf(item);
      if (title) primaryHtml = `<div class="clip-title">${hlTitle(title)}</div>`;
      previewHtml = `<div class="preview expanded">${hl(String(item.text || ''))}</div>`;
    } else {
      const parts = clipRowText(item, opts);
      primaryHtml = parts.derived
        ? `<div class="clip-title derived">${parts.primary ? hl(parts.primary) : '&nbsp;'}</div>`
        : `<div class="clip-title">${hlTitle(parts.primary)}</div>`;
      if (parts.rest) previewHtml = `<div class="preview collapsed">${hl(parts.rest)}</div>`;
    }
    const is = (flag, fromSel) => (sel ? fromSel(sel) : !!opts[flag]);
    // `selected` = keyboard focus cursor (single). `multi-selected` = membership
    // in the multi-select set (Ctrl/Shift-click). `actions-held` keeps the row's
    // buttons out while its menu is open or it is being dragged; `similar` =
    // a candidate duplicate of the hovered / cursor row (Core.similarClipIds).
    let cls = pinned ? ' has-pin' : '';
    if (is('selected', (s) => s.focusId === id)) cls += ' selected';
    if (is('multiSelected', (s) => !!(s.selectedIds && s.selectedIds.has(id)))) cls += ' multi-selected';
    if (sel && sel.heldId === id) cls += ' actions-held';
    if (sel && sel.similarIds && sel.similarIds.has(id)) cls += ' similar';
    // The row's buttons: a text row's slide in on the shared reveal (closed =
    // 0 px, the text runs full width); an image row's float over the picture.
    const actionsHtml = opts.actionsHtml || '';
    const actions = !isImage && actionsHtml
      ? `<span class="bc-reveal row-actions"><span class="bc-reveal-inner">${actionsHtml}</span></span>`
      : '';
    // draggable: a row drags its clip out (controller.onDragstart): images as
    // files, text as text. A still click still pastes. No whitespace between
    // the tags: every rebuild parses and styles ~60 rows, and indentation was
    // a dozen extra text nodes per row.
    return `<div class="item${cls}" data-id="${escapeHtml(id)}" draggable="true">`
      + '<div class="item-row"><div class="pin-area">'
      + `<button class="star${pinned ? ' active' : ''}" type="button" data-action="pin" data-id="${escapeHtml(id)}" title="${pinned ? 'Unpin' : 'Pin'}"><span class="mi${pinned ? ' filled' : ''}">star</span></button>`
      + `</div><div class="content">${primaryHtml}${previewHtml}<div class="meta">${renderClipMeta(item)}</div></div>${actions}</div></div>`;
  }
  // Empty list states, ONE renderer for the app and the demo: what is empty and
  // why, with the way out. kind (derived from { total, query } when omitted):
  //   'no-clips'    - history is empty
  //   'no-match'    - the search text matches nothing
  //   'filtered'    - the filters (group:/is:/since:/...) exclude everything
  //   'empty-group' - the only filter is one group, and it has no clips
  // opts.nudgeHtml fills the .empty-nudge slot (renderRelaxNudge);
  // opts.regex / opts.groups let it tell an invalid query from a bad spelling.
  function emptyStateKind(opts) {
    const o = opts || {};
    if (!(Number(o.total) > 0)) return 'no-clips';
    const parsed = Search.parseQuery(o.query || '');
    if (parsed.content.length) return 'no-match';
    const onlyGroup = parsed.groups.length === 1 && !parsed.negGroups.length && !parsed.is.length && !parsed.negIs.length
      && !parsed.nums.length && !parsed.negNums.length && !parsed.since && !parsed.before && !parsed.len && !parsed.lines && !parsed.words && !parsed.id;
    return onlyGroup ? 'empty-group' : 'filtered';
  }
  function renderEmptyState(options) {
    const o = options || {};
    const kind = o.kind || emptyStateKind(o);
    const parsed = Search.parseQuery(o.query || '');
    const said = parsed.content.filter((c) => !c.neg).map((c) => c.value).join(' ').trim();
    const group = parsed.groups[0] || '';
    const states = {
      'no-clips': { icon: 'content_paste', title: 'No clips yet', hint: 'Copy something and it shows up here.' },
      'no-match': { icon: 'search_off', title: said ? `No matches for "${said}"` : 'No matches', hint: 'Check the spelling, or try fewer or different words.', action: 'Clear search' },
      filtered: { icon: 'filter_alt_off', title: 'Nothing matches these filters', hint: 'Every clip is hidden by the active filters.', action: 'Clear filters' },
      'empty-group': { icon: 'sell', title: `No clips in ${group || 'this group'} yet`, hint: 'Add a clip with the + on its row, or from its menu.', action: 'Show all clips' },
    };
    const s = states[kind] || states['no-match'];
    // A query the validator rejects (a broken regex, a bad value, an unknown
    // filter) is the real reason, and the hint line under the field already
    // says what: never point at the spelling instead. opts.regex / opts.groups
    // = the same context the search box validates with.
    const invalid = kind !== 'no-clips' && o.query && Search.validateQuery(o.query, { regex: !!o.regex, groups: o.groups || [] }).length;
    const hint = invalid ? 'Part of the search is not valid: fix the part marked in red.' : s.hint;
    const action = s.action ? `<button class="btn quiet sm empty-action" type="button" data-action="clear-search-filters">${escapeHtml(s.action)}</button>` : '';
    return `<div class="list-empty" data-empty="${escapeHtml(kind)}" role="status">`
      + `<span class="mi empty-icon" aria-hidden="true">${s.icon}</span>`
      + `<p class="empty-title">${escapeHtml(s.title)}</p><p class="empty-hint">${escapeHtml(hint)}</p>${action}`
      + `<div class="empty-nudge"${o.nudgeHtml ? '' : ' hidden'}>${o.nudgeHtml || ''}</div></div>`;
  }
  // The empty-result nudge (the .empty-nudge slot): the ONE filter whose
  // removal brings back the most clips (Search.bestRelaxation), as one click
  // that rewrites the query (data-action="apply-query" -> adapter.setQuery).
  // rel: bestRelaxation's result, or null (no nudge). It sits under the empty
  // state's own title, so it never says "No matches" again, and when dropping
  // the blocker leaves nothing to search by it is the state's own clear button
  // over again, so it is left out.
  function renderRelaxNudge(rel) {
    if (!rel || !(rel.count > 0)) return '';
    const relaxed = Search.parseQuery(rel.query || '');
    if (!relaxed.content.length && !Search.anyFilterActive(relaxed)) return '';
    const what = rel.time ? 'range' : 'filter';
    const title = `Remove ${rel.label} and show ${rel.count} clip${rel.count === 1 ? '' : 's'}`;
    return `<button class="empty-nudge-btn" type="button" data-action="apply-query" data-query="${escapeHtml(rel.query)}" title="${escapeHtml(title)}">`
      + `<span><code>${escapeHtml(rel.label)}</code>: ${rel.count} outside this ${what}</span><span class="mi" aria-hidden="true">arrow_forward</span></button>`;
  }
  // ONE availability census per (filters, docs, groups, minute): free text is
  // not part of it (Search.facetKey), so typing words never recomputes it.
  // opts: { docs() -> the search docs, groups() -> group names, onUpdate?(census) }.
  // get(query) returns the census, each new one with a fresh `id` (consumers
  // key their chip rebuilds on it). A filter change computes at once (the
  // chips must answer the click); with onUpdate, a change of only the history
  // or the minute keeps the current census for this paint and refreshes it
  // right after, so a capture, a sync or a keystroke never pays for it.
  function createCensusCache(opts) {
    const o = opts || {};
    let key = null;
    let filtersKey = null;
    let docsRef = null;
    let value = null;
    let seq = 0;
    let timer = null;
    let lastParsed = null;
    function compute(parsed) {
      const now = Date.now();
      const docs = o.docs ? o.docs() : [];
      const groups = o.groups ? o.groups() : [];
      value = Search.facetCensus(docs, parsed, { now, groups });
      value.id = ++seq;
      filtersKey = `${Search.facetKey(parsed)}\u0002${groups.join('\u0001')}`;
      key = `${filtersKey}\u0002${Math.floor(now / 60000)}`;
      docsRef = docs;
      return value;
    }
    return {
      get(query) {
        const parsed = typeof query === 'string' ? Search.parseQuery(query) : query;
        lastParsed = parsed;
        const docs = o.docs ? o.docs() : [];
        const groups = o.groups ? o.groups() : [];
        const fk = `${Search.facetKey(parsed)}\u0002${groups.join('\u0001')}`;
        const k = `${fk}\u0002${Math.floor(Date.now() / 60000)}`;
        if (value && k === key && docs === docsRef) return value;
        if (value && fk === filtersKey && o.onUpdate) {
          if (!timer) timer = setTimeout(() => { timer = null; o.onUpdate(compute(lastParsed)); }, 0);
          return value;
        }
        return compute(parsed);
      },
    };
  }
  function renderPopupShell(options) {
    const opts = options || {};
    const ids = {
      mainView: 'mainView',
      count: 'count',
      syncHeaderBtn: 'syncHeaderBtn',
      settingsBtn: 'settingsBtn',
      closeBtn: 'closeBtn',
      search: 'search',
      searchClear: 'searchClear',
      regexBtn: 'regexBtn',
      sortBtn: 'sortBtn',
      searchOptsBtn: 'searchOptsBtn',
      searchOpts: 'searchOpts',
      groupFilters: 'groupFilters',
      selectionBar: 'selectionBar',
      list: 'list',
      listNewest: 'listNewest',
      settingsView: 'settingsView',
      settingsBack: 'settingsBack',
      settingsCloseBtn: 'settingsCloseBtn',
      ...(opts.ids || {}),
    };
    const esc = escapeHtml;
    const settingsBodyHtml = opts.settingsBodyHtml || '';
    const afterListHtml = opts.afterListHtml || '';
    const headerActionsHtml = opts.headerActionsHtml || '';
    const settingsNoteHtml = opts.settingsNote
      ? `<span class="settings-note">${esc(opts.settingsNote)}</span>`
      : '';
    const closeCls = opts.showCloseButtons ? '' : ' hidden';
    return `<div class="main-view" id="${esc(ids.mainView)}">
      <div class="sticky">
        <header>
          <span class="count" id="${esc(ids.count)}"></span>
          ${opts.showSyncButton === false ? '' : `<button class="icon-btn" id="${esc(ids.syncHeaderBtn)}" type="button" title="Sync now" aria-label="Sync now"><span class="mi">sync</span></button>`}
          ${headerActionsHtml}
          <button class="icon-btn" id="${esc(ids.settingsBtn)}" type="button" title="Settings" aria-label="Settings" aria-expanded="false" aria-controls="${esc(ids.settingsView)}"><span class="mi">settings</span></button>
          <button class="icon-btn close-btn${closeCls}" id="${esc(ids.closeBtn)}" type="button" title="Close (Esc)" aria-label="Close"><span class="mi">close</span></button>
        </header>
        <div class="search-row">
          <div class="search-field"><input class="search" id="${esc(ids.search)}" type="text" placeholder="Click here to search..." aria-label="Search clips" autocomplete="off" spellcheck="false"></div>
          <span class="bc-reveal" data-reveal="clear"><span class="bc-reveal-inner"><button class="icon-btn search-clear" id="${esc(ids.searchClear)}" type="button" tabindex="-1" title="Clear search" aria-label="Clear search"><span class="mi">close</span></button></span></span>
          <span class="bc-reveal" data-reveal="sort"><span class="bc-reveal-inner"><button class="icon-btn sort-btn" id="${esc(ids.sortBtn)}" type="button" title="Sort results" aria-label="Sort results"><span class="mi">sort</span></button></span></span>
          <span class="bc-reveal" data-reveal="tools"><span class="bc-reveal-inner">
            <button class="icon-btn rx-btn" id="${esc(ids.regexBtn)}" type="button" title="Regex search" aria-label="Regex search"><span class="mi">regular_expression</span></button>
            <button class="icon-btn opts-btn" id="${esc(ids.searchOptsBtn)}" type="button" title="Search options" aria-label="Search options" aria-expanded="false" aria-controls="${esc(ids.searchOpts)}"><span class="mi">tune</span></button>
          </span></span>
        </div>
        <div class="search-opts" id="${esc(ids.searchOpts)}" aria-hidden="true" inert>
          <div class="search-opts-clip">
            <div class="search-opts-scroll" role="region" aria-label="Search options">${renderSearchOptions('')}</div>
            <div class="search-opts-resize" role="separator" aria-orientation="horizontal" title="Drag to resize (double-click to reset)"></div>
          </div>
        </div>
        <div class="chip-row">
          <div class="group-filters" id="${esc(ids.groupFilters)}" aria-label="Filters"></div>
          <div class="selection-bar hidden" id="${esc(ids.selectionBar)}" role="toolbar" aria-label="Selection actions"></div>
        </div>
      </div>
      <div class="list-wrap">
        <div class="list" id="${esc(ids.list)}" aria-live="polite"></div>
        <button class="list-newest" id="${esc(ids.listNewest)}" type="button" title="Jump to the newest clip" aria-label="Jump to the newest clip" tabindex="-1"><span class="mi sm">arrow_upward</span><span class="list-newest-label">Newest</span><span class="list-newest-dot" aria-hidden="true"></span></button>
      </div>
      ${afterListHtml}
    </div>
    <div class="settings-view" id="${esc(ids.settingsView)}">
      <div class="settings-hdr">
        <button class="icon-btn" id="${esc(ids.settingsBack)}" type="button" title="Back" aria-label="Back"><span class="mi">arrow_back</span></button>
        <h2>Settings</h2>
        ${settingsNoteHtml}
        <button class="icon-btn close-btn${closeCls}" id="${esc(ids.settingsCloseBtn)}" type="button" title="Close (Esc)" aria-label="Close"><span class="mi">close</span></button>
      </div>
      <div class="settings-body">
        ${settingsBodyHtml}
      </div>
    </div>`;
  }
  const COLLAPSED_PREVIEW_CHARS = 700;
  const SEARCH_PREVIEW_CONTEXT = 260;
  function queryMatchIndex(text, query, regex) {
    const queryText = String(query || '').trim();
    if (!queryText) return -1;
    if (regex) {
      try {
        const match = new RegExp(queryText, 'i').exec(text);
        return match ? match.index : -1;
      } catch { return -1; }
    }
    // Case-insensitive search of the text as is (no lowercased copy of a
    // possibly huge body).
    const match = new RegExp(queryText.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i').exec(String(text || ''));
    return match ? match.index : -1;
  }
  // One-line preview window around the first match. Only the window is ever
  // flattened: flattening (and lowercasing) the WHOLE text cost ~300 ms per
  // keystroke whenever a 31 MB clip was among the visible rows. opts.matchIndex
  // (where the match sits in `text`, e.g. from the search haystack) skips the
  // search; without it a case-insensitive search of the raw text is used.
  // opts.max / opts.lead: the window's length and how much text it keeps
  // before the match (default 700 / 260).
  function collapsedPreviewText(text, query, regex, opts) {
    const raw = String(text || '');
    const max = opts && opts.max > 0 ? opts.max : COLLAPSED_PREVIEW_CHARS;
    const lead = opts && opts.lead >= 0 ? opts.lead : SEARCH_PREVIEW_CONTEXT;
    if (raw.length <= max) return raw.replace(/\r?\n/g, ' ');
    const known = opts && Number.isFinite(opts.matchIndex) ? opts.matchIndex : null;
    const matchIndex = known != null ? known : queryMatchIndex(raw, query, regex);
    const center = matchIndex >= 0 ? Math.max(0, matchIndex - lead) : 0;
    const start = Math.min(center, Math.max(0, raw.length - max));
    const end = Math.min(raw.length, start + max);
    return `${start > 0 ? '...' : ''}${raw.slice(start, end).replace(/\r?\n/g, ' ')}${end < raw.length ? '...' : ''}`;
  }
  // Apply a history-feed delta (main's lib/history-feed.js) to the items a
  // renderer holds: unchanged clips keep their objects (so per-clip caches keyed
  // by them stay valid), changed ones are replaced, the order is main's.
  function applyHistoryDelta(items, state) {
    if (!state || !state.delta) return (state && state.items) || items || [];
    const byId = new Map();
    for (const item of items || []) byId.set(itemId(item), item);
    for (const item of state.items || []) byId.set(itemId(item), item);
    const out = [];
    for (const id of state.order || []) { const item = byId.get(id); if (item) out.push(item); }
    return out;
  }
  function highlight(text, query, regex) {
    const raw = String(text || '');
    const queryText = String(query || '').trim();
    if (!queryText) return escapeHtml(raw);
    try {
      const re = regex ? new RegExp(queryText, 'gi') : new RegExp(queryText.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi');
      let out = '';
      let last = 0;
      let count = 0;
      let match;
      while ((match = re.exec(raw)) && count < 100) {
        if (match[0] === '') { re.lastIndex += 1; continue; }
        out += escapeHtml(raw.slice(last, match.index));
        out += `<mark>${escapeHtml(match[0])}</mark>`;
        last = match.index + match[0].length;
        count += 1;
      }
      return out + escapeHtml(raw.slice(last));
    } catch { return escapeHtml(raw); }
  }
  // Shared per-clip action row. App wires window.api; demo wires in-browser
  // equivalents. Markup MUST stay identical so the two popups never drift.
  //
  // The always-visible hover row is deliberately MINIMAL (the one primary
  // action + a "..." button). "Rename..." and "Delete" are demoted into the
  // right-click / "..." menu (renderClipMenu) as advanced actions, so the row
  // stays clean and accidental deletes are less likely. The menu is the
  // complete surface; the row is the fast path.
  //
  // ONE glyph per clip action, shared by the row buttons and every clip menu
  // (popup, editor, viewer), so an action looks the same wherever it appears
  // and no two actions share a glyph.
  const CLIP_ACTION_ICONS = {
    pin: 'star', edit: 'edit_note', 'open-img': 'open_in_full', 'open-img-ext': 'open_in_new', 'save-img': 'download',
    rename: 'drive_file_rename_outline', revert: 'history', 'select-similar': 'select_all', del: 'delete',
  };
  function renderClipActions(item, options) {
    const opts = options || {};
    const id = itemId(item) || '';
    const isImage = item && item.type === 'image';
    const I = CLIP_ACTION_ICONS;
    let html = '';
    if (isImage) {
      html += `<button class="icon-btn" data-action="open-img" data-id="${escapeHtml(id)}" title="Open image"><span class="mi">${I['open-img']}</span></button><button class="icon-btn" data-action="save-img" data-id="${escapeHtml(id)}" title="Copy to Downloads"><span class="mi">${I['save-img']}</span></button>`;
    } else {
      html += `<button class="icon-btn" data-action="edit" data-id="${escapeHtml(id)}" title="Open in editor"><span class="mi">${I.edit}</span></button>`;
    }
    html += `<button class="icon-btn" data-action="clip-menu" data-id="${escapeHtml(id)}" title="More actions" aria-label="More actions"><span class="mi">more_horiz</span></button>`;
    return html;
  }
  // Numpad 1-9 buttons, shared by the clip menu's Numpad submenu and a row's
  // # popover. Rendered in real NUMPAD FORMATION (7 8 9 / 4 5 6 / 1 2 3:
  // .np-row is a 3-column grid), which reads like the physical keypad instead
  // of a flat strip. `np` is the item's current slot; `nmap` is slot->id.
  // Keys are menu items (radio: the clip's own key is checked); a taken key
  // keeps its slot's clip as the tooltip.
  const NUMPAD_LAYOUT = [7, 8, 9, 4, 5, 6, 1, 2, 3];
  function renderNumpadButtons(item, items, nmap) {
    const np = numpadOf(item);
    let html = '';
    for (const n of NUMPAD_LAYOUT) {
      const cls = np === n ? 'current' : nmap[n] ? 'taken' : 'free';
      let title = `Key ${n}`;
      if (np === n) title = `Key ${n}: this clip`;
      else if (nmap[n]) {
        const slotItem = (items || []).find((candidate) => itemId(candidate) === nmap[n]);
        title = slotItem && slotItem.type === 'image'
          ? `Key ${n} (taken): [image]`
          : `Key ${n} (taken): ${String(slotItem && slotItem.text || '').replace(/\s+/g, ' ').slice(0, 80)}`;
      }
      html += `<button class="np-btn ${cls}" type="button" role="menuitemradio" aria-checked="${np === n}" tabindex="-1" data-n="${n}" title="${escapeHtml(title)}">${n}</button>`;
    }
    return html;
  }
  // The keypad block used wherever a clip's key is picked (the clip menu's
  // Numpad submenu and a row's # popover): the keys, then "Remove from key N"
  // as a normal row when the clip has one.
  function renderKeypadMenu(item, items, nmap) {
    const np = numpadOf(item);
    let html = `<div class="numpad-picker" role="group" aria-label="Numpad key"><div class="np-row">${renderNumpadButtons(item, items, nmap || {})}</div></div>`;
    if (np) html += menuRowHtml({ icon: 'backspace', label: `Remove from key ${np}`, cls: 'np-remove', attrs: { 'data-action': 'numpad-unassign', 'data-slot': np } });
    return html;
  }
  // Per-group membership across a set of selected items: 'all' | 'some' | 'none'.
  // Drives the bulk-group tri-state toggle (all -> remove from all, else -> add
  // to all).
  function groupMembership(items, group) {
    const list = items || [];
    if (!list.length) return 'none';
    let has = 0;
    for (const item of list) if (isInGroup(item, group)) has += 1;
    return has === 0 ? 'none' : has === list.length ? 'all' : 'some';
  }
  function similarLabel(n) { return `Select ${n} similar`; }
  // ONE menu row primitive (.bc-menu-item) for every menu, submenu, group tree
  // and picker: an icon column (an icon, a membership check, or empty, so labels
  // always line up), the label, then an optional trailing hint or submenu
  // caret. Rows are menu items for keyboard navigation (createMenu): roving
  // focus, so they stay out of the Tab order. A label ending in "..." opens a
  // dialog. o: { icon, label, hint, caret, cls, role, check, disabled, attrs }.
  function menuRowHtml(o) {
    let attrs = '';
    for (const [key, value] of Object.entries(o.attrs || {})) {
      if (value != null && value !== false) attrs += ` ${key}="${escapeHtml(value)}"`;
    }
    const icon = `<span class="mi${o.check ? ' bc-menu-check' : ''}" aria-hidden="true">${o.icon || ''}</span>`;
    const tail = (o.hint ? `<span class="bc-menu-hint">${escapeHtml(o.hint)}</span>` : '')
      + (o.caret ? '<span class="tag-caret mi" aria-hidden="true">chevron_right</span>' : '');
    return `<button class="bc-menu-item${o.cls ? ` ${o.cls}` : ''}" type="button" role="${o.role || 'menuitem'}" tabindex="-1"${o.disabled ? ' disabled' : ''}${attrs}>`
      + `${icon}<span class="bc-menu-label">${escapeHtml(o.label)}</span>${tail}</button>`;
  }
  // A row that opens a submenu beside it: the row (aria-haspopup) and its
  // .tag-submenu share one .tag-menu-node, which hover / keyboard opens.
  function submenuNodeHtml(row, innerHtml, subClass) {
    const parent = menuRowHtml({ ...row, caret: true, attrs: { ...(row.attrs || {}), 'aria-haspopup': 'menu', 'aria-expanded': 'false' } });
    return `<div class="tag-menu-node has-children" role="none">${parent}<div class="tag-submenu${subClass ? ` ${subClass}` : ''}" role="menu">${innerHtml}</div></div>`;
  }
  const MENU_SEPARATOR = '<div class="bc-menu-sep" role="separator"></div>';
  // ONE group checklist for every group menu: the tag tree as rows with the
  // membership glyph in the icon column (state(group) 'all' | 'some' | 'none'
  // = check / dash / nothing, in the accent; labels stay --text) and a nested
  // submenu per parent tag. Single-clip pickers toggle with toggle-group, the
  // multi-select tree with bulk-group. A click on a member removes it.
  const MEMBERSHIP_GLYPH = { all: ['check', 'true'], some: ['remove', 'mixed'], none: ['', 'false'] };
  function renderGroupChecklist(nodes, state, action) {
    return (nodes || []).map((node) => {
      const group = normalizeTagName(node && node.name);
      if (!group) return '';
      const [icon, checked] = MEMBERSHIP_GLYPH[state(group)] || MEMBERSHIP_GLYPH.none;
      const row = { icon, check: true, label: node.label || group, role: 'menuitemcheckbox', attrs: { 'data-action': action, 'data-group': group, 'aria-checked': checked, title: group } };
      return node.children && node.children.length
        ? submenuNodeHtml(row, renderGroupChecklist(node.children, state, action))
        : menuRowHtml(row);
    }).join('');
  }
  // "New group..." closes every group checklist: a normal row, after a
  // separator when there are groups above it.
  function withNewGroupRow(treeHtml, action) {
    return treeHtml + (treeHtml ? MENU_SEPARATOR : '') + menuRowHtml({ icon: 'add', label: 'New group...', attrs: { 'data-action': action } });
  }
  // ONE menu-content builder for the per-clip "..." menu. Reuses the exact
  // data-action attributes the controller already dispatches (pin/edit/rename/
  // del/open-img/save-img) plus the shared group checklist + keypad, so the menu
  // needs no new dispatch. The menu root carries data-id, so the group / key
  // handlers resolve their target via closest('[data-id]') the same way a
  // row's popovers do.
  function renderClipMenu(item, options) {
    const opts = options || {};
    // context: 'popup' (default, the clip list) | 'editor' | 'viewer' — the
    // standalone windows reuse this exact menu, minus the "open what's already
    // open" row (editor: no Edit; viewer: Open→Open externally).
    const context = opts.context || 'popup';
    const id = itemId(item) || '';
    const isImage = item && item.type === 'image';
    const pinned = isPinned(item);
    const items = opts.items || [];
    const groups = opts.groups || [];
    const nmap = opts.numpadMap || numpadMap(items);
    const row = (action, label, cls, extra) => menuRowHtml({ icon: CLIP_ACTION_ICONS[action], label, cls, ...(extra || {}), attrs: { 'data-action': action, 'data-id': id, ...((extra && extra.attrs) || {}) } });
    let html = '<div class="bc-menu-list">';
    html += row('pin', pinned ? 'Unpin' : 'Pin');
    if (isImage) {
      if (context !== 'viewer') html += row('open-img', 'Open image');
      html += row('open-img-ext', 'Open externally');
      html += row('save-img', 'Copy to Downloads');
    } else if (context !== 'editor') {
      html += row('edit', 'Open in editor');
    }
    html += row('rename', 'Rename...');
    // The editor's "back to the text it opened with" (the window bar keeps
    // only find and the menu).
    if (context === 'editor' && !isImage) html += row('revert', 'Revert to original');
    html += submenuNodeHtml({ icon: 'sell', label: 'Add to group' }, clipGroupTreeHtml(groups, item));
    html += submenuNodeHtml({ icon: 'tag', label: 'Numpad', hint: numpadOf(item) ? String(numpadOf(item)) : '' }, renderKeypadMenu(item, items, nmap), 'bc-keypad');
    // opts.similarCount: a number (0 = no row) or null while it is being
    // counted (a disabled placeholder the controller fills in); absent = never.
    if (opts.similarCount === null) {
      html += row('select-similar', 'Finding similar clips', '', { disabled: true, attrs: { 'aria-busy': 'true' } });
    } else if (opts.similarCount > 0) {
      html += row('select-similar', similarLabel(opts.similarCount));
    }
    html += MENU_SEPARATOR + row('del', 'Delete', 'danger');
    html += '</div>';
    return html;
  }
  // Group checklist + "New group..." for ONE clip: the single builder behind
  // the clip menu's "Add to group" submenu AND the title-bar strip's / a row's
  // + popover (openGroupPickerAt). The clip's current groups carry the check.
  function clipGroupTreeHtml(groups, item) {
    const itemGroups = new Set(groupsOf(item));
    return withNewGroupRow(renderTagTreeMenu(buildTagTree([...(groups || []), ...itemGroups]), { mode: 'picker', itemGroups }), 'add-group');
  }
  // ONE menu-content builder for the multi-select bulk menu (shared by the
  // action bar's overflow and the right-click menu on a multi-selection). Bulk
  // actions carry their own data-action; the controller runs them against the
  // current selection, so no ids are needed on the items.
  function renderBulkMenu(state, options) {
    const opts = options || {};
    const info = state || {};
    const count = info.count || 0;
    const groups = opts.groups || [];
    const selItems = opts.selectedItems || [];
    const allText = !info.hasImage;
    const row = (action, icon, label, cls) => menuRowHtml({ icon, label, cls, attrs: { 'data-action': action } });
    let html = '<div class="bc-menu-list">';
    html += row('bulk-paste', 'content_paste', `Paste all (${count})`);
    html += submenuNodeHtml({ icon: 'sell', label: 'Add to group' }, bulkGroupTreeHtml(groups, selItems));
    if (allText) html += row('bulk-unify', 'merge', `Unify (${count})`);
    html += MENU_SEPARATOR + row('bulk-delete', CLIP_ACTION_ICONS.del, `Delete (${count})`, 'danger');
    html += '</div>';
    return html;
  }
  // Tri-state group checklist + "New group..." for a selection: ONE builder
  // shared by the bulk menu's submenu and the selection bar's Group popover.
  // Each group shows its membership across the selection (all = check, some =
  // dash, none = empty); a click toggles it for every selected clip (all ->
  // remove from all, else add to all).
  function bulkGroupTreeHtml(groups, selItems) {
    const sel = selItems || [];
    const treeGroups = [...new Set([...(groups || []), ...sel.flatMap(groupsOf)])];
    return withNewGroupRow(renderGroupChecklist(buildTagTree(treeGroups), (g) => groupMembership(sel, g), 'bulk-group'), 'bulk-add-group');
  }
  // The contextual bar shown while 2+ clips are selected. It takes the chip
  // bar's place at the same height (the shell stacks both in .chip-row; the
  // chips come back when the selection ends), so the list never moves. Mirrors
  // the bulk menu's actions. Reuses icon-btn + tokens.
  function renderSelectionBar(state) {
    const info = state || {};
    const count = info.count || 0;
    const allText = !info.hasImage;
    return `<span class="selection-count">${count} selected</span>
      <div class="selection-actions">
        <button class="icon-btn" type="button" data-action="bulk-paste" title="Paste all (Enter)" aria-label="Paste all"><span class="mi">content_paste</span></button>
        <button class="icon-btn" type="button" data-action="bulk-group-open" title="Group" aria-label="Group" aria-haspopup="true"><span class="mi">sell</span></button>
        ${allText ? '<button class="icon-btn" type="button" data-action="bulk-unify" title="Unify into one clip" aria-label="Unify into one clip"><span class="mi">merge</span></button>' : ''}
        <button class="icon-btn danger" type="button" data-action="bulk-delete" title="Delete selected" aria-label="Delete selected"><span class="mi">delete</span></button>
        <button class="icon-btn" type="button" data-action="bulk-clear" title="Clear selection (Esc)" aria-label="Clear selection"><span class="mi">close</span></button>
      </div>`;
  }
  // ── Window drag on a header (one helper for every popup header) ──
  // A press on a non-control pixel of `el` is captured: released within 4 px it
  // is a click (opts.onClick, e.g. focus the search), dragged further it moves
  // the window (opts.move(phase, dx, dy), phase 'start' | 'move' | 'end', dx/dy =
  // the pointer's SCREEN delta since the press, so a window moving under the
  // pointer never feeds back). The app's move asks main to move the sender's
  // window; the demo passes none (a drag is a no-op). Replaces
  // -webkit-app-region: drag, which swallowed every click and double-click
  // maximised the window. Controls (buttons, fields, chips, menus, the options
  // panel) are left alone, except an EMPTY text field: it has nothing to
  // select, so it is header too (a drag moves the window, a click focuses the
  // field). Once it holds text, a drag in it selects text as always.
  const WINDOW_DRAG_IGNORE = 'button, input, textarea, select, a[href], label, [contenteditable=""], [contenteditable="true"], '
    + '[role="button"], [role="separator"], [role="menuitem"], [data-action], [data-filter], [data-group], '
    + '.filter-tag, .search-suggest, .search-opts, .tag-submenu, .bc-menu';
  const WINDOW_DRAG_SLOP = 4;
  function attachWindowDrag(el, opts) {
    if (typeof document === 'undefined' || !el) return { destroy() {} };
    const o = opts || {};
    const ignoreSel = o.ignore ? `${WINDOW_DRAG_IGNORE}, ${o.ignore}` : WINDOW_DRAG_IGNORE;
    const emptyField = (target) => !!(target && target.tagName === 'INPUT' && /^(text|search)$/.test(target.type) && !target.value && !target.readOnly && !target.disabled);
    const isControl = (target) => !emptyField(target) && !!(target && target.closest && target.closest(ignoreSel));
    let press = null;
    let swallowClick = false;
    const onPointerDown = (e) => {
      if (e.button !== 0 || e.pointerType === 'touch' || isControl(e.target)) return;
      press = { id: e.pointerId, x: e.screenX, y: e.screenY, dragging: false, field: emptyField(e.target) ? e.target : null };
      try { el.setPointerCapture(e.pointerId); } catch {}
    };
    // The page must not take focus (or start a text selection) from a header press.
    const onMouseDown = (e) => { if (e.button === 0 && !isControl(e.target)) e.preventDefault(); };
    const onPointerMove = (e) => {
      if (!press || e.pointerId !== press.id) return;
      // The button is up but its release never arrived (the window hid, capture
      // went elsewhere): the press ends here, a hover never moves the window.
      if ((e.buttons & 1) === 0) { finish(e, true); return; }
      const dx = e.screenX - press.x;
      const dy = e.screenY - press.y;
      if (!press.dragging) {
        if (Math.hypot(dx, dy) <= WINDOW_DRAG_SLOP) return;
        press.dragging = true;
        if (o.move) o.move('start', 0, 0);
      }
      if (o.move) o.move('move', Math.round(dx), Math.round(dy));
    };
    const finish = (e, cancelled) => {
      if (!press || (e && e.pointerId !== press.id)) return;
      const p = press;
      press = null;
      try { el.releasePointerCapture(p.id); } catch {}
      if (p.dragging) {
        if (o.move) o.move('end', 0, 0);
        swallowClick = true; // the click that follows the release is not a click
        setTimeout(() => { swallowClick = false; }, 0);
      } else if (!cancelled && p.field) {
        p.field.focus(); // a click on the empty field is a click on the field
      } else if (!cancelled && o.onClick) {
        o.onClick(e);
      }
    };
    const onPointerUp = (e) => finish(e, false);
    const onPointerCancel = (e) => finish(e, true);
    // Capture lost without a release (after a release, press is already null).
    const onLostCapture = (e) => finish(e, true);
    const onClickCapture = (e) => { if (swallowClick) { swallowClick = false; e.preventDefault(); e.stopPropagation(); } };
    el.addEventListener('pointerdown', onPointerDown);
    el.addEventListener('mousedown', onMouseDown);
    el.addEventListener('pointermove', onPointerMove);
    el.addEventListener('pointerup', onPointerUp);
    el.addEventListener('pointercancel', onPointerCancel);
    el.addEventListener('lostpointercapture', onLostCapture);
    el.addEventListener('click', onClickCapture, true);
    return {
      destroy() {
        el.removeEventListener('pointerdown', onPointerDown);
        el.removeEventListener('mousedown', onMouseDown);
        el.removeEventListener('pointermove', onPointerMove);
        el.removeEventListener('pointerup', onPointerUp);
        el.removeEventListener('pointercancel', onPointerCancel);
        el.removeEventListener('lostpointercapture', onLostCapture);
        el.removeEventListener('click', onClickCapture, true);
      },
    };
  }

  // ── Scroll-edge fade (Forge's useScrollFade, one helper for every scroller) ──
  // Sets --fade-top / --fade-bottom on `el` (the .bc-scroll-fade mask in
  // clipboard-popup.css) to the preset size only while content is hidden past
  // that edge, so the fade shows on the side that has more and animates out as
  // you reach the end. Presets are Forge's tiers: pick by the class of surface.
  const FADE_PRESETS = {
    pane: { top: 44, bottom: 64 },
    rail: { top: 44, bottom: 44 },
    panel: { top: 36, bottom: 36 },
    box: { top: 24, bottom: 24 },
  };
  // Pure: the fade sizes for a scroller's geometry. axis 'x' (a one-line strip
  // that scrolls sideways) reads the horizontal geometry and returns
  // { left, right } (the preset's top / bottom sizes), else { top, bottom }.
  function resolveFadeVars(m, sizes, axis) {
    if (axis === 'x') {
      const hiddenLeft = m.scrollLeft > 2;
      const hiddenRight = m.scrollLeft + m.clientWidth < m.scrollWidth - 2;
      return { left: hiddenLeft ? sizes.top : 0, right: hiddenRight ? sizes.bottom : 0 };
    }
    const hiddenAbove = m.scrollTop > 2;
    const hiddenBelow = m.scrollTop + m.clientHeight < m.scrollHeight - 2;
    return { top: hiddenAbove ? sizes.top : 0, bottom: hiddenBelow ? sizes.bottom : 0 };
  }
  // opts.axis 'x': the mask runs left to right (.bc-scroll-fade-x).
  function attachScrollFade(el, preset, opts) {
    if (!el) return { refresh() {}, detach() {} };
    const sizes = (preset && typeof preset === 'object') ? preset : (FADE_PRESETS[preset] || FADE_PRESETS.box);
    const axis = opts && opts.axis === 'x' ? 'x' : 'y';
    el.classList.add(axis === 'x' ? 'bc-scroll-fade-x' : 'bc-scroll-fade');
    // Write only a changed value: this runs on every scroll frame.
    const written = {};
    const put = (prop, value) => { if (written[prop] === value) return; written[prop] = value; el.style.setProperty(prop, value); };
    const update = () => {
      const v = resolveFadeVars(el, sizes, axis);
      if (axis === 'x') {
        put('--fade-left', `${v.left}px`);
        put('--fade-right', `${v.right}px`);
      } else {
        put('--fade-top', `${v.top}px`);
        put('--fade-bottom', `${v.bottom}px`);
      }
    };
    // Coalesced into one frame; a hidden page produces no frames, so it updates
    // at once there (the popup is laid out while hidden).
    let raf = null;
    const schedule = () => {
      if (raf !== null) return;
      if (typeof requestAnimationFrame !== 'function' || (typeof document !== 'undefined' && document.hidden)) { update(); return; }
      raf = requestAnimationFrame(() => { raf = null; update(); });
    };
    update(); // first paint synchronous: a deferred one flashes an unmasked frame
    el.addEventListener('scroll', schedule, { passive: true });
    const ro = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(schedule) : null;
    if (ro) ro.observe(el);
    const mo = typeof MutationObserver !== 'undefined' ? new MutationObserver(schedule) : null;
    if (mo) mo.observe(el, { childList: true, subtree: true });
    let detached = false;
    return {
      refresh: () => { if (!detached) update(); },
      detach() {
        detached = true;
        if (raf !== null && typeof cancelAnimationFrame === 'function') cancelAnimationFrame(raf);
        raf = null;
        el.removeEventListener('scroll', schedule);
        if (ro) ro.disconnect();
        if (mo) mo.disconnect();
      },
    };
  }

  // The theme's motion duration (--dur, 0ms under reduced motion) in ms.
  function motionMs(el) {
    if (typeof getComputedStyle !== 'function') return 0;
    const v = String(getComputedStyle(el).getPropertyValue('--dur') || '').trim();
    const n = parseFloat(v);
    if (!Number.isFinite(n)) return 0;
    return /ms$/.test(v) ? n : n * 1000;
  }
  // ── One-line strip that scrolls sideways (the popup's chip row, a clip
  // window's keys): the sideways scroll fade, and a plain wheel scrolls it
  // sideways while it overflows (most mice have no sideways wheel). Returns
  // the fade's { refresh }.
  function attachSideScroll(el) {
    if (!el) return null;
    if (el._bcSideScroll) return el._bcSideScroll;
    // 'panel' (36 px): long enough to overlap the last visible chip, so a cut
    // edge always reads as "more this way", wherever a chip happens to end.
    const fade = attachScrollFade(el, 'panel', { axis: 'x' });
    // A reveal inside (the window bar's ghosts) changes only the scroll width.
    el.addEventListener('transitionrun', fade.refresh);
    el.addEventListener('transitionend', fade.refresh);
    el.addEventListener('wheel', (e) => {
      if (e.ctrlKey || e.metaKey || !e.deltaY || Math.abs(e.deltaX) >= Math.abs(e.deltaY)) return;
      if (e.target && e.target.closest && e.target.closest('.tag-submenu')) return;
      if (el.scrollWidth <= el.clientWidth + 1 || getComputedStyle(el).overflowX === 'visible') return;
      const before = el.scrollLeft;
      el.scrollLeft += e.deltaMode === 1 ? e.deltaY * 16 : e.deltaY;
      if (el.scrollLeft !== before) e.preventDefault();
    }, { passive: false });
    el._bcSideScroll = fade;
    return fade;
  }
  // The popup's chip row: ONE line that scrolls sideways under the mask fade
  // until the search options panel opens (attachSearchBox), then every chip,
  // wrapped. The switch animates both ways (FLIP: each chip glides from where
  // it was to where it lands while the row's height follows), so the line and
  // the full set read as the same chips. Its group submenus open in the top
  // layer (installSubmenuAutoflip), out of the strip's clip and mask.
  function attachChipStrip(el) {
    if (!el) return { setExpanded() {}, isExpanded: () => false };
    if (el._bcChipStrip) return el._bcChipStrip;
    const side = attachSideScroll(el);
    let expanded = el.classList.contains('expanded');
    let settleTimer = null;
    const settle = () => {
      clearTimeout(settleTimer);
      settleTimer = null;
      el.classList.remove('strip-moving');
      el.style.height = '';
      for (const chip of el.children) { chip.style.transform = ''; chip.style.transition = ''; }
      if (side) side.refresh();
    };
    function setExpanded(open, how) {
      const next = !!open;
      if (next === expanded) return;
      expanded = next;
      const chips = Array.from(el.children);
      // Measured BEFORE settle(): a toggle mid-glide starts from where the
      // chips are drawn right now, not from the aborted glide's end.
      const before = chips.map((chip) => chip.getBoundingClientRect());
      const fromHeight = el.getBoundingClientRect().height;
      settle();
      const ms = motionMs(el);
      if ((how && how.instant) || !ms || document.hidden || !el.getClientRects().length) {
        el.classList.toggle('expanded', next);
        if (!next) el.scrollLeft = 0;
        if (side) side.refresh();
        return;
      }
      el.classList.toggle('expanded', next);
      if (!next) el.scrollLeft = 0;
      const toHeight = el.getBoundingClientRect().height;
      chips.forEach((chip, i) => {
        const r = chip.getBoundingClientRect();
        const dx = before[i].left - r.left;
        const dy = before[i].top - r.top;
        if (!dx && !dy) return;
        chip.style.transition = 'none';
        chip.style.transform = `translate(${dx}px, ${dy}px)`;
      });
      el.style.height = `${fromHeight}px`;
      el.classList.add('strip-moving');
      void el.offsetHeight; // commit the inverted start before the transitions run
      el.style.height = `${toHeight}px`;
      for (const chip of chips) { chip.style.transition = ''; chip.style.transform = ''; }
      settleTimer = setTimeout(settle, ms + 60);
    }
    el._bcChipStrip = { setExpanded, isExpanded: () => expanded };
    return el._bcChipStrip;
  }

  // ── Resize handle (Forge's ResizeHandle + useResizablePane, pointer events) ──
  // One drag-to-resize along one axis: opts { axis: 'y'|'x', edge: 'bottom'|'top'|
  // 'right'|'left' (the side the handle sits on), size() current px, min(), max(),
  // onDrag(px) live on every move, onCommit(px) on release, onReset() on
  // double-click, onState(dragging) }. The consumer applies and persists the size.
  function attachResizeHandle(handle, opts) {
    if (typeof document === 'undefined' || !handle) return { destroy() {} };
    const o = opts || {};
    const axis = o.axis === 'x' ? 'x' : 'y';
    const edge = o.edge || (axis === 'x' ? 'right' : 'bottom');
    const sign = edge === 'left' || edge === 'top' ? -1 : 1; // grow toward the cursor
    let drag = null;
    const pos = (e) => (axis === 'x' ? e.clientX : e.clientY);
    const clamp = (v) => Math.round(Math.min(Number(o.max ? o.max() : Infinity), Math.max(Number(o.min ? o.min() : 0), v)));
    const onDown = (e) => {
      if (e.button !== 0) return;
      e.preventDefault();
      e.stopPropagation();
      drag = { id: e.pointerId, start: pos(e), size: Number(o.size ? o.size() : 0), latest: null };
      try { handle.setPointerCapture(e.pointerId); } catch {}
      document.documentElement.style.cursor = axis === 'x' ? 'col-resize' : 'row-resize';
      if (o.onState) o.onState(true);
    };
    const onMove = (e) => {
      if (!drag || e.pointerId !== drag.id) return;
      const next = clamp(drag.size + sign * (pos(e) - drag.start));
      if (next === drag.latest) return;
      drag.latest = next;
      if (o.onDrag) o.onDrag(next);
    };
    const onEnd = (e) => {
      if (!drag || e.pointerId !== drag.id) return;
      const d = drag;
      drag = null;
      try { handle.releasePointerCapture(d.id); } catch {}
      document.documentElement.style.cursor = '';
      if (o.onState) o.onState(false);
      if (d.latest !== null && o.onCommit) o.onCommit(d.latest);
    };
    const onDblClick = (e) => { e.preventDefault(); if (o.onReset) o.onReset(); };
    handle.addEventListener('pointerdown', onDown);
    handle.addEventListener('pointermove', onMove);
    handle.addEventListener('pointerup', onEnd);
    handle.addEventListener('pointercancel', onEnd);
    handle.addEventListener('dblclick', onDblClick);
    return {
      destroy() {
        handle.removeEventListener('pointerdown', onDown);
        handle.removeEventListener('pointermove', onMove);
        handle.removeEventListener('pointerup', onEnd);
        handle.removeEventListener('pointercancel', onEnd);
        handle.removeEventListener('dblclick', onDblClick);
      },
    };
  }

  // ── Search options panel (the "tune" toggle under the search field) ──
  // Facet rows (Core.search.OPTION_FACETS) as chips that write query tokens (the
  // field shows what a toggle means: that is how the grammar is learned), the
  // keys no toggle writes (OPTION_FIELDS) and one line of rules (SYNTAX_NOTES),
  // all in ONE label | chips grid. The chip renderer takes the
  // state from the query (facetTokenState) plus an optional { disabled, reason },
  // so the availability census can grey an option out through the same markup.
  function renderFacetOption(opt, state, extra) {
    const x = extra || {};
    const cls = state === 'include' ? ' active' : state === 'exclude' ? ' excluded' : '';
    const tokenText = Search && Search.facetTokenText ? Search.facetTokenText(opt.token) : '';
    const label = opt.prompt && state === 'include' && x.value ? `Before ${x.value}` : opt.label;
    const title = x.reason || (opt.prompt ? (state === 'include' ? 'Remove this filter' : `Add ${opt.prompt} and type a date (2026-01-31) or 7d`) : tokenText);
    return renderChip({
      tag: 'button',
      cls: `facet-opt${disabledChipClass(x)}`,
      state,
      attrs: { 'data-row': x.row, 'data-opt': x.index, 'aria-pressed': state === 'include' ? 'true' : 'false', title, disabled: !!x.disabled, 'aria-disabled': x.disabled ? 'true' : null },
      html: escapeHtml(label),
    });
  }
  // A greyed chip's tier (Forge's disabledTier): 'transient' = nothing matches
  // right now, 'structural' = can never match with the active filters (fainter).
  function disabledChipClass(x) {
    return x && x.disabled ? ` is-disabled${x.disabledKind === 'structural' ? ' dis-structural' : ''}` : '';
  }
  // A query token painted exactly as the search field paints it (lexQuery's
  // .qh-* spans), so the panel shows the syntax the field will show.
  function queryTokenHtml(text) {
    if (!Search || !Search.lexQuery) return escapeHtml(text);
    return Search.lexQuery(String(text)).map((seg) => `<span class="qh-${seg.kind}">${escapeHtml(seg.text)}</span>`).join('');
  }
  // census: Search.facetCensus for this query (null = everything enabled). An
  // option the census hides (a kind absent from all history) is left out.
  function renderSearchFacets(query, census) {
    if (!Search || !Search.OPTION_FACETS) return '';
    const parsed = Search.parseQuery(query || '');
    const row = (label, html) => `<span class="opts-facet-label">${escapeHtml(label)}</span><div class="opts-facet-chips" role="group" aria-label="${escapeHtml(label)}">${html}</div>`;
    const facets = Search.OPTION_FACETS.map((def, r) => row(def.label, def.options.map((opt, i) => {
      const probe = opt.prompt ? { kind: opt.token.kind } : opt.token;
      const state = Search.facetTokenState(parsed, probe);
      const v = census ? Search.facetOptionVerdict(census, parsed, probe, { selected: state !== null }) : { enabled: true };
      if (v.hidden) return '';
      return renderFacetOption(opt, state, { row: r, index: i, value: opt.prompt ? parsed[opt.token.kind] : '', disabled: !v.enabled, disabledKind: v.kind, reason: v.reason });
    }).join(''))).join('');
    // A key chip puts its prefix in the field for typing (the autocomplete then
    // offers its values); its tooltip is the autocomplete's own hint.
    const fields = (Search.OPTION_FIELDS || []).map((key) => {
      const f = Search.FIELD_INFO[key] || {};
      return renderChip({ tag: 'button', cls: 'opts-field', attrs: { 'data-insert': `${key}:`, title: `${key}: ${f.desc || ''}${f.short ? ` (or ${f.short}:)` : ''}` }, html: queryTokenHtml(`${key}:`) });
    }).join('');
    const notes = (Search.SYNTAX_NOTES || []).map((n) => (n.code ? `${queryTokenHtml(n.code)} ` : '') + escapeHtml(n.text)).join('<span class="opts-notes-sep" aria-hidden="true">·</span>');
    return facets + (fields ? row('More', fields) : '') + (notes ? `<p class="opts-notes">${notes}</p>` : '');
  }
  function renderSearchOptions(query) {
    return `<div class="opts-facets">${renderSearchFacets(query)}</div>`;
  }

  // ── Search box enhancer: live query-syntax highlighting + autocomplete ──
  // Wraps an existing search <input> with a transparent-input-over-colored-backdrop
  // mirror (Forge's PatternInput idiom) so prefixes/regex/quotes/unknowns are colored as
  // you type, plus a token autocomplete dropdown (prefixes, group names, is:/sort: values,
  // since: presets, num:). It also owns the field's chrome, for the app popup AND the
  // demo: the placeholder ("Click here to search..." until focused), the in-field
  // buttons on the shared reveal (clear with text, sort with a query, regex + options
  // while focused or in use) and the options panel (the "tune" toggle).
  //   opts: { getRegex(): bool, getGroups(): string[], onChange(value), onEnter?(),
  //           optionsHeight?: px (0 = default), saveOptionsHeight?(px | 0),
  //           sizeRoot?: element the panel is sized against (default: the popup) }
  // Returns { refresh(), isSuggestOpen(), isOptionsOpen(), openOptions(),
  //           closeOptions({ instant }) -> bool, setOptionsHeight(px), destroy() }.
  // The input keeps its id/handlers; we only decorate.
  const SEARCH_PLACEHOLDER_IDLE = 'Click here to search...';
  // The Best/Recent sort toggle's look for the effective mode ('best' | 'new'),
  // painted by both popups (attachSearchBox decides when it is shown).
  function paintSortButton(btn, mode) {
    if (!btn) return;
    const recent = mode === 'new';
    btn.classList.toggle('active', recent);
    btn.title = recent ? 'Sorted by newest. Click for best match.' : 'Sorted by best match. Click for newest.';
    btn.setAttribute('aria-label', btn.title);
    const icon = btn.querySelector('.mi');
    if (icon) icon.textContent = recent ? 'schedule' : 'sort';
  }
  const SEARCH_PLACEHOLDER_FOCUSED = 'Search...';
  const OPTIONS_MIN_PX = 80;
  const OPTIONS_DEFAULT_SHARE = 0.4;
  const OPTIONS_MAX_SHARE = 0.7;
  function attachSearchBox(inputEl, opts) {
    if (typeof document === 'undefined' || !inputEl) return { refresh() {}, destroy() {}, closeOptions: () => false, isOptionsOpen: () => false };
    const o = opts || {};
    const getRegex = o.getRegex || (() => false);
    const getGroups = o.getGroups || (() => []);
    const row = inputEl.closest('.search-row') || inputEl.parentElement;
    const field = inputEl.parentElement;
    // Backdrop mirror: a div exactly under the input, carrying the SAME text metrics.
    const backdrop = document.createElement('div');
    backdrop.className = 'search-hl';
    backdrop.setAttribute('aria-hidden', 'true');
    inputEl.classList.add('search-live');
    if (getComputedStyle(field).position === 'static') field.style.position = 'relative';
    field.insertBefore(backdrop, inputEl);
    // Dropdown for autocomplete.
    const dropdown = document.createElement('div');
    dropdown.className = 'search-suggest hidden';
    if (row && getComputedStyle(row).position === 'static') row.style.position = 'relative';
    (row || field).appendChild(dropdown);
    // In-field buttons on the shared reveal + the options panel (renderPopupShell markup).
    const revealOf = (name) => (row ? row.querySelector(`.bc-reveal[data-reveal="${name}"]`) : null);
    const clearReveal = revealOf('clear');
    const sortReveal = revealOf('sort');
    const toolsReveal = revealOf('tools');
    const optsBtn = row ? row.querySelector('.opts-btn') : null;
    const panel = optsBtn ? document.getElementById(optsBtn.getAttribute('aria-controls')) : null;
    const scroller = panel ? panel.querySelector('.search-opts-scroll') : null;
    const facetsEl = panel ? panel.querySelector('.opts-facets') : null;
    const handle = panel ? panel.querySelector('.search-opts-resize') : null;
    // The chip row is one line while the panel is shut and shows every chip
    // while it is open: the panel is the "all filters" view.
    const header = row ? row.closest('.sticky') : null;
    const chipStrip = header && header.querySelector('.group-filters') ? attachChipStrip(header.querySelector('.group-filters')) : null;
    const sizeRoot = o.sizeRoot || inputEl.closest('.bc-popup') || document.documentElement;
    let suggestions = [];
    let active = -1;
    let suggestOpen = false;
    let suggestFor = null; // the field text the open list was built for
    let panelOpen = false;
    let optionsHeight = Math.max(0, Math.round(Number(o.optionsHeight) || 0)); // 0 = the default share
    let facetsKey = null;
    // Forge autocomplete state: the list parked by Esc (until the text changes),
    // the open result, the ghost suffix, the selected-suffix auto-fill and how
    // the last edit was made (a deletion never auto-fills).
    let parkedFor = null;
    let suggestRes = null;
    let ghost = '';
    let autoFill = null; // { text, selStart, selEnd }
    let lastInputType = '';
    let rawPaste = false; // Ctrl/Cmd+Shift+V: paste exactly what is on the clipboard
    let pendingTimer = null;
    let pendingShown = null; // the text whose pending problems (a regex being typed) are shown
    // ONE hint line under the field (invalid tokens, a broken regex): it folds
    // open and shut, 0 px when there is nothing to say.
    const hint = document.createElement('div');
    hint.className = 'search-hint';
    hint.setAttribute('role', 'status');
    hint.setAttribute('aria-live', 'polite');
    hint.innerHTML = '<div class="search-hint-clip"><div class="search-hint-row"><span class="mi" aria-hidden="true">info</span><span class="search-hint-text"></span></div></div>';
    const hintText = hint.querySelector('.search-hint-text');
    if (row) row.insertAdjacentElement('afterend', hint); else field.insertAdjacentElement('afterend', hint);

    // One focus state for everything that shows it (the underline's accent and
    // the placeholder): the field (or its buttons) holds the focus AND the
    // window does. A popup open in an unfocused window shows neither.
    const fieldFocused = () => document.activeElement === inputEl && (typeof document.hasFocus !== 'function' || document.hasFocus());
    const rowFocused = () => !!(row && row.contains(document.activeElement)) && (typeof document.hasFocus !== 'function' || document.hasFocus());
    const caretAt = () => (inputEl.selectionStart === inputEl.selectionEnd ? inputEl.selectionStart : null);

    function paintHighlight() {
      const value = inputEl.value;
      let segs = [];
      let shown = [];
      if (Search && Search.validateQuery) {
        const all = Search.validateQuery(value, { regex: !!getRegex(), groups: getGroups(), caret: caretAt() });
        // A token still being typed at the caret (a regex mid-group) is flagged
        // only once typing pauses.
        shown = all.filter((p) => !p.pending || pendingShown === value);
        clearTimeout(pendingTimer);
        if (all.some((p) => p.pending) && pendingShown !== value) pendingTimer = setTimeout(() => { pendingShown = inputEl.value; paintHighlight(); }, 700);
        segs = Search.lexQuery(value, { regex: !!getRegex(), problems: shown });
      }
      backdrop.innerHTML = segs.map((s) => `<span class="qh-${s.kind}">${escapeHtml(s.text)}</span>`).join('')
        + (ghost ? `<span class="qh-ghost">${escapeHtml(ghost)}</span>` : '');
      backdrop.scrollLeft = inputEl.scrollLeft;
      paintHint(shown[0] || null);
    }
    function paintHint(problem) {
      // The "Did you mean X?" is its own button (one click rewrites the bad key
      // or token), so the sentence leaves it out.
      const text = problem && Search.describeProblem ? Search.describeProblem({ ...problem, didYouMean: undefined, options: problem.didYouMean ? undefined : problem.options }) : '';
      hint.classList.toggle('show', !!text);
      if (!text) return;
      hintText.textContent = text;
      if (problem.didYouMean) {
        const fix = document.createElement('button');
        fix.type = 'button';
        fix.className = 'btn quiet sm accent search-hint-fix';
        fix.innerHTML = `Did you mean <code>${escapeHtml(problem.didYouMean)}</code>?`;
        const neg = problem.token[0] === '-' && problem.token.length > 1 ? '-' : '';
        fix.dataset.from = String(problem.kind === 'unknown-key' ? problem.start + neg.length : problem.start);
        fix.dataset.to = String(problem.kind === 'unknown-key' ? problem.valueStart : problem.end);
        fix.dataset.text = problem.kind === 'unknown-key' ? problem.didYouMean : neg + problem.didYouMean;
        fix.dataset.for = inputEl.value;
        hintText.appendChild(fix);
      }
    }
    // The field's chrome follows its state: placeholder, revealed buttons, the
    // options toggle (lit while the panel is open or the query holds one of its filters).
    function syncControls() {
      const value = inputEl.value;
      // ONE value for the underline AND the placeholder (Tab onto a field
      // button keeps both in the focused look).
      const focusInside = row ? rowFocused() : fieldFocused();
      inputEl.placeholder = focusInside ? SEARCH_PLACEHOLDER_FOCUSED : SEARCH_PLACEHOLDER_IDLE;
      if (row) row.classList.toggle('is-focused', focusInside);
      const parsed = Search && Search.parseQuery ? Search.parseQuery(value) : null;
      const optionFilters = !!(parsed && Search.optionFacetsActive && Search.optionFacetsActive(parsed));
      if (clearReveal) clearReveal.classList.toggle('open', value.length > 0);
      if (sortReveal) sortReveal.classList.toggle('open', !!value.trim());
      if (toolsReveal) toolsReveal.classList.toggle('open', focusInside || value.length > 0 || !!getRegex() || panelOpen);
      if (optsBtn) {
        optsBtn.classList.toggle('active', panelOpen || optionFilters);
        optsBtn.setAttribute('aria-expanded', String(panelOpen));
        optsBtn.title = panelOpen ? 'Hide search options' : 'Search options';
      }
      if (panelOpen) renderFacets();
    }
    // The chips depend on the filters and the census only, never on the free
    // text: typing words with the panel open rebuilds nothing.
    function renderFacets() {
      if (!facetsEl) return;
      const parsed = Search.parseQuery(inputEl.value);
      const census = o.getCensus ? o.getCensus(parsed) : null;
      const key = `${Search.facetKey(parsed)}\u0001${census ? census.id || 'c' : ''}`;
      if (facetsKey === key) return;
      facetsKey = key;
      // A rebuild must not drop a keyboard user's place: the focused chip's twin
      // takes the focus back (else it falls to <body> and Tab starts over).
      const focused = facetsEl.contains(document.activeElement) ? document.activeElement : null;
      const place = focused && focused.dataset ? `.facet-opt[data-row="${focused.dataset.row}"][data-opt="${focused.dataset.opt}"]` : null;
      facetsEl.innerHTML = renderSearchFacets(inputEl.value, census);
      const twin = place ? facetsEl.querySelector(place) : null;
      if (twin) twin.focus({ preventScroll: true });
    }
    function closeSuggest() { suggestOpen = false; active = -1; suggestions = []; dropdown.classList.add('hidden'); dropdown.innerHTML = ''; }
    // The rows share the menu-row look (.bc-menu-item); each row's hint is its
    // own (Search.FIELD_INFO), never one hint repeated down the list.
    function renderSuggest() {
      if (!suggestions.length) { closeSuggest(); return; }
      dropdown.innerHTML = suggestions.map((s, i) =>
        `<div class="bc-menu-item search-suggest-item${i === active ? ' active' : ''}" data-i="${i}" role="option" aria-selected="${i === active}"><span class="ss-text bc-menu-label">${escapeHtml(s.label)}</span>${s.hint ? `<span class="ss-hint">${escapeHtml(s.hint)}</span>` : ''}</div>`
      ).join('');
      dropdown.classList.remove('hidden');
      suggestOpen = true;
    }
    // Suggestions for the token at the caret (Search.suggestQuery's rules), the
    // top row's ghost and, unless Esc parked the list for this exact text,
    // the dropdown.
    function computeSuggest() {
      const caret = caretAt();
      const parked = parkedFor !== null && parkedFor === inputEl.value;
      suggestRes = !parked && caret != null && Search && Search.suggestQuery ? Search.suggestQuery(inputEl.value, caret, { groups: getGroups() }) : null;
      ghost = suggestRes && Search.ghostCompletion ? Search.ghostCompletion(inputEl.value, caret, suggestRes) : '';
      suggestFor = inputEl.value;
    }
    function updateSuggest() {
      if (parkedFor !== null && parkedFor !== inputEl.value) parkedFor = null; // any edit un-parks
      computeSuggest();
      if (!suggestRes) { closeSuggest(); return; }
      suggestions = suggestRes.suggestions;
      active = -1;
      renderSuggest();
    }
    // Exactly one value fits what was just typed: fill it in, the inserted part
    // selected (the next key replaces it; Space or Tab keeps it). Never after a
    // deletion, never over a selection.
    function maybeAutoFill() {
      if (!suggestRes || lastInputType.startsWith('delete') || caretAt() == null || !Search.uniqueCompletion) return false;
      const comp = Search.uniqueCompletion(inputEl.value, suggestRes);
      if (!comp || comp.text === inputEl.value) return false;
      inputEl.value = comp.text;
      inputEl.setSelectionRange(comp.selectionStart, comp.selectionEnd);
      autoFill = { text: comp.text, selStart: comp.selectionStart, selEnd: comp.selectionEnd };
      closeSuggest();
      suggestRes = null;
      ghost = '';
      paintHighlight();
      syncControls();
      if (o.onChange) o.onChange(inputEl.value);
      return true;
    }
    // A programmatic change of the query (suggestion, panel chip): repaint, then
    // hand the new value to the consumer like typed input.
    function commitValue(next, caret) {
      closeSuggest(); // its rows (and their replace ranges) belong to the old text
      autoFill = null;
      inputEl.value = next;
      const at = caret == null ? next.length : caret;
      inputEl.setSelectionRange(at, at);
      computeSuggest();
      paintHighlight();
      syncControls();
      if (o.onChange) o.onChange(inputEl.value);
    }
    function applySuggestion(i) {
      const s = suggestRes && suggestRes.suggestions[i];
      if (!s) return;
      const res = suggestRes;
      closeSuggest();
      const next = Search.applySuggestion(inputEl.value, res, s);
      commitValue(next.text, next.caret);
      // A key (title:) is followed by its value: offer the values at once.
      if (res.kind === 'key') updateSuggest();
    }
    // The consumer changed the field's text (cleared it, a chip rewrote it): a
    // suggestion list built for the old text goes with it.
    function refresh() {
      if (suggestOpen && inputEl.value !== suggestFor) closeSuggest();
      if (inputEl.value !== suggestFor) { suggestRes = null; ghost = ''; }
      paintHighlight();
      syncControls();
    }

    // ── options panel ──
    const rootHeight = () => (sizeRoot === document.documentElement ? window.innerHeight : sizeRoot.clientHeight) || 0;
    const maxOptionsHeight = () => Math.max(OPTIONS_MIN_PX, Math.round(rootHeight() * OPTIONS_MAX_SHARE));
    const effectiveOptionsHeight = () => Math.min(maxOptionsHeight(), Math.max(OPTIONS_MIN_PX, optionsHeight || Math.round(rootHeight() * OPTIONS_DEFAULT_SHARE)));
    const applyOptionsHeight = (px) => { if (panel) panel.style.setProperty('--opts-h', `${px}px`); };
    const fade = scroller ? attachScrollFade(scroller, 'box') : null;
    function setPanel(open, how) {
      if (!panel) return false;
      const was = panelOpen;
      const active = document.activeElement;
      const focusInPanel = !!(active && panel.contains(active));
      panelOpen = !!open;
      if (how && how.instant) {
        panel.style.transition = 'none';
        panel.classList.toggle('open', panelOpen);
        void panel.offsetHeight; // settle the closed state before transitions return
        panel.style.transition = '';
      } else {
        panel.classList.toggle('open', panelOpen);
      }
      panel.inert = !panelOpen;
      panel.setAttribute('aria-hidden', String(!panelOpen));
      if (chipStrip) chipStrip.setExpanded(panelOpen, how);
      if (panelOpen) {
        closeSuggest(); // the panel opens under the field; a suggest list would cover its rows
        facetsKey = null;
        applyOptionsHeight(effectiveOptionsHeight());
        if (scroller && !was) scroller.scrollTop = 0;
      } else if (was && (focusInPanel || !active || active === document.body)) {
        // The panel went inert under the focus (or the focus was already lost):
        // typing goes back to the field.
        inputEl.focus({ preventScroll: true });
      }
      syncControls();
      if (fade) fade.refresh();
      return was !== panelOpen;
    }
    // Shown and open: an Esc closes it before anything else (the controller asks).
    const panelVisible = () => panelOpen && !!panel && panel.getClientRects().length > 0;
    const onOptsClick = (e) => { e.preventDefault(); setPanel(!panelOpen); };
    const onPanelMousedown = (e) => {
      // Nothing in the panel takes the focus from the field (typing continues after
      // a click on a chip, the reference or a gap). Its scrollbar is left alone.
      if (document.activeElement !== inputEl) return;
      if (scroller && e.target === scroller && e.offsetX >= scroller.clientWidth) return;
      e.preventDefault();
    };
    function facetFromEvent(e) {
      const chip = e.target.closest('.facet-opt');
      if (!chip || chip.disabled || !Search || !Search.OPTION_FACETS) return null;
      const rowDef = Search.OPTION_FACETS[Number(chip.dataset.row)];
      const opt = rowDef && rowDef.options[Number(chip.dataset.opt)];
      return opt ? { chip, opt } : null;
    }
    function applyOption(opt, intent) {
      const value = inputEl.value;
      if (opt.prompt) {
        // A prompt option either clears its facet or puts its prefix in the field
        // for typing (the autocomplete then offers the presets).
        if (Search.facetTokenState(Search.parseQuery(value), { kind: opt.token.kind })) {
          commitValue(Search.applyFacet(value, { kind: opt.token.kind, value: Search.parseQuery(value)[opt.token.kind] }, 'include'));
        } else {
          const base = value.replace(/\s+$/, '');
          commitValue(`${base}${base ? ' ' : ''}${opt.prompt}`);
          inputEl.focus();
          updateSuggest();
        }
        return;
      }
      const single = ['since', 'before', 'len', 'lines', 'words'].includes(opt.token.kind);
      commitValue(Search.applyFacet(value, opt.token, single ? 'include' : intent));
    }
    const onPanelClick = (e) => {
      // A key chip: its prefix goes on the end of the query (a space before it)
      // and the field takes the typing, with the autocomplete on its values.
      const key = e.target.closest('.opts-field');
      if (key && key.dataset.insert) {
        e.preventDefault();
        e.stopPropagation();
        const base = inputEl.value.replace(/\s+$/, '');
        commitValue(`${base}${base ? ' ' : ''}${key.dataset.insert}`);
        inputEl.focus();
        updateSuggest();
        return;
      }
      const hit = facetFromEvent(e);
      if (!hit) return;
      e.preventDefault();
      e.stopPropagation();
      applyOption(hit.opt, 'include');
    };
    const onPanelContextmenu = (e) => {
      // A disabled <button> still receives contextmenu (Forge's ChipToggle note): a greyed chip does nothing.
      if (e.target.closest('.facet-opt:disabled')) { e.preventDefault(); e.stopPropagation(); return; }
      const hit = facetFromEvent(e);
      if (!hit) return;
      e.preventDefault();
      e.stopPropagation();
      // Right-click excludes a multi-valued facet (is:), like the chip bar; a
      // single-valued one (a date, a size) has no exclude, so it just toggles.
      applyOption(hit.opt, 'exclude');
    };
    if (optsBtn) optsBtn.addEventListener('click', onOptsClick);
    if (panel) {
      panel.addEventListener('mousedown', onPanelMousedown);
      panel.addEventListener('click', onPanelClick);
      panel.addEventListener('contextmenu', onPanelContextmenu);
    }
    const resize = handle ? attachResizeHandle(handle, {
      axis: 'y',
      edge: 'bottom',
      size: () => (scroller ? scroller.getBoundingClientRect().height : effectiveOptionsHeight()),
      min: () => OPTIONS_MIN_PX,
      // Never past the content (the panel would stop following the cursor) nor 70 % of the popup.
      max: () => Math.max(OPTIONS_MIN_PX, Math.min(maxOptionsHeight(), scroller ? scroller.scrollHeight : Infinity)),
      onDrag: (px) => applyOptionsHeight(px),
      onCommit: (px) => { optionsHeight = px; if (o.saveOptionsHeight) o.saveOptionsHeight(px); },
      onReset: () => { optionsHeight = 0; applyOptionsHeight(effectiveOptionsHeight()); if (o.saveOptionsHeight) o.saveOptionsHeight(0); },
      onState: (dragging) => { if (panel) panel.classList.toggle('resizing', dragging); },
    }) : null;
    // The panel keeps its share of the popup as the window resizes.
    const onRootResize = () => { if (panelOpen) applyOptionsHeight(effectiveOptionsHeight()); };
    if (typeof window !== 'undefined') window.addEventListener('resize', onRootResize);
    const rootObserver = sizeRoot !== document.documentElement && typeof ResizeObserver !== 'undefined' ? new ResizeObserver(onRootResize) : null;
    if (rootObserver) rootObserver.observe(sizeRoot);

    // In-field buttons never take the focus from the field; the clear button stays
    // out of the Tab order (Forge's ClearButton).
    const onRowMousedown = (e) => {
      if (e.button === 0 && e.target.closest('.bc-reveal .icon-btn') && document.activeElement === inputEl) e.preventDefault();
    };
    const clearBtn = row ? row.querySelector('.search-clear') : null;
    if (clearBtn) clearBtn.tabIndex = -1;
    if (row) row.addEventListener('mousedown', onRowMousedown);

    const onBeforeInput = (e) => { lastInputType = e.inputType || ''; };
    const onInput = () => {
      if (autoFill && autoFill.text !== inputEl.value) autoFill = null; // typed over (or deleted) the fill
      updateSuggest();
      if (!maybeAutoFill()) { paintHighlight(); syncControls(); }
      lastCaret = caretAt(); // the keyup that follows is not a caret move
    };
    const onScroll = () => { backdrop.scrollLeft = inputEl.scrollLeft; };
    const onFocus = () => syncControls();
    const onBlur = () => { syncControls(); setTimeout(closeSuggest, 120); if (ghost) { ghost = ''; paintHighlight(); } }; // allow a click on a suggestion
    // Focus moving between the field and its own buttons keeps them revealed.
    const onRowFocusChange = () => setTimeout(syncControls, 0);
    // The window gaining or losing focus changes the ONE focus state too.
    const onWindowFocus = () => syncControls();
    // The caret moved without an edit (arrows, a click): the list and the ghost
    // follow it (both only exist with the caret at the end of a token).
    let lastCaret = null;
    const onCaretMove = () => {
      const caret = caretAt();
      if (caret === lastCaret) return;
      lastCaret = caret;
      updateSuggest();
      paintHighlight();
    };
    const onKeyDown = (e) => {
      if (e.isComposing) return;
      // Ctrl/Cmd+Shift+V pastes exactly what is on the clipboard (no auto-quote).
      // Windows/Linux Chromium pastes on that chord by itself; macOS binds no
      // paste to Cmd+Shift+V, so there the box asks for one (a no-op where the
      // page may not read the clipboard).
      if ((e.ctrlKey || e.metaKey) && e.shiftKey && (e.key === 'v' || e.key === 'V')) {
        rawPaste = Date.now();
        if (e.metaKey && typeof navigator !== 'undefined' && /Mac/i.test(navigator.platform || '')) {
          e.preventDefault();
          try { document.execCommand('paste'); } catch {}
        }
      }
      // Space or Tab keeps an auto-filled value and ends its token.
      if ((e.key === ' ' || e.key === 'Tab') && !e.shiftKey && autoFill && autoFill.text === inputEl.value
        && inputEl.selectionStart === autoFill.selStart && inputEl.selectionEnd === autoFill.selEnd) {
        e.preventDefault(); e.stopPropagation();
        const at = autoFill.selEnd;
        const v = inputEl.value;
        const space = /^\s/.test(v.slice(at)) ? '' : ' ';
        commitValue(v.slice(0, at) + space + v.slice(at), at + space.length);
        return;
      }
      if (suggestOpen && suggestions.length) {
        // While the dropdown is open, capture nav keys BEFORE the document controller sees
        // them (stopPropagation) so arrows move the suggestion, not the result cursor.
        if (e.key === 'ArrowDown') { e.preventDefault(); e.stopPropagation(); active = (active + 1) % suggestions.length; renderSuggest(); return; }
        if (e.key === 'ArrowUp') { e.preventDefault(); e.stopPropagation(); active = (active - 1 + suggestions.length) % suggestions.length; renderSuggest(); return; }
        if (e.key === 'Tab' || (e.key === 'Enter' && active >= 0)) { e.preventDefault(); e.stopPropagation(); applySuggestion(active >= 0 ? active : 0); return; }
        // Esc parks the list for this text (the next edit brings it back); the
        // Esc after that reaches the panel / popup as before.
        if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); parkedFor = inputEl.value; closeSuggest(); computeSuggest(); paintHighlight(); return; }
      }
      // The ghost: Tab, or Right with the caret at the very end, takes it.
      const atEnd = inputEl.selectionStart === inputEl.value.length && inputEl.selectionEnd === inputEl.value.length;
      if (ghost && suggestRes && !e.shiftKey && (e.key === 'Tab' || (e.key === 'ArrowRight' && atEnd))) { e.preventDefault(); e.stopPropagation(); applySuggestion(0); return; }
      if (e.key === 'Enter' && o.onEnter) { o.onEnter(); }
    };
    // A multi-word plain-text paste searches as ONE phrase (Search.quotePastedText);
    // not inside an open quote, not query syntax, not after Ctrl/Cmd+Shift+V.
    const onPaste = (e) => {
      const raw = rawPaste && Date.now() - rawPaste < 1000;
      rawPaste = false;
      if (raw || !Search || !Search.quotePastedText) return;
      const v = inputEl.value;
      const start = inputEl.selectionStart == null ? v.length : inputEl.selectionStart;
      const end = inputEl.selectionEnd == null ? v.length : inputEl.selectionEnd;
      if (Search.insideQuote(v, start)) return;
      const quoted = Search.quotePastedText(e.clipboardData ? e.clipboardData.getData('text') : '');
      if (!quoted) return;
      e.preventDefault();
      const before = start > 0 && !/\s/.test(v[start - 1]) ? ' ' : '';
      const after = end < v.length && !/\s/.test(v[end]) ? ' ' : '';
      const ins = before + quoted + after;
      commitValue(v.slice(0, start) + ins + v.slice(end), start + ins.length);
    };
    const onDropdownMousedown = (e) => {
      const item = e.target.closest('.search-suggest-item');
      if (item) { e.preventDefault(); applySuggestion(Number(item.dataset.i)); }
    };
    // The hint's "Use title:" fixes the token; the field keeps the focus.
    const onHintMousedown = (e) => { if (e.target.closest('.search-hint-fix')) e.preventDefault(); };
    const onHintClick = (e) => {
      const fix = e.target.closest('.search-hint-fix');
      if (!fix || fix.dataset.for !== inputEl.value) return;
      const from = Number(fix.dataset.from);
      const to = Number(fix.dataset.to);
      const v = inputEl.value;
      commitValue(v.slice(0, from) + fix.dataset.text + v.slice(to), from + fix.dataset.text.length);
      inputEl.focus();
    };
    dropdown.addEventListener('mousedown', onDropdownMousedown);
    hint.addEventListener('mousedown', onHintMousedown);
    hint.addEventListener('click', onHintClick);
    inputEl.addEventListener('beforeinput', onBeforeInput);
    inputEl.addEventListener('input', onInput);
    inputEl.addEventListener('paste', onPaste);
    inputEl.addEventListener('scroll', onScroll);
    inputEl.addEventListener('focus', onFocus);
    inputEl.addEventListener('blur', onBlur);
    inputEl.addEventListener('keydown', onKeyDown, true);
    inputEl.addEventListener('keyup', onCaretMove);
    inputEl.addEventListener('mouseup', onCaretMove);
    if (typeof window !== 'undefined') { window.addEventListener('focus', onWindowFocus); window.addEventListener('blur', onWindowFocus); }
    if (row) { row.addEventListener('focusin', onRowFocusChange); row.addEventListener('focusout', onRowFocusChange); }
    paintHighlight();
    syncControls();
    return {
      refresh,
      isSuggestOpen: () => suggestOpen,
      isOptionsOpen: () => panelOpen,
      openOptions: () => setPanel(true),
      // true when it closed a shown panel (Esc consumed).
      closeOptions: (how) => { const shown = panelVisible(); setPanel(false, how); return shown; },
      setOptionsHeight: (px) => { optionsHeight = Math.max(0, Math.round(Number(px) || 0)); if (panelOpen) applyOptionsHeight(effectiveOptionsHeight()); },
      destroy() {
        clearTimeout(pendingTimer);
        inputEl.removeEventListener('beforeinput', onBeforeInput);
        inputEl.removeEventListener('input', onInput);
        inputEl.removeEventListener('paste', onPaste);
        inputEl.removeEventListener('scroll', onScroll);
        inputEl.removeEventListener('focus', onFocus);
        inputEl.removeEventListener('blur', onBlur);
        inputEl.removeEventListener('keydown', onKeyDown, true);
        inputEl.removeEventListener('keyup', onCaretMove);
        inputEl.removeEventListener('mouseup', onCaretMove);
        if (typeof window !== 'undefined') { window.removeEventListener('focus', onWindowFocus); window.removeEventListener('blur', onWindowFocus); }
        hint.remove();
        if (row) { row.removeEventListener('focusin', onRowFocusChange); row.removeEventListener('focusout', onRowFocusChange); row.removeEventListener('mousedown', onRowMousedown); }
        if (optsBtn) optsBtn.removeEventListener('click', onOptsClick);
        if (panel) {
          panel.removeEventListener('mousedown', onPanelMousedown);
          panel.removeEventListener('click', onPanelClick);
          panel.removeEventListener('contextmenu', onPanelContextmenu);
        }
        if (resize) resize.destroy();
        if (fade) fade.detach();
        if (typeof window !== 'undefined') window.removeEventListener('resize', onRootResize);
        if (rootObserver) rootObserver.disconnect();
        backdrop.remove(); dropdown.remove();
        inputEl.classList.remove('search-live');
      },
    };
  }

  // How the user last drove this window: a trusted keydown or a pointer press.
  // A menu opened right after a key press (Enter / Space on its button, the
  // menu key) is a keyboard open and focuses its first row; one opened by a
  // click or right-click is not. (Focus state cannot tell: a field, or an
  // element focused by script, matches :focus-visible either way.)
  let lastInputWasKey = false;
  function trackInputModality() {
    if (typeof document === 'undefined' || document.bcInputModality) return;
    document.bcInputModality = true;
    document.addEventListener('keydown', (e) => { if (e.isTrusted) lastInputWasKey = true; }, true);
    document.addEventListener('pointerdown', (e) => { if (e.isTrusted) lastInputWasKey = false; }, true);
  }
  // Keyboard model shared by every menu (createMenu), pure so it is unit
  // tested (Forge SelectionList): the item to focus after `key` from `index`
  // (-1 = none focused yet) over `count` items, skipping disabled ones
  // (isDisabled(i)) and wrapping; Home / End = the first / last enabled item.
  // -1 when nothing is enabled.
  function menuNavIndex(count, index, key, isDisabled) {
    if (!count) return -1;
    const usable = (i) => !(isDisabled && isDisabled(i));
    const scan = (from, step) => {
      for (let k = 0, i = from; k < count; k += 1, i = (i + step + count) % count) if (usable(i)) return i;
      return -1;
    };
    if (key === 'Home') return scan(0, 1);
    if (key === 'End') return scan(count - 1, -1);
    if (key === 'ArrowDown') return scan(index < 0 ? 0 : (index + 1) % count, 1);
    if (key === 'ArrowUp') return scan(index < 0 ? count - 1 : (index - 1 + count) % count, -1);
    return index;
  }
  // The keypad (7 8 9 / 4 5 6 / 1 2 3) moves in two dimensions: the key
  // position (0-8, layout order) after an arrow, 'up' / 'down' when it leaves
  // the grid at the top / bottom (the menu moves on to the row before / after
  // it), 'left' at the left edge (closes a submenu), null at the right edge.
  function keypadStep(pos, key) {
    const col = pos % 3;
    if (key === 'ArrowLeft') return col > 0 ? pos - 1 : 'left';
    if (key === 'ArrowRight') return col < 2 ? pos + 1 : null;
    if (key === 'ArrowUp') return pos >= 3 ? pos - 3 : 'up';
    if (key === 'ArrowDown') return pos < 6 ? pos + 3 : 'down';
    return null;
  }
  // A lightweight click-open popover, mounted into `host` (document.body for the
  // app so it inherits :root tokens; the demo window for the demo so it inherits
  // .bc-popup tokens). Positioned at a point, clamped to the host box, dismissed
  // on outside-click / Esc / scroll / resize. Menu item clicks bubble to the
  // document controller (same data-action dispatch); this just closes after.
  // Keyboard: Up / Down / Home / End move between rows (disabled rows are
  // skipped), Right or Enter opens a submenu, Left / Esc close one level,
  // Enter / Space activate, 1-9 press the visible keypad's key, Tab closes.
  // Opened from the keyboard, the first row takes focus; opened with the
  // mouse, nothing moves until the first arrow key. Focus that went into the
  // menu goes back to the opener on close. The mouse works as it always did.
  function createMenu(host) {
    if (typeof document === 'undefined') return { open() {}, close() {}, isOpen: () => false, root: () => null };
    const mount = host || document.body;
    const boundsEl = mount === document.body || mount === document.documentElement ? document : mount;
    trackInputModality();
    let el = null;
    let onClosed = null;
    let opener = null;
    function close() {
      if (!el) return;
      const hadFocus = el.contains(document.activeElement);
      el.remove();
      el = null;
      document.removeEventListener('pointerdown', onOutside, true);
      document.removeEventListener('keydown', onKey, true);
      document.removeEventListener('scroll', onScroll, true);
      window.removeEventListener('resize', close, true);
      const back = opener;
      opener = null;
      if (hadFocus && back && back.isConnected && typeof back.focus === 'function') back.focus({ preventScroll: true });
      const done = onClosed;
      onClosed = null;
      if (done) done();
    }
    function onOutside(e) { if (el && !el.contains(e.target)) close(); }
    // Scrolling the list under an open menu would leave it floating over rows
    // that moved away — close instead (scrolls inside the menu are fine).
    function onScroll(e) { if (el && !el.contains(e.target)) close(); }
    // --- Keyboard: one level = the root list or one .tag-submenu; its items
    // are its own rows (a parent row included) and the keys of its keypad.
    const ITEMS = ':scope > .bc-menu-item, :scope > .tag-menu-node > .bc-menu-item, :scope > .numpad-picker .np-btn';
    const rootLevel = () => (el ? el.querySelector(':scope > .bc-menu-list') || el : null);
    const itemsOf = (level) => (level ? [...level.querySelectorAll(ITEMS)] : []);
    const isOff = (item) => !!(item && (item.disabled || item.getAttribute('aria-disabled') === 'true'));
    const levelOf = (item) => (item.parentElement && item.parentElement.closest('.tag-submenu')) || rootLevel();
    const isParent = (item) => item.getAttribute('aria-haspopup') === 'menu';
    function focusedItem() {
      const active = document.activeElement;
      return el && active && el.contains(active) && typeof active.matches === 'function' && active.matches('.bc-menu-item, .np-btn') ? active : null;
    }
    function focusItem(item) { if (item && typeof item.focus === 'function') item.focus({ preventScroll: true }); }
    function focusStep(level, from, key) {
      const items = itemsOf(level);
      const next = menuNavIndex(items.length, from ? items.indexOf(from) : -1, key, (i) => isOff(items[i]));
      if (next >= 0) focusItem(items[next]);
    }
    function shut(node) {
      for (const n of [node, ...node.querySelectorAll('.tag-menu-node.open')]) {
        n.classList.remove('open');
        const row = n.querySelector(':scope > .bc-menu-item');
        if (row) row.setAttribute('aria-expanded', 'false');
      }
    }
    function openSub(row) {
      const node = row.parentElement;
      const sub = node && node.classList.contains('tag-menu-node') ? node.querySelector(':scope > .tag-submenu') : null;
      if (!sub) return;
      for (const other of node.parentElement.querySelectorAll(':scope > .tag-menu-node.open')) if (other !== node) shut(other);
      node.classList.add('open');
      row.setAttribute('aria-expanded', 'true');
      fitSubmenu(node, sub, boundsEl);
      focusStep(sub, null, 'ArrowDown');
    }
    function closeLevel(level) {
      const node = level.parentElement;
      if (!node) return;
      shut(node);
      focusItem(node.querySelector(':scope > .bc-menu-item'));
    }
    function onKey(e) {
      if (!el) return;
      const key = e.key;
      if (key === 'Tab') { close(); return; } // focus is back on the opener; Tab moves on from there
      const item = focusedItem();
      const stop = () => { e.preventDefault(); e.stopPropagation(); };
      if (key === 'Escape') {
        stop();
        const level = item ? levelOf(item) : null;
        if (level && level !== rootLevel()) closeLevel(level); else close();
        return;
      }
      if (/^[1-9]$/.test(key) && !e.ctrlKey && !e.metaKey && !e.altKey) {
        const pad = [...el.querySelectorAll('.numpad-picker')].find((p) => p.getClientRects().length);
        const keyBtn = pad && pad.querySelector(`.np-btn[data-n="${key}"]`);
        if (keyBtn) { stop(); keyBtn.click(); }
        return;
      }
      // Nothing focused yet (opened with the mouse): only Up / Down enter the
      // menu, so typing and caret keys in a focused field keep working.
      if (!item) {
        if (key === 'ArrowDown' || key === 'ArrowUp') { stop(); focusStep(rootLevel(), null, key); }
        return;
      }
      if (!['ArrowDown', 'ArrowUp', 'ArrowLeft', 'ArrowRight', 'Home', 'End', 'Enter', ' '].includes(key)) return;
      stop();
      const level = levelOf(item);
      if (key === 'Enter' || key === ' ') {
        if (isOff(item)) return;
        if (isParent(item) && !item.dataset.action) openSub(item); else item.click();
        return;
      }
      if (item.classList.contains('np-btn') && key.startsWith('Arrow')) {
        const keys = [...item.parentElement.querySelectorAll(':scope > .np-btn')];
        const step = keypadStep(keys.indexOf(item), key);
        if (typeof step === 'number') { focusItem(keys[step]); return; }
        if (step === 'up') { focusStep(level, keys[0], 'ArrowUp'); return; }
        if (step === 'down') { focusStep(level, keys[keys.length - 1], 'ArrowDown'); return; }
        if (step === 'left' && level !== rootLevel()) closeLevel(level);
        return;
      }
      if (key === 'ArrowRight') { if (isParent(item)) openSub(item); return; }
      if (key === 'ArrowLeft') { if (level !== rootLevel()) closeLevel(level); return; }
      focusStep(level, item, key);
    }
    // opts: { x, y, html, id (the clip it acts on, read by the dispatch via
    // closest('[data-id]')), className (an extra class), onClose(), aboveY (the
    // anchor's top edge: when the menu does not fit below y it opens above the
    // anchor instead of being pushed up over it), keyboard (opened from the
    // keyboard: focus the first row; default = the last input was a key) }
    function open(opts) {
      close();
      const o = opts || {};
      const active = document.activeElement;
      opener = active && active !== document.body ? active : null;
      el = document.createElement('div');
      el.className = o.className ? `bc-menu ${o.className}` : 'bc-menu';
      el.setAttribute('role', 'menu');
      onClosed = typeof o.onClose === 'function' ? o.onClose : null;
      if (o.id != null) el.dataset.id = o.id;
      el.innerHTML = o.html || '';
      const list = el.querySelector(':scope > .bc-menu-list');
      if (list) list.setAttribute('role', 'none');
      // Close after an actionable click (let the document dispatch run first).
      el.addEventListener('click', (e) => {
        if (e.target.closest('[data-action],.np-btn')) setTimeout(close, 0);
      });
      // Pointer and keyboard drive ONE active row: moving onto a row closes the
      // keyboard-opened branches it is not in and, once the keyboard has put
      // focus in the menu, moves focus with it.
      el.addEventListener('pointermove', (e) => {
        const row = e.target && e.target.closest ? e.target.closest('.bc-menu-item, .np-btn') : null;
        if (!row) return;
        for (const node of el.querySelectorAll('.tag-menu-node.open')) if (!node.contains(row)) shut(node);
        if (focusedItem() && document.activeElement !== row && !isOff(row)) focusItem(row);
      });
      mount.appendChild(el);
      const isBody = mount === document.body || mount === document.documentElement;
      const hostRect = mount.getBoundingClientRect();
      const mw = el.offsetWidth;
      const mh = el.offsetHeight;
      const vw = isBody ? window.innerWidth : hostRect.width;
      const vh = isBody ? window.innerHeight : hostRect.height;
      let localX = isBody ? o.x : o.x - hostRect.left;
      let localY = isBody ? o.y : o.y - hostRect.top;
      if (o.aboveY != null && localY + mh > vh - 4) {
        const above = (isBody ? o.aboveY : o.aboveY - hostRect.top) - mh;
        if (above >= 4) localY = above;
      }
      localX = Math.max(4, Math.min(localX, vw - mw - 4));
      localY = Math.max(4, Math.min(localY, vh - mh - 4));
      el.style.left = `${Math.round(localX + (isBody ? window.scrollX : mount.scrollLeft))}px`;
      el.style.top = `${Math.round(localY + (isBody ? window.scrollY : mount.scrollTop))}px`;
      if (o.keyboard != null ? o.keyboard : lastInputWasKey) focusStep(rootLevel(), null, 'ArrowDown');
      setTimeout(() => {
        document.addEventListener('pointerdown', onOutside, true);
        document.addEventListener('keydown', onKey, true);
        document.addEventListener('scroll', onScroll, true);
        window.addEventListener('resize', close, true);
      }, 0);
    }
    return { open, close, isOpen: () => !!el, root: () => el };
  }
  // Keep a shown submenu inside the window: a right-opening submenu near the
  // edge opens leftward (flip-x), a tall tree near the bottom shifts up.
  // boundsEl: document (the app popup IS the OS window, so the viewport) or
  // the demo's embedded popup box. Hover (installSubmenuAutoflip) and the
  // menu keyboard (createMenu) both place submenus through this.
  function fitSubmenu(node, sub, boundsEl) {
    sub.classList.remove('flip-x');
    sub.style.top = '';
    const r = sub.getBoundingClientRect();
    if (!r.width) return; // not shown (hover already left)
    const bound = (boundsEl === document || boundsEl === document.documentElement)
      ? { left: 0, top: 0, right: window.innerWidth, bottom: window.innerHeight }
      : boundsEl.getBoundingClientRect();
    if (bound.right - bound.left < 40) return; // hidden/unmeasurable host
    if (r.right > bound.right - 4) {
      const nr = node.getBoundingClientRect();
      if (nr.left - bound.left > bound.right - nr.right) sub.classList.add('flip-x'); // open toward the roomier side
    }
    const r2 = sub.getBoundingClientRect();
    if (r2.bottom > bound.bottom - 4) {
      const shift = Math.min(r2.bottom - (bound.bottom - 4), Math.max(0, r2.top - (bound.top + 4)));
      if (shift > 0) {
        const curTop = parseFloat((typeof getComputedStyle === 'function' ? getComputedStyle(sub).top : '') || '0') || 0;
        sub.style.top = `${curTop - shift}px`;
      }
    }
  }
  // Auto-flip/clamp hover submenus so they never overflow the window. The popup
  // window is narrow, so a right-opening submenu near the edge must open leftward
  // (flip-x) and a tall group tree near the bottom must shift up. One delegated
  // listener per consumer root covers the filter bar AND the popover menus (the
  // controller installs it automatically); keyboard-opened submenus are placed
  // by createMenu through the same fitSubmenu.
  // A chip's submenu in the top layer (popover="manual", the chip row's): it
  // escapes the strip's clip and mask, so it is placed by hand under its chip
  // (left edges aligned, or right edges when that would overflow), clamped to
  // the bounds, and shown while its chip or the submenu itself is hovered or
  // holds the focus (it is still the chip node's DOM child, so :hover and
  // :focus-within reach the node from inside it).
  function placeTopLayerSubmenu(node, sub, boundsEl) {
    const bound = (boundsEl === document || boundsEl === document.documentElement)
      ? { left: 0, top: 0, right: window.innerWidth, bottom: window.innerHeight }
      : boundsEl.getBoundingClientRect();
    const nr = node.getBoundingClientRect();
    const r = sub.getBoundingClientRect();
    let left = nr.left;
    if (left + r.width > bound.right - 4) left = Math.max(bound.left + 4, nr.right - r.width);
    let top = nr.bottom;
    if (top + r.height > bound.bottom - 4) top = Math.max(bound.top + 4, bound.bottom - 4 - r.height);
    sub.style.left = `${Math.round(left)}px`;
    sub.style.top = `${Math.round(top)}px`;
  }
  function closeTopLayerSubmenus(rootEl) {
    const root = rootEl || (typeof document !== 'undefined' ? document : null);
    if (root && typeof root._bcCloseTopLayer === 'function') root._bcCloseTopLayer();
  }
  function installSubmenuAutoflip(rootEl) {
    if (typeof document === 'undefined' || !rootEl || rootEl._bcAutoflip) return;
    rootEl._bcAutoflip = true;
    const shownTopLayer = new Set();
    const openTopLayer = (node, sub) => {
      if (typeof sub.showPopover !== 'function') return;
      if (!sub.matches(':popover-open')) { try { sub.showPopover(); } catch { return; } }
      shownTopLayer.add(sub);
      placeTopLayerSubmenu(node, sub, rootEl);
    };
    // A pointer or the focus leaving a chip (or its submenu): close every
    // top-layer submenu whose chip no longer has either.
    const closeStale = () => setTimeout(() => {
      for (const sub of shownTopLayer) {
        const node = sub.parentElement;
        if (sub.isConnected && node && node.matches(':hover, :focus-within')) continue;
        shownTopLayer.delete(sub);
        if (sub.isConnected && sub.matches(':popover-open')) { try { sub.hidePopover(); } catch {} }
      }
    }, 0);
    rootEl.addEventListener('mouseout', () => { if (shownTopLayer.size) closeStale(); });
    rootEl.addEventListener('focusout', () => { if (shownTopLayer.size) closeStale(); });
    const closeAll = () => {
      for (const sub of shownTopLayer) {
        if (sub.isConnected && sub.matches(':popover-open')) { try { sub.hidePopover(); } catch {} }
      }
      shownTopLayer.clear();
    };
    rootEl._bcCloseTopLayer = closeAll;
    if (typeof window !== 'undefined') window.addEventListener('blur', closeAll);
    rootEl.addEventListener('scroll', (event) => {
      const scroller = event.target;
      if (!shownTopLayer.size || !scroller || !scroller.contains) return;
      for (const sub of shownTopLayer) {
        const node = sub.parentElement;
        if (!node || !scroller.contains(node)) continue;
        const nr = node.getBoundingClientRect();
        const sr = scroller.getBoundingClientRect();
        if (nr.right < sr.left || nr.left > sr.right) {
          shownTopLayer.delete(sub);
          try { sub.hidePopover(); } catch {}
        } else {
          placeTopLayerSubmenu(node, sub, rootEl);
        }
      }
    }, true);
    rootEl.addEventListener('focusin', (event) => {
      const node = event.target && event.target.closest ? event.target.closest('.tag-menu-node.has-children') : null;
      const sub = node ? node.querySelector(':scope > .tag-submenu[popover]') : null;
      if (sub) openTopLayer(node, sub);
    });
    rootEl.addEventListener('mouseover', (event) => {
      const target = event.target;
      if (!target || !target.closest) return;
      const node = target.closest('.tag-menu-node.has-children');
      if (!node) return;
      const sub = node.querySelector(':scope > .tag-submenu');
      if (!sub) return;
      if (sub.hasAttribute('popover')) { openTopLayer(node, sub); return; }
      // setTimeout (not rAF): rAF is throttled to a halt in background tabs.
      // Bounds: the app popup IS the OS window (viewport); the demo popup is a
      // box embedded in the marketing page, so clamp to that box instead.
      setTimeout(() => { if (sub.isConnected) fitSubmenu(node, sub, rootEl); }, 0);
    });
  }
  // Shared "action toast": the transient toast with an Undo button, reused by the
  // app and demo for delete-with-undo. Manipulates the consumer's existing
  // .toast element (theme-scoped) so there's no second toast implementation.
  // Clip mutations carry the rev they read; main refuses a stale one with a
  // "revision_conflict:<code>" error (lib/clip-revision). Electron wraps it
  // ("Error invoking remote method ...: Error: revision_conflict:..."), so
  // match the marker anywhere in the message.
  function revisionConflictCode(err) {
    const m = /revision_conflict:([a-z_]+)/.exec(String((err && err.message) || err || ''));
    return m ? m[1] : null;
  }
  function revisionTargets(ids, revOf) {
    return (Array.isArray(ids) ? ids : []).map((id) => ({ id, rev: revOf(id) }));
  }
  const REVISION_CONFLICT_MESSAGE = 'This clip changed elsewhere \u2014 refreshed';
  // Run a mutation; on a revision conflict tell the user, reload, and resolve
  // to `fallback` so the calling flow ends quietly. Other errors propagate.
  async function guardRevision(run, { toast, refresh, fallback } = {}) {
    try {
      return await run();
    } catch (err) {
      if (!revisionConflictCode(err)) throw err;
      if (toast) toast(REVISION_CONFLICT_MESSAGE);
      if (refresh) { try { await refresh(); } catch {} }
      return fallback;
    }
  }

  function showActionToast(toastEl, opts) {
    if (!toastEl) return;
    const o = opts || {};
    toastEl.innerHTML = '';
    const msg = document.createElement('span');
    msg.textContent = o.message || '';
    toastEl.appendChild(msg);
    // Hiding also drops the action button, so a hidden toast never keeps a
    // focusable (Enter would undo again) or clickable Undo around.
    const hide = () => {
      if (toastEl._actionTimer) clearTimeout(toastEl._actionTimer);
      toastEl._actionTimer = null;
      toastEl.classList.remove('show');
      toastEl.textContent = o.resetText || 'Copied';
    };
    if (o.actionLabel && typeof o.onAction === 'function') {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'btn quiet sm accent toast-action';
      btn.textContent = o.actionLabel;
      btn.addEventListener('click', () => { hide(); o.onAction(); });
      toastEl.appendChild(btn);
    }
    toastEl.classList.add('show');
    if (toastEl._actionTimer) clearTimeout(toastEl._actionTimer);
    toastEl._actionTimer = setTimeout(hide, o.timeout || 5000);
  }
  // Paint the current selection state onto an already-rendered list + drive the
  // slim selection bar. Shared by both consumers so the class names + bar markup
  // can't drift. The consumer still owns list virtualization (it loads enough
  // rows before calling this when the focus moved past the rendered batch).
  function applySelectionUI(opts) {
    const o = opts || {};
    const state = o.state || {};
    const selected = state.selectedIds instanceof Set ? state.selectedIds : new Set(state.ids || []);
    const similar = state.similarIds instanceof Set ? state.similarIds : null;
    if (o.listEl) {
      o.listEl.querySelectorAll('.item').forEach((el) => {
        const id = el.dataset.id;
        el.classList.toggle('selected', id === state.focusId);
        el.classList.toggle('multi-selected', selected.has(id));
        el.classList.toggle('actions-held', id === state.heldId);
        el.classList.toggle('similar', !!(similar && similar.has(id)));
      });
      if (state.focusId && o.scroll !== false) {
        const sel = '.item[data-id="' + String(state.focusId).replace(/["\\]/g, '\\$&') + '"]';
        const focusEl = o.listEl.querySelector(sel);
        if (focusEl) focusEl.scrollIntoView({ block: 'nearest' });
      }
    }
    if (o.barEl) {
      const active = (state.count || 0) >= 2;
      o.barEl.classList.toggle('hidden', !active);
      // Only when it changed: hover and hold repaints must not rebuild the bar
      // under a focused or pressed button.
      const html = active ? renderSelectionBar(state) : '';
      if (o.barEl._bcHtml !== html) { o.barEl.innerHTML = html; o.barEl._bcHtml = html; }
    }
  }
  // ---- Settings ---------------------------------------------------------------
  // The full settings panel body, shared verbatim by the app and the demo; each
  // fills the dynamic parts (numpad slots, groups, sync providers, peers, AI
  // clients, grants, conflicts, status lines) through the shared renderers
  // below. ONE row grid (.setting-row: label + optional one-line help | control
  // | reset column) and ONE list style (renderSettingsItem) share the three
  // columns, so every control and every row action ends on the same right edge.
  function settingAttrs(attrs) {
    let out = '';
    for (const [key, value] of Object.entries(attrs || {})) {
      if (value == null || value === false) continue;
      out += value === true ? ` ${key}` : ` ${key}="${escapeHtml(value)}"`;
    }
    return out;
  }
  // help: [[id, text, cls], ...] = one-line help / status lines under the label.
  // An empty one takes no space, so a status line costs nothing until it says
  // something.
  function settingTextHtml(o) {
    const idAttr = o.labelId ? ` id="${o.labelId}"` : '';
    const label = o.label == null ? ''
      : o.forId ? `<label class="setting-label" for="${o.forId}"${idAttr}>${o.label}</label>`
        : `<span class="setting-label"${idAttr}>${o.label}</span>`;
    const help = (o.help || []).map(([id, text, cls]) => `<span class="setting-help${cls ? ` ${cls}` : ''}"${id ? ` id="${id}"` : ''}>${text || ''}</span>`).join('');
    return `<span class="setting-text">${label}${help}</span>`;
  }
  function settingRowHtml(o) {
    return `<div class="setting-row${o.cls ? ` ${o.cls}` : ''}"${o.id ? ` id="${o.id}"` : ''}>${settingTextHtml(o)}`
      + (o.control ? `<span class="setting-control">${o.control}</span>` : '')
      + (o.reset ? `<span class="setting-reset">${o.reset}</span>` : '')
      + '</div>';
  }
  function switchRowHtml(o) {
    return `<label class="setting-row switch-row" for="${o.id}">${settingTextHtml({ ...o, forId: null })}`
      + `<input id="${o.id}" type="checkbox"><span class="switch" aria-hidden="true"></span></label>`;
  }
  function settingSegHtml(key, label, options) {
    return `<div class="seg" role="group" aria-label="${label}" data-appearance="${key}">`
      + options.map(([value, text]) => `<button type="button" class="seg-btn" data-value="${value}">${text}</button>`).join('')
      + '</div>';
  }
  function settingResetHtml(id, title) {
    return `<button class="icon-btn shortcut-reset" id="${id}" type="button" title="${title}" aria-label="${title}"><span class="mi">restart_alt</span></button>`;
  }
  // A number field carries its unit inside the control, so no label needs one.
  function settingNumberHtml(id, unit, attrs) {
    return `<span class="input-affix"><input id="${id}" type="number"${attrs || ''}><span class="affix">${unit}</span></span>`;
  }
  function settingSectionHtml(title, inner) {
    return `<section class="settings-section"><h3>${title}</h3>${inner}</section>`;
  }
  const ACCENT_CHOICES = [['system', 'System'], ['blue', 'Blue'], ['teal', 'Teal'], ['mono', 'Mono'], ['custom', 'Custom']];
  function modKeyLabel() {
    return typeof navigator !== 'undefined' && /Mac/i.test(navigator.platform || '') ? 'Cmd' : 'Ctrl';
  }
  function renderSettingsBody() {
    const mod = modKeyLabel();
    const swatches = '<div class="accent-swatches" id="accentMode" role="radiogroup" aria-label="Accent">'
      + ACCENT_CHOICES.map(([value, text]) => `<button type="button" class="accent-swatch" role="radio" aria-checked="false" data-accent-mode="${value}" title="${text}" aria-label="${text}"><span class="accent-dot"><span class="mi">check</span></span></button>`).join('')
      + '</div>';
    const theme = '<div class="seg" id="themeMode" role="group" aria-label="Theme">'
      + '<button type="button" class="seg-btn" data-theme-mode="system" title="Follow your desktop">System</button>'
      + '<button type="button" class="seg-btn" data-theme-mode="light" title="Always light">Light</button>'
      + '<button type="button" class="seg-btn" data-theme-mode="dark" title="Always dark">Dark</button></div>';
    // Sync conflicts need the user, so they sit on top (shown only when present).
    const conflicts = '<section class="settings-section hidden" id="conflictsSection"><h3>Sync conflicts</h3><div class="settings-list" id="conflictSlots"></div></section>';
    const general = settingSectionHtml('General',
      switchRowHtml({ id: 'autoLaunch', label: 'Launch on startup' })
      + settingRowHtml({ label: 'Popup shortcut', help: [['shortcutStatus']], control: '<button class="shortcut-btn" id="shortcutRecord" type="button"></button>', reset: settingResetHtml('shortcutReset', 'Reset to the default shortcut') })
      + settingRowHtml({ label: 'Quick paste shortcut', help: [['quickPasteStatus']], control: '<button class="shortcut-btn" id="quickPasteRecord" type="button"></button>', reset: settingResetHtml('quickPasteReset', 'Reset to the default shortcut') }));
    const appearance = settingSectionHtml('Appearance',
      settingRowHtml({ label: 'Theme', control: theme })
      + settingRowHtml({ label: 'Accent', help: [['accentHelp']], control: swatches })
      + settingRowHtml({ id: 'accentCustomRow', cls: 'hidden', label: 'Custom colour', forId: 'accentCustom', help: [['accentCustomHelp']],
        control: '<input id="accentHue" class="accent-hue" type="range" min="0" max="359" step="1" aria-label="Hue">'
          + '<input id="accentCustom" class="accent-hex" type="text" maxlength="9" spellcheck="false" autocomplete="off" placeholder="#rrggbb">' })
      + settingRowHtml({ label: 'Surface', help: [['surfaceHelp']], control: settingSegHtml('surface_style', 'Surface', [['auto', 'Auto'], ['glass', 'Glass'], ['solid', 'Solid']]) })
      + settingRowHtml({ id: 'glassScopeRow', cls: 'hidden', label: 'Glass on', control: settingSegHtml('glass_scope', 'Glass on', [['popup', 'Popup only'], ['all', 'All windows']]) })
      + settingRowHtml({ label: 'Density', control: settingSegHtml('ui_density', 'Density', [['normal', 'Normal'], ['compact', 'Compact']]) })
      + settingRowHtml({ label: 'Corners', control: settingSegHtml('ui_corners', 'Corners', [['soft', 'Soft'], ['sharp', 'Sharp']]) })
      + settingRowHtml({ label: 'Image preview height', forId: 'imagePreviewHeight', help: [[null, `Also ${mod}+wheel over the list`]],
        control: settingNumberHtml('imagePreviewHeight', 'px', ` min="${IMAGE_ZOOM.min}" max="${IMAGE_ZOOM.max}" step="10"`),
        reset: settingResetHtml('imagePreviewHeightReset', `Reset to ${IMAGE_ZOOM.def} px`) })
      + '<div id="appearanceVariants"></div>');
    const numpad = settingSectionHtml('Quick paste and numpad',
      switchRowHtml({ id: 'quickPasteRestore', label: 'Restore the clipboard afterwards', help: [[null, 'Puts back what you had copied before the paste']] })
      + '<div class="settings-list" id="numpadSlots"></div>'
      + settingRowHtml({ cls: 'note', help: [['numpadHelp', 'Give a clip a key from its # button or its menu']] }));
    const groups = settingSectionHtml('Groups',
      '<div class="settings-list" id="groupSlots"></div>'
      + settingRowHtml({ cls: 'note', control: '<button class="btn" id="addGroupBtn" type="button"><span class="mi sm">add</span>New group</button>' }));
    const sync = settingSectionHtml('Sync',
      settingRowHtml({ label: 'Cloud folders', help: [['syncStatus']],
        control: '<button class="icon-btn sync-btn" id="syncNow" type="button" title="Sync now" aria-label="Sync now"><span class="mi">sync</span></button>'
          + '<button class="icon-btn" id="addSyncFolder" type="button" title="Add a sync folder" aria-label="Add a sync folder"><span class="mi">create_new_folder</span></button>' })
      + '<div class="settings-list" id="syncAccounts"></div>'
      + switchRowHtml({ id: 'p2pEnabled', label: 'Local network sync', help: [['p2pStatus'], ['p2pTailnet']] })
      + '<div class="settings-list" id="p2pPeers"></div>'
      + settingRowHtml({ cls: 'stack', label: 'Pinned peers', forId: 'p2pPinned', help: [[null, 'Hosts discovery cannot see: host or host:port, comma-separated']],
        control: '<input id="p2pPinned" type="text" spellcheck="false" autocomplete="off" placeholder="mac.local, 100.64.0.2:45455">' }));
    const ai = settingSectionHtml('AI access',
      switchRowHtml({ id: 'aiAccessEnabled', label: 'Local AI assistants', help: [['aiAccessStatus']] })
      + '<div id="aiAccessBody" class="hidden">'
      + '<div class="settings-list-title">Installed in</div><div class="settings-list" id="aiClients"></div>'
      + '<div class="settings-list hidden" id="aiClientsMore"></div>'
      + '<button class="btn quiet sm settings-more hidden" id="aiMoreClients" type="button"></button>'
      + '<div class="settings-list-title hidden" id="aiAlwaysHead">Always allowed</div><div class="settings-list" id="aiAlwaysAllow"></div>'
      + settingRowHtml({ label: 'Approval timeout', forId: 'aiTimeout', help: [[null, 'An unanswered prompt is denied']], control: settingNumberHtml('aiTimeout', 's', ' min="5" max="600" step="5"') })
      + '</div>');
    const history = settingSectionHtml('History',
      settingRowHtml({ label: 'Keep clips for', forId: 'maxAge', control: settingNumberHtml('maxAge', 'days', ' min="1"') })
      + settingRowHtml({ label: 'Storage limit', forId: 'maxSize', help: [['usage']], control: settingNumberHtml('maxSize', 'GB', ' min="0.1" step="0.1"') })
      + settingRowHtml({ label: 'Clear unpinned clips', help: [[null, 'Pinned clips are kept']], control: '<button class="btn danger" id="clearAll" type="button">Clear all</button>' }));
    const diagnostics = settingSectionHtml('Diagnostics',
      switchRowHtml({ id: 'diagnosticsEnabled', label: 'Performance logging', help: [['diagnosticsStatus']] })
      + settingRowHtml({ label: 'Diagnostics report', help: [[null, 'Sync state, peers and recent events, for a bug report']], control: '<button class="btn" id="copyDiagnostics" type="button">Copy</button>' })
      + settingRowHtml({ label: 'Build', labelId: 'updateBuild', help: [['updateDetail'], ['updateStatus']], control: '<button class="btn" id="updateNow" type="button">Check now</button>' })
      + settingRowHtml({ label: 'App folder', help: [['buildInfo', '', 'mono']] }));
    return conflicts + general + appearance + numpad + groups + sync + ai + history + diagnostics;
  }
  // One settings list row (every settings list). o = { title, key (a lead
  // token, e.g. '#3'), meta (dim, after the title), sub (second line), subMono,
  // titleMono, dim, cls, attrs, toggle: { checked, disabled, label, cls, attrs }
  // (a switch in the control column), controlHtml, actionHtml (the reset /
  // remove column) }. Text is escaped here; *Html parts are trusted markup.
  function settingSwitchHtml(t) {
    const label = escapeHtml(t.label || '');
    return `<label class="switch-wrap${t.disabled ? ' is-disabled' : ''}" title="${label}"><input type="checkbox"${t.cls ? ` class="${escapeHtml(t.cls)}"` : ''} aria-label="${label}"`
      + `${t.checked ? ' checked' : ''}${t.disabled ? ' disabled' : ''}${settingAttrs(t.attrs)}><span class="switch" aria-hidden="true"></span></label>`;
  }
  function renderSettingsItem(o) {
    const opt = o || {};
    const title = '<span class="si-title">'
      + (opt.key ? `<span class="si-key">${escapeHtml(opt.key)}</span>` : '')
      + `<span class="si-name${opt.titleMono ? ' mono' : ''}" title="${escapeHtml(opt.title)}">${escapeHtml(opt.title)}</span>`
      + (opt.meta ? `<span class="si-meta">${escapeHtml(opt.meta)}</span>` : '')
      + '</span>';
    const sub = opt.sub ? `<span class="si-sub${opt.subMono ? ' mono' : ''}" title="${escapeHtml(opt.sub)}">${escapeHtml(opt.sub)}</span>` : '';
    const control = opt.toggle ? settingSwitchHtml(opt.toggle) : (opt.controlHtml || '');
    return `<div class="settings-item${opt.dim ? ' dim' : ''}${opt.cls ? ` ${opt.cls}` : ''}"${settingAttrs(opt.attrs)}>`
      + `<span class="si-text">${title}${sub}</span>`
      + (control ? `<span class="si-control">${control}</span>` : '')
      + (opt.actionHtml ? `<span class="si-action">${opt.actionHtml}</span>` : '')
      + '</div>';
  }
  // The ASSIGNED numpad slots (nmap: { n: clipId }, itemOf: id -> clip): a
  // click copies the clip, the x removes the key (the controller's settings
  // dispatch: .np-slot.has-content / .np-remove).
  function renderNumpadSlotRows(nmap, itemOf) {
    let html = '';
    for (let n = 1; n <= 9; n++) {
      const id = nmap && nmap[n];
      if (id == null) continue;
      const it = typeof itemOf === 'function' ? itemOf(id) : null;
      // The clip's primary line, as its row shows it (title, else first text).
      const named = it ? titleOf(it) : '';
      const text = !it ? 'Missing clip' : it.type === 'image' ? (named || 'Image') : (named || String(it.text || '').replace(/\s+/g, ' ').trim().slice(0, 120));
      html += renderSettingsItem({
        key: `#${n}`, title: text,
        cls: 'np-slot has-content clickable', attrs: { 'data-slot-id': id, title: 'Click to copy' },
        actionHtml: `<button class="icon-btn np-remove" type="button" data-slot="${n}" title="Remove key ${n}" aria-label="Remove key ${n}"><span class="mi">close</span></button>`,
      });
    }
    return html;
  }
  // Groups: name, clip count, the AI-sharing switch (.gp-share) and delete
  // (.gp-del), both handled by the controller's settings dispatch. o = { counts
  // (Map | object), shared (Set of shared names), aiGroup (always shared, never
  // deleted) }.
  function renderGroupRows(groups, o) {
    const opt = o || {};
    const countOf = (g) => Number(opt.counts instanceof Map ? opt.counts.get(g) : (opt.counts || {})[g]) || 0;
    const shared = opt.shared instanceof Set ? opt.shared : new Set(opt.shared || []);
    // The switch column says what it is, right above the switches (the rows'
    // own grid, so the label ends on the switches' edge).
    const head = (groups || []).length
      ? '<div class="settings-list-title settings-list-cols" aria-hidden="true" title="AI assistants can read the clips in a shared group"><span class="si-text"></span><span class="si-control">Shared with AI</span><span class="si-action"></span></div>'
      : '';
    return head + (groups || []).map((g) => {
      const count = countOf(g);
      const isAi = g === opt.aiGroup;
      return renderSettingsItem({
        title: g, meta: `${count} clip${count === 1 ? '' : 's'}`, cls: 'group-row',
        toggle: { checked: isAi || shared.has(g), disabled: isAi, cls: 'gp-share', label: isAi ? 'The AI group is always shared with AI' : `Share ${g} with AI`, attrs: { 'data-group': g } },
        actionHtml: isAi ? '' : `<button class="icon-btn gp-del" type="button" data-group="${escapeHtml(g)}" title="Delete group" aria-label="Delete group ${escapeHtml(g)}"><span class="mi">close</span></button>`,
      });
    }).join('');
  }
  // A row's help / status line. state: '' | 'active' (a green status dot) | 'error'.
  function setSettingHelp(el, text, state) {
    if (!el) return;
    el.textContent = text || '';
    el.classList.toggle('active', state === 'active');
    el.classList.toggle('error', state === 'error');
  }
  // Binds the settings view once per consumer: the Appearance controls and the
  // body's scroll fade. adapter.save(body) writes settings (the app:
  // save-settings, which validates and answers with appearance-changed; the
  // demo: its local store); adapter.preview(look) paints a hue being dragged in
  // this window only, until the release saves it. update(state) repaints from
  // { accentMode, accentCustom, systemAccent, surfaceStyle (the SETTING:
  // auto | glass | solid), glassSupported, glassScope, uiDensity, uiCorners }.
  // A native colour dialog is no option: it takes focus from the popup, which
  // hides on blur, so Custom is a hue slider plus a #rrggbb field.
  const APPEARANCE_SEGS = { surface_style: ['surfaceStyle', 'auto'], glass_scope: ['glassScope', 'popup'], ui_density: ['uiDensity', 'normal'], ui_corners: ['uiCorners', 'soft'] };
  const ACCENT_FALLBACK = '#3b82f6'; // --blue-500: what System paints where no OS accent is known
  const HUE_SL = [0.72, 0.52];
  // Why the painted accent can differ from the colour picked (accentShades).
  function shadeNote(color) {
    const s = accentShades(color);
    if (!s) return '';
    const hex = normalizeHexColor(color);
    const lighter = s.dark.accent !== hex;
    const darker = s.light.accent !== hex;
    return lighter && darker ? ', adjusted in both themes so it reads'
      : lighter ? ', lighter in the dark theme so it reads'
        : darker ? ', darker in the light theme so it reads' : '';
  }
  function mountSettings(viewEl, adapter) {
    const a = adapter || {};
    if (!viewEl || !viewEl.querySelector) return { update() {} };
    const body = viewEl.querySelector('.settings-body');
    if (body) attachScrollFade(body, 'panel');
    const $ = (sel) => viewEl.querySelector(sel);
    const hue = $('#accentHue');
    const hex = $('#accentCustom');
    const state = {};
    const save = (b) => { if (typeof a.save === 'function') a.save(b); };
    const focused = (el) => typeof document !== 'undefined' && document.activeElement === el;
    if (hue) hue.style.background = `linear-gradient(to right, ${Array.from({ length: 13 }, (_, i) => hslHex((i * 30) % 360, HUE_SL[0], HUE_SL[1])).join(', ')})`;
    // A System / Custom swatch previews its colour as each theme paints it
    // (the CSS picks --dot-dark or --dot-light); no colour = the CSS default.
    function setDot(mode, color) {
      const btn = viewEl.querySelector(`.accent-swatch[data-accent-mode="${mode}"]`);
      if (!btn) return;
      const s = accentShades(color);
      if (s) {
        btn.style.setProperty('--dot-dark', s.dark.accent);
        btn.style.setProperty('--dot-light', s.light.accent);
        btn.dataset.own = '';
      } else {
        btn.style.removeProperty('--dot-dark');
        btn.style.removeProperty('--dot-light');
        delete btn.dataset.own;
      }
    }
    function paint() {
      const mode = ACCENT_CHOICES.some(([v]) => v === state.accentMode) ? state.accentMode : 'system';
      const custom = normalizeHexColor(state.accentCustom);
      const system = normalizeHexColor(state.systemAccent);
      viewEl.querySelectorAll('[data-accent-mode]').forEach((btn) => btn.setAttribute('aria-checked', btn.dataset.accentMode === mode ? 'true' : 'false'));
      // Every dot shows the colour its choice paints (the chosen one = the live accent).
      setDot('system', system);
      setDot('custom', custom);
      const help = $('#accentHelp');
      if (help) help.textContent = mode === 'system' ? (system ? `Your system colour, ${system}${shadeNote(system)}` : 'No system colour here, so Blue') : '';
      const customHelp = $('#accentCustomHelp');
      if (customHelp && !customHelp.classList.contains('error')) customHelp.textContent = custom ? shadeNote(custom).replace(/^, /, '').replace(/^./, (ch) => ch.toUpperCase()) : '';
      const customRow = $('#accentCustomRow');
      if (customRow) customRow.classList.toggle('hidden', mode !== 'custom');
      if (hex && !focused(hex)) hex.value = custom || '';
      if (hue && !focused(hue)) hue.value = String(Math.round(hexHsl(custom || system || ACCENT_FALLBACK)[0]));
      for (const [key, [field, def]] of Object.entries(APPEARANCE_SEGS)) {
        const seg = viewEl.querySelector(`.seg[data-appearance="${key}"]`);
        if (seg) setActiveVariantSeg(seg, state[field] || def);
      }
      const supported = state.glassSupported !== false;
      const scopeRow = $('#glassScopeRow');
      if (scopeRow) scopeRow.classList.toggle('hidden', !supported || (state.surfaceStyle || 'auto') === 'solid');
      const surfaceHelp = $('#surfaceHelp');
      if (surfaceHelp) surfaceHelp.textContent = supported ? '' : 'Glass needs Windows 11 or macOS, so Solid here';
    }
    viewEl.addEventListener('click', (e) => {
      const t = e.target;
      if (!t || !t.closest) return;
      const swatch = t.closest('[data-accent-mode]');
      if (swatch) {
        const mode = swatch.dataset.accentMode;
        const b = { accent_mode: mode };
        // Custom without a colour yet starts from the colour on screen.
        if (mode === 'custom' && !normalizeHexColor(state.accentCustom)) {
          b.accent_custom = normalizeHexColor(state.systemAccent) || ACCENT_FALLBACK;
          state.accentCustom = b.accent_custom;
        }
        state.accentMode = mode;
        setSettingHelp($('#accentCustomHelp'), '');
        paint();
        save(b);
        return;
      }
      const btn = t.closest('.seg[data-appearance] [data-value]');
      const spec = btn && APPEARANCE_SEGS[btn.closest('.seg').dataset.appearance];
      if (!spec) return;
      state[spec[0]] = btn.dataset.value;
      paint();
      save({ [btn.closest('.seg').dataset.appearance]: btn.dataset.value });
    });
    // The hue slider keeps the colour's own saturation + lightness (a vivid
    // default for a near-grey one), previews while dragging, saves on release.
    let dragSL = null;
    if (hue) {
      hue.addEventListener('input', () => {
        if (!dragSL) {
          const [, s, l] = hexHsl(normalizeHexColor(state.accentCustom) || ACCENT_FALLBACK);
          dragSL = s >= 0.25 ? [s, l] : HUE_SL;
        }
        state.accentCustom = hslHex(Number(hue.value) || 0, dragSL[0], dragSL[1]);
        paint();
        if (typeof a.preview === 'function') a.preview({ accentColor: state.accentCustom });
      });
      hue.addEventListener('change', () => {
        dragSL = null;
        const c = normalizeHexColor(state.accentCustom);
        if (c) save({ accent_mode: 'custom', accent_custom: c });
      });
    }
    const commitHex = () => {
      const c = normalizeHexColor(hex.value);
      const err = $('#accentCustomHelp');
      if (!c) { setSettingHelp(err, 'Use a colour like #e8590c', 'error'); return; }
      setSettingHelp(err, '');
      hex.value = c;
      state.accentCustom = c;
      state.accentMode = 'custom';
      paint();
      save({ accent_mode: 'custom', accent_custom: c });
    };
    if (hex) {
      hex.addEventListener('change', commitHex);
      hex.addEventListener('keydown', (e) => {
        if (e.key !== 'Enter') return;
        e.preventDefault();
        e.stopPropagation();
        commitHex();
      });
    }
    return {
      update(next) { Object.assign(state, next || {}); paint(); },
      get: () => ({ ...state }),
    };
  }
  // Theme: shared by the app (sets data-theme on <html>) and the demo (sets it
  // on the .bc-popup window). mode is 'system' | 'light' | 'dark'.
  function resolveTheme(mode, systemDark) {
    if (mode === 'light' || mode === 'dark') return mode;
    return systemDark ? 'dark' : 'light';
  }
  function applyTheme(rootEl, mode, systemDark) {
    const theme = resolveTheme(mode, systemDark);
    if (rootEl && rootEl.setAttribute) rootEl.setAttribute('data-theme', theme);
    return theme;
  }
  function setActiveThemeSeg(containerEl, mode) {
    if (!containerEl || !containerEl.querySelectorAll) return;
    const active = mode === 'light' || mode === 'dark' ? mode : 'system';
    containerEl.querySelectorAll('[data-theme-mode]').forEach((btn) => {
      btn.classList.toggle('active', btn.dataset.themeMode === active);
    });
  }
  // Appearance variants: sibling data-* attributes to data-theme that swap token
  // values (see clipboard-tokens.css). ONE applier for app/editor/modal/demo so
  // every surface renders identically. Defaults are omitted to keep the DOM clean.
  const VARIANT_AXES = [
    { key: 'surfaceStyle', attr: 'data-surface', label: 'Surface', def: 'auto', options: [['auto', 'Auto'], ['glass', 'Glass'], ['solid', 'Solid']] },
    { key: 'accentVariant', attr: 'data-accent', label: 'Accent', def: 'blue', options: [['blue', 'Blue'], ['teal', 'Teal'], ['mono', 'Mono']] },
    { key: 'uiDensity', attr: 'data-density', label: 'Density', def: 'normal', options: [['normal', 'Normal'], ['compact', 'Compact']] },
    { key: 'uiCorners', attr: 'data-corners', label: 'Corners', def: 'soft', options: [['soft', 'Soft'], ['sharp', 'Sharp']] },
    { key: 'uiBorders', attr: 'data-borders', label: 'Borders', def: 'bordered', options: [['bordered', 'Lines'], ['borderless', 'None']] },
  ];
  function applyVariants(rootEl, opts) {
    if (!rootEl || !rootEl.setAttribute) return;
    const o = opts || {};
    // surface is always explicit (glass|solid) so the shell scrim + [data-surface]
    // rules have something to key on; 'auto' resolves to glass for in-page preview
    // (the app corrects it from main's resolved value via onSurfaceChanged).
    if (o.surfaceStyle) rootEl.setAttribute('data-surface', o.surfaceStyle === 'solid' ? 'solid' : 'glass');
    const setOrClear = (attr, value, def) => {
      if (value && value !== def) rootEl.setAttribute(attr, value);
      else rootEl.removeAttribute(attr);
    };
    setOrClear('data-accent', o.accentVariant, 'blue');
    setOrClear('data-density', o.uiDensity, 'normal');
    setOrClear('data-corners', o.uiCorners, 'soft');
    setOrClear('data-borders', o.uiBorders, 'bordered');
    // Glass scope: only the demo reads it (its editor overlay stands in for the
    // app's editor window, solid unless 'all'); main resolves the app's windows.
    setOrClear('data-glass-scope', o.glassScope, 'popup');
  }
  // ---- Accent colour: System / Custom -------------------------------------
  // A System or Custom accent can be any colour, so the applier derives what
  // the presets get by hand in clipboard-tokens.css: per theme, the colour
  // itself where it reads, else the nearest shade that does. WCAG: the accent
  // reaches 3:1 against the theme's surfaces (check glyphs, the focus ring, a
  // switch: non-text contrast), and the ink on an accent fill (a selected seg,
  // a primary button) reaches 4.5:1, the ink being whichever of the two theme
  // inks contrasts more. A colour that misses either is mixed toward white
  // (dark theme) or black (light theme) until both hold; pure white / black
  // pass both, so it always ends. A light yellow (#ffb900) keeps its colour in
  // dark and darkens in light; a dark navy keeps it in light, lightens in dark.
  // Accent used AS TEXT (an active chip, the current numpad key, Accept, a
  // zoom step, the clipboard status, link-like buttons) is --accent-text: the
  // same walk continued until it reaches 4.5:1 against the surface AND against
  // the --accent-bg tint (tint = the share of the accent in that wash).
  const ACCENT_THEMES = {
    dark: { surface: '#1b1f24', away: '#ffffff', tint: 0.16 },  // --g-800: the lightest dark surface an accent sits on
    light: { surface: '#f4f5f7', away: '#000000', tint: 0.12 }, // --g-050: the darkest light one
  };
  const ACCENT_INKS = ['#0b0d10', '#ffffff']; // --g-950, --white
  // '#rgb' | '#rrggbb' | '#rrggbbaa', '#' optional -> '#rrggbb' (alpha dropped), else null.
  function normalizeHexColor(value) {
    const m = /^#?([0-9a-f]{3}|[0-9a-f]{6}|[0-9a-f]{8})$/i.exec(String(value == null ? '' : value).trim());
    if (!m) return null;
    let hex = m[1].toLowerCase();
    if (hex.length === 3) hex = hex.split('').map((c) => c + c).join('');
    return `#${hex.slice(0, 6)}`;
  }
  function hexRgb(hex) {
    const n = parseInt(hex.slice(1), 16);
    return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
  }
  function rgbHex(rgb) {
    return `#${rgb.map((c) => Math.round(Math.min(255, Math.max(0, c))).toString(16).padStart(2, '0')).join('')}`;
  }
  function relativeLuminance(color) {
    const hex = normalizeHexColor(color);
    if (!hex) return 0;
    const [r, g, b] = hexRgb(hex).map((c) => {
      const s = c / 255;
      return s <= 0.04045 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
    });
    return 0.2126 * r + 0.7152 * g + 0.0722 * b;
  }
  // WCAG 2 contrast ratio of two colours (1 .. 21).
  function contrastRatio(a, b) {
    const la = relativeLuminance(a);
    const lb = relativeLuminance(b);
    return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
  }
  function mixHex(a, b, t) {
    const x = hexRgb(a);
    const y = hexRgb(b);
    return rgbHex(x.map((c, i) => c + (y[i] - c) * t));
  }
  function accentInk(hex) {
    return contrastRatio(hex, ACCENT_INKS[0]) >= contrastRatio(hex, ACCENT_INKS[1]) ? ACCENT_INKS[0] : ACCENT_INKS[1];
  }
  // The accent as text: the fill's colour walked further toward `away` until it
  // reads at 4.5:1 on the surface and on the fill's own tint over it.
  function accentTextShade(accent, theme) {
    const t = ACCENT_THEMES[theme];
    const tint = mixHex(t.surface, accent, t.tint);
    for (let step = 0; step <= 50; step++) {
      const text = step ? mixHex(accent, t.away, step / 50) : accent;
      if (contrastRatio(text, t.surface) >= 4.5 && contrastRatio(text, tint) >= 4.5) return text;
    }
    return t.away;
  }
  function accentShade(hex, theme) {
    const t = ACCENT_THEMES[theme];
    let shade = { accent: t.away, ink: accentInk(t.away) };
    for (let step = 0; step <= 50; step++) {
      const accent = step ? mixHex(hex, t.away, step / 50) : hex;
      const ink = accentInk(accent);
      if (contrastRatio(accent, t.surface) >= 3 && contrastRatio(accent, ink) >= 4.5) { shade = { accent, ink }; break; }
    }
    return { ...shade, text: accentTextShade(shade.accent, theme) };
  }
  // -> { dark: { accent, ink, text }, light: { accent, ink, text } }, or null for no colour.
  function accentShades(color) {
    const hex = normalizeHexColor(color);
    return hex ? { dark: accentShade(hex, 'dark'), light: accentShade(hex, 'light') } : null;
  }
  // Hue <-> colour for the Custom accent's hue slider.
  function hexHsl(color) {
    const [r, g, b] = hexRgb(normalizeHexColor(color) || '#000000').map((c) => c / 255);
    const max = Math.max(r, g, b);
    const min = Math.min(r, g, b);
    const l = (max + min) / 2;
    const d = max - min;
    if (!d) return [0, 0, l];
    const s = d / (1 - Math.abs(2 * l - 1));
    const h = max === r ? ((g - b) / d) % 6 : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
    return [(h * 60 + 360) % 360, s, l];
  }
  function hslHex(h, s, l) {
    const c = (1 - Math.abs(2 * l - 1)) * s;
    const x = c * (1 - Math.abs(((h / 60) % 2) - 1));
    const m = l - c / 2;
    const [r, g, b] = h < 60 ? [c, x, 0] : h < 120 ? [x, c, 0] : h < 180 ? [0, c, x] : h < 240 ? [0, x, c] : h < 300 ? [x, 0, c] : [c, 0, x];
    return rgbHex([r, g, b].map((v) => (v + m) * 255));
  }
  const ACCENT_VARS = ['--accent-custom-dark', '--accent-ink-dark', '--accent-text-dark', '--accent-custom-light', '--accent-ink-light', '--accent-text-light'];
  // THE appearance applier of every window (popup, editor, viewer, unify /
  // conflict, approval) and the demo: main's payload (appearanceVariantPayload
  // plus the window's surfaceStyle) -> the data-* variant attributes, and a
  // System / Custom accent colour as data-accent="custom" + one shade and ink
  // per theme (clipboard-tokens.css picks the theme's pair, so a theme flip
  // needs no script). Pass the whole payload: an axis left out is reset.
  function applyAppearance(rootEl, look) {
    if (!rootEl || !rootEl.setAttribute) return null;
    const o = look || {};
    applyVariants(rootEl, o);
    const shades = accentShades(o.accentColor);
    const style = rootEl.style;
    if (shades) {
      rootEl.setAttribute('data-accent', 'custom');
      if (style) {
        style.setProperty('--accent-custom-dark', shades.dark.accent);
        style.setProperty('--accent-ink-dark', shades.dark.ink);
        style.setProperty('--accent-text-dark', shades.dark.text);
        style.setProperty('--accent-custom-light', shades.light.accent);
        style.setProperty('--accent-ink-light', shades.light.ink);
        style.setProperty('--accent-text-light', shades.light.text);
      }
    } else if (style) {
      for (const name of ACCENT_VARS) style.removeProperty(name);
    }
    return shades;
  }
  function setActiveVariantSeg(seg, value) {
    if (!seg || !seg.querySelectorAll) return;
    seg.querySelectorAll('[data-value]').forEach((btn) => {
      btn.classList.toggle('active', btn.dataset.value === value);
    });
  }
  // A live playground of segmented controls, one row per axis. Reuses the shared
  // .seg/.seg-btn styling. The app renders it dev-gated (plus Surface as a real
  // setting); the demo renders it always-on. `fields` picks which axes appear;
  // `options` ({ axisKey: [[value, label], ...] }) replaces an axis's choices
  // (the app's accent row picks the accent MODE, System included).
  function createVariantSwitcher(config) {
    if (typeof document === 'undefined') return { el: null, set() {}, get: () => ({}) };
    const cfg = config || {};
    const fields = cfg.fields && cfg.fields.length ? cfg.fields : VARIANT_AXES.map((a) => a.key);
    const axes = VARIANT_AXES.filter((a) => fields.includes(a.key));
    const state = { ...(cfg.initial || {}) };
    const root = cfg.root || null;
    const el = document.createElement('div');
    el.className = 'variant-switcher';
    const segRefs = {};
    for (const axis of axes) {
      const row = document.createElement('div');
      row.className = 'setting-row';
      const label = document.createElement('label');
      label.textContent = axis.label;
      const seg = document.createElement('div');
      seg.className = 'seg';
      seg.setAttribute('role', 'group');
      seg.setAttribute('aria-label', axis.label);
      for (const [val, text] of (cfg.options && cfg.options[axis.key]) || axis.options) {
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'seg-btn';
        btn.dataset.value = val;
        btn.textContent = text;
        btn.addEventListener('click', () => {
          state[axis.key] = val;
          setActiveVariantSeg(seg, val);
          if (root) applyVariants(root, state);
          if (typeof cfg.onChange === 'function') cfg.onChange({ ...state }, axis.key, val);
        });
        seg.appendChild(btn);
      }
      row.append(label, seg);
      el.appendChild(row);
      segRefs[axis.key] = seg;
      setActiveVariantSeg(seg, state[axis.key] || axis.def);
    }
    return {
      el,
      set(next) {
        Object.assign(state, next || {});
        for (const axis of axes) setActiveVariantSeg(segRefs[axis.key], state[axis.key] || axis.def);
        if (root) applyVariants(root, state);
      },
      get() { return { ...state }; },
    };
  }
  // Shared confirm/prompt dialogs — ONE implementation for the app and the demo
  // so a confirm flow (group delete, numpad replace, clear all, add-group name)
  // can never drift between them. Creates its own DOM in `host`; Promise-based;
  // Escape + backdrop dismiss; capture-phase keys so they beat global nav.
  function createDialogs(host) {
    if (typeof document === 'undefined') {
      return { confirm: () => Promise.resolve(false), prompt: () => Promise.resolve(null), isOpen: () => false, dismiss: () => {} };
    }
    trackInputModality();
    const root = host || document.body;
    const make = (inner) => {
      const overlay = document.createElement('div');
      overlay.className = 'overlay';
      overlay.innerHTML = inner;
      root.appendChild(overlay);
      return overlay;
    };
    // Buttons are the shared .btn set: Cancel is the default button, the
    // confirm is .primary, or .danger when the caller passes {danger:true}.
    const confirmEl = make('<div class="dialog"><h3 data-x="title"></h3><p data-x="msg"></p><div class="dialog-preview" data-x="preview"></div><div class="dialog-btns"><button type="button" class="btn" data-x="no"></button><button type="button" class="btn primary" data-x="yes"></button></div></div>');
    const promptEl = make('<div class="dialog"><h3 data-x="title"></h3><input class="prompt-input" type="text" autocomplete="off" spellcheck="false" data-x="input"><div class="dialog-btns"><button type="button" class="btn" data-x="no"></button><button type="button" class="btn primary" data-x="yes"></button></div></div>');
    const q = (parent, name) => parent.querySelector(`[data-x="${name}"]`);
    let activeCancel = null;
    // Keys: Esc cancels. Enter confirms a non-destructive dialog; a destructive
    // one ({danger}) never confirms on a bare Enter: it opens with Cancel
    // focused, so Enter (or Space) acts on whichever button has focus and the
    // red button needs a click or a deliberate Tab to it. Focus moves into the
    // dialog (the field, else the default button) and goes back on close when
    // it came from a field or the keyboard.
    function run(overlay, setup, getValue, focusEl, danger) {
      return new Promise((resolve) => {
        setup();
        overlay.classList.add('show');
        const yesBtn = q(overlay, 'yes');
        const noBtn = q(overlay, 'no');
        let back = null;
        const finish = (value) => {
          const restore = back && back.isConnected && overlay.contains(document.activeElement);
          overlay.classList.remove('show');
          yesBtn.removeEventListener('click', onYes);
          noBtn.removeEventListener('click', onNo);
          overlay.removeEventListener('click', onBackdrop);
          document.removeEventListener('keydown', onKey, true);
          activeCancel = null;
          if (restore) back.focus({ preventScroll: true });
          resolve(value);
        };
        const onYes = () => finish(getValue());
        const onNo = () => finish(getValue(true));
        const onBackdrop = (e) => { if (e.target === overlay) onNo(); };
        const onKey = (e) => {
          if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); onNo(); return; }
          if (e.key !== 'Enter') return;
          e.stopPropagation();
          // A focused dialog button answers Enter natively (its own click).
          if (e.target === yesBtn || e.target === noBtn) return;
          e.preventDefault();
          if (!danger) onYes();
        };
        // After the opening click settles (a closing menu hands focus back to
        // its opener first): remember where focus was, then take it.
        setTimeout(() => {
          if (!overlay.classList.contains('show')) return;
          const prev = document.activeElement;
          const typing = prev && (/^(INPUT|TEXTAREA)$/.test(prev.tagName) || prev.isContentEditable);
          back = prev && prev !== document.body && !overlay.contains(prev) && (typing || lastInputWasKey) ? prev : null;
          if (focusEl) focusEl.focus({ preventScroll: true });
        }, 0);
        yesBtn.addEventListener('click', onYes);
        noBtn.addEventListener('click', onNo);
        overlay.addEventListener('click', onBackdrop);
        document.addEventListener('keydown', onKey, true);
        activeCancel = onNo;
      });
    }
    // opts: { title, message (sans body copy), preview (clip text, shown in a
    // mono block), okLabel, cancelLabel, danger (destructive: red confirm) }.
    function confirm(opts) {
      const o = opts || {};
      return run(confirmEl, () => {
        q(confirmEl, 'title').textContent = o.title || '';
        q(confirmEl, 'msg').textContent = o.message || '';
        q(confirmEl, 'preview').textContent = o.preview || '';
        const yes = q(confirmEl, 'yes');
        yes.textContent = o.okLabel || 'OK';
        yes.classList.toggle('danger', !!o.danger);
        yes.classList.toggle('primary', !o.danger);
        q(confirmEl, 'no').textContent = o.cancelLabel || 'Cancel';
      }, (cancelled) => !cancelled, q(confirmEl, o.danger ? 'no' : 'yes'), !!o.danger);
    }
    function prompt(opts) {
      const o = typeof opts === 'string' ? { title: opts } : (opts || {});
      const input = q(promptEl, 'input');
      const result = run(promptEl, () => {
        q(promptEl, 'title').textContent = o.title || '';
        input.value = o.value || '';
        q(promptEl, 'yes').textContent = o.okLabel || 'OK';
        q(promptEl, 'no').textContent = o.cancelLabel || 'Cancel';
      }, (cancelled) => cancelled ? null : (input.value.trim() || null), input, false);
      return result;
    }
    return {
      confirm,
      prompt,
      isOpen: () => confirmEl.classList.contains('show') || promptEl.classList.contains('show'),
      dismiss: () => { if (activeCancel) activeCancel(); },
    };
  }
  // Shared interaction controller. ONE dispatch table + confirm/prompt-gated
  // flows for the popup, driven by a backend `adapter`. The desktop app supplies
  // an adapter backed by window.api; the website demo supplies one backed by the
  // in-memory Core mutators + browser APIs. This is what stops the click handlers
  // from drifting (e.g. a confirm dialog present in one popup but not the other).
  //
  // Adapter contract (backend ops may return a Promise; the controller awaits,
  // then re-renders via render() for view-only changes or refresh() after a
  // data mutation):
  //   data:    itemById(id), numpadMap(), protectedGroups()
  //   dialogs: dialogs ({confirm,prompt}) OR dialogHost (an element to mount into)
  //   filter:  setFilterIntent(filter,intent) [controller renders], clearFilters()
  //            [self-renders — also called directly by the search-clear button],
  //            focusSearch()
  //   mutate:  pin(id), numpadAssign(id,slot), numpadUnassign(slot),
  //            toggleGroup(id,group) [add-or-remove], createGroup(name),
  //            deleteGroup(group), deleteClip(id), clearUnpinned(),
  //            setGroupSharedAi(group), copyNumpadSlot(id)
  //   actions: activateClip(id), editClip(id,itemEl), openImage(item),
  //            saveImage(item)->feedbackString|null
  //   keyboard:isSettingsOpen(), closeSettings(), hidePopup(),
  //            moveSelection(dir), activateSelected()
  //   ui:      render() [cheap re-render of current data — view-only changes like
  //            expand/filter], refresh() [re-fetch + re-render after a data
  //            mutation; falls back to render() if absent], toast(msg),
  //            deletedToast (string|null)
  // ---- Keep-your-place clip list (app popup + demo) --------------------------
  //
  // resolveListAnchor is the PURE policy for where a rebuilt list sits. It runs
  // on every rebuild (typing, clearing, a sort flip, a background refresh):
  //   ids      - the new visible ids, in display order
  //   tsAt(i)  - capture time of ids[i] (for "nearest clip in time")
  //   anchor   - { id, offset, ts, atTop, isCursor } from the old list, or null:
  //              the cursor row if it was on screen, else the top visible row;
  //              atTop = unscrolled with no on-screen cursor
  //   prevMode / nextMode - Search.rankMode of the old / new list
  //   cleared  - the query went to empty (clear X, select-all + delete, last chip)
  // Returns { index, offset, reason }; index -1 = the top of the list.
  function resolveListAnchor(opts) {
    const o = opts || {};
    const ids = o.ids || [];
    const top = (reason) => ({ index: -1, offset: 0, reason });
    if (!ids.length) return top('empty');
    const nextMode = o.nextMode || 'none';
    const prevMode = o.prevMode || nextMode;
    // Starting a search (or flipping to Best match) begins at the best match.
    if (nextMode === 'best' && prevMode !== 'best') return top('search-start');
    const anchor = o.anchor;
    if (!anchor || anchor.id == null) return top('no-anchor');
    // Leaving a search shows the clip you were on among what you copied around
    // then, even if you never scrolled; otherwise an unscrolled list stays at
    // the top (so new clips and the best match show).
    const leaving = !!o.cleared || (prevMode === 'best' && nextMode === 'none');
    if (anchor.atTop && !leaving) return top('at-top');
    const offset = Number(anchor.offset) || 0;
    const kept = ids.indexOf(anchor.id);
    if (kept >= 0) return { index: kept, offset, reason: 'kept' };
    // The clip dropped out. A ranked list has no "nearby": go to the top. A
    // time-ordered list goes to the clip copied closest in time.
    if (nextMode === 'best' || typeof o.tsAt !== 'function' || !Number.isFinite(Number(anchor.ts))) return top('dropped');
    const ts = Number(anchor.ts);
    let best = 0;
    let bestDiff = Infinity;
    for (let i = 0; i < ids.length; i += 1) {
      const diff = Math.abs((Number(o.tsAt(i)) || 0) - ts);
      if (diff < bestDiff) { bestDiff = diff; best = i; }
    }
    return { index: best, offset, reason: 'nearest' };
  }

  // createClipList: the ONE list both popups render through. It renders a
  // window of rows [start, end) around the place being kept and grows it in both
  // directions as you scroll, so keeping a clip 6,000 rows deep costs no more
  // than a normal rebuild. Every rebuild captures the anchor, resolves it with
  // resolveListAnchor and puts that row back at the same pixel offset; the
  // "Newest" pill takes you back to the top.
  //   opts: { listEl, newestEl, barEl, renderRow(index, id) -> Element|html,
  //           controller (optional, or setController later), onRendered(), batch }
  function createClipList(opts) {
    const o = opts || {};
    const listEl = o.listEl;
    const newestEl = o.newestEl || null;
    const batch = o.batch || 30;
    let controller = o.controller || null;
    let ids = [];
    let tsAt = () => 0;
    let start = 0;
    let end = 0;
    let mode = null;
    let queryKey = null;     // null = never rendered
    let emptyHtml = '';
    let newestTs = null;
    let hasNew = false;
    let lastAnchor = null;   // last anchor seen while laid out (used while hidden)
    let pendingPlace = null; // { id, offset } to apply once the list is laid out
    let snapshotTimer = null;
    const resizeHooks = [];

    const laidOut = () => !!listEl && listEl.clientHeight > 0;
    const notifyRendered = () => { if (o.onRendered) o.onRendered(); };
    // The results fade out at an edge while more is past it, like every other
    // scroller (the CSS keeps the keyboard cursor clear of the fades).
    if (listEl) attachScrollFade(listEl, 'panel');
    function toEl(row) {
      if (row && typeof row !== 'string') return row;
      const t = document.createElement('template');
      t.innerHTML = String(row || '').trim();
      return t.content.firstElementChild || document.createElement('div');
    }
    // Rows given as html are parsed in ONE pass (a parse per row cost ~5 ms of
    // every keystroke's rebuild); an element row is used as it is.
    function build(from, to) {
      const rows = [];
      let html = true;
      for (let i = from; i < to; i += 1) {
        const row = o.renderRow(i, ids[i]);
        if (row && typeof row !== 'string') html = false;
        rows.push(row);
      }
      if (html) {
        const t = document.createElement('template');
        t.innerHTML = rows.map((r) => String(r || '<div></div>').trim()).join('');
        return t.content;
      }
      const frag = document.createDocumentFragment();
      for (const row of rows) frag.appendChild(toEl(row));
      return frag;
    }
    function rowFor(id) {
      if (id == null || !listEl) return null;
      return listEl.querySelector(`:scope > [data-id="${String(id).replace(/["\\]/g, '\\$&')}"]`);
    }
    // The rendered row under client-y (first row whose bottom is below y).
    function rowAtY(y) {
      const rows = listEl.children;
      let lo = 0;
      let hi = rows.length - 1;
      let found = null;
      while (lo <= hi) {
        const mid = (lo + hi) >> 1;
        if (rows[mid].getBoundingClientRect().bottom <= y) lo = mid + 1;
        else { found = rows[mid]; hi = mid - 1; }
      }
      return found && found.dataset && found.dataset.id != null ? found : null;
    }
    // Chromium's native scroll anchoring must not adjust on top of our own exact
    // placement; it stays on for everything else (late image loads, etc.).
    function withAnchoringOff(fn) {
      const prev = listEl.style.overflowAnchor;
      listEl.style.overflowAnchor = 'none';
      try { return fn(); } finally { listEl.style.overflowAnchor = prev; }
    }
    function place(el, offset) {
      if (!el) return;
      listEl.scrollTop += (el.getBoundingClientRect().top - listEl.getBoundingClientRect().top) - offset;
    }
    function appendRows(count) {
      if (end >= ids.length) return false;
      const to = Math.min(ids.length, end + Math.max(1, count || batch));
      listEl.appendChild(build(end, to));
      end = to;
      return true;
    }
    function prependRows(count) {
      if (start <= 0) return false;
      const from = Math.max(0, start - Math.max(1, count || batch));
      const ref = listEl.firstElementChild;
      const before = ref && laidOut() ? ref.getBoundingClientRect().top : null;
      listEl.insertBefore(build(from, start), listEl.firstChild);
      start = from;
      if (ref && before != null) {
        const delta = ref.getBoundingClientRect().top - before;
        if (Math.abs(delta) > 0.5) listEl.scrollTop += delta;
      }
      return true;
    }
    // Keep a screenful of rows rendered below AND above the viewport, so the
    // scrollbar never bottoms out on a partial window (wheeling up at
    // scrollTop 0 fires no scroll event to load more).
    // Rows are added in steps sized from the rows' measured height (rowH), so
    // a rebuild renders about two screenfuls, not a fixed batch: every row a
    // keystroke builds is parsed, styled and laid out, and a 30-row batch was
    // twice what a popup shows (measured: ~halves the rebuild).
    let rowH = 0;   // average row height at the last fill (0 = not measured yet)
    let lastH = 0;  // the list's height at the last fill
    const rowsFor = (px) => (rowH > 0 ? Math.min(batch, Math.max(4, Math.ceil(px / rowH) + 2)) : batch);
    function fill() {
      if (!laidOut() || !ids.length) return;
      const h = listEl.clientHeight;
      lastH = h;
      if (end > start) rowH = listEl.scrollHeight / (end - start);
      let guard = 0;
      while (end < ids.length && listEl.scrollHeight - listEl.scrollTop - h < h && guard++ < 100) appendRows(rowsFor(2 * h - (listEl.scrollHeight - listEl.scrollTop)));
      while (start > 0 && listEl.scrollTop < h && guard++ < 200) prependRows(rowsFor(h - listEl.scrollTop));
    }
    function anchorOf(el, offset, isCursor) {
      const id = el.dataset.id;
      const index = ids.indexOf(id);
      return { id, offset, ts: index >= 0 ? tsAt(index) : null, isCursor, atTop: false };
    }
    function capture() {
      if (!ids.length) return null;
      if (!laidOut()) return lastAnchor;
      const listTop = listEl.getBoundingClientRect().top;
      const listBottom = listTop + listEl.clientHeight;
      const cursorId = controller && controller.focusedId ? controller.focusedId() : null;
      const cursorEl = rowFor(cursorId);
      if (cursorEl) {
        const r = cursorEl.getBoundingClientRect();
        if (r.bottom > listTop + 1 && r.top < listBottom - 1) return anchorOf(cursorEl, r.top - listTop, true);
      }
      const el = rowAtY(listTop + 1);
      if (!el) return null;
      const anchor = anchorOf(el, el.getBoundingClientRect().top - listTop, false);
      anchor.atTop = start === 0 && listEl.scrollTop <= 1;
      return anchor;
    }
    function renderAt(index, offset) {
      withAnchoringOff(() => {
        listEl.textContent = '';
        pendingPlace = null;
        if (!ids.length) {
          start = 0; end = 0;
          const empty = typeof emptyHtml === 'function' ? emptyHtml() : emptyHtml;
          if (empty) listEl.innerHTML = empty;
          listEl.scrollTop = 0;
          return;
        }
        if (index < 0 || index >= ids.length) {
          start = 0; end = 0;
          appendRows(rowsFor(2 * lastH));
          listEl.scrollTop = 0;
          fill();
          return;
        }
        start = Math.max(0, index - rowsFor(1.5 * lastH));
        end = start;
        appendRows(Math.min(ids.length, index + rowsFor(2 * lastH)) - start);
        const el = listEl.children[index - start];
        if (!laidOut()) { pendingPlace = { id: ids[index], offset }; return; }
        place(el, offset);
        fill();
        place(el, offset);
      });
    }
    function updatePill() {
      if (!newestEl) return;
      const away = ids.length > 0 && (start > 0 || listEl.scrollTop > (hasNew ? 1 : 48));
      if (!away) hasNew = false;
      newestEl.classList.toggle('show', away);
      newestEl.classList.toggle('has-new', away && hasNew);
      const best = mode === 'best';
      const label = newestEl.querySelector('.list-newest-label');
      if (label) label.textContent = best ? 'Top' : 'Newest';
      const title = best ? 'Back to the best match' : (hasNew ? 'New clips above - jump to the newest' : 'Jump to the newest clip');
      newestEl.title = title;
      newestEl.setAttribute('aria-label', title);
    }
    function scheduleSnapshot() {
      clearTimeout(snapshotTimer);
      snapshotTimer = setTimeout(() => { if (laidOut()) lastAnchor = capture(); }, 150);
    }

    // Rebuild for a new result set. next: { ids, tsAt, mode (Search.rankMode),
    // queryKey (the query text), emptyHtml (html, or a function called only when
    // the list IS empty) }. A changed query/mode only keeps
    // the cursor if it was the on-screen anchor and stayed put; a background
    // rebuild (same query) keeps it whenever it is still in the results.
    function update(next) {
      const n = next || {};
      const nextIds = n.ids || [];
      const nextMode = n.mode || 'none';
      const nextKey = n.queryKey != null ? String(n.queryKey) : '';
      const firstRender = queryKey === null;
      const queryChanged = !firstRender && (nextKey !== queryKey || nextMode !== mode);
      const cleared = !firstRender && queryKey.trim() !== '' && nextKey.trim() === '';
      const anchor = firstRender ? null : capture();
      const resolved = resolveListAnchor({ ids: nextIds, tsAt: n.tsAt, anchor, prevMode: mode || nextMode, nextMode, cleared });
      // A newer clip than any seen while the place is kept below it -> dot on
      // the pill. Time-ordered lists are newest-first, so index 0 is newest.
      if (nextMode !== 'best' && nextIds.length && typeof n.tsAt === 'function') {
        const topTs = Number(n.tsAt(0)) || 0;
        if (newestTs !== null && topTs > newestTs && resolved.index >= 0 && !queryChanged) hasNew = true;
        newestTs = newestTs === null ? topTs : Math.max(newestTs, topTs);
      }
      ids = nextIds;
      tsAt = typeof n.tsAt === 'function' ? n.tsAt : () => 0;
      mode = nextMode;
      queryKey = nextKey;
      if (n.emptyHtml != null) emptyHtml = n.emptyHtml;
      renderAt(resolved.index, resolved.offset);
      if (controller && controller.reconcileVisible) {
        controller.reconcileVisible({ keepCursor: !queryChanged || !!(anchor && anchor.isCursor && resolved.reason === 'kept') });
        controller.repaintSelection({ scroll: false });
      }
      if (laidOut()) lastAnchor = capture();
      updatePill();
      notifyRendered();
      return { ...resolved, anchor };
    }
    function scrollToTop() {
      hasNew = false;
      if (start > 0) renderAt(-1, 0);
      else listEl.scrollTop = 0;
      lastAnchor = null;
      updatePill();
      notifyRendered();
    }
    // Make sure `id`'s row is rendered (keyboard nav into the unrendered part).
    function ensureRendered(id) {
      const existing = rowFor(id);
      if (existing) return existing;
      const index = ids.indexOf(id);
      if (index < 0) return null;
      if (index >= end && index - end <= batch * 3) { while (end <= index && appendRows(batch)); }
      else if (index < start && start - index <= batch * 3) { while (start > index && prependRows(batch)); }
      else renderAt(index, 0);
      notifyRendered();
      return rowFor(id);
    }
    // The controller's renderSelection hook: paint focus/checked rows + the
    // selection bar; a scrolling paint (keyboard nav) first renders the row.
    function paintSelection(state, paintOpts) {
      const p = paintOpts || {};
      if (p.scroll !== false && state && state.focusId) ensureRendered(state.focusId);
      applySelectionUI({ listEl, barEl: o.barEl, state, scroll: p.scroll });
    }
    function firstVisibleId() {
      if (!laidOut()) return null;
      const el = rowAtY(listEl.getBoundingClientRect().top + 1);
      return el ? el.dataset.id : null;
    }

    if (listEl) {
      // Entering a row (pointer or keyboard) opens its meta ghosts: fit its names first.
      const onEnterRow = (e) => {
        const row = e.target && e.target.closest ? e.target.closest('.item') : null;
        const from = e.relatedTarget && e.relatedTarget.closest ? e.relatedTarget.closest('.item') : null;
        if (row && row !== from) fitMetaTags(row);
      };
      listEl.addEventListener('pointerover', onEnterRow);
      listEl.addEventListener('focusin', onEnterRow);
      listEl.addEventListener('scroll', () => {
        if (!ids.length) return;
        const h = listEl.clientHeight;
        let grew = false;
        if (end < ids.length && listEl.scrollHeight - listEl.scrollTop - h < h) grew = appendRows(batch) || grew;
        if (start > 0 && listEl.scrollTop < h) grew = prependRows(batch) || grew;
        if (grew) notifyRendered();
        updatePill();
        scheduleSnapshot();
      }, { passive: true });
      if (typeof ResizeObserver === 'function') {
        new ResizeObserver(() => {
          if (!laidOut()) return;
          if (pendingPlace) {
            const p = pendingPlace;
            pendingPlace = null;
            withAnchoringOff(() => { const el = rowFor(p.id); place(el, p.offset); fill(); place(el, p.offset); });
          } else fill();
          updatePill();
          resizeHooks.forEach((fn) => { try { fn(); } catch {} });
        }).observe(listEl);
      }
    }
    if (newestEl) {
      newestEl.addEventListener('mousedown', (e) => e.preventDefault()); // keep focus in the search box
      newestEl.addEventListener('click', (e) => { e.stopPropagation(); scrollToTop(); });
    }
    return {
      listEl,
      update,
      capture,
      scrollToTop,
      ensureRendered,
      paintSelection,
      firstVisibleId,
      rowAtY,
      fill,
      withAnchoringOff,
      onResize: (fn) => { if (typeof fn === 'function') resizeHooks.push(fn); },
      setController: (c) => { controller = c; },
      ids: () => ids,
      window: () => ({ start, end }),
    };
  }

  // Image preview zoom: ONE value (px height, persisted by the host) applied as
  // --clip-img-h on the popup root. Ctrl+wheel anywhere over the popup or
  // Ctrl+= / Ctrl+- / Ctrl+0 resize every preview (and never zoom the page);
  // the row under the pointer (keys: the cursor row, else the top row) stays
  // where it is. --clip-img-cap keeps one preview inside the visible list.
  const IMAGE_ZOOM = { min: 40, max: 600, def: 60, wheelStep: 1.15, keyStep: 1.25 };
  function clampImageHeight(px) {
    const n = Number(px);
    if (px === '' || px == null || !Number.isFinite(n)) return IMAGE_ZOOM.def;
    return Math.min(IMAGE_ZOOM.max, Math.max(IMAGE_ZOOM.min, n));
  }
  function imageZoomKey(e) {
    if (!e || !(e.ctrlKey || e.metaKey) || e.altKey) return null;
    const k = e.key;
    const c = e.code;
    if (k === '=' || k === '+' || c === 'Equal' || c === 'NumpadAdd') return 'in';
    if (k === '-' || k === '_' || c === 'Minus' || c === 'NumpadSubtract') return 'out';
    if (k === '0' || c === 'Digit0' || c === 'Numpad0') return 'reset';
    return null;
  }
  //   opts: { root, clipList, initial, save(px), toast(msg) }
  function createImageZoom(opts) {
    const o = opts || {};
    const root = o.root;
    const list = o.clipList || null;
    const listEl = list ? list.listEl : null;
    let exact = clampImageHeight(o.initial == null ? IMAGE_ZOOM.def : o.initial);
    let saveTimer = null;
    let inputEl = null;
    let resetEl = null;
    // The Settings reset shows only while the height is not the default (its
    // column stays reserved, so the control never moves).
    const syncReset = () => { if (resetEl) resetEl.style.visibility = value() === IMAGE_ZOOM.def ? 'hidden' : 'visible'; };
    const value = () => Math.round(exact);
    function applyCss() {
      if (root) root.style.setProperty('--clip-img-h', `${+exact.toFixed(2)}px`);
    }
    function applyCap() {
      if (root && listEl && listEl.clientHeight) root.style.setProperty('--clip-img-cap', `${Math.max(IMAGE_ZOOM.min, listEl.clientHeight - 40)}px`);
    }
    // Keep the point at client-y inside its row fixed across the resize.
    function holdRowAt(y) {
      if (!list || !listEl || !listEl.clientHeight) return null;
      const rect = listEl.getBoundingClientRect();
      const at = Math.min(rect.bottom - 1, Math.max(rect.top + 1, y));
      const el = list.rowAtY(at);
      if (!el) return null;
      const r = el.getBoundingClientRect();
      const frac = r.height ? Math.min(1, Math.max(0, (at - r.top) / r.height)) : 0;
      return () => {
        const n = el.getBoundingClientRect();
        listEl.scrollTop += (n.top + frac * n.height) - at;
      };
    }
    function set(px, setOpts) {
      const so = setOpts || {};
      const apply = () => {
        const restore = so.anchorY != null ? holdRowAt(so.anchorY) : null;
        exact = clampImageHeight(px);
        applyCss();
        if (restore) restore();
        if (list) list.fill();
      };
      if (list) list.withAnchoringOff(apply); else apply();
      if (inputEl && (typeof document === 'undefined' || document.activeElement !== inputEl)) inputEl.value = String(value());
      syncReset();
      if (!so.silent && o.toast) o.toast(`Image previews: ${value()}px`);
      if (so.save !== false && o.save) {
        clearTimeout(saveTimer);
        const v = value();
        saveTimer = setTimeout(() => o.save(v), 400);
      }
      return value();
    }
    function onWheel(e) {
      if (!e || !(e.ctrlKey || e.metaKey)) return false;
      e.preventDefault(); // never the page zoom
      const dy = e.deltaMode === 1 ? e.deltaY * 33 : e.deltaMode === 2 ? e.deltaY * 400 : e.deltaY;
      if (dy) set(exact * Math.pow(IMAGE_ZOOM.wheelStep, -dy / 100), { anchorY: e.clientY });
      return true;
    }
    function onKeydown(e) {
      const act = imageZoomKey(e);
      if (!act) return false;
      e.preventDefault(); // never the page zoom
      applyKey(act);
      return true;
    }
    // 'in' | 'out' | 'reset'. Also the entry for hosts whose main process claims
    // the chord before the page sees it (the app: macOS menu key equivalents).
    function applyKey(act) {
      if (act !== 'in' && act !== 'out' && act !== 'reset') return;
      let y = listEl ? listEl.getBoundingClientRect().top + 1 : 0;
      const cursor = listEl && listEl.querySelector(':scope > .item.selected');
      if (cursor) {
        const r = cursor.getBoundingClientRect();
        const lr = listEl.getBoundingClientRect();
        if (r.bottom > lr.top && r.top < lr.bottom) y = Math.max(lr.top + 1, r.top + 1);
      }
      const next = act === 'reset' ? IMAGE_ZOOM.def : exact * (act === 'in' ? IMAGE_ZOOM.keyStep : 1 / IMAGE_ZOOM.keyStep);
      set(next, { anchorY: y });
    }
    // The Settings row: number input (live while typing a valid value, clamped
    // on commit) + a reset button.
    function bindInput(input, resetBtn) {
      inputEl = input || null;
      if (input) {
        input.value = String(value());
        input.oninput = () => {
          const n = Number(input.value);
          if (input.value !== '' && n >= IMAGE_ZOOM.min && n <= IMAGE_ZOOM.max) set(n, { silent: true });
        };
        input.onchange = () => { set(input.value, { silent: true }); input.value = String(value()); };
      }
      resetEl = resetBtn || null;
      if (resetBtn) resetBtn.onclick = () => { set(IMAGE_ZOOM.def, { silent: true }); if (input) input.value = String(value()); };
      syncReset();
    }
    applyCss();
    applyCap();
    if (list) list.onResize(applyCap);
    return {
      get: value,
      set,
      // A value loaded from settings: apply without a toast or a save.
      load: (px) => set(px, { silent: true, save: false }),
      onWheel,
      onKeydown,
      applyKey,
      bindInput,
    };
  }

  // ── Similar clips: candidate duplicates to merge (Unify) ──
  // Two text clips are similar when one contains the other once whitespace is
  // collapsed and case ignored, both sides at least SIMILAR_MIN_CHARS long.
  // Pure. The normalised text is cached per item OBJECT (a history delta keeps
  // unchanged clips' objects, so a refresh re-normalises only what changed).
  // A clip over SIMILAR_MAX_CHARS is never normalised: as a candidate it is
  // searched through its lowercase text (opts.lowerOf(item), e.g. the app's
  // search haystack) a chunk at a time, anchored on the target's longest
  // space-free run (similarContainsAt); as the target it has no similar clips
  // (it would be scanned once per clip).
  const SIMILAR_MIN_CHARS = 12;
  const SIMILAR_MAX_CHARS = 262144;
  const SIMILAR_CHUNK = 1 << 20;
  const SIMILAR_GRAM_TABLE_AT = 1024; // longer targets index their 12-char windows
  const similarNormCache = new WeakMap();
  const similarLowerCache = new WeakMap();
  function similarText(item) {
    if (!item || item.type === 'image' || typeof item !== 'object') return '';
    const raw = String(item.text || '');
    if (raw.length < SIMILAR_MIN_CHARS || raw.length > SIMILAR_MAX_CHARS) return '';
    let norm = similarNormCache.get(item);
    if (norm == null) {
      // Lowercase, then ONE pass over whitespace runs + non-space whitespace
      // (about 4x faster than replacing every \s+ run, measured on 23 MB).
      norm = raw.toLowerCase().replace(/\s{2,}|[^\S ]/g, ' ').trim();
      if (norm.length < SIMILAR_MIN_CHARS) norm = '';
      similarNormCache.set(item, norm);
    }
    return norm;
  }
  function similarLower(item, opts) {
    const fromHost = opts && typeof opts.lowerOf === 'function' ? opts.lowerOf(item) : null;
    if (typeof fromHost === 'string') return fromHost;
    let lower = similarLowerCache.get(item);
    if (lower == null) { lower = String(item.text || '').toLowerCase(); similarLowerCache.set(item, lower); }
    return lower;
  }
  // The 12-char windows of a long target in an open-addressing hash table
  // (rolling hash), so "is this shorter clip inside the target?" first asks
  // whether its opening 12 chars occur there at all: O(1) per clip instead of a
  // scan of the target per clip. A hash collision only costs a real check.
  function similarGramHash(s, from) {
    let h = 0;
    for (let i = from; i < from + SIMILAR_MIN_CHARS; i += 1) h = (Math.imul(h, 31) + s.charCodeAt(i)) | 0;
    return h;
  }
  function similarGramTable(t) {
    const n = t.length - SIMILAR_MIN_CHARS + 1;
    let size = 2;
    while (size < n * 2) size *= 2;
    const keys = new Int32Array(size);
    const used = new Uint8Array(size);
    const mask = size - 1;
    const slotOf = (h) => (Math.imul(h, 0x9E3779B1) >>> 0) & mask;
    let pow = 1;
    for (let i = 1; i < SIMILAR_MIN_CHARS; i += 1) pow = Math.imul(pow, 31);
    let h = similarGramHash(t, 0);
    for (let i = 0; i < n; i += 1) {
      if (i > 0) h = (Math.imul(h - Math.imul(t.charCodeAt(i - 1), pow), 31) + t.charCodeAt(i + SIMILAR_MIN_CHARS - 1)) | 0;
      let slot = slotOf(h);
      while (used[slot] && keys[slot] !== h) slot = (slot + 1) & mask;
      used[slot] = 1;
      keys[slot] = h;
    }
    return (x) => {
      const hx = similarGramHash(x, 0);
      for (let slot = slotOf(hx); used[slot]; slot = (slot + 1) & mask) if (keys[slot] === hx) return true;
      return false;
    };
  }
  // A huge clip is never normalised, so "does it contain the target?" works on
  // its raw lowercase text: the target's longest space-free run is the anchor
  // (native indexOf finds where it occurs), and each spot is checked outward
  // with every space of the target matching one whitespace RUN of the clip.
  // No pattern is built from the target (a 25K+ char RegExp does not compile:
  // V8 "Stack overflow", 2026-10-08) and nothing is copied per chunk.
  const SPACE_RE = /\s/;
  function isSpaceCode(c) { return c === 32 || (c >= 9 && c <= 13) || (c > 127 && SPACE_RE.test(String.fromCharCode(c))); }
  function similarAnchor(t) {
    let best = 0;
    let bestLen = 0;
    let start = 0;
    for (let i = 0; i <= t.length; i += 1) {
      if (i === t.length || t.charCodeAt(i) === 32) {
        if (i - start > bestLen) { best = start; bestLen = i - start; }
        start = i + 1;
      }
    }
    return { seg: t.slice(best, best + bestLen), off: best };
  }
  // Does `lower` hold the normalised target t with its anchor run starting at p?
  function similarContainsAt(lower, p, t, anchor) {
    let i = anchor.off + anchor.seg.length;
    let j = p + anchor.seg.length;
    while (i < t.length) {
      if (t.charCodeAt(i) === 32) {
        if (j >= lower.length || !isSpaceCode(lower.charCodeAt(j))) return false;
        while (j < lower.length && isSpaceCode(lower.charCodeAt(j))) j += 1;
      } else if (lower.charCodeAt(j) !== t.charCodeAt(i)) return false;
      else j += 1;
      i += 1;
    }
    i = anchor.off - 1;
    j = p - 1;
    while (i >= 0) {
      if (t.charCodeAt(i) === 32) {
        if (j < 0 || !isSpaceCode(lower.charCodeAt(j))) return false;
        while (j >= 0 && isSpaceCode(lower.charCodeAt(j))) j -= 1;
      } else if (j < 0 || lower.charCodeAt(j) !== t.charCodeAt(i)) return false;
      else j -= 1;
      i -= 1;
    }
    return true;
  }
  // The scan as a generator that yields after every unit of work (one clip, or
  // one chunk of a huge clip), so a host can run it in time slices; returns the
  // similar clips' ids. similarClipIds runs it to the end.
  function* similarSteps(target, items, opts) {
    const out = [];
    const t = similarText(target);
    if (!t) return out;
    const targetId = itemId(target);
    const m = t.length;
    let inTarget = null;
    let anchor = null;
    for (const item of items || []) {
      if (!item || item === target || item.type === 'image') continue;
      const id = itemId(item);
      if (id == null || id === targetId) continue;
      const rawLen = String(item.text || '').length;
      if (rawLen < SIMILAR_MIN_CHARS) continue;
      if (rawLen > SIMILAR_MAX_CHARS) {
        // A huge clip can only CONTAIN the target. Each chunk's window runs on
        // by the anchor's length, so an anchor across a chunk edge is found once.
        anchor = anchor || similarAnchor(t);
        const lower = similarLower(item, opts);
        const seg = anchor.seg;
        let found = false;
        for (let at = 0; at < lower.length && !found; at += SIMILAR_CHUNK) {
          const win = lower.slice(at, at + SIMILAR_CHUNK + seg.length - 1);
          for (let q = win.indexOf(seg); q !== -1 && !found; q = win.indexOf(seg, q + 1)) {
            found = similarContainsAt(lower, at + q, t, anchor);
          }
          if (!found) yield;
        }
        if (found) out.push(id);
        continue;
      }
      const x = similarText(item);
      if (x) {
        if (x.length >= m) { if (x.includes(t)) out.push(id); }
        else if (m < SIMILAR_GRAM_TABLE_AT) { if (t.includes(x)) out.push(id); }
        else {
          inTarget = inTarget || similarGramTable(t);
          if (inTarget(x) && t.includes(x)) out.push(id);
        }
      }
      yield;
    }
    return out;
  }
  // Candidate duplicates of `target` among `items`: every other text clip whose
  // whitespace-collapsed, case-folded text contains the target's or is
  // contained in it (both >= 12 chars; images, the target itself and a target
  // over SIMILAR_MAX_CHARS give none). opts: { lowerOf(item) -> lowercase text,
  // used for clips too big to normalise }. Returns ids in `items` order.
  function similarClipIds(target, items, opts) {
    const steps = similarSteps(target, items, opts);
    let r = steps.next();
    while (!r.done) r = steps.next();
    return r.value;
  }
  // Run a step generator in slices of at most sliceMs on the event loop, so a
  // long scan never blocks a frame; holdUntil() > Date.now() pauses it (e.g.
  // while the query is typed); onSlice(ms) reports each slice (QA). Returns stop().
  // A step that throws ends the run with onDone(undefined), so a caller waiting
  // on it is always answered; the error is rethrown on its own tick, where the
  // host's error reporting records it.
  function runSliced(steps, onDone, options) {
    const o = options || {};
    const sliceMs = o.sliceMs || 6;
    const clock = () => (typeof performance !== 'undefined' && performance.now ? performance.now() : Date.now());
    let stopped = false;
    const step = () => {
      if (stopped) return;
      const hold = o.holdUntil ? o.holdUntil() - Date.now() : 0;
      if (hold > 0) { setTimeout(step, hold); return; }
      const began = clock();
      const until = began + sliceMs;
      let r;
      try {
        r = steps.next();
        while (!r.done && clock() < until) r = steps.next();
      } catch (error) {
        stopped = true;
        setTimeout(() => { throw error; }, 0);
        onDone(undefined);
        return;
      }
      if (o.onSlice) o.onSlice(clock() - began);
      if (r.done) { stopped = true; onDone(r.value); } else setTimeout(step, 0);
    };
    step();
    return () => { stopped = true; };
  }

  function createClipController(adapter) {
    const a = adapter || {};
    const dialogs = a.dialogs || createDialogs(a.dialogHost);
    const render = () => { if (a.render) a.render(); };
    const refresh = () => { if (a.refresh) a.refresh(); else render(); };
    const toast = (msg) => { if (a.toast && msg) a.toast(msg); };
    const protectedHas = (group) => {
      const p = a.protectedGroups && a.protectedGroups();
      return !!(p && typeof p.has === 'function' && p.has(group));
    };

    async function deleteGroup(group) {
      if (!group || protectedHas(group)) return;
      const ok = await dialogs.confirm({ title: `Delete group "${group}"?`, message: 'Items will be ungrouped but not deleted.', okLabel: 'Delete', danger: true });
      if (!ok) return;
      await a.deleteGroup(group);
      refresh();
    }
    async function tryAssignNumpad(id, slot) {
      const nmap = a.numpadMap ? a.numpadMap() : {};
      if (slot in nmap && nmap[slot] !== id) {
        const existing = a.itemById(nmap[slot]);
        const preview = existing ? (existing.type === 'image' ? '[image]' : String(existing.text || '').replace(/\s+/g, ' ').slice(0, 80)) : '';
        const ok = await dialogs.confirm({ title: `Numpad ${slot} already assigned:`, preview, okLabel: 'Replace' });
        if (!ok) return;
      }
      await a.numpadAssign(id, slot);
      refresh();
    }
    async function addGroup(id) {
      const name = await dialogs.prompt({ title: 'New group name', okLabel: 'Create' });
      if (!name) return;
      await a.createGroup(name);
      if (id != null && a.toggleGroup) await a.toggleGroup(id, name); // clip is not yet in the new group, so this adds
      refresh();
    }
    async function clearAll() {
      const ok = await dialogs.confirm({ title: 'Clear all unpinned clips?', message: 'Pinned clips are kept.', okLabel: 'Clear all', danger: true });
      if (!ok) return;
      await a.clearUnpinned();
      refresh();
    }
    // Name a clip via the shared title prompt (text + images alike), prefilled
    // with the current name. Reuses the same title field search indexes.
    async function renameClip(id) {
      const item = a.itemById(id);
      const title = await dialogs.prompt({ title: item && item.type === 'image' ? 'Rename image' : 'Rename clip', value: item ? titleOf(item) : '', okLabel: 'Save' });
      if (title === null) return;
      if (a.setClipTitle) await a.setClipTitle(id, title);
      refresh();
    }

    // --- Multi-select (lifted from the consumers so app + demo share ONE
    // implementation). selectedIds = the checked set (bulk target); focusId =
    // the keyboard cursor (single, paints `.selected`). visibleIds() +
    // renderSelection() are the only new adapter hooks the consumers must give.
    const menu = createMenu(a.menuHost || a.dialogHost);
    // Keep hover submenus (filter bar, pickers, popover menus) inside the window.
    installSubmenuAutoflip(a.menuHost || (typeof document !== 'undefined' ? document : null));
    const selectedIds = new Set();
    let anchorId = null;
    let focusId = null;
    let lastUndo = null;
    // heldId: the row whose buttons stay out while its menu / popover is open
    // or it is being dragged (painted as .actions-held).
    let heldId = null;

    function visibleIds() { return (a.visibleIds && a.visibleIds()) || []; }
    function allItems() { return (a.allItems && a.allItems()) || []; }
    function groupNames() { return (a.groupNames && a.groupNames()) || []; }
    function itemIsImage(id) { const it = a.itemById && a.itemById(id); return !!(it && it.type === 'image'); }
    function selectionInfo() {
      let hasImage = false;
      for (const id of selectedIds) { if (itemIsImage(id)) { hasImage = true; break; } }
      return { count: selectedIds.size, ids: [...selectedIds], selectedIds, focusId, anchorId, hasImage, heldId, similarIds };
    }

    // --- Similar clips (candidate duplicates, D2) ---
    // Hovering a text row, or moving the keyboard cursor onto one, tints the
    // RENDERED rows whose text contains it or is contained in it
    // (Core.similarClipIds over all history, painted as .similar), so likely
    // duplicates stand out for Unify; the "..." menu offers "Select N similar".
    // Never on the typing path: a scan starts only after the pointer / cursor
    // rests on a row (SIMILAR_DWELL_MS), runs in slices of a few ms, pauses
    // while the query is being typed, and its result is kept per target until
    // the history (allItems()) changes.
    const SIMILAR_DWELL_MS = 120;
    const SIMILAR_QUIET_MS = 350;
    let hoverId = null;          // the row under the pointer
    let similarCursorId = null;  // the cursor row after a keyboard move
    let similarFor = null;       // the target whose similar set is wanted now
    let similarIds = null;       // the painted set (null = none)
    let similarTimer = null;
    let similarScan = null;      // { id, list, waiters, stop }
    let quietUntil = 0;          // no scanning until then (query typing)
    const similarCache = { list: null, byId: new Map() };
    function similarResults() {
      const list = allItems();
      if (similarCache.list !== list) { similarCache.list = list; similarCache.byId = new Map(); }
      return similarCache.byId;
    }
    function isTextClip(id) { const it = id != null && a.itemById ? a.itemById(id) : null; return !!(it && it.type !== 'image'); }
    // The similar set of `id` to cb(Set): from the cache, by joining the scan
    // already running for it, or by starting one (which replaces a scan for
    // another target).
    function whenSimilar(id, cb) {
      const cache = similarResults();
      if (cache.has(id)) { cb(cache.get(id)); return; }
      if (similarScan && similarScan.id === id && similarScan.list === similarCache.list) { similarScan.waiters.push(cb); return; }
      if (similarScan) similarScan.stop();
      const item = a.itemById ? a.itemById(id) : null;
      if (!item || item.type === 'image') { const none = new Set(); cache.set(id, none); cb(none); return; }
      const list = similarCache.list;
      const job = { id, list, waiters: [cb], stop: () => {} };
      similarScan = job;
      // runSliced runs its first slice before returning, so the job can be done
      // (or failed: ids undefined = an empty set, cached like any answer)
      // before job.stop is assigned.
      job.stop = runSliced(similarSteps(item, list, { lowerOf: a.lowerOf }), (ids) => {
        if (similarScan === job) similarScan = null;
        const set = new Set(ids || []);
        if (similarCache.list === list) similarCache.byId.set(id, set);
        for (const waiter of job.waiters) waiter(set);
      }, { holdUntil: () => quietUntil });
    }
    function paintSimilar(set) {
      const next = set && set.size ? set : null;
      if (next === similarIds) return;
      similarIds = next;
      paintSelection({ scroll: false });
    }
    // The target is the row whose menu is open, else the hovered row, else the
    // cursor row (only while the cursor is still on it: a cursor the list
    // dropped takes its tint along); a cached result paints at once, a new one
    // after the dwell.
    function refreshSimilar() {
      const id = heldId || hoverId || (similarCursorId != null && similarCursorId === focusId ? similarCursorId : null);
      const target = isTextClip(id) ? id : null;
      if (target === similarFor) return;
      similarFor = target;
      if (similarTimer) { clearTimeout(similarTimer); similarTimer = null; }
      const cached = target ? similarResults().get(target) : null;
      paintSimilar(cached || null); // the previous row's tint goes at once
      if (!target || cached) return;
      similarTimer = setTimeout(() => {
        similarTimer = null;
        if (similarFor === target) whenSimilar(target, (set) => { if (similarFor === target) paintSimilar(set); });
      }, SIMILAR_DWELL_MS);
    }
    function hold(id) {
      if (heldId === id) return;
      heldId = id;
      refreshSimilar();
      paintSelection({ scroll: false });
    }
    // A row's menu / popover is opening: its onClose. The caller opens the menu,
    // THEN hold(id) (opening closes a previous one, whose onClose releases its
    // own hold first). Closing releases the hold; when it was opened with the
    // mouse and the opener button still has focus afterwards (Esc, a scroll),
    // focus goes back to the search field, so :focus-within does not keep the
    // buttons out. Opened from the keyboard, focus stays where Tab put it.
    function releaseOnClose(id) {
      const doc = typeof document !== 'undefined' ? document : null;
      const inRow = (el) => {
        const row = el && typeof el.closest === 'function' ? el.closest('.item') : null;
        return !!(row && row.dataset && row.dataset.id === id);
      };
      const opener = doc ? doc.activeElement : null;
      const keyboard = !!(opener && inRow(opener) && typeof opener.matches === 'function' && opener.matches(':focus-visible'));
      return () => {
        hold(null);
        if (keyboard || !doc) return;
        // After the close settles: a popover opened next on the same row holds it again.
        setTimeout(() => {
          const el = doc.activeElement;
          if (heldId === id || !inRow(el)) return;
          if (a.focusSearch) a.focusSearch(); else if (typeof el.blur === 'function') el.blur();
        }, 0);
      };
    }
    // Hover tracking (hosts route mouseover / mouseout here).
    function onMouseover(event) {
      const t = event.target;
      const row = t && typeof t.closest === 'function' ? t.closest('.item') : null;
      const id = row && row.dataset && row.dataset.id ? row.dataset.id : null;
      if (id === hoverId) return false;
      hoverId = id;
      refreshSimilar();
      return !!id;
    }
    function onMouseout(event) {
      if (hoverId == null) return false;
      // Still inside the host (the app's document, the demo's popup box): the
      // next mouseover says where. Out of the window or the box: no hover.
      const host = event.currentTarget;
      const to = event.relatedTarget;
      if (to && (!host || typeof host.contains !== 'function' || host === to || host.contains(to))) return false;
      hoverId = null;
      refreshSimilar();
      return true;
    }
    // "Select N similar": the clip plus every clip similar to it, across all
    // history. When some of them are outside the current results, the search is
    // cleared first so the selection never holds a clip the list hides.
    function selectSimilar(id) {
      if (!a.itemById || !a.itemById(id)) return;
      // From the cache (the menu's count); recounted when the history changed since.
      whenSimilar(id, (set) => { if (set.size) applySelectSimilar(id, set); });
    }
    function applySelectSimilar(id, set) {
      const ids = [...set].filter((x) => a.itemById(x));
      const visible = new Set(visibleIds());
      if (a.clearFilters && (!visible.has(id) || ids.some((x) => !visible.has(x)))) a.clearFilters();
      selectedIds.clear();
      selectedIds.add(id);
      for (const x of ids) selectedIds.add(x);
      anchorId = id;
      focusId = id;
      paintSelection({ scroll: false });
    }
    // opts.scroll === false: a repaint after a list rebuild, which must not move
    // the kept scroll place to chase the cursor.
    function paintSelection(opts) { if (a.renderSelection) a.renderSelection(selectionInfo(), opts || {}); }
    function clearSelection({ paint = true } = {}) {
      const had = selectedIds.size || focusId != null;
      selectedIds.clear();
      anchorId = null;
      focusId = null;
      if (similarCursorId != null) { similarCursorId = null; refreshSimilar(); }
      if (paint) paintSelection();
      return had;
    }
    // The query is changing: a multi-selection would let a bulk action hit
    // clips the new results hide, so it goes; the cursor waits for the rebuild
    // (reconcileVisible), which keeps it only if it stays on screen.
    function onQueryChange() {
      selectedIds.clear();
      anchorId = null;
      quietUntil = Date.now() + SIMILAR_QUIET_MS; // similar scans wait for a typing pause
    }
    // After a rebuild: drop selection/cursor ids the list no longer shows; a
    // changed query keeps the cursor only when keepCursor (the list decides).
    // The similar target goes with a row the list no longer shows (a hidden
    // row's tint would leave a result looking like the cursor).
    function reconcileVisible({ keepCursor = true } = {}) {
      if (!selectedIds.size && focusId == null && anchorId == null && hoverId == null && similarCursorId == null) return;
      const visible = new Set(visibleIds());
      for (const id of [...selectedIds]) if (!visible.has(id)) selectedIds.delete(id);
      if (anchorId != null && !visible.has(anchorId)) anchorId = null;
      if (focusId != null && (!keepCursor || !visible.has(focusId))) focusId = null;
      if (hoverId != null && !visible.has(hoverId)) hoverId = null;
      if (similarCursorId != null && similarCursorId !== focusId) similarCursorId = null;
      refreshSimilar();
    }
    function toggleSelect(id) {
      if (!id) return;
      if (selectedIds.has(id)) selectedIds.delete(id); else selectedIds.add(id);
      anchorId = id; focusId = id;
      paintSelection();
    }
    function selectRange(id) {
      const ids = visibleIds();
      const to = ids.indexOf(id);
      if (to < 0) return;
      let from = anchorId != null ? ids.indexOf(anchorId) : (focusId != null ? ids.indexOf(focusId) : to);
      if (from < 0) from = to;
      const lo = Math.min(from, to);
      const hi = Math.max(from, to);
      selectedIds.clear();
      for (let i = lo; i <= hi; i += 1) selectedIds.add(ids[i]);
      if (anchorId == null) anchorId = ids[from];
      focusId = id;
      paintSelection();
    }
    function selectAll() {
      const ids = visibleIds();
      if (!ids.length) return;
      selectedIds.clear();
      for (const id of ids) selectedIds.add(id);
      anchorId = ids[0];
      // Keep the cursor where it is. Jumping focus to the LAST row made the
      // lazily-rendered popup list materialise every row just to scroll there
      // (9.7k DOM rows after one Ctrl+A, measured 2026-09-02); nothing about
      // select-all needs the cursor to move.
      if (focusId == null || !selectedIds.has(focusId)) focusId = ids[0];
      paintSelection();
    }
    function moveFocus(dir, opts) {
      const extend = opts && opts.extend;
      const ids = visibleIds();
      if (!ids.length) return;
      const idx = focusId != null ? ids.indexOf(focusId) : -1;
      // No cursor yet: start on the first row on screen (keeps a scrolled place),
      // else the top (Down) / bottom (Up) as before.
      const onScreen = idx < 0 && a.firstVisibleId ? ids.indexOf(a.firstVisibleId()) : -1;
      const next = idx < 0
        ? (onScreen >= 0 ? onScreen : (dir > 0 ? 0 : ids.length - 1))
        : Math.max(0, Math.min(idx + dir, ids.length - 1));
      const nextId = ids[next];
      // The cursor row is now the similar target (until the pointer moves).
      hoverId = null;
      similarCursorId = nextId;
      if (extend) {
        if (anchorId == null) anchorId = focusId != null ? focusId : nextId;
        selectRange(nextId);
      } else {
        selectedIds.clear();
        anchorId = nextId;
        focusId = nextId;
        paintSelection();
      }
      refreshSimilar();
    }
    function isTypingTarget(el) {
      if (!el) return false;
      const tag = el.tagName;
      return tag === 'INPUT' || tag === 'TEXTAREA' || el.isContentEditable;
    }
    // A focused control (the options toggle, a panel chip, a row or bar button)
    // answers a plain Enter / Space itself, natively: the list keys below would
    // cancel that activation and paste a clip (or toggle a selection) instead.
    const ACTIVATABLE_CONTROL = 'button, a[href], select, summary, [role="button"], [role="menuitem"], [role="separator"], '
      + '[role="checkbox"], [role="switch"], [role="tab"], [role="option"]';
    function isActivatableControl(el) {
      return !!(el && !isTypingTarget(el) && typeof el.closest === 'function' && el.closest(ACTIVATABLE_CONTROL));
    }

    // --- Bulk flows (all reuse the same single-item backend primitives, batched
    // by the adapter into one save). Delete is instant + Undo toast; no dialog.
    async function pasteSelection() {
      const ids = selectionInfo().ids;
      if (!ids.length) return;
      try { if (a.pasteMany) await a.pasteMany(ids); }
      finally { clearSelection(); } // always drop the selection (app hides the popup; demo hides the bar)
    }
    async function deleteIds(ids) {
      if (!ids || !ids.length) return;
      ids.forEach((id) => selectedIds.delete(id));
      if (focusId != null && ids.includes(focusId)) focusId = null;
      let snapshots = null;
      if (a.deleteClips) snapshots = await a.deleteClips(ids);
      else if (a.deleteClip) { for (const id of ids) await a.deleteClip(id); }
      refresh();
      if (snapshots && snapshots.length && a.restoreClips && a.offerUndo) {
        const snaps = snapshots;
        lastUndo = async () => { lastUndo = null; await a.restoreClips(snaps); refresh(); };
        a.offerUndo({ count: snaps.length, undo: () => { if (lastUndo) lastUndo(); } });
      } else {
        toast(a.deletedToast);
      }
    }
    function deleteSelection() {
      const ids = selectionInfo().ids;
      return deleteIds(ids.length ? ids : (focusId ? [focusId] : []));
    }
    async function bulkGroup(group) {
      const ids = selectionInfo().ids;
      if (!ids.length || !group) return;
      const items = ids.map((id) => a.itemById(id)).filter(Boolean);
      const shouldHave = groupMembership(items, group) !== 'all'; // all -> remove from all; else add to all
      if (a.groupAssignMany) await a.groupAssignMany(ids, group, shouldHave);
      else if (a.toggleGroup) { for (const id of ids) { const it = a.itemById(id); if (!!it && isInGroup(it, group) !== shouldHave) await a.toggleGroup(id, group); } }
      refresh();
    }
    async function bulkAddGroup() {
      const name = await dialogs.prompt({ title: 'New group name', okLabel: 'Create' });
      if (!name) return;
      if (a.createGroup) await a.createGroup(name);
      await bulkGroup(name);
    }
    async function unifySelection() {
      const ids = selectionInfo().ids;
      if (ids.length < 2) return;
      if (a.startUnify) await a.startUnify(ids);
      // Paint the cleared state: on macOS the popup stays visible while the
      // unify window opens (no blur-to-hide), so a stale bar would linger.
      clearSelection();
    }
    function openBulkMenu(x, y, keyboard) {
      const info = selectionInfo();
      const selItems = info.ids.map((id) => a.itemById(id)).filter(Boolean);
      menu.open({ x, y, keyboard, html: renderBulkMenu(info, { groups: groupNames(), selectedItems: selItems }) });
    }
    // The bar's dedicated Group button: a popover with JUST the tri-state group
    // tree (no submenu hop). The full bulk menu stays on right-click.
    function openBulkGroupMenu(x, y) {
      const selItems = selectionInfo().ids.map((id) => a.itemById(id)).filter(Boolean);
      menu.open({ x, y, html: `<div class="bc-menu-list bc-group-list">${bulkGroupTreeHtml(groupNames(), selItems)}</div>` });
    }
    // The popup's single-clip menu: also holds the row's buttons out while it
    // is open and offers "Select N similar" for a text clip (N over all
    // history; a placeholder row while the count is being worked out, removed
    // when there are none).
    function openClipMenu(rowEl, x, y, aboveY, keyboard) {
      const id = rowEl && rowEl.dataset ? rowEl.dataset.id : null;
      if (!id) return;
      if (selectedIds.size >= 2 && selectedIds.has(id)) { openBulkMenu(x, y, keyboard); return; }
      const item = a.itemById(id);
      if (!item) return;
      const offerSimilar = item.type !== 'image' && (!a.menuContext || a.menuContext === 'popup');
      const known = offerSimilar ? similarResults().get(id) : null;
      const similarCount = !offerSimilar ? undefined : known ? known.size : null;
      menu.open({ id, x, y, aboveY, keyboard, onClose: releaseOnClose(id), html: renderClipMenu(item, { items: allItems(), groups: groupNames(), numpadMap: a.numpadMap ? a.numpadMap() : {}, context: a.menuContext, similarCount }) });
      hold(id);
      if (similarCount !== null) return;
      whenSimilar(id, (set) => {
        const root = menu.root();
        const row = root && root.dataset.id === id ? root.querySelector('[data-action="select-similar"]') : null;
        if (!row) return;
        if (!set.size) { row.remove(); return; }
        row.disabled = false;
        row.removeAttribute('aria-busy');
        const label = row.querySelector('.bc-menu-label');
        if (label) label.textContent = similarLabel(set.size);
      });
    }
    // Public entry for hosts without clip rows (the standalone editor/viewer
    // windows): open the shared clip menu for `id` at x,y. `context` overrides
    // the adapter's menuContext (the demo's editor overlay shares the popup's
    // controller but shows the editor's menu).
    function openClipMenuAt(id, x, y, context) {
      const item = a.itemById(id);
      if (!item) return;
      menu.open({ id, x, y, html: renderClipMenu(item, { items: allItems(), groups: groupNames(), numpadMap: a.numpadMap ? a.numpadMap() : {}, context: context || a.menuContext }) });
    }
    // The one-clip group picker: the title-bar strip's + and a row's meta +
    // (same clipGroupTreeHtml checklist as the clip menu's submenu, same
    // toggle-group/add-group dispatch - the menu root carries data-id).
    // Mirrors openBulkGroupMenu.
    function openGroupPickerAt(id, x, y, aboveY) {
      const item = a.itemById(id);
      if (!item) return;
      menu.open({ id, x, y, aboveY, onClose: releaseOnClose(id), html: `<div class="bc-menu-list bc-group-list">${clipGroupTreeHtml(groupNames(), item)}</div>` });
      hold(id);
    }
    // A row's numpad badge / ghost #: the keypad (the same renderKeypadMenu the
    // clip menu's Numpad submenu shows) in a popover; a key assigns through
    // tryAssignNumpad (its replace confirm included), and a set key can be
    // removed.
    function openNumpadPickerAt(id, x, y, aboveY) {
      const item = a.itemById(id);
      if (!item) return;
      const keys = renderKeypadMenu(item, allItems(), a.numpadMap ? a.numpadMap() : {});
      menu.open({ id, x, y, aboveY, className: 'bc-keypad', onClose: releaseOnClose(id), html: `<div class="bc-menu-list">${keys}</div>` });
      hold(id);
    }

    // Opens the editor (or image viewer for images) for the clip row under event.
    // Shared inner helper used by alt+click and middle-click (auxclick) paths.
    // MOUSE-driven opens keep the popup: the window opens WITHOUT taking focus
    // (main: showInactive, no hidePopup) so several results can be opened in a
    // row; the popup still blur-hides the moment the user clicks into one of them.
    // Keyboard opens (Ctrl/Alt+Enter) stay a hand-off: focus moves to the editor.
    const KEEP_POPUP = { keepPopup: true };
    // Filter targets: the chip bar's chips, the group rows in a chip's dropdown
    // and a row's group names (click includes, right-click excludes).
    const FILTER_TARGET = '.filter-tag[data-filter], .filter-tag[data-group], .group-filter-row[data-group], .meta-tag[data-group]';
    async function openClipInEditor(event, row) {
      event.preventDefault(); event.stopPropagation();
      const item = a.itemById(row.dataset.id);
      if (!item) return true;
      if (item.type === 'image') { if (a.openImage) await a.openImage(item, KEEP_POPUP); }
      else { await a.editClip(row.dataset.id, row, KEEP_POPUP); }
      return true;
    }
    // Middle-click on a clip row = open in editor/viewer WITHOUT the autoscroll
    // widget. Measured in Electron's Chromium (2026-09-03): preventing the default
    // on the middle-button MOUSEDOWN is the only thing that stops autoscroll, and
    // once it is prevented Chromium never fires `auxclick` for that press. So the
    // open happens on MOUSEUP of a press that stayed on the same row and did not
    // drag (a drag is what autoscroll would have been). `onAuxclick` remains only
    // as a fallback for a consumer that does not route mousedown through here.
    const MIDDLE_DRAG_SLOP_PX = 6;
    let middleArm = null;        // { id, x, y } from the last middle mousedown on a row
    let lastMiddleOpen = null;   // { id, at } so a stray auxclick can't double-open
    // The row's own open button: a NORMAL click hands off (editor takes focus, popup
    // closes); a middle-click or RIGHT-click on that same button opens while keeping
    // the popup - the "open several results" gesture the owner asked for.
    const OPEN_BTN_SEL = '[data-action="edit"], [data-action="open-img"]';
    function middleRowFor(event) {
      const t = event.target;
      if (!t || typeof t.closest !== 'function') return null;
      const openBtn = t.closest(OPEN_BTN_SEL);
      const row = openBtn ? openBtn.closest('.item') : (t.closest('button, .star, [data-action], a') ? null : t.closest('.item'));
      return row && row.dataset && row.dataset.id ? row : null;
    }
    function onMousedown(event) {
      if (event.button !== 1) return false;
      const row = middleRowFor(event);
      if (!row) { middleArm = null; return false; }
      event.preventDefault();
      middleArm = { id: row.dataset.id, x: Number(event.clientX) || 0, y: Number(event.clientY) || 0 };
      return true;
    }
    async function onMouseup(event) {
      if (event.button !== 1 || !middleArm) return false;
      const arm = middleArm;
      middleArm = null;
      const row = middleRowFor(event);
      if (!row || row.dataset.id !== arm.id) return false;
      const dx = Math.abs((Number(event.clientX) || 0) - arm.x);
      const dy = Math.abs((Number(event.clientY) || 0) - arm.y);
      if (dx > MIDDLE_DRAG_SLOP_PX || dy > MIDDLE_DRAG_SLOP_PX) return false;
      lastMiddleOpen = { id: arm.id, at: Date.now() };
      return openClipInEditor(event, row);
    }
    async function onAuxclick(event) {
      if (event.button !== 1) return false;
      const row = middleRowFor(event);
      if (!row) return false;
      // Already opened by onMouseup for this press: swallow the (rare) auxclick.
      if (lastMiddleOpen && lastMiddleOpen.id === row.dataset.id && Date.now() - lastMiddleOpen.at < 800) { event.preventDefault(); return true; }
      return openClipInEditor(event, row);
    }
    async function onClick(event) {
      const t = event.target;
      // Alt+click on a clip row body → open in editor/viewer (not on inner controls).
      if (event.altKey && !event.ctrlKey && !event.metaKey && !event.shiftKey) {
        if (!t.closest('button, .star, [data-action], a')) {
          const row = t.closest('.item');
          if (row && row.dataset.id) return openClipInEditor(event, row);
        }
      }
      // Multi-select: Ctrl/Cmd-click toggles a row, Shift-click ranges from the
      // anchor. Only when the click lands on the row body (not an inner control),
      // so modifier-clicking the star/menu still does its own thing.
      if ((event.metaKey || event.ctrlKey || event.shiftKey) && !t.closest('button, .star, [data-action], a')) {
        const row = t.closest('.item');
        if (row && row.dataset.id) {
          event.preventDefault(); event.stopPropagation();
          // Shift-click extends the browser's native TEXT selection before the
          // click lands (disorienting highlight across rows) — clear it.
          const nativeSel = typeof window !== 'undefined' && window.getSelection && window.getSelection();
          if (nativeSel && !nativeSel.isCollapsed) nativeSel.removeAllRanges();
          if (event.shiftKey) selectRange(row.dataset.id); else toggleSelect(row.dataset.id);
          return true;
        }
      }
      // Per-clip "..." menu + multi-select bulk actions (bar + menu share these).
      const menuBtn = t.closest('[data-action="clip-menu"]');
      if (menuBtn) { event.stopPropagation(); const r = menuBtn.getBoundingClientRect(); openClipMenu(menuBtn.closest('.item'), r.right, r.bottom + 2, r.top - 2); return true; }
      const bulkGroupOpen = t.closest('[data-action="bulk-group-open"]');
      if (bulkGroupOpen) { event.stopPropagation(); const r = bulkGroupOpen.getBoundingClientRect(); openBulkGroupMenu(r.left, r.bottom + 2); return true; }
      if (t.closest('[data-action="bulk-paste"]')) { event.stopPropagation(); pasteSelection(); return true; }
      if (t.closest('[data-action="bulk-unify"]')) { event.stopPropagation(); unifySelection(); return true; }
      if (t.closest('[data-action="bulk-delete"]')) { event.stopPropagation(); deleteSelection(); return true; }
      if (t.closest('[data-action="bulk-clear"]')) { event.stopPropagation(); clearSelection(); return true; }
      const bulkAdd = t.closest('[data-action="bulk-add-group"]');
      if (bulkAdd) { event.stopPropagation(); bulkAddGroup(); return true; }
      const bulkGroupBtn = t.closest('[data-action="bulk-group"]');
      if (bulkGroupBtn) { event.stopPropagation(); bulkGroup(bulkGroupBtn.dataset.group); return true; }
      if (t.closest('[data-action="clear-search-filters"]')) { event.stopPropagation(); if (a.clearFilters) a.clearFilters(); if (a.focusSearch) a.focusSearch(); return true; }
      // A clip's + (and, in a window bar, a group name) opens the shared group
      // picker. A strip without data-id is a new note that isn't a clip yet:
      // commit-on-add - the host's ensureClipId force-commits the draft and
      // returns the fresh content-addressed id.
      const tagAdd = t.closest('[data-action="tag-add"]');
      if (tagAdd) {
        event.stopPropagation();
        // A new note's ensureClipId() commits then refreshes the strip, replacing
        // this button in the DOM. Capture its anchor before awaiting so the picker
        // still opens beside the clicked + rather than at viewport origin.
        const r = tagAdd.getBoundingClientRect();
        const strip = tagAdd.closest('[data-id]');
        let id = strip ? strip.dataset.id : null;
        if (!id && a.ensureClipId) id = await a.ensureClipId();
        if (!id) { toast(a.emptyClipToast || 'Type something first'); return true; }
        openGroupPickerAt(id, r.left, r.bottom + 4, r.top - 4);
        return true;
      }
      // A clip's numpad badge / ghost # opens the keypad popover (a new note
      // commits first, like the +; the anchor is measured before that await).
      const npOpen = t.closest('[data-action="numpad-open"]');
      if (npOpen) {
        event.stopPropagation();
        const owner = npOpen.closest('[data-id]');
        const r = npOpen.getBoundingClientRect();
        let id = owner ? owner.dataset.id : null;
        if (!id && a.ensureClipId) id = await a.ensureClipId();
        if (!id) { toast(a.emptyClipToast || 'Type something first'); return true; }
        openNumpadPickerAt(id, r.left, r.bottom + 4, r.top - 4);
        return true;
      }
      const selSimilar = t.closest('[data-action="select-similar"]');
      if (selSimilar) { event.stopPropagation(); if (!selSimilar.disabled) selectSimilar(selSimilar.dataset.id); return true; }
      const ftag = t.closest(FILTER_TARGET);
      // A greyed chip (the availability census: it would show nothing) is inert.
      if (ftag && ftag.getAttribute('aria-disabled') === 'true') { event.stopPropagation(); return true; }
      if (ftag) { event.stopPropagation(); if (a.setFilterIntent) a.setFilterIntent(ftag.dataset.filter || ftag.dataset.group, 'include'); render(); return true; }
      // The empty-result nudge: one click rewrites the query without its blocker.
      const applyQuery = t.closest('[data-action="apply-query"]');
      if (applyQuery) { event.stopPropagation(); if (a.setQuery) a.setQuery(applyQuery.dataset.query || ''); render(); if (a.focusSearch) a.focusSearch(); return true; }
      const npRemove = t.closest('.np-remove');
      if (npRemove) { event.stopPropagation(); await a.numpadUnassign(Number(npRemove.dataset.slot)); refresh(); return true; }
      const slotEl = t.closest('.np-slot.has-content');
      if (slotEl && slotEl.dataset.slotId) { event.stopPropagation(); await a.copyNumpadSlot(slotEl.dataset.slotId); toast('Copied'); return true; }
      const share = t.closest('.gp-share');
      if (share) { event.stopPropagation(); await a.setGroupSharedAi(share.dataset.group); refresh(); return true; }
      const gpDel = t.closest('.gp-del');
      if (gpDel) { event.stopPropagation(); deleteGroup(gpDel.dataset.group); return true; }
      // A clip's group checklist (clip menu submenu, + / meta popovers): a row
      // toggles membership, "New group..." prompts then adds. The menu root
      // carries the clip's data-id.
      const groupRow = t.closest('[data-action="toggle-group"], [data-action="add-group"]');
      if (groupRow) {
        event.stopPropagation();
        const owner = groupRow.closest('[data-id]');
        if (!owner) return true;
        if (groupRow.dataset.action === 'add-group') addGroup(owner.dataset.id);
        else if (groupRow.dataset.group) { await a.toggleGroup(owner.dataset.id, groupRow.dataset.group); refresh(); }
        return true;
      }
      const npBtn = t.closest('.np-btn');
      if (npBtn) { event.stopPropagation(); const item = npBtn.closest('[data-id]'); if (item) tryAssignNumpad(item.dataset.id, Number(npBtn.dataset.n)); return true; }
      const pin = t.closest('[data-action="pin"]');
      if (pin) {
        event.stopPropagation();
        let id = pin.dataset.id || null;
        if (!id && a.ensureClipId) id = await a.ensureClipId();
        if (!id) { toast(a.emptyClipToast || 'Type something first'); return true; }
        await a.pin(id);
        refresh();
        return true;
      }
      // The row's primary open button is the "normal" open: a hand-off (the
      // popup closes, like before). Only the detached "..."/right-click MENU's
      // Open in editor / Open image keeps the popup, alongside middle/alt-click.
      const fromMenu = !!t.closest('.bc-menu-item');
      const openImg = t.closest('[data-action="open-img"]');
      if (openImg) { event.stopPropagation(); await a.openImage(a.itemById(openImg.dataset.id), fromMenu ? KEEP_POPUP : undefined); return true; }
      const openImgExt = t.closest('[data-action="open-img-ext"]');
      if (openImgExt) { event.stopPropagation(); if (a.openImageExternal) await a.openImageExternal(a.itemById(openImgExt.dataset.id)); return true; }
      const saveImg = t.closest('[data-action="save-img"]');
      if (saveImg) { event.stopPropagation(); toast(await a.saveImage(a.itemById(saveImg.dataset.id))); return true; }
      const edit = t.closest('[data-action="edit"]');
      if (edit) { event.stopPropagation(); await a.editClip(edit.dataset.id, edit.closest('.item'), fromMenu ? KEEP_POPUP : undefined); return true; }
      const rename = t.closest('[data-action="rename"]');
      if (rename) { event.stopPropagation(); await renameClip(rename.dataset.id); return true; }
      const revert = t.closest('[data-action="revert"]');
      if (revert) { event.stopPropagation(); if (a.revertClip) await a.revertClip(revert.dataset.id); return true; }
      const del = t.closest('[data-action="del"]');
      if (del) { event.stopPropagation(); await deleteIds([del.dataset.id]); return true; } // same instant-delete + Undo toast as bulk
      const item = t.closest('.item');
      if (item) { await a.activateClip(item.dataset.id); return true; }
      return false;
    }
    function onContextmenu(event) {
      // Right-click on the row's open button = open and KEEP the popup (no menu).
      const openBtn = event.target.closest && event.target.closest(OPEN_BTN_SEL);
      if (openBtn) {
        const row = openBtn.closest('.item');
        if (row && row.dataset && row.dataset.id) return openClipInEditor(event, row);
      }
      const ftag = event.target.closest(FILTER_TARGET);
      if (ftag) {
        event.preventDefault();
        event.stopPropagation();
        if (ftag.getAttribute('aria-disabled') === 'true') return true; // greyed: inert to right-click too
        if (a.setFilterIntent) a.setFilterIntent(ftag.dataset.filter || ftag.dataset.group, 'exclude');
        render();
        return true;
      }
      // Right-click a clip row -> the shared menu. Explorer-style: right-clicking
      // outside the current multi-selection collapses to just that row (single
      // menu); right-clicking within a 2+ selection keeps it (bulk menu).
      const row = event.target.closest('.item');
      if (row && row.dataset.id) {
        event.preventDefault();
        event.stopPropagation();
        if (!(selectedIds.size >= 2 && selectedIds.has(row.dataset.id))) {
          selectedIds.clear();
          anchorId = row.dataset.id;
          focusId = row.dataset.id;
          paintSelection();
        }
        openClipMenu(row, event.clientX, event.clientY);
        return true;
      }
      return false;
    }
    // Drag a clip out of the list into another app: image rows go out as image
    // FILES (the host's dragImages runs the native file drag), text rows as
    // text (plus its HTML when the clip has one). Grabbing a row that is part of
    // a 2+ selection drags every selected clip of the grabbed row's kind, in list
    // order. Presses on a row's own controls never start a drag.
    // The dragged row keeps its buttons out until the drag ends: dragend for a
    // page drag; for a host-run (native file) drag the page sees no drag
    // events, so the first pointer event after it (no button held) ends it.
    function holdWhileDragging(id) {
      if (typeof document === 'undefined') return;
      hold(id);
      const end = (e) => {
        if (e && e.type === 'pointermove' && e.buttons) return;
        document.removeEventListener('dragend', end, true);
        document.removeEventListener('pointermove', end, true);
        document.removeEventListener('pointerdown', end, true);
        if (heldId === id && !menu.isOpen()) hold(null);
      };
      document.addEventListener('dragend', end, true);
      document.addEventListener('pointermove', end, true);
      document.addEventListener('pointerdown', end, true);
    }
    function onDragstart(event) {
      const t = event.target && event.target.nodeType === 1 ? event.target : event.target && event.target.parentElement;
      const row = t && typeof t.closest === 'function' ? t.closest('.item') : null;
      if (!row || !row.dataset || !row.dataset.id) return false;
      if (t.closest('button, .star, [data-action], a, .filter-tag, .numpad-picker')) { event.preventDefault(); return true; }
      const item = a.itemById(row.dataset.id);
      if (!item) { event.preventDefault(); return true; }
      const isImage = item.type === 'image';
      const ids = selectedIds.size >= 2 && selectedIds.has(row.dataset.id)
        ? visibleIds().filter((id) => selectedIds.has(id))
        : [row.dataset.id];
      const items = ids.map((id) => a.itemById(id)).filter((it) => it && (it.type === 'image') === isImage);
      if (isImage) {
        // No host support -> no drag (a bare internal image URL is useless elsewhere).
        if (!a.dragImages || !a.dragImages(items.map(itemId), event)) event.preventDefault();
        else holdWhileDragging(row.dataset.id);
        return true;
      }
      const dt = event.dataTransfer;
      if (!dt) return false;
      dt.setData('text/plain', items.map((it) => String(it.text || '')).join('\n'));
      if (items.length === 1 && typeof items[0].html === 'string' && items[0].html) dt.setData('text/html', items[0].html);
      holdWhileDragging(row.dataset.id);
      // effectAllowed stays at its default ("all"): a text drop target that
      // asks for "move" (rich-text composers often do) must not be refused.
      // BoardClip ignores the result either way - nothing is ever removed.
      return true;
    }
    // Ctrl+wheel resizes image previews (never the page); hosts bind this on
    // the whole popup with { passive: false }.
    function onWheel(event) {
      if (!a.imageZoom) return false;
      return a.imageZoom.onWheel(event);
    }
    async function onKeydown(event) {
      // Ctrl+= / Ctrl+- / Ctrl+0 size image previews, even under a dialog: the
      // page itself must never zoom.
      if (a.imageZoom && a.imageZoom.onKeydown(event)) return;
      if (dialogs.isOpen() || menu.isOpen()) return; // dialogs/menu own their keys
      const mod = event.metaKey || event.ctrlKey;
      if (event.key === 'Escape') {
        if (a.closeSearchOptions && a.closeSearchOptions()) return; // an open options panel goes first
        if (clearSelection()) return; // then an active selection
        if (a.isSettingsOpen && a.isSettingsOpen()) { if (a.closeSettings) a.closeSettings(); }
        else if (a.hidePopup) a.hidePopup();
        return;
      }
      if (a.isSettingsOpen && a.isSettingsOpen()) return;
      if ((event.key === 'Enter' || event.key === ' ' || event.key === 'Spacebar') && !mod && !event.altKey && isActivatableControl(event.target)) return;
      // Ctrl/Cmd+A & +Z: the search box is focused nearly always in the app, so
      // route by whether the field actually has text — with text the chord means
      // the FIELD (native select-all / typing undo); empty, it means the LIST.
      const fieldHasText = isTypingTarget(event.target) && typeof event.target.value === 'string' && event.target.value.length > 0;
      if (mod && (event.key === 'z' || event.key === 'Z')) { if (!fieldHasText && lastUndo) { event.preventDefault(); lastUndo(); } return; }
      if (mod && (event.key === 'a' || event.key === 'A')) { if (!fieldHasText) { event.preventDefault(); selectAll(); } return; }
      // The menu key / Shift+F10 opens the cursor row's menu (the bulk menu on
      // a multi-selection) from the keyboard, its first row focused.
      if (event.key === 'ContextMenu' || (event.key === 'F10' && event.shiftKey && !mod && !event.altKey)) {
        const id = focusId || (selectedIds.size ? [...selectedIds][0] : null);
        const scope = a.menuHost || (typeof document !== 'undefined' ? document : null);
        const row = id && scope ? scope.querySelector(`.item[data-id="${String(id).replace(/["\\]/g, '\\$&')}"]`) : null;
        if (row) {
          event.preventDefault();
          const r = row.getBoundingClientRect();
          openClipMenu(row, r.right, r.top + Math.min(r.height, 28), r.top, true);
        }
        return;
      }
      if (event.key === 'ArrowDown') { event.preventDefault(); moveFocus(1, { extend: event.shiftKey }); }
      else if (event.key === 'ArrowUp') { event.preventDefault(); moveFocus(-1, { extend: event.shiftKey }); }
      // Delete while EDITING query text must stay a text edit (same fieldHasText
      // routing as the chords above); with an empty field it means the clips.
      else if (event.key === 'Delete') { if (selectedIds.size && !fieldHasText) { event.preventDefault(); deleteSelection(); } }
      else if (event.key === 'Backspace') { if (!isTypingTarget(event.target) && (selectedIds.size || focusId)) { event.preventDefault(); deleteSelection(); } }
      else if ((event.key === ' ' || event.key === 'Spacebar') && !isTypingTarget(event.target)) { if (focusId) { event.preventDefault(); toggleSelect(focusId); } }
      else if (event.key === 'Enter' && (mod || event.altKey)) {
        // Ctrl/Cmd+Enter or Alt+Enter → open focused clip in editor (or image viewer).
        event.preventDefault();
        const target = focusId || (visibleIds()[0] || null);
        if (target) {
          const item = a.itemById(target);
          if (item && item.type === 'image') { if (a.openImage) await a.openImage(item); }
          else if (item) { await a.editClip(target); }
        }
      }
      else if (event.key === 'Enter') {
        event.preventDefault();
        if (selectedIds.size >= 2) pasteSelection();
        else if (focusId) a.activateClip(focusId);
        else {
          // No focus yet: activate the FIRST visible clip — the "type, press
          // Enter, and paste" flow both popups are built around.
          const ids = visibleIds();
          if (ids.length) a.activateClip(ids[0]);
          else if (a.activateSelected) a.activateSelected();
        }
      }
    }
    return {
      dialogs,
      onClick,
      onMousedown,
      onMouseup,
      onAuxclick,
      onContextmenu,
      onKeydown,
      onWheel,
      onDragstart,
      onMouseover,
      onMouseout,
      deleteGroup,
      tryAssignNumpad,
      addGroup,
      clearAll,
      render,
      // Selection surface used by the consumers (numpad hotkey, popup reset, and
      // re-painting selection classes after a full list rebuild) + exposed for tests.
      selection: selectionInfo,
      focusedId: () => focusId,
      clearSelection,
      selectAll,
      moveFocus,
      toggle: toggleSelect,
      selectRange,
      repaintSelection: paintSelection,
      onQueryChange,
      reconcileVisible,
      openClipMenu: openClipMenuAt, // standalone editor/viewer windows open the same menu
      openRowMenu: openClipMenu, // a row's "..." menu (with Select N similar), e.g. for QA
      openGroupPicker: openGroupPickerAt, // title-bar strip's + popover (same picker as the menu submenu)
      openNumpadPicker: openNumpadPickerAt, // a row's numpad badge / ghost #
      // Similar clips: the painted target + set, and the "Select N similar" action.
      similar: () => ({ target: similarFor, ids: similarIds ? [...similarIds] : [] }),
      whenSimilar,
      selectSimilar,
      heldId: () => heldId,
      // The popup was hidden: the pointer is no longer over a row (its tint goes).
      forgetPointer: () => { if (hoverId != null) { hoverId = null; refreshSimilar(); } },
      // Popup hide/reset must not leave a stale popover, nor a chip's
      // top-layer submenu (popover="manual": nothing else closes it then).
      closeMenu: () => { menu.close(); closeTopLayerSubmenus(a.menuHost || (typeof document !== 'undefined' ? document : null)); },
    };
  }
  // Pure find helpers (shared by the editor's find bar). findAllMatches returns
  // every {start,end} span so the editor can navigate/count; countWords for the
  // footer stats. Kept pure so they're unit-testable without a DOM.
  function findAllMatches(text, query, regex) {
    const raw = String(text || '');
    const q = String(query || '');
    if (!q) return [];
    const out = [];
    try {
      const re = regex
        ? new RegExp(q, 'gi')
        : new RegExp(q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi');
      let m;
      let guard = 0;
      while ((m = re.exec(raw)) && guard < 100000) {
        if (m[0] === '') { re.lastIndex += 1; continue; }
        out.push({ start: m.index, end: m.index + m[0].length });
        guard += 1;
      }
    } catch { return []; }
    return out;
  }
  function countWords(text) {
    const t = String(text || '').trim();
    return t ? (t.match(/\S+/g) || []).length : 0;
  }
  // The editor footer's save state, recomputed from scratch on every change
  // (pure, so an undone edit can never leave a stale "Saving..."):
  // dirty = the buffer differs from its last write, inFlight = a write has not
  // landed yet, failed = the last write was refused, blank = the buffer is
  // empty (never written), hasSaved = something has been written.
  const EDITOR_SAVE_LABELS = { saving: 'Saving...', saved: 'Saved', failed: 'Not saved', blank: 'Empty, not saved' };
  function editorSaveState({ dirty, inFlight, failed, blank, hasSaved } = {}) {
    if (inFlight) return 'saving';
    if (dirty && failed) return 'failed';
    if (dirty) return blank ? 'blank' : 'saving';
    return hasSaved ? 'saved' : '';
  }
  function lineNumberAtIndex(text, index) {
    const raw = String(text || '');
    const end = Math.max(0, Math.min(Number(index) || 0, raw.length));
    let line = 0;
    for (let i = 0; i < end; i += 1) {
      if (raw.charCodeAt(i) === 10) line += 1;
    }
    return line;
  }
  function editorScrollTopForIndex(text, index, lineHeight, clientHeight, paddingTop) {
    const lh = Number(lineHeight) > 0 ? Number(lineHeight) : 18;
    const view = Number(clientHeight) > 0 ? Number(clientHeight) : 0;
    const pad = Number(paddingTop) > 0 ? Number(paddingTop) : 0;
    const lineTop = lineNumberAtIndex(text, index) * lh + pad;
    return Math.max(0, Math.floor(lineTop - view * 0.35));
  }
  // Shared updater for a clip window's bar, which createEditor and
  // createImageViewer expose as setTags(item, opts): the star before the title
  // and the keys strip after it (renderClipKeys, the row's own meta keys), so
  // pin, numpad key and groups look and work as they do in the list. Both carry
  // the clip's data-id, so the controller's pin / numpad-open / tag-add
  // resolve their target exactly like a row's. `item` null + {allowAdd:true}
  // is the new-note case (commit-on-add); null without it hides both (hosts
  // that never call setTags keep the bar bare).
  function updateTagStrip(strip, item, opts) {
    if (!strip) return;
    const o = opts || {};
    const id = item ? itemId(item) : null;
    const bar = strip.closest('.bc-bar');
    const star = bar ? bar.querySelector('[data-x="pin"]') : null;
    const shown = !!(id || o.allowAdd);
    for (const el of [strip, star]) {
      if (!el) continue;
      if (id) el.dataset.id = id; else delete el.dataset.id;
      el.hidden = !shown;
    }
    if (star) {
      const pinned = !!(item && isPinned(item));
      star.classList.toggle('active', pinned);
      star.title = pinned ? 'Unpin' : 'Pin';
      star.setAttribute('aria-label', star.title);
      star.setAttribute('aria-pressed', String(pinned));
      const glyph = star.querySelector('.mi');
      if (glyph) glyph.classList.toggle('filled', pinned);
    }
    strip.innerHTML = shown ? renderClipKeys(item, { inWindow: true }) : '';
    attachSideScroll(strip);
  }
  // ── ONE window bar (.bc-bar) for every clip window: the editor, the image
  // viewer and the merge view (unify + conflict), in the app's own windows and
  // in the demo's overlay. Left to right: an optional leading control (the
  // viewer's drag-out handle), a clip window's star (with `tags`: the row's
  // pin), the clip's own title (an editable flat field or plain text, sentence
  // case), an optional dim context label, the clip's keys strip (`tags`: its
  // numpad key and groups, as on the row's meta line), a spacer (the window's
  // drag region), the quiet actions. The app's windows
  // draw no close button: the OS controls replace it (attachWindowControls
  // reserves their room). The demo overlay has none, so it keeps one.
  //   o: { lead, title, context, tags, actions, close }
  function renderWindowBar(o) {
    const opts = o || {};
    const close = opts.close
      ? '<button class="icon-btn" type="button" data-x="close" title="Close (Esc)" aria-label="Close"><span class="mi">close</span></button>'
      : '';
    const star = opts.tags ? '<button class="star" type="button" data-x="pin" data-action="pin" title="Pin" aria-label="Pin" aria-pressed="false" hidden><span class="mi">star</span></button>' : '';
    return `<div class="bc-bar">${opts.lead || ''}${star}${opts.title || ''}`
      + (opts.context ? `<span class="bc-bar-context" data-x="context">${escapeHtml(opts.context)}</span>` : '')
      + (opts.tags ? '<div class="bc-tag-strip" data-x="tags" hidden></div>' : '')
      + `<span class="bc-bar-spacer"></span><div class="bc-bar-actions">${opts.actions || ''}${close}</div></div>`;
  }
  // The bar's editable title: a flat field sized to its text, so the rest of
  // the bar stays a drag region. An untitled clip shows its first line (or
  // "Untitled") dim, as the placeholder.
  function barTitleField(dataX, label) {
    return `<input class="bc-bar-title" data-x="${dataX}" type="text" maxlength="240" placeholder="Untitled" autocomplete="off" spellcheck="false" aria-label="${escapeHtml(label || 'Title')}" title="${escapeHtml(label || 'Title')}">`;
  }
  function untitledHint(text) {
    const t = String(text || '');
    const line = rowFirstLine(t);
    return line ? t.slice(line.start, Math.min(line.end, line.start + 160)).trim() : 'Untitled';
  }
  // Native window controls (the app's clip windows): main draws the OS's own
  // minimise / maximise-restore / close (Windows: caption buttons over the
  // bar's right end; macOS: the traffic lights at its left). The page reserves
  // their room (data-window-controls on <html>: Windows reads the Window
  // Controls Overlay env(titlebar-area-*), macOS takes the inset main sends)
  // and reports what the buttons sit on: the bar's height in CSS px, the first
  // OPAQUE surface under it (none under glass: the buttons stay clear) and its
  // text colour, resolved by painting them, again after every theme / accent /
  // surface / density change.
  //   wc: { side: 'left' | 'right', inset } (main's windowControlsInfo)
  //   report({ height, color: '#rrggbb' | '#00rrggbb' (Electron's alpha form), symbolColor })
  // Returns { refresh() }: call it after mounting a new bar.
  function attachWindowControls(wc, report) {
    const none = { refresh() {} };
    if (typeof document === 'undefined' || !wc) return none;
    const root = document.documentElement;
    root.dataset.windowControls = wc.side === 'left' ? 'left' : 'right';
    if (wc.side === 'left' && Number(wc.inset) > 0) root.style.setProperty('--wc-left', `${Math.round(Number(wc.inset))}px`);
    if (typeof report !== 'function') return none;
    const canvas = document.createElement('canvas');
    canvas.width = 1;
    canvas.height = 1;
    const ctx = canvas.getContext ? canvas.getContext('2d', { willReadFrequently: true }) : null;
    const rgba = (css) => {
      if (!ctx) return null;
      ctx.clearRect(0, 0, 1, 1);
      ctx.fillStyle = 'transparent';
      ctx.fillStyle = css;
      ctx.fillRect(0, 0, 1, 1);
      return Array.from(ctx.getImageData(0, 0, 1, 1).data);
    };
    const hex = (c) => c.slice(0, 3).map((v) => v.toString(16).padStart(2, '0')).join('');
    let last = '';
    let timer = null;
    function send() {
      timer = null;
      const bar = document.querySelector('.bc-bar');
      if (!bar) return;
      let surface = null;
      for (let el = bar; el; el = el.parentElement) {
        const c = rgba(getComputedStyle(el).backgroundColor);
        if (c && c[3] === 255) { surface = c; break; }
        if (c && c[3] > 0) break; // a translucent band (glass): clear buttons
      }
      const text = rgba(getComputedStyle(bar).color) || [0, 0, 0, 255];
      const darkText = text[0] * 0.299 + text[1] * 0.587 + text[2] * 0.114 < 128;
      const msg = {
        height: bar.clientHeight, // above its bottom hairline, which runs on under the buttons
        color: surface ? `#${hex(surface)}` : `#00${darkText ? 'ffffff' : '000000'}`,
        symbolColor: `#${hex(text)}`,
      };
      // Page zoom (main claims its chords in clip windows) or a move to a
      // display with another scale changes the DIP size main derives, not the
      // CSS height, so the scale is part of what counts as a change.
      const signature = JSON.stringify([msg, typeof window !== 'undefined' ? window.devicePixelRatio : 1]);
      if (signature === last || !msg.height) return;
      last = signature;
      report(msg);
    }
    const schedule = () => { if (!timer) timer = setTimeout(send, 0); };
    if (typeof MutationObserver !== 'undefined') new MutationObserver(schedule).observe(root, { attributes: true });
    window.addEventListener('resize', schedule);
    schedule();
    return { refresh: schedule };
  }
  // Shared plain-text editor — ONE implementation mounted by BOTH the desktop
  // app (in its own window) and the website demo (in an in-page overlay).
  // Edits are captured live: every keystroke fires onInput (the host persists
  // a crash-safe draft), and after a short idle / on blur / on close / on
  // Ctrl+S onCommit fires (the host writes the clip; the footer shows Saving...
  // until the write lands, then Saved). Find (Ctrl+F), word/char count,
  // revert-to-original (the clip menu), Tab-inserts-tab. The title is edited
  // in place in the shared .bc-bar. The host owns persistence; this owns UI.
  //   opts: { initialText, initialTitle, initialFocusTitle, idleMs, nativeControls,
  //           onInput(payload), onCommit(payload), onClose(), onMenu(x, y), clipboard,
  //           toastEl (the host's .toast: Revert offers Undo there) }
  // nativeControls: the window has the OS's own close (no close in the bar).
  function createEditor(opts) {
    if (typeof document === 'undefined') return null;
    const o = opts || {};
    const idleMs = o.idleMs || 1200;
    const originalText = String(o.initialText || '');
    const originalTitle = cleanTitle(o.initialTitle != null ? o.initialTitle : o.noteTitle);
    const root = document.createElement('div');
    root.className = 'bc-editor';
    root.innerHTML = `
      ${renderWindowBar({
        title: barTitleField('titleinput', 'Title (click to rename)'),
        tags: true,
        close: !o.nativeControls,
        actions: `<button class="icon-btn" type="button" data-x="find" title="Find (${modKeyLabel()}+F)" aria-label="Find"><span class="mi">search</span></button>${
          o.onMenu ? '<button class="icon-btn" type="button" data-x="menu" title="More actions" aria-label="More actions"><span class="mi">more_horiz</span></button>' : ''}`,
      })}
      <div class="bc-find" data-x="findbar" hidden>
        <input class="bc-find-input" type="text" placeholder="Find" spellcheck="false" autocomplete="off" data-x="findinput">
        <button class="icon-btn rx-btn" type="button" data-x="findregex" title="Regex find" aria-label="Regex find"><span class="mi">regular_expression</span></button>
        <span class="bc-find-count" data-x="findcount"></span>
        <button class="icon-btn" type="button" data-x="findprev" title="Previous (Shift+Enter)"><span class="mi">keyboard_arrow_up</span></button>
        <button class="icon-btn" type="button" data-x="findnext" title="Next (Enter)"><span class="mi">keyboard_arrow_down</span></button>
        <button class="icon-btn" type="button" data-x="findclose" title="Close (Esc)"><span class="mi">close</span></button>
      </div>
      <div class="bc-editor-area-wrap">
        <div class="bc-editor-hl" aria-hidden="true" data-x="findhl"></div>
        <textarea class="bc-editor-area" spellcheck="false" wrap="soft"></textarea>
      </div>
      <div class="bc-editor-foot">
        <span data-x="stats"></span>
        <span class="bc-editor-foot-end">
          ${o.clipboard ? '<span class="bc-editor-clip" data-x="clip"></span>' : ''}
          <span class="bc-save-state" data-x="savestate" aria-live="polite"></span>
        </span>
      </div>`;
    const q = (name) => root.querySelector(`[data-x="${name}"]`);
    const area = root.querySelector('.bc-editor-area');
    const titleInput = q('titleinput');
    const statsEl = q('stats');
    const saveStateEl = q('savestate');
    const findBar = q('findbar');
    const findInput = q('findinput');
    const findRegexBtn = q('findregex');
    const findCount = q('findcount');
    const findHl = q('findhl');
    area.value = originalText;
    titleInput.value = originalTitle;

    let idleTimer = null;
    let lastCommittedText = originalText;
    let lastCommittedTitle = originalTitle;
    let matches = [];
    let findIdx = -1;
    let findRegex = !!o.initialFindRegex;

    function payload() { return { text: area.value, title: cleanTitle(titleInput.value) }; }
    function emitInput() { if (o.onInput) o.onInput(payload()); }
    function updateRegexButton() { findRegexBtn.classList.toggle('active', findRegex); }
    // The bar's title field: an untitled note shows its first line, dim.
    function updateTitleHint() { titleInput.placeholder = untitledHint(area.value); }

    function updateStats() {
      const t = area.value;
      statsEl.textContent = `${countWords(t)} word${countWords(t) === 1 ? '' : 's'} · ${t.length.toLocaleString()} char${t.length === 1 ? '' : 's'}`;
    }
    // Live save state in the footer, derived from the buffer vs its last write
    // on every change (editorSaveState): an edit undone before the idle save
    // reads Saved again, an emptied note says it is not saved.
    let inFlight = 0;
    let lastFailed = false;
    const unsaved = () => area.value !== lastCommittedText || cleanTitle(titleInput.value) !== lastCommittedTitle;
    function refreshSaveState() {
      const state = editorSaveState({
        dirty: unsaved(),
        inFlight: inFlight > 0,
        failed: lastFailed,
        blank: !area.value.trim(),
        hasSaved: !!(lastCommittedText || lastCommittedTitle),
      });
      saveStateEl.className = `bc-save-state${state === 'failed' ? ' failed' : ''}`;
      saveStateEl.textContent = EDITOR_SAVE_LABELS[state] || '';
      if (state === 'failed') saveStateEl.title = 'The last save did not go through. Your next edit (or Ctrl+S) tries again.';
      else if (state === 'blank') saveStateEl.title = 'An empty note is not saved. The clip keeps its last text.';
      else saveStateEl.removeAttribute('title');
    }
    function commit() {
      if (idleTimer) { clearTimeout(idleTimer); idleTimer = null; }
      const next = payload();
      // Nothing new, or a blank buffer: the host never writes an empty note
      // (the clip keeps its last text; a new note starts at its first
      // non-blank save), so nothing is sent and lastCommitted stays put.
      if ((next.text === lastCommittedText && next.title === lastCommittedTitle) || !next.text.trim()) { refreshSaveState(); return undefined; }
      const prior = { text: lastCommittedText, title: lastCommittedTitle };
      lastCommittedText = next.text;
      lastCommittedTitle = next.title;
      lastFailed = false;
      // Return the host's result (a promise in the app) so commit-on-add flows
      // (the tag strip's ensureClipId) can await the write before re-querying.
      const result = o.onCommit ? o.onCommit(next) : undefined;
      if (result && typeof result.then === 'function') {
        inFlight += 1;
        refreshSaveState();
        result.then(() => { inFlight -= 1; refreshSaveState(); }, () => {
          inFlight -= 1;
          // Not written: the next commit (an edit, Ctrl+S, blur, close) retries it.
          if (lastCommittedText === next.text && lastCommittedTitle === next.title) { lastCommittedText = prior.text; lastCommittedTitle = prior.title; }
          lastFailed = true;
          refreshSaveState();
        });
      } else {
        refreshSaveState();
      }
      return result;
    }
    function scheduleCommit() {
      lastFailed = false;
      refreshSaveState();
      if (idleTimer) clearTimeout(idleTimer);
      idleTimer = setTimeout(commit, idleMs);
    }
    // Clipboard follow status (opt-in via o.clipboard = { following, onCopy }).
    // The host keeps the clipboard in step with the note while it holds the
    // note; the footer says so, or offers Copy to start it.
    const clipEl = q('clip');
    let clipNoticeTimer = null;
    function setClipboardState(state) {
      if (!clipEl) return;
      const s = state || {};
      clearTimeout(clipNoticeTimer);
      if (s.event === 'stopped' && !s.following) {
        clipEl.className = 'bc-editor-clip notice';
        clipEl.removeAttribute('title');
        clipEl.textContent = 'Clipboard changed elsewhere';
        clipNoticeTimer = setTimeout(() => setClipboardState({ following: false }), 2500);
        return;
      }
      if (s.following) {
        clipEl.className = 'bc-editor-clip on';
        clipEl.title = 'The clipboard holds this note, so every save updates it. Copying something else stops this.';
        clipEl.innerHTML = '<span class="mi sm">content_paste</span><span>On clipboard - edits update it</span>';
      } else {
        clipEl.className = 'bc-editor-clip';
        clipEl.removeAttribute('title');
        clipEl.innerHTML = '<button class="btn quiet sm bc-editor-copy" type="button" data-x="copy" title="Copy this note. While it stays on the clipboard, your edits keep it up to date."><span class="mi sm">content_copy</span>Copy</button>';
      }
    }
    if (clipEl) {
      setClipboardState({ following: !!o.clipboard.following });
      clipEl.addEventListener('click', async (e) => {
        if (!e.target.closest('[data-x="copy"]') || !o.clipboard.onCopy) return;
        commit();
        try { setClipboardState(await o.clipboard.onCopy(payload())); } catch {}
      });
    }
    // Save the moment the editor loses focus (the user switching to the app
    // they will paste into), not just after the idle pause.
    function onWindowBlur() {
      if (!root.isConnected) { window.removeEventListener('blur', onWindowBlur); return; }
      commit();
    }
    if (o.commitOnBlur !== false) window.addEventListener('blur', onWindowBlur);
    function insertAtCursor(s) {
      const start = area.selectionStart;
      const end = area.selectionEnd;
      area.value = area.value.slice(0, start) + s + area.value.slice(end);
      area.selectionStart = area.selectionEnd = start + s.length;
      area.dispatchEvent(new Event('input'));
    }
    function selectMatch(options) {
      if (findIdx < 0 || !matches[findIdx]) { findCount.textContent = findInput.value ? '0/0' : ''; return; }
      const m = matches[findIdx];
      const preserveFocus = options && options.preserveFocus;
      const active = preserveFocus ? document.activeElement : null;
      try { area.focus({ preventScroll: true }); } catch { area.focus(); }
      area.setSelectionRange(m.start, m.end);
      renderFindHighlights();
      scrollToCurrentMark();
      if (preserveFocus && active && active !== area && active.focus) {
        try { active.focus({ preventScroll: true }); } catch { active.focus(); }
      }
      findCount.textContent = `${findIdx + 1}/${matches.length}`;
    }
    // The textarea's own selection is invisible while focus stays in the find
    // input (Chrome doesn't paint selection in unfocused textareas), so matches
    // are highlighted via a backdrop div that mirrors the textarea's text with
    // <mark> spans — all matches marked, the current one emphasized (.cur).
    function syncHlScroll() { findHl.scrollTop = area.scrollTop; findHl.scrollLeft = area.scrollLeft; }
    // Scroll the current match into view. The textarea is soft-wrapped, so a
    // character index -> line count (editorScrollTopForIndex) undercounts wrapped
    // visual rows and lands short. The highlight backdrop mirrors the textarea
    // exactly, so the current <mark>'s measured offsetTop is the true visual
    // position (wrap/tab/font accurate). Fall back to the estimate only when the
    // backdrop is absent (huge-doc guard cleared it).
    function scrollToCurrentMark() {
      let target;
      const cur = findHl.querySelector('mark.cur');
      if (cur) {
        target = cur.offsetTop - Math.round(area.clientHeight * 0.35);
      } else {
        const m = matches[findIdx];
        if (!m) return;
        const style = window.getComputedStyle ? window.getComputedStyle(area) : null;
        const lineHeight = style ? parseFloat(style.lineHeight) : 0;
        const paddingTop = style ? parseFloat(style.paddingTop) : 0;
        target = editorScrollTopForIndex(area.value, m.start, lineHeight, area.clientHeight, paddingTop);
      }
      target = Math.max(0, Math.round(target));
      area.scrollTop = target;
      findHl.scrollTop = target;
    }
    function renderFindHighlights() {
      const raw = area.value;
      if (findBar.hidden || !matches.length || raw.length > 300000) {
        findHl.textContent = '';
        return;
      }
      let html = '';
      let pos = 0;
      for (let i = 0; i < matches.length; i += 1) {
        const m = matches[i];
        html += escapeHtml(raw.slice(pos, m.start));
        html += `<mark${i === findIdx ? ' class="cur"' : ''}>${escapeHtml(raw.slice(m.start, m.end))}</mark>`;
        pos = m.end;
      }
      html += escapeHtml(raw.slice(pos));
      findHl.innerHTML = `${html}\n`;
      syncHlScroll();
    }
    function recomputeMatches() {
      matches = findAllMatches(area.value, findInput.value, findRegex);
      if (!matches.length) { findIdx = -1; findCount.textContent = findInput.value ? '0/0' : ''; }
      else if (findIdx < 0 || findIdx >= matches.length) findIdx = 0;
      renderFindHighlights();
    }
    function step(dir) {
      if (!matches.length) return;
      findIdx = (findIdx + dir + matches.length) % matches.length;
      selectMatch({ preserveFocus: true });
    }
    function setFindQuery(query, options) {
      const opt = options || {};
      findBar.hidden = false;
      if (query != null) findInput.value = String(query || '');
      if (opt.regex != null) findRegex = !!opt.regex;
      updateRegexButton();
      findIdx = -1;
      recomputeMatches();
      selectMatch({ preserveFocus: true });
      findInput.focus();
      if (opt.select !== false) findInput.select();
    }
    function openFind(query, regex) {
      if (query != null) { setFindQuery(query, { regex, select: true }); return; }
      findBar.hidden = false;
      const sel = area.value.slice(area.selectionStart, area.selectionEnd);
      if (sel && !sel.includes('\n')) findInput.value = sel.slice(0, 120);
      updateRegexButton();
      findIdx = -1;
      recomputeMatches();
      selectMatch({ preserveFocus: true });
      findInput.focus();
      findInput.select();
    }
    function closeFind() { findBar.hidden = true; renderFindHighlights(); area.focus(); }

    area.addEventListener('input', () => {
      updateStats();
      updateTitleHint();
      emitInput();
      scheduleCommit();
      if (!findBar.hidden) { recomputeMatches(); }
    });
    area.addEventListener('scroll', syncHlScroll);
    titleInput.addEventListener('input', () => { emitInput(); scheduleCommit(); });
    area.addEventListener('keydown', (e) => {
      if (e.key === 'Tab') { e.preventDefault(); insertAtCursor('\t'); }
      else if ((e.ctrlKey || e.metaKey) && !e.shiftKey && e.key.toLowerCase() === 's') { e.preventDefault(); commit(); }
      else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'f') { e.preventDefault(); openFind(); }
    });
    titleInput.addEventListener('keydown', (e) => {
      if ((e.ctrlKey || e.metaKey) && !e.shiftKey && e.key.toLowerCase() === 's') { e.preventDefault(); commit(); }
      else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'f') { e.preventDefault(); openFind(); }
      else if (e.key === 'Enter') { e.preventDefault(); commit(); area.focus(); } // done naming: back to the text
    });
    findInput.addEventListener('input', () => { findIdx = -1; recomputeMatches(); selectMatch({ preserveFocus: true }); });
    findInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { e.preventDefault(); step(e.shiftKey ? -1 : 1); }
      else if (e.key === 'Escape') { e.preventDefault(); closeFind(); }
    });
    findRegexBtn.onclick = () => { findRegex = !findRegex; updateRegexButton(); findIdx = -1; recomputeMatches(); selectMatch({ preserveFocus: true }); findInput.focus(); };
    q('findprev').onclick = () => step(-1);
    q('findnext').onclick = () => step(1);
    q('findclose').onclick = closeFind;
    // Not `onclick = openFind`: the click event would arrive as the query and
    // fill the field with "[object MouseEvent]".
    q('find').onclick = () => openFind();
    // Opt-in clip menu (the app's editor window wires the shared clip menu here;
    // the demo's in-page editor overlay has no clip context so no button).
    const menuBtn = q('menu');
    if (menuBtn) menuBtn.onclick = (e) => { e.stopPropagation(); const r = menuBtn.getBoundingClientRect(); o.onMenu(r.right, r.bottom + 2); };
    // Back to the text and title the editor opened with (the clip menu's
    // "Revert to original"), committed at once. Setting the textarea's value
    // drops its own undo history, so the toast offers the Undo: the text and
    // title from just before, committed again.
    const setContent = (text, title) => { area.value = text; titleInput.value = title; updateStats(); updateTitleHint(); emitInput(); commit(); area.focus(); };
    const revert = () => {
      const before = { text: area.value, title: titleInput.value };
      if (before.text === originalText && cleanTitle(before.title) === originalTitle) return;
      setContent(originalText, originalTitle);
      if (o.toastEl) showActionToast(o.toastEl, { message: 'Reverted to the original', actionLabel: 'Undo', onAction: () => setContent(before.text, before.title) });
    };
    const closeBtn = q('close');
    if (closeBtn) closeBtn.onclick = () => { commit(); if (o.onClose) o.onClose(); };
    root.addEventListener('keydown', (e) => {
      if (e.key !== 'Escape') return;
      if (!findBar.hidden) { e.preventDefault(); e.stopPropagation(); closeFind(); }
      else { e.preventDefault(); e.stopPropagation(); commit(); if (o.onClose) o.onClose(); }
    });

    updateStats();
    updateTitleHint();
    updateRegexButton();
    refreshSaveState();
    const focusTitle = () => { titleInput.focus(); titleInput.select(); };
    setTimeout(() => {
      if (o.initialFocusTitle) focusTitle();
      else if (o.initialFind) openFind(o.initialFind, !!o.initialFindRegex);
      else area.focus();
    }, 0);
    return {
      el: root,
      getText: () => area.value,
      getTitle: () => cleanTitle(titleInput.value),
      getValue: payload,
      setText: (t) => { area.value = String(t || ''); updateStats(); updateTitleHint(); },
      // A title set from outside (the clip menu's Rename) shows in the bar at once.
      setTitle: (t) => { titleInput.value = cleanTitle(t); },
      // Title-bar tag strip (shared with the viewer): the clip's groups as
      // removable chips + a "+" opening the group picker. Host calls this after
      // init and after every mutation/commit (the clip id is content-addressed).
      setTags: (item, tagOpts) => updateTagStrip(q('tags'), item, tagOpts),
      setClipboardState,
      commit,
      focus: () => area.focus(),
      focusTitle,
      openFind,
      revert,
    };
  }
  // Shared in-app IMAGE VIEWER — the image twin of createEditor, mounted by the
  // app's viewer window (viewer.html). Same chrome (the shared .bc-bar + foot)
  // so the two windows read as one family. Interactions: fit-to-window (default),
  // click toggles fit⇄100%, wheel zooms around the cursor, drag pans when
  // zoomed; the footer's zoom out / percentage / zoom in / Fit / 100% do the
  // same from buttons (and zoomKey from Ctrl/Cmd+= / - / 0). With onDragOut,
  // the image glyph at the bar's leading edge is the file itself, like a
  // macOS title-bar proxy icon: drag it into another app or a folder.
  //   opts: { src, title, nativeControls, onMenu(x,y), onClose(), onDragOut() }
  // Returns { el, setSrc, setTitle, setTags, zoomKey, focus }.
  function createImageViewer(opts) {
    if (typeof document === 'undefined') return null;
    const o = opts || {};
    const root = document.createElement('div');
    root.className = 'bc-viewer';
    root.tabIndex = -1;
    const mod = modKeyLabel();
    root.innerHTML = `
      ${renderWindowBar({
        lead: o.onDragOut ? '<span class="bc-drag-handle" data-x="drag" draggable="true" role="button" title="Drag the image into another app or a folder" aria-label="Drag the image out"><span class="mi">image</span></span>' : '',
        title: '<span class="bc-bar-title" data-x="title"></span>',
        tags: true,
        close: !o.nativeControls,
        actions: '<button class="icon-btn" type="button" data-x="menu" title="More actions" aria-label="More actions"><span class="mi">more_horiz</span></button>',
      })}
      <div class="bc-viewer-stage" data-x="stage"><img class="bc-viewer-img" data-x="img" alt="clip image" draggable="false"></div>
      <div class="bc-editor-foot">
        <span data-x="dims"></span>
        <span class="bc-editor-foot-end bc-zoom">
          <button class="icon-btn" type="button" data-x="zoomout" title="Zoom out (${mod}+-)" aria-label="Zoom out"><span class="mi">zoom_out</span></button>
          <span class="bc-zoom-pct" data-x="zoom"></span>
          <button class="icon-btn" type="button" data-x="zoomin" title="Zoom in (${mod}+=)" aria-label="Zoom in"><span class="mi">zoom_in</span></button>
          <button class="btn quiet sm" type="button" data-x="fit" title="Fit to the window (${mod}+0)">Fit</button>
          <button class="btn quiet sm" type="button" data-x="actual" title="Actual size">100%</button>
        </span>
      </div>`;
    const q = (name) => root.querySelector(`[data-x="${name}"]`);
    const stage = q('stage');
    const img = q('img');
    const dimsEl = q('dims');
    const zoomEl = q('zoom');
    const titleEl = q('title');
    titleEl.textContent = o.title || 'Image';

    // Transform state: scale + translate applied to the image (origin 0 0).
    let nw = 0, nh = 0;          // natural image size
    let scale = 1, tx = 0, ty = 0;
    let fitMode = true;          // true = track window size
    function fitScale() {
      const cw = stage.clientWidth, ch = stage.clientHeight;
      if (!nw || !nh || !cw || !ch) return 1;
      return Math.min(cw / nw, ch / nh, 1); // never blow up a small image to "fit"
    }
    // Keep the image on-screen: center any axis it doesn't fill; clamp pan otherwise.
    function clamp() {
      const cw = stage.clientWidth, ch = stage.clientHeight;
      const w = nw * scale, h = nh * scale;
      tx = w <= cw ? (cw - w) / 2 : Math.min(0, Math.max(cw - w, tx));
      ty = h <= ch ? (ch - h) / 2 : Math.min(0, Math.max(ch - h, ty));
    }
    const isPannable = () => nw * scale > stage.clientWidth || nh * scale > stage.clientHeight;
    function paint() {
      clamp();
      img.style.transform = `translate(${tx}px, ${ty}px) scale(${scale})`;
      const pannable = isPannable();
      stage.style.cursor = pannable ? 'grab' : (fitMode && fitScale() < 1 ? 'zoom-in' : 'default');
      zoomEl.textContent = nw ? `${Math.round(scale * 100)}%` : '';
      // The footer controls say which view this is (Fit / 100%) and stop at the limits.
      q('fit').classList.toggle('active', !!nw && fitMode);
      q('actual').classList.toggle('active', !!nw && !fitMode && Math.abs(scale - 1) < 0.001);
      q('zoomin').disabled = !nw || scale >= ZOOM_MAX - 0.001;
      q('zoomout').disabled = !nw || scale <= zoomMin() + 0.001;
    }
    function applyFit() {
      fitMode = true;
      scale = fitScale();
      paint();
    }
    const ZOOM_MAX = 8;
    const zoomMin = () => Math.min(fitScale(), 1) * 0.5;
    function zoomAt(cx, cy, nextScale) {
      const s = Math.max(Math.min(nextScale, ZOOM_MAX), zoomMin());
      // keep the stage point (cx,cy) anchored on the same image pixel
      tx = cx - ((cx - tx) / scale) * s;
      ty = cy - ((cy - ty) / scale) * s;
      scale = s;
      fitMode = false;
      paint();
    }
    // Buttons / keys zoom around the stage centre, one wheel notch at a time.
    const zoomCentre = (factor) => { if (nw) zoomAt(stage.clientWidth / 2, stage.clientHeight / 2, scale * factor); };
    const actualSize = () => { if (nw) zoomAt(stage.clientWidth / 2, stage.clientHeight / 2, 1); };
    function zoomKey(act) {
      if (act === 'in') zoomCentre(1.2);
      else if (act === 'out') zoomCentre(1 / 1.2);
      else if (act === 'reset' && nw) applyFit();
    }
    img.addEventListener('load', () => {
      nw = img.naturalWidth; nh = img.naturalHeight;
      dimsEl.textContent = nw ? `${nw} × ${nh} px` : '';
      applyFit();
    });
    stage.addEventListener('wheel', (e) => {
      if (!nw) return;
      e.preventDefault();
      const rect = stage.getBoundingClientRect();
      zoomAt(e.clientX - rect.left, e.clientY - rect.top, scale * (e.deltaY < 0 ? 1.2 : 1 / 1.2));
    }, { passive: false });
    // Pointer: drag pans (when pannable); a still click toggles fit ⇄ 100% at the point.
    // With o.onDragOut, a drag on an image that fits (or any Alt+drag) pulls the
    // image OUT instead: the img turns natively draggable for that press only and
    // its dragstart hands over to the host (a native file drag).
    let down = null, moved = false;
    stage.addEventListener('pointerdown', (e) => {
      if (e.button !== 0) return;
      const out = !!o.onDragOut && nw > 0 && (!isPannable() || e.altKey);
      img.draggable = out;
      down = { x: e.clientX, y: e.clientY, tx, ty, out };
      moved = false;
      if (!out) stage.setPointerCapture(e.pointerId);
    });
    stage.addEventListener('pointercancel', () => { down = null; moved = false; paint(); });
    stage.addEventListener('pointermove', (e) => {
      if (!down || down.out) return;
      const dx = e.clientX - down.x, dy = e.clientY - down.y;
      if (Math.abs(dx) + Math.abs(dy) > 4) moved = true;
      if (moved) {
        tx = down.tx + dx; ty = down.ty + dy;
        stage.style.cursor = 'grabbing';
        paint();
      }
    });
    stage.addEventListener('pointerup', (e) => {
      const wasDrag = moved;
      down = null; moved = false;
      if (wasDrag) { paint(); return; }
      if (!nw) return;
      const rect = stage.getBoundingClientRect();
      if (fitMode && fitScale() < 1) zoomAt(e.clientX - rect.left, e.clientY - rect.top, 1);
      else applyFit();
    });
    if (typeof ResizeObserver !== 'undefined') {
      const ro = new ResizeObserver(() => { if (fitMode) applyFit(); else paint(); });
      ro.observe(stage);
    }
    // The title-bar handle always drags out; the image only when this press
    // was a drag-out press (never in the middle of a pan).
    root.addEventListener('dragstart', (e) => {
      const fromHandle = !!e.target.closest && !!e.target.closest('[data-x="drag"]');
      e.preventDefault();
      if (!o.onDragOut || (!fromHandle && !(down && down.out))) return;
      down = null;
      moved = false;
      o.onDragOut();
    });
    q('menu').onclick = (e) => {
      e.stopPropagation();
      const r = q('menu').getBoundingClientRect();
      if (o.onMenu) o.onMenu(r.right, r.bottom + 2);
    };
    q('zoomin').onclick = () => zoomKey('in');
    q('zoomout').onclick = () => zoomKey('out');
    q('fit').onclick = () => { if (nw) applyFit(); };
    q('actual').onclick = actualSize;
    const closeBtn = q('close');
    if (closeBtn) closeBtn.onclick = () => { if (o.onClose) o.onClose(); };
    root.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); if (o.onClose) o.onClose(); }
    });
    if (o.src) img.src = o.src;
    paint();
    return {
      el: root,
      setSrc: (src) => { if (img.src !== src) img.src = src; },
      setTitle: (t) => { titleEl.textContent = t || 'Image'; },
      // Same title-bar tag strip as createEditor (updateTagStrip is shared).
      setTags: (item, tagOpts) => updateTagStrip(q('tags'), item, tagOpts),
      // 'in' | 'out' | 'reset' (Ctrl/Cmd+= / - / 0, claimed by the app's main).
      zoomKey,
      focus: () => root.focus(),
    };
  }
  // Generic LCS diff over token arrays (lines OR words) — the ONE diff engine
  // behind the reconciliation view in the app editor window AND the website demo
  // (no `diff` npm dependency in the browser). `keyOf` normalizes tokens for
  // MATCHING only (display always uses the originals — that's how whitespace-
  // insensitive matching still shows each side verbatim). Common prefix/suffix
  // trimmed; past the DP budget the middle degrades to one opaque change block.
  function lcsSegments(aArr, bArr, keyOf) {
    const key = keyOf || ((x) => x);
    const ka = aArr.map(key);
    const kb = bArr.map(key);
    let start = 0;
    while (start < ka.length && start < kb.length && ka[start] === kb[start]) start += 1;
    let endA = ka.length;
    let endB = kb.length;
    while (endA > start && endB > start && ka[endA - 1] === kb[endB - 1]) { endA -= 1; endB -= 1; }
    const segs = [];
    const pushSame = (aL, bL) => { if (aL.length) segs.push({ same: true, a: aL, b: bL }); };
    const pushChange = (aL, bL) => { if (aL.length || bL.length) segs.push({ same: false, a: aL, b: bL }); };
    pushSame(aArr.slice(0, start), bArr.slice(0, start));
    const midA = aArr.slice(start, endA);
    const midB = bArr.slice(start, endB);
    const mka = ka.slice(start, endA);
    const mkb = kb.slice(start, endB);
    const n = midA.length;
    const m = midB.length;
    if (n || m) {
      if (!n || !m || n * m > 2000000) {
        pushChange(midA, midB);
      } else {
        const W = m + 1;
        const dp = new Uint32Array((n + 1) * W);
        for (let i = n - 1; i >= 0; i -= 1) {
          for (let j = m - 1; j >= 0; j -= 1) {
            dp[i * W + j] = mka[i] === mkb[j]
              ? dp[(i + 1) * W + j + 1] + 1
              : Math.max(dp[(i + 1) * W + j], dp[i * W + j + 1]);
          }
        }
        let i = 0;
        let j = 0;
        let sameA = [];
        let sameB = [];
        let delRun = [];
        let addRun = [];
        const flushChange = () => { if (delRun.length || addRun.length) { pushChange(delRun, addRun); delRun = []; addRun = []; } };
        const flushSame = () => { if (sameA.length) { pushSame(sameA, sameB); sameA = []; sameB = []; } };
        while (i < n && j < m) {
          if (mka[i] === mkb[j]) { flushChange(); sameA.push(midA[i++]); sameB.push(midB[j++]); }
          else { flushSame(); if (dp[(i + 1) * W + j] >= dp[i * W + j + 1]) delRun.push(midA[i++]); else addRun.push(midB[j++]); }
        }
        flushSame();
        while (i < n) delRun.push(midA[i++]);
        while (j < m) addRun.push(midB[j++]);
        flushChange();
      }
    }
    pushSame(aArr.slice(endA), bArr.slice(endB));
    return segs;
  }
  // Whitespace-insensitive line key: clips of the same text routinely differ in
  // CRLF vs LF, trailing spaces, and indentation depending on where they were
  // copied from — those must not defeat the diff.
  const WS_LINE_KEY = (line) => line.replace(/\s+/g, ' ').trim();
  function diffLineHunks(leftText, rightText, opts) {
    const ignoreWs = !opts || opts.ignoreWhitespace !== false; // default ON
    const a = String(leftText || '').split(/\r?\n/);
    const b = String(rightText || '').split(/\r?\n/);
    return lcsSegments(a, b, ignoreWs ? WS_LINE_KEY : null).map((seg) => seg.same
      ? { type: 'same', lines: seg.a, leftLines: seg.a, rightLines: seg.b }
      : { type: 'change', leftLines: seg.a, rightLines: seg.b });
  }
  // Union-merge two texts: identical regions once, differing regions as
  // current-then-incoming. Seeds a Unify step's Result (nothing silently
  // dropped) and backs the "Keep both" action.
  function unionMergeText(leftText, rightText) {
    return diffLineHunks(leftText, rightText)
      .flatMap((seg) => seg.type === 'same' ? seg.lines : [...seg.leftLines, ...seg.rightLines])
      .join('\n');
  }
  // Would replacing `leftText` (a Result chunk) with `rightText` (the incoming
  // side of the same chunk) lose anything? Lossless when the left side is blank
  // (a pure insertion) or every non-blank left line still occurs in the right
  // text - the successive-edit case (a line grew, a paragraph was appended). A
  // reworded or unrelated block is NOT lossless and stays a decision.
  function losslessChange(leftText, rightText) {
    const norm = (s) => String(s == null ? '' : s).replace(/\s+/g, ' ').trim();
    const right = norm(rightText);
    const leftLines = String(leftText == null ? '' : leftText).split(/\r?\n/).map(norm).filter(Boolean);
    if (!leftLines.length) return true;
    if (!right) return false;
    return leftLines.every((line) => right.includes(line));
  }
  // Same line, reworded? At least half the words shared (or one contains the
  // other), so "ship the beta friday" ~ "ship the beta on monday".
  function similarLine(a, b) {
    const words = (s) => new Set(String(s).toLowerCase().match(/[\p{L}\p{N}]+/gu) || []);
    const wa = words(a);
    const wb = words(b);
    if (!wa.size || !wb.size) return String(a).trim() === String(b).trim();
    let shared = 0;
    for (const w of wa) if (wb.has(w)) shared += 1;
    return shared / Math.max(wa.size, wb.size) >= 0.5 || String(a).includes(String(b)) || String(b).includes(String(a));
  }
  // The automatic merge of one 2-way chunk (Result side vs Incoming side, no
  // common base to consult), decided line by line - a diff chunk often lumps a
  // line Incoming lacks together with an Incoming addition:
  //   Incoming adds lines        -> taken
  //   Incoming lacks lines       -> kept (a stale copy missing lines looks
  //                                 exactly like this; never delete silently)
  //   Incoming rewords/grows one -> taken (every Result line has a counterpart)
  //   unrelated lines collide    -> 'conflict', a person has to pick
  // Returns { verdict: 'apply' | 'keep' | 'conflict', text } where `text` is the
  // merged chunk for 'apply' ('keep' = Result already is the answer).
  function smartMergeChunk(resultText, incomingText) {
    const norm = (s) => s.replace(/\s+/g, ' ').trim();
    const content = (lines) => lines.map(norm).filter(Boolean);
    let changed = false;
    const out = [];
    for (const seg of diffLineHunks(resultText, incomingText)) {
      if (seg.type === 'same') { out.push(...seg.leftLines); continue; }
      const mine = content(seg.leftLines);
      const theirs = content(seg.rightLines);
      if (!theirs.length) { out.push(...seg.leftLines); continue; }
      const taken = !mine.length
        || losslessChange(seg.leftLines.join('\n'), seg.rightLines.join('\n'))
        || mine.every((line) => theirs.some((other) => similarLine(line, other)));
      if (!taken) return { verdict: 'conflict', text: null };
      out.push(...seg.rightLines);
      changed = true;
    }
    return changed ? { verdict: 'apply', text: out.join('\n') } : { verdict: 'keep', text: null };
  }
  // IntelliJ-style merge built on the vendored CodeMirror 5 merge addon
  // (site/shared/vendor/cm5, loaded by BOTH editor.html and the demo).
  //
  // TWO layouts from ONE builder, chosen by the record:
  //  - 2-pane (default; unify + baseless conflicts): Result (EDITABLE, seeded
  //    with Current) LEFT | Incoming (read-only) RIGHT — the IntelliJ 1<>1
  //    apply-changes view. Curved SVG connectors join each chunk across the
  //    gap, carrying an apply arrow AND a decline (x) per chunk.
  //  - 3-pane (only when the record has a true base): Current | Result (base-
  //    seeded, editable) | Incoming — the IntelliJ 1<>target<>1 merge.
  // connect stays DEFAULT (svg connectors); 'align' is deliberately avoided —
  // it disables connectors and breaks scrolling with lineWrapping+collapse.
  //
  // Whitespace handling: the addon's ignoreWhitespace only covers spaces/tabs
  // (extending its diff splice to newlines corrupts line bookkeeping), so
  // blank-line-only chunks are QUIETED at chunk level via the vendored
  // chunkState hook: not drawn, not counted, excluded from nav/merge-all/save.
  // Declined chunks keep a dimmed dashed connector and are excluded the same
  // way (tracked by what the change is, declineKeyOf: the diff re-aligns its
  // chunks when a neighbour is taken, so coordinates do not hold).
  function createReconciliationView(opts) {
    if (typeof document === 'undefined') return null;
    const o = opts || {};
    const record = o.record || {};
    const left = record.left || {};
    const right = record.right || {};
    // Keep the RAW texts for verbatim accept actions; feed LF-normalized copies
    // to the merge view (stray \r defeats chunking and identical-collapse).
    const rawLeft = String(left.text || '');
    const rawRight = String(right.text || '');
    const toLF = (t) => String(t == null ? '' : t).replace(/\r\n?/g, '\n');
    const leftText = toLF(rawLeft);
    const rightText = toLF(rawRight);
    const threeWay = !!(record.base && record.base.text != null);
    const CM = typeof window !== 'undefined' && window.CodeMirror && window.CodeMirror.MergeView ? window.CodeMirror : null;
    // Result seed: the true base for a 3-way merge, else Current (pull Incoming
    // hunks in via the connectors; the save guard catches unhandled ones).
    const seed = threeWay ? toLF(record.base.text) : leftText;
    let ignoreWs = true;

    const root = document.createElement('div');
    root.className = 'bc-reconcile';
    const lTitle = titleOf(left);
    const rTitle = titleOf(right);
    // The result's title is the bar's title field (shown once). When the two
    // sides' titles differ, each read-only pane head offers its title as a
    // one-click pick; the whole-side accepts sit at the end of the head of the
    // pane they take. In 2-pane mode the left pane is Current, edited in place
    // into the result.
    const titlesDiffer = (lTitle || rTitle) && lTitle !== rTitle;
    // In a narrow head the accept keeps only its glyph (a container query on
    // the head, clipboard-popup.css) so a title pick stays readable; the
    // tooltip always carries the full action, and the pick's its full title.
    const headCell = (label, side, title, accept, tip) => `<div class="bc-merge-head"${side ? ` data-side="${side}"` : ''}>`
      + `<span class="bc-head-label"${tip ? ` title="${escapeHtml(tip)}"` : ''}>${label}</span>`
      + (titlesDiffer && side ? `<button type="button" class="bc-head-title" data-title-pick="${escapeHtml(title)}" title="${escapeHtml(`Use this title: ${title || 'Untitled'}`)}">${escapeHtml(title || 'Untitled')}</button>` : '')
      + (accept ? `<button type="button" class="btn quiet sm accent bc-head-accept" data-x="${side}" title="${escapeHtml(`${accept.label}: ${accept.tip}`)}" aria-label="${escapeHtml(accept.label)}"><span class="mi sm">done_all</span><span class="bc-accept-label">Accept</span></button>` : '')
      + '</div>';
    const gap = '<span class="bc-merge-heads-gap"></span>';
    const takeCurrent = { label: 'Accept current', tip: 'finish with the current text as it is, without the incoming changes' };
    const takeIncoming = { label: 'Accept incoming', tip: 'finish with the incoming text as it is' };
    // A multi-step Unify says where it is in the footer (never truncated
    // there; the bar's context label gives way first in a narrow window).
    const step = record.step && Number(record.step.of) > 1 ? record.step : null;
    const headsHtml = threeWay
      ? headCell('Current', 'left', lTitle, takeCurrent) + gap + headCell('Result', '', '', null) + gap + headCell('Incoming', 'right', rTitle, takeIncoming)
      : headCell('Current', 'left', lTitle, takeCurrent, 'Edit this pane: it is the result') + gap + headCell('Incoming', 'right', rTitle, takeIncoming);
    root.innerHTML = `
      ${renderWindowBar({
        title: barTitleField('title', 'Title of the merged clip'),
        context: record.title || o.title || 'Sync conflict',
        close: !o.nativeControls,
        actions: `<span class="bc-chg-count" data-x="chgcount"></span>
          <button class="icon-btn" type="button" data-x="prevchg" title="Previous change (Alt+Up)" aria-label="Previous change"><span class="mi">keyboard_arrow_up</span></button>
          <button class="icon-btn" type="button" data-x="nextchg" title="Next change (Alt+Down)" aria-label="Next change"><span class="mi">keyboard_arrow_down</span></button>
          <button class="icon-btn" type="button" data-x="mergeall" title="Merge all non-conflicting" aria-label="Merge all non-conflicting"><span class="mi">call_merge</span></button>
          <button class="icon-btn" type="button" data-x="ws" title="Ignore whitespace differences" aria-label="Ignore whitespace differences"><span class="mi">space_bar</span></button>`,
      })}
      <div class="bc-merge-heads ${threeWay ? 'bc-heads-3' : 'bc-heads-2'}">${headsHtml}</div>
      <div class="bc-merge-note" data-x="note" hidden></div>
      <div class="bc-merge-host" data-x="host"></div>
      <div class="bc-reconcile-actions" data-x="actions">
        ${step ? `<span class="bc-step" data-x="step">Step ${Number(step.at)} of ${Number(step.of)}</span>` : ''}
        <button type="button" class="btn" data-x="both" title="Keep both sides of every change">Keep both</button>
        ${record.unify ? '' : '<button type="button" class="btn discard" data-x="remove" title="Dismiss this conflict and leave the clip as it is">Remove conflict</button>'}
        <button type="button" class="btn primary" data-x="save">${escapeHtml(record.saveLabel || 'Save merged')}</button>
      </div>`;
    const q = (name) => root.querySelector(`[data-x="${name}"]`);
    const dialogs = createDialogs(root);
    const titleInput = q('title');
    const host = q('host');
    const initial = record.result || {};
    titleInput.value = cleanTitle(initial.title != null ? initial.title : (rTitle || lTitle));
    titleInput.placeholder = untitledHint(seed);
    titleInput.addEventListener('keydown', (event) => { if (event.key === 'Enter') { event.preventDefault(); if (mv) mv.editor().focus(); } });
    root.querySelector('.bc-merge-heads').addEventListener('click', (event) => {
      const pick = event.target.closest('[data-title-pick]');
      if (pick) titleInput.value = pick.dataset.titlePick;
    });

    // ---- CodeMirror MergeView (plain-textarea fallback if vendor missing) ----
    let mv = null;
    let fallbackArea = null;
    let navIdx = -1;
    let statusTimer = null;
    let lineClassHandles = [];
    let changeTotal = null;        // real changes the view was built with (the counter's total)
    let takenBeforeRebuild = 0;    // changes already taken when the whitespace toggle rebuilt the view
    let lastChangeCount = 0;
    const declinedKeys = new Set(); // declineKeyOf: WHAT a dismissed change is, not where
    const currentText = () => mv ? mv.editor().getValue() : (fallbackArea ? fallbackArea.value : seed);
    const keyOf = (side, chunk) => `${side}:${chunk.origFrom}-${chunk.origTo}`;
    // A dismissed change is remembered by its content: the lines only the
    // Result has and the lines only the other pane has (multisets, sorted).
    // The addon's character diff re-aligns its chunks whenever a neighbouring
    // change is taken, so a chunk's coordinates, even its exact line span, can
    // move under a dismissal that must stay (taking a conflict next to a kept
    // line used to re-open that line).
    function declineKeyOf(dv, chunk) {
      const r = chunkRanges(dv, chunk);
      const editLines = dv.edit.getRange(r.editStart, r.editEnd).split('\n').filter(Boolean);
      const origLines = dv.orig.getRange(r.origStart, r.origEnd).split('\n').filter(Boolean);
      const onlyOrig = [];
      for (const line of origLines) {
        const at = editLines.indexOf(line);
        if (at >= 0) editLines.splice(at, 1); else onlyOrig.push(line);
      }
      return `${dv.type}:${editLines.sort().join('\n')}\u0000${onlyOrig.sort().join('\n')}`;
    }
    const isDeclined = (dv, chunk) => declinedKeys.has(declineKeyOf(dv, chunk));
    function chunkRanges(dv, chunk) {
      const Pos = CM.Pos;
      return {
        origStart: chunk.origTo > dv.orig.lastLine() ? Pos(chunk.origFrom - 1) : Pos(chunk.origFrom, 0),
        origEnd: Pos(chunk.origTo, 0),
        editStart: chunk.editTo > dv.edit.lastLine() ? Pos(chunk.editFrom - 1) : Pos(chunk.editFrom, 0),
        editEnd: Pos(chunk.editTo, 0),
      };
    }
    // A chunk is "quiet" (whitespace-only) when its two sides are IDENTICAL once
    // whitespace is normalized — this covers both blank-vs-blank AND a shared
    // content line that differs only by surrounding blank lines (the addon's own
    // ignoreWhitespace handles spaces/tabs but NOT blank lines, so those survive
    // as chunks the diff would otherwise count).
    const wsNorm = (s) => String(s).replace(/\s+/g, ' ').trim();
    function wsEqualChunk(dv, chunk) {
      const r = chunkRanges(dv, chunk);
      return wsNorm(dv.orig.getRange(r.origStart, r.origEnd)) === wsNorm(dv.edit.getRange(r.editStart, r.editEnd));
    }
    // Vendored chunkState hook: how a chunk is drawn (see cm5/README patches).
    function chunkState(dv, chunk) {
      if (ignoreWs && wsEqualChunk(dv, chunk)) return 'quiet';
      if (isDeclined(dv, chunk)) return 'declined';
      if (conflictKeys.has(keyOf(dv.type, chunk))) return 'conflict'; // red connector, like its lines
      return null;
    }
    let conflictKeys = new Set(); // chunks inside a conflict, from the last survey (updateStatus)
    // One classified pass over both sides' chunks: quiet skipped, declined
    // separated, 3-pane conflicts = active left/right chunks touching the same
    // Result lines (merged into regions).
    function survey() {
      const out = { changes: 0, pending: [], declined: 0, quiet: [], conflicts: [], conflictKeys: new Set(), activeBySide: { left: [], right: [] } };
      if (!mv) return out;
      for (const dv of [mv.left, mv.right]) {
        if (!dv) continue;
        const chunks = (dv.type === 'left' ? mv.leftChunks() : mv.rightChunks()) || [];
        for (const chunk of chunks) {
          if (ignoreWs && wsEqualChunk(dv, chunk)) { out.quiet.push({ dv, chunk }); continue; }
          out.changes += 1;
          out.activeBySide[dv.type].push(chunk);
          if (isDeclined(dv, chunk)) { out.declined += 1; continue; }
          const p = { side: dv.type, dv, chunk };
          if (!threeWay) {
            const r = chunkRanges(dv, chunk);
            const smart = smartMergeChunk(dv.edit.getRange(r.editStart, r.editEnd), dv.orig.getRange(r.origStart, r.origEnd));
            p.verdict = smart.verdict;
            p.mergedText = smart.text;
            // origs: the same hunk on the read-only pane(s), painted red too.
            if (p.verdict === 'conflict') {
              out.conflicts.push({ from: chunk.editFrom, to: Math.max(chunk.editTo, chunk.editFrom + 1), origs: [{ cm: dv.orig, from: chunk.origFrom, to: chunk.origTo }] });
              out.conflictKeys.add(keyOf(dv.type, chunk));
            }
          }
          out.pending.push(p);
        }
      }
      if (threeWay) {
        const touches = (a, b) => a.editFrom <= b.editTo && b.editFrom <= a.editTo;
        const regions = [];
        for (const lc of out.activeBySide.left) for (const rc of out.activeBySide.right) {
          if (touches(lc, rc)) {
            if (!isDeclined(mv.left, lc)) out.conflictKeys.add(keyOf('left', lc));
            if (!isDeclined(mv.right, rc)) out.conflictKeys.add(keyOf('right', rc));
            regions.push({
              from: Math.min(lc.editFrom, rc.editFrom),
              to: Math.max(lc.editTo, rc.editTo, Math.min(lc.editFrom, rc.editFrom) + 1),
              origs: [{ cm: mv.left.orig, from: lc.origFrom, to: lc.origTo }, { cm: mv.right.orig, from: rc.origFrom, to: rc.origTo }],
            });
          }
        }
        regions.sort((a, b) => a.from - b.from);
        for (const reg of regions) {
          const last = out.conflicts[out.conflicts.length - 1];
          if (last && reg.from <= last.to) { last.to = Math.max(last.to, reg.to); last.origs.push(...reg.origs); }
          else out.conflicts.push({ ...reg, origs: [...reg.origs] });
        }
      }
      return out;
    }
    function clearLineClasses() {
      for (const entry of lineClassHandles) { try { entry.cm.removeLineClass(entry.h, entry.where, entry.cls); } catch {} }
      lineClassHandles = [];
    }
    function addLineClasses(cm, from, to, where, cls) {
      for (let line = from; line < Math.max(to, from + 1) && line <= cm.lastLine(); line += 1) {
        lineClassHandles.push({ cm, h: cm.addLineClass(line, where, cls), where, cls });
      }
    }
    function updateStatus() {
      if (!mv) return;
      const info = survey();
      // Conflict chunks draw a red connector (chunkState 'conflict'): redraw
      // the gaps when the set changes.
      if ([...info.conflictKeys].sort().join('|') !== [...conflictKeys].sort().join('|')) {
        conflictKeys = info.conflictKeys;
        for (const dv of [mv.left, mv.right]) if (dv && dv.bcRedraw) dv.bcRedraw();
      }
      // ONE counter: how many of the real changes are settled (merged in or
      // dismissed; click jumps to the next open one), plus a red conflict chip
      // only while conflicts remain. A change taken into the Result stops being
      // a chunk, so the total is the count the view was built with (plus any
      // taken before a whitespace rebuild), never the live chunk count: the
      // resolved number only rises as changes are taken or dismissed.
      if (changeTotal == null) changeTotal = info.changes + takenBeforeRebuild;
      const total = Math.max(changeTotal, info.changes);
      lastChangeCount = info.changes;
      const open = info.pending.length;
      let html = !total ? 'No differences'
        : open ? `<button type="button" class="bc-chg-progress" data-x="pendjump" title="Next open change (Alt+Down)">${total - open} of ${total} resolved</button>`
          : `All ${total} resolved`;
      if (info.conflicts.length) html += ` <button type="button" class="bc-conflict-chip" data-x="confjump" title="Jump to the first conflict">${info.conflicts.length} conflict${info.conflicts.length === 1 ? '' : 's'}</button>`;
      q('chgcount').innerHTML = html;
      const pj = q('pendjump');
      if (pj) pj.onclick = () => jumpChange(1);
      const cj = q('confjump');
      if (cj) cj.onclick = () => { const c = survey().conflicts[0]; if (c) scrollToLine(c.from); };
      // A Unify step only saves what the Smart merge can settle on its own.
      if (record.unify) {
        const n = info.conflicts.length;
        q('save').disabled = n > 0;
        q('save').title = n
          ? `${n} conflict${n === 1 ? '' : 's'} left: use the arrow in the gap to take incoming, the x to keep yours, Alt+B to keep both, or edit the result`
          : 'Takes the incoming additions and rewordings, keeps lines that incoming lacks, then saves';
      }
      // Two panes with no markers read as "nothing happened". When the only
      // differences are whitespace the view is hiding, say so explicitly.
      const note = q('note');
      const result = currentText();
      const wsHidden = !info.changes && ignoreWs && (result !== rightText || (threeWay && result !== leftText));
      note.hidden = !wsHidden;
      if (wsHidden) {
        note.innerHTML = 'Same text on both sides: the only differences are whitespace, hidden while Ignore whitespace is on. <button type="button" class="btn quiet sm accent" data-x="showws">Show them</button>';
        q('showws').onclick = () => q('ws').click();
      }
      // Line paint: quiet chunks lose the green chunk background on both panes;
      // declined chunks dim their text; conflict regions tint red on every pane
      // that holds them (the wash on the line background, and the line's
      // wrapper marked so its word-level marks turn red too).
      clearLineClasses();
      for (const { dv, chunk } of info.quiet) {
        addLineClasses(dv.edit, chunk.editFrom, chunk.editTo, 'background', 'bc-quiet');
        addLineClasses(dv.orig, chunk.origFrom, chunk.origTo, 'background', 'bc-quiet');
      }
      for (const dv of [mv.left, mv.right]) {
        if (!dv) continue;
        const chunks = (dv.type === 'left' ? mv.leftChunks() : mv.rightChunks()) || [];
        for (const chunk of chunks) {
          if (chunkState(dv, chunk) !== 'declined') continue;
          addLineClasses(dv.orig, chunk.origFrom, chunk.origTo, 'wrap', 'bc-dim-line');
        }
      }
      for (const reg of info.conflicts) {
        for (const span of [{ cm: mv.editor(), from: reg.from, to: reg.to }, ...(reg.origs || [])]) {
          addLineClasses(span.cm, span.from, span.to, 'background', 'bc-conflict');
          addLineClasses(span.cm, span.from, span.to, 'wrap', 'bc-conflict-line');
        }
      }
    }
    function scheduleStatus() { clearTimeout(statusTimer); statusTimer = setTimeout(updateStatus, 120); }
    // Force the addon to recompute the diff NOW (it otherwise debounces ~250ms),
    // so the counter/nav reflect a programmatic bulk change immediately instead
    // of racing the debounce.
    function forceRecompute() {
      for (const dv of [mv && mv.left, mv && mv.right]) if (dv && dv.forceUpdate) dv.forceUpdate('full');
      if (mv && mv.bcRecollapse) mv.bcRecollapse(); // re-fold identical stretches after a merge/decline
    }
    function scrollToLine(line) {
      if (!mv) return;
      const ed = mv.editor();
      ed.setCursor({ line: Math.min(line, ed.lastLine()), ch: 0 });
      ed.scrollIntoView({ line: Math.min(line, ed.lastLine()), ch: 0 }, ed.getScrollInfo().clientHeight * 0.35);
      ed.focus();
    }
    function jumpChange(dir) {
      const pos = [...new Set(survey().pending.map((p) => p.chunk.editFrom))].sort((a, b) => a - b);
      if (!pos.length) return;
      navIdx = ((navIdx + dir) % pos.length + pos.length) % pos.length;
      scrollToLine(pos[navIdx]);
    }
    // Pull one chunk from an original pane into the Result (same replace the
    // addon's own arrows perform), reused by keyboard + merge-all.
    function applyChunk(side, chunk) {
      const orig = side === 'left' ? mv.leftOriginal() : mv.rightOriginal();
      if (!orig) return;
      const dv = side === 'left' ? mv.left : mv.right;
      const r = chunkRanges(dv, chunk);
      mv.editor().replaceRange(orig.getRange(r.origStart, r.origEnd), r.editStart, r.editEnd);
    }
    function appendChunk(side, chunk) { // "keep both": insert the side's block after the Result block
      const orig = side === 'left' ? mv.leftOriginal() : mv.rightOriginal();
      if (!orig) return;
      const dv = side === 'left' ? mv.left : mv.right;
      const r = chunkRanges(dv, chunk);
      const ed = mv.editor();
      const at = chunk.editTo > ed.lastLine() ? CM.Pos(ed.lastLine()) : CM.Pos(chunk.editTo, 0);
      ed.replaceRange(orig.getRange(r.origStart, r.origEnd), at, at);
    }
    function pendingAtCursor(side) {
      if (!mv) return null;
      const line = mv.editor().getCursor().line;
      let best = null;
      let bestDist = Infinity;
      for (const p of survey().pending) {
        if (side && p.side !== side) continue;
        const c = p.chunk;
        if (line >= c.editFrom && line < Math.max(c.editTo, c.editFrom + 1)) return p;
        const d = Math.min(Math.abs(line - c.editFrom), Math.abs(line - c.editTo));
        if (d < bestDist) { bestDist = d; best = p; }
      }
      return bestDist <= 6 ? best : null; // only act when reasonably close
    }
    function declineChunk(dv, chunk) {
      declinedKeys.add(declineKeyOf(dv, chunk));
      if (dv.bcRedraw) dv.bcRedraw();
      updateStatus();
    }
    // ONE automatic merge, used by the toolbar button AND by "Merge & continue"
    // before a Unify step saves. 3-pane: every pending chunk outside a conflict
    // region (the base says which side changed). 2-pane: smartMergeChunk
    // decides - its merged text replaces the chunk, a block Incoming merely
    // lacks is kept (declined, so it stops counting as pending), real conflicts
    // stay pending and red for a person. Writing a merged chunk re-chunks the
    // diff (kept lines become their own chunk), so it repeats until stable.
    function autoMergeNonConflicting() {
      if (!mv) return 0;
      let total = 0;
      for (let pass = 0; pass < 4; pass += 1) {
        const info = survey();
        const inConflict = (c) => info.conflicts.some((reg) => c.editFrom <= reg.to && reg.from <= c.editTo);
        const open = info.pending.filter((p) => !inConflict(p.chunk));
        for (const p of open) if (p.verdict === 'keep') declinedKeys.add(declineKeyOf(p.dv, p.chunk));
        const take = open.filter((p) => threeWay || p.verdict === 'apply')
          .sort((a, b) => b.chunk.editFrom - a.chunk.editFrom); // bottom-up keeps earlier coords valid
        for (const p of take) {
          if (threeWay) { applyChunk(p.side, p.chunk); continue; }
          const r = chunkRanges(p.dv, p.chunk);
          mv.editor().replaceRange(p.mergedText, r.editStart, r.editEnd);
        }
        for (const dv of [mv.left, mv.right]) if (dv && dv.bcRedraw) dv.bcRedraw();
        forceRecompute();
        total += take.length;
        if (!take.length) break;
      }
      updateStatus(); // deterministic: recompute done, so the count reflects reality now
      return total;
    }
    // Ignore-whitespace, the diff-viewer way: normalize blank-line RUNS (and
    // trailing whitespace) so regions that differ only in blank spacing become
    // truly identical and therefore FOLD (the addon's own ignoreWhitespace only
    // covers intra-line spaces/tabs, not blank lines). Single line breaks are
    // preserved. Only applied while the WS toggle is on — off shows every byte.
    function wsNormText(t) {
      return ignoreWs
        ? String(t == null ? '' : t).replace(/[ \t]+$/gm, '').replace(/\n[ \t]*(\n[ \t]*)+/g, '\n\n')
        : String(t == null ? '' : t);
    }
    function buildMergeView(centerText) {
      host.innerHTML = '';
      navIdx = -1;
      lineClassHandles = [];
      const cmOpts = {
        value: wsNormText(centerText),
        origRight: wsNormText(rightText),
        lineNumbers: false,
        mode: null,
        lineWrapping: true,
        collapseIdentical: 2,
        revertButtons: true,
        ignoreWhitespace: ignoreWs,
        allowEditingOriginals: false,
        theme: 'bc',
        chunkState,      // vendored BOARDCLIP hooks (see cm5/README)
        declineChunk,
        phrases: { 'Revert chunk': 'Take this change into the result' },
      };
      if (threeWay) cmOpts.origLeft = wsNormText(leftText);
      mv = new CM.MergeView(host, cmOpts);
      const editors = [mv.editor(), mv.leftOriginal(), mv.rightOriginal()].filter(Boolean);
      const keymap = {
        'Alt-Down': () => jumpChange(1),
        'Alt-Up': () => jumpChange(-1),
        'Alt-Right': () => { const p = pendingAtCursor('right'); if (p) { applyChunk('right', p.chunk); forceRecompute(); updateStatus(); } },
        'Alt-Left': () => {
          if (threeWay) { const p = pendingAtCursor('left'); if (p) { applyChunk('left', p.chunk); forceRecompute(); updateStatus(); } }
          else { const p = pendingAtCursor('right'); if (p) declineChunk(p.dv, p.chunk); } // 2-pane: dismiss
        },
        'Alt-B': () => { const p = pendingAtCursor(null); if (p) { appendChunk(p.side, p.chunk); forceRecompute(); updateStatus(); } },
      };
      for (const cm of editors) cm.setOption('extraKeys', keymap);
      mv.editor().on('changes', scheduleStatus);
      CodeMirror.on(mv.editor(), 'updateDiff', scheduleStatus);
      setTimeout(() => {
        for (const cm of editors) cm.refresh();
        updateStatus();
        mv.editor().focus();
      }, 0);
    }
    if (CM) buildMergeView(seed);
    else {
      // Vendored CodeMirror missing: degrade to an editable textarea seeded with
      // the merge seed so resolution is still possible.
      fallbackArea = document.createElement('textarea');
      fallbackArea.className = 'bc-editor-area';
      fallbackArea.value = seed;
      host.appendChild(fallbackArea);
      q('chgcount').textContent = '';
    }

    const value = () => ({ title: cleanTitle(titleInput.value), text: currentText() });
    const resolve = (action, extra) => {
      if (o.onResolve) o.onResolve({ id: record.id, action, ...value(), ...(extra || {}) });
    };
    // Accept actions resolve with the RAW side text (verbatim — no LF rewrite).
    q('left').onclick = () => { titleInput.value = lTitle; resolve('accept_left', { text: rawLeft }); };
    q('right').onclick = () => { titleInput.value = rTitle; resolve('accept_right', { text: rawRight }); };
    q('both').onclick = () => resolve('keep_both', { text: unionMergeText(leftText, rightText) });
    const removeBtn = q('remove');
    if (removeBtn) removeBtn.onclick = () => resolve('remove');
    q('save').onclick = async () => {
      if (record.unify && mv) {
        // Nothing but (hidden) whitespace differs: keep the newer clip verbatim
        // rather than the whitespace-normalized Result.
        if (!survey().changes) { resolve('save', { text: rawRight }); return; }
        // "Merge & continue" MERGES first (the button used to save as-is and
        // warn, which read as "merge did nothing"); anything still open is a
        // conflict, which disables the button instead of saving.
        autoMergeNonConflicting();
        const open = survey().pending;
        if (open.length) { updateStatus(); scrollToLine(open[0].chunk.editFrom); return; }
        resolve('save');
        return;
      }
      // Unhandled = real changes neither merged nor dismissed (Result starts as
      // Current, so an unpulled incoming replacement = potential loss).
      const pending = mv ? survey().pending.length : 0;
      if (pending > 0) {
        const ok = await dialogs.confirm({
          title: `${pending} change${pending === 1 ? '' : 's'} still pending`,
          message: 'Save anyway with the current Result?',
          okLabel: 'Save',
        });
        if (!ok) return;
      }
      resolve('save');
    };
    q('prevchg').onclick = () => jumpChange(-1);
    q('nextchg').onclick = () => jumpChange(1);
    q('mergeall').onclick = () => autoMergeNonConflicting();
    q('ws').classList.toggle('active', ignoreWs);
    q('ws').onclick = () => {
      if (!mv) return;
      ignoreWs = !ignoreWs;
      q('ws').classList.toggle('active', ignoreWs);
      // The taken changes are in the Result now and vanish from the new diff:
      // carry them so the counter's progress survives the rebuild.
      if (changeTotal != null) takenBeforeRebuild = Math.max(0, Math.max(changeTotal, lastChangeCount) - lastChangeCount);
      changeTotal = null;
      buildMergeView(currentText()); // rebuild with the same Result text
    };
    const closeBtn = q('close');
    if (closeBtn) closeBtn.onclick = () => { if (o.onClose) o.onClose(); };
    root.addEventListener('keydown', (event) => {
      if (event.key === 'Escape' && !dialogs.isOpen()) { event.preventDefault(); if (o.onClose) o.onClose(); }
    });
    return { el: root, getValue: value };
  }
  function sortItems(items) {
    return [...(items || [])].sort((a, b) => (b.ts || 0) - (a.ts || 0));
  }
  function touchItem(items, id, now) {
    const ts = now || Math.floor(Date.now() / 1000);
    return sortItems((items || []).map((item) => itemId(item) === id ? { ...item, ts, updatedAt: ts } : item));
  }
  function withPinTimestamp(item, ts, field) {
    const next = { ...item, updatedAt: ts, pinUpdatedAt: ts };
    if (next.pin) {
      next.pin = { ...next.pin, updatedAt: ts };
      if (field === 'number') next.pin.numberUpdatedAt = ts;
      if (field === 'groups') next.pin.groupsUpdatedAt = ts;
    }
    return next;
  }
  function togglePin(items, id, now) {
    const ts = now || Math.floor(Date.now() / 1000);
    return (items || []).map((item) => {
      if (itemId(item) !== id) return item;
      if (isPinned(item)) return withPinTimestamp({ ...item, pin: null }, ts);
      return withPinTimestamp({ ...item, pin: {} }, ts);
    });
  }
  function assignNumpad(items, id, slot, now) {
    const ts = now || Math.floor(Date.now() / 1000);
    return (items || []).map((item) => {
      const next = { ...item, pin: item.pin ? { ...item.pin } : item.pin };
      let changed = false;
      if (numpadOf(next) === slot && itemId(next) !== id) {
        delete next.pin.number;
        changed = true;
      }
      if (itemId(next) === id) {
        const pin = ensurePin(next);
        pin.number = slot;
        return withPinTimestamp(next, ts, 'number');
      }
      if (next.pin && typeof next.pin.number !== 'number' && !groupsOf(next).length) next.pin = null;
      return changed ? withPinTimestamp(next, ts, 'number') : next;
    });
  }
  function toggleGroup(items, id, group, now) {
    const ts = now || Math.floor(Date.now() / 1000);
    return (items || []).map((item) => {
      if (itemId(item) !== id) return item;
      const next = { ...item, pin: item.pin ? { ...item.pin } : {} };
      const groups = new Set(groupsOf(next));
      if (groups.has(group)) groups.delete(group);
      else groups.add(group);
      if (groups.size) next.pin.groups = [...groups];
      else delete next.pin.groups;
      if (typeof next.pin.number !== 'number' && !groups.size) next.pin = null;
      return withPinTimestamp(next, ts, 'groups');
    });
  }
  function deleteItem(items, id) {
    return (items || []).filter((item) => itemId(item) !== id);
  }
  function addClipboardText(items, text, now) {
    const value = String(text || '').trim();
    if (!value) return items || [];
    const ts = now || Math.floor(Date.now() / 1000);
    const existing = (items || []).find((item) => item.type === 'text' && item.text === value);
    if (existing) return touchItem(items, itemId(existing), ts);
    return sortItems([createTextItem(value, { ts, updatedAt: ts }), ...(items || [])]);
  }

  return {
    isPinned,
    numpadOf,
    groupsOf,
    isInGroup,
    titleOf,
    itemId,
    createTextItem,
    ago,
    nextAgoDelayMs,
    updateRelativeTimes,
    numpadMap,
    BUILTIN_FILTERS,
    builtinFilterCount,
    builtinFilters,
    itemSearchText,
    normalizeTagName,
    tagParentPaths,
    tagMatchesFilter,
    itemMatchesGroupFilter,
    groupFilterCount,
    sourceGroupsFromFilters,
    buildTagTree,
    renderTagTreeMenu,
    prepareQuery,
    matchesQuery,
    asFilterSet,
    filterStateFrom,
    ensureFilterState,
    hasActiveFilters,
    filterTokenMatches,
    matchesFilter,
    applyFilterIntent,
    clearFilterState,
    filterItems,
    filterItemIndexes,
    parsedFromState,
    installRendererErrorReporting,
    search: Search, // the shared engine (parseQuery/applyFacet/facetState/filterRankIndexes/…)
    itemCountLabel,
    escapeHtml,
    builtinFilterTitle,
    builtinFilterIconHtml,
    renderFilterBar,
    renderChip,
    renderNumpadButtons,
    renderKeypadMenu,
    groupMembership,
    renderClipItem,
    clipRowText,
    renderClipMeta,
    renderEmptyState,
    emptyStateKind,
    renderRelaxNudge,
    createCensusCache,
    similarClipIds,
    similarSteps,
    similarText,
    SIMILAR_MIN_CHARS,
    SIMILAR_MAX_CHARS,
    runSliced,
    renderClipActions,
    renderClipMenu,
    renderBulkMenu,
    bulkGroupTreeHtml,
    clipGroupTreeHtml,
    renderClipKeys,
    renderSelectionBar,
    attachSearchBox,
    paintSortButton,
    attachWindowDrag,
    attachScrollFade,
    attachSideScroll,
    attachChipStrip,
    closeTopLayerSubmenus,
    resolveFadeVars,
    FADE_PRESETS,
    attachResizeHandle,
    renderFacetOption,
    renderSearchOptions,
    createMenu,
    menuNavIndex,
    keypadStep,
    installSubmenuAutoflip,
    showActionToast,
    revisionConflictCode,
    revisionTargets,
    guardRevision,
    applySelectionUI,
    renderPopupShell,
    renderSettingsBody,
    renderSettingsItem,
    renderNumpadSlotRows,
    renderGroupRows,
    setSettingHelp,
    fitMetaTags,
    mountSettings,
    queryMatchIndex,
    collapsedPreviewText,
    applyHistoryDelta,
    highlight,
    resolveTheme,
    applyTheme,
    setActiveThemeSeg,
    applyVariants,
    applyAppearance,
    normalizeHexColor,
    contrastRatio,
    accentShades,
    createVariantSwitcher,
    setActiveVariantSeg,
    createDialogs,
    resolveListAnchor,
    createClipList,
    IMAGE_ZOOM,
    clampImageHeight,
    imageZoomKey,
    createImageZoom,
    createClipController,
    findAllMatches,
    countWords,
    editorSaveState,
    lineNumberAtIndex,
    editorScrollTopForIndex,
    renderWindowBar,
    attachWindowControls,
    createEditor,
    createImageViewer,
    lcsSegments,
    diffLineHunks,
    unionMergeText,
    losslessChange,
    smartMergeChunk,
    createReconciliationView,
    sortItems,
    touchItem,
    togglePin,
    assignNumpad,
    toggleGroup,
    deleteItem,
    addClipboardText,
  };
});
