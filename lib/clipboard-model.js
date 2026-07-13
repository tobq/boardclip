'use strict';

const crypto = require('crypto');

const DEFAULT_SETTINGS = {
  max_age_days: 7,
  max_size_gb: 10,
  regex_search: false,
  theme_mode: 'system', // 'system' | 'light' | 'dark' — popup appearance
  // Appearance variants (per-machine, not synced). surface_style is a real user
  // setting; the rest are dev-only auditioning knobs baked to a default in ship.
  surface_style: 'auto', // 'auto' | 'glass' | 'solid' — auto = glass where supported
  accent_variant: 'blue', // 'blue' | 'teal' | 'mono'
  ui_density: 'normal',   // 'normal' | 'compact'
  ui_corners: 'soft',     // 'soft' | 'sharp'
  ui_borders: 'bordered', // 'bordered' | 'borderless'
  show_shortcut: '',
  quick_paste_shortcut: '',
  // Quick-paste (numpad slots + panel number keys) behaviour. Per-machine, not
  // synced — these are about how THIS machine drives the OS paste, not content.
  // 'clipboard' = the real paste API (set clipboard + Ctrl/Cmd+V + restore),
  // made robust by lib/quick-paste.js (serialize, verify-the-write-landed,
  // safe + lag-adaptive restore). 'type' injects keystrokes (no clipboard, no
  // restore race) but is slower and turns newlines into real Enter presses, so
  // it is opt-in only. Default is real paste.
  quick_paste_restore: true,          // restore the previous clipboard after a quick-paste
  quick_paste_restore_delay_ms: 400,  // floor delay before restore; adapts up under lag
  groups: [],
  sync_path: '',
  sync_custom_paths: [],
  sync_disabled_paths: [],
  p2p_enabled: true,
  p2p_device_id: '',
  p2p_secret: '',
  diagnostics_enabled: false,
  popup_size: null,
  editor_bounds: null, // built-in editor window bounds (per-machine, not synced)
  tombstones: [],
  group_tombstones: [],
  // Edit lineage for content-hash ids. Every text edit changes id, so sync needs
  // to know old-id -> new-id is a rename/edit, not a hard delete tombstone.
  supersedes: [],
  // AI Access (local MCP server). See lib/mcp-core.js and the MCP section in main.js.
  ai_access_enabled: false,
  groups_shared_with_ai: [],   // group names whose clips are exposed to AI (curation allowlist)
  ai_always_allow: [],         // MCP tool names the user chose to always allow (skip approval modal)
  ai_approval_timeout_sec: 60, // approval modal deny-by-default countdown
  mcp_secret: '',              // per-machine control-channel HMAC secret (not synced)
  // In-app AI Search (BYO endpoint). Per-machine, never synced (like mcp_secret). Offline
  // "smart ranking" (token-IDF + title fuzzy) always works; these enable the LLM agent.
  ai_search_endpoint: '',      // Anthropic-compatible base URL, e.g. https://cp.twoshot.app
  ai_search_key: '',           // API key for the endpoint
  ai_search_model: '',         // model id (e.g. claude-3-5-sonnet-latest)
  ai_search_scope: 'all',      // 'all' = whole history (user-initiated) | 'shared' = shared groups only
};

const TOMBSTONE_MAX_AGE_MS = 30 * 86400 * 1000;
const TEXT_HASH_RE = /^[a-f0-9]{64}$/i;
const DEFAULT_DESTRUCTIVE_PRUNE_FRACTION = 0.25;

function textHashForText(text) {
  return crypto.createHash('sha256').update(String(text || ''), 'utf8').digest('hex');
}

function normalizedTextHash(hash) {
  const value = String(hash || '').trim().toLowerCase();
  return TEXT_HASH_RE.test(value) ? value : '';
}

function itemTextHash(item) {
  if (!item || item.type === 'image') return '';
  return normalizedTextHash(item.textHash) || textHashForText(item.text || '');
}

function textByteLength(text) {
  return Buffer.byteLength(String(text || ''), 'utf8');
}

function itemHasVerifiedFullText(item) {
  if (!item || item.type === 'image') return false;
  const text = String(item.text || '');
  const hash = normalizedTextHash(item.textHash);
  if (!item.textRef && !hash) return true;
  if (hash) return textHashForText(text) === hash;
  const size = Number(item.textSize) || 0;
  return !size || textByteLength(text) >= size;
}

function textPayloadScore(item) {
  if (!item || item.type === 'image') return -1;
  if (itemHasVerifiedFullText(item)) return 3;
  if (item.text && !item.textRef) return 2;
  if (item.textHash || item.textRef) return 1;
  return 0;
}

function migrateItemPin(item) {
  if ('pin' in item) return item;
  const pin = {};
  let pinned = false;
  if (typeof item.pinned === 'number') {
    pin.number = item.pinned;
    pinned = true;
  } else if (item.pinned === true) {
    pinned = true;
  }
  if (item.group) {
    pin.groups = [item.group];
    pinned = true;
  }
  item.pin = pinned ? pin : null;
  delete item.pinned;
  delete item.group;
  return item;
}

function isPinned(item) { return item.pin != null; }
function numpadSlotOf(item) {
  return item.pin && typeof item.pin.number === 'number' ? item.pin.number : null;
}
function groupsOf(item) {
  return item.pin && Array.isArray(item.pin.groups) ? item.pin.groups : [];
}
function hasNumpadSlot(item, n) { return numpadSlotOf(item) === n; }
function ensurePin(item) {
  if (!item.pin) item.pin = {};
  return item.pin;
}

function setInlineText(item, text) {
  if (!item || item.type === 'image') return item;
  item.text = String(text || '');
  delete item.textHash;
  delete item.textRef;
  delete item.textSize;
  delete item.textPreview;
  return item;
}

function cleanTitle(value) {
  return String(value == null ? '' : value).replace(/\s+/g, ' ').trim().slice(0, 240);
}

function titleOf(item) {
  return cleanTitle(item && item.title);
}

function titleUpdatedAt(item) {
  if (!item || item.type === 'image') return 0;
  return timestamp(item.titleUpdatedAt) || (titleOf(item) ? itemUpdatedAt(item) : 0);
}

function setTitleMetadata(item, title, updatedAt = Date.now()) {
  if (!item || item.type === 'image') return item;
  const nextTitle = cleanTitle(title);
  const nextUpdatedAt = timestamp(updatedAt) || Date.now();
  if (nextTitle) item.title = nextTitle;
  else delete item.title;
  item.titleUpdatedAt = nextUpdatedAt;
  if (timestamp(item.updatedAt) < nextUpdatedAt) item.updatedAt = nextUpdatedAt;
  return item;
}

function titleState(item) {
  const title = titleOf(item);
  const updatedAt = titleUpdatedAt(item);
  return { title, updatedAt, known: !!title || updatedAt > 0 };
}

function mergeTitleMetadata(base, localItem, remoteItem) {
  if (!base || base.type === 'image') return base;
  const local = titleState(localItem);
  const remote = titleState(remoteItem);
  let winner = null;
  if (local.known && remote.known) {
    if (remote.updatedAt > local.updatedAt) winner = remote;
    else if (local.updatedAt > remote.updatedAt) winner = local;
    else winner = remote.title.length >= local.title.length ? remote : local;
  } else if (local.known) winner = local;
  else if (remote.known) winner = remote;

  if (!winner) {
    delete base.title;
    delete base.titleUpdatedAt;
    return base;
  }
  if (winner.title) base.title = winner.title;
  else delete base.title;
  if (winner.updatedAt) base.titleUpdatedAt = winner.updatedAt;
  else delete base.titleUpdatedAt;
  return base;
}

function itemTextForConflict(item) {
  if (!item || item.type === 'image') return '';
  return String(item.text != null ? item.text : (item.textPreview || ''));
}

function conflictSnapshot(item, fallback = {}) {
  const source = item || {};
  return {
    id: (item ? itemKey(source) : '') || fallback.id || '',
    type: source.type === 'image' ? 'image' : 'text',
    title: titleOf(source) || cleanTitle(fallback.title),
    text: itemTextForConflict(source) || String(fallback.text || ''),
    groups: groupsOf(source),
    ts: timestamp(source.ts) || timestamp(fallback.ts),
    updatedAt: timestamp(source.updatedAt) || timestamp(fallback.updatedAt),
    titleUpdatedAt: titleUpdatedAt(source) || timestamp(fallback.titleUpdatedAt),
  };
}

function titleConflict(localItem, remoteItem) {
  if (!localItem || !remoteItem || localItem.type === 'image' || remoteItem.type === 'image') return false;
  if (itemKey(localItem) !== itemKey(remoteItem)) return false;
  const local = titleState(localItem);
  const remote = titleState(remoteItem);
  return local.known && remote.known && local.title !== remote.title;
}

function legacyContentKey(item) {
  if (item.type === 'image') return `img:${item.image}`;
  return `txt:${itemTextHash(item)}`;
}

function ensureItemId(item) {
  if (!item.id) item.id = legacyContentKey(item);
  return item.id;
}

function itemKey(item) {
  return item && (item.id || legacyContentKey(item));
}

function normalizeTombstones(list, now = Date.now()) {
  const cutoff = now - TOMBSTONE_MAX_AGE_MS;
  const byId = new Map();
  for (const tombstone of Array.isArray(list) ? list : []) {
    if (!tombstone || !tombstone.id) continue;
    const deletedAt = Number(tombstone.deletedAt) || 0;
    if (deletedAt < cutoff) continue;
    const existing = byId.get(tombstone.id);
    if (!existing || deletedAt > existing.deletedAt) byId.set(tombstone.id, { id: tombstone.id, deletedAt });
  }
  return [...byId.values()];
}

function normalizeGroupTombstones(list, now = Date.now()) {
  const cutoff = now - TOMBSTONE_MAX_AGE_MS;
  const byName = new Map();
  for (const tombstone of Array.isArray(list) ? list : []) {
    if (!tombstone || !tombstone.name) continue;
    const name = String(tombstone.name);
    const deletedAt = Number(tombstone.deletedAt) || 0;
    if (deletedAt < cutoff) continue;
    const existing = byName.get(name);
    if (!existing || deletedAt > existing.deletedAt) byName.set(name, { name, deletedAt });
  }
  return [...byName.values()];
}

function normalizeSupersedes(list, now = Date.now()) {
  const cutoff = now - TOMBSTONE_MAX_AGE_MS;
  const byFrom = new Map();
  for (const record of Array.isArray(list) ? list : []) {
    if (!record || !record.from || !record.to || record.from === record.to) continue;
    const updatedAt = Number(record.updatedAt) || 0;
    if (updatedAt < cutoff) continue;
    const from = String(record.from);
    const to = String(record.to);
    const existing = byFrom.get(from);
    if (!existing || updatedAt > existing.updatedAt) byFrom.set(from, { from, to, updatedAt });
  }
  return [...byFrom.values()];
}

function supersedeMap(list) {
  const direct = new Map(normalizeSupersedes(list).map(record => [record.from, record.to]));
  const resolved = new Map();
  const resolve = (id, seen = new Set()) => {
    const value = String(id || '');
    if (!direct.has(value) || seen.has(value)) return value;
    seen.add(value);
    return resolve(direct.get(value), seen);
  };
  for (const from of direct.keys()) resolved.set(from, resolve(from));
  return resolved;
}

function tombstoneIds(list) {
  return new Set(normalizeTombstones(list).map(t => t.id));
}

function groupTombstoneNames(list) {
  return new Set(normalizeGroupTombstones(list).map(t => t.name));
}

function timestamp(value) {
  const n = Number(value) || 0;
  return Number.isFinite(n) ? n : 0;
}

function timestampMs(value) {
  const n = timestamp(value);
  if (!n) return 0;
  return n < 100000000000 ? n * 1000 : n;
}

function pinUpdatedAt(item) {
  if (!item) return 0;
  const pin = item.pin || null;
  return Math.max(
    timestamp(item.pinUpdatedAt),
    pin ? timestamp(pin.updatedAt) : 0,
    pin ? timestamp(pin.numberUpdatedAt) : 0,
    pin ? timestamp(pin.groupsUpdatedAt) : 0
  );
}

function pinMetadataUpdatedAt(pin, fallback = 0) {
  return pin ? timestamp(pin.updatedAt) || timestamp(fallback) : timestamp(fallback);
}

function groupState(pin, fallback = 0) {
  if (!pin) return { known: false, groups: [], updatedAt: 0 };
  const groups = Array.isArray(pin.groups) ? pin.groups : [];
  const explicitUpdatedAt = timestamp(pin.groupsUpdatedAt);
  const updatedAt = explicitUpdatedAt || (groups.length ? pinMetadataUpdatedAt(pin, fallback) : 0);
  return {
    known: groups.length > 0 || explicitUpdatedAt > 0,
    explicit: explicitUpdatedAt > 0,
    groups,
    updatedAt,
  };
}

function numberState(pin, fallback = 0) {
  if (!pin) return { known: false, number: null, updatedAt: 0 };
  const hasNumber = typeof pin.number === 'number';
  const explicitUpdatedAt = timestamp(pin.numberUpdatedAt);
  const updatedAt = explicitUpdatedAt || (hasNumber ? pinMetadataUpdatedAt(pin, fallback) : 0);
  return {
    known: hasNumber || explicitUpdatedAt > 0,
    number: hasNumber ? pin.number : null,
    updatedAt,
  };
}

function cleanPin(pin, deletedGroups = new Set()) {
  if (!pin) return null;
  const cleaned = { ...pin };
  if (typeof cleaned.number !== 'number') delete cleaned.number;
  if (Array.isArray(cleaned.groups)) {
    cleaned.groups = cleaned.groups.filter(g => !deletedGroups.has(g));
    if (!cleaned.groups.length) delete cleaned.groups;
  }
  return cleaned;
}

function mergeGroupState(localPin, remotePin, localUpdatedAt, remoteUpdatedAt, deletedGroups) {
  const local = groupState(localPin, localUpdatedAt);
  const remote = groupState(remotePin, remoteUpdatedAt);
  let groups = [];
  let updatedAt = 0;

  if (local.known && remote.known) {
    updatedAt = Math.max(local.updatedAt, remote.updatedAt);
    if (!local.explicit && !remote.explicit) groups = [...new Set([...local.groups, ...remote.groups])];
    else if (local.updatedAt > remote.updatedAt) groups = local.groups;
    else if (remote.updatedAt > local.updatedAt) groups = remote.groups;
    else groups = [...new Set([...local.groups, ...remote.groups])];
  } else if (local.known) {
    groups = local.groups;
    updatedAt = local.updatedAt;
  } else if (remote.known) {
    groups = remote.groups;
    updatedAt = remote.updatedAt;
  }

  groups = [...new Set(groups)].filter(g => !deletedGroups.has(g));
  return { known: local.known || remote.known, groups, updatedAt };
}

function mergeNumberState(localPin, remotePin, localUpdatedAt, remoteUpdatedAt) {
  const local = numberState(localPin, localUpdatedAt);
  const remote = numberState(remotePin, remoteUpdatedAt);
  if (local.known && remote.known) {
    const updatedAt = Math.max(local.updatedAt, remote.updatedAt);
    if (remote.updatedAt > local.updatedAt) return { ...remote, updatedAt };
    if (local.updatedAt > remote.updatedAt) return { ...local, updatedAt };
    if (local.number == null && remote.number != null) return { ...remote, updatedAt };
    if (remote.number == null && local.number != null) return { ...local, updatedAt };
    return (remote.number || 0) > (local.number || 0) ? { ...remote, updatedAt } : { ...local, updatedAt };
  }
  if (local.known) return local;
  if (remote.known) return remote;
  return { known: false, number: null, updatedAt: 0 };
}

function mergePins(localPin, remotePin, localUpdatedAt = 0, remoteUpdatedAt = 0, groupTombstones = []) {
  if (!localPin && !remotePin) return null;
  const deletedGroups = groupTombstoneNames(groupTombstones);
  const localPinUpdated = pinMetadataUpdatedAt(localPin, localUpdatedAt);
  const remotePinUpdated = pinMetadataUpdatedAt(remotePin, remoteUpdatedAt);

  if (!localPin && remotePin) return timestamp(localUpdatedAt) > remotePinUpdated ? null : cleanPin(remotePin, deletedGroups);
  if (localPin && !remotePin) return timestamp(remoteUpdatedAt) > localPinUpdated ? null : cleanPin(localPin, deletedGroups);

  const merged = {};
  const groups = mergeGroupState(localPin, remotePin, localPinUpdated, remotePinUpdated, deletedGroups);
  if (groups.groups.length) merged.groups = groups.groups;
  if (groups.known && groups.updatedAt) merged.groupsUpdatedAt = groups.updatedAt;

  const number = mergeNumberState(localPin, remotePin, localPinUpdated, remotePinUpdated);
  if (number.number != null) merged.number = number.number;
  if (number.known && number.updatedAt) merged.numberUpdatedAt = number.updatedAt;

  const updatedAt = Math.max(localPinUpdated, remotePinUpdated, groups.updatedAt, number.updatedAt);
  if (updatedAt) merged.updatedAt = updatedAt;
  return merged;
}

function mergeItemTimestamp(localItem, remoteItem, base) {
  const localTs = timestamp(localItem.ts);
  const remoteTs = timestamp(remoteItem.ts);
  const localTsUpdated = timestamp(localItem.tsUpdatedAt);
  const remoteTsUpdated = timestamp(remoteItem.tsUpdatedAt);
  if (localTsUpdated || remoteTsUpdated) {
    if (remoteTsUpdated > localTsUpdated) base.ts = remoteTs;
    else if (localTsUpdated > remoteTsUpdated) base.ts = localTs;
    else base.ts = Math.max(localTs, remoteTs); // deterministic clock-collision tie-break
    base.tsUpdatedAt = Math.max(localTsUpdated, remoteTsUpdated) || undefined;
  } else {
    base.ts = Math.max(localTs, remoteTs);
    delete base.tsUpdatedAt;
  }
  return base;
}

function mergeItems(localItem, remoteItem, groupTombstones = []) {
  migrateItemPin(localItem);
  migrateItemPin(remoteItem);
  ensureItemId(localItem);
  ensureItemId(remoteItem);
  const localTs = localItem.ts || 0;
  const remoteTs = remoteItem.ts || 0;
  const localUpdated = localItem.updatedAt || localTs;
  const remoteUpdated = remoteItem.updatedAt || remoteTs;
  const localPinUpdated = pinUpdatedAt(localItem);
  const remotePinUpdated = pinUpdatedAt(remoteItem);
  const base = remoteUpdated > localUpdated ? { ...remoteItem } : { ...localItem };
  base.id = itemKey(base);
  // tsUpdatedAt is the LWW clock for an intentional capture-time correction or
  // recapture. Legacy replicas have no clock, so a repaired timestamp cannot be
  // re-clobbered by an old provider that still carries the inflated value.
  mergeItemTimestamp(localItem, remoteItem, base);
  base.updatedAt = Math.max(localItem.updatedAt || 0, remoteItem.updatedAt || 0) || undefined;
  base.pinUpdatedAt = Math.max(localPinUpdated, remotePinUpdated) || undefined;
  base.pin = mergePins(
    localItem.pin,
    remoteItem.pin,
    localPinUpdated,
    remotePinUpdated,
    groupTombstones
  );
  mergeTextPayload(base, localItem, remoteItem);
  mergeTitleMetadata(base, localItem, remoteItem);
  return base;
}

function mergeSupersededStaleIntoTarget(targetItem, staleItem, groupTombstones = []) {
  // The stale item is an older content-hash id in the same edit lineage. It may
  // still carry useful pin/title metadata, but its TEXT must never overwrite the
  // newer target text: that is the exact stale-provider regression this fixes.
  migrateItemPin(targetItem);
  migrateItemPin(staleItem);
  ensureItemId(targetItem);
  ensureItemId(staleItem);
  const base = { ...targetItem };
  const targetPinUpdated = pinUpdatedAt(targetItem);
  const stalePinUpdated = pinUpdatedAt(staleItem);
  base.id = itemKey(targetItem);
  mergeItemTimestamp(targetItem, staleItem, base);
  base.updatedAt = Math.max(targetItem.updatedAt || 0, staleItem.updatedAt || 0) || undefined;
  base.pinUpdatedAt = Math.max(targetPinUpdated, stalePinUpdated) || undefined;
  base.pin = mergePins(targetItem.pin, staleItem.pin, targetPinUpdated, stalePinUpdated, groupTombstones);
  mergeTitleMetadata(base, targetItem, staleItem);
  return base;
}

function mergeTextPayload(base, localItem, remoteItem) {
  if (!base || base.type === 'image') return base;
  const candidates = [base, localItem, remoteItem].filter(item => item && item.type !== 'image');
  const bestText = candidates
    .slice()
    .sort((a, b) => {
      const score = textPayloadScore(b) - textPayloadScore(a);
      if (score) return score;
      return String(b.text || '').length - String(a.text || '').length;
    })[0];
  const bestMeta = candidates.find(item => item.textHash || item.textRef || item.textSize || item.textPreview);

  if (bestText && textPayloadScore(bestText) >= 2) {
    base.text = bestText.text || '';
  } else if (!base.text && bestMeta) {
    base.text = bestMeta.textPreview || bestMeta.text || '';
  }

  for (const field of ['textHash', 'textRef', 'textSize', 'textPreview']) {
    const source = candidates.find(item => item[field] !== undefined);
    if (source) base[field] = source[field];
    else delete base[field];
  }
  return base;
}

function itemUpdatedAt(item) {
  if (!item) return 0;
  return timestamp(item.updatedAt) || timestampMs(item.ts);
}

function numpadSlotUpdatedAt(item) {
  if (!item || !item.pin) return 0;
  return timestamp(item.pin.numberUpdatedAt) || pinUpdatedAt(item) || itemUpdatedAt(item);
}

function isBetterNumpadClaim(item, current) {
  if (!current) return true;
  const itemSlotUpdatedAt = numpadSlotUpdatedAt(item);
  const currentSlotUpdatedAt = numpadSlotUpdatedAt(current);
  if (itemSlotUpdatedAt !== currentSlotUpdatedAt) return itemSlotUpdatedAt > currentSlotUpdatedAt;

  const itemUpdated = itemUpdatedAt(item);
  const currentUpdated = itemUpdatedAt(current);
  if (itemUpdated !== currentUpdated) return itemUpdated > currentUpdated;

  return String(itemKey(item)) > String(itemKey(current));
}

function removeNumpadSlot(item, updatedAt) {
  if (!item || !item.pin) return false;
  let changed = false;
  if (typeof item.pin.number === 'number') {
    delete item.pin.number;
    changed = true;
  }

  const nextUpdatedAt = timestamp(updatedAt);
  if (nextUpdatedAt) {
    if (timestamp(item.pin.numberUpdatedAt) < nextUpdatedAt) {
      item.pin.numberUpdatedAt = nextUpdatedAt;
      changed = true;
    }
    if (timestamp(item.pin.updatedAt) < nextUpdatedAt) {
      item.pin.updatedAt = nextUpdatedAt;
      changed = true;
    }
    if (timestamp(item.pinUpdatedAt) < nextUpdatedAt) {
      item.pinUpdatedAt = nextUpdatedAt;
      changed = true;
    }
    if (timestamp(item.updatedAt) < nextUpdatedAt) {
      item.updatedAt = nextUpdatedAt;
      changed = true;
    }
  }
  return changed;
}

function dedupeNumpadSlots(items) {
  let changed = false;
  const bestBySlot = new Map();
  for (const item of items) {
    const slot = numpadSlotOf(item);
    if (slot == null) continue;
    const current = bestBySlot.get(slot);
    if (isBetterNumpadClaim(item, current)) bestBySlot.set(slot, item);
  }
  for (const item of items) {
    const slot = numpadSlotOf(item);
    if (slot != null && bestBySlot.get(slot) !== item) {
      const winner = bestBySlot.get(slot);
      const resolvedAt = Math.max(numpadSlotUpdatedAt(item), numpadSlotUpdatedAt(winner)) + 1;
      if (removeNumpadSlot(item, resolvedAt)) changed = true;
    }
  }
  return changed;
}

function legacySlotMatchesItem(slot, item) {
  if (!slot || !item) return false;
  if (slot.type === 'image') return item.type === 'image' && item.image === slot.image;
  return item.type !== 'image' && String(item.text || '') === String(slot.text || '');
}

function setNumpadSlot(item, slot, updatedAt) {
  const pin = ensurePin(item);
  const nextUpdatedAt = timestamp(updatedAt);
  pin.number = slot;
  if (nextUpdatedAt) {
    pin.numberUpdatedAt = nextUpdatedAt;
    pin.updatedAt = nextUpdatedAt;
    item.pinUpdatedAt = nextUpdatedAt;
    item.updatedAt = nextUpdatedAt;
  }
}

function createHistoryItemForLegacySlot(slot, number, updatedAt) {
  const item = slot.type === 'image'
    ? { type: 'image', image: slot.image || '', ts: updatedAt / 1000 }
    : { type: 'text', text: String(slot.text || ''), ts: updatedAt / 1000 };
  setNumpadSlot(item, number, updatedAt);
  ensureItemId(item);
  return item;
}

function migrateLegacyNumpadSlots(history, oldSlots, options = {}) {
  const items = Array.isArray(history) ? history : [];
  if (!oldSlots || typeof oldSlots !== 'object') return { changed: false, migrated: 0, created: 0, skipped: 0 };

  for (const item of items) {
    migrateItemPin(item);
    ensureItemId(item);
  }

  const now = timestamp(options.now) || Date.now();
  let changed = false;
  let migrated = 0;
  let created = 0;
  let skipped = 0;

  for (const [numStr, rawSlot] of Object.entries(oldSlots)) {
    const slotNumber = Number.parseInt(numStr, 10);
    if (!Number.isInteger(slotNumber) || slotNumber < 1 || slotNumber > 9 || !rawSlot) {
      skipped++;
      continue;
    }

    const slot = typeof rawSlot === 'string' ? { type: 'text', text: rawSlot } : rawSlot;
    const existingClaim = items.find(item => hasNumpadSlot(item, slotNumber));
    const match = items.find(item => legacySlotMatchesItem(slot, item));

    if (existingClaim && (!match || itemKey(existingClaim) !== itemKey(match))) {
      skipped++;
      continue;
    }
    if (existingClaim && match && itemKey(existingClaim) === itemKey(match)) {
      continue;
    }

    if (match) {
      setNumpadSlot(match, slotNumber, now);
      changed = true;
      migrated++;
      continue;
    }

    const createdItem = createHistoryItemForLegacySlot(slot, slotNumber, now);
    items.unshift(createdItem);
    changed = true;
    migrated++;
    created++;
  }

  if (dedupeNumpadSlots(items)) changed = true;
  return { changed, migrated, created, skipped };
}

function groupsOnlyPin(groups, updatedAt, groupTombstones = []) {
  const deleted = groupTombstoneNames(groupTombstones);
  const cleanGroups = [...new Set((Array.isArray(groups) ? groups : [])
    .map(group => String(group || '').trim())
    .filter(group => group && !deleted.has(group)))];
  if (!cleanGroups.length) return null;
  const ts = timestamp(updatedAt) || Date.now();
  return { groups: cleanGroups, updatedAt: ts, groupsUpdatedAt: ts };
}

function touchNumpadMetadata(item, updatedAt) {
  if (!item || !item.pin || typeof item.pin.number !== 'number') return;
  const ts = timestamp(updatedAt) || Date.now();
  item.pin.numberUpdatedAt = ts;
  item.pin.updatedAt = ts;
  item.pinUpdatedAt = ts;
  item.updatedAt = ts;
}

function moveIndexToFront(items, index) {
  if (index <= 0) return;
  const item = items.splice(index, 1)[0];
  items.unshift(item);
}

function applyTextEdit(items, options = {}) {
  const history = Array.isArray(items) ? items : [];
  const originalText = String(options.originalText || '');
  const newText = String(options.newText || '');
  const textChanged = newText !== originalText;
  const tombstoneIds = [];
  const supersedes = [];
  const titleEditRequested = options.originalTitle !== undefined || options.newTitle !== undefined;

  if (!textChanged && !titleEditRequested) return { changed: false, reason: 'unchanged', tombstoneIds };
  if (options.ignoreBlank !== false && !newText.trim()) return { changed: false, reason: 'blank', tombstoneIds };

  const now = timestamp(options.now) || Date.now();
  const nowSeconds = now / 1000;
  const id = String(options.id || '');
  const groupTombstones = options.groupTombstones || [];

  for (const item of history) {
    migrateItemPin(item);
    ensureItemId(item);
  }

  const currentIndex = id ? history.findIndex(item => itemKey(item) === id) : -1;
  const current = currentIndex >= 0 ? history[currentIndex] : null;
  const originalTitle = titleEditRequested
    ? (options.originalTitle !== undefined ? cleanTitle(options.originalTitle) : titleOf(current))
    : titleOf(current);
  const newTitle = titleEditRequested
    ? (options.newTitle !== undefined ? cleanTitle(options.newTitle) : originalTitle)
    : originalTitle;
  const titleChanged = titleEditRequested && newTitle !== originalTitle;
  if (!textChanged && !titleChanged) return { changed: false, reason: 'unchanged', tombstoneIds };
  const canUpdateCurrent = current && current.type !== 'image' && String(current.text || '') === originalText;
  const currentBefore = current ? conflictSnapshot(current, { id, text: originalText, title: originalTitle }) : null;
  const currentTitle = current ? titleOf(current) : '';
  const titleDiverged = !!(canUpdateCurrent && titleChanged && currentTitle !== originalTitle);
  const oldId = canUpdateCurrent ? itemKey(current) : '';
  const edited = canUpdateCurrent
    ? current
    : {
      type: 'text',
      text: originalText,
      ts: nowSeconds,
      updatedAt: now,
      pin: groupsOnlyPin(options.sourceGroups, now, groupTombstones),
    };

  if (edited.pin && !edited.pinUpdatedAt) edited.pinUpdatedAt = now;
  if (textChanged || !canUpdateCurrent) setInlineText(edited, newText);
  if (titleEditRequested) setTitleMetadata(edited, newTitle, now);
  edited.ts = nowSeconds;
  edited.updatedAt = now;
  edited.id = legacyContentKey(edited);
  touchNumpadMetadata(edited, now);

  const editedId = itemKey(edited);
  const existingIndex = history.findIndex(item => item !== edited && item.type !== 'image' && itemKey(item) === editedId);
  if (existingIndex >= 0) {
    const existing = history[existingIndex];
    const existingBefore = conflictSnapshot(existing);
    const existingPinUpdated = pinUpdatedAt(existing);
    const editedPinUpdated = pinUpdatedAt(edited);
    setInlineText(existing, newText);
    if (titleChanged || newTitle || titleOf(existing)) mergeTitleMetadata(existing, existing, edited);
    existing.id = editedId;
    existing.ts = nowSeconds;
    existing.updatedAt = now;
    existing.pin = mergePins(existing.pin, edited.pin, existingPinUpdated, editedPinUpdated, groupTombstones);
    existing.pinUpdatedAt = Math.max(pinUpdatedAt(existing), editedPinUpdated, existingPinUpdated) || undefined;
    if (canUpdateCurrent) {
      const removeIndex = history.indexOf(current);
      if (removeIndex >= 0) history.splice(removeIndex, 1);
      if (oldId && oldId !== editedId) {
        tombstoneIds.push(oldId);
        supersedes.push({ from: oldId, to: editedId, updatedAt: now });
      }
    }
    moveIndexToFront(history, history.indexOf(existing));
    dedupeNumpadSlots(history);
    const titleMergeConflict = titleConflict(existingBefore, edited);
    const conflict = current && (!canUpdateCurrent || titleDiverged || titleMergeConflict)
      ? {
        kind: titleDiverged || titleMergeConflict ? 'title' : 'editor',
        base: { id, type: 'text', text: originalText, title: originalTitle },
        left: titleMergeConflict ? existingBefore : (currentBefore || existingBefore),
        right: conflictSnapshot(edited, { text: newText, title: newTitle }),
        targetId: itemKey(existing),
      }
      : null;
    return {
      changed: true,
      reason: canUpdateCurrent || !current ? 'merged' : 'conflict_merged',
      item: existing,
      tombstoneIds,
      supersedes,
      conflict,
    };
  }

  if (canUpdateCurrent) {
    moveIndexToFront(history, history.indexOf(current));
    if (oldId && oldId !== editedId) {
      tombstoneIds.push(oldId);
      supersedes.push({ from: oldId, to: editedId, updatedAt: now });
    }
    dedupeNumpadSlots(history);
    return {
      changed: true,
      reason: 'updated',
      item: current,
      tombstoneIds,
      supersedes,
      conflict: titleDiverged
        ? {
          kind: 'title',
          base: { id, type: 'text', text: originalText, title: originalTitle },
          left: currentBefore,
          right: conflictSnapshot(current, { text: newText, title: newTitle }),
          targetId: itemKey(current),
        }
        : null,
    };
  }

  ensureItemId(edited);
  history.unshift(edited);
  dedupeNumpadSlots(history);
  return {
    changed: true,
    reason: id || originalText ? 'conflict_created' : 'created',
    item: edited,
    tombstoneIds,
    supersedes,
    conflict: current
      ? {
        kind: 'editor',
        base: { id, type: 'text', text: originalText, title: originalTitle },
        left: currentBefore,
        right: conflictSnapshot(edited, { text: newText, title: newTitle }),
        targetId: itemKey(edited),
      }
      : null,
  };
}

function mergeHistories(local, remote, settings = {}) {
  local = Array.isArray(local) ? local : [];
  remote = Array.isArray(remote) ? remote : [];
  const deleted = tombstoneIds(settings.tombstones);
  const groupTombstones = settings.group_tombstones || [];
  const lineage = supersedeMap(settings.supersedes);
  const allKeys = new Set();
  for (const item of [...local, ...remote]) {
    if (!item) continue;
    migrateItemPin(item);
    ensureItemId(item);
    allKeys.add(itemKey(item));
  }
  const merged = new Map();
  const pendingStaleByTarget = new Map();

  const foldPending = (targetKey) => {
    const pending = pendingStaleByTarget.get(targetKey);
    if (!pending || !merged.has(targetKey)) return;
    let target = merged.get(targetKey);
    for (const stale of pending) target = mergeSupersededStaleIntoTarget(target, stale, groupTombstones);
    merged.set(targetKey, target);
    pendingStaleByTarget.delete(targetKey);
  };

  const addItem = (item) => {
    if (!item) return;
    const key = itemKey(item);
    const targetKey = lineage.get(key);
    if (targetKey && deleted.has(targetKey)) return;
    if (deleted.has(key) && !targetKey) return;

    if (targetKey && allKeys.has(targetKey)) {
      if (merged.has(targetKey)) {
        merged.set(targetKey, mergeSupersededStaleIntoTarget(merged.get(targetKey), item, groupTombstones));
      } else {
        const pending = pendingStaleByTarget.get(targetKey) || [];
        pending.push(item);
        pendingStaleByTarget.set(targetKey, pending);
      }
      return;
    }

    const existing = merged.get(key);
    merged.set(key, existing ? mergeItems(existing, item, groupTombstones) : item);
    foldPending(key);
  };

  for (const item of local) addItem(item);
  for (const item of remote) addItem(item);

  // If every provider lost the target of an edit lineage, keep the newest stale
  // old-id copy rather than converting an edit into data loss. The old-id
  // tombstone is an edit marker while supersedes exists, not a hard delete.
  for (const pending of pendingStaleByTarget.values()) {
    for (const item of pending) {
      const key = itemKey(item);
      if (deleted.has(lineage.get(key))) continue;
      const existing = merged.get(key);
      merged.set(key, existing ? mergeItems(existing, item, groupTombstones) : item);
    }
  }

  const result = [...merged.values()].sort((a, b) => (b.ts || 0) - (a.ts || 0));
  dedupeNumpadSlots(result);
  return result;
}

function planHistoryPrune(history, settings = {}, options = {}) {
  const now = options.now != null ? Number(options.now) : Date.now() / 1000;
  const maxAgeDays = Number(settings.max_age_days);
  const maxAge = Number.isFinite(maxAgeDays) && maxAgeDays > 0 ? maxAgeDays * 86400 : Infinity;
  const planned = [];
  const survivors = Array.isArray(history) ? history.map((item, index) => ({ item, index })) : [];

  for (let i = survivors.length - 1; i >= 0; i--) {
    const { item, index } = survivors[i];
    if (!isPinned(item) && (now - (Number(item && item.ts) || 0)) > maxAge) {
      planned.push({ index, reason: 'age' });
      survivors.splice(i, 1);
    }
  }

  return planned.sort((a, b) => b.index - a.index);
}

function isDestructivePrune(history, plan, options = {}) {
  const total = Array.isArray(history) ? history.length : 0;
  const count = Array.isArray(plan) ? plan.length : 0;
  if (!total || !count) return false;
  const minItems = Number(options.minItems) || 50;
  const fraction = Number(options.fraction) || DEFAULT_DESTRUCTIVE_PRUNE_FRACTION;
  return count >= minItems && count / total >= fraction;
}

function mergeGroups(local, remote, groupTombstones = []) {
  const deleted = groupTombstoneNames(groupTombstones);
  return [...new Set([...(local || []), ...(remote || [])])].filter(g => !deleted.has(g));
}

module.exports = {
  DEFAULT_SETTINGS,
  TOMBSTONE_MAX_AGE_MS,
  textHashForText,
  itemTextHash,
  itemHasVerifiedFullText,
  migrateItemPin,
  isPinned,
  numpadSlotOf,
  groupsOf,
  titleOf,
  titleUpdatedAt,
  setTitleMetadata,
  mergeTitleMetadata,
  conflictSnapshot,
  titleConflict,
  hasNumpadSlot,
  ensurePin,
  setInlineText,
  legacyContentKey,
  ensureItemId,
  itemKey,
  normalizeTombstones,
  normalizeGroupTombstones,
  normalizeSupersedes,
  supersedeMap,
  tombstoneIds,
  groupTombstoneNames,
  planHistoryPrune,
  isDestructivePrune,
  mergePins,
  pinUpdatedAt,
  mergeItems,
  mergeHistories,
  mergeGroups,
  dedupeNumpadSlots,
  migrateLegacyNumpadSlots,
  applyTextEdit,
};
