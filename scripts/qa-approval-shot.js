// node scripts/qa-approval-shot.js  (writes approval-<tool>.png into BOARDCLIP_QA_OUT or the OS temp dir)
// Screenshot the redesigned AI-action approval modal for three actions in an
// isolated sandbox: assign_group (add), delete_clip, edit_clip (replace).
// The sandbox has AI access on, its own discovery file + pipe tag (so it does
// not collide with the live app), and a fake HOME so the MCP registrar never
// touches real client configs.
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');
const ROOT = path.join(__dirname, '..');
const SCRATCH = process.env.BOARDCLIP_QA_OUT || os.tmpdir();
const RPORT = 18451;
const tmp = fs.mkdtempSync(path.join(SCRATCH, 'bc-appr-'));
const dataDir = path.join(tmp, 'data'), udd = path.join(tmp, 'udd'), home = path.join(tmp, 'home');
for (const d of [dataDir, udd, home, path.join(home, 'AppData', 'Roaming'), path.join(home, 'AppData', 'Local')]) fs.mkdirSync(d, { recursive: true });
let providerPaths = [];
try { const accs = require(path.join(ROOT, 'lib', 'cloud-accounts'))(); providerPaths = (Array.isArray(accs) ? accs : []).map((a) => a && a.path).filter(Boolean); } catch {}
const crypto = require('crypto');
const txt = (text, ts, pin) => ({ id: 'txt:' + crypto.createHash('sha256').update(text).digest('hex'), type: 'text', text, ts, pin: pin || null });
const NOTE = 'impl new scoped accounts/api providers - API | Account scope keys\n\nclaude API fallback becomes api which you can setup a forwarded key for\n\nrotate keys per workspace';
const items = [txt(NOTE, 1788000000, null), txt('a short shared clip', 1788000100, { groups: ['AI'] })];
fs.writeFileSync(path.join(dataDir, 'clipboard-settings.json'), JSON.stringify({ p2p_enabled: false, ai_access_enabled: true, groups: ['AI', 'todo/claude-proxy'], groups_shared_with_ai: ['AI'], diagnostics_enabled: true, sync_disabled_paths: providerPaths, surface_style: 'solid', theme_mode: 'dark', ai_approval_timeout_sec: 60 }, null, 2));
fs.writeFileSync(path.join(dataDir, 'clipboard-history.json'), JSON.stringify(items));
const discovery = path.join(tmp, 'mcp.json');
const child = spawn(path.join(ROOT, 'node_modules', 'electron', 'dist', 'electron.exe'), ['.', `--user-data-dir=${udd}`, `--remote-debugging-port=${RPORT}`], {
  cwd: ROOT,
  env: { ...process.env, BOARDCLIP_DATA_DIR: dataDir, BOARDCLIP_ISOLATED: '1', BOARDCLIP_MCP_DISCOVERY: discovery, BOARDCLIP_MCP_PIPE_TAG: 'qa' + process.pid, HOME: home, USERPROFILE: home, APPDATA: path.join(home, 'AppData', 'Roaming'), LOCALAPPDATA: path.join(home, 'AppData', 'Local'), XDG_CONFIG_HOME: path.join(home, '.config') },
  stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true,
});
let stderr = ''; child.stderr.on('data', (d) => { stderr += d.toString(); });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function listTargets(port) { try { const r = await fetch(`http://127.0.0.1:${port}/json/list`); return await r.json(); } catch { return null; } }
function connect(wsUrl) {
  const ws = new WebSocket(wsUrl); let seq = 0; const pending = new Map();
  ws.addEventListener('message', (ev) => { const m = JSON.parse(ev.data); if (m.id && pending.has(m.id)) { const { res, rej } = pending.get(m.id); pending.delete(m.id); m.error ? rej(new Error(JSON.stringify(m.error))) : res(m.result); } });
  const send = (method, params) => new Promise((res, rej) => { const id = ++seq; pending.set(id, { res, rej }); ws.send(JSON.stringify({ id, method, params: params || {} })); setTimeout(() => { if (pending.has(id)) { pending.delete(id); rej(new Error('timeout ' + method)); } }, 20000); });
  return new Promise((res, rej) => { ws.addEventListener('open', () => res({ ws, send })); ws.addEventListener('error', () => rej(new Error('ws error'))); });
}
const controlClient = require(path.join(ROOT, 'lib', 'control-client.js'));
(async () => {
  const out = { ok: false, shots: [] };
  try {
    let disco = null;
    for (let i = 0; i < 60 && !disco; i++) { try { disco = JSON.parse(fs.readFileSync(discovery, 'utf8')); } catch { await sleep(500); } }
    if (!disco) throw new Error('no discovery file ' + stderr.slice(-300));
    await sleep(1500);
    const cases = [
      ['assign_group', { id: items[0].id, group: 'todo/claude-proxy' }],
      ['delete_clip', { id: items[0].id }],
      ['edit_clip', { id: items[0].id, text: NOTE + '\n\nalso: audit key rotation' }],
    ];
    const seen = new Set();
    for (const [tool, args] of cases) {
      const req = controlClient.request('action', '/action', { tool, args, client: 'Claude (dedupe of pure duplicate clips)' }, { discovery: disco, timeoutMs: 30000 }).catch((e) => ({ error: e.message }));
      let modal = null;
      for (let i = 0; i < 40 && !modal; i++) { const t = await listTargets(RPORT); modal = (t || []).find((x) => x.type === 'page' && /mcp-approval\.html/.test(x.url || '') && !seen.has(x.id)); if (!modal) await sleep(250); }
      if (!modal) throw new Error('no modal for ' + tool);
      seen.add(modal.id);
      const cdp = await connect(modal.webSocketDebuggerUrl); await cdp.send('Runtime.enable'); await cdp.send('Page.enable');
      for (let i = 0; i < 40; i++) { const r = await cdp.send('Runtime.evaluate', { expression: `document.getElementById('explain').textContent.length > 0`, returnByValue: true }); if (r.result.value) break; await sleep(150); }
      await sleep(500);
      const state = (await cdp.send('Runtime.evaluate', { expression: `JSON.stringify({ title: document.getElementById('title').textContent, explain: document.getElementById('explain').textContent, why: document.getElementById('why').textContent, facts: [...document.querySelectorAll('#facts dt, #facts dd')].map(e => e.textContent), label: document.getElementById('detailLabel').textContent, hint: document.getElementById('hint').textContent })`, returnByValue: true })).result.value;
      const shot = await cdp.send('Page.captureScreenshot', { format: 'png' });
      const file = path.join(SCRATCH, `approval-${tool}.png`);
      fs.writeFileSync(file, Buffer.from(shot.data, 'base64'));
      out.shots.push({ tool, file, state: JSON.parse(state) });
      await cdp.send('Runtime.evaluate', { expression: `document.getElementById('deny').click()` });
      cdp.ws.close();
      const r = await req;
      out.shots[out.shots.length - 1].result = r && r.error ? r.error : 'unexpected success';
      await sleep(600);
    }
    out.ok = out.shots.length === 3 && out.shots.every((s) => /denied/i.test(String(s.result)) && s.state.explain.length > 40);
  } catch (e) { out.error = e.message; }
  finally { child.kill(); await sleep(1500); console.log(JSON.stringify(out, null, 2)); try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {} process.exit(out.ok ? 0 : 1); }
})();
