'use strict';

// Content-addressed local backup store (the "logic-bug time-machine").
//
// A backup is a point-in-time snapshot of the clipboard history + settings. The
// naive design copied the WHOLE history JSON (~4-5MB) on every change, so an edit
// to one note re-stored thousands of unchanged items. This store instead keeps a
// content-addressed OBJECT POOL: each stored item (and the settings object) is
// written once under its sha256, and a snapshot is just a small MANIFEST listing
// the ordered item hashes. Unchanged items across snapshots share one blob, so a
// snapshot after editing one note costs ~one item + a manifest, not a full copy.
//
// Everything stays PLAIN-TEXT JSON on disk (objects and manifests) so a backup is
// still greppable/inspectable during an incident. Reuses lib/blob-store for the
// atomic write + dir helpers and lib/retention (planRetention) for eviction.
//
// Layout under `baseDir` (e.g. clipboard-backups/):
//   objects/{sha256}.json            one stored item, or the settings object
//   snapshots/{stamp}-{reason}.json  manifest { items:[hash], settings:hash, ... }
//   {stamp}-{reason}-{hash12}.json   LEGACY full snapshots (read-only, age out)
//
// This module is deliberately filesystem-real but dependency-light: pass a baseDir
// and (optionally) `now`, so it's testable against a temp dir.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const blobStore = require('./blob-store');
const { planRetention } = require('./retention');

const OBJECTS_DIRNAME = 'objects';
const SNAPSHOTS_DIRNAME = 'snapshots';
const OBJECT_RE = /^[a-f0-9]{64}\.json$/i;
const MANIFEST_RE = /\.json$/i;
// Legacy full-snapshot filenames: {ISO-stamp}-{reason}-{hash12}.json in baseDir.
const LEGACY_RE = /^\d{4}-\d{2}-\d{2}T[\dhZ.-]*-[a-z]+-[a-f0-9]{6,}\.json$/i;

function sha256Hex(str) {
  return crypto.createHash('sha256').update(str).digest('hex');
}

// Deterministic JSON (recursively sorted object keys) so two equal items always
// serialize to the same bytes and therefore hash to the same object.
function stableStringify(value) {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  if (value && typeof value === 'object') {
    const keys = Object.keys(value).sort();
    return `{${keys.map(k => `${JSON.stringify(k)}:${stableStringify(value[k])}`).join(',')}}`;
  }
  return JSON.stringify(value === undefined ? null : value);
}

function objectsDir(baseDir) { return path.join(baseDir, OBJECTS_DIRNAME); }
function snapshotsDir(baseDir) { return path.join(baseDir, SNAPSHOTS_DIRNAME); }

function objectPath(baseDir, hash) {
  return path.join(objectsDir(baseDir), `${hash}.json`);
}

// Write `value` into the pool iff its content isn't already there; return its hash.
function putObject(baseDir, value) {
  const json = stableStringify(value);
  const hash = sha256Hex(json);
  const filePath = objectPath(baseDir, hash);
  if (!fs.existsSync(filePath)) {
    blobStore.ensureDir(objectsDir(baseDir));
    blobStore.atomicWriteFile(filePath, json);
  }
  return hash;
}

function getObject(baseDir, hash) {
  try { return JSON.parse(fs.readFileSync(objectPath(baseDir, hash), 'utf8')); }
  catch { return null; }
}

function toIso(createdAt) {
  if (createdAt instanceof Date) return createdAt.toISOString();
  const d = new Date(createdAt || Date.now());
  return Number.isNaN(d.getTime()) ? new Date().toISOString() : d.toISOString();
}

// Write a content-addressed snapshot. Returns { manifestPath, manifest }.
function writeSnapshot(baseDir, { history, settings = null, reason = 'periodic', createdAt = new Date(), source = {} } = {}) {
  const items = (Array.isArray(history) ? history : []).map(item => putObject(baseDir, item));
  const settingsHash = settings != null ? putObject(baseDir, settings) : null;
  const iso = toIso(createdAt);
  const manifest = {
    version: 1,
    createdAt: iso,
    reason,
    source,
    count: items.length,
    settings: settingsHash,
    items,
  };
  const dir = snapshotsDir(baseDir);
  blobStore.ensureDir(dir);
  const stamp = iso.replace(/[:.]/g, '-');
  const manifestPath = path.join(dir, `${stamp}-${reason}.json`);
  blobStore.atomicWriteFile(manifestPath, JSON.stringify(manifest));
  return { manifestPath, manifest };
}

function readManifestFile(filePath) {
  try { return JSON.parse(fs.readFileSync(filePath, 'utf8')); } catch { return null; }
}

// Reconstruct a snapshot's full { createdAt, reason, history, settings } from either
// a new manifest (items are hashes → resolve from the pool) or a legacy full file
// (history/settings inline). Accepts a manifest path or a parsed manifest object.
function readSnapshot(baseDir, manifestOrPath) {
  const manifest = typeof manifestOrPath === 'string' ? readManifestFile(manifestOrPath) : manifestOrPath;
  if (!manifest || typeof manifest !== 'object') return null;

  // Legacy full snapshot: history already inline.
  if (Array.isArray(manifest.history)) {
    return {
      createdAt: manifest.createdAt || null,
      reason: manifest.reason || 'legacy',
      history: manifest.history,
      settings: manifest.settings && typeof manifest.settings === 'object' ? manifest.settings : null,
    };
  }

  // New manifest: resolve item hashes + settings hash from the pool.
  const items = Array.isArray(manifest.items) ? manifest.items : [];
  const history = items.map(hash => getObject(baseDir, hash)).filter(v => v != null);
  const settings = manifest.settings ? getObject(baseDir, manifest.settings) : null;
  return {
    createdAt: manifest.createdAt || null,
    reason: manifest.reason || 'periodic',
    history,
    settings,
  };
}

// Enumerate snapshot descriptors (new manifests + legacy full files), newest first.
function listSnapshots(baseDir) {
  const out = [];
  // New manifests.
  try {
    for (const name of fs.readdirSync(snapshotsDir(baseDir))) {
      if (!MANIFEST_RE.test(name)) continue;
      const filePath = path.join(snapshotsDir(baseDir), name);
      try {
        const st = fs.statSync(filePath);
        out.push({ path: filePath, name, mtimeMs: st.mtimeMs, size: st.size, legacy: false });
      } catch {}
    }
  } catch {}
  // Legacy full snapshots in baseDir.
  try {
    for (const name of fs.readdirSync(baseDir)) {
      if (!LEGACY_RE.test(name)) continue;
      const filePath = path.join(baseDir, name);
      try {
        const st = fs.statSync(filePath);
        if (st.isFile()) out.push({ path: filePath, name, mtimeMs: st.mtimeMs, size: st.size, legacy: true });
      } catch {}
    }
  } catch {}
  out.sort((a, b) => b.mtimeMs - a.mtimeMs);
  return out;
}

// Set of object hashes referenced by the given manifest descriptors.
function referencedHashes(baseDir, descriptors) {
  const refs = new Set();
  for (const d of descriptors) {
    if (d.legacy) continue; // legacy files carry their own content, reference no pool objects
    const manifest = readManifestFile(d.path);
    if (!manifest) continue;
    for (const h of Array.isArray(manifest.items) ? manifest.items : []) refs.add(h);
    if (manifest.settings) refs.add(manifest.settings);
  }
  return refs;
}

// Delete pool objects not referenced by any surviving manifest. Returns freed count.
function gcObjects(baseDir, survivors) {
  const refs = referencedHashes(baseDir, survivors);
  let freed = 0;
  let names = [];
  try { names = fs.readdirSync(objectsDir(baseDir)); } catch { return 0; }
  for (const name of names) {
    if (!OBJECT_RE.test(name)) continue;
    const hash = name.slice(0, -'.json'.length).toLowerCase();
    if (refs.has(hash)) continue;
    try { fs.rmSync(path.join(objectsDir(baseDir), name), { force: true }); freed++; } catch {}
  }
  return freed;
}

function totalBytes(baseDir) {
  return blobStore.directoryBytes(objectsDir(baseDir))
    + blobStore.directoryBytes(snapshotsDir(baseDir))
    + blobStore.directoryBytes(baseDir); // legacy files live directly in baseDir
}

// Prune snapshots by age + count, GC unreferenced objects, then enforce a size
// ceiling by dropping the oldest surviving snapshots (re-GC) until under maxBytes.
function pruneBackups(baseDir, { maxAgeMs, maxBytes, maxManifests, now = Date.now() } = {}) {
  let survivors = listSnapshots(baseDir);

  // 1. age + count eviction (planRetention is oldest-first LRU by mtime).
  const evicted = planRetention(
    survivors.map(s => ({ ...s, filePath: s.path })),
    { maxAgeMs, maxFiles: maxManifests, now },
  );
  const evictedPaths = new Set(evicted.map(e => e.filePath));
  for (const e of evicted) { try { fs.rmSync(e.filePath, { force: true }); } catch {} }
  survivors = survivors.filter(s => !evictedPaths.has(s.path));

  // 2. GC objects no longer referenced by a surviving manifest.
  gcObjects(baseDir, survivors);

  // 3. size ceiling: drop oldest survivors until total is under maxBytes.
  if (maxBytes != null) {
    survivors.sort((a, b) => a.mtimeMs - b.mtimeMs); // oldest first
    while (survivors.length > 1 && totalBytes(baseDir) > maxBytes) {
      const oldest = survivors.shift();
      try { fs.rmSync(oldest.path, { force: true }); } catch {}
      gcObjects(baseDir, survivors);
    }
  }
}

module.exports = {
  stableStringify,
  sha256Hex,
  putObject,
  getObject,
  writeSnapshot,
  readSnapshot,
  listSnapshots,
  pruneBackups,
  OBJECTS_DIRNAME,
  SNAPSHOTS_DIRNAME,
};
