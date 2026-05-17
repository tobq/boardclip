'use strict';

const crypto = require('crypto');

const DEFAULT_SETTINGS = {
  max_age_days: 7,
  max_size_gb: 10,
  regex_search: false,
  groups: [],
  sync_path: '',
  tombstones: [],
  group_tombstones: [],
};

const TOMBSTONE_MAX_AGE_MS = 30 * 86400 * 1000;

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

function legacyContentKey(item) {
  if (item.type === 'image') return `img:${item.image}`;
  return `txt:${crypto.createHash('sha256').update(item.text || '').digest('hex')}`;
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

function tombstoneIds(list) {
  return new Set(normalizeTombstones(list).map(t => t.id));
}

function groupTombstoneNames(list) {
  return new Set(normalizeGroupTombstones(list).map(t => t.name));
}

function mergePins(localPin, remotePin, localUpdatedAt = 0, remoteUpdatedAt = 0, groupTombstones = []) {
  if (!localPin && !remotePin) return null;
  const deletedGroups = groupTombstoneNames(groupTombstones);
  const cleanPin = (pin) => {
    if (!pin) return null;
    const cleaned = { ...pin };
    if (Array.isArray(cleaned.groups)) {
      cleaned.groups = cleaned.groups.filter(g => !deletedGroups.has(g));
      if (!cleaned.groups.length) delete cleaned.groups;
    }
    if (typeof cleaned.number !== 'number' && !cleaned.groups) return null;
    return cleaned;
  };
  if (!localPin && remotePin) return localUpdatedAt > (remotePin.updatedAt || remoteUpdatedAt) ? null : cleanPin(remotePin);
  if (localPin && !remotePin) return remoteUpdatedAt > (localPin.updatedAt || localUpdatedAt) ? null : cleanPin(localPin);

  const merged = {};
  const groups = [...new Set([
    ...(Array.isArray(localPin.groups) ? localPin.groups : []),
    ...(Array.isArray(remotePin.groups) ? remotePin.groups : []),
  ])].filter(g => !deletedGroups.has(g));
  if (groups.length) merged.groups = groups;

  const localNumber = typeof localPin.number === 'number' ? localPin.number : null;
  const remoteNumber = typeof remotePin.number === 'number' ? remotePin.number : null;
  if (localNumber != null && remoteNumber != null) {
    merged.number = (localPin.updatedAt || 0) >= (remotePin.updatedAt || 0) ? localNumber : remoteNumber;
  } else if (localNumber != null) {
    merged.number = localNumber;
  } else if (remoteNumber != null) {
    merged.number = remoteNumber;
  }

  if (localPin.updatedAt || remotePin.updatedAt) {
    merged.updatedAt = Math.max(localPin.updatedAt || 0, remotePin.updatedAt || 0);
  }
  return Object.keys(merged).length ? merged : {};
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
  const base = remoteUpdated > localUpdated ? { ...remoteItem } : { ...localItem };
  base.id = itemKey(base);
  base.ts = Math.max(localTs, remoteTs);
  base.updatedAt = Math.max(localItem.updatedAt || 0, remoteItem.updatedAt || 0) || undefined;
  base.pin = mergePins(
    localItem.pin,
    remoteItem.pin,
    localItem.updatedAt || localItem.ts || 0,
    remoteItem.updatedAt || remoteItem.ts || 0,
    groupTombstones
  );
  return base;
}

function dedupeNumpadSlots(items) {
  const bestBySlot = new Map();
  for (const item of items) {
    const slot = numpadSlotOf(item);
    if (slot == null) continue;
    const current = bestBySlot.get(slot);
    const itemScore = item.pin && item.pin.updatedAt || item.ts || 0;
    const currentScore = current && (current.pin && current.pin.updatedAt || current.ts || 0);
    if (!current || itemScore >= currentScore) bestBySlot.set(slot, item);
  }
  for (const item of items) {
    const slot = numpadSlotOf(item);
    if (slot != null && bestBySlot.get(slot) !== item) delete item.pin.number;
  }
}

function mergeHistories(local, remote, settings = {}) {
  local = Array.isArray(local) ? local : [];
  remote = Array.isArray(remote) ? remote : [];
  const deleted = tombstoneIds(settings.tombstones);
  const groupTombstones = settings.group_tombstones || [];
  const merged = new Map();

  for (const item of local) {
    migrateItemPin(item);
    ensureItemId(item);
    if (!deleted.has(itemKey(item))) merged.set(itemKey(item), item);
  }

  for (const item of remote) {
    migrateItemPin(item);
    ensureItemId(item);
    const key = itemKey(item);
    if (deleted.has(key)) continue;
    const existing = merged.get(key);
    merged.set(key, existing ? mergeItems(existing, item, groupTombstones) : item);
  }

  const result = [...merged.values()].sort((a, b) => (b.ts || 0) - (a.ts || 0));
  dedupeNumpadSlots(result);
  return result;
}

function mergeGroups(local, remote, groupTombstones = []) {
  const deleted = groupTombstoneNames(groupTombstones);
  return [...new Set([...(local || []), ...(remote || [])])].filter(g => !deleted.has(g));
}

module.exports = {
  DEFAULT_SETTINGS,
  TOMBSTONE_MAX_AGE_MS,
  migrateItemPin,
  isPinned,
  numpadSlotOf,
  groupsOf,
  hasNumpadSlot,
  ensurePin,
  legacyContentKey,
  ensureItemId,
  itemKey,
  normalizeTombstones,
  normalizeGroupTombstones,
  tombstoneIds,
  groupTombstoneNames,
  mergePins,
  mergeItems,
  mergeHistories,
  mergeGroups,
  dedupeNumpadSlots,
};
