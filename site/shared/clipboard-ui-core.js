(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.BoardClipCore = factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  function isPinned(item) { return item && item.pin != null; }
  function numpadOf(item) { return item && item.pin && typeof item.pin.number === 'number' ? item.pin.number : null; }
  function groupsOf(item) {
    const groups = [];
    if (item && item.pin && Array.isArray(item.pin.groups)) groups.push(...item.pin.groups);
    if (item && Array.isArray(item.labels)) groups.push(...item.labels);
    return [...new Set(groups)];
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
  function matchesQuery(text, query, regex) {
    const q = String(query || '').trim();
    if (!q) return true;
    if (regex) {
      try { return new RegExp(q, 'i').test(text); } catch { return false; }
    }
    return String(text || '').toLowerCase().includes(q.toLowerCase());
  }
  function matchesFilter(item, filters) {
    if (!filters || !filters.size) return true;
    for (const filter of filters) {
      if (filter === '__pinned__' && !isPinned(item)) return false;
      if (filter === '__numbered__' && numpadOf(item) == null) return false;
      if (filter === '__images__' && item.type !== 'image') return false;
      if (!String(filter).startsWith('__') && !isInGroup(item, filter)) return false;
    }
    return true;
  }
  function filterItems(items, state) {
    const filters = state && state.filters;
    const query = state && state.query;
    const regex = state && state.regex;
    return (items || []).filter((item) => matchesFilter(item, filters) && matchesQuery(itemSearchText(item), query, regex));
  }
  function filterItemIndexes(items, state) {
    const filters = state && state.filters;
    const query = state && state.query;
    const regex = state && state.regex;
    const result = [];
    (items || []).forEach((item, index) => {
      if (matchesFilter(item, filters) && matchesQuery(itemSearchText(item), query, regex)) result.push(index);
    });
    return result;
  }
  function itemCountLabel(total, visible, state) {
    const count = Number(total) || 0;
    const shown = Number(visible) || 0;
    const label = count === 1 ? 'item' : 'items';
    return state && (state.query || state.filters && state.filters.size) ? `${shown} of ${count} ${label}` : `${count} ${label}`;
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
    const activeFilters = options.activeFilters || new Set();
    const query = options.query || '';
    let html = '';
    for (const filter of builtinFilters(items, activeFilters)) {
      html += `<span class="filter-tag builtin icon-filter${filter.active ? ' active' : ''}" data-filter="${escapeHtml(filter.id)}" title="${escapeHtml(builtinFilterTitle(filter))}" aria-label="${escapeHtml(filter.ariaLabel)}">${builtinFilterIconHtml(filter, options)}</span>`;
    }
    html += groups.map((group) => {
      const count = items.filter((item) => isInGroup(item, group)).length;
      const label = escapeHtml(group);
      return `<span class="filter-tag${activeFilters.has(group) ? ' active' : ''}" data-group="${label}" title="${count} item${count !== 1 ? 's' : ''} in ${label}">${label}<span class="gtag-x mi" data-action="delete-group" data-group="${label}">close</span></span>`;
    }).join('');
    if (activeFilters.size && !query) {
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
    const display = options && options.expanded ? text : text.replace(/\r?\n/g, ' ');
    if (options && typeof options.highlight === 'function') return options.highlight(display);
    return escapeHtml(display);
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
    if (pinned) metaHtml += '<span class="pin-tag">pinned</span>';
    for (const group of groupsOf(item)) metaHtml += `<span class="group-tag">${escapeHtml(group)}</span>`;
    const previewClass = opts.expanded ? 'expanded' : 'collapsed';
    const selected = opts.selected ? ' selected' : '';
    return `<div class="item${pinned ? ' has-pin' : ''}${selected}" data-id="${escapeHtml(id)}">
      <div class="item-row">
        <div class="pin-area">
          <button class="star${pinned ? ' active' : ''}" data-action="pin" data-id="${escapeHtml(id)}" title="${pinned ? 'Unpin' : 'Pin'}"><span class="mi${pinned ? ' filled' : ''}">star</span></button>
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
    matchesQuery,
    matchesFilter,
    filterItems,
    filterItemIndexes,
    itemCountLabel,
    escapeHtml,
    builtinFilterTitle,
    builtinFilterIconHtml,
    renderFilterBar,
    renderClipItem,
    sortItems,
    touchItem,
    togglePin,
    assignNumpad,
    toggleGroup,
    deleteItem,
    addClipboardText,
  };
});
