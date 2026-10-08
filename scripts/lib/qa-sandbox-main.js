'use strict';

// Main-process guard for a QA sandbox. scripts/lib/qa-sandbox.js preloads it
// with `electron -r <this file> .`, so it runs BEFORE main.js: no window, poll,
// paste or update can race it. In the sandbox:
// - every window is shown CLOAKED (Windows: DWM cloak + no-activate; macOS, or
//   a window Windows could not cloak: transparent + click-through) and nothing
//   ever takes the focus. Windows still paint, so CDP screenshots and input
//   work, but nothing appears on the desktop and the user's keystrokes never
//   land in a sandbox window. window.open never makes a window (Electron
//   creates those already shown, before they could be cloaked);
// - the clipboard: main's electron.clipboard (and the native Windows reads the
//   capture path makes) is an in-memory fake; renderer pages, which reach the
//   OS clipboard through Chromium itself, get the clipboard permissions denied,
//   navigator.clipboard / execCommand copy-cut-paste stubbed in their main
//   world (qa-sandbox-page.js) and the copy / cut / paste keys blocked;
// - pastes, foreground switches, drags out, shell opens, native dialogs,
//   notifications, login items and the auto-updater (it would git pull this
//   checkout and relaunch it) are recorded, never performed. (main.js itself
//   puts no tray icon up and installs no keyboard hook when isolated.)
// Blocked actions land in globalThis.__qa.events for assertions; __qa also
// carries require / electron / the fake clipboard for the harness's main eval.

const path = require('path');
const childProcess = require('child_process');
const EventEmitter = require('events');
const electron = require('electron');

if (process.env.BOARDCLIP_ISOLATED !== '1' || !process.env.BOARDCLIP_QA_SANDBOX) {
  throw new Error('qa-sandbox-main: refusing to load outside an isolated QA sandbox');
}

const { app, BrowserWindow, clipboard, nativeImage, shell, dialog, Notification } = electron;
// main.js is loaded from the app path the harness passes as `.` (= cwd), so
// resolving lib/ from cwd gives the SAME module-cache keys main.js gets. A copy
// under another spelling of the path would leave main.js unpatched; selfCheck()
// below lets the harness prove it did not happen.
const ROOT = process.cwd();
const lib = (name) => require(path.join(ROOT, 'lib', name));
const IS_WIN = process.platform === 'win32';

const events = [];
function record(type, detail) {
  if (events.length < 1000) events.push({ type, at: Date.now(), ...(detail || {}) });
}

// --- Windows: cloaked, never activated ---------------------------------------
const dwm = IS_WIN ? lib('windows-dwm.js') : null;
const setParked = dwm ? dwm.setParked : null;
// The app uncloaks the popup to open it; in the sandbox it stays cloaked.
if (dwm) dwm.setParked = (win, _parked, opts) => setParked(win, true, opts);

const proto = BrowserWindow.prototype;
const nativeShowInactive = proto.showInactive;
const nativeSetOpacity = proto.setOpacity;
const nativeSetIgnoreMouseEvents = proto.setIgnoreMouseEvents;
// Windows concealed by opacity stay transparent + click-through for good.
const transparent = new WeakSet();
function concealByOpacity(win) {
  transparent.add(win);
  nativeSetOpacity.call(win, 0);
  nativeSetIgnoreMouseEvents.call(win, true);
}
function conceal(win) {
  if (IS_WIN) {
    const result = setParked(win, true);
    // Fail closed: the window is about to be shown either way, so one the DWM
    // could not cloak goes transparent + click-through instead, and the run
    // fails on the recorded event (qa-sandbox.js finish()).
    if (!result.ok) { record('cloak_failed', result); concealByOpacity(win); }
  } else {
    concealByOpacity(win);
  }
  try { win.setSkipTaskbar(true); } catch {}
}
// The popup's open fade sets a layered alpha natively (not through setOpacity)
// and then clears it: never on a window concealed by opacity, which that would
// put back on screen. Cloaked windows fade for real (nothing is drawn).
if (dwm) {
  for (const name of ['setWindowAlpha', 'clearLayered']) {
    const nativeFn = dwm[name];
    dwm[name] = (win, ...rest) => (transparent.has(win) ? { ok: false, reason: 'qa-concealed' } : nativeFn(win, ...rest));
  }
}
proto.show = function show() { conceal(this); return nativeShowInactive.call(this); };
proto.showInactive = function showInactive() { conceal(this); return nativeShowInactive.call(this); };
proto.focus = function focus() { record('window_focus_blocked'); };
proto.moveTop = function moveTop() {};
// maximize() shows AND activates a window (SW_MAXIMIZE), cloak or not: in the
// sandbox it is recorded and the window takes its display's work area instead
// (setBounds never shows or activates), so a maximised layout can be shot.
proto.maximize = function maximize() {
  record('maximize_blocked');
  try { this.setBounds(electron.screen.getDisplayMatching(this.getBounds()).workArea); } catch {}
};
proto.setOpacity = function setOpacity(value) { return nativeSetOpacity.call(this, transparent.has(this) ? 0 : value); };
proto.setIgnoreMouseEvents = function setIgnoreMouseEvents(ignore, opts) {
  return nativeSetIgnoreMouseEvents.call(this, transparent.has(this) ? true : ignore, opts);
};
app.focus = () => record('app_focus_blocked');
if (typeof app.show === 'function') app.show = () => record('app_show_blocked');
app.setLoginItemSettings = (settings) => record('login_item_blocked', { openAtLogin: !!(settings && settings.openAtLogin) });
app.relaunch = () => record('relaunch_blocked');
app.on('browser-window-created', (_event, win) => {
  // Every app window is created hidden; one that is not is concealed at once.
  if (win.isVisible()) conceal(win);
});

// Copy / cut / paste keys (Ctrl or Cmd + C / X / V, Ctrl / Shift + Insert,
// Shift + Delete). Blocked before the page AND the menu shortcuts see them.
function clipboardChord(input) {
  const key = String(input.key || '').toLowerCase();
  const mod = input.control || input.meta;
  return (mod && !input.alt && (key === 'c' || key === 'x' || key === 'v'))
    || (key === 'insert' && (input.control || input.shift))
    || (key === 'delete' && input.shift && !mod);
}
const PAGE_CLIPBOARD_NOTE = /^__qa_clipboard_blocked (\w+)$/; // logged by qa-sandbox-page.js

let webContentsPatched = false;
app.on('web-contents-created', (_event, contents) => {
  // Per page (every one, not only the first).
  contents.setWindowOpenHandler((details) => {
    record('window_open_blocked', { url: String((details && details.url) || '').slice(0, 200) });
    return { action: 'deny' };
  });
  contents.on('before-input-event', (event, input) => {
    if (input.type !== 'keyDown' || !clipboardChord(input)) return;
    event.preventDefault();
    record('clipboard_key_blocked', { key: String(input.key || '') });
  });
  // Electron 34 passes (event, level, message, ...); newer ones put it on event.
  contents.on('console-message', (event, _level, message) => {
    const text = typeof message === 'string' ? message : String((event && event.message) || '');
    const m = PAGE_CLIPBOARD_NOTE.exec(text);
    if (m) record('clipboard_api_blocked', { api: m[1] });
  });
  if (webContentsPatched) return;
  webContentsPatched = true;
  const wproto = Object.getPrototypeOf(contents);
  // webContents.focus() gives the window OS focus (SetFocus activates it).
  wproto.focus = function focus() { record('webcontents_focus_blocked'); };
  // A real drag with no button held drops onto whatever is under the cursor.
  wproto.startDrag = function startDrag(item) {
    record('start_drag_blocked', { files: (item && (item.files || [item.file]) || []).filter(Boolean).length });
  };
});

// --- Renderer clipboard: permissions + the page stub ----------------------------
// navigator.clipboard and execCommand copy / paste go to the OS clipboard
// through Chromium, past the electron.clipboard fake below: deny the clipboard
// permissions and stub the calls in every page's main world.
const CLIPBOARD_PERMISSIONS = new Set(['clipboard-read', 'clipboard-sanitized-write', 'deprecated-sync-clipboard-read']);
const PAGE_STUB = path.join(__dirname, 'qa-sandbox-page.js');
const guardedSessions = new WeakSet();
function guardSession(ses) {
  if (!ses || guardedSessions.has(ses)) return;
  guardedSessions.add(ses);
  ses.setPermissionRequestHandler((_contents, permission, callback) => {
    if (!CLIPBOARD_PERMISSIONS.has(permission)) { callback(true); return; }
    record('clipboard_permission_blocked', { permission });
    callback(false);
  });
  ses.setPermissionCheckHandler((_contents, permission) => !CLIPBOARD_PERMISSIONS.has(permission));
  ses.setPreloads([...ses.getPreloads(), PAGE_STUB]);
}
app.on('session-created', guardSession);
// 'ready' listeners run in registration order and this file loads before
// main.js, so the default session is guarded before main.js makes a window.
app.on('ready', () => guardSession(electron.session.defaultSession));

// --- In-memory clipboard -------------------------------------------------------
const fake = { text: '', html: '', rtf: '', image: null, bookmark: null, seq: 1, writes: 0 };
function clearFake() {
  fake.text = ''; fake.html = ''; fake.rtf = ''; fake.image = null; fake.bookmark = null;
}
function wrote(kind) { fake.seq += 1; fake.writes += 1; record('clipboard_write', { kind }); }
const str = (value) => (value == null ? '' : String(value));
function formats() {
  const out = [];
  if (fake.text) out.push('text/plain');
  if (fake.html) out.push('text/html');
  if (fake.rtf) out.push('text/rtf');
  if (fake.image && !fake.image.isEmpty()) out.push('image/png');
  return out;
}
Object.assign(clipboard, {
  readText: () => fake.text,
  readHTML: () => fake.html,
  readRTF: () => fake.rtf,
  readImage: () => fake.image || nativeImage.createEmpty(),
  readBookmark: () => fake.bookmark || { title: '', url: '' },
  readFindText: () => '',
  read: () => '',
  readBuffer: () => Buffer.alloc(0),
  availableFormats: () => formats(),
  has: (format) => formats().includes(format),
  writeText: (text) => { clearFake(); fake.text = str(text); wrote('text'); },
  writeHTML: (html) => { clearFake(); fake.html = str(html); wrote('html'); },
  writeRTF: (rtf) => { clearFake(); fake.rtf = str(rtf); wrote('rtf'); },
  writeImage: (image) => { clearFake(); fake.image = image || null; wrote('image'); },
  writeBookmark: (title, url) => { clearFake(); fake.bookmark = { title: str(title), url: str(url) }; fake.text = str(url); wrote('bookmark'); },
  writeFindText: () => {},
  writeBuffer: () => { clearFake(); wrote('buffer'); },
  write: (data) => {
    const d = data || {};
    clearFake();
    if (d.text != null) fake.text = str(d.text);
    if (d.html != null) fake.html = str(d.html);
    if (d.rtf != null) fake.rtf = str(d.rtf);
    if (d.image) fake.image = d.image;
    if (d.bookmark != null) fake.bookmark = { title: str(d.bookmark), url: fake.text };
    wrote('formats');
  },
  clear: () => { clearFake(); wrote('clear'); },
});
// The capture path also asks Windows directly (sequence number, file drops).
const winClipboard = lib('windows-clipboard.js');
winClipboard.getSequenceNumber = () => fake.seq;
winClipboard.readImageCandidate = () => null;

// --- Paste, foreground, click-away -----------------------------------------------
const winPaste = lib('windows-paste.js');
winPaste.sendCtrlV = () => { record('paste_blocked', { via: 'SendInput' }); };
winPaste.typeText = () => { record('paste_blocked', { via: 'typeText' }); };
winPaste.setForegroundWindow = () => { record('foreground_blocked'); return true; };
// The click-away watcher polls the real mouse: a click elsewhere on the desktop
// during a run would close the sandbox popup mid-test.
winPaste.isMouseButtonDown = () => false;
const macPaste = lib('macos-paste.js');
macPaste.sendCommandV = () => { record('paste_blocked', { via: 'CGEvent' }); return { ok: true }; };
macPaste.typeText = () => { record('paste_blocked', { via: 'typeText' }); return { ok: true }; };
// macOS falls back to osascript keystrokes; main.js destructures exec/execFile
// at load, so wrapping them here (before main.js) covers that path too.
const KEYSTROKE = /\b(keystroke|key code)\b/;
function fakeChild(callback) {
  const child = new EventEmitter();
  child.kill = () => true;
  process.nextTick(() => { if (callback) callback(null, '', ''); child.emit('exit', 0); child.emit('close', 0); });
  return child;
}
const nativeExec = childProcess.exec;
childProcess.exec = function exec(command, ...rest) {
  if (/osascript/.test(String(command)) && KEYSTROKE.test(String(command))) {
    record('paste_blocked', { via: 'osascript' });
    return fakeChild(rest.find((x) => typeof x === 'function'));
  }
  return nativeExec.call(this, command, ...rest);
};
const nativeExecFile = childProcess.execFile;
childProcess.execFile = function execFile(file, ...rest) {
  const args = Array.isArray(rest[0]) ? rest[0].join(' ') : '';
  if (/osascript/.test(String(file)) && KEYSTROKE.test(args)) {
    record('paste_blocked', { via: 'osascript' });
    return fakeChild(rest.find((x) => typeof x === 'function'));
  }
  return nativeExecFile.call(this, file, ...rest);
};

// --- Shell, dialogs, notifications, updater ----------------------------------------
shell.openExternal = async (url) => { record('open_external_blocked', { url: str(url).slice(0, 200) }); };
shell.openPath = async (target) => { record('open_path_blocked', { path: str(target).slice(0, 200) }); return ''; };
shell.showItemInFolder = (target) => { record('show_item_blocked', { path: str(target).slice(0, 200) }); };
shell.beep = () => {};
const dialogOpts = (a, b) => (b && typeof b === 'object' ? b : (a && typeof a === 'object' && !a.webContents ? a : {}));
dialog.showOpenDialog = async () => { record('dialog_blocked', { kind: 'open' }); return { canceled: true, filePaths: [] }; };
dialog.showOpenDialogSync = () => { record('dialog_blocked', { kind: 'open' }); return undefined; };
dialog.showSaveDialog = async () => { record('dialog_blocked', { kind: 'save' }); return { canceled: true, filePath: '' }; };
dialog.showSaveDialogSync = () => { record('dialog_blocked', { kind: 'save' }); return undefined; };
dialog.showMessageBox = async (a, b) => {
  const opts = dialogOpts(a, b);
  record('dialog_blocked', { kind: 'message', message: str(opts.message).slice(0, 200) });
  return { response: Number.isInteger(opts.cancelId) ? opts.cancelId : 0, checkboxChecked: false };
};
dialog.showMessageBoxSync = (a, b) => {
  const opts = dialogOpts(a, b);
  record('dialog_blocked', { kind: 'message', message: str(opts.message).slice(0, 200) });
  return Number.isInteger(opts.cancelId) ? opts.cancelId : 0;
};
dialog.showErrorBox = (title, content) => { record('dialog_blocked', { kind: 'error', message: `${str(title)}: ${str(content)}`.slice(0, 200) }); };
Notification.prototype.show = function show() { record('notification_blocked', { title: str(this.title).slice(0, 120) }); };
lib('auto-update.js').createAutoUpdater = () => ({
  start() { record('auto_update_blocked'); },
  stop() {},
  check: async () => ({ ok: false, status: 'unsupported', reason: 'qa-sandbox' }),
});

// Every guarded module must exist exactly once in the cache (see ROOT above),
// and main.js must have loaded (it requires them all at startup).
function selfCheck() {
  const keys = Object.keys(require.cache).map((k) => k.toLowerCase());
  const guarded = ['windows-dwm.js', 'windows-clipboard.js', 'windows-paste.js', 'macos-paste.js', 'auto-update.js'];
  const counts = Object.fromEntries(guarded.map((name) => [name, keys.filter((k) => k.endsWith(path.sep + 'lib' + path.sep + name)).length]));
  const mainLoaded = keys.includes(path.join(ROOT, 'main.js').toLowerCase());
  return { ok: mainLoaded && Object.values(counts).every((n) => n === 1), mainLoaded, counts };
}

globalThis.__qa = { require, electron, events, clipboard: fake, record, selfCheck, root: ROOT, sandbox: process.env.BOARDCLIP_QA_SANDBOX };
