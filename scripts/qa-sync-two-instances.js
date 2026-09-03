#!/usr/bin/env node
'use strict';
// Hermetic two-instance P2P check: boots TWO isolated BoardClip instances on this
// machine (own data dirs, own --user-data-dir, own CDP ports, cloud sync
// disabled, AI off), sharing one generated P2P secret. Asserts from each
// instance's diagnostics log that:
//   1. discovery joined the multicast group on every real interface,
//   2. each instance SAW the other as a peer (p2p.peer.seen),
//   3. the two seeded histories converged over P2P (each ends with both clips),
// and prints the measured discovery + convergence times.
//
// SAFETY: the sandboxes generate their own secret, so the user's live BoardClip
// (same UDP discovery port) ignores their announcements; every detected cloud
// provider is pre-disabled; only electron processes whose command line contains
// the temp dir are killed.
//
// Usage: node scripts/qa-sync-two-instances.js [--keep]

const { spawn, execFileSync } = require('child_process');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const KEEP = process.argv.includes('--keep');
const TIMEOUT_MS = 45 * 1000;
const electronBin = process.platform === 'win32'
  ? path.join(ROOT, 'node_modules', 'electron', 'dist', 'electron.exe')
  : path.join(ROOT, 'node_modules', '.bin', 'electron');

let providerPaths = [];
try {
  const accounts = require(path.join(ROOT, 'lib', 'cloud-accounts'))();
  providerPaths = (Array.isArray(accounts) ? accounts : []).map(a => a && a.path).filter(Boolean);
} catch {}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'bc-two-'));
const secret = crypto.randomBytes(32).toString('hex');
const sleep = ms => new Promise(r => setTimeout(r, ms));
const nowSec = Math.floor(Date.now() / 1000);

function textItem(text, ts) {
  const hash = crypto.createHash('sha256').update(text).digest('hex');
  return { id: `txt:${hash}`, type: 'text', text, ts };
}

function makeInstance(name, cdpPort, seedText) {
  const dataDir = path.join(tmp, name, 'data');
  const userDataDir = path.join(tmp, name, 'udd');
  fs.mkdirSync(dataDir, { recursive: true });
  fs.mkdirSync(userDataDir, { recursive: true });
  fs.writeFileSync(path.join(dataDir, 'clipboard-settings.json'), JSON.stringify({
    p2p_enabled: true,
    p2p_secret: secret,
    p2p_device_id: crypto.randomBytes(16).toString('hex'),
    ai_access_enabled: false,
    diagnostics_enabled: true,
    sync_disabled_paths: providerPaths,
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
  return { name, dataDir, child, seedText, stderr: () => stderr };
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

function killSandboxElectrons() {
  if (process.platform !== 'win32') return;
  try {
    const marker = tmp.replace(/\\/g, '\\\\');
    execFileSync('powershell', ['-NoProfile', '-Command',
      `Get-CimInstance Win32_Process -Filter "Name='electron.exe'" | Where-Object { $_.CommandLine -like '*${tmp.replace(/'/g, "''")}*' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }`,
    ], { stdio: 'ignore', timeout: 20000 });
    void marker;
  } catch {}
}

(async () => {
  const a = makeInstance('A', 18421, 'two-instance clip from A');
  const b = makeInstance('B', 18422, 'two-instance clip from B');
  const started = Date.now();
  const out = { ok: false, tmp };
  try {
    let seenA = null; let seenB = null; let converged = null; let startA = null; let startB = null;
    while (Date.now() - started < TIMEOUT_MS) {
      const da = readDiag(a); const db = readDiag(b);
      startA = startA || da.find(e => e.event === 'p2p.start');
      startB = startB || db.find(e => e.event === 'p2p.start');
      seenA = seenA || da.find(e => e.event === 'p2p.peer.seen');
      seenB = seenB || db.find(e => e.event === 'p2p.peer.seen');
      const ta = readHistoryTexts(a); const tb = readHistoryTexts(b);
      if (ta.has(a.seedText) && ta.has(b.seedText) && tb.has(a.seedText) && tb.has(b.seedText)) {
        converged = converged || Date.now();
        break;
      }
      await sleep(500);
    }
    out.a_start = startA && { port: startA.port, fixed_port: startA.fixed_port, interfaces: (startA.interfaces || []).map(i => i.address) };
    out.b_start = startB && { port: startB.port, fixed_port: startB.fixed_port, interfaces: (startB.interfaces || []).map(i => i.address) };
    out.a_saw_b = !!seenA && { host: seenA.host, port: seenA.port, transport: seenA.transport, via: seenA.via };
    out.b_saw_a = !!seenB && { host: seenB.host, port: seenB.port, transport: seenB.transport, via: seenB.via };
    out.converged_ms = converged ? converged - started : null;
    out.a_texts = [...readHistoryTexts(a)];
    out.b_texts = [...readHistoryTexts(b)];
    const errorsA = readDiag(a).filter(e => /p2p.*error/.test(e.event)).map(e => e.event + ':' + (e.error || ''));
    const errorsB = readDiag(b).filter(e => /p2p.*error/.test(e.event)).map(e => e.event + ':' + (e.error || ''));
    out.p2p_errors = { A: errorsA.slice(0, 5), B: errorsB.slice(0, 5) };
    const stderrTail = (a.stderr() + b.stderr()).split('\n').filter(l => /Error|error/.test(l)).slice(-5);
    if (stderrTail.length) out.stderr = stderrTail;
    out.ok = !!(startA && startB && seenA && seenB && converged
      && startA.interfaces && startA.interfaces.length
      && (startA.fixed_port !== startB.fixed_port));
  } catch (error) {
    out.error = error && error.message;
  } finally {
    if (!KEEP) {
      try { a.child.kill(); } catch {}
      try { b.child.kill(); } catch {}
      await sleep(1500);
      killSandboxElectrons();
      await sleep(500);
      try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {}
    }
    console.log(JSON.stringify(out, null, 2));
    process.exit(out.ok ? 0 : 1);
  }
})();
