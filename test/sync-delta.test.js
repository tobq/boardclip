'use strict';
// Delta sync core: the changes feed (revision cursors), envelope apply safety on
// top of the REAL union merge, AES-GCM body sealing, cloud journal files, and
// the Tailscale status parser.
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

const clipboardModel = require('../lib/clipboard-model');
const syncDelta = require('../lib/sync-delta');
const p2pCrypto = require('../lib/p2p-crypto');
const journal = require('../lib/sync-journal');
const tailscale = require('../lib/tailscale');

const NOW = 1_800_000_000_000;
function txt(text, ts, extra = {}) {
  const hash = crypto.createHash('sha256').update(text).digest('hex');
  return { id: `txt:${hash}`, type: 'text', text, ts, ...extra };
}
function view(items, extra = {}) {
  return {
    items,
    tombstones: extra.tombstones || [],
    groupTombstones: extra.groupTombstones || [],
    supersedes: extra.supersedes || [],
    conflicts: extra.conflicts || { records: [] },
    settings: extra.settings || { groups: ['Work'], p2p_secret: 'abc' },
  };
}

(async () => {
  // ---- 1. changes feed: only what changed after the cursor -----------------
  const a = txt('alpha', 1000);
  const b = txt('bravo', 2000);
  const tracker = syncDelta.createChangeTracker({ revision: 100, now: () => NOW });
  tracker.bump();                                     // 101
  let changed = tracker.observe(view([a, b]));
  assert.deepStrictEqual(changed.sort(), [`i:${a.id}`, `i:${b.id}`, 'S'].sort(), 'first observe stamps everything');
  const r1 = tracker.revision;
  assert.strictEqual(r1, 101);
  changed = tracker.observe(view([a, b]));
  assert.deepStrictEqual(changed, [], 'unchanged view changes nothing');
  tracker.bump();                                     // 102
  const b2 = { ...b, pin: { groups: ['Work'], updatedAt: NOW } };
  changed = tracker.observe(view([a, b2]));
  assert.deepStrictEqual(changed, [`i:${b.id}`], 'a pin change is a change of that item only');
  let env = tracker.deltaSince(r1, view([a, b2]), { deviceId: 'dev-A', deviceName: 'A', assetsOf: items => ({ text: items.map(i => i.id) }) });
  assert.strictEqual(env.v, 2);
  assert.deepStrictEqual(env.history.map(i => i.id), [b.id], 'delta since r1 carries only bravo');
  assert.strictEqual(env.settings, undefined, 'settings unchanged since cursor: omitted');
  assert.strictEqual(env.full, false);
  assert.strictEqual(env.revision, 102);
  assert.strictEqual(env.originClock, NOW);
  assert.deepStrictEqual(env.assets, { text: [b.id] });
  const fullEnv = tracker.deltaSince(0, view([a, b2]), { deviceId: 'dev-A' });
  assert.strictEqual(fullEnv.full, true);
  assert.strictEqual(fullEnv.history.length, 2);
  assert.ok(fullEnv.settings && fullEnv.settings.groups[0] === 'Work', 'a full delta carries the small settings');
  assert.ok(tracker.isEmpty(tracker.deltaSince(102, view([a, b2]))), 'nothing after the head revision');

  // ---- 2. a delete arrives as a tombstone, never as an absence -------------
  tracker.bump();                                     // 103
  const tomb = { id: a.id, deletedAt: NOW + 5 };
  changed = tracker.observe(view([b2], { tombstones: [tomb] }));
  assert.deepStrictEqual(changed, [`t:${a.id}`], 'the tombstone is the change; the vanished item is just forgotten');
  env = tracker.deltaSince(102, view([b2], { tombstones: [tomb] }));
  assert.deepStrictEqual(env.history, []);
  assert.deepStrictEqual(env.tombstones, [tomb]);
  assert.ok(syncDelta.touchedIds(env).has(a.id));

  // ---- 3. restart: lost arrivals are re-sent once, known ones are not ------
  const persisted = tracker.serialize();
  assert.strictEqual(persisted.revision, 103);
  const startRev = syncDelta.startRevisionAfterLoad(persisted.revision, NOW);
  assert.strictEqual(startRev, NOW, 'start revision jumps past any cursor a peer could hold');
  const reloaded = syncDelta.createChangeTracker({ ...persisted, revision: startRev, now: () => NOW });
  const c = txt('charlie', 3000);                     // arrived during the lazy-write window
  reloaded.observe(view([b2, c], { tombstones: [tomb] }));
  env = reloaded.deltaSince(103, view([b2, c], { tombstones: [tomb] }));
  assert.deepStrictEqual(env.history.map(i => i.id), [c.id], 'only the entry whose arrival was lost is re-sent');
  assert.strictEqual(env.tombstones.length, 0);

  // ---- 4. applying a PARTIAL envelope through the real union merge ---------
  const local = [txt('alpha', 1000), txt('bravo', 2000), txt('delta', 4000)];
  const remoteB = { ...local[1], pin: { groups: ['Work'], updatedAt: NOW } };
  const partial = { v: 2, deviceId: 'dev-B', history: [remoteB], tombstones: [], group_tombstones: [], supersedes: [] };
  assert.ok(syncDelta.isEnvelope(partial));
  const rs = syncDelta.envelopeToRemoteState(partial);
  const settings = { tombstones: rs.remoteSettings.tombstones, group_tombstones: [], supersedes: [] };
  const merged = clipboardModel.mergeHistories(local.map(i => ({ ...i })), rs.remoteHistory, settings);
  assert.strictEqual(merged.length, 3, 'items absent from the delta survive (union merge)');
  assert.ok(merged.find(i => i.id === local[1].id).pin, 'the delta updated bravo');
  assert.strictEqual(syncDelta.historyChangedBy(local, merged, syncDelta.touchedIds(partial)), true);
  // The merge normalizes pin metadata on its first re-application (adds
  // groupsUpdatedAt), so byte-idempotence holds from the second application
  // on; change detection must report the fixed point as unchanged.
  const once = clipboardModel.mergeHistories(merged.map(i => ({ ...i })), rs.remoteHistory, settings);
  const twice = clipboardModel.mergeHistories(once.map(i => ({ ...i })), rs.remoteHistory, settings);
  assert.strictEqual(syncDelta.historyChangedBy(once, twice, syncDelta.touchedIds(partial)), false, 'idempotent re-apply is detected as no change');
  const tombEnv = { v: 2, deviceId: 'dev-B', history: [], tombstones: [{ id: local[0].id, deletedAt: NOW }], group_tombstones: [], supersedes: [] };
  const rs2 = syncDelta.envelopeToRemoteState(tombEnv);
  const afterDelete = clipboardModel.mergeHistories(merged.map(i => ({ ...i })), rs2.remoteHistory, { tombstones: rs2.remoteSettings.tombstones, group_tombstones: [], supersedes: [] });
  assert.strictEqual(afterDelete.length, 2, 'a tombstone delta deletes');
  assert.strictEqual(syncDelta.historyChangedBy(merged, afterDelete, syncDelta.touchedIds(tombEnv)), true);
  assert.deepStrictEqual(Object.keys(syncDelta.settingsSmall({ groups: ['x'], tombstones: [1], supersedes: [2], group_tombstones: [3] })), ['groups']);

  // ---- 5. AES-GCM bodies ---------------------------------------------------
  const key = p2pCrypto.deriveKey('shared-secret');
  const sealed = p2pCrypto.sealJson(key, { hello: 'world', n: 1 });
  assert.deepStrictEqual(p2pCrypto.openJson(key, sealed), { hello: 'world', n: 1 });
  assert.notDeepStrictEqual(p2pCrypto.sealJson(key, { hello: 'world', n: 1 }), sealed, 'fresh IV per message');
  const tampered = Buffer.from(sealed); tampered[tampered.length - 1] ^= 0x01;
  assert.throws(() => p2pCrypto.openJson(key, tampered), 'tampered ciphertext is rejected');
  assert.throws(() => p2pCrypto.openJson(p2pCrypto.deriveKey('other-secret'), sealed), 'wrong secret is rejected');
  assert.throws(() => p2pCrypto.open(key, Buffer.alloc(5)), 'short body is rejected');
  assert.strictEqual(p2pCrypto.deriveKey('shared-secret').equals(key), true, 'derivation is deterministic');

  // ---- 6. cloud journal files ---------------------------------------------
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'bc-journal-'));
  try {
    const A = 'a1b2c3d4a1b2c3d4', B = 'ffffffffffffffff';
    assert.strictEqual(journal.journalName(102), '0000000000000102.json');
    assert.strictEqual(journal.parseJournalName('0000000000000102.json'), 102);
    assert.strictEqual(journal.parseJournalName('102.json'), null);
    assert.strictEqual(journal.parseJournalName('0000000000000102.json.123.tmp'), null);
    assert.strictEqual(journal.safeDeviceId('../evil'), 'evil');
    for (const rev of [5, 7, 9]) await journal.writeJournalEntry(tmp, A, { v: 2, deviceId: A, since: rev - 2, revision: rev, history: [] });
    await journal.writeJournalEntry(tmp, B, { v: 2, deviceId: B, since: 0, revision: 3, history: [] });
    const others = await journal.listJournal(tmp, { excludeDeviceId: A });
    assert.deepStrictEqual(others.map(f => [f.deviceId, f.revision]), [[B, 3]], 'own files are excluded');
    const all = await journal.listJournal(tmp);
    assert.deepStrictEqual(all.map(f => f.revision), [5, 7, 9, 3]);
    assert.strictEqual((await journal.readJournalEntry(all[0].path)).revision, 5);
    assert.strictEqual(await journal.readJournalEntry(path.join(tmp, 'missing.json')), null);
    assert.strictEqual(await journal.countJournal(tmp, A), 3);
    // Age the two oldest; prune covers revision <= 7 and older than 1 h only.
    const old = new Date(Date.now() - 2 * 3600 * 1000);
    for (const rev of [5, 7, 9]) fs.utimesSync(path.join(journal.deviceDir(tmp, A), journal.journalName(rev)), old, old);
    const removed = await journal.pruneJournal(tmp, A, { upToRevision: 7, olderThanMs: 3600 * 1000 });
    assert.strictEqual(removed, 2);
    assert.deepStrictEqual((await journal.listJournal(tmp, { excludeDeviceId: B })).map(f => f.revision), [9], 'the file past the snapshot survives');
    assert.ok(!fs.existsSync(path.join(journal.deviceDir(tmp, A), '0000000000000005.json')));
    // Folder identity: stable, and two paths carrying the same marker dedupe.
    const id1 = await journal.folderIdentity(tmp);
    assert.strictEqual(await journal.folderIdentity(tmp), id1);
    const mirror = path.join(tmp, 'mirror'); fs.mkdirSync(mirror);
    fs.copyFileSync(path.join(tmp, journal.FOLDER_ID_FILE), path.join(mirror, journal.FOLDER_ID_FILE));
    const other = path.join(tmp, 'other'); fs.mkdirSync(other);
    const id3 = await journal.folderIdentity(other);
    const dedup = journal.dedupeByIdentity([{ path: tmp, id: id1 }, { path: mirror, id: await journal.folderIdentity(mirror) }, { path: other, id: id3 }]);
    assert.deepStrictEqual(dedup.primary, [tmp, other]);
    assert.deepStrictEqual(dedup.duplicateOf, { [mirror]: tmp });
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }

  // ---- 7. tailscale status --------------------------------------------------
  const fixture = {
    BackendState: 'Running',
    Self: { HostName: 'Tobi-Room-Desktop', DNSName: 'tobi-room-desktop.tail.ts.net.', TailscaleIPs: ['100.109.45.50', 'fd7a::1'], Online: true },
    Peer: {
      k1: { ID: 'n1', HostName: 'tobis-macbook-air', DNSName: 'tobis-macbook-air.tail.ts.net.', OS: 'macOS', TailscaleIPs: ['100.96.108.108', 'fd7a::2'], Online: true },
      k2: { ID: 'n2', HostName: 'phone', OS: 'iOS', TailscaleIPs: ['100.70.1.1'], Online: false },
    },
  };
  const parsed = tailscale.parseStatus(fixture);
  assert.strictEqual(parsed.available, true);
  assert.deepStrictEqual(parsed.self.ips, ['100.109.45.50']);
  assert.deepStrictEqual(parsed.peers.map(p => [p.name, p.ips[0], p.online]), [['phone', '100.70.1.1', false], ['tobis-macbook-air', '100.96.108.108', true]]);
  assert.strictEqual(parsed.peers[1].dnsName, 'tobis-macbook-air.tail.ts.net');
  assert.strictEqual(tailscale.parseStatus(null).available, false);
  assert.strictEqual(tailscale.findBinary({ platform: 'win32', exists: p => p === 'C:\\Program Files\\Tailscale\\tailscale.exe', pathEnv: '' }), 'C:\\Program Files\\Tailscale\\tailscale.exe');
  assert.strictEqual(tailscale.findBinary({ platform: 'linux', exists: p => p === '/opt/x/tailscale', pathEnv: '/opt/x:/bin' }), '/opt/x/tailscale');
  assert.strictEqual(tailscale.findBinary({ platform: 'darwin', exists: () => false, pathEnv: '' }), '');
  const viaExec = await tailscale.readStatus({ binary: '/fake', exec: (bin, args, opts, cb) => cb(null, JSON.stringify(fixture)) });
  assert.strictEqual(viaExec.peers.length, 2);
  const failed = await tailscale.readStatus({ binary: '/fake', exec: (bin, args, opts, cb) => cb(new Error('boom')) });
  assert.strictEqual(failed.available, false);
  assert.strictEqual((await tailscale.readStatus({ binary: '' })).available, false);

  console.log('sync-delta tests passed');
})().catch(error => { console.error(error); process.exit(1); });
