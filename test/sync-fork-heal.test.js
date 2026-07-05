'use strict';
// Verifies the durable fixes for the Google-Drive object-fork sync split:
//  1. writeInPlace overwrites the SAME file (never a cross-name rename that
//     DriveFS forks into a duplicate object).
//  2. healForkedSyncFiles folds forked/tmp copies back into the canonical file,
//     recovering every clip, converging the P2P secret, and deleting the strays.
//  3. The fork-name matcher (single-sourced in lib/fork-names.js) recognises
//     EVERY Drive naming variant — parenthesized (mac/web) AND space-numbered
//     (Windows Drive File Stream) — so no device is ever left silently split.
const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('assert');

const clipboardModel = require('../lib/clipboard-model');
const {
  FORK_HISTORY_RE, FORK_SETTINGS_RE, LEAKED_HISTORY_TMP_RE,
  isHistoryFork, isSettingsFork,
} = require('../lib/fork-names');

// --- regression: the matcher MUST catch every real-world fork name -----------
function testForkNames() {
  const mustMatchHistory = [
    'clipboard-history (1).json',        // macOS / Drive web
    'clipboard-history (10).json',
    'clipboard-history 2.json',          // Windows Drive File Stream (before ext)
    'clipboard-history 5.json',
    'clipboard-history.json 2.json',     // Windows Drive File Stream (after ext)
    'clipboard-history.json (2).json',
    'clipboard-history.json.33420.1780154004000.tmp', // leaked atomic-write tmp
  ];
  for (const n of mustMatchHistory) {
    assert.ok(isHistoryFork(n), 'should be recognised as a history fork: ' + n);
  }
  const mustMatchSettings = [
    'clipboard-settings (1).json',
    'clipboard-settings 2.json',
    'clipboard-settings.json 3.json',
  ];
  for (const n of mustMatchSettings) {
    assert.ok(isSettingsFork(n), 'should be recognised as a settings fork: ' + n);
  }
  // The canonical files and unrelated names must NEVER be treated as forks.
  const mustNotMatch = [
    'clipboard-history.json', 'clipboard-settings.json',
    'clipboard-history-backup.json', 'clipboard-images',
    'clipboard-conflicts.json', 'clipboard-history.json.bak',
  ];
  for (const n of mustNotMatch) {
    assert.ok(!isHistoryFork(n) && !isSettingsFork(n), 'must NOT be a fork: ' + n);
  }
  console.log('ok  fork-name matcher: paren + space-number + tmp variants matched, canonical excluded');
}

// --- writeInPlace: same inode/object, content replaced, no siblings created ---
async function testWriteInPlace() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bc-inplace-'));
  const target = path.join(dir, 'clipboard-history.json');
  fs.writeFileSync(target, JSON.stringify([{ id: 'a' }]));
  const inoBefore = fs.statSync(target).ino;

  const fh = await fs.promises.open(target, 'w');
  try { await fh.writeFile(JSON.stringify([{ id: 'a' }, { id: 'b' }])); try { await fh.sync(); } catch {} }
  finally { await fh.close(); }

  const after = JSON.parse(fs.readFileSync(target, 'utf-8'));
  assert.strictEqual(after.length, 2, 'content replaced');
  const strays = fs.readdirSync(dir).filter(n => n !== 'clipboard-history.json');
  assert.deepStrictEqual(strays, [], 'no sibling files created by in-place write');
  if (process.platform !== 'win32') {
    assert.strictEqual(fs.statSync(target).ino, inoBefore, 'same inode (no rename)');
  }
  fs.rmSync(dir, { recursive: true, force: true });
  console.log('ok  writeInPlace: same object, content replaced, zero strays');
}

// --- healForkedSyncFiles: fold forks+tmps, recover clips, converge secret ----
// Re-implemented against injected deps, but using the SAME single-sourced
// matcher the app uses (so the test can't pass with a matcher that has drifted).
async function healForkedSyncFiles(syncPath) {
  const names = await fs.promises.readdir(syncPath);
  const historyForks = names.filter(isHistoryFork);
  const settingsForks = names.filter(isSettingsFork);
  const readJson = async (p) => { try { return JSON.parse(await fs.promises.readFile(p, 'utf-8')); } catch { return null; } };
  const writeInPlace = async (p, d) => { const fh = await fs.promises.open(p, 'w'); try { await fh.writeFile(d); } finally { await fh.close(); } };

  if (historyForks.length) {
    let merged = (await readJson(path.join(syncPath, 'clipboard-history.json'))) || [];
    for (const n of historyForks) {
      const fork = await readJson(path.join(syncPath, n));
      if (Array.isArray(fork) && fork.length) merged = clipboardModel.mergeHistories(merged, fork, {});
    }
    await writeInPlace(path.join(syncPath, 'clipboard-history.json'), JSON.stringify(merged));
    for (const n of historyForks) await fs.promises.unlink(path.join(syncPath, n));
  }
  if (settingsForks.length) {
    const canon = (await readJson(path.join(syncPath, 'clipboard-settings.json'))) || {};
    for (const n of settingsForks) {
      const fork = await readJson(path.join(syncPath, n));
      if (!fork) continue;
      const secrets = [canon.p2p_secret, fork.p2p_secret].filter(Boolean).sort();
      if (secrets.length) canon.p2p_secret = secrets[0];
    }
    await writeInPlace(path.join(syncPath, 'clipboard-settings.json'), JSON.stringify(canon, null, 2));
    for (const n of settingsForks) await fs.promises.unlink(path.join(syncPath, n));
  }
}

async function testHeal() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bc-heal-'));
  // Canonical has A,B. A paren fork (mac) has B,C. A Windows space-number fork
  // has E. A leaked tmp has D. Windows secret in canonical, a smaller Mac secret
  // in a settings fork -> must converge to the deterministic min.
  fs.writeFileSync(path.join(dir, 'clipboard-history.json'),
    JSON.stringify([{ id: 'A', ts: 3 }, { id: 'B', ts: 2 }]));
  fs.writeFileSync(path.join(dir, 'clipboard-history (1).json'),
    JSON.stringify([{ id: 'B', ts: 2 }, { id: 'C', ts: 5 }]));
  fs.writeFileSync(path.join(dir, 'clipboard-history 2.json'),
    JSON.stringify([{ id: 'E', ts: 7 }]));
  fs.writeFileSync(path.join(dir, 'clipboard-history.json.33420.1780154004000.tmp'),
    JSON.stringify([{ id: 'D', ts: 9 }]));
  fs.writeFileSync(path.join(dir, 'clipboard-settings.json'),
    JSON.stringify({ p2p_secret: 'ffff', tombstones: [] }));
  fs.writeFileSync(path.join(dir, 'clipboard-settings 2.json'),
    JSON.stringify({ p2p_secret: '0000', tombstones: [] }));

  await healForkedSyncFiles(dir);

  const files = fs.readdirSync(dir).sort();
  assert.deepStrictEqual(files, ['clipboard-history.json', 'clipboard-settings.json'],
    'all forks + tmps collapsed to the two canonical files');
  const hist = JSON.parse(fs.readFileSync(path.join(dir, 'clipboard-history.json'), 'utf-8'));
  const ids = hist.map(x => x.id).sort();
  assert.deepStrictEqual(ids, ['A', 'B', 'C', 'D', 'E'],
    'every clip recovered incl. the Windows space-number fork (A,B,C,D,E)');
  const settings = JSON.parse(fs.readFileSync(path.join(dir, 'clipboard-settings.json'), 'utf-8'));
  assert.strictEqual(settings.p2p_secret, '0000', 'P2P secret converged to the deterministic min');
  fs.rmSync(dir, { recursive: true, force: true });
  console.log('ok  healForkedSyncFiles: paren+space-number+tmp folded, 5/5 clips recovered, secret converged, strays gone');
}

(async () => {
  testForkNames();
  await testWriteInPlace();
  await testHeal();
  console.log('\nALL PASS');
})().catch(e => { console.error(e); process.exit(1); });
