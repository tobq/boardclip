'use strict';
// The cloud history snapshot as segments (lib/sync-snapshot): a snapshot write
// hands the cloud client only the segments whose clips changed (Drive uploads
// a changed file whole), the legacy 21 MB monolith converts to segments holding
// exactly the same clips before it is deleted, Drive forks fold back, and
// main.js no longer writes the monolith or a synced diagnostics copy.
const assert = require('assert');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');

const snapshot = require('../lib/sync-snapshot');
const forkNames = require('../lib/fork-names');

const tmpDirs = [];
function tmpDir(tag) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `bc-snapshot-${tag}-`));
  tmpDirs.push(dir);
  return dir;
}
function txt(text, ts, extra = {}) {
  const hash = crypto.createHash('sha256').update(text).digest('hex');
  return { id: `txt:${hash}`, type: 'text', text, ts, ...extra };
}
function history(n, { size = 900, from = 0 } = {}) {
  const out = [];
  for (let i = from; i < from + n; i++) out.push(txt(`clip ${i} ${'x'.repeat(size)}`, 1_800_000_000 - i));
  return out;
}
function itemInBucket(bucket, label) {
  for (let i = 0; ; i++) {
    const item = txt(`${label} ${i}`, 1_700_000_000 + i);
    if (snapshot.bucketOf(item) === bucket) return item;
  }
}
const ids = items => items.map(item => item.id).sort();
const segDir = dir => path.join(dir, snapshot.SNAPSHOT_DIR);
const listSeg = dir => fs.readdirSync(segDir(dir)).sort();

(async () => {
  // ---- 1. partition: every clip in exactly one of <= 256 buckets ----------
  {
    const items = history(3000, { size: 10 });
    const parts = snapshot.partition(items);
    assert.ok(parts.size <= 256 && parts.size > 200, `3000 clips spread over the buckets (${parts.size})`);
    const flat = [...parts.values()].flat();
    assert.strictEqual(flat.length, items.length, 'no clip lost or doubled by the partition');
    for (const [bucket, list] of parts) for (const item of list) assert.strictEqual(snapshot.bucketOf(item), bucket);
    assert.strictEqual(snapshot.bucketOf(items[7]), snapshot.bucketOf({ ...items[7], pin: { number: 3 } }), 'the bucket follows the id, not the content');
    console.log('ok  partition: 3000 clips, each in exactly one bucket keyed by id');
  }

  // ---- 2. a snapshot write uploads only the segments a new clip touches -----
  {
    const dir = tmpDir('write');
    const items = history(5000);
    let current = await snapshot.readSegments(dir);
    assert.strictEqual(current.exists, false);
    const first = await snapshot.writeSegments(dir, items, current, { device: 'dev-A' });
    const total = first.bytes;
    assert.ok(first.written.length > 200 && first.indexBytes > 0, 'first write creates every segment + the index');
    assert.ok(!listSeg(dir).some(n => /\.tmp$/.test(n)), 'segments are written in place (no tmp + rename for DriveFS to fork)');
    current = await snapshot.readSegments(dir);
    assert.deepStrictEqual(snapshot.fingerprint(current.items), snapshot.fingerprint(items), 'read back = written (count + content hashes)');

    const added = [txt('one more clip', 1_900_000_000), ...items];
    const second = await snapshot.writeSegments(dir, added, current, { device: 'dev-A' });
    assert.deepStrictEqual(second.written, [snapshot.bucketOf(added[0])], 'one new clip rewrites exactly its own segment');
    const perClip = second.bytes + second.indexBytes;
    assert.ok(perClip * 100 < total, `a new clip costs ${perClip} bytes, under 1% of the ${total}-byte history`);

    current = await snapshot.readSegments(dir);
    const same = await snapshot.writeSegments(dir, added, current, { device: 'dev-A' });
    assert.deepStrictEqual(same.written, [], 'nothing changed: no segment written');
    assert.strictEqual(same.indexBytes, 0, 'nothing changed: index untouched');

    // Another device serialises the same clips with other field and list order:
    // no upload, and no ping-pong back to this device's order.
    const otherDevice = [...added].reverse().map(item => Object.fromEntries(Object.entries(item).reverse()));
    const foreign = await snapshot.writeSegments(dir, otherDevice, current, {});
    assert.deepStrictEqual(foreign.written, [], 'the same clips in another order write nothing');
    assert.deepStrictEqual(snapshot.fingerprint(otherDevice), snapshot.fingerprint(added), 'the fingerprint ignores field and list order');

    // A pin on an existing clip touches its segment only; a bucket that empties is written as [].
    const pinned = added.map((item, i) => (i === 10 ? { ...item, pin: { number: 2 } } : item));
    current = await snapshot.readSegments(dir);
    const pinWrite = await snapshot.writeSegments(dir, pinned, current, {});
    assert.deepStrictEqual(pinWrite.written, [snapshot.bucketOf(pinned[10])]);
    const bucket = snapshot.bucketOf(pinned[0]);
    const emptied = pinned.filter(item => snapshot.bucketOf(item) !== bucket);
    current = await snapshot.readSegments(dir);
    await snapshot.writeSegments(dir, emptied, current, {});
    assert.strictEqual(fs.readFileSync(path.join(segDir(dir), `${bucket}.json`), 'utf8'), '[]', 'an emptied segment is rewritten as [], never left stale');
    current = await snapshot.readSegments(dir);
    assert.deepStrictEqual(snapshot.fingerprint(current.items), snapshot.fingerprint(emptied));
    console.log(`ok  writeSegments: ${total} bytes first, ${perClip} bytes for one new clip (1 segment + index), 0 when unchanged`);
  }

  // ---- 3. legacy monolith -> segments: exact, verified, backed up, deleted --
  {
    const dir = tmpDir('migrate');
    const items = history(4000);
    const raw = '﻿' + JSON.stringify(items);   // a BOM must not read as an empty store
    fs.writeFileSync(path.join(dir, snapshot.LEGACY_FILE), raw);
    const backups = [];
    const report = await snapshot.migrateLegacy(dir, { backup: async file => { backups.push(file); return `kept:${file.name}`; } });
    assert.ok(report && report.ok, `migration ok (${report && report.pending})`);
    assert.strictEqual(report.exact, true);
    assert.deepStrictEqual(report.segment_fingerprint, report.legacy_fingerprint, 'segments hold exactly the legacy clips');
    assert.strictEqual(report.legacy_fingerprint.count, 4000);
    assert.strictEqual(report.missing, 0);
    assert.ok(!fs.existsSync(path.join(dir, snapshot.LEGACY_FILE)), 'legacy monolith deleted');
    assert.strictEqual(backups.length, 1);
    assert.strictEqual(backups[0].raw, raw, 'the backup callback got the legacy bytes untouched');
    assert.deepStrictEqual(report.backups, [`kept:${snapshot.LEGACY_FILE}`]);
    const read = await snapshot.readSegments(dir);
    assert.deepStrictEqual(snapshot.fingerprint(read.items), snapshot.fingerprint(items));
    assert.ok(read.hasIndex, 'the index is written');
    assert.strictEqual(await snapshot.migrateLegacy(dir, {}), null, 'nothing left to migrate');
    console.log('ok  migrateLegacy: 4000 clips, same count + content hashes, backup kept, monolith gone, idempotent');
  }

  // ---- 4. a torn legacy file or a failed backup deletes nothing ------------
  {
    const dir = tmpDir('torn');
    fs.writeFileSync(path.join(dir, snapshot.LEGACY_FILE), '[{"id":"txt:a","ts":1},{"id":"t');
    const torn = await snapshot.migrateLegacy(dir, {});
    assert.ok(!torn.ok && torn.pending, 'a torn legacy file is not converted');
    assert.ok(fs.existsSync(path.join(dir, snapshot.LEGACY_FILE)), 'a torn legacy file is kept');
    assert.ok(!fs.existsSync(segDir(dir)), 'no segment written from a torn read');

    const dir2 = tmpDir('nobackup');
    fs.writeFileSync(path.join(dir2, snapshot.LEGACY_FILE), JSON.stringify(history(50)));
    await assert.rejects(snapshot.migrateLegacy(dir2, { backup: async () => { throw new Error('disk full'); } }));
    assert.ok(fs.existsSync(path.join(dir2, snapshot.LEGACY_FILE)), 'a failed backup deletes nothing');

    // An old build rewriting the monolith after it was read: kept for the next pass.
    const dir3 = tmpDir('rewritten');
    const legacy = path.join(dir3, snapshot.LEGACY_FILE);
    fs.writeFileSync(legacy, JSON.stringify(history(50)));
    const report = await snapshot.migrateLegacy(dir3, { backup: async () => { fs.writeFileSync(legacy, JSON.stringify(history(51))); return 'b'; } });
    assert.ok(!report.ok && report.kept && report.kept.length === 1, 'a monolith changed since it was read is kept');
    assert.ok(fs.existsSync(legacy));
    const next = await snapshot.migrateLegacy(dir3, { backup: async () => 'b' });
    assert.ok(next.ok && !fs.existsSync(legacy), 'and converted on the next pass');
    const read = await snapshot.readSegments(dir3);
    assert.deepStrictEqual(ids(read.items), ids(history(51)), 'the rewritten content reached the segments');
    console.log('ok  migrateLegacy: torn file, failed backup and a mid-migration rewrite all keep the monolith');
  }

  // ---- 5. legacy forks + tmps (every Drive naming) union into existing segments
  {
    const dir = tmpDir('forks');
    const [A, B, C, D, E] = ['A', 'B', 'C', 'D', 'E'].map((label, i) => txt(`fork clip ${label}`, 100 + i));
    await snapshot.writeSegments(dir, [A, B], await snapshot.readSegments(dir), {});
    fs.writeFileSync(path.join(dir, 'clipboard-history.json'), JSON.stringify([B, C]));
    fs.writeFileSync(path.join(dir, 'clipboard-history 2.json'), JSON.stringify([E]));
    fs.writeFileSync(path.join(dir, 'clipboard-history.json.33420.1780154004000.tmp'), JSON.stringify([D]));
    fs.writeFileSync(path.join(dir, 'clipboard-history.json.104500.1793913408459.tmp'), '');
    const report = await snapshot.migrateLegacy(dir, {});
    assert.ok(report.ok && !report.exact, `union migration ok (${report.pending})`);
    assert.deepStrictEqual(ids((await snapshot.readSegments(dir)).items), ids([A, B, C, D, E]), 'every clip from segments + monolith + forks + tmps kept');
    assert.deepStrictEqual(fs.readdirSync(dir).sort(), [snapshot.SNAPSHOT_DIR], 'every legacy file gone (the 0-byte tmp too)');
    console.log('ok  migrateLegacy: monolith + space-number fork + tmps unioned into existing segments, A-E kept');
  }

  // ---- 6. Drive forks of a segment and of the index fold back on read -------
  {
    const dir = tmpDir('segfork');
    const X = itemInBucket('3f', 'x');
    const Y = itemInBucket('3f', 'y');
    await snapshot.writeSegments(dir, [X], await snapshot.readSegments(dir), {});
    fs.writeFileSync(path.join(segDir(dir), '3f (1).json'), JSON.stringify([Y]));
    fs.writeFileSync(path.join(segDir(dir), '3f.json 2.json'), JSON.stringify([X]));
    fs.writeFileSync(path.join(segDir(dir), 'index (1).json'), '{}');
    assert.strictEqual(forkNames.segmentForkBucket('3f (1).json'), '3f');
    assert.strictEqual(forkNames.segmentForkBucket('3f 2.json'), '3f');
    assert.strictEqual(forkNames.segmentForkBucket('3f.json 2.json'), '3f');
    assert.strictEqual(forkNames.segmentForkBucket('3f.json'), null);
    assert.strictEqual(forkNames.segmentForkBucket('index.json'), null);
    const removed = await snapshot.healSegmentForks(dir);
    assert.strictEqual(removed, 3);
    assert.deepStrictEqual(listSeg(dir), ['3f.json', 'index.json']);
    assert.deepStrictEqual(ids((await snapshot.readSegments(dir)).items), ids([X, Y]), 'the fork\'s clip folded into its segment');
    console.log('ok  healSegmentForks: paren + space-number forks folded, index fork dropped');
  }

  // ---- 7. main.js: no monolith write, no synced diagnostics copy ------------
  {
    const mainJs = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8');
    const body = (name) => {
      const start = mainJs.indexOf(`async function ${name}(`);
      assert.ok(start >= 0, `${name} exists`);
      return mainJs.slice(start, mainJs.indexOf('\n}\n', start));
    };
    const write = body('writeRemoteState');
    assert.ok(write.includes('syncSnapshot.writeSegments('), 'the snapshot write goes through the segment writer');
    assert.ok(!/clipboard-history\.json|LEGACY_FILE/.test(write), 'the snapshot write never touches the monolith');
    const read = body('readRemoteState');
    assert.ok(read.includes('syncSnapshot.readSegments(') && !/clipboard-history\.json|LEGACY_FILE/.test(read), 'the read takes segments only');
    assert.ok(!/SyncedDiagnostics/.test(mainJs), 'the synced diagnostics writer is gone');
    const cleanup = body('removeRetiredDiagnosticsCopy');
    assert.strictEqual(mainJs.split("'boardclip-diagnostics'").length - 1, 1, 'the cloud diagnostics folder is named once in main.js');
    assert.ok(cleanup.includes("'boardclip-diagnostics'") && !/writeFile|atomicWrite|writeInPlace|mkdir/.test(cleanup),
      'and only to remove what this device left there');
    assert.ok(/removeRetiredDiagnosticsCopy\(syncPath\)/.test(mainJs), 'this device removes the copy it left behind');
    assert.ok(/DIAGNOSTICS_PATH = path\.join\(DATA_DIR, 'boardclip-diagnostics\.jsonl'\)/.test(mainJs) && /'main\.heartbeat'/.test(mainJs),
      'the local diagnostics log and its 1 s heartbeat stay');
    console.log('ok  main.js: snapshot via segments only, synced diagnostics copy retired, local heartbeat kept');
  }

  for (const dir of tmpDirs) fs.rmSync(dir, { recursive: true, force: true });
  console.log('\nALL PASS');
})().catch(error => {
  for (const dir of tmpDirs) { try { fs.rmSync(dir, { recursive: true, force: true }); } catch {} }
  console.error(error);
  process.exit(1);
});
