'use strict';

// Cloud-folder change journals. Instead of rewriting the whole
// clipboard-history.json on every copy (8 MB per copy per provider), each
// device appends ONE small NEW file per change under
//   <provider>/sync/<deviceId>/<revision16>.json
// holding the delta envelope (lib/sync-delta.js) since its previous journal
// write to that folder. Readers list the other devices' directories and apply
// every file newer than their per-device cursor. The monolith stays as a
// periodic SNAPSHOT (cold start, pre-v2 readers) and the writer prunes its own
// journal files once a snapshot covers them.
//
// Files are only ever CREATED (tmp + rename to a fresh name), never rewritten:
// Google Drive File Stream forks an object when a rename lands on an existing
// name (lib/fork-names.js), so nothing here renames over an existing file.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const blobStore = require('./blob-store');

const JOURNAL_DIR = 'sync';
const FOLDER_ID_FILE = '.boardclip-folder-id';
const NAME_RE = /^(\d{16})\.json$/;
const DEVICE_RE = /^[a-z0-9_-]{1,64}$/i;

function safeDeviceId(deviceId) {
  const value = String(deviceId || '').replace(/[^a-z0-9_-]/ig, '').slice(0, 64);
  return DEVICE_RE.test(value) ? value : '';
}

function journalName(revision) {
  return String(Math.max(0, Math.floor(Number(revision) || 0))).padStart(16, '0') + '.json';
}

function parseJournalName(name) {
  const match = NAME_RE.exec(String(name || ''));
  return match ? Number(match[1]) : null;
}

function journalRoot(syncPath) {
  return path.join(syncPath, JOURNAL_DIR);
}

function deviceDir(syncPath, deviceId) {
  return path.join(journalRoot(syncPath), safeDeviceId(deviceId));
}

// [{ deviceId, revision, path }] for every journal file in the folder, sorted by
// device then revision. `excludeDeviceId` skips the caller's own files.
async function listJournal(syncPath, { excludeDeviceId = '' } = {}) {
  let devices = [];
  try { devices = await fs.promises.readdir(journalRoot(syncPath), { withFileTypes: true }); } catch { return []; }
  const out = [];
  const skip = safeDeviceId(excludeDeviceId);
  for (const entry of devices) {
    if (!entry.isDirectory()) continue;
    const deviceId = safeDeviceId(entry.name);
    if (!deviceId || deviceId === skip) continue;
    let names = [];
    try { names = await fs.promises.readdir(path.join(journalRoot(syncPath), entry.name)); } catch { continue; }
    for (const name of names) {
      const revision = parseJournalName(name);
      if (revision == null) continue;
      out.push({ deviceId, revision, path: path.join(journalRoot(syncPath), entry.name, name) });
    }
  }
  out.sort((a, b) => a.deviceId.localeCompare(b.deviceId) || a.revision - b.revision);
  return out;
}

async function writeJournalEntry(syncPath, deviceId, envelope) {
  const dir = deviceDir(syncPath, deviceId);
  if (!safeDeviceId(deviceId)) throw new Error('journal: invalid device id');
  await fs.promises.mkdir(dir, { recursive: true });
  const finalPath = path.join(dir, journalName(envelope.revision));
  const tmpPath = `${finalPath}.${process.pid}.${Date.now()}.tmp`;
  const json = JSON.stringify(envelope);
  await fs.promises.writeFile(tmpPath, json);
  await fs.promises.rename(tmpPath, finalPath);
  return { path: finalPath, bytes: Buffer.byteLength(json) };
}

async function readJournalEntry(filePath) {
  try {
    const parsed = blobStore.parseJsonText(await fs.promises.readFile(filePath, 'utf-8'));
    return parsed && typeof parsed === 'object' ? parsed : null;
  } catch {
    return null;
  }
}

// Delete this device's own journal files that a snapshot already covers
// (revision <= upToRevision) and that are old enough for every reader to have
// consumed them. Returns how many were removed.
async function pruneJournal(syncPath, deviceId, { upToRevision = 0, olderThanMs = 60 * 60 * 1000, now = Date.now() } = {}) {
  const dir = deviceDir(syncPath, deviceId);
  let names = [];
  try { names = await fs.promises.readdir(dir); } catch { return 0; }
  let removed = 0;
  for (const name of names) {
    const revision = parseJournalName(name);
    const isTmp = /\.tmp$/.test(name);
    if (revision == null && !isTmp) continue;
    const file = path.join(dir, name);
    try {
      const stats = await fs.promises.stat(file);
      if (now - stats.mtimeMs < olderThanMs) continue;
      if (!isTmp && revision > upToRevision) continue;
      await fs.promises.unlink(file);
      removed++;
    } catch {}
  }
  return removed;
}

async function countJournal(syncPath, deviceId) {
  try {
    const names = await fs.promises.readdir(deviceDir(syncPath, deviceId));
    return names.filter(name => parseJournalName(name) != null).length;
  } catch {
    return 0;
  }
}

// A stable id stored INSIDE the folder, so two mount paths of the same cloud
// folder (Google Drive on G: and H:) are recognised as one provider.
async function folderIdentity(syncPath) {
  const marker = path.join(syncPath, FOLDER_ID_FILE);
  try {
    const raw = (await fs.promises.readFile(marker, 'utf-8')).trim();
    if (/^[a-f0-9]{32}$/i.test(raw)) return raw.toLowerCase();
  } catch {}
  const id = crypto.randomBytes(16).toString('hex');
  try {
    await fs.promises.mkdir(syncPath, { recursive: true });
    await fs.promises.writeFile(marker, id, { flag: 'wx' });
    return id;
  } catch {
    // Lost a race with another writer (or a read-only folder): re-read, else
    // fall back to the path itself so the folder is still treated as unique.
    try {
      const raw = (await fs.promises.readFile(marker, 'utf-8')).trim();
      if (/^[a-f0-9]{32}$/i.test(raw)) return raw.toLowerCase();
    } catch {}
    return `path:${syncPath}`;
  }
}

// entries: [{ path, id }] -> { primary: [path], duplicateOf: { path: primaryPath } }
function dedupeByIdentity(entries) {
  const byId = new Map();
  const primary = [];
  const duplicateOf = {};
  for (const entry of entries) {
    if (!entry || !entry.path) continue;
    const id = entry.id || `path:${entry.path}`;
    const first = byId.get(id);
    if (first) { duplicateOf[entry.path] = first; continue; }
    byId.set(id, entry.path);
    primary.push(entry.path);
  }
  return { primary, duplicateOf };
}

module.exports = {
  JOURNAL_DIR,
  FOLDER_ID_FILE,
  safeDeviceId,
  journalName,
  parseJournalName,
  journalRoot,
  deviceDir,
  listJournal,
  writeJournalEntry,
  readJournalEntry,
  pruneJournal,
  countJournal,
  folderIdentity,
  dedupeByIdentity,
};
