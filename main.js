const { app, BrowserWindow, Tray, Menu, globalShortcut, clipboard, nativeImage,
        ipcMain, protocol, screen, shell } = require('electron');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const os = require('os');
const { exec, spawn } = require('child_process');

// Windows-specific fast input (keybd_event, Get/SetForegroundWindow).
// Module is a no-op on non-Windows platforms so it's safe to require unconditionally.
const winPaste = require('./lib/windows-paste');
const getBuildInfo = require('./lib/build-info');
const getCloudAccounts = require('./lib/cloud-accounts');
const clipboardModel = require('./lib/clipboard-model');

app.setName('Clipboard Tray');

// --- Paths ---
const SCRIPT_DIR = __dirname;
const DB_PATH = path.join(SCRIPT_DIR, 'clipboard-history.json');
const SETTINGS_PATH = path.join(SCRIPT_DIR, 'clipboard-settings.json');
const IMG_DIR = path.join(SCRIPT_DIR, 'clipboard-images');

function windowsStartupDir() {
  const appData = process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming');
  return path.join(appData, 'Microsoft', 'Windows', 'Start Menu', 'Programs', 'Startup');
}

function windowsDevStartupScriptPath() {
  return path.join(windowsStartupDir(), 'Clipboard Tray.vbs');
}

function escapeVbsString(value) {
  return String(value).replace(/"/g, '""');
}

function windowsDevStartupScript() {
  const startBat = path.join(SCRIPT_DIR, 'start.bat');
  return [
    'Set shell = CreateObject("WScript.Shell")',
    `shell.Run """${escapeVbsString(startBat)}""", 0, False`,
    '',
  ].join('\r\n');
}

function removeLegacyStartupShortcuts() {
  if (process.platform !== 'win32') return;
  for (const name of ['ClipboardTray.lnk', 'clipboard-tray.lnk', 'clipboard_numpad.lnk']) {
    try { fs.rmSync(path.join(windowsStartupDir(), name), { force: true }); } catch {}
  }
}

function getAutoLaunchEnabled() {
  if (process.platform === 'win32' && !app.isPackaged) {
    return fs.existsSync(windowsDevStartupScriptPath());
  }
  return app.getLoginItemSettings().openAtLogin;
}

function setAutoLaunchEnabled(enabled) {
  if (process.platform === 'win32' && !app.isPackaged) {
    const scriptPath = windowsDevStartupScriptPath();
    if (enabled) {
      removeLegacyStartupShortcuts();
      fs.mkdirSync(path.dirname(scriptPath), { recursive: true });
      fs.writeFileSync(scriptPath, windowsDevStartupScript(), 'utf-8');
    } else {
      try { fs.rmSync(scriptPath, { force: true }); } catch {}
    }
    return;
  }
  app.setLoginItemSettings({ openAtLogin: !!enabled });
}

if (!fs.existsSync(IMG_DIR)) fs.mkdirSync(IMG_DIR, { recursive: true });

const BUILD_INFO = getBuildInfo(SCRIPT_DIR);

// --- AHK presets for first-run seeding ---
const AHK_PRESETS = {
  1: "does that all make sense or is there any clarifying questions you have to make for the best output? Maybe even suggestions?\n\nMake sure to look through the code/documentation/etc, and consult back to me before you start - we need to make sure were on the same page first. Think very hard",
  2: "does that all make sense or is there any clarifying questions you have to make for the best output? Maybe even suggestions? Think very hard",
  3: "Nothing else? Any suggestions? Maybe have a final look over of the stuff we've just done. Do you reckon what we have so far is the best/cleanest way to impl this. if not impl a production ready clean minimal version. Think very hard",
  4: "ok that solved that issue, do you reckon what we have so far is the best/cleanest way to impl this. if not impl a production ready clean minimal version. Think very hard",
  5: "Think very hard",
  6: "Would it help if you added comprehensive test logs temporarily and i retest then give you the results to help you pin point the solution? Think very hard",
  7: "I think this is good to go, before you start impl, can you just write down a super technical/detailed plan in markdown format in file. Include key findings from your research, so whoever reading this has context from where to start from, before they move on to the new task at hand. When I say technical, you don't need to write out actual full code implementations, but I mean detail the sorts of tables needing reworking, libraries/methods used, etc... Pseudocode at most unless reference small snippets of code. This conversation can get interrupted/cleared/compacted so we need to be able to impl this from the info in this file. Let me know if that all makes sense or is there any clarifying questions you have to make for the best output? Maybe even suggestions? Think very hard",
  8: "here's where we left off before our conversation got condensed:\n===================\n\n===================",
  9: "We AGGRESSIVELY should try to minimise code/logic duplication and maximise/unify/reuse shared components across projects.\nOften it's better to adapt existing components, further strengthening them as opposed to creating new variants which will likely lead to duplicated effort down the line.\nWe can still have inheritance/composition - doesn't have to be everything in 1 monster function/class, but the core logic should be shared/reused.\nThis must be taken into account at every step of thinking/planning.\nThis reduces maintenance cost and chance of bugs, and makes it easier to understand and adapt code in future",
};

// --- Settings ---
const DEFAULT_SETTINGS = clipboardModel.DEFAULT_SETTINGS;

function atomicWriteFile(filePath, data) {
  const tmpPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmpPath, data);
  fs.renameSync(tmpPath, filePath);
}

function atomicWriteJson(filePath, value, spacing) {
  atomicWriteFile(filePath, JSON.stringify(value, null, spacing));
}

function loadSettings() {
  try {
    return { ...DEFAULT_SETTINGS, ...JSON.parse(fs.readFileSync(SETTINGS_PATH, 'utf-8')) };
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}

function saveSettingsFile() {
  const s = { ...settings };
  s.tombstones = normalizeTombstones(s.tombstones);
  s.group_tombstones = normalizeGroupTombstones(s.group_tombstones);
  settings.tombstones = s.tombstones;
  settings.group_tombstones = s.group_tombstones;
  delete s.numpad_slots;
  atomicWriteJson(SETTINGS_PATH, s, 2);
  dataRevision++;
  notifyDataChanged();
  scheduleSyncMerge();
}

let settings = loadSettings();
let dataRevision = 0;

function notifyDataChanged() {
  if (!win || win.isDestroyed() || !win.webContents || win.webContents.isDestroyed()) return;
  win.webContents.send('history-changed', dataRevision);
}

// --- History ---
function loadHistory() {
  try {
    const loaded = JSON.parse(fs.readFileSync(DB_PATH, 'utf-8'));
    return Array.isArray(loaded) ? loaded : [];
  } catch {
    return [];
  }
}

function saveHistory() {
  for (const item of history) ensureItemId(item);
  atomicWriteJson(DB_PATH, history);
  dataRevision++;
  notifyDataChanged();
  scheduleSyncMerge();
  syncHookState();
}

// Reflect current history/popup state into the Windows hook's shared
// buffer so the hook worker can synchronously decide whether to swallow
// plain numpad keypresses.
function syncHookState() {
  if (!windowsHook) return;
  const assigned = new Set();
  for (const item of history) {
    const n = numpadSlotOf(item);
    if (n != null) assigned.add(n);
  }
  windowsHook.setSlotAssignments(assigned);
}

let history = loadHistory();
for (const h of history) migrateItemPin(h);
for (const h of history) ensureItemId(h);

// --- Pin model ---
// Unified state: item.pin is null/undefined for unpinned items, or an object
// { number?: 1-9, groups?: string[] } for pinned items. Presence of the pin
// object = "starred" (eligible for retention). Replaces the old tangled
// model of `item.pinned: false|true|1-9` + `item.group: string`.
function migrateItemPin(h) {
  clipboardModel.migrateItemPin(h);
}

function isPinned(item) { return clipboardModel.isPinned(item); }
function numpadSlotOf(item) {
  return clipboardModel.numpadSlotOf(item);
}
function groupsOf(item) {
  return clipboardModel.groupsOf(item);
}
function hasNumpadSlot(item, n) { return clipboardModel.hasNumpadSlot(item, n); }
function ensurePin(item) {
  return clipboardModel.ensurePin(item);
}

function dedupeNumpadSlots(items) {
  return clipboardModel.dedupeNumpadSlots(items);
}

function legacyContentKey(item) {
  return clipboardModel.legacyContentKey(item);
}

function ensureItemId(item) {
  return clipboardModel.ensureItemId(item);
}

function itemKey(item) {
  return clipboardModel.itemKey(item);
}

function findHistoryIndex(id) {
  if (!id) return -1;
  return history.findIndex(item => itemKey(item) === id);
}

function findHistoryItem(id) {
  const idx = findHistoryIndex(id);
  return idx >= 0 ? history[idx] : null;
}

function updateTextItem(item, text) {
  if (!item || item.type === 'image') return null;
  const oldId = itemKey(item);
  const next = { ...item, text: text || '', updatedAt: Date.now() };
  next.id = legacyContentKey(next);

  const existingIdx = history.findIndex(h => h !== item && itemKey(h) === next.id);
  if (existingIdx >= 0) {
    const existing = history[existingIdx];
    existing.text = next.text;
    existing.ts = Math.max(existing.ts || 0, next.ts || 0);
    existing.updatedAt = Math.max(existing.updatedAt || 0, next.updatedAt || 0);
    existing.pin = mergePins(existing.pin, next.pin, existing.updatedAt || existing.ts || 0, next.updatedAt || next.ts || 0);
    const oldIdx = history.indexOf(item);
    if (oldIdx >= 0) history.splice(oldIdx, 1);
    addTombstone(oldId);
    return existing;
  }

  item.text = next.text;
  item.id = next.id;
  item.updatedAt = next.updatedAt;
  if (oldId !== item.id) addTombstone(oldId);
  return item;
}

function getStorageBytes() {
  let total = 0;
  try { total = fs.statSync(DB_PATH).size; } catch {}
  try {
    for (const fname of fs.readdirSync(IMG_DIR)) {
      try { total += fs.statSync(path.join(IMG_DIR, fname)).size; } catch {}
    }
  } catch {}
  return total;
}

function removeItemImage(item) {
  if (item.type !== 'image') return;
  const fname = item.image || '';
  if (history.filter(h => h.image === fname).length <= 1) {
    try { fs.unlinkSync(path.join(IMG_DIR, fname)); } catch {}
  }
}

function deleteHistoryIndex(index, { tombstone = true } = {}) {
  if (index < 0 || index >= history.length) return null;
  const item = history[index];
  if (tombstone) addTombstone(itemKey(item));
  removeItemImage(item);
  history.splice(index, 1);
  return item;
}

function pruneHistory() {
  const now = Date.now() / 1000;
  const maxAge = settings.max_age_days * 86400;
  const maxBytes = settings.max_size_gb * 1024 ** 3;
  let changed = false;

  for (let i = history.length - 1; i >= 0; i--) {
    if (!isPinned(history[i]) && (now - (history[i].ts || 0)) > maxAge) {
      deleteHistoryIndex(i);
      changed = true;
    }
  }

  while (getStorageBytes() > maxBytes) {
    let idx = -1;
    for (let i = history.length - 1; i >= 0; i--) {
      if (!isPinned(history[i])) { idx = i; break; }
    }
    if (idx < 0) break;
    deleteHistoryIndex(idx);
    changed = true;
  }

  if (changed) {
    saveSettingsFile();
    saveHistory();
  }
}

// --- Migration: old settings.numpad_slots -> per-item pin ---
// Runs once on first launch after upgrading from the Python-era config.
function migrateNumpad() {
  const oldSlots = settings.numpad_slots;

  if (oldSlots) {
    for (const [numStr, slot] of Object.entries(oldSlots)) {
      const num = parseInt(numStr);
      if (slot.type === 'image') {
        const match = history.find(h => h.type === 'image' && h.image === slot.image);
        if (match) ensurePin(match).number = num;
        else history.unshift({ type: 'image', image: slot.image, ts: Date.now() / 1000, pin: { number: num } });
      } else {
        const text = slot.text || '';
        const match = history.find(h => h.type !== 'image' && h.text === text);
        if (match) ensurePin(match).number = num;
        else history.unshift({ type: 'text', text, ts: Date.now() / 1000, pin: { number: num } });
      }
    }
    delete settings.numpad_slots;
    saveHistory();
    saveSettingsFile();
  } else if (!history.length) {
    for (const num of [9, 8, 7, 6, 5, 4, 3, 2, 1]) {
      if (AHK_PRESETS[num]) {
        history.unshift({ type: 'text', text: AHK_PRESETS[num], ts: Date.now() / 1000, pin: { number: num } });
      }
    }
    saveHistory();
  }
}

// --- Sync: merge local <-> shared (Google Drive etc) ---
function normalizeTombstones(list) {
  return clipboardModel.normalizeTombstones(list);
}

function normalizeGroupTombstones(list) {
  return clipboardModel.normalizeGroupTombstones(list);
}

function groupTombstoneNames(list) {
  return clipboardModel.groupTombstoneNames(list);
}

function addTombstone(id) {
  if (!id) return;
  settings.tombstones = normalizeTombstones([
    ...(settings.tombstones || []),
    { id, deletedAt: Date.now() },
  ]);
}

function addGroupTombstone(name) {
  if (!name) return;
  settings.group_tombstones = normalizeGroupTombstones([
    ...(settings.group_tombstones || []),
    { name, deletedAt: Date.now() },
  ]);
}

function mergePins(localPin, remotePin, localUpdatedAt = 0, remoteUpdatedAt = 0) {
  return clipboardModel.mergePins(localPin, remotePin, localUpdatedAt, remoteUpdatedAt, settings.group_tombstones);
}

function mergeItems(localItem, remoteItem) {
  return clipboardModel.mergeItems(localItem, remoteItem, settings.group_tombstones);
}

function mergeHistories(local, remote) {
  return clipboardModel.mergeHistories(local, remote, settings);
}

function mergeGroups(local, remote) {
  return clipboardModel.mergeGroups(local, remote, settings.group_tombstones);
}

function remoteSettingsPayload() {
  const remoteSave = {
    ...settings,
    tombstones: normalizeTombstones(settings.tombstones),
    group_tombstones: normalizeGroupTombstones(settings.group_tombstones),
  };
  delete remoteSave.numpad_slots;
  delete remoteSave.sync_path;
  return remoteSave;
}

function syncImages(remoteImgDir) {
  if (!fs.existsSync(remoteImgDir)) fs.mkdirSync(remoteImgDir, { recursive: true });

  // Copy remote -> local (missing locally)
  try {
    for (const fname of fs.readdirSync(remoteImgDir)) {
      const localPath = path.join(IMG_DIR, fname);
      if (!fs.existsSync(localPath)) {
        fs.copyFileSync(path.join(remoteImgDir, fname), localPath);
      }
    }
  } catch {}

  // Copy local -> remote (missing remotely)
  try {
    for (const fname of fs.readdirSync(IMG_DIR)) {
      const remotePath = path.join(remoteImgDir, fname);
      if (!fs.existsSync(remotePath)) {
        fs.copyFileSync(path.join(IMG_DIR, fname), remotePath);
      }
    }
  } catch {}
}

let lastSyncMtime = 0;
let syncDebounceTimer = null;
let insideSync = false;

function scheduleSyncMerge() {
  if (!settings.sync_path || insideSync) return;
  if (syncDebounceTimer) clearTimeout(syncDebounceTimer);
  // DO NOT reset lastSyncMtime here — that would force the merge path on
  // every scheduled sync, breaking the local-only-wins resurrection guard.
  syncDebounceTimer = setTimeout(syncMerge, 500);
}

function syncMerge() {
  const syncPath = settings.sync_path;
  if (!syncPath || !fs.existsSync(syncPath)) return;

  insideSync = true;
  try {
    const remoteDbPath = path.join(syncPath, 'clipboard-history.json');
    const remoteSettingsPath = path.join(syncPath, 'clipboard-settings.json');
    const remoteImgDir = path.join(syncPath, 'clipboard-images');

    let remoteMtime = 0;
    try { remoteMtime = fs.statSync(remoteDbPath).mtimeMs; } catch {}
    let remoteSettingsMtime = 0;
    try { remoteSettingsMtime = fs.statSync(remoteSettingsPath).mtimeMs; } catch {}
    let localMtime = 0;
    try { localMtime = fs.statSync(DB_PATH).mtimeMs; } catch {}
    let localSettingsMtime = 0;
    try { localSettingsMtime = fs.statSync(SETTINGS_PATH).mtimeMs; } catch {}
    const localChangedSince = Math.max(localMtime, localSettingsMtime) > lastSyncMtime;
    const remoteChangedSince = Math.max(remoteMtime, remoteSettingsMtime) > lastSyncMtime;
    if (!localChangedSince && !remoteChangedSince) return;

    // Local-only changes: push local to remote without merging. Prevents the
    // resurrection bug where a deleted group comes back because the merge
    // sees the "still has group" remote copy as higher-scored.
    if (localChangedSince && !remoteChangedSince) {
      try { atomicWriteJson(remoteDbPath, history); } catch {}
      try {
        atomicWriteJson(remoteSettingsPath, remoteSettingsPayload(), 2);
      } catch {}
      syncImages(remoteImgDir);
      try {
        const rmt = fs.statSync(remoteDbPath).mtimeMs;
        const rsmt = fs.statSync(remoteSettingsPath).mtimeMs;
        const lmt = fs.statSync(DB_PATH).mtimeMs;
        const lsmt = fs.statSync(SETTINGS_PATH).mtimeMs;
        lastSyncMtime = Math.max(rmt, rsmt, lmt, lsmt);
      } catch {}
      return;
    }

    lastSyncMtime = Date.now();

    // Load remote data (merge path)
    let remoteHistory = [];
    try { remoteHistory = JSON.parse(fs.readFileSync(remoteDbPath, 'utf-8')); } catch {}
    let remoteSettings = {};
    try { remoteSettings = JSON.parse(fs.readFileSync(remoteSettingsPath, 'utf-8')); } catch {}

    const previousTombstones = JSON.stringify(normalizeTombstones(settings.tombstones));
    const previousGroupTombstones = JSON.stringify(normalizeGroupTombstones(settings.group_tombstones));
    settings.tombstones = normalizeTombstones([
      ...(settings.tombstones || []),
      ...(remoteSettings.tombstones || []),
    ]);
    settings.group_tombstones = normalizeGroupTombstones([
      ...(settings.group_tombstones || []),
      ...(remoteSettings.group_tombstones || []),
    ]);

    // Merge histories
    const merged = mergeHistories(history, remoteHistory);
    const localChanged = JSON.stringify(merged) !== JSON.stringify(history);
    const remoteChanged = JSON.stringify(merged) !== JSON.stringify(remoteHistory);

    if (localChanged) {
      history.length = 0;
      history.push(...merged);
    }

    // Merge groups from settings + any groups found on history items
    const historyGroups = history.flatMap(h => groupsOf(h));
    const mergedGroups = mergeGroups(settings.groups, [...(remoteSettings.groups || []), ...historyGroups]);
    const groupsChanged = JSON.stringify(mergedGroups) !== JSON.stringify(settings.groups);
    if (groupsChanged) settings.groups = mergedGroups;
    const tombstonesChanged =
      JSON.stringify(settings.tombstones || []) !== previousTombstones ||
      JSON.stringify(settings.tombstones || []) !== JSON.stringify(normalizeTombstones(remoteSettings.tombstones || []));
    const groupTombstonesChanged =
      JSON.stringify(settings.group_tombstones || []) !== previousGroupTombstones ||
      JSON.stringify(settings.group_tombstones || []) !==
        JSON.stringify(normalizeGroupTombstones(remoteSettings.group_tombstones || []));

    // Sync images both ways
    syncImages(remoteImgDir);

    // Only write if something actually changed
    if (localChanged || groupsChanged || tombstonesChanged || groupTombstonesChanged) {
      saveHistory();
      saveSettingsFile();
    }
    if (remoteChanged || groupsChanged || tombstonesChanged || groupTombstonesChanged) {
      try { atomicWriteJson(remoteDbPath, merged); } catch {}
      try {
        atomicWriteJson(remoteSettingsPath, remoteSettingsPayload(), 2);
      } catch {}
    }

    // Update mtime tracking
    try {
      const rmt = fs.statSync(path.join(syncPath, 'clipboard-history.json')).mtimeMs;
      const rsmt = fs.statSync(path.join(syncPath, 'clipboard-settings.json')).mtimeMs;
      const lmt = fs.statSync(DB_PATH).mtimeMs;
      const lsmt = fs.statSync(SETTINGS_PATH).mtimeMs;
      lastSyncMtime = Math.max(rmt, rsmt, lmt, lsmt);
    } catch {}
  } finally { insideSync = false; }
}

// --- Image helpers ---
function imageHash(buffer) {
  return crypto.createHash('md5').update(buffer).digest('hex').slice(0, 12);
}

function saveClipboardImage(nativeImg) {
  const buf = nativeImg.toPNG();
  const hash = imageHash(buf);
  const fname = `${hash}.png`;
  const fpath = path.join(IMG_DIR, fname);
  if (!fs.existsSync(fpath)) atomicWriteFile(fpath, buf);
  const size = nativeImg.getSize();
  return { fname, width: size.width, height: size.height };
}

// --- Clipboard polling ---
let lastText = '';
let lastImgHash = '';
let pollGate = true;

function addToHistory(entry, matchFn) {
  ensureItemId(entry);
  const beforeTombstones = normalizeTombstones(settings.tombstones);
  settings.tombstones = beforeTombstones.filter(t => t.id !== itemKey(entry));
  const tombstoneRemoved = settings.tombstones.length !== beforeTombstones.length;
  // Check if already at top
  if (history.length && matchFn(history[0])) {
    if (tombstoneRemoved) saveSettingsFile();
    return;
  }
  // Find existing, preserve pin metadata
  const existIdx = history.findIndex(matchFn);
  if (existIdx >= 0) {
    if (history[existIdx].pin) entry.pin = history[existIdx].pin;
    entry.id = itemKey(history[existIdx]);
    history.splice(existIdx, 1);
  }
  history.unshift(entry);
  pruneHistory();
  if (tombstoneRemoved) saveSettingsFile();
  saveHistory();
}

function pollClipboard() {
  if (!pollGate) return;

  try {
    const img = clipboard.readImage();
    if (!img.isEmpty()) {
      const buf = img.toPNG();
      const h = imageHash(buf);
      if (h !== lastImgHash) {
        lastImgHash = h;
        lastText = '';
        const { fname, width, height } = saveClipboardImage(img);
        addToHistory(
          { type: 'image', image: fname, ts: Date.now() / 1000, width, height },
          it => it.type === 'image' && it.image === fname
        );
      }
    } else {
      const text = clipboard.readText();
      if (text && text !== lastText) {
        lastText = text;
        lastImgHash = '';
        addToHistory(
          { type: 'text', text, ts: Date.now() / 1000 },
          it => it.text === text
        );
      }
    }
  } catch {}
}

// --- Clipboard backup/restore (simplified — backs up text/image/html/rtf) ---
function backupClipboard() {
  return {
    text: clipboard.readText(),
    html: clipboard.readHTML(),
    rtf: clipboard.readRTF(),
    image: clipboard.readImage(),
  };
}

function restoreClipboard(backup) {
  if (!backup) return;
  clipboard.clear();
  if (!backup.image.isEmpty()) {
    clipboard.writeImage(backup.image);
  } else if (backup.text) {
    const formats = {};
    if (backup.text) formats.text = backup.text;
    if (backup.html) formats.html = backup.html;
    if (backup.rtf) formats.rtf = backup.rtf;
    clipboard.write(formats);
  }
}

// --- Paste simulation ---
// Sends Ctrl+V (Cmd+V on mac) to the currently focused window. On Windows
// this uses a direct keybd_event call via koffi (microseconds, no side
// effects). On macOS we use osascript because there's no equivalent native
// Electron API — acceptable there because the Mac paste flow is less hot.
function simulatePaste() {
  if (process.platform === 'win32') {
    winPaste.sendCtrlV();
    return Promise.resolve();
  }
  return new Promise((resolve) => {
    exec(`osascript -e 'tell application "System Events" to keystroke "v" using command down'`, () => resolve());
  });
}

// --- Numpad quick-paste ---
async function numpadPaste(slotNum) {
  // Drop the call if a previous paste is still in its restore window —
  // otherwise rapid Num-key presses race and the second call's "backup"
  // captures the first call's pasted content.
  if (!pollGate) return;
  const item = history.find(h => hasNumpadSlot(h, slotNum));
  if (!item) return;

  pollGate = false;
  let backup = null;
  try {
    backup = backupClipboard();
    setClipboardToItem(item);
  // Minimum delay for Windows clipboard propagation before paste. 15ms is
  // tight but reliable — clipboard.writeText is synchronous and Windows
  // WM_CLIPBOARDUPDATE propagates within a few ms on any modern system.
    await new Promise(r => setTimeout(r, 15));
    await simulatePaste();
    await new Promise(r => setTimeout(r, 150));
  // Fire-and-forget restore: the target app needs ~100-150ms to read from
  // the clipboard after receiving Ctrl+V. We don't block the caller on that.
  } finally {
    try { restoreClipboard(backup); } catch {}
    pollGate = true;
  }
}

// --- Window & state ---
const WIN_W = 460;
const WIN_H = 520;
let win = null;
let tray = null;

function createPopup() {
  win = new BrowserWindow({
    width: WIN_W,
    height: WIN_H,
    frame: false,
    alwaysOnTop: true,
    show: false,
    skipTaskbar: true,
    resizable: false,
    backgroundColor: '#131313',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  win.loadFile('index.html');

  // Dev: auto-reload UI when index.html changes (debounced)
  let reloadTimer = null;
  fs.watch(path.join(__dirname, 'index.html'), () => {
    if (reloadTimer) clearTimeout(reloadTimer);
    reloadTimer = setTimeout(() => {
      if (win && !win.isDestroyed()) win.webContents.reloadIgnoringCache();
    }, 300);
  });

  // Windows: blur-to-hide works reliably
  if (process.platform === 'win32') {
    win.on('blur', () => {
      setTimeout(() => {
        if (Date.now() < ignoreBlurUntil) return;
        if (win && !win.isDestroyed() && !win.isFocused()) win.hide();
      }, 150);
    });
  }

  win.on('hide', () => {
    if (windowsHook) windowsHook.setPopupVisible(false);
    stopClickAwayWatcher();
    // Clear any open modals/state in renderer
    win.webContents.executeJavaScript(`
      document.getElementById('confirmOverlay')?.classList.remove('show');
      document.getElementById('settingsView')?.classList.remove('show');
      document.getElementById('mainView')?.classList.remove('hidden');
    `).catch(() => {});
  });

  win.on('close', (e) => {
    if (!app.isQuitting) {
      e.preventDefault();
      win.hide();
    }
  });
}

// HWND of the app that was frontmost before the popup was shown. We restore
// focus to it before pasting so the user's terminal/editor/etc. receives the
// keystrokes instead of our now-hidden popup.
let savedForegroundWindow = null;
let clickAwayTimer = null;
let clickAwayMouseWasDown = false;
let ignoreBlurUntil = 0;

function pointInWindowBounds(point, bounds) {
  return point.x >= bounds.x && point.x < bounds.x + bounds.width &&
         point.y >= bounds.y && point.y < bounds.y + bounds.height;
}

function stopClickAwayWatcher() {
  if (clickAwayTimer) clearInterval(clickAwayTimer);
  clickAwayTimer = null;
}

function startClickAwayWatcher() {
  if (process.platform !== 'win32' || !win || win.isDestroyed()) return;
  stopClickAwayWatcher();
  clickAwayMouseWasDown = winPaste.isMouseButtonDown();
  clickAwayTimer = setInterval(() => {
    if (!win || win.isDestroyed() || !win.isVisible()) {
      stopClickAwayWatcher();
      return;
    }

    const mouseDown = winPaste.isMouseButtonDown();
    const mousePressed = mouseDown && !clickAwayMouseWasDown;
    clickAwayMouseWasDown = mouseDown;
    if (!mousePressed) return;

    if (!pointInWindowBounds(screen.getCursorScreenPoint(), win.getBounds())) {
      hidePopup();
    }
  }, 50);
}

function hidePopup() {
  if (win && !win.isDestroyed()) win.hide();
  if (windowsHook) windowsHook.setPopupVisible(false);
  stopClickAwayWatcher();
}

function showPopup() {
  if (!win) return;
  if (win.isVisible()) {
    hidePopup();
    return;
  }

  // Capture the currently-focused window *before* showing ours so pasteAndHide
  // can restore focus to it. Electron doesn't do this automatically.
  if (process.platform === 'win32') {
    savedForegroundWindow = winPaste.getForegroundWindow();
    ignoreBlurUntil = Date.now() + 1200;
  }

  const cursor = screen.getCursorScreenPoint();
  const display = screen.getDisplayNearestPoint(cursor);
  const { x: wx, y: wy, width: ww, height: wh } = display.workArea;

  const x = Math.min(Math.max(wx, cursor.x - WIN_W / 2), wx + ww - WIN_W);
  const y = Math.min(Math.max(wy, cursor.y - 50), wy + wh - WIN_H);

  win.setPosition(Math.round(x), Math.round(y));
  win.show();
  win.moveTop();
  win.focus();
  if (windowsHook) windowsHook.setPopupVisible(true);
  startClickAwayWatcher();
}

function setClipboardToItem(item) {
  if (item.type === 'image') {
    const imgPath = path.join(IMG_DIR, item.image);
    if (fs.existsSync(imgPath)) clipboard.writeImage(nativeImage.createFromPath(imgPath));
  } else {
    clipboard.writeText(item.text || '');
  }
}

async function pasteAndHide(id) {
  const item = findHistoryItem(id);
  if (!item) return;

  pollGate = false;
  try {
    setClipboardToItem(item);
    hidePopup();
    if (process.platform === 'darwin') {
      // macOS: dock-hidden apps don't return focus automatically.
      // Use osascript to activate the frontmost app, then paste.
      await new Promise(r => setTimeout(r, 50));
      await new Promise((resolve) => {
        exec(`osascript -e '
          tell application "System Events"
            set frontApp to name of first application process whose frontmost is true
            tell application process frontApp to set frontmost to true
            delay 0.05
            keystroke "v" using command down
          end tell'`, () => resolve());
      });
    } else {
      // Windows: explicitly restore focus to the app that was frontmost
      // before we showed the popup. Without this, hidePopup() may leave
      // focus on the desktop/shell and Ctrl+V goes nowhere.
      if (savedForegroundWindow) winPaste.setForegroundWindow(savedForegroundWindow);
      await new Promise(r => setTimeout(r, 15));
      await simulatePaste();
    }
  } finally {
    pollGate = true;
  }
}

function createTray() {
  const iconPath = path.join(__dirname, 'icon.png');
  let trayIcon;
  if (fs.existsSync(iconPath)) {
    trayIcon = nativeImage.createFromPath(iconPath).resize({ width: 16, height: 16 });
  } else {
    trayIcon = nativeImage.createEmpty();
  }
  if (process.platform === 'darwin') trayIcon.setTemplateImage(true);

  tray = new Tray(trayIcon);
  tray.setToolTip(`Clipboard Tray ${BUILD_INFO.label}`);

  const contextMenu = Menu.buildFromTemplate([
    { label: 'Open', click: showPopup },
    { type: 'separator' },
    { label: `Build ${BUILD_INFO.label}`, enabled: false },
    { type: 'separator' },
    { label: 'Quit', click: () => { app.isQuitting = true; app.quit(); } },
  ]);

  tray.setContextMenu(contextMenu);
  tray.on('click', showPopup);
  tray.on('double-click', showPopup);
}

// --- Open in editor ---
function openEditor(id) {
  const item = findHistoryItem(id);
  if (!item || item.type === 'image') return;
  const originalText = item.text || '';
  const tmpPath = path.join(os.tmpdir(), `clip-${Date.now()}.txt`);
  fs.writeFileSync(tmpPath, originalText, 'utf-8');

  const cmd = process.platform === 'darwin' ? 'open' : 'notepad.exe';
  const args = process.platform === 'darwin' ? ['-t', '-W', tmpPath] : [tmpPath];
  const proc = spawn(cmd, args, { detached: true, stdio: 'ignore' });

  proc.on('exit', () => {
    try {
      const newText = fs.readFileSync(tmpPath, 'utf-8');
      // Use item reference — survives index shifts from deletes/adds
      if (newText !== originalText && item.text === originalText) {
        updateTextItem(item, newText);
        saveSettingsFile();
        saveHistory();
      }
    } catch {}
    try { fs.unlinkSync(tmpPath); } catch {}
  });

  proc.unref();
}

// --- IPC handlers ---
function setupIPC() {
  ipcMain.handle('get-history', () => history);
  ipcMain.handle('get-history-state', () => ({ revision: dataRevision, items: history }));

  ipcMain.handle('get-settings', () => ({
    ...settings,
    storage_bytes: getStorageBytes(),
    item_count: history.length,
    build_info: BUILD_INFO,
  }));

  ipcMain.handle('paste', (_, id) => {
    const item = findHistoryItem(id);
    if (!item) return;
    setClipboardToItem(item);
  });

  ipcMain.handle('paste-and-hide', (_, id) => pasteAndHide(id));

  ipcMain.handle('hide-popup', () => hidePopup());

  ipcMain.handle('copy', (_, text) => clipboard.writeText(text || ''));

  ipcMain.handle('delete-item', (_, id) => {
    const index = findHistoryIndex(id);
    if (index < 0) return;
    deleteHistoryIndex(index);
    saveSettingsFile();
    saveHistory();
  });

  ipcMain.handle('delete-all', () => {
    const kept = [];
    for (const item of history) {
      if (isPinned(item)) kept.push(item);
      else {
        addTombstone(itemKey(item));
        removeItemImage(item);
      }
    }
    history.length = 0;
    history.push(...kept);
    saveSettingsFile();
    saveHistory();
  });

  // Click-star behavior, matching the pre-Electron Python version:
  //   - unpinned        → star it (pin = {})
  //   - starred+numbered → remove the number, keep starred
  //   - starred (any)   → fully unpin (pin = null, clears groups too)
  ipcMain.handle('pin', (_, id) => {
    const item = findHistoryItem(id);
    if (!item) return;
    if (!item.pin) {
      item.pin = {};
    } else if (typeof item.pin.number === 'number') {
      delete item.pin.number;
    } else {
      item.pin = null;
    }
    item.updatedAt = Date.now();
    if (item.pin) item.pin.updatedAt = Date.now();
    saveHistory();
  });

  ipcMain.handle('numpad-assign', (_, id, slot) => {
    const item = findHistoryItem(id);
    if (typeof slot !== 'number' || slot < 1 || slot > 9 || !item) return;
    // Strip the slot from any other item without unpinning them.
    for (const h of history) {
      if (hasNumpadSlot(h, slot)) {
        delete h.pin.number;
        h.pin.updatedAt = Date.now();
        h.updatedAt = h.pin.updatedAt;
      }
    }
    const pin = ensurePin(item);
    pin.number = slot;
    pin.updatedAt = Date.now();
    item.updatedAt = pin.updatedAt;
    saveHistory();
  });

  ipcMain.handle('numpad-unassign', (_, slot) => {
    if (typeof slot !== 'number' || slot < 1 || slot > 9) return;
    for (const h of history) {
      if (hasNumpadSlot(h, slot)) {
        delete h.pin.number;
        h.pin.updatedAt = Date.now();
        h.updatedAt = h.pin.updatedAt;
        saveHistory();
        break;
      }
    }
  });

  ipcMain.handle('save-settings', (_, body) => {
    if (body.max_age_days !== undefined) settings.max_age_days = Math.max(1, parseInt(body.max_age_days));
    if (body.max_size_gb !== undefined) settings.max_size_gb = Math.max(0.1, parseFloat(body.max_size_gb));
    if (body.regex_search !== undefined) settings.regex_search = !!body.regex_search;
    saveSettingsFile();
    pruneHistory();
  });

  ipcMain.handle('group-create', (_, name) => {
    if (!name) return;
    if (!settings.groups) settings.groups = [];
    settings.group_tombstones = normalizeGroupTombstones(settings.group_tombstones)
      .filter(t => t.name !== name);
    if (!settings.groups.includes(name)) {
      settings.groups.push(name);
      saveSettingsFile();
    } else {
      saveSettingsFile();
    }
  });

  ipcMain.handle('group-delete', (_, name) => {
    const groups = settings.groups || [];
    const idx = groups.indexOf(name);
    if (idx >= 0) {
      addGroupTombstone(name);
      groups.splice(idx, 1);
      for (const h of history) {
        if (h.pin && h.pin.groups) {
          h.pin.groups = h.pin.groups.filter(g => g !== name);
          if (h.pin.groups.length === 0) delete h.pin.groups;
          h.pin.updatedAt = Date.now();
          h.updatedAt = h.pin.updatedAt;
        }
      }
      saveSettingsFile();
      saveHistory();
    }
  });

  // Toggle membership in a group. Multi-group: an item can belong to many.
  // Adding to any group implicitly pins the item (creates pin object).
  ipcMain.handle('group-assign', (_, id, group) => {
    const item = findHistoryItem(id);
    if (!item || !group) return;
    const pin = ensurePin(item);
    if (!pin.groups) pin.groups = [];
    const gIdx = pin.groups.indexOf(group);
    if (gIdx >= 0) {
      pin.groups.splice(gIdx, 1);
      if (pin.groups.length === 0) delete pin.groups;
    } else {
      pin.groups.push(group);
    }
    pin.updatedAt = Date.now();
    item.updatedAt = pin.updatedAt;
    saveHistory();
  });

  ipcMain.handle('copy-image-path', (_, id) => {
    const item = findHistoryItem(id);
    if (!item || item.type !== 'image') return { path: null };
    const fname = item.image;
    const src = path.join(IMG_DIR, fname);
    if (!fs.existsSync(src)) return { path: null };
    const dest = path.join(os.homedir(), 'Downloads', fname);
    fs.copyFileSync(src, dest);
    clipboard.writeText(dest);
    return { path: dest };
  });

  ipcMain.handle('open-editor', (_, id) => {
    openEditor(id);
  });

  ipcMain.handle('open-image', (_, id) => {
    const item = findHistoryItem(id);
    if (!item || item.type !== 'image') return;
    const imgPath = path.join(IMG_DIR, item.image);
    if (fs.existsSync(imgPath)) shell.openPath(imgPath);
  });

  ipcMain.handle('set-sync-path', (_, syncPath) => {
    settings.sync_path = syncPath || '';
    saveSettingsFile();
    if (syncPath) {
      // Ensure the sync directory exists
      if (!fs.existsSync(syncPath)) fs.mkdirSync(syncPath, { recursive: true });
      lastSyncMtime = 0; // force next sync
      syncMerge();
    }
  });

  ipcMain.handle('get-cloud-accounts', () => getCloudAccounts());

  ipcMain.handle('sync-now', () => {
    lastSyncMtime = 0;
    syncMerge();
  });

  ipcMain.handle('get-auto-launch', () => {
    return getAutoLaunchEnabled();
  });

  ipcMain.handle('set-auto-launch', (_, enabled) => {
    setAutoLaunchEnabled(enabled);
  });
}

// --- Global shortcuts ---
let windowsHook = null;

function handleNumpad(slot) {
  if (win && win.isVisible()) {
    // Popup open: assign numpad to selected item
    win.webContents.executeJavaScript(`window.assignNumpad(${slot})`).catch(() => {});
  } else {
    // Popup closed: quick-paste from slot
    numpadPaste(slot);
  }
}

function registerShortcuts() {
  if (process.platform === 'win32') {
    // Windows Clipboard History owns Win+V and Win+Numpad1-9, so we can't use
    // Electron's globalShortcut (RegisterHotKey) here — it silently fails.
    // Instead, install a WH_KEYBOARD_LL hook on a dedicated worker thread that
    // intercepts these keys *before* Windows Clipboard History sees them.
    const { install } = require('./lib/windows-hook');
    windowsHook = install({
      onShowPopup: showPopup,
      onNumpadPaste: handleNumpad,
    });
    // Seed the shared state with current history so plain numpad keys
    // immediately intercept for already-assigned slots.
    syncHookState();
    return;
  }

  // macOS / Linux: Electron globalShortcut works
  const showKey = 'CommandOrControl+Shift+V';
  globalShortcut.register(showKey, showPopup);

  for (let n = 1; n <= 9; n++) {
    const key = `Super+num${n}`;
    const slot = n;
    const registered = globalShortcut.register(key, () => handleNumpad(slot));
    if (!registered) console.log(`Warning: Could not register ${key}`);
  }
}

// --- Single instance lock ---
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  console.log('Another instance is already running. Quitting.');
  app.quit();
}
app.on('second-instance', () => {
  // If user tries to start again, show the popup
  showPopup();
});

// --- Custom protocol for serving clipboard images ---
protocol.registerSchemesAsPrivileged([
  { scheme: 'clip-img', privileges: { bypassCSP: true, supportFetchAPI: true, standard: true, secure: true } }
]);

// --- App lifecycle ---
app.whenReady().then(() => {
  protocol.handle('clip-img', (request) => {
    const url = new URL(request.url);
    const fname = decodeURIComponent(url.hostname + url.pathname).replace(/^\/+/, '').replace(/\/+$/, '');
    const filePath = path.join(IMG_DIR, fname);
    try {
      const data = fs.readFileSync(filePath);
      return new Response(data, { headers: { 'Content-Type': 'image/png' } });
    } catch {
      return new Response('Not found', { status: 404 });
    }
  });

  if (process.platform === 'darwin') app.dock.hide();

  migrateNumpad();
  setupIPC();
  createPopup();
  createTray();
  registerShortcuts();

  // Sync with shared folder on startup + every 30s
  syncMerge();
  pollClipboard();
  setInterval(pollClipboard, 400);
  setInterval(syncMerge, 30000);

  const hotkey = process.platform === 'darwin' ? 'Cmd+Shift+V' : 'Win+V';
  console.log(`Clipboard Tray running. ${hotkey} to open popup.`);
});

app.on('will-quit', () => {
  globalShortcut.unregisterAll();
  if (windowsHook) windowsHook.uninstall();
});
app.on('window-all-closed', () => { /* keep running as tray app */ });
