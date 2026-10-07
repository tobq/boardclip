'use strict';

// ONE harness for every QA script that drives a REAL BoardClip instance
// (qa-app-pentest, qa-approval-shot, qa-approval-hold, qa-popup-sandbox,
// qa-ui-shots). launch() starts a throwaway instance of THIS checkout:
// - everything under one fresh temp dir: data (BOARDCLIP_DATA_DIR), Chromium
//   profile (--user-data-dir), a fake HOME / APPDATA / LOCALAPPDATA (MCP client
//   configs, the Startup folder and ~/.boardclip land there, never in the real
//   profile), its own TEMP (orphaned-draft recovery and drag-out copies never
//   touch the real %TEMP%) and its own MCP discovery file + pipe tag;
// - BOARDCLIP_ISOLATED=1 (no cloud probing, keyboard hook or shortcuts), every
//   detected cloud provider pre-disabled as a second layer, p2p off;
// - free ports only: CDP and the main-process inspector both bind port 0, so
//   runs never collide with each other or the live app;
// - qa-sandbox-main.js preloaded before main.js: windows paint but stay cloaked
//   and never take the focus, no page can reach the OS clipboard (main's is
//   in-memory), pastes / drags / foreground switches / the auto-updater are
//   recorded, never performed.
// kill() stops ONLY processes whose command line contains the sandbox dir, then
// removes the dir; it also runs on exit and Ctrl+C. finish() is kill() plus the
// safety audit every script ends with (a dir left behind, a sweep that timed
// out or a window that could not be cloaked fails the run). A run that was
// hard-killed (no exit hook) is cleaned up by the next launch(). QA_KEEP=1
// keeps the dir.

const fs = require('fs');
const os = require('os');
const path = require('path');
const zlib = require('zlib');
const http = require('http');
const crypto = require('crypto');
const { spawn, spawnSync } = require('child_process');

const ROOT = path.join(__dirname, '..', '..');
const GUARD = path.join(__dirname, 'qa-sandbox-main.js');
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const sleepSync = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

async function waitFor(fn, label, timeoutMs = 30000, stepMs = 250) {
  const until = Date.now() + timeoutMs;
  let lastError = null;
  while (Date.now() < until) {
    try { const v = await fn(); if (v) return v; } catch (error) { lastError = error; }
    await sleep(stepMs);
  }
  throw new Error(`timeout waiting for ${label}${lastError ? ` (last error: ${String(lastError.message).slice(0, 160)})` : ''}`);
}

// --- CDP over the raw websocket (Node >= 21 global WebSocket) -----------------
function connect(wsUrl, { timeoutMs = 60000 } = {}) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl);
    const pending = new Map();
    const listeners = new Map();
    let seq = 0;
    let open = false;
    ws.addEventListener('message', (event) => {
      let msg;
      try { msg = JSON.parse(event.data); } catch { return; }
      if (msg.id && pending.has(msg.id)) {
        const p = pending.get(msg.id);
        pending.delete(msg.id);
        clearTimeout(p.timer);
        if (msg.error) p.reject(new Error(`${p.method}: ${msg.error.message || JSON.stringify(msg.error)}`));
        else p.resolve(msg.result);
      } else if (msg.method && listeners.has(msg.method)) {
        for (const fn of listeners.get(msg.method)) { try { fn(msg.params || {}); } catch {} }
      }
    });
    ws.addEventListener('close', () => {
      for (const p of pending.values()) { clearTimeout(p.timer); p.reject(new Error(`${p.method}: socket closed`)); }
      pending.clear();
    });
    ws.addEventListener('error', () => { if (!open) reject(new Error(`ws error ${wsUrl}`)); });
    ws.addEventListener('open', () => {
      open = true;
      resolve({
        send(method, params, opts) {
          return new Promise((res, rej) => {
            const id = ++seq;
            const ms = (opts && opts.timeoutMs) || timeoutMs;
            const timer = setTimeout(() => { if (pending.delete(id)) rej(new Error(`${method}: timeout after ${ms} ms`)); }, ms);
            pending.set(id, { resolve: res, reject: rej, timer, method });
            try { ws.send(JSON.stringify({ id, method, params: params || {} })); } catch (error) { pending.delete(id); clearTimeout(timer); rej(error); }
          });
        },
        on(method, fn) {
          if (!listeners.has(method)) listeners.set(method, new Set());
          listeners.get(method).add(fn);
          return () => listeners.get(method).delete(fn);
        },
        close() { try { ws.close(); } catch {} },
      });
    });
  });
}

async function evaluate(cdp, expression, opts) {
  const r = await cdp.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true }, opts);
  if (r.exceptionDetails) {
    const d = r.exceptionDetails;
    throw new Error(`eval failed: ${((d.exception || {}).description || d.text || '').slice(0, 600)}`);
  }
  return r.result ? r.result.value : undefined;
}

// A page session with the helpers every QA script repeats.
function pageApi(cdp, target) {
  const page = {
    target,
    id: target.id,
    url: target.url,
    send: cdp.send,
    on: cdp.on,
    close: cdp.close,
    eval: (expression, opts) => evaluate(cdp, expression, opts),
    waitFor: (expression, label, timeoutMs) => waitFor(() => evaluate(cdp, expression), label || expression.slice(0, 80), timeoutMs),
    async screenshot(file, opts) {
      const r = await cdp.send('Page.captureScreenshot', { format: 'png', ...(opts || {}) });
      const buf = Buffer.from(r.data, 'base64');
      if (file) {
        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.writeFileSync(file, buf);
      }
      return buf;
    },
    mouse: (type, x, y, extra) => cdp.send('Input.dispatchMouseEvent', { type, x, y, ...(extra || {}) }),
    // Centre of the first match, scrolled into view; null when absent.
    centerOf: (selector) => evaluate(cdp, `(() => {
      const el = document.querySelector(${JSON.stringify(selector)});
      if (!el) return null;
      el.scrollIntoView({ block: 'nearest' });
      const r = el.getBoundingClientRect();
      return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
    })()`),
    async hover(selector) {
      const c = await page.centerOf(selector);
      if (!c) throw new Error(`hover: no element ${selector}`);
      await page.mouse('mouseMoved', c.x, c.y);
      return c;
    },
    // A real (CDP-dispatched) press + release at the element's centre.
    async click(selector, { button = 'left', modifiers = 0 } = {}) {
      const c = await page.centerOf(selector);
      if (!c) throw new Error(`click: no element ${selector}`);
      await page.mouse('mouseMoved', c.x, c.y, { modifiers });
      await page.mouse('mousePressed', c.x, c.y, { button, buttons: 1, clickCount: 1, modifiers });
      await page.mouse('mouseReleased', c.x, c.y, { button, buttons: 0, clickCount: 1, modifiers });
      return c;
    },
    emulateTheme: (theme) => cdp.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: theme }] }),
    // Web fonts (the icon font comes from Google Fonts) loaded, capped: offline
    // runs still finish, with ligature names where icons would be.
    fontsReady: (timeoutMs = 10000) => evaluate(cdp, `Promise.race([
      (async () => {
        if ([...document.fonts].some((f) => /Material Symbols/.test(f.family))) await document.fonts.load('16px "Material Symbols Rounded"', 'star');
        await document.fonts.ready;
        return true;
      })(),
      new Promise((r) => setTimeout(() => r(false), ${timeoutMs})),
    ])`),
  };
  return page;
}

// --- Seed helpers -------------------------------------------------------------
// RGBA PNG; pixel(x, y) -> [r, g, b] (or [r, g, b, a]).
function png(width, height, pixel) {
  const stride = width * 4 + 1;
  const raw = Buffer.alloc(stride * height);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const p = pixel(x, y);
      const o = y * stride + 1 + x * 4;
      raw[o] = p[0]; raw[o + 1] = p[1]; raw[o + 2] = p[2]; raw[o + 3] = p.length > 3 ? p[3] : 255;
    }
  }
  const chunk = (type, data) => {
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
    const td = Buffer.concat([Buffer.from(type, 'ascii'), data]);
    const crc = Buffer.alloc(4); crc.writeUInt32BE(zlib.crc32(td) >>> 0);
    return Buffer.concat([len, td, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0); ihdr.writeUInt32BE(height, 4); ihdr[8] = 8; ihdr[9] = 6;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}
// The app's content addresses: text ids are sha256 keys, image files md5 names.
const txtId = (text) => `txt:${crypto.createHash('sha256').update(text).digest('hex')}`;
const imageName = (buf) => `${crypto.createHash('md5').update(buf).digest('hex')}.png`;

// PASS/FAIL lines + the closing "n/m checks passed" every check script prints.
function createChecks() {
  const results = [];
  const check = (name, ok, detail) => {
    results.push({ name, ok: !!ok, detail: detail == null ? '' : String(detail).slice(0, 200) });
    console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail != null && detail !== '' ? `  (${String(detail).slice(0, 160)})` : ''}`);
  };
  const summary = () => {
    const failed = results.filter((r) => !r.ok);
    console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
    if (failed.length) console.log('FAILED:', failed.map((f) => f.name).join(' | '));
    return { passed: results.length - failed.length, failed: failed.length, total: results.length };
  };
  return { check, results, summary };
}

// Detection probes every drive letter (seconds): once per process, shared by
// concurrent launches.
let providerPathsOnce = null;
function cloudProviderPaths() {
  if (!providerPathsOnce) {
    providerPathsOnce = (async () => {
      try {
        const accounts = await require(path.join(ROOT, 'lib', 'cloud-accounts'))();
        return (Array.isArray(accounts) ? accounts : []).map((a) => a && a.path).filter(Boolean);
      } catch { return []; }
    })();
  }
  return providerPathsOnce;
}

// Static file server for site/ (root-absolute URLs need a real origin).
const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png',
  '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp', '.ico': 'image/x-icon',
  '.woff': 'font/woff', '.woff2': 'font/woff2', '.ttf': 'font/ttf', '.mp4': 'video/mp4', '.webm': 'video/webm',
  '.txt': 'text/plain; charset=utf-8', '.xml': 'application/xml',
};
function startStaticServer(rootDir) {
  const base = path.resolve(rootDir);
  const server = http.createServer((req, res) => {
    let rel;
    try { rel = decodeURIComponent(new URL(req.url, 'http://x').pathname); } catch { res.writeHead(400); res.end(); return; }
    let file = path.resolve(base, `.${rel}`);
    if (file !== base && !file.startsWith(base + path.sep)) { res.writeHead(403); res.end(); return; }
    try { if (fs.statSync(file).isDirectory()) file = path.join(file, 'index.html'); } catch {}
    fs.readFile(file, (error, body) => {
      if (error) { res.writeHead(404, { 'content-type': 'text/plain' }); res.end('not found'); return; }
      res.writeHead(200, { 'content-type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream', 'cache-control': 'no-store' });
      res.end(body);
    });
  });
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      // closeAllConnections: a page's keep-alive socket would hold close() open.
      resolve({ port, url: `http://127.0.0.1:${port}/`, close: () => new Promise((r) => { server.close(() => r()); server.closeAllConnections(); }) });
    });
  });
}

// --- Process sweep: only command lines containing the sandbox dir --------------
function sweepSandboxProcesses(dir) {
  if (process.platform === 'win32') {
    // CIM (with a deadline: a wedged winmgmt hangs every query) in a job the
    // deadline can kill. The dir travels in an env var, never in a command line.
    const script = [
      '$d = $env:QA_SANDBOX_DIR',
      '$job = Start-Job -ArgumentList $d -ScriptBlock { param($d)',
      "  Get-CimInstance Win32_Process -Filter \"Name='electron.exe'\" |",
      "    Where-Object { $_.CommandLine -and $_.CommandLine.Replace('/', '\\').IndexOf($d, [StringComparison]::OrdinalIgnoreCase) -ge 0 } |",
      '    ForEach-Object { [string]$_.ProcessId } }',
      "if (-not (Wait-Job $job -Timeout 15)) { Remove-Job $job -Force; 'TIMEOUT'; exit 0 }",
      '$ids = @(Receive-Job $job); Remove-Job $job -Force',
      "foreach ($id in $ids) { try { Stop-Process -Id ([int]$id) -Force -ErrorAction Stop; \"KILLED $id\" } catch { \"GONE $id\" } }",
    ].join('\n');
    const r = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')], {
      env: { ...process.env, QA_SANDBOX_DIR: dir.replace(/\//g, '\\') }, encoding: 'utf8', timeout: 30000, windowsHide: true,
    });
    const out = String(r.stdout || '');
    return { killed: [...out.matchAll(/KILLED (\d+)/g)].map((m) => Number(m[1])), timedOut: /TIMEOUT/.test(out) || !!r.error };
  }
  const r = spawnSync('ps', ['-Ao', 'pid=,command='], { encoding: 'utf8', timeout: 10000 });
  const killed = [];
  for (const line of String(r.stdout || '').split('\n')) {
    const m = line.trim().match(/^(\d+)\s+(.*)$/);
    if (!m || Number(m[1]) === process.pid || !m[2].includes(dir) || !/electron/i.test(m[2])) continue;
    try { process.kill(Number(m[1]), 'SIGKILL'); killed.push(Number(m[1])); } catch {}
  }
  return { killed, timedOut: !!r.error };
}

function pidAlive(pid) {
  try { process.kill(pid, 0); return true; } catch (error) { return error.code === 'EPERM'; }
}

const live = new Set();
let hooksInstalled = false;
function installExitHooks() {
  if (hooksInstalled) return;
  hooksInstalled = true;
  process.on('exit', () => { for (const sb of [...live]) sb.killSync(); });
  for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
    try { process.on(signal, () => { for (const sb of [...live]) sb.killSync(); process.exit(130); }); } catch {}
  }
}

function readLog(file) { try { return fs.readFileSync(file, 'utf8'); } catch { return ''; } }

// A run killed from outside (TerminateProcess, `timeout`, a stall detector)
// never reaches its exit hook: its dir stays, and so may this checkout's
// boardclip.pid. Each sandbox dir names the harness process that owns it
// (OWNER_FILE); a dir whose owner is gone can get no new process, so its
// leftover processes are swept and it is removed. A dir with a live owner, a
// QA_KEEP marker or no owner file (not ours to judge) is left alone.
const OWNER_FILE = 'qa-owner.json';
const KEEP_FILE = 'qa-keep';
function pruneStaleSandboxes(parentDir) {
  let names = [];
  try { names = fs.readdirSync(parentDir).filter((n) => n.startsWith('bc-qa-')); } catch {}
  const pruned = [];
  for (const n of names) {
    const dir = path.join(parentDir, n);
    if (fs.existsSync(path.join(dir, KEEP_FILE))) continue;
    let owner;
    try { owner = JSON.parse(fs.readFileSync(path.join(dir, OWNER_FILE), 'utf8')); } catch { continue; }
    if (!owner || !Number.isInteger(owner.pid) || owner.pid === process.pid || pidAlive(owner.pid)) continue;
    sweepSandboxProcesses(dir);
    try { fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); pruned.push(n); } catch {}
  }
  try {
    const pidFile = path.join(ROOT, 'boardclip.pid');
    const rec = JSON.parse(fs.readFileSync(pidFile, 'utf8'));
    if (rec && Number.isInteger(rec.pid) && !pidAlive(rec.pid)) fs.unlinkSync(pidFile);
  } catch {}
  return pruned;
}

// --- launch ---------------------------------------------------------------------
// opts: name, theme ('dark'|'light'), settings (merged over the safe defaults),
// history (array written as clipboard-history.json), conflicts (object),
// images ({ fileName: Buffer } into clipboard-images), ai (AI access on, the
// 'AI' group shared), env (extra env), args (extra Electron switches),
// providers (override detected cloud paths), parentDir (default os.tmpdir()).
// The window surface is the product default unless settings say otherwise
// (screenshot scripts pass surface_style 'solid').
async function launch(opts = {}) {
  const name = String(opts.name || 'sandbox').replace(/[^a-zA-Z0-9_-]/g, '');
  const parentDir = opts.parentDir || os.tmpdir();
  pruneStaleSandboxes(parentDir);
  const dir = fs.mkdtempSync(path.join(parentDir, `bc-qa-${name}-`));
  const dataDir = path.join(dir, 'data');
  const userDataDir = path.join(dir, 'udd');
  const home = path.join(dir, 'home');
  const appData = path.join(home, 'AppData', 'Roaming');
  const localAppData = path.join(home, 'AppData', 'Local');
  const tempDir = path.join(dir, 'tmp');
  const theme = opts.theme || 'dark';
  let settings;
  try {
    fs.writeFileSync(path.join(dir, OWNER_FILE), JSON.stringify({ pid: process.pid, startedAt: Date.now() }));
    const providers = opts.providers || await cloudProviderPaths();
    for (const d of [path.join(dataDir, 'clipboard-images'), userDataDir, appData, localAppData, path.join(home, '.config'), tempDir]) fs.mkdirSync(d, { recursive: true });
    const given = opts.settings || {};
    settings = {
      theme_mode: theme,
      diagnostics_enabled: false,
      ai_access_enabled: !!opts.ai,
      ...(opts.ai ? { groups_shared_with_ai: ['AI'], ai_approval_timeout_sec: 120 } : {}),
      ...given,
      // Never overridable: no sync to a real provider, no p2p with real devices.
      sync_disabled_paths: [...new Set([...providers, ...(given.sync_disabled_paths || [])])],
      p2p_enabled: false,
    };
    fs.writeFileSync(path.join(dataDir, 'clipboard-settings.json'), JSON.stringify(settings, null, 2));
    if (opts.history) fs.writeFileSync(path.join(dataDir, 'clipboard-history.json'), JSON.stringify(opts.history));
    if (opts.conflicts) fs.writeFileSync(path.join(dataDir, 'clipboard-conflicts.json'), JSON.stringify(opts.conflicts, null, 2));
    for (const [file, buf] of Object.entries(opts.images || {})) fs.writeFileSync(path.join(dataDir, 'clipboard-images', file), buf);
  } catch (error) {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
    throw error;
  }

  const discoveryPath = path.join(dir, 'mcp.json');
  const logPath = path.join(dir, 'app.log');
  // opts.env first: the isolation below is never overridable.
  const env = {
    ...process.env,
    ...(opts.env || {}),
    BOARDCLIP_DATA_DIR: dataDir,
    BOARDCLIP_ISOLATED: '1',
    BOARDCLIP_QA_SANDBOX: dir,
    BOARDCLIP_MCP_DISCOVERY: discoveryPath,
    BOARDCLIP_MCP_PIPE_TAG: `qa${process.pid}${crypto.randomBytes(3).toString('hex')}`,
    HOME: home, USERPROFILE: home, APPDATA: appData, LOCALAPPDATA: localAppData, XDG_CONFIG_HOME: path.join(home, '.config'),
    TEMP: tempDir, TMP: tempDir, TMPDIR: tempDir,
  };
  delete env.ELECTRON_RUN_AS_NODE; // set in an MCP helper's env: Electron would run as plain node
  const electronBin = require(path.join(ROOT, 'node_modules', 'electron'));
  const logFd = fs.openSync(logPath, 'a');
  const args = ['-r', GUARD, '.', `--user-data-dir=${userDataDir}`, '--remote-debugging-port=0', '--inspect=127.0.0.1:0', ...(opts.args || [])];
  const child = spawn(electronBin, args, { cwd: ROOT, env, windowsHide: true, stdio: ['ignore', logFd, logFd] });
  fs.closeSync(logFd);
  let exited = null;
  child.on('exit', (code, signal) => { exited = { code, signal }; });
  child.on('error', (error) => { exited = { error: error.message }; });

  const pages = new Set();
  const seen = new Set();
  let main = null;
  let killed = false;
  let popupPage = null;

  const sb = {
    dir, dataDir, userDataDir, home, discoveryPath, logPath, pid: child.pid, theme, settings, cdpPort: null,
    log: () => readLog(logPath),
    killSync() {
      if (killed) return;
      killed = true;
      live.delete(sb);
      for (const p of pages) p.close();
      if (main) main.close();
      // Only while the child has not exited: after its exit Node has closed the
      // process handle and Windows may already have reused the pid. child.kill()
      // goes through that retained handle, never the bare pid.
      if (!exited && child.exitCode === null && child.signalCode === null) {
        try { child.kill(); } catch {}
        for (let i = 0; i < 40 && pidAlive(child.pid); i += 1) sleepSync(100);
      }
      sb.swept = sweepSandboxProcesses(dir);
      // The app writes this checkout's boardclip.pid; drop it only if it is ours.
      try {
        const pidFile = path.join(ROOT, 'boardclip.pid');
        if (JSON.parse(fs.readFileSync(pidFile, 'utf8')).pid === child.pid) fs.unlinkSync(pidFile);
      } catch {}
      if (process.env.QA_KEEP === '1') {
        try { fs.writeFileSync(path.join(dir, KEEP_FILE), ''); } catch {}
        console.error(`QA_KEEP: sandbox kept at ${dir}`);
        return;
      }
      try { fs.rmSync(dir, { recursive: true, force: true, maxRetries: 20, retryDelay: 150 }); } catch (error) { sb.cleanupError = error.message; }
    },
    async kill() { sb.killSync(); return { swept: sb.swept, removed: !fs.existsSync(dir), error: sb.cleanupError || null }; },
    // kill() + the safety audit every script ends with. problems (printed as
    // "QA SAFETY:" lines) make ok false: the dir was left behind, the process
    // sweep timed out, or a window could not be cloaked.
    async finish() {
      let events = [];
      if (main && !killed) { try { events = await evaluate(main, '__qa.events', { timeoutMs: 5000 }); } catch {} }
      const k = await sb.kill();
      const problems = [];
      if (!k.removed && process.env.QA_KEEP !== '1') problems.push(`sandbox dir not removed: ${dir}${k.error ? ` (${k.error})` : ''}`);
      if (k.swept && k.swept.timedOut) problems.push('the leftover-process sweep timed out');
      const cloak = (events || []).filter((e) => e.type === 'cloak_failed');
      if (cloak.length) problems.push(`${cloak.length} window(s) could not be cloaked (hidden by opacity instead): ${JSON.stringify(cloak[0])}`);
      for (const problem of problems) console.error(`QA SAFETY: ${problem}`);
      return { ...k, problems, ok: problems.length === 0 };
    },
    async targets() {
      try { return await (await fetch(`http://127.0.0.1:${sb.cdpPort}/json/list`, { signal: AbortSignal.timeout(5000) })).json(); } catch { return []; }
    },
    // Connects to the first page target whose URL matches `re` (and, with
    // fresh, that no earlier page() call returned; never one in `exclude`):
    // Page + Runtime enabled. focus: emulate page focus (focus styles and
    // :focus-visible without OS focus). theme: emulate prefers-color-scheme.
    async page(re, { label, timeoutMs = 30000, fresh = true, exclude = null, focus = false, theme: mediaTheme } = {}) {
      const t = await waitFor(async () => (await sb.targets()).find((x) => x.type === 'page' && re.test(x.url || '')
        && !(fresh && seen.has(x.id)) && !(exclude && exclude.has(x.id))), label || String(re), timeoutMs);
      seen.add(t.id);
      const cdp = await connect(t.webSocketDebuggerUrl);
      pages.add(cdp);
      await cdp.send('Page.enable');
      await cdp.send('Runtime.enable');
      const page = pageApi(cdp, t);
      if (focus) await cdp.send('Emulation.setFocusEmulationEnabled', { enabled: true }).catch(() => {});
      if (mediaTheme) await page.emulateTheme(mediaTheme).catch(() => {});
      return page;
    },
    // The page of the window `trigger` opens: targets that existed before it ran
    // never match, so a window left over from an earlier step cannot.
    async newPage(re, trigger, opts) {
      const before = new Set((await sb.targets()).map((t) => t.id));
      const result = await trigger();
      const page = await sb.page(re, { ...(opts || {}), exclude: before });
      page.triggerResult = result;
      return page;
    },
    // The popup renderer (index.html), connected once and reused.
    async popup(opts) {
      if (!popupPage) popupPage = await sb.page(/index\.html/, { label: 'popup', fresh: false, ...(opts || {}) });
      return popupPage;
    },
    // Opens the popup through the app's own path (a second launch shows it),
    // so it is laid out and painting as when the user opens it, cloaked.
    async openPopup(opts) {
      const isOpen = `__qa.electron.BrowserWindow.getAllWindows().some((w) => /index\\.html/.test(w.webContents.getURL()) && w.isVisible())`;
      if (!(await evaluate(main, isOpen))) await evaluate(main, `(__qa.electron.app.emit('second-instance', {}, [], process.cwd()), true)`);
      await waitFor(() => evaluate(main, isOpen), 'popup open', 15000);
      return sb.popup(opts);
    },
    // Full history as the renderer sees it (each item stamped with its rev).
    async historyState() {
      const p = await sb.popup();
      await p.waitFor('!!(window.api && window.api.getHistoryState)', 'popup api');
      return (await p.eval('window.api.getHistoryState()')).items;
    },
    // Evaluate in the MAIN process; globalThis.__qa = { require, electron,
    // events, clipboard, ... } (see qa-sandbox-main.js).
    mainEval: (expression, o) => evaluate(main, expression, o),
    events: () => evaluate(main, '__qa.events'),
    // Opens a URL in a new (cloaked) sandbox window and returns its page.
    async openWindow(url, { width = 1280, height = 900, theme: mediaTheme, focus = false } = {}) {
      const escaped = url.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      return sb.newPage(new RegExp(`^${escaped}`), () => evaluate(main, `(() => {
        const w = new __qa.electron.BrowserWindow({ width: ${width}, height: ${height}, useContentSize: true, show: false, webPreferences: { backgroundThrottling: false } });
        w.loadURL(${JSON.stringify(url)});
        w.show();
        return true;
      })()`), { label: url, theme: mediaTheme, focus });
    },
    async discovery(timeoutMs = 30000) {
      return waitFor(() => { try { return JSON.parse(fs.readFileSync(discoveryPath, 'utf8')); } catch { return null; } }, 'MCP discovery file', timeoutMs);
    },
    // One MCP action through the control channel, as an AI client sends it.
    async mcp(tool, args, { client = 'QA sandbox', timeoutMs = 60000, keepalive } = {}) {
      const controlClient = require(path.join(ROOT, 'lib', 'control-client.js'));
      const discovery = await sb.discovery();
      return controlClient.request('action', '/action', { tool, args, client }, { discovery, timeoutMs, ...(keepalive === undefined ? {} : { keepalive }) });
    },
    diagnostics() {
      try {
        return fs.readFileSync(path.join(dataDir, 'boardclip-diagnostics.jsonl'), 'utf8').split('\n').filter(Boolean)
          .map((line) => { try { return JSON.parse(line); } catch { return null; } }).filter(Boolean);
      } catch { return []; }
    },
  };
  live.add(sb);
  installExitHooks();

  try {
    const alive = () => { if (exited) throw new Error(`sandbox exited early ${JSON.stringify(exited)}: ${readLog(logPath).slice(-600)}`); };
    sb.cdpPort = await waitFor(() => {
      alive();
      const fromFile = (() => { try { return Number(fs.readFileSync(path.join(userDataDir, 'DevToolsActivePort'), 'utf8').split('\n')[0]); } catch { return 0; } })();
      if (fromFile) return fromFile;
      const m = readLog(logPath).match(/DevTools listening on ws:\/\/127\.0\.0\.1:(\d+)\//);
      return m ? Number(m[1]) : 0;
    }, 'CDP port', 30000, 150);
    const inspectorUrl = await waitFor(() => { alive(); const m = readLog(logPath).match(/Debugger listening on (ws:\/\/\S+)/); return m && m[1]; }, 'main inspector', 30000, 150);
    main = await connect(inspectorUrl);
    await waitFor(async () => { alive(); return evaluate(main, '!!(globalThis.__qa && __qa.electron.app.isReady() && __qa.selfCheck().mainLoaded)'); }, 'app ready', 30000);
    const guard = await evaluate(main, '__qa.selfCheck()');
    if (!guard.ok) throw new Error(`sandbox guard not effective (main.js would run unpatched): ${JSON.stringify(guard)}`);
  } catch (error) {
    sb.killSync();
    throw error;
  }
  return sb;
}

module.exports = {
  ROOT, sleep, waitFor, connect, evaluate, launch, png, txtId, imageName, createChecks, cloudProviderPaths, startStaticServer,
};
