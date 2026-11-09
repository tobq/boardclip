'use strict';

// The cloud SNAPSHOT of the clip history: what a device reads in full when it
// has no journal cursor for a folder or fell behind the journals
// (lib/sync-journal holds the per-change files).
//
//   <provider>/clipboard-history/<xx>.json   a segment: the stored clips whose id
//                                            hashes to bucket xx (first byte of sha256)
//   <provider>/clipboard-history/index.json  rewritten after any segment changes;
//                                            the readers' change signal
//
// Until 9 Nov 2026 the snapshot was ONE file, clipboard-history.json, rewritten
// whole (21 MB on the owner's PC) every 5 min while clips kept coming, to every
// provider. Drive uploads a changed file whole, so that alone was ~1 GB an hour
// per Drive account. A clip lives in one segment, so a snapshot now uploads only
// the segments whose clips changed (~80 KB each) plus the small index.
//
// Writes are IN PLACE (blobStore.writeInPlace): DriveFS forks a file when a
// rename lands on its name, so each segment is created once and then
// overwritten. Two devices creating the same segment before Drive syncs still
// fork it; healSegmentForks folds every fork back, as the monolith's were.
//
// The legacy monolith (and its Drive forks and leaked tmps, lib/fork-names) is
// converted by migrateLegacy: split into segments (or unioned into the ones
// there), read back and verified, handed to a backup callback, then deleted.
// A device still on an old build that writes it again is converted the same
// way on the next read.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const blobStore = require('./blob-store');
const clipboardModel = require('./clipboard-model');
const forkNames = require('./fork-names');

const SNAPSHOT_DIR = 'clipboard-history';
const INDEX_FILE = 'index.json';
const LEGACY_FILE = 'clipboard-history.json';
const SEGMENT_RE = /^([0-9a-f]{2})\.json$/;

const sha256 = (text) => crypto.createHash('sha256').update(text).digest('hex');

function snapshotDir(syncPath) {
  return path.join(syncPath, SNAPSHOT_DIR);
}

function indexPath(syncPath) {
  return path.join(snapshotDir(syncPath), INDEX_FILE);
}

function bucketOf(item) {
  return sha256(String(clipboardModel.itemKey(item) || '')).slice(0, 2);
}

// bucket -> clips, each list in the order given (the history's own order).
function partition(items) {
  const out = new Map();
  for (const item of Array.isArray(items) ? items : []) {
    if (!item) continue;
    const bucket = bucketOf(item);
    if (!out.has(bucket)) out.set(bucket, []);
    out.get(bucket).push(item);
  }
  return out;
}

// Count + digest of the sorted per-clip content hashes: two lists hold exactly
// the same clips iff both are equal.
function fingerprint(items) {
  const hashes = (Array.isArray(items) ? items : []).map(item => sha256(JSON.stringify(item))).sort();
  return { count: hashes.length, digest: sha256(hashes.join('\n')) };
}

async function readText(file) {
  try { return await fs.promises.readFile(file, 'utf-8'); } catch { return null; }
}

async function listDir(dir) {
  try { return await fs.promises.readdir(dir); } catch { return null; }
}

// A clip list, [] for an empty file (a 0-byte leaked tmp holds nothing), null
// when unreadable (torn mid-write by its writer).
function parseItems(raw) {
  if (raw == null) return null;
  if (!raw.trim()) return [];
  try {
    const value = blobStore.parseJsonText(raw);
    return Array.isArray(value) ? value : null;
  } catch {
    return null;
  }
}

// Fold Drive forks of a segment ("3f (1).json", "3f 2.json", "3f.json 2.json")
// back into it (a structural union, like the monolith's fork heal: tombstones
// are applied later by the normal sync merge, never here) and delete them. A
// fork that does not parse is kept for the next pass; a segment that does not
// parse is being written by its owner and is left alone this pass.
async function healSegmentForks(syncPath) {
  const dir = snapshotDir(syncPath);
  const names = await listDir(dir);
  if (!names) return 0;
  const forksByBucket = new Map();
  let removed = 0;
  for (const name of names) {
    if (forkNames.isIndexFork(name)) {
      try { await fs.promises.unlink(path.join(dir, name)); removed++; } catch {}
      continue;
    }
    const bucket = forkNames.segmentForkBucket(name);
    if (!bucket) continue;
    if (!forksByBucket.has(bucket)) forksByBucket.set(bucket, []);
    forksByBucket.get(bucket).push(name);
  }
  for (const [bucket, forks] of forksByBucket) {
    const file = path.join(dir, `${bucket}.json`);
    const raw = await readText(file);
    let merged = raw == null ? [] : parseItems(raw);
    if (!merged) continue;
    const folded = [];
    for (const name of forks) {
      const items = parseItems(await readText(path.join(dir, name)));
      if (!items) continue;
      if (items.length) merged = clipboardModel.mergeHistories(merged, items, {});
      folded.push(name);
    }
    if (!folded.length) continue;
    await blobStore.writeInPlace(file, JSON.stringify(merged));
    for (const name of folded) {
      try { await fs.promises.unlink(path.join(dir, name)); removed++; } catch {}
    }
  }
  return removed;
}

// Every segment's clips. `segments` keeps each file's raw text, so the writer
// compares against what is actually there (as the monolith's write did).
// Segments are read one at a time: a wedged mount must not take every libuv
// thread (lib/fs-probe).
async function readSegments(syncPath) {
  const dir = snapshotDir(syncPath);
  const names = await listDir(dir);
  const out = { exists: !!names, hasIndex: false, items: [], segments: new Map(), torn: [] };
  if (!names) return out;
  out.hasIndex = names.includes(INDEX_FILE);
  for (const name of names.sort()) {
    const match = SEGMENT_RE.exec(name);
    if (!match) continue;
    const raw = await readText(path.join(dir, name));
    if (raw == null) continue;
    const items = parseItems(raw);
    out.segments.set(match[1], { raw, items });
    if (items) out.items.push(...items);
    else out.torn.push(name);
  }
  return out;
}

// Write the clips as segments, touching only those whose text changes, then
// the index (only when a segment changed, or it is missing). `current` is
// readSegments' result for this folder.
async function writeSegments(syncPath, storedItems, current, meta = {}) {
  const dir = snapshotDir(syncPath);
  await fs.promises.mkdir(dir, { recursive: true });
  const next = partition(storedItems);
  const buckets = [...new Set([...next.keys(), ...current.segments.keys()])].sort();
  const written = [];
  let bytes = 0;
  for (const bucket of buckets) {
    const items = next.get(bucket) || [];
    const existing = current.segments.get(bucket);
    if (!items.length && !existing) continue;          // never create an empty segment
    const json = JSON.stringify(items);
    if (existing && existing.raw === json) continue;
    await blobStore.writeInPlace(path.join(dir, `${bucket}.json`), json);
    written.push(bucket);
    bytes += Buffer.byteLength(json);
  }
  let indexBytes = 0;
  if (written.length || !current.hasIndex) {
    const index = JSON.stringify({
      v: 1,
      items: Array.isArray(storedItems) ? storedItems.length : 0,
      segments: next.size,
      ...meta,
      written_at: new Date().toISOString(),
    });
    await blobStore.writeInPlace(indexPath(syncPath), index);
    indexBytes = Buffer.byteLength(index);
  }
  return { written, bytes, indexBytes, segments: next.size };
}

function isLegacyName(name) {
  return name === LEGACY_FILE || forkNames.isHistoryFork(name);
}

// Convert the legacy monolith (+ its forks and leaked tmps) into segments.
// Returns null when there is none, else a report ({ ok } plus counts, no clip
// content). A legacy file is deleted only after the segments read back hold
// every clip in it (one file into an empty folder: the same count and content
// hashes; otherwise every clip id), `backup(file)` has kept it, and it still
// holds what was converted.
async function migrateLegacy(syncPath, { backup = null, meta = {} } = {}) {
  const names = ((await listDir(syncPath)) || []).filter(isLegacyName).sort();
  if (!names.length) return null;
  const files = [];
  for (const name of names) {
    const raw = await readText(path.join(syncPath, name));
    if (raw == null) continue;
    files.push({ name, raw, items: parseItems(raw), bytes: Buffer.byteLength(raw), sha256: sha256(raw) });
  }
  if (!files.length) return null;
  const report = {
    ok: false,
    legacy: files.map(f => ({ name: f.name, bytes: f.bytes, sha256: f.sha256, items: f.items ? f.items.length : null })),
  };
  if (files.some(f => !f.items)) { report.pending = 'legacy file unreadable'; return report; }

  await healSegmentForks(syncPath);
  const current = await readSegments(syncPath);
  if (current.torn.length) { report.pending = 'segment unreadable'; return report; }
  // One legacy file into an empty folder is split exactly as it is; anything
  // else is a structural union (never drops a clip).
  const exact = files.length === 1 && current.items.length === 0;
  let target = exact ? files[0].items : current.items;
  if (!exact) {
    for (const file of files) if (file.items.length) target = clipboardModel.mergeHistories(target, file.items, {});
  }
  const write = await writeSegments(syncPath, target, current, meta);
  report.exact = exact;
  report.segments_written = write.written.length;
  report.bytes_written = write.bytes + write.indexBytes;

  const after = await readSegments(syncPath);
  const afterIds = new Set(after.items.map(item => clipboardModel.itemKey(item)));
  const before = [...current.items, ...files.flatMap(f => f.items)];
  report.missing = before.filter(item => !afterIds.has(clipboardModel.itemKey(item))).length;
  report.items = after.items.length;
  if (exact) {
    report.legacy_fingerprint = fingerprint(files[0].items);
    report.segment_fingerprint = fingerprint(after.items);
  }
  const verified = !after.torn.length && report.missing === 0 && (!exact
    || (report.legacy_fingerprint.count === report.segment_fingerprint.count
      && report.legacy_fingerprint.digest === report.segment_fingerprint.digest));
  if (!verified) { report.pending = 'read-back mismatch'; return report; }

  for (const file of files) {
    if (backup) file.backup = await backup(file);
  }
  report.backups = files.map(f => f.backup || null);
  const kept = [];
  for (const file of files) {
    // An old build may have rewritten it since: that content is converted next pass.
    const now = await readText(path.join(syncPath, file.name));
    if (now == null || sha256(now) !== file.sha256) { kept.push(file.name); continue; }
    try { await fs.promises.unlink(path.join(syncPath, file.name)); } catch { kept.push(file.name); }
  }
  if (kept.length) { report.kept = kept; report.pending = 'legacy file changed or locked'; return report; }
  report.ok = true;
  return report;
}

module.exports = {
  SNAPSHOT_DIR,
  INDEX_FILE,
  LEGACY_FILE,
  snapshotDir,
  indexPath,
  bucketOf,
  partition,
  fingerprint,
  healSegmentForks,
  readSegments,
  writeSegments,
  migrateLegacy,
};
