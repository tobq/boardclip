'use strict';

// Tests for the content-addressed backup store (lib/backup.js): dedup, exact
// reconstruction, per-edit cost, and retention (age + count + size) with object GC.
// Runs against a real temp dir (no Electron).

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const backup = require('../lib/backup');

let passed = 0;
function ok(name) { passed++; console.log(`  ok - ${name}`); }

function tmpBase() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'bc-backup-'));
}
function objectCount(base) {
  try { return fs.readdirSync(path.join(base, 'objects')).filter(n => n.endsWith('.json')).length; }
  catch { return 0; }
}
function manifestCount(base) {
  try { return fs.readdirSync(path.join(base, 'snapshots')).filter(n => n.endsWith('.json')).length; }
  catch { return 0; }
}
function item(id, text) { return { id: `txt:${id}`, type: 'text', text, pin: null }; }

// ---------------------------------------------------------------------------
// 1. Round-trip: a snapshot reconstructs the exact history + settings, order kept.
// ---------------------------------------------------------------------------
function roundTrip() {
  const base = tmpBase();
  const history = [item('a', 'alpha'), item('b', 'beta'), item('c', 'gamma')];
  const settings = { theme_mode: 'dark', groups: ['x'] };
  const { manifestPath } = backup.writeSnapshot(base, { history, settings, reason: 'periodic' });

  const restored = backup.readSnapshot(base, manifestPath);
  assert.deepStrictEqual(restored.history, history, 'history reconstructed verbatim, in order');
  assert.deepStrictEqual(restored.settings, settings, 'settings reconstructed');
  assert.strictEqual(restored.reason, 'periodic', 'reason preserved');
  fs.rmSync(base, { recursive: true, force: true });
  ok('snapshot round-trips history + settings exactly (order preserved)');
}

// ---------------------------------------------------------------------------
// 2. Dedup: two snapshots that share items store each distinct item ONCE.
// ---------------------------------------------------------------------------
function dedup() {
  const base = tmpBase();
  const h1 = [item('a', 'alpha'), item('b', 'beta'), item('c', 'gamma')];
  backup.writeSnapshot(base, { history: h1, settings: { s: 1 }, reason: 'periodic' });
  // Identical history again → NO new item objects (settings identical too).
  backup.writeSnapshot(base, { history: h1, settings: { s: 1 }, reason: 'periodic' });

  // 3 items + 1 settings object, shared across both snapshots.
  assert.strictEqual(objectCount(base), 4, 'identical snapshots reuse the same objects');
  assert.strictEqual(manifestCount(base), 2, 'both manifests written');
  fs.rmSync(base, { recursive: true, force: true });
  ok('identical snapshots dedup to one object set');
}

// ---------------------------------------------------------------------------
// 3. One edit = one new object (the whole point of content-addressing).
// ---------------------------------------------------------------------------
function oneEditOneObject() {
  const base = tmpBase();
  const h1 = [item('a', 'alpha'), item('b', 'beta'), item('c', 'gamma')];
  backup.writeSnapshot(base, { history: h1, reason: 'periodic' }); // 3 objects
  const before = objectCount(base);

  const h2 = [item('a', 'alpha'), item('b', 'beta-EDITED'), item('c', 'gamma')];
  backup.writeSnapshot(base, { history: h2, reason: 'periodic' });
  assert.strictEqual(objectCount(base) - before, 1, 'editing one item adds exactly one object');
  fs.rmSync(base, { recursive: true, force: true });
  ok('editing one item costs exactly one new object');
}

// ---------------------------------------------------------------------------
// 4. Retention by age: an old snapshot is evicted and its now-unreferenced objects
//    are GC'd, while objects still referenced by a surviving snapshot are kept.
// ---------------------------------------------------------------------------
function ageEvictionGCs() {
  const base = tmpBase();
  const shared = item('a', 'alpha');
  const oldOnly = item('x', 'old-unique');
  const { manifestPath: oldPath } = backup.writeSnapshot(base, { history: [shared, oldOnly], reason: 'periodic' });
  const { manifestPath: newPath } = backup.writeSnapshot(base, { history: [shared, item('y', 'new-unique')], reason: 'periodic' });

  // Age the OLD manifest far into the past.
  const past = Date.now() - 10 * 86400 * 1000;
  fs.utimesSync(oldPath, new Date(past), new Date(past));

  backup.pruneBackups(base, { maxAgeMs: 48 * 3600 * 1000, now: Date.now() });

  assert.ok(!fs.existsSync(oldPath), 'old manifest evicted by age');
  assert.ok(fs.existsSync(newPath), 'recent manifest kept');
  const restored = backup.readSnapshot(base, newPath);
  assert.deepStrictEqual(restored.history, [shared, item('y', 'new-unique')], 'surviving snapshot still fully resolvable');
  // old-unique object should be GC'd; shared (alpha) must remain.
  const sharedHash = backup.sha256Hex(backup.stableStringify(shared));
  const oldHash = backup.sha256Hex(backup.stableStringify(oldOnly));
  assert.ok(fs.existsSync(path.join(base, 'objects', `${sharedHash}.json`)), 'shared object retained');
  assert.ok(!fs.existsSync(path.join(base, 'objects', `${oldHash}.json`)), 'orphaned object GC-ed');
  fs.rmSync(base, { recursive: true, force: true });
  ok('age eviction removes the manifest and GCs only its orphaned objects');
}

// ---------------------------------------------------------------------------
// 5. Size ceiling: drop oldest snapshots until the store is under maxBytes.
// ---------------------------------------------------------------------------
function sizeCeiling() {
  const base = tmpBase();
  // 6 snapshots each with a big unique item so the pool grows past the cap.
  const big = 'z'.repeat(20000);
  const paths = [];
  for (let i = 0; i < 6; i++) {
    const { manifestPath } = backup.writeSnapshot(base, { history: [item(`k${i}`, `${big}-${i}`)], reason: 'periodic' });
    paths.push(manifestPath);
    const t = Date.now() - (6 - i) * 1000; // ascending mtime
    fs.utimesSync(manifestPath, new Date(t), new Date(t));
  }
  // Cap at ~2 snapshots' worth.
  backup.pruneBackups(base, { maxBytes: 50000, now: Date.now() });

  const remaining = backup.listSnapshots(base).length;
  assert.ok(remaining >= 1 && remaining < 6, `size cap dropped oldest snapshots (kept ${remaining})`);
  assert.ok(!fs.existsSync(paths[0]), 'oldest snapshot dropped first');
  assert.ok(fs.existsSync(paths[5]), 'newest snapshot kept');
  fs.rmSync(base, { recursive: true, force: true });
  ok('size ceiling drops oldest snapshots until under the cap');
}

// ---------------------------------------------------------------------------
// 6. Legacy full snapshots are readable and age out under the same retention.
// ---------------------------------------------------------------------------
function legacyCompat() {
  const base = tmpBase();
  fs.mkdirSync(base, { recursive: true });
  const legacyName = '2026-06-01T00-00-00-000Z-periodic-abc123def456.json';
  const legacyPath = path.join(base, legacyName);
  const legacyHistory = [item('L', 'legacy-note')];
  fs.writeFileSync(legacyPath, JSON.stringify({ createdAt: '2026-06-01T00:00:00.000Z', reason: 'periodic', history: legacyHistory, settings: { s: 9 } }));

  const restored = backup.readSnapshot(base, legacyPath);
  assert.deepStrictEqual(restored.history, legacyHistory, 'legacy full snapshot reads back');
  assert.deepStrictEqual(restored.settings, { s: 9 }, 'legacy settings read back');
  assert.strictEqual(backup.listSnapshots(base).length, 1, 'legacy snapshot enumerated');

  // Age it out.
  const past = Date.now() - 100 * 86400 * 1000;
  fs.utimesSync(legacyPath, new Date(past), new Date(past));
  backup.pruneBackups(base, { maxAgeMs: 48 * 3600 * 1000, now: Date.now() });
  assert.ok(!fs.existsSync(legacyPath), 'legacy snapshot aged out');
  fs.rmSync(base, { recursive: true, force: true });
  ok('legacy full snapshots read back and age out under retention');
}

(async () => {
  console.log('backup.test.js');
  roundTrip();
  dedup();
  oneEditOneObject();
  ageEvictionGCs();
  sizeCeiling();
  legacyCompat();
  console.log(`\n${passed} assertions passed`);
})().catch(e => { console.error('\nFAILED:', e && e.stack || e); process.exit(1); });
