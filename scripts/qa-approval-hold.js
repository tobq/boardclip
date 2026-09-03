// node scripts/qa-approval-hold.js
// Sandbox proof for the approval prompt's hover pause + control-channel
// liveness, against the DEV checkout's code in an isolated instance:
//  1. hover -> countdown shows "paused" and stays put past the 5 s timeout
//     (main's safety timer is held too, the modal stays open)
//  2. leave -> the countdown resumes and the request times out normally
//  3. the waiting client survives all of that on keepalive frames
//  4. a client that gives up (keepalive off, short timeout) makes the modal
//     close by itself: decision client_gone, nothing executed
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const os = require('os');
const ROOT = path.join(__dirname, '..');
const SCRATCH = process.env.BOARDCLIP_QA_OUT || os.tmpdir();
const RPORT = 18452;
const tmp = fs.mkdtempSync(path.join(SCRATCH, 'bc-hold-'));
const dataDir = path.join(tmp, 'data'), udd = path.join(tmp, 'udd'), home = path.join(tmp, 'home');
for (const d of [dataDir, udd, home, path.join(home, 'AppData', 'Roaming'), path.join(home, 'AppData', 'Local')]) fs.mkdirSync(d, { recursive: true });
let providerPaths = [];
try { const accs = require(path.join(ROOT, 'lib', 'cloud-accounts'))(); providerPaths = (Array.isArray(accs) ? accs : []).map((a) => a && a.path).filter(Boolean); } catch {}
const txt = (text, ts) => ({ id: 'txt:' + crypto.createHash('sha256').update(text).digest('hex'), type: 'text', text, ts, pin: null });
const items = [txt('hover pause proof clip\nsecond line', 1788000000)];
fs.writeFileSync(path.join(dataDir, 'clipboard-settings.json'), JSON.stringify({ p2p_enabled: false, ai_access_enabled: true, groups: ['AI'], groups_shared_with_ai: ['AI'], diagnostics_enabled: true, sync_disabled_paths: providerPaths, surface_style: 'solid', theme_mode: 'dark', ai_approval_timeout_sec: 5 }, null, 2));
fs.writeFileSync(path.join(dataDir, 'clipboard-history.json'), JSON.stringify(items));
const discovery = path.join(tmp, 'mcp.json');
const child = spawn(path.join(ROOT, 'node_modules', 'electron', 'dist', 'electron.exe'), ['.', `--user-data-dir=${udd}`, `--remote-debugging-port=${RPORT}`], {
  cwd: ROOT,
  env: { ...process.env, BOARDCLIP_DATA_DIR: dataDir, BOARDCLIP_ISOLATED: '1', BOARDCLIP_MCP_DISCOVERY: discovery, BOARDCLIP_MCP_PIPE_TAG: 'qa' + process.pid, HOME: home, USERPROFILE: home, APPDATA: path.join(home, 'AppData', 'Roaming'), LOCALAPPDATA: path.join(home, 'AppData', 'Local'), XDG_CONFIG_HOME: path.join(home, '.config') },
  stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true,
});
let stderr = ''; child.stderr.on('data', (d) => { stderr += d.toString(); });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function listTargets() { try { const r = await fetch(`http://127.0.0.1:${RPORT}/json/list`); return await r.json(); } catch { return null; } }
function connect(wsUrl) {
  const ws = new WebSocket(wsUrl); let seq = 0; const pending = new Map();
  ws.addEventListener('message', (ev) => { const m = JSON.parse(ev.data); if (m.id && pending.has(m.id)) { const { res, rej } = pending.get(m.id); pending.delete(m.id); m.error ? rej(new Error(JSON.stringify(m.error))) : res(m.result); } });
  const send = (method, params) => new Promise((res, rej) => { const id = ++seq; pending.set(id, { res, rej }); ws.send(JSON.stringify({ id, method, params: params || {} })); setTimeout(() => { if (pending.has(id)) { pending.delete(id); rej(new Error('timeout ' + method)); } }, 20000); });
  return new Promise((res, rej) => { ws.addEventListener('open', () => res({ ws, send })); ws.addEventListener('error', () => rej(new Error('ws error'))); });
}
const controlClient = require(path.join(ROOT, 'lib', 'control-client.js'));
async function waitModal(seen) {
  for (let i = 0; i < 40; i++) { const t = await listTargets(); const m = (t || []).find((x) => x.type === 'page' && /mcp-approval\.html/.test(x.url || '') && !seen.has(x.id)); if (m) return m; await sleep(250); }
  return null;
}
async function modalGone(id) {
  for (let i = 0; i < 40; i++) { const t = await listTargets(); if (!(t || []).some((x) => x.id === id)) return true; await sleep(250); }
  return false;
}
const state = (cdp) => cdp.send('Runtime.evaluate', { expression: `JSON.stringify({ label: document.getElementById('countLabel').textContent, num: document.getElementById('countNum').textContent })`, returnByValue: true }).then((r) => JSON.parse(r.result.value));
(async () => {
  const out = { ok: false, steps: {} };
  try {
    let disco = null;
    for (let i = 0; i < 60 && !disco; i++) { try { disco = JSON.parse(fs.readFileSync(discovery, 'utf8')); } catch { await sleep(500); } }
    if (!disco) throw new Error('no discovery file ' + stderr.slice(-300));
    await sleep(1500);
    const seen = new Set();
    // ---- 1-3: hover pause with a keepalive client ----
    const t0 = Date.now();
    const req = controlClient.request('action', '/action', { tool: 'delete_clip', args: { id: items[0].id }, client: 'hold proof' }, { discovery: disco, timeoutMs: 15000 }).then(() => 'unexpected success', (e) => e.message);
    const modal = await waitModal(seen); if (!modal) throw new Error('no modal');
    seen.add(modal.id);
    const cdp = await connect(modal.webSocketDebuggerUrl); await cdp.send('Runtime.enable'); await cdp.send('Page.enable');
    for (let i = 0; i < 40; i++) { const r = await cdp.send('Runtime.evaluate', { expression: `document.getElementById('explain').textContent.length > 0`, returnByValue: true }); if (r.result.value) break; await sleep(150); }
    await sleep(300);
    out.steps.before = await state(cdp);
    // Real pointer entering the page (fires mouseenter on <html>).
    await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 200, y: 120 });
    await sleep(400);
    out.steps.hovered = await state(cdp);
    await sleep(8500); // well past the 5 s timeout (+3 s safety net)
    out.steps.stillOpenAfter8s = (await listTargets() || []).some((x) => x.id === modal.id);
    out.steps.whileHeld = await state(cdp);
    out.steps.clientStillWaiting = (await Promise.race([req, sleep(10).then(() => 'waiting')])) === 'waiting';
    // Pointer leaves: real leave = mouseleave on <html>.
    await cdp.send('Runtime.evaluate', { expression: `document.documentElement.dispatchEvent(new Event('mouseleave'))` });
    await sleep(1600);
    out.steps.resumed = await state(cdp);
    out.steps.resumedAtSec = Number(String(out.steps.resumed.num).replace('s', ''));
    cdp.ws.close();
    out.steps.result = await req;
    out.steps.totalMs = Date.now() - t0;
    await sleep(500);
    // ---- 4: client gives up -> prompt closes itself ----
    const req2 = controlClient.request('action', '/action', { tool: 'delete_clip', args: { id: items[0].id }, client: 'hold proof' }, { discovery: disco, timeoutMs: 2000, keepalive: false }).then(() => 'unexpected success', (e) => e.message);
    const modal2 = await waitModal(seen); if (!modal2) throw new Error('no second modal');
    seen.add(modal2.id);
    out.steps.clientGaveUp = await req2;
    const closedAt = Date.now();
    out.steps.modalClosedAfterClientGone = await modalGone(modal2.id);
    out.steps.closeLagMs = Date.now() - closedAt;
    await sleep(800);
    const diag = fs.readFileSync(path.join(dataDir, 'boardclip-diagnostics.jsonl'), 'utf8').split('\n').filter((l) => l.includes('"mcp.approval"')).map((l) => JSON.parse(l).decision);
    out.steps.decisions = diag;
    const hist = JSON.parse(fs.readFileSync(path.join(dataDir, 'clipboard-history.json'), 'utf8'));
    out.steps.clipStillThere = hist.some((i) => i.id === items[0].id);
    const s = out.steps;
    out.ok = /paused/i.test(s.hovered.label) && s.hovered.num === 'paused' && s.stillOpenAfter8s && s.whileHeld.num === 'paused' && s.clientStillWaiting
      && !/paused/i.test(s.resumed.label) && s.resumedAtSec >= 1 && s.resumedAtSec <= 5 && s.result === 'timed_out' && s.totalMs > 13000
      && s.clientGaveUp === 'control_timeout' && s.modalClosedAfterClientGone && s.decisions.includes('client_gone') && s.clipStillThere;
  } catch (e) { out.error = e.message; }
  finally { child.kill(); await sleep(1500); console.log(JSON.stringify(out, null, 2)); try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {} process.exit(out.ok ? 0 : 1); }
})();
