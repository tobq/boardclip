'use strict';

// Delta sync: ONE changes feed shared by P2P (v2 /delta endpoints) and the
// cloud journals (sync/<device>/<revision>.json files in each provider folder).
//
// Model (CouchDB `_changes?since=seq` on top of the existing union merge):
//  - `createChangeTracker` keeps, per entry (item / tombstone / group tombstone
//    / supersede / conflict record / the small synced settings), the LOCAL
//    revision at which that entry last changed on THIS device, whatever its
//    source (own capture, P2P, cloud). Revisions are a per-device monotonic
//    counter, so cursors are "the sender's revision" and never compare clocks
//    across devices.
//  - `deltaSince(since)` selects every entry whose arrival revision is newer
//    than the cursor. Applying a delta is the existing `foldRemoteState` union
//    merge, which only ever ADDS or UPDATES (deletion needs a tombstone), so a
//    partial history is safe by construction and re-sending is idempotent.
//  - Restart safety: the tracker is persisted lazily (sync-state.json). On load
//    the start revision jumps to max(persisted + 1, Date.now()), and any entry
//    whose arrival was lost (crash inside the lazy-write window) is stamped with
//    the new start revision, so it is re-sent to every peer once. Over-sending
//    is harmless; under-sending would be a silent hole, so the bias is deliberate.

const crypto = require('crypto');
const clipboardModel = require('./clipboard-model');

const PROTOCOL = 2;
const K_ITEM = 'i:';
const K_TOMB = 't:';
const K_GTOMB = 'g:';
const K_SUP = 's:';
const K_CONF = 'c:';
const K_SETTINGS = 'S';

function hashJson(value) {
  return crypto.createHash('sha1').update(JSON.stringify(value === undefined ? null : value)).digest('hex').slice(0, 20);
}

// The mutation clock is THE "newer" signal the merge itself uses (capture/edit,
// pin/groups/numpad, title, ts correction), so it is the right change signal
// here too; the blob refs cover a formatting payload arriving for an existing
// clip without any clock change.
function itemFingerprint(item) {
  return [
    clipboardModel.itemMutationClock(item),
    item.textRef || '', item.htmlRef || '', item.rtfRef || '', item.image || '',
    item.textHash || '', item.htmlHash || '', item.rtfHash || '',
  ].join('|');
}

// Synced settings minus the three big time-stamped lists (which are tracked
// entry by entry) and minus anything that is not user data.
function settingsSmall(syncedSettings) {
  const small = { ...(syncedSettings || {}) };
  delete small.tombstones;
  delete small.group_tombstones;
  delete small.supersedes;
  return small;
}

function conflictFingerprint(record) {
  return `${record.updatedAt || 0}|${record.resolved ? 1 : 0}|${hashJson(record.result || null)}`;
}

function startRevisionAfterLoad(persistedRevision, now = Date.now()) {
  return Math.max((Number(persistedRevision) || 0) + 1, now);
}

function createChangeTracker({ revision = 0, entries = {}, now = Date.now } = {}) {
  const map = new Map();
  for (const [key, entry] of Object.entries(entries || {})) {
    if (entry && Number.isFinite(entry.a)) map.set(key, { a: entry.a, f: String(entry.f || '') });
  }
  let rev = Number(revision) || 0;
  let dirty = false;

  function bump() {
    rev += 1;
    dirty = true;
    return rev;
  }

  // Stamp every entry the view holds that is new or changed with the current
  // revision; forget entries the view no longer holds. Returns the changed keys.
  function observe(view) {
    const seen = new Set();
    const changed = [];
    const touch = (key, fingerprint) => {
      seen.add(key);
      const current = map.get(key);
      if (current && current.f === fingerprint) return;
      map.set(key, { a: rev, f: fingerprint });
      changed.push(key);
    };
    for (const item of view.items || []) {
      if (!item) continue;
      touch(K_ITEM + clipboardModel.itemKey(item), itemFingerprint(item));
    }
    for (const t of view.tombstones || []) if (t && t.id) touch(K_TOMB + t.id, String(t.deletedAt || 0));
    for (const g of view.groupTombstones || []) if (g && g.name) touch(K_GTOMB + g.name, String(g.deletedAt || 0));
    for (const s of view.supersedes || []) if (s && s.from && s.to) touch(K_SUP + s.from + '>' + s.to, String(s.updatedAt || 0));
    const records = view.conflicts && Array.isArray(view.conflicts.records) ? view.conflicts.records : [];
    for (const c of records) if (c && c.id) touch(K_CONF + c.id, conflictFingerprint(c));
    touch(K_SETTINGS, hashJson(settingsSmall(view.settings)));
    for (const key of [...map.keys()]) if (!seen.has(key)) { map.delete(key); dirty = true; }
    if (changed.length) dirty = true;
    return changed;
  }

  // Everything that arrived after `since`, as a self-describing envelope.
  function deltaSince(since, view, meta = {}) {
    const cursor = Number(since) || 0;
    const newer = key => {
      const entry = map.get(key);
      return !entry || entry.a > cursor;
    };
    const items = [];
    for (const item of view.items || []) {
      if (item && newer(K_ITEM + clipboardModel.itemKey(item))) items.push(item);
    }
    const tombstones = (view.tombstones || []).filter(t => t && t.id && newer(K_TOMB + t.id));
    const groupTombstones = (view.groupTombstones || []).filter(g => g && g.name && newer(K_GTOMB + g.name));
    const supersedes = (view.supersedes || []).filter(s => s && s.from && s.to && newer(K_SUP + s.from + '>' + s.to));
    const records = view.conflicts && Array.isArray(view.conflicts.records) ? view.conflicts.records : [];
    const conflicts = records.filter(c => c && c.id && newer(K_CONF + c.id));
    const includeSettings = newer(K_SETTINGS);
    const envelope = {
      v: PROTOCOL,
      deviceId: meta.deviceId || '',
      deviceName: meta.deviceName || '',
      build: meta.build || '',
      port: meta.port || 0,
      since: cursor,
      revision: rev,
      originClock: now(),
      full: cursor <= 0 || items.length === (view.items || []).length,
      history: items,
      tombstones,
      group_tombstones: groupTombstones,
      supersedes,
    };
    if (conflicts.length) envelope.conflicts = { records: conflicts };
    if (includeSettings) envelope.settings = settingsSmall(view.settings);
    if (typeof meta.assetsOf === 'function') envelope.assets = meta.assetsOf(items);
    return envelope;
  }

  function isEmpty(envelope) {
    return !envelope.history.length && !envelope.tombstones.length && !envelope.group_tombstones.length
      && !envelope.supersedes.length && !envelope.conflicts && !envelope.settings;
  }

  function serialize() {
    return { revision: rev, entries: Object.fromEntries(map) };
  }

  return {
    get revision() { return rev; },
    get size() { return map.size; },
    get dirty() { return dirty; },
    markClean() { dirty = false; },
    bump,
    observe,
    deltaSince,
    isEmpty,
    serialize,
  };
}

function isEnvelope(value) {
  return !!(value && typeof value === 'object' && value.v === PROTOCOL && value.deviceId && Array.isArray(value.history));
}

// The (remoteHistory, remoteSettings, remoteConflicts) triple foldRemoteState
// already consumes, built from an envelope. Items are still in STORED form
// (blob refs); the caller hydrates after fetching missing assets.
function envelopeToRemoteState(envelope) {
  return {
    remoteHistory: Array.isArray(envelope.history) ? envelope.history : [],
    remoteSettings: {
      ...(envelope.settings || {}),
      tombstones: Array.isArray(envelope.tombstones) ? envelope.tombstones : [],
      group_tombstones: Array.isArray(envelope.group_tombstones) ? envelope.group_tombstones : [],
      supersedes: Array.isArray(envelope.supersedes) ? envelope.supersedes : [],
    },
    remoteConflicts: envelope.conflicts && typeof envelope.conflicts === 'object' ? envelope.conflicts : {},
  };
}

// Ids an envelope can have touched in the merged history: its items, its
// tombstones, and both ends of its edit lineages. Used for O(delta) change
// detection instead of stringifying the whole 8 MB history twice per apply.
function touchedIds(envelope) {
  const ids = new Set();
  for (const item of envelope.history || []) if (item) ids.add(clipboardModel.itemKey(item));
  for (const t of envelope.tombstones || []) if (t && t.id) ids.add(t.id);
  for (const s of envelope.supersedes || []) { if (s && s.from) ids.add(s.from); if (s && s.to) ids.add(s.to); }
  return ids;
}

function historyChangedBy(before, after, ids) {
  if (before.length !== after.length) return true;
  const beforeById = new Map();
  for (const item of before) if (item) beforeById.set(clipboardModel.itemKey(item), item);
  const afterById = new Map();
  for (const item of after) if (item) afterById.set(clipboardModel.itemKey(item), item);
  if (beforeById.size !== afterById.size) return true;
  for (const id of ids) {
    const a = beforeById.get(id);
    const b = afterById.get(id);
    if (!a && !b) continue;
    if (!a || !b) return true;
    if (a !== b && JSON.stringify(a) !== JSON.stringify(b)) return true;
  }
  return false;
}

module.exports = {
  PROTOCOL,
  createChangeTracker,
  startRevisionAfterLoad,
  settingsSmall,
  itemFingerprint,
  isEnvelope,
  envelopeToRemoteState,
  touchedIds,
  historyChangedBy,
};
