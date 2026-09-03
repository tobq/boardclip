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
// Usage: node scripts/qa-sync-two-instances.js [p2p|cloud|all] [--keep]

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
    const r = await cdp.send('Runtime.evaluate', { expression: `window.api.pin(${JSON.stringify(id)}).then(() => 'pinned')`, awaitPromise: true, returnByValue: true });
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

(async () => {
  const results = [];
  if (SCENARIO === 'p2p' || SCENARIO === 'all') results.push(await runScenario('p2p', { bP2P: true }));
  if (SCENARIO === 'cloud' || SCENARIO === 'all') results.push(await runScenario('cloud', { bP2P: false }));
  console.log(JSON.stringify(results, null, 2));
  process.exit(results.every(r => r.ok) ? 0 : 1);
})();
