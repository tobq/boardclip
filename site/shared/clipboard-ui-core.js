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
      item.type === 'image' ? 'image' : item.text || '',
      item.type || '',
      ...groupsOf(item),
    ].join(' ');
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
    return isInGroup(item, key);
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
    return `${filter.count} ${filter.label.toLowerCase().replace(/s$/, '')}${filter.count !== 1 ? 's' : ''}`;
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
    html += groups.map((group) => {
      const count = groupCounts && typeof groupCounts.get === 'function'
        ? groupCounts.get(group) || 0
        : items.filter((item) => isInGroup(item, group)).length;
      const label = escapeHtml(group);
      const stateClass = activeFilters.has(group) ? ' active' : excludedFilters.has(group) ? ' excluded' : '';
      const title = excludedFilters.has(group) ? `Excluding ${group}` : `${count} item${count !== 1 ? 's' : ''} in ${group}`;
      return `<span class="filter-tag${stateClass}" data-group="${label}" title="${escapeHtml(title)}">${label}<span class="gtag-x mi" data-action="delete-group" data-group="${label}">close</span></span>`;
    }).join('');
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
    let gpBtns = groups.map((group) => {
      const label = escapeHtml(group);
      const cls = itemGroups.has(group) ? 'assigned' : 'available';
      return `<span class="gp-btn ${cls}" data-group="${label}">${label}</span>`;
    }).join('');
    if (opts.showAddGroup !== false) {
      gpBtns += '<span class="gp-btn add-group" data-action="add-group" title="New group"><span class="mi" style="font-size:14px">add</span></span>';
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
    const selected = opts.selected ? ' selected' : '';
    return `<div class="item${pinned ? ' has-pin' : ''}${selected}" data-id="${escapeHtml(id)}">
      <div class="item-row">
        <div class="pin-area">
          <button class="star${pinned ? ' active' : ''}" type="button" data-action="pin" data-id="${escapeHtml(id)}" title="${pinned ? 'Unpin' : 'Pin'}"><span class="mi${pinned ? ' filled' : ''}">star</span></button>
          ${opts.pickerHtml || ''}
        </div>
        <div class="content">
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
    const closeStyle = opts.showCloseButtons ? '' : ' style="display:none"';
    return `<div class="main-view" id="${esc(ids.mainView)}">
      <div class="sticky">
        <header>
          <span class="count" id="${esc(ids.count)}"></span>
          ${opts.showSyncButton === false ? '' : `<button class="icon-btn accent" id="${esc(ids.syncHeaderBtn)}" type="button" title="Sync now" aria-label="Sync now"><span class="mi">sync</span></button>`}
          ${headerActionsHtml}
          <button class="icon-btn accent" id="${esc(ids.settingsBtn)}" type="button" title="Settings" aria-label="Settings" aria-expanded="false" aria-controls="${esc(ids.settingsView)}"><span class="mi filled">settings</span></button>
          <button class="icon-btn close-btn" id="${esc(ids.closeBtn)}" type="button" title="Close (Esc)"${closeStyle}>&times;</button>
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
        <button class="icon-btn close-btn" id="${esc(ids.settingsCloseBtn)}" type="button" title="Close (Esc)"${closeStyle}>&times;</button>
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
    const expanded = !!opts.expanded;
    const text = (item && item.text) || '';
    const canExpand = !isImage && (text.length > 120 || /\n/.test(text));
    let html = '';
    if (canExpand) {
      html += `<button class="icon-btn accent" data-action="expand" data-id="${escapeHtml(id)}" title="${expanded ? 'Collapse' : 'Expand'}"><span class="mi">${expanded ? 'unfold_less' : 'unfold_more'}</span></button>`;
    }
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
        <button class="sync-btn" id="syncNow" title="Sync now"><span class="mi" style="font-size:14px;vertical-align:middle">sync</span></button>
      </div>
      <button class="settings-secondary sync-add-folder" id="addSyncFolder" type="button"><span class="mi" style="font-size:14px;vertical-align:middle">create_new_folder</span> Add sync folder</button>
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
        <button class="settings-icon-btn" id="updateNow" title="Check for updates"><span class="mi" style="font-size:14px;vertical-align:middle">system_update_alt</span></button>
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
        <button class="settings-secondary" id="aiMoreClients" type="button" style="display:none"></button>
        <div id="aiClientsMore" class="hidden"></div>
        <div class="ai-subhead" id="aiSecretsHead" style="display:none">Hidden from AI (look like secrets)</div>
        <div id="aiSecrets"></div>
        <div class="ai-subhead" id="aiAlwaysHead" style="display:none">Always allowed actions</div>
        <div id="aiAlwaysAllow"></div>
        <div class="setting-row"><label>Approval timeout (seconds)</label><input id="aiTimeout" type="number" min="5" max="600" step="5"></div>
      </div>
    </div>
    <div class="settings-section">
      <h3>Groups</h3>
      <div id="groupSlots"></div>
      <button class="add-group-btn" id="addGroupBtn"><span class="mi" style="font-size:14px;vertical-align:middle">add</span> New Group</button>
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
    const expanded = new Set();
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
      const exp = t.closest('[data-action="expand"]');
      if (exp) { event.stopPropagation(); const id = exp.dataset.id; if (expanded.has(id)) expanded.delete(id); else expanded.add(id); render(); return true; }
      const del = t.closest('[data-action="del"]');
      if (del) { event.stopPropagation(); const id = del.dataset.id; await a.deleteClip(id); expanded.delete(id); refresh(); toast(a.deletedToast); return true; }
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
      expanded,
      dialogs,
      isExpanded: (id) => expanded.has(id),
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
  // Shared plain-text editor — ONE implementation mounted by BOTH the desktop
  // app (in its own frameless window) and the website demo (in an in-page
  // overlay). Edits are captured live: every keystroke fires onInput (the host
  // persists a crash-safe draft), and after a short idle / on close / on Ctrl+S
  // onCommit fires (the host writes the clip). Find (Ctrl+F), word/char count,
  // revert-to-original, Tab-inserts-tab. The host owns persistence; this owns UI.
  //   opts: { initialText, title, idleMs, onInput(text), onCommit(text), onClose() }
  function createEditor(opts) {
    if (typeof document === 'undefined') return null;
    const o = opts || {};
    const idleMs = o.idleMs || 1200;
    const original = String(o.initialText || '');
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
      <div class="bc-find" data-x="findbar" hidden>
        <input class="bc-find-input" type="text" placeholder="Find" spellcheck="false" autocomplete="off" data-x="findinput">
        <span class="bc-find-count" data-x="findcount"></span>
        <button class="icon-btn" type="button" data-x="findprev" title="Previous (Shift+Enter)"><span class="mi">keyboard_arrow_up</span></button>
        <button class="icon-btn" type="button" data-x="findnext" title="Next (Enter)"><span class="mi">keyboard_arrow_down</span></button>
        <button class="icon-btn" type="button" data-x="findclose" title="Close (Esc)"><span class="mi">close</span></button>
      </div>
      <textarea class="bc-editor-area" spellcheck="false" wrap="soft"></textarea>
      <div class="bc-editor-foot">
        <span data-x="stats"></span>
        <span class="bc-editor-hint">Saved automatically</span>
      </div>`;
    const q = (name) => root.querySelector(`[data-x="${name}"]`);
    const area = root.querySelector('.bc-editor-area');
    const titleEl = root.querySelector('.bc-editor-title');
    const statsEl = q('stats');
    const findBar = q('findbar');
    const findInput = q('findinput');
    const findCount = q('findcount');
    area.value = original;
    titleEl.textContent = o.title || 'Edit clip';

    let idleTimer = null;
    let lastCommitted = original;
    let matches = [];
    let findIdx = -1;

    function updateStats() {
      const t = area.value;
      statsEl.textContent = `${countWords(t)} word${countWords(t) === 1 ? '' : 's'} · ${t.length.toLocaleString()} char${t.length === 1 ? '' : 's'}`;
    }
    function commit() {
      if (idleTimer) { clearTimeout(idleTimer); idleTimer = null; }
      const t = area.value;
      if (t === lastCommitted) return;
      lastCommitted = t;
      if (o.onCommit) o.onCommit(t);
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
    function selectMatch() {
      if (findIdx < 0 || !matches[findIdx]) { findCount.textContent = findInput.value ? '0/0' : ''; return; }
      const m = matches[findIdx];
      area.focus();
      area.setSelectionRange(m.start, m.end);
      findCount.textContent = `${findIdx + 1}/${matches.length}`;
    }
    function recomputeMatches() {
      matches = findAllMatches(area.value, findInput.value);
      if (!matches.length) { findIdx = -1; findCount.textContent = findInput.value ? '0/0' : ''; }
      else if (findIdx < 0 || findIdx >= matches.length) findIdx = 0;
    }
    function step(dir) {
      if (!matches.length) return;
      findIdx = (findIdx + dir + matches.length) % matches.length;
      selectMatch();
    }
    function openFind() {
      findBar.hidden = false;
      const sel = area.value.slice(area.selectionStart, area.selectionEnd);
      if (sel && !sel.includes('\n')) findInput.value = sel.slice(0, 120);
      recomputeMatches();
      selectMatch();
      findInput.focus();
      findInput.select();
    }
    function closeFind() { findBar.hidden = true; area.focus(); }

    area.addEventListener('input', () => {
      updateStats();
      if (o.onInput) o.onInput(area.value);
      scheduleCommit();
      if (!findBar.hidden) { recomputeMatches(); }
    });
    area.addEventListener('keydown', (e) => {
      if (e.key === 'Tab') { e.preventDefault(); insertAtCursor('\t'); }
      else if ((e.ctrlKey || e.metaKey) && !e.shiftKey && e.key.toLowerCase() === 's') { e.preventDefault(); commit(); }
      else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'f') { e.preventDefault(); openFind(); }
    });
    findInput.addEventListener('input', () => { findIdx = -1; recomputeMatches(); selectMatch(); });
    findInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { e.preventDefault(); step(e.shiftKey ? -1 : 1); }
      else if (e.key === 'Escape') { e.preventDefault(); closeFind(); }
    });
    q('findprev').onclick = () => step(-1);
    q('findnext').onclick = () => step(1);
    q('findclose').onclick = closeFind;
    q('find').onclick = openFind;
    q('revert').onclick = () => { area.value = original; updateStats(); if (o.onInput) o.onInput(area.value); commit(); area.focus(); };
    q('close').onclick = () => { commit(); if (o.onClose) o.onClose(); };
    root.addEventListener('keydown', (e) => {
      if (e.key !== 'Escape') return;
      if (!findBar.hidden) { e.preventDefault(); e.stopPropagation(); closeFind(); }
      else { e.preventDefault(); e.stopPropagation(); commit(); if (o.onClose) o.onClose(); }
    });

    updateStats();
    setTimeout(() => area.focus(), 0);
    return {
      el: root,
      getText: () => area.value,
      setText: (t) => { area.value = String(t || ''); updateStats(); },
      commit,
      focus: () => area.focus(),
      openFind,
    };
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
    createDialogs,
    createClipController,
    findAllMatches,
    countWords,
    createEditor,
    sortItems,
    touchItem,
    togglePin,
    assignNumpad,
    toggleGroup,
    deleteItem,
    addClipboardText,
  };
});
