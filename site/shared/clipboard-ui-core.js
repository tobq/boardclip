(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.BoardClipCore = factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

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
    const activeFilters = asFilterSet(opts.activeFilters || opts.filters);
    const excludedFilters = asFilterSet(opts.excludedFilters);
    const itemGroups = asFilterSet(opts.itemGroups);
    const label = escapeHtml(group);
    const text = escapeHtml(node.label || group);
    const hasChildren = !!(node.children && node.children.length);
    const baseClass = isFilter ? 'filter-tag' : 'gp-btn';
    const stateClass = isFilter
      ? (activeFilters.has(group) ? ' active' : excludedFilters.has(group) ? ' excluded' : '')
      : (itemGroups.has(group) ? ' assigned' : ' available');
    const treeClass = `${hasChildren ? ' has-children' : ''}${node.stored ? '' : ' virtual'}`;
    const count = isFilter ? groupFilterCount(opts.items || [], group) : 0;
    const title = isFilter
      ? (excludedFilters.has(group)
        ? `Excluding ${group}`
        : `${group} - ${count} item${count !== 1 ? 's' : ''}`)
      : group;
    const caret = hasChildren
      ? `<span class="tag-caret mi" aria-hidden="true">${isFilter && depth === 0 ? 'expand_more' : 'chevron_right'}</span>`
      : '';
    const deleteHtml = isFilter && node.stored
      ? `<span class="gtag-x mi" data-action="delete-group" data-group="${label}" title="Delete group">close</span>`
      : '';
    const control = `<span class="${baseClass}${stateClass}${treeClass}" data-group="${label}" title="${escapeHtml(title)}" aria-label="${label}"><span class="tag-label">${text}</span>${caret}${deleteHtml}</span>`;
    const children = hasChildren
      ? `<span class="tag-submenu" role="menu">${renderTagTreeMenu(node.children, opts, depth + 1)}</span>`
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
    return Boolean(state.filters.size || state.excludedFilters.size);
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
  function filterItems(items, state) {
    const filterState = filterStateFrom(state);
    const prepared = prepareQuery(state && state.query, state && state.regex);
    const searchTexts = state && state.searchTexts;
    const searchTextLower = state && state.searchTextLower;
    return (items || []).filter((item, index) => {
      if (!matchesFilter(item, filterState)) return false;
      if (prepared.kind === 'none') return true;
      return matchesPreparedQuery(searchTexts ? searchTexts[index] : itemSearchText(item), prepared, searchTextLower && searchTextLower[index]);
    });
  }
  function filterItemIndexes(items, state) {
    const filterState = filterStateFrom(state);
    const prepared = prepareQuery(state && state.query, state && state.regex);
    const searchTexts = state && state.searchTexts;
    const searchTextLower = state && state.searchTextLower;
    const result = [];
    (items || []).forEach((item, index) => {
      if (!matchesFilter(item, filterState)) return;
      if (prepared.kind === 'none' || matchesPreparedQuery(searchTexts ? searchTexts[index] : itemSearchText(item), prepared, searchTextLower && searchTextLower[index])) {
        result.push(index);
      }
    });
    return result;
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
  function builtinFilterIconHtml(filter, options) {
    const iconMode = options && options.iconMode || 'material';
    if (!filter) return '';
    if (filter.icon === 'numpad') return '#';
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
    for (const filter of filters) {
      const stateClass = filter.active ? ' active' : filter.excluded ? ' excluded' : '';
      const title = filter.excluded ? `Excluding ${filter.label}` : builtinFilterTitle(filter);
      html += `<span class="filter-tag builtin icon-filter${stateClass}" data-filter="${escapeHtml(filter.id)}" title="${escapeHtml(title)}" aria-label="${escapeHtml(filter.ariaLabel)}">${builtinFilterIconHtml(filter, options)}</span>`;
    }
    html += renderTagTreeMenu(buildTagTree(groups), {
      mode: 'filter',
      items,
      activeFilters,
      excludedFilters,
      groupCounts,
    });
    if ((activeFilters.size || excludedFilters.size) && !query) {
      html += '<span class="filter-tag clear-filter icon-filter" data-action="clear-search-filters" title="Clear filters" aria-label="Clear filters"><span class="mi">close</span></span>';
    }
    return html;
  }
  function defaultPreviewHtml(item, options) {
    const isImage = item && item.type === 'image';
    if (isImage) {
      const src = options && typeof options.imageSrc === 'function' ? options.imageSrc(item) : item.imageSrc || item.image || '';
      return `<img src="${escapeHtml(src)}" alt="image">`;
    }
    const text = item && item.text || '';
    const display = options && typeof options.previewText === 'function'
      ? options.previewText(item)
      : options && options.expanded ? text : text.replace(/\r?\n/g, ' ');
    if (options && typeof options.highlight === 'function') return options.highlight(display);
    return escapeHtml(display);
  }
  function renderItemPicker(item, options) {
    const opts = options || {};
    const items = opts.items || [];
    const groups = opts.groups || [];
    const nmap = opts.numpadMap || numpadMap(items);
    const np = numpadOf(item);
    let npBtns = '';
    for (let n = 1; n <= 9; n += 1) {
      const cls = np === n ? 'current' : nmap[n] ? 'taken' : 'free';
      let title = String(n);
      if (nmap[n]) {
        const slotItem = items.find((candidate) => itemId(candidate) === nmap[n]);
        title = slotItem && slotItem.type === 'image'
          ? `${n}: [image]`
          : `${n}: ${String(slotItem && slotItem.text || '').replace(/\s+/g, ' ').slice(0, 80)}`;
      }
      npBtns += `<span class="np-btn ${cls}" data-n="${n}" title="${escapeHtml(title)}">${n}</span>`;
    }
    const itemGroups = new Set(groupsOf(item));
    let gpBtns = renderTagTreeMenu(buildTagTree([...groups, ...itemGroups]), {
      mode: 'picker',
      itemGroups,
    });
    if (opts.showAddGroup !== false) {
      gpBtns += '<span class="tag-menu-node"><span class="gp-btn add-group" data-action="add-group" title="New group"><span class="mi sm">add</span></span></span>';
    }
    return `<div class="numpad-picker">
      <div class="np-row">${npBtns}</div>
      <div class="gp-row">${gpBtns}</div>
    </div>`;
  }
  function renderClipItem(item, options) {
    const opts = options || {};
    const id = itemId(item) || '';
    const pinned = isPinned(item);
    const np = numpadOf(item);
    const isImage = item && item.type === 'image';
    let metaHtml;
    if (isImage) {
      const width = item.width || '?';
      const height = item.height || '?';
      metaHtml = `<span data-relative-ts="${item.ts || 0}">${ago(item.ts)}</span><span>${escapeHtml(`${width}x${height}`)}</span>`;
    } else {
      const text = item && item.text || '';
      metaHtml = `<span data-relative-ts="${item.ts || 0}">${ago(item.ts)}</span><span>${text.length.toLocaleString()} chars</span>`;
    }
    if (np) metaHtml += `<span class="numpad-tag">#${np}</span>`;
    for (const group of groupsOf(item)) metaHtml += `<span class="group-tag">${escapeHtml(group)}</span>`;
    const previewClass = opts.expanded ? 'expanded' : 'collapsed';
    // Both text and images can carry a title (images are named so they're searchable).
    const title = titleOf(item);
    const titleHtml = title
      ? `<div class="clip-title">${opts.highlightTitle ? opts.highlightTitle(title) : escapeHtml(title)}</div>`
      : '';
    const selected = opts.selected ? ' selected' : '';
    return `<div class="item${pinned ? ' has-pin' : ''}${selected}" data-id="${escapeHtml(id)}">
      <div class="item-row">
        <div class="pin-area">
          <button class="star${pinned ? ' active' : ''}" type="button" data-action="pin" data-id="${escapeHtml(id)}" title="${pinned ? 'Unpin' : 'Pin'}"><span class="mi${pinned ? ' filled' : ''}">star</span></button>
          ${opts.pickerHtml || ''}
        </div>
        <div class="content">
          ${titleHtml}
          <div class="preview ${previewClass}">${defaultPreviewHtml(item, opts)}</div>
          <div class="meta">${metaHtml}</div>
        </div>
        <div class="actions">${opts.actionsHtml || ''}</div>
      </div>
    </div>`;
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
      groupFilters: 'groupFilters',
      list: 'list',
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
          ${opts.showSyncButton === false ? '' : `<button class="icon-btn accent" id="${esc(ids.syncHeaderBtn)}" type="button" title="Sync now" aria-label="Sync now"><span class="mi">sync</span></button>`}
          ${headerActionsHtml}
          <button class="icon-btn accent" id="${esc(ids.settingsBtn)}" type="button" title="Settings" aria-label="Settings" aria-expanded="false" aria-controls="${esc(ids.settingsView)}"><span class="mi filled">settings</span></button>
          <button class="icon-btn close-btn${closeCls}" id="${esc(ids.closeBtn)}" type="button" title="Close (Esc)">&times;</button>
        </header>
        <div class="search-row">
          <input class="search" id="${esc(ids.search)}" type="text" placeholder="Search..." autocomplete="off" spellcheck="false">
          <div class="search-btns">
            <button class="icon-btn search-clear" id="${esc(ids.searchClear)}" type="button" title="Clear search" aria-label="Clear search"><span class="mi">close</span></button>
            <button class="icon-btn rx-btn" id="${esc(ids.regexBtn)}" type="button" title="Regex search" aria-label="Regex search">.*</button>
          </div>
        </div>
        <div class="group-filters" id="${esc(ids.groupFilters)}" aria-label="Filters"></div>
      </div>
      <div class="list" id="${esc(ids.list)}" aria-live="polite"></div>
      ${afterListHtml}
    </div>
    <div class="settings-view" id="${esc(ids.settingsView)}">
      <div class="settings-hdr">
        <button class="icon-btn" id="${esc(ids.settingsBack)}" type="button" title="Back" aria-label="Back"><span class="mi">arrow_back</span></button>
        <h2>Settings</h2>
        ${settingsNoteHtml}
        <button class="icon-btn close-btn${closeCls}" id="${esc(ids.settingsCloseBtn)}" type="button" title="Close (Esc)">&times;</button>
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
    return String(text || '').toLowerCase().indexOf(queryText.toLowerCase());
  }
  function collapsedPreviewText(text, query, regex) {
    const singleLine = String(text || '').replace(/\r?\n/g, ' ');
    if (singleLine.length <= COLLAPSED_PREVIEW_CHARS) return singleLine;
    const matchIndex = queryMatchIndex(singleLine, query, regex);
    const center = matchIndex >= 0 ? Math.max(0, matchIndex - SEARCH_PREVIEW_CONTEXT) : 0;
    const start = Math.min(center, Math.max(0, singleLine.length - COLLAPSED_PREVIEW_CHARS));
    const end = Math.min(singleLine.length, start + COLLAPSED_PREVIEW_CHARS);
    return `${start > 0 ? '...' : ''}${singleLine.slice(start, end)}${end < singleLine.length ? '...' : ''}`;
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
  function renderClipActions(item, options) {
    const opts = options || {};
    const id = itemId(item) || '';
    const isImage = item && item.type === 'image';
    let html = '';
    // 'rename' names the clip (a shared title prompt) for BOTH types so images
    // become searchable by name; 'edit' opens the text editor (text only).
    html += `<button class="icon-btn accent" data-action="rename" data-id="${escapeHtml(id)}" title="${isImage ? 'Name image' : 'Edit title'}"><span class="mi">drive_file_rename_outline</span></button>`;
    if (isImage) {
      html += `<button class="icon-btn accent" data-action="open-img" data-id="${escapeHtml(id)}" title="Open image"><span class="mi">open_in_new</span></button><button class="icon-btn accent" data-action="save-img" data-id="${escapeHtml(id)}" title="Copy to Downloads"><span class="mi">save</span></button>`;
    } else {
      html += `<button class="icon-btn accent" data-action="edit" data-id="${escapeHtml(id)}" title="Open in editor"><span class="mi">open_in_new</span></button>`;
    }
    html += `<button class="icon-btn danger" data-action="del" data-id="${escapeHtml(id)}" title="Delete"><span class="mi">close</span></button>`;
    return html;
  }
  // The full settings panel body, shared verbatim by the app and the demo. The
  // app fills the dynamic containers (numpadSlots/groupSlots/syncAccounts/
  // aiClients/buildInfo/usage) from window.api; the demo fills them with sample
  // data. One source means the two settings panels are structurally identical.
  function renderSettingsBody() {
    return `
    <label class="setting-row switch-row" for="autoLaunch">
      <span>Launch on startup</span>
      <input id="autoLaunch" type="checkbox">
      <span class="switch" aria-hidden="true"></span>
    </label>
    <div class="setting-row">
      <label>Theme</label>
      <div class="seg" id="themeMode" role="group" aria-label="Theme">
        <button type="button" class="seg-btn" data-theme-mode="system" title="Follow your desktop">System</button>
        <button type="button" class="seg-btn" data-theme-mode="light" title="Always light">Light</button>
        <button type="button" class="seg-btn" data-theme-mode="dark" title="Always dark">Dark</button>
      </div>
    </div>
    <div id="appearanceVariants"></div>
    <div class="setting-row shortcut-row">
      <label>Popup shortcut</label>
      <div class="shortcut-control">
        <button class="shortcut-btn" id="shortcutRecord" type="button"></button>
        <button class="icon-btn shortcut-reset" id="shortcutReset" title="Reset shortcut" type="button"><span class="mi">restart_alt</span></button>
      </div>
    </div>
    <div class="shortcut-status" id="shortcutStatus"></div>
    <div class="setting-row shortcut-row">
      <label>Quick paste</label>
      <div class="shortcut-control">
        <button class="shortcut-btn" id="quickPasteRecord" type="button"></button>
        <button class="icon-btn shortcut-reset" id="quickPasteReset" title="Reset quick paste shortcut" type="button"><span class="mi">restart_alt</span></button>
      </div>
    </div>
    <div class="shortcut-status" id="quickPasteStatus"></div>
    <div class="setting-row"><label>Max age (days)</label><input id="maxAge" type="number" min="1"></div>
    <div class="setting-row"><label>Max size (GB)</label><input id="maxSize" type="number" min="0.1" step="0.1"></div>
    <div class="settings-usage" id="usage"></div>
    <div class="settings-section">
      <h3>Numpad Shortcuts</h3>
      <div id="numpadSlots"></div>
    </div>
    <div class="settings-section">
      <h3>Sync</h3>
      <div class="sync-row">
        <div class="sync-list" id="syncAccounts"></div>
        <button class="sync-btn" id="syncNow" title="Sync now"><span class="mi sm mid">sync</span></button>
      </div>
      <button class="settings-secondary sync-add-folder" id="addSyncFolder" type="button"><span class="mi sm mid">create_new_folder</span> Add sync folder</button>
      <div class="sync-status" id="syncStatus"></div>
      <label class="setting-row switch-row" for="p2pEnabled">
        <span>Local network fast sync</span>
        <input id="p2pEnabled" type="checkbox">
        <span class="switch" aria-hidden="true"></span>
      </label>
      <div class="sync-status" id="p2pStatus"></div>
    </div>
    <div class="settings-section">
      <h3>Updates</h3>
      <div class="settings-action-row">
        <div class="settings-action-list">
          <div class="settings-action-card">
            <span class="settings-action-main">
              <span class="settings-action-title" id="updateBuild"></span>
              <span class="settings-action-detail" id="updateDetail"></span>
            </span>
          </div>
        </div>
        <button class="settings-icon-btn" id="updateNow" title="Check for updates"><span class="mi sm mid">system_update_alt</span></button>
      </div>
      <div class="settings-status" id="updateStatus"></div>
    </div>
    <div class="settings-section">
      <h3>Diagnostics</h3>
      <label class="setting-row switch-row" for="diagnosticsEnabled">
        <span>Performance logging</span>
        <input id="diagnosticsEnabled" type="checkbox">
        <span class="switch" aria-hidden="true"></span>
      </label>
      <div class="settings-status" id="diagnosticsStatus"></div>
    </div>
    <div class="settings-section">
      <h3>AI Access</h3>
      <label class="setting-row switch-row" for="aiAccessEnabled">
        <span>Let local AI assistants use BoardClip</span>
        <input id="aiAccessEnabled" type="checkbox">
        <span class="switch" aria-hidden="true"></span>
      </label>
      <div class="settings-status" id="aiAccessStatus"></div>
      <div id="aiAccessBody" class="hidden">
        <div class="ai-hint">AI assistants can read clips in groups you share, and act with your approval. Drop clips into the <b>AI</b> group (or share any group below) to expose them.</div>
        <div class="ai-subhead">Installed in</div>
        <div id="aiClients"></div>
        <button class="settings-secondary hidden" id="aiMoreClients" type="button"></button>
        <div id="aiClientsMore" class="hidden"></div>
        <div class="ai-subhead hidden" id="aiAlwaysHead">Always allowed actions</div>
        <div id="aiAlwaysAllow"></div>
        <div class="setting-row"><label>Approval timeout (seconds)</label><input id="aiTimeout" type="number" min="5" max="600" step="5"></div>
      </div>
    </div>
    <div class="settings-section hidden" id="conflictsSection">
      <h3>Conflicts</h3>
      <div id="conflictSlots"></div>
    </div>
    <div class="settings-section">
      <h3>Groups</h3>
      <div id="groupSlots"></div>
      <button class="add-group-btn" id="addGroupBtn"><span class="mi sm mid">add</span> New Group</button>
    </div>
    <div class="settings-footer">
      <div class="settings-footer-actions">
        <button class="settings-clear" id="clearAll">Clear All</button>
        <button class="settings-secondary" id="copyDiagnostics">Copy Diagnostics</button>
      </div>
      <div class="build-info" id="buildInfo"></div>
    </div>
  `;
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
  }
  function setActiveVariantSeg(seg, value) {
    if (!seg || !seg.querySelectorAll) return;
    seg.querySelectorAll('[data-value]').forEach((btn) => {
      btn.classList.toggle('active', btn.dataset.value === value);
    });
  }
  // A live playground of segmented controls, one row per axis. Reuses the shared
  // .seg/.seg-btn styling. The app renders it dev-gated (plus Surface as a real
  // setting); the demo renders it always-on. `fields` picks which axes appear.
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
      for (const [val, text] of axis.options) {
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
    const root = host || document.body;
    const make = (inner) => {
      const overlay = document.createElement('div');
      overlay.className = 'overlay';
      overlay.innerHTML = inner;
      root.appendChild(overlay);
      return overlay;
    };
    const confirmEl = make('<div class="dialog"><h3 data-x="title"></h3><p data-x="msg"></p><div class="dialog-btns"><button class="btn-cancel" data-x="no"></button><button class="btn-confirm" data-x="yes"></button></div></div>');
    const promptEl = make('<div class="dialog"><h3 data-x="title"></h3><input class="prompt-input" type="text" autocomplete="off" spellcheck="false" data-x="input"><div class="dialog-btns"><button class="btn-cancel" data-x="no"></button><button class="btn-confirm" data-x="yes"></button></div></div>');
    const q = (parent, name) => parent.querySelector(`[data-x="${name}"]`);
    let activeCancel = null;
    function run(overlay, setup, getValue) {
      return new Promise((resolve) => {
        setup();
        overlay.classList.add('show');
        const yesBtn = q(overlay, 'yes');
        const noBtn = q(overlay, 'no');
        const finish = (value) => {
          overlay.classList.remove('show');
          yesBtn.removeEventListener('click', onYes);
          noBtn.removeEventListener('click', onNo);
          overlay.removeEventListener('click', onBackdrop);
          document.removeEventListener('keydown', onKey, true);
          activeCancel = null;
          resolve(value);
        };
        const onYes = () => finish(getValue());
        const onNo = () => finish(getValue(true));
        const onBackdrop = (e) => { if (e.target === overlay) onNo(); };
        const onKey = (e) => {
          if (e.key === 'Enter') { e.preventDefault(); e.stopPropagation(); onYes(); }
          else if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); onNo(); }
        };
        yesBtn.addEventListener('click', onYes);
        noBtn.addEventListener('click', onNo);
        overlay.addEventListener('click', onBackdrop);
        document.addEventListener('keydown', onKey, true);
        activeCancel = onNo;
      });
    }
    function confirm(opts) {
      const o = opts || {};
      return run(confirmEl, () => {
        q(confirmEl, 'title').textContent = o.title || '';
        q(confirmEl, 'msg').textContent = o.message || '';
        q(confirmEl, 'yes').textContent = o.okLabel || 'OK';
        q(confirmEl, 'no').textContent = o.cancelLabel || 'Cancel';
      }, (cancelled) => !cancelled);
    }
    function prompt(opts) {
      const o = typeof opts === 'string' ? { title: opts } : (opts || {});
      const input = q(promptEl, 'input');
      const result = run(promptEl, () => {
        q(promptEl, 'title').textContent = o.title || '';
        input.value = o.value || '';
        q(promptEl, 'yes').textContent = o.okLabel || 'OK';
        q(promptEl, 'no').textContent = o.cancelLabel || 'Cancel';
        setTimeout(() => input.focus(), 0);
      }, (cancelled) => cancelled ? null : (input.value.trim() || null));
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
      const ok = await dialogs.confirm({ title: `Delete group "${group}"?`, message: 'Items will be ungrouped but not deleted.', okLabel: 'Delete' });
      if (!ok) return;
      await a.deleteGroup(group);
      refresh();
    }
    async function tryAssignNumpad(id, slot) {
      const nmap = a.numpadMap ? a.numpadMap() : {};
      if (slot in nmap && nmap[slot] !== id) {
        const existing = a.itemById(nmap[slot]);
        const preview = existing ? (existing.type === 'image' ? '[image]' : String(existing.text || '').replace(/\s+/g, ' ').slice(0, 80)) : '';
        const ok = await dialogs.confirm({ title: `Numpad ${slot} already assigned:`, message: preview, okLabel: 'Replace' });
        if (!ok) return;
      }
      await a.numpadAssign(id, slot);
      refresh();
    }
    async function addGroup(id) {
      const name = await dialogs.prompt({ title: 'New group name' });
      if (!name) return;
      await a.createGroup(name);
      if (id != null && a.toggleGroup) await a.toggleGroup(id, name); // clip is not yet in the new group, so this adds
      refresh();
    }
    async function clearAll() {
      const ok = await dialogs.confirm({ title: 'Clear all unpinned items?', message: 'Pinned items will be kept.', okLabel: 'Clear' });
      if (!ok) return;
      await a.clearUnpinned();
      refresh();
    }
    // Name a clip via the shared title prompt (text + images alike), prefilled
    // with the current name. Reuses the same title field search indexes.
    async function renameClip(id) {
      const item = a.itemById(id);
      const title = await dialogs.prompt({ title: 'Name this clip', value: item ? titleOf(item) : '', okLabel: 'Save' });
      if (title === null) return;
      if (a.setClipTitle) await a.setClipTitle(id, title);
      refresh();
    }

    async function onClick(event) {
      const t = event.target;
      if (t.closest('[data-action="clear-search-filters"]')) { event.stopPropagation(); if (a.clearFilters) a.clearFilters(); if (a.focusSearch) a.focusSearch(); return true; }
      const gx = t.closest('[data-action="delete-group"]');
      if (gx) { event.stopPropagation(); deleteGroup(gx.dataset.group); return true; }
      const ftag = t.closest('.filter-tag[data-filter], .filter-tag[data-group]');
      if (ftag) { event.stopPropagation(); if (a.setFilterIntent) a.setFilterIntent(ftag.dataset.filter || ftag.dataset.group, 'include'); render(); return true; }
      const npRemove = t.closest('.np-remove');
      if (npRemove) { event.stopPropagation(); await a.numpadUnassign(Number(npRemove.dataset.slot)); refresh(); return true; }
      const slotEl = t.closest('.np-slot.has-content');
      if (slotEl && slotEl.dataset.slotId) { event.stopPropagation(); await a.copyNumpadSlot(slotEl.dataset.slotId); toast('Copied'); return true; }
      const share = t.closest('.gp-share');
      if (share) { event.stopPropagation(); await a.setGroupSharedAi(share.dataset.group); refresh(); return true; }
      const gpDel = t.closest('.gp-del');
      if (gpDel) { event.stopPropagation(); deleteGroup(gpDel.dataset.group); return true; }
      const gpBtn = t.closest('.gp-btn');
      if (gpBtn) {
        event.stopPropagation();
        const item = gpBtn.closest('.item');
        if (!item) return true;
        if (gpBtn.dataset.action === 'add-group') addGroup(item.dataset.id);
        else if (gpBtn.dataset.group) { await a.toggleGroup(item.dataset.id, gpBtn.dataset.group); refresh(); }
        return true;
      }
      const npBtn = t.closest('.np-btn');
      if (npBtn) { event.stopPropagation(); const item = npBtn.closest('.item'); if (item) tryAssignNumpad(item.dataset.id, Number(npBtn.dataset.n)); return true; }
      const pin = t.closest('[data-action="pin"]');
      if (pin) { event.stopPropagation(); await a.pin(pin.dataset.id); refresh(); return true; }
      const openImg = t.closest('[data-action="open-img"]');
      if (openImg) { event.stopPropagation(); await a.openImage(a.itemById(openImg.dataset.id)); return true; }
      const saveImg = t.closest('[data-action="save-img"]');
      if (saveImg) { event.stopPropagation(); toast(await a.saveImage(a.itemById(saveImg.dataset.id))); return true; }
      const edit = t.closest('[data-action="edit"]');
      if (edit) { event.stopPropagation(); await a.editClip(edit.dataset.id, edit.closest('.item')); return true; }
      const rename = t.closest('[data-action="rename"]');
      if (rename) { event.stopPropagation(); await renameClip(rename.dataset.id); return true; }
      const del = t.closest('[data-action="del"]');
      if (del) { event.stopPropagation(); await a.deleteClip(del.dataset.id); refresh(); toast(a.deletedToast); return true; }
      const item = t.closest('.item');
      if (item) { await a.activateClip(item.dataset.id); return true; }
      return false;
    }
    function onContextmenu(event) {
      const ftag = event.target.closest('.filter-tag[data-filter], .filter-tag[data-group]');
      if (!ftag || event.target.closest('[data-action="delete-group"]')) return false;
      event.preventDefault();
      event.stopPropagation();
      if (a.setFilterIntent) a.setFilterIntent(ftag.dataset.filter || ftag.dataset.group, 'exclude');
      render();
      return true;
    }
    function onKeydown(event) {
      if (dialogs.isOpen()) return; // dialogs own their keys via capture phase
      if (event.key === 'Escape') {
        if (a.isSettingsOpen && a.isSettingsOpen()) { if (a.closeSettings) a.closeSettings(); }
        else if (a.hidePopup) a.hidePopup();
        return;
      }
      if (a.isSettingsOpen && a.isSettingsOpen()) return;
      if (event.key === 'ArrowDown') { event.preventDefault(); if (a.moveSelection) a.moveSelection(1); }
      else if (event.key === 'ArrowUp') { event.preventDefault(); if (a.moveSelection) a.moveSelection(-1); }
      else if (event.key === 'Enter') { if (a.activateSelected) { event.preventDefault(); a.activateSelected(); } }
    }
    return {
      dialogs,
      onClick,
      onContextmenu,
      onKeydown,
      deleteGroup,
      tryAssignNumpad,
      addGroup,
      clearAll,
      render,
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
  // Shared plain-text editor — ONE implementation mounted by BOTH the desktop
  // app (in its own frameless window) and the website demo (in an in-page
  // overlay). Edits are captured live: every keystroke fires onInput (the host
  // persists a crash-safe draft), and after a short idle / on close / on Ctrl+S
  // onCommit fires (the host writes the clip). Find (Ctrl+F), word/char count,
  // revert-to-original, Tab-inserts-tab. The host owns persistence; this owns UI.
  //   opts: { initialText, initialTitle, initialFocusTitle, title, idleMs,
  //           onInput(payload), onCommit(payload), onClose() }
  function createEditor(opts) {
    if (typeof document === 'undefined') return null;
    const o = opts || {};
    const idleMs = o.idleMs || 1200;
    const originalText = String(o.initialText || '');
    const originalTitle = cleanTitle(o.initialTitle != null ? o.initialTitle : o.noteTitle);
    const root = document.createElement('div');
    root.className = 'bc-editor';
    root.innerHTML = `
      <div class="bc-editor-bar">
        <span class="bc-editor-title"></span>
        <div class="bc-editor-bar-actions">
          <button class="icon-btn" type="button" data-x="find" title="Find (Ctrl+F)"><span class="mi">search</span></button>
          <button class="icon-btn" type="button" data-x="revert" title="Revert to original"><span class="mi">undo</span></button>
          <button class="icon-btn close-btn" type="button" data-x="close" title="Close (Esc)">&times;</button>
        </div>
      </div>
      <div class="bc-title-row" hidden>
        <input class="bc-note-title" type="text" maxlength="240" placeholder="Title" autocomplete="off" spellcheck="false" data-x="titleinput">
      </div>
      <div class="bc-find" data-x="findbar" hidden>
        <input class="bc-find-input" type="text" placeholder="Find" spellcheck="false" autocomplete="off" data-x="findinput">
        <button class="icon-btn rx-btn" type="button" data-x="findregex" title="Regex find" aria-label="Regex find">.*</button>
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
        <span class="bc-editor-hint">Saved automatically</span>
      </div>`;
    const q = (name) => root.querySelector(`[data-x="${name}"]`);
    const area = root.querySelector('.bc-editor-area');
    const titleRow = root.querySelector('.bc-title-row');
    const titleInput = q('titleinput');
    const titleEl = root.querySelector('.bc-editor-title');
    const statsEl = q('stats');
    const findBar = q('findbar');
    const findInput = q('findinput');
    const findRegexBtn = q('findregex');
    const findCount = q('findcount');
    const findHl = q('findhl');
    area.value = originalText;
    titleInput.value = originalTitle;
    titleEl.textContent = o.chromeTitle || o.title || 'Edit clip';

    let idleTimer = null;
    let lastCommittedText = originalText;
    let lastCommittedTitle = originalTitle;
    let matches = [];
    let findIdx = -1;
    let findRegex = !!o.initialFindRegex;

    function payload() { return { text: area.value, title: cleanTitle(titleInput.value) }; }
    function emitInput() { if (o.onInput) o.onInput(payload()); }
    function updateRegexButton() { findRegexBtn.classList.toggle('active', findRegex); }
    function showTitleInput() { titleRow.hidden = false; }

    function updateStats() {
      const t = area.value;
      statsEl.textContent = `${countWords(t)} word${countWords(t) === 1 ? '' : 's'} · ${t.length.toLocaleString()} char${t.length === 1 ? '' : 's'}`;
    }
    function commit() {
      if (idleTimer) { clearTimeout(idleTimer); idleTimer = null; }
      const next = payload();
      if (next.text === lastCommittedText && next.title === lastCommittedTitle) return;
      lastCommittedText = next.text;
      lastCommittedTitle = next.title;
      if (o.onCommit) o.onCommit(next);
    }
    function scheduleCommit() {
      if (idleTimer) clearTimeout(idleTimer);
      idleTimer = setTimeout(commit, idleMs);
    }
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
    q('find').onclick = openFind;
    q('revert').onclick = () => { area.value = originalText; titleInput.value = originalTitle; updateStats(); emitInput(); commit(); area.focus(); };
    q('close').onclick = () => { commit(); if (o.onClose) o.onClose(); };
    root.addEventListener('keydown', (e) => {
      if (e.key !== 'Escape') return;
      if (!findBar.hidden) { e.preventDefault(); e.stopPropagation(); closeFind(); }
      else { e.preventDefault(); e.stopPropagation(); commit(); if (o.onClose) o.onClose(); }
    });

    updateStats();
    updateRegexButton();
    setTimeout(() => {
      if (o.initialFocusTitle) { showTitleInput(); titleInput.focus(); titleInput.select(); }
      else if (o.initialFind) openFind(o.initialFind, !!o.initialFindRegex);
      else area.focus();
    }, 0);
    return {
      el: root,
      getText: () => area.value,
      getTitle: () => cleanTitle(titleInput.value),
      getValue: payload,
      setText: (t) => { area.value = String(t || ''); updateStats(); },
      setTitle: (t) => { titleInput.value = cleanTitle(t); },
      commit,
      focus: () => area.focus(),
      focusTitle: () => { showTitleInput(); titleInput.focus(); titleInput.select(); },
      openFind,
    };
  }
  function simpleTextHunks(leftText, rightText) {
    const left = String(leftText || '');
    const right = String(rightText || '');
    if (left === right) return [{ type: 'same', text: left }];
    return [
      ...(left ? [{ type: 'remove', text: left }] : []),
      ...(right ? [{ type: 'add', text: right }] : []),
    ];
  }
  function snapshotLabel(snapshot, fallback) {
    const title = titleOf(snapshot);
    return title || fallback || 'Untitled';
  }
  function createReconciliationView(opts) {
    if (typeof document === 'undefined') return null;
    const o = opts || {};
    const record = o.record || {};
    const left = record.left || {};
    const right = record.right || {};
    const initial = record.result || right || left || {};
    const hunks = Array.isArray(record.hunks) && record.hunks.length
      ? record.hunks
      : simpleTextHunks(left.text, right.text);
    const root = document.createElement('div');
    root.className = 'bc-reconcile';
    root.innerHTML = `
      <div class="bc-editor-bar">
        <span class="bc-editor-title">Resolve conflict</span>
        <div class="bc-editor-bar-actions">
          <button class="icon-btn close-btn" type="button" data-x="close" title="Close (Esc)">&times;</button>
        </div>
      </div>
      <div class="bc-reconcile-body">
        <section class="bc-reconcile-side">
          <div class="bc-reconcile-head">Current</div>
          <div class="bc-reconcile-title">${escapeHtml(snapshotLabel(left, 'Current'))}</div>
          <pre>${escapeHtml(left.text || '')}</pre>
        </section>
        <section class="bc-reconcile-side">
          <div class="bc-reconcile-head">Incoming</div>
          <div class="bc-reconcile-title">${escapeHtml(snapshotLabel(right, 'Incoming'))}</div>
          <pre>${escapeHtml(right.text || '')}</pre>
        </section>
        <section class="bc-reconcile-merge">
          <div class="bc-reconcile-head">Merged result</div>
          <input class="bc-note-title" data-x="title" maxlength="240" placeholder="Title" autocomplete="off" spellcheck="false">
          <textarea class="bc-editor-area" data-x="text" spellcheck="false" wrap="soft"></textarea>
        </section>
      </div>
      <div class="bc-hunks">
        ${hunks.map((hunk) => `<pre class="bc-hunk ${escapeHtml(hunk.type || 'same')}">${escapeHtml(hunk.text || '')}</pre>`).join('')}
      </div>
      <div class="bc-reconcile-actions">
        <button type="button" data-x="left">Accept current</button>
        <button type="button" data-x="right">Accept incoming</button>
        <button type="button" data-x="both">Keep both</button>
        <button type="button" data-x="remove">Remove conflict</button>
        <button type="button" class="primary" data-x="save">Save merged</button>
      </div>`;
    const q = (name) => root.querySelector(`[data-x="${name}"]`);
    const titleInput = q('title');
    const textArea = q('text');
    titleInput.value = cleanTitle(initial.title);
    textArea.value = String(initial.text || '');
    const value = () => ({ title: cleanTitle(titleInput.value), text: textArea.value });
    const setSnapshot = (snapshot) => {
      titleInput.value = titleOf(snapshot);
      textArea.value = String(snapshot && snapshot.text || '');
    };
    const resolve = (action, extra) => {
      if (o.onResolve) o.onResolve({ id: record.id, action, ...value(), ...(extra || {}) });
    };
    q('left').onclick = () => { setSnapshot(left); resolve('accept_left'); };
    q('right').onclick = () => { setSnapshot(right); resolve('accept_right'); };
    q('both').onclick = () => resolve('keep_both');
    q('remove').onclick = () => resolve('remove');
    q('save').onclick = () => resolve('save');
    q('close').onclick = () => { if (o.onClose) o.onClose(); };
    root.addEventListener('keydown', (event) => {
      if (event.key === 'Escape') { event.preventDefault(); if (o.onClose) o.onClose(); }
    });
    setTimeout(() => textArea.focus(), 0);
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
    itemCountLabel,
    escapeHtml,
    builtinFilterTitle,
    builtinFilterIconHtml,
    renderFilterBar,
    renderItemPicker,
    renderClipItem,
    renderClipActions,
    renderPopupShell,
    renderSettingsBody,
    queryMatchIndex,
    collapsedPreviewText,
    highlight,
    resolveTheme,
    applyTheme,
    setActiveThemeSeg,
    applyVariants,
    createVariantSwitcher,
    setActiveVariantSeg,
    createDialogs,
    createClipController,
    findAllMatches,
    countWords,
    lineNumberAtIndex,
    editorScrollTopForIndex,
    createEditor,
    simpleTextHunks,
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
