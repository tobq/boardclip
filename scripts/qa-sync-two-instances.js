#!/usr/bin/env node
'use strict';
// Hermetic two-instance sync check: boots TWO isolated BoardClip instances on
// this machine (own data dirs, own --user-data-dir, own CDP ports, every real
// cloud provider pre-disabled, AI off) sharing one generated P2P secret and one
// temp "cloud" folder, and asserts from their diagnostics logs:
//
//   scenario p2p   (both P2P on):  discovery joined every real interface, each
//                  instance saw the other (p2p.peer.seen), the seeded histories
//                  converged over the v2 delta protocol (sync.delta_apply with
//                  protocol 2 / no full-state push), and sync.latency was logged.
//   scenario cloud (B's P2P off):  A's clip reaches B through the temp cloud
//                  folder's journal file (sync/<device>/<rev>.json) via the
//                  folder watcher, well inside the 30 s poll.
//
// Prints discovery + convergence times per scenario. SAFETY: the sandboxes use
// their own secret (the user's live BoardClip ignores their announcements),
// pre-disable every detected provider, and only electron processes whose
// command line contains the temp dir are killed.
//
// Usage: node scripts/qa-sync-two-instances.js [p2p|cloud|all|legacy] [--keep]
//   legacy: QA_LEGACY_ROOT=<old-build checkout> [QA_PARENT_DIR=<scratch>] (see runLegacyScenario)

const { spawn, execFileSync } = require('child_process');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const KEEP = process.argv.includes('--keep');
const SCENARIO = (process.argv.slice(2).find(a => !a.startsWith('--')) || 'all');
const TIMEOUT_MS = 45 * 1000;
const electronBin = process.platform === 'win32'
  ? path.join(ROOT, 'node_modules', 'electron', 'dist', 'electron.exe')
  : path.join(ROOT, 'node_modules', '.bin', 'electron');

let providerPaths = [];
try {
  const accounts = require(path.join(ROOT, 'lib', 'cloud-accounts'))();
  providerPaths = (Array.isArray(accounts) ? accounts : []).map(a => a && a.path).filter(Boolean);
} catch {}

const sleep = ms => new Promise(r => setTimeout(r, ms));

function textItem(text, ts) {
  const hash = crypto.createHash('sha256').update(text).digest('hex');
  return { id: `txt:${hash}`, type: 'text', text, ts };
}

function readDiag(inst) {
  try {
    return fs.readFileSync(path.join(inst.dataDir, 'boardclip-diagnostics.jsonl'), 'utf8')
      .split('\n').filter(Boolean).map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
  } catch { return []; }
}

function readHistoryTexts(inst) {
  try {
    const items = JSON.parse(fs.readFileSync(path.join(inst.dataDir, 'clipboard-history.json'), 'utf8'));
    return new Set(items.map(it => it.text || it.preview || '').filter(Boolean));
  } catch { return new Set(); }
}

// Drive A's popup renderer over CDP and pin its seed clip: a REAL local
// mutation (saveHistory -> push / journal), then time its arrival on B.
async function listTargets(port) { try { const r = await fetch(`http://127.0.0.1:${port}/json/list`); return await r.json(); } catch { return null; } }
function connectCdp(wsUrl) {
  const ws = new WebSocket(wsUrl); let seq = 0; const pending = new Map();
  ws.addEventListener('message', ev => { const m = JSON.parse(ev.data); if (m.id && pending.has(m.id)) { const { res, rej } = pending.get(m.id); pending.delete(m.id); m.error ? rej(new Error(JSON.stringify(m.error))) : res(m.result); } });
  const send = (method, params) => new Promise((res, rej) => { const id = ++seq; pending.set(id, { res, rej }); ws.send(JSON.stringify({ id, method, params: params || {} })); setTimeout(() => { if (pending.has(id)) { pending.delete(id); rej(new Error('cdp timeout ' + method)); } }, 15000); });
  return new Promise((res, rej) => { ws.addEventListener('open', () => res({ ws, send })); ws.addEventListener('error', () => rej(new Error('cdp ws error'))); });
}
async function driveLiveChange(a, b, cdpPort) {
  let popup = null;
  for (let i = 0; i < 40 && !popup; i++) { const targets = await listTargets(cdpPort); popup = (targets || []).find(x => x.type === 'page' && /index\.html/.test(x.url || '')); if (!popup) await sleep(250); }
  if (!popup) return { error: 'no popup target on A' };
  const cdp = await connectCdp(popup.webSocketDebuggerUrl);
  try {
    await cdp.send('Runtime.enable');
    const id = textItem(a.seedText, 0).id;
    const startedAt = Date.now();
    const r = await cdp.send('Runtime.evaluate', { expression: `window.api.getHistory().then((h) => window.api.pin(${JSON.stringify(id)}, (h.find((x) => x.id === ${JSON.stringify(id)}) || {}).rev)).then(() => 'pinned')`, awaitPromise: true, returnByValue: true });
    if (r.exceptionDetails) return { error: 'pin failed: ' + (r.exceptionDetails.text || '') };
    let arrivedAt = null;
    while (Date.now() - startedAt < 20000) {
      try {
        const items = JSON.parse(fs.readFileSync(path.join(b.dataDir, 'clipboard-history.json'), 'utf8'));
        const item = items.find(it => it.id === id);
        if (item && item.pin) { arrivedAt = Date.now(); break; }
      } catch {}
      await sleep(50);
    }
    return { pinned_id: id.slice(0, 16), arrived_ms: arrivedAt ? arrivedAt - startedAt : null };
  } finally { try { cdp.ws.close(); } catch {} }
}

function killSandboxElectrons(tmp) {
  if (process.platform !== 'win32') return;
  try {
    execFileSync('powershell', ['-NoProfile', '-Command',
      `Get-CimInstance Win32_Process -Filter "Name='electron.exe'" | Where-Object { $_.CommandLine -like '*${tmp.replace(/'/g, "''")}*' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }`,
    ], { stdio: 'ignore', timeout: 20000 });
  } catch {}
}

async function runScenario(name, { bP2P }) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), `bc-two-${name}-`));
  const cloudDir = path.join(tmp, 'cloud');
  fs.mkdirSync(cloudDir, { recursive: true });
  const secret = crypto.randomBytes(32).toString('hex');
  const nowSec = Math.floor(Date.now() / 1000);
  const out = { scenario: name, ok: false, tmp };

  function makeInstance(label, cdpPort, seedText, p2pEnabled) {
    const dataDir = path.join(tmp, label, 'data');
    const userDataDir = path.join(tmp, label, 'udd');
    fs.mkdirSync(dataDir, { recursive: true });
    fs.mkdirSync(userDataDir, { recursive: true });
    const deviceId = crypto.randomBytes(16).toString('hex');
    fs.writeFileSync(path.join(dataDir, 'clipboard-settings.json'), JSON.stringify({
      p2p_enabled: p2pEnabled,
      p2p_secret: secret,
      p2p_device_id: deviceId,
      ai_access_enabled: false,
      diagnostics_enabled: true,
      sync_disabled_paths: providerPaths,
      sync_custom_paths: [cloudDir],
      surface_style: 'solid',
    }, null, 2));
    fs.writeFileSync(path.join(dataDir, 'clipboard-history.json'), JSON.stringify([textItem(seedText, nowSec - 10)]));
    const child = spawn(electronBin, ['.', `--user-data-dir=${userDataDir}`, `--remote-debugging-port=${cdpPort}`], {
      cwd: ROOT,
      env: { ...process.env, BOARDCLIP_DATA_DIR: dataDir, BOARDCLIP_ISOLATED: '1' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stderr = '';
    child.stderr.on('data', d => { stderr += d.toString(); });
    child.stdout.on('data', () => {});
    return { label, dataDir, deviceId, child, seedText, stderr: () => stderr };
  }

  const a = makeInstance('A', 18421, `${name} clip from A`, true);
  // Start B a beat later so A's first journal write is what B's watcher sees.
  await sleep(1500);
  const b = makeInstance('B', 18422, `${name} clip from B`, bP2P);
  const started = Date.now();
  try {
    let converged = null;
    let firstSeenA = null; let firstSeenB = null;
    while (Date.now() - started < TIMEOUT_MS) {
      const da = readDiag(a); const db = readDiag(b);
      firstSeenA = firstSeenA || da.find(e => e.event === 'p2p.peer.seen');
      firstSeenB = firstSeenB || db.find(e => e.event === 'p2p.peer.seen');
      const ta = readHistoryTexts(a); const tb = readHistoryTexts(b);
      if (ta.has(a.seedText) && ta.has(b.seedText) && tb.has(a.seedText) && tb.has(b.seedText)) { converged = Date.now(); break; }
      await sleep(250);
    }
    // Live change on A after convergence: pin A's seed clip, time it on B.
    out.live_change = converged ? await driveLiveChange(a, b, 18421) : { skipped: 'no convergence' };
    await sleep(800);
    const da = readDiag(a); const db = readDiag(b);
    const startA = da.find(e => e.event === 'p2p.start');
    out.a_start = startA && { port: startA.port, fixed_port: startA.fixed_port, interfaces: (startA.interfaces || []).map(i => i.address) };
    out.a_saw_b = !!firstSeenA && { host: firstSeenA.host, port: firstSeenA.port, transport: firstSeenA.transport, via: firstSeenA.via, at_ms: new Date(firstSeenA.ts).getTime() - started };
    out.b_saw_a = !!firstSeenB && { host: firstSeenB.host, via: firstSeenB.via, at_ms: new Date(firstSeenB.ts).getTime() - started };
    out.converged_ms = converged ? converged - started : null;
    const applies = [...da, ...db].filter(e => e.event === 'sync.delta_apply');
    out.delta_applies = applies.map(e => ({ who: da.includes(e) ? 'A' : 'B', source: e.source, remote_items: e.remote_items, full: e.full, local_changed: e.local_changed, ms: e.ms }));
    out.full_state_pushes = [...da, ...db].filter(e => e.event === 'p2p.push' && e.protocol !== 2).length;
    out.v2_pushes = [...da, ...db].filter(e => e.event === 'p2p.push' && e.protocol === 2).map(e => ({ items: e.items, bytes: e.bytes, ok: e.ok }));
    out.latencies = [...da, ...db].filter(e => e.event === 'sync.latency').map(e => ({ who: da.includes(e) ? 'A' : 'B', source: e.source, ms: e.ms, items: e.items }));
    out.journal_writes = [...da, ...db].filter(e => e.event === 'sync.journal.write').map(e => ({ who: da.includes(e) ? 'A' : 'B', bytes: e.bytes, items: e.items }));
    out.journal_reads = [...da, ...db].filter(e => e.event === 'sync.journal.read').map(e => ({ who: da.includes(e) ? 'A' : 'B', entries: e.entries, items: e.items }));
    out.watch = [...da, ...db].filter(e => /^sync\.watch/.test(e.event)).map(e => e.event);
    let journalFiles = [];
    try {
      for (const dev of fs.readdirSync(path.join(cloudDir, 'sync'))) {
        for (const f of fs.readdirSync(path.join(cloudDir, 'sync', dev))) journalFiles.push(`${dev.slice(0, 6)}/${f}`);
      }
    } catch {}
    out.journal_files = journalFiles;
    out.snapshot_bytes = (() => { try { return fs.statSync(path.join(cloudDir, 'clipboard-history.json')).size; } catch { return 0; } })();
    out.errors = [...da, ...db].filter(e => /error/.test(e.event)).map(e => `${da.includes(e) ? 'A' : 'B'} ${e.event}: ${e.error || ''}`).slice(0, 8);
    const stderrTail = (a.stderr() + b.stderr()).split('\n').filter(l => /Error|error/.test(l)).slice(-5);
    if (stderrTail.length) out.stderr = stderrTail;
    const live = out.live_change && out.live_change.arrived_ms != null;
    if (name === 'p2p') {
      out.ok = !!(converged && live && firstSeenA && firstSeenB && startA && startA.interfaces.length
        && out.full_state_pushes === 0 && applies.some(e => /^p2p/.test(e.source))
        && out.latencies.some(l => /^p2p/.test(l.source)) && out.journal_writes.length > 0 && !out.errors.length);
    } else {
      out.ok = !!(converged && live && out.journal_reads.length > 0 && out.latencies.some(l => l.source === 'cloud')
        && journalFiles.length > 0 && !out.errors.length);
    }
  } catch (error) {
    out.error = error && error.message;
  } finally {
    if (!KEEP) {
      try { a.child.kill(); } catch {}
      try { b.child.kill(); } catch {}
      await sleep(1500);
      killSandboxElectrons(tmp);
      await sleep(500);
      try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {}
    }
  }
  return out;
}

// --- scenario legacy: sync with a device still on the PREVIOUS build ---------------
// QA_LEGACY_ROOT = a checkout of the old build (e.g. `git worktree add <dir> <commit>`
// with node_modules junctioned in; never npm-install there). A runs THIS checkout,
// B the old build, each through its own checkout's scripts/lib/qa-sandbox.js (so B's
// guard and main.js are the old ones), seeded with the same NESTED tags, sharing one
// temp cloud folder and P2P (the harness launches with P2P off; it is turned on
// through the Settings toggle's IPC, with a secret only these sandboxes share).
// Asserted from the data files + diagnostics: A ends flat with no clip lost, B keeps
// every tag, the history files stop changing, and B restarted on THIS build with its
// own files (history, settings, conflicts, sync-state.json) ends flat too.
// QA_PARENT_DIR = where the sandboxes and the cloud folder go (default os tmpdir).
async function runLegacyScenario() {
  const out = { scenario: 'legacy', ok: false };
  const oldRoot = process.env.QA_LEGACY_ROOT;
  if (!oldRoot || !fs.existsSync(path.join(oldRoot, 'main.js')) || !fs.existsSync(path.join(oldRoot, 'scripts', 'lib', 'qa-sandbox.js'))) {
    return { ...out, error: 'set QA_LEGACY_ROOT to a checkout of the old build (main.js + scripts/lib/qa-sandbox.js)' };
  }
  const harness = require('./lib/qa-sandbox');
  const oldHarness = require(path.join(oldRoot, 'scripts', 'lib', 'qa-sandbox.js'));
  const parentDir = process.env.QA_PARENT_DIR || os.tmpdir();
  const work = fs.mkdtempSync(path.join(parentDir, 'bc-two-legacy-'));
  const cloudDir = path.join(work, 'cloud');
  fs.mkdirSync(cloudDir, { recursive: true });
  const { check, results, summary } = harness.createChecks();
  const secret = crypto.randomBytes(32).toString('hex');
  const nowSec = Math.floor(Date.now() / 1000);

  // Seed: the same clips on both, plus a few only on each side. ts in seconds.
  const clip = (label, ageSec, pin) => { const it = textItem(`legacy ${label}`, nowSec - ageSec); if (pin) it.pin = pin; it.label = label; return it; };
  const S = [
    clip('S1 todo/forge (explicit groupsUpdatedAt)', 100, { groups: ['todo/forge'], groupsUpdatedAt: (nowSec - 100) * 1000, updatedAt: (nowSec - 100) * 1000 }),
    clip('S2 twoshot/support', 110, { groups: ['twoshot/support'] }),
    clip('S3 Notes (capital)', 120, { groups: ['Notes'] }),
    clip('S4 notes (lower)', 130, { groups: ['notes'] }),
    clip('S5 several', 140, { groups: ['todo/forge', 'twoshot/support', 'Notes', 'todo'] }),
    clip('S6 numpad 3 + todo/done', 150, { number: 3, groups: ['todo/done'] }),
    clip('S7 plain unpinned', 160, null),
    clip('S8 literal-slash target (untagged at seed)', 170, null),
  ];
  const A_ONLY = [clip('A1 only on new: todo/forge', 90, { groups: ['todo/forge'] })];
  const B_ONLY = [
    clip('B1 only on old: todo/forge (a retired name)', 80, { groups: ['todo/forge'] }),
    clip('B2 only on old: todo/newthing (a nested name A never had)', 70, { groups: ['todo/newthing'] }),
    clip('B3 only on old: Notes', 60, { groups: ['Notes'] }),
  ];
  const strip = (list) => list.map(({ label, ...rest }) => JSON.parse(JSON.stringify(rest))).sort((x, y) => y.ts - x.ts);
  const ALL = [...S, ...A_ONLY, ...B_ONLY];
  const label = new Map(ALL.map(c => [c.id, c.label]));
  const seedById = new Map(ALL.map(c => [c.id, c]));
  const S8 = S[7].id;
  const B2ID = B_ONLY[1].id;
  // Expected flat tag keys on a new-build device (stored spelling checked separately).
  const flatExpect = new Map([
    [S[0].id, ['todo', 'forge']], [S[1].id, ['twoshot', 'support']], [S[2].id, ['notes']], [S[3].id, ['notes']],
    [S[4].id, ['todo', 'forge', 'twoshot', 'support', 'notes']], [S[5].id, ['todo', 'done']], [S[6].id, []], [S[7].id, []],
    [A_ONLY[0].id, ['todo', 'forge']], [B_ONLY[0].id, ['todo', 'forge']], [B_ONLY[2].id, ['notes']],
  ]);
  const seedGroups = ['todo/forge', 'twoshot/support', 'Notes', 'notes', 'todo', 'todo/done'];
  const baseSettings = (deviceId, extraGroups = []) => ({
    p2p_secret: secret, p2p_device_id: deviceId, diagnostics_enabled: true, ai_access_enabled: false,
    sync_custom_paths: [cloudDir], surface_style: 'solid', groups: [...seedGroups, ...extraGroups],
  });

  const readJson = (file, fallback) => { for (let i = 0; i < 5; i++) { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { /* mid-rename */ } } return fallback; };
  const histOf = sb => readJson(path.join(sb.dataDir, 'clipboard-history.json'), []);
  const settingsOf = sb => readJson(path.join(sb.dataDir, 'clipboard-settings.json'), {});
  const groupsOf = it => (it && it.pin && Array.isArray(it.pin.groups) ? it.pin.groups : []);
  const keys = names => new Set(names.map(n => String(n).trim().toLowerCase()).filter(Boolean));
  const flatKeys = names => new Set(names.flatMap(n => String(n).split('/')).map(p => p.trim().toLowerCase()).filter(Boolean));
  const sameSet = (a, b) => a.size === b.size && [...a].every(x => b.has(x));
  const covers = (big, small) => [...small].every(x => big.has(x));
  const fileHash = file => { try { return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex').slice(0, 12); } catch { return 'missing'; } };
  const fileMtime = file => { try { return fs.statSync(file).mtimeMs; } catch { return 0; } };
  const journalCount = () => { let n = 0; try { for (const d of fs.readdirSync(path.join(cloudDir, 'sync'))) n += fs.readdirSync(path.join(cloudDir, 'sync', d)).length; } catch {} return n; };
  const errorsOf = sb => sb.diagnostics().filter(e => /error/.test(e.event)).map(e => `${e.event}: ${e.error || e.message || ''}`.slice(0, 160));
  const slashNames = (items, s) => ({
    clips: items.flatMap(it => groupsOf(it).filter(g => g.includes('/')).map(g => `${label.get(it.id) || it.id.slice(0, 12)} -> ${g}`)),
    groups: (s.groups || []).filter(g => g.includes('/')),
    shared: (s.groups_shared_with_ai || []).filter(g => g.includes('/')),
  });
  const enableP2P = async (sb) => {
    const popup = await sb.popup();
    await popup.waitFor('!!(window.api && window.api.setP2PEnabled)', 'popup api', 30000);
    return popup.eval('window.api.setP2PEnabled(true).then((s) => ({ enabled: s.enabled, running: s.running, port: s.port }))');
  };
  const waitUntil = async (fn, ms) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { const v = fn(); if (v) return Date.now() - t0; await sleep(250); } return null; };
  // ~60 s of samples: content changes (hash) and writes (mtime) per file, journal files
  // added, and merges that changed local history, per instance.
  const watchQuiet = async (name, files, instances, ms) => {
    const state = {};
    for (const [k, f] of Object.entries(files)) state[k] = { file: f, hash: fileHash(f), mtime: fileMtime(f), content_changes: 0, writes: 0 };
    const diagBefore = new Map(instances.map(([n, sb]) => [n, sb.diagnostics().length]));
    const journalsBefore = journalCount();
    const t0 = Date.now();
    while (Date.now() - t0 < ms) {
      await sleep(1000);
      for (const s of Object.values(state)) {
        const h = fileHash(s.file); const m = fileMtime(s.file);
        if (h !== s.hash) { s.content_changes += 1; s.hash = h; }
        if (m !== s.mtime) { s.writes += 1; s.mtime = m; }
      }
    }
    const merges = {};
    for (const [n, sb] of instances) {
      const fresh = sb.diagnostics().slice(diagBefore.get(n));
      merges[n] = {
        cloud_merges_changed: fresh.filter(e => e.event === 'sync.merge' && e.local_changed).length,
        delta_applies_changed: fresh.filter(e => e.event === 'sync.delta_apply' && e.local_changed).length,
        delta_applies: fresh.filter(e => e.event === 'sync.delta_apply').length,
        p2p_pushes: fresh.filter(e => e.event === 'p2p.push').length,
        journal_writes: fresh.filter(e => e.event === 'sync.journal.write').length,
      };
    }
    const files_ = Object.fromEntries(Object.entries(state).map(([k, s]) => [k, { content_changes: s.content_changes, writes: s.writes }]));
    return { name, seconds: Math.round((Date.now() - t0) / 1000), files: files_, journal_files_added: journalCount() - journalsBefore, merges };
  };
  // A normal quit; done = the app's own app.exit line (a pid probe on Windows still
  // answers while the harness holds the child's handle).
  const quitGracefully = async (sb) => {
    try { await sb.mainEval('(setTimeout(() => __qa.electron.app.quit(), 50), true)', { timeoutMs: 5000 }); } catch {}
    for (let i = 0; i < 100; i++) {
      const exit = sb.diagnostics().find(e => e.event === 'app.exit');
      if (exit) return { app_exit_code: exit.code, reason: exit.reason };
      await sleep(100);
    }
    return false;
  };

  let A = null; let B = null; let B2 = null; let bKeptDir = null;
  try {
    // ---- Phase 1: A on this build, B on the old build ------------------------------
    A = await harness.launch({ name: 'lgA', parentDir, settings: baseSettings(crypto.randomBytes(16).toString('hex')), history: strip([...S, ...A_ONLY]) });
    B = await oldHarness.launch({ name: 'lgB', parentDir, settings: baseSettings(crypto.randomBytes(16).toString('hex'), ['todo/newthing']), history: strip([...S, ...B_ONLY]) });
    out.dirs = { A: A.dir, B: B.dir, cloud: cloudDir };
    out.p2p_on = { A: await enableP2P(A), B: await enableP2P(B) };
    const t0 = Date.now();
    const hasAll = sb => { const ids = new Set(histOf(sb).map(it => it.id)); return ALL.every(c => ids.has(c.id)); };
    const convergedMs = await waitUntil(() => hasAll(A) && hasAll(B), 90000);
    check('phase 1: A (new) and B (old) both hold every seeded clip', convergedMs != null, `converged in ${convergedMs} ms, ${ALL.length} clips`);
    // Settle a few passes (the 30 s poll floor) before judging tags.
    await sleep(8000);

    const aH = histOf(A); const aS = settingsOf(A); const aById = new Map(aH.map(it => [it.id, it]));
    const bH = histOf(B); const bS = settingsOf(B); const bById = new Map(bH.map(it => [it.id, it]));
    const aMissing = ALL.filter(c => !aById.has(c.id)).map(c => c.label);
    const bMissing = ALL.filter(c => !bById.has(c.id)).map(c => c.label);
    check('phase 1: A lost no clip', aMissing.length === 0, `${ALL.length - aMissing.length}/${ALL.length} present${aMissing.length ? `; missing ${aMissing.join(', ')}` : ''}; A holds ${aH.length}`);
    check('phase 1: B lost no clip', bMissing.length === 0, `${ALL.length - bMissing.length}/${ALL.length} present${bMissing.length ? `; missing ${bMissing.join(', ')}` : ''}; B holds ${bH.length}`);
    const aSlash = slashNames(aH, aS);
    const aSlashRetired = aSlash.clips.filter(x => !/todo\/newthing$/.test(x));
    check('phase 1: A has no retired (seeded nested) name left anywhere', aSlashRetired.length === 0 && !aSlash.groups.some(g => g !== 'todo/newthing') && aSlash.shared.length === 0,
      `clips ${aSlashRetired.length}, settings.groups ${JSON.stringify(aSlash.groups)}, shared ${aSlash.shared.length}`);
    // A nested name the OLD device makes after A's cutover is one tag on A until that device
    // updates and retires it (phase 3): transitional by design, nothing else may carry a '/'.
    check('phase 1: the only "/" name on A is the one the old device made after the cutover', aSlash.clips.every(x => /todo\/newthing$/.test(x)) && aSlash.groups.every(g => g === 'todo/newthing'),
      `slash names on clips: ${JSON.stringify(aSlash.clips)}; settings.groups: ${JSON.stringify(aSlash.groups)}`);
    const aWrong = [];
    for (const [id, want] of flatExpect) {
      const got = keys(groupsOf(aById.get(id)));
      if (!sameSet(got, new Set(want))) aWrong.push(`${label.get(id)}: ${JSON.stringify([...got])} want ${JSON.stringify(want)}`);
    }
    check('phase 1: A holds the expected flat tags on every clip', aWrong.length === 0, aWrong.length ? aWrong.join(' | ') : `${flatExpect.size} clips exact`);
    const notesSpellings = [...new Set(aH.flatMap(it => groupsOf(it)).filter(g => g.toLowerCase() === 'notes'))];
    check('phase 1: A stores one spelling for Notes/notes ("notes")', notesSpellings.length === 1 && notesSpellings[0] === 'notes', JSON.stringify(notesSpellings));
    const splits = (aS.group_splits || []).map(r => r.name).sort();
    check('phase 1: A recorded the retired names in group_splits', ['todo/done', 'todo/forge', 'twoshot/support'].every(n => splits.includes(n)), JSON.stringify(splits));
    const aFlatten = A.diagnostics().filter(e => e.event === 'groups.flatten');
    out.a_flatten = aFlatten.map(e => ({ cutover: e.cutover, retired: e.retired, clips_changed: e.clips_changed, groups_before: e.groups_before, groups_after: e.groups_after, copy_path: e.copy_path ? 'yes' : '' }));
    check('phase 1: A cut over exactly once at start (groups.flatten cutover:true)', aFlatten.filter(e => e.cutover).length === 1,
      JSON.stringify(out.a_flatten));
    out.a_stragglers = A.diagnostics().filter(e => e.event === 'groups.flatten.straggler').map(e => ({ source: e.source, local_clips: e.local_clips }));
    out.a_straggler_events = out.a_stragglers.length;
    // B (old) must keep every tag it had: the old names literally, and every flat part.
    const bWrong = [];
    let bLiteralKept = 0; let bFlatKept = 0; let bTagged = 0;
    for (const c of [...S, ...B_ONLY]) {
      const want = groupsOf(c);
      if (!want.length) continue;
      bTagged += 1;
      const got = groupsOf(bById.get(c.id));
      const lit = covers(new Set(got), new Set(want));
      const flat = covers(flatKeys(got), flatKeys(want));
      if (lit) bLiteralKept += 1;
      if (flat) bFlatKept += 1;
      if (!lit || !flat) bWrong.push(`${c.label}: ${JSON.stringify(got)} seed ${JSON.stringify(want)}`);
    }
    out.b_tags = Object.fromEntries([...S, ...A_ONLY, ...B_ONLY].map(c => [c.label, groupsOf(bById.get(c.id))]));
    check('phase 1: B (old) kept every tag (old names literally + every flat part)', bWrong.length === 0,
      `${bLiteralKept}/${bTagged} literal, ${bFlatKept}/${bTagged} flat-equivalent${bWrong.length ? `; ${bWrong.join(' | ')}` : ''}`);
    const aOnB = groupsOf(bById.get(A_ONLY[0].id));
    check('phase 1: A-only clip reached B with its flat parts', covers(keys(aOnB), new Set(['todo', 'forge'])), JSON.stringify(aOnB));
    // No clock moved, no pin lost or added, the numpad key kept.
    const clockMoves = []; const pinFlips = [];
    for (const [who, byId] of [['A', aById], ['B', bById]]) {
      for (const c of ALL) {
        const it = byId.get(c.id);
        if (!it) continue;
        if (it.ts !== c.ts) clockMoves.push(`${who} ${c.label}: ts ${c.ts} -> ${it.ts}`);
        if (!!it.pin !== !!c.pin) pinFlips.push(`${who} ${c.label}: pinned ${!!c.pin} -> ${!!it.pin}`);
      }
    }
    check('phase 1: no clip clock moved (ts) on A or B', clockMoves.length === 0, clockMoves.length ? clockMoves.join(' | ') : `${ALL.length * 2} ts equal`);
    check('phase 1: no pin added or removed on A or B', pinFlips.length === 0, pinFlips.length ? pinFlips.join(' | ') : `${ALL.length * 2} pin states equal`);
    const nA = (aById.get(S[5].id) || {}).pin; const nB = (bById.get(S[5].id) || {}).pin;
    check('phase 1: numpad key 3 kept on both', !!nA && nA.number === 3 && !!nB && nB.number === 3, `A ${nA && nA.number}, B ${nB && nB.number}`);
    const p1Errors = { A: errorsOf(A), B: errorsOf(B) };
    check('phase 1: no error events in either diagnostics log', !p1Errors.A.length && !p1Errors.B.length, JSON.stringify(p1Errors).slice(0, 300));
    const sources = (sb) => { const m = {}; for (const e of sb.diagnostics().filter(x => x.event === 'sync.delta_apply' || x.event === 'sync.merge')) { const k = e.event === 'sync.merge' ? 'cloud-merge' : e.source; m[k] = (m[k] || 0) + 1; } return m; };
    out.phase1_transport = { A: sources(A), B: sources(B), A_saw_B: A.diagnostics().some(e => e.event === 'p2p.peer.seen'), B_saw_A: B.diagnostics().some(e => e.event === 'p2p.peer.seen') };
    check('phase 1: P2P paired both ways (p2p.peer.seen on A and B)', out.phase1_transport.A_saw_B && out.phase1_transport.B_saw_A, JSON.stringify(out.phase1_transport));

    // ---- Phase 1b: a NEW literal '/' tag made on A after its cutover ------------------
    const aItems = await A.historyState();
    const s8 = aItems.find(it => it.id === S8);
    const popupA = await A.popup();
    out.literal_assign = await popupA.eval(`window.api.groupAssign(${JSON.stringify(S8)}, 'AC/DC', ${JSON.stringify(s8 && s8.rev)})`);
    const litMs = await waitUntil(() => groupsOf(new Map(histOf(B).map(it => [it.id, it])).get(S8)).includes('AC/DC'), 60000);
    check('phase 1b: literal tag "AC/DC" made on A reaches old B unchanged', litMs != null, `assign ${JSON.stringify(out.literal_assign)}, arrived in ${litMs} ms`);

    // ---- Phase 2: no ping-pong ---------------------------------------------------------
    await sleep(5000);
    const q1 = await watchQuiet('A(new) + B(old)', {
      A_history: path.join(A.dataDir, 'clipboard-history.json'), B_history: path.join(B.dataDir, 'clipboard-history.json'),
      cloud_snapshot: path.join(cloudDir, 'clipboard-history.json'),
      A_settings: path.join(A.dataDir, 'clipboard-settings.json'), B_settings: path.join(B.dataDir, 'clipboard-settings.json'),
    }, [['A', A], ['B', B]], 62000);
    out.quiet_phase2 = q1;
    check('phase 2: history files stop changing (A, B, cloud snapshot; 62 s)', q1.files.A_history.content_changes === 0 && q1.files.B_history.content_changes === 0 && q1.files.cloud_snapshot.content_changes === 0,
      `content changes A ${q1.files.A_history.content_changes} (writes ${q1.files.A_history.writes}), B ${q1.files.B_history.content_changes} (writes ${q1.files.B_history.writes}), cloud ${q1.files.cloud_snapshot.content_changes} (writes ${q1.files.cloud_snapshot.writes}), journals +${q1.journal_files_added}, merges ${JSON.stringify(q1.merges)}`);
    check('phase 2: no merge changed local history during the window', Object.values(q1.merges).every(m => !m.cloud_merges_changed && !m.delta_applies_changed),
      JSON.stringify(q1.merges));

    // ---- Phase 3: B restarted on THIS build with its own files -------------------------
    const bLegacyDiag = B.diagnostics();
    out.b_quit_graceful = await quitGracefully(B);
    process.env.QA_KEEP = '1';
    try { await B.kill(); } finally { delete process.env.QA_KEEP; }
    bKeptDir = B.dir;
    const bData = B.dataDir;
    const blobDirs = ['clipboard-text', 'clipboard-html', 'clipboard-rtf'].filter(d => { try { return fs.readdirSync(path.join(bData, d)).length > 0; } catch { return false; } });
    if (blobDirs.length) throw new Error(`B has text blobs this restart does not carry: ${blobDirs.join(', ')}`);
    const bFinalHistory = readJson(path.join(bData, 'clipboard-history.json'), null);
    const bFinalSettings = readJson(path.join(bData, 'clipboard-settings.json'), null);
    if (!Array.isArray(bFinalHistory) || !bFinalSettings) throw new Error('could not read B\'s files after quit');
    const bConflicts = readJson(path.join(bData, 'clipboard-conflicts.json'), null);
    // The harness writes history, settings and conflicts; sync-state.json (change tracker
    // + P2P / journal cursors) and the images ride in through its images map ('..' = the
    // data dir itself).
    const carry = {};
    try { carry['../sync-state.json'] = fs.readFileSync(path.join(bData, 'sync-state.json')); } catch {}
    try { for (const f of fs.readdirSync(path.join(bData, 'clipboard-images'))) carry[f] = fs.readFileSync(path.join(bData, 'clipboard-images', f)); } catch {}
    out.b_carried = { history: bFinalHistory.length, settings_keys: Object.keys(bFinalSettings).length, conflicts: !!bConflicts, files: Object.keys(carry) };
    B2 = await harness.launch({ name: 'lgB2', parentDir, settings: bFinalSettings, history: bFinalHistory, ...(bConflicts ? { conflicts: bConflicts } : {}), images: carry });
    out.p2p_on.B2 = await enableP2P(B2);
    const sameTags = () => {
      const a = new Map(histOf(A).map(it => [it.id, it])); const b = new Map(histOf(B2).map(it => [it.id, it]));
      return ALL.every(c => a.has(c.id) && b.has(c.id) && sameSet(keys(groupsOf(a.get(c.id))), keys(groupsOf(b.get(c.id)))));
    };
    const flatMs = await waitUntil(() => slashNames(histOf(B2), settingsOf(B2)).clips.every(x => /AC\/DC$/.test(x)) && sameTags(), 90000);
    check('phase 3: B (now new) and A converge to the same tags on every clip, B with no retired "/" name on any clip', flatMs != null, `in ${flatMs} ms`);
    await sleep(8000);
    const a3 = histOf(A); const a3S = settingsOf(A); const a3ById = new Map(a3.map(it => [it.id, it]));
    const b3 = histOf(B2); const b3S = settingsOf(B2); const b3ById = new Map(b3.map(it => [it.id, it]));
    const b2Flatten = B2.diagnostics().filter(e => e.event === 'groups.flatten');
    out.b2_flatten = b2Flatten.map(e => ({ cutover: e.cutover, retired: e.retired, clips_changed: e.clips_changed, groups_before: e.groups_before, groups_after: e.groups_after }));
    check('phase 3: B cut over once on its first new-build start', b2Flatten.filter(e => e.cutover).length === 1, JSON.stringify(out.b2_flatten));
    // Every '/' left is A's plain 'AC/DC' (phase 1b): no retired name anywhere.
    const notLiteral = (x) => !/AC\/DC$/.test(x);
    const b3Slash = slashNames(b3, b3S); const a3Slash = slashNames(a3, a3S);
    check('phase 3: B ends with no retired "/" name (clips, settings.groups, share list)', !b3Slash.clips.filter(notLiteral).length && !b3Slash.groups.filter(notLiteral).length && !b3Slash.shared.length, JSON.stringify(b3Slash));
    check('phase 3: A ends with no retired "/" name (clips, settings.groups, share list)', !a3Slash.clips.filter(notLiteral).length && !a3Slash.groups.filter(notLiteral).length && !a3Slash.shared.length, JSON.stringify(a3Slash));
    const lostA = ALL.filter(c => !a3ById.has(c.id)).map(c => c.label); const lostB = ALL.filter(c => !b3ById.has(c.id)).map(c => c.label);
    check('phase 3: no clip lost on A or B', !lostA.length && !lostB.length, `A ${ALL.length - lostA.length}/${ALL.length}, B ${ALL.length - lostB.length}/${ALL.length}${lostA.length + lostB.length ? `; lost ${[...lostA, ...lostB].join(', ')}` : ''}`);
    const b3Wrong = [];
    for (const [id, want] of flatExpect) {
      if (id === S8) continue;
      const got = keys(groupsOf(b3ById.get(id)));
      if (!sameSet(got, new Set(want))) b3Wrong.push(`${label.get(id)}: ${JSON.stringify([...got])} want ${JSON.stringify(want)}`);
    }
    check('phase 3: B holds the expected flat tags (same as A had)', b3Wrong.length === 0, b3Wrong.length ? b3Wrong.join(' | ') : `${flatExpect.size - 1} clips exact`);
    const tagsLostOnB = [];
    for (const c of [...S, ...B_ONLY]) {
      const before = flatKeys(groupsOf(bById.get(c.id)));
      const after = keys(groupsOf(b3ById.get(c.id)));
      if (!covers(after, before)) tagsLostOnB.push(`${c.label}: ${JSON.stringify([...before])} -> ${JSON.stringify([...after])}`);
    }
    check('phase 3: every tag B had (as flat parts) survived its cutover', tagsLostOnB.length === 0, tagsLostOnB.length ? tagsLostOnB.join(' | ') : `${S.length + B_ONLY.length} clips`);
    const newthingA = groupsOf(a3ById.get(B2ID));
    check('phase 3: the old device\'s new nested name (todo/newthing) lands flat on A once B updates', sameSet(keys(newthingA), new Set(['todo', 'newthing'])), JSON.stringify(newthingA));
    const litA = groupsOf(a3ById.get(S8)); const litB = groupsOf(b3ById.get(S8));
    check('phase 3: A\'s post-cutover literal tag "AC/DC" survives B\'s later cutover', litA.includes('AC/DC') && litB.includes('AC/DC'),
      `A ${JSON.stringify(litA)}, B ${JSON.stringify(litB)}, A group_splits ${JSON.stringify((a3S.group_splits || []).map(r => r.name))}`);
    const partTags = (h, st) => [...new Set([...h.flatMap(groupsOf), ...(st.groups || [])])].filter(g => g === 'AC' || g === 'DC');
    check('phase 3: no stray AC / DC tags from the late split (on clips or listed)', !partTags(a3, a3S).length && !partTags(b3, b3S).length,
      `A ${JSON.stringify(partTags(a3, a3S))}, B ${JSON.stringify(partTags(b3, b3S))}, A literals ${JSON.stringify(a3S.group_literals || [])}`);
    const clock3 = [];
    for (const [who, byId] of [['A', a3ById], ['B', b3ById]]) for (const c of ALL) { const it = byId.get(c.id); if (it && it.ts !== c.ts) clock3.push(`${who} ${c.label}`); }
    check('phase 3: no clip clock moved (ts)', clock3.length === 0, clock3.join(' | ') || `${ALL.length * 2} ts equal`);
    const pin3 = [];
    for (const [who, byId] of [['A', a3ById], ['B', b3ById]]) for (const c of ALL) { const it = byId.get(c.id); const want = c.id === S8 || !!c.pin; if (it && !!it.pin !== want) pin3.push(`${who} ${c.label}: ${!!it.pin}`); }
    check('phase 3: pin states as expected (S8 pinned by its tag, S7 unpinned, rest kept)', pin3.length === 0, pin3.join(' | ') || `${ALL.length * 2} ok`);
    const n3A = (a3ById.get(S[5].id) || {}).pin; const n3B = (b3ById.get(S[5].id) || {}).pin;
    check('phase 3: numpad key 3 kept on both', !!n3A && n3A.number === 3 && !!n3B && n3B.number === 3, `A ${n3A && n3A.number}, B ${n3B && n3B.number}`);
    const q2 = await watchQuiet('A(new) + B(new)', {
      A_history: path.join(A.dataDir, 'clipboard-history.json'), B_history: path.join(B2.dataDir, 'clipboard-history.json'),
      cloud_snapshot: path.join(cloudDir, 'clipboard-history.json'),
    }, [['A', A], ['B', B2]], 62000);
    out.quiet_phase3 = q2;
    check('phase 3: history files stop changing (A, B, cloud snapshot; 62 s)', q2.files.A_history.content_changes === 0 && q2.files.B_history.content_changes === 0 && q2.files.cloud_snapshot.content_changes === 0,
      `content changes A ${q2.files.A_history.content_changes} (writes ${q2.files.A_history.writes}), B ${q2.files.B_history.content_changes} (writes ${q2.files.B_history.writes}), cloud ${q2.files.cloud_snapshot.content_changes} (writes ${q2.files.cloud_snapshot.writes}), journals +${q2.journal_files_added}, merges ${JSON.stringify(q2.merges)}`);
    const p3Errors = { A: errorsOf(A), B: errorsOf(B2), B_old_log: bLegacyDiag.filter(e => /error/.test(e.event)).length };
    check('phase 3: no error events (A, restarted B)', !p3Errors.A.length && !p3Errors.B.length, JSON.stringify(p3Errors).slice(0, 300));
    out.b2_stragglers = B2.diagnostics().filter(e => e.event === 'groups.flatten.straggler').map(e => ({ source: e.source, local_clips: e.local_clips }));
    out.final_tags = Object.fromEntries(ALL.map(c => [c.label, { A: groupsOf(a3ById.get(c.id)), B: groupsOf(b3ById.get(c.id)) }]));
    out.final_settings = { A: { groups: a3S.groups, group_splits: (a3S.group_splits || []).map(r => r.name) }, B: { groups: b3S.groups, group_splits: (b3S.group_splits || []).map(r => r.name) } };
    out.timeline_ms = Date.now() - t0;
  } catch (error) {
    out.error = error && (error.stack || error.message);
    check('scenario ran to the end', false, out.error);
  } finally {
    const fin = [];
    for (const sb of [A, B2]) if (sb) { try { fin.push(await sb.finish()); } catch (e) { fin.push({ ok: false, problems: [String(e && e.message)] }); } }
    if (B && !bKeptDir) { try { fin.push(await B.finish()); } catch (e) { fin.push({ ok: false, problems: [String(e && e.message)] }); } }
    if (bKeptDir) { try { fs.rmSync(bKeptDir, { recursive: true, force: true, maxRetries: 20, retryDelay: 150 }); } catch (e) { fin.push({ ok: false, problems: [`kept B dir: ${e.message}`] }); } }
    try { fs.rmSync(work, { recursive: true, force: true, maxRetries: 20, retryDelay: 150 }); } catch {}
    out.cleanup = { sandboxes_ok: fin.every(f => f.ok !== false), problems: fin.flatMap(f => f.problems || []), b_dir_removed: bKeptDir ? !fs.existsSync(bKeptDir) : null, work_removed: !fs.existsSync(work) };
  }
  out.checks = results;
  out.summary = summary();
  out.ok = out.summary.failed === 0;
  return out;
}

(async () => {
  const results = [];
  if (SCENARIO === 'legacy') results.push(await runLegacyScenario());
  if (SCENARIO === 'p2p' || SCENARIO === 'all') results.push(await runScenario('p2p', { bP2P: true }));
  if (SCENARIO === 'cloud' || SCENARIO === 'all') results.push(await runScenario('cloud', { bP2P: false }));
  console.log(JSON.stringify(results, null, 2));
  process.exit(results.every(r => r.ok) ? 0 : 1);
})();
