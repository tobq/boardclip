const { app, BrowserWindow, Tray, Menu, globalShortcut, clipboard, nativeImage,
        ipcMain, protocol, screen, shell, nativeTheme, dialog } = require('electron');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const os = require('os');
const http = require('http');
const dgram = require('dgram');
const { exec, spawn } = require('child_process');

// Windows-specific fast input (keybd_event, Get/SetForegroundWindow).
// Module is a no-op on non-Windows platforms so it's safe to require unconditionally.
const winPaste = require('./lib/windows-paste');
const getBuildInfo = require('./lib/build-info');
const getCloudAccounts = require('./lib/cloud-accounts');
const blobStore = require('./lib/blob-store');
const clipboardModel = require('./lib/clipboard-model');
const clipboardCapture = require('./lib/clipboard-capture');
const textBlobStore = require('./lib/text-blob-store');
const { createAutoUpdater, updateSupport } = require('./lib/auto-update');
const syncPaths = require('./lib/sync-paths');
const { Diagnostics } = require('./lib/diagnostics');

function guardBrokenPipe(stream) {
  try {
    stream.on('error', err => {
      if (!err || err.code === 'EPIPE') return;
    });
  } catch {}
}

function logSafe(...args) {
  try { console.log(...args); } catch {}
}

guardBrokenPipe(process.stdout);
guardBrokenPipe(process.stderr);
for (const method of ['log', 'warn', 'error']) {
  const original = console[method].bind(console);
  console[method] = (...args) => {
    try { original(...args); } catch {}
  };
}

app.setName('BoardClip');

// --- Paths ---
const SCRIPT_DIR = __dirname;
const DATA_DIR = app.isPackaged ? app.getPath('userData') : SCRIPT_DIR;
const DB_PATH = path.join(DATA_DIR, 'clipboard-history.json');
const SETTINGS_PATH = path.join(DATA_DIR, 'clipboard-settings.json');
const IMG_DIR = path.join(DATA_DIR, 'clipboard-images');
const TEXT_DIR = path.join(DATA_DIR, textBlobStore.TEXT_BLOB_DIRNAME);
const HISTORY_BACKUP_DIR = path.join(DATA_DIR, 'clipboard-backups');
const APP_ICON_PATH = path.join(SCRIPT_DIR, 'icon.png');
const DIAGNOSTICS_PATH = path.join(DATA_DIR, 'boardclip-diagnostics.jsonl');
const HISTORY_BACKUP_MAX_FILES = 100;
const HISTORY_BACKUP_MIN_INTERVAL_MS = 60 * 1000;
const IMAGE_ORPHAN_RECOVERY_WINDOW_MS = 30 * 60 * 1000;
const IMAGE_ORPHAN_RECOVERY_MAX_FILES = 20;
const SYNC_REMOTE_WRITE_TIMEOUT_MS = 8000;
const CONTENT_IMAGE_RE = /^([a-f0-9]{12})(?: \(\d+\))?\.png$/i;
const P2P_DISCOVERY_ADDR = '239.255.43.21';
const P2P_DISCOVERY_PORT = 45454;
const P2P_PROTOCOL_VERSION = 1;
const P2P_ANNOUNCE_INTERVAL_MS = 2000;
const P2P_PULL_THROTTLE_MS = 1000;
const P2P_HTTP_TIMEOUT_MS = 5000;
const P2P_AUTH_WINDOW_MS = 60 * 1000;

function windowsStartupDir() {
  const appData = process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming');
  return path.join(appData, 'Microsoft', 'Windows', 'Start Menu', 'Programs', 'Startup');
}

function windowsDevStartupScriptPath() {
  return path.join(windowsStartupDir(), 'BoardClip.vbs');
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
  for (const name of ['ClipboardTray.lnk', 'clipboard-tray.lnk', 'clipboard_numpad.lnk', 'Clipboard Tray.vbs', 'Clippy.vbs']) {
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
if (!fs.existsSync(TEXT_DIR)) fs.mkdirSync(TEXT_DIR, { recursive: true });

let BUILD_INFO = getBuildInfo(SCRIPT_DIR);

function refreshBuildInfo() {
  BUILD_INFO = getBuildInfo(SCRIPT_DIR);
  return BUILD_INFO;
}

async function reloadRendererAfterUpdate() {
  refreshBuildInfo();
  refreshTray();
  if (!win || win.isDestroyed() || !win.webContents || win.webContents.isDestroyed()) return;
  await new Promise((resolve) => {
    const timer = setTimeout(resolve, 2000);
    if (timer.unref) timer.unref();
    win.webContents.once('did-finish-load', () => {
      clearTimeout(timer);
      resolve();
    });
    win.webContents.reloadIgnoringCache();
  });
  await resetPopupRendererState();
}

function relaunchAfterUpdate() {
  app.relaunch();
  app.exit(0);
}

const autoUpdater = createAutoUpdater({
  appDir: SCRIPT_DIR,
  buildInfo: BUILD_INFO,
  onReload: reloadRendererAfterUpdate,
  onRelaunch: relaunchAfterUpdate,
  onBuildInfoChanged: refreshBuildInfo,
});

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
const DEFAULT_PRESET_SEED_AT_MS = 1;

// --- Settings ---
const DEFAULT_SETTINGS = clipboardModel.DEFAULT_SETTINGS;

function atomicWriteFile(filePath, data) {
  blobStore.atomicWriteFile(filePath, data);
}

function atomicWriteJson(filePath, value, spacing) {
  atomicWriteFile(filePath, JSON.stringify(value, null, spacing));
}

let lastHistoryBackupAt = 0;
let lastHistoryBackupHash = '';

function historyContentHash(historyJson, settingsJson = '') {
  return crypto.createHash('sha256').update(historyJson).update('\0').update(settingsJson || '').digest('hex');
}

function slotFingerprintFromItems(items) {
  const slots = {};
  for (const item of Array.isArray(items) ? items : []) {
    const slot = numpadSlotOf(item);
    if (slot != null) slots[slot] = itemKey(item);
  }
  return JSON.stringify(slots);
}

function pruneHistoryBackups() {
  let files = [];
  try {
    files = fs.readdirSync(HISTORY_BACKUP_DIR)
      .filter(name => name.endsWith('.json'))
      .map(name => {
        const filePath = path.join(HISTORY_BACKUP_DIR, name);
        try { return { name, filePath, mtimeMs: fs.statSync(filePath).mtimeMs }; } catch { return null; }
      })
      .filter(Boolean)
      .sort((a, b) => b.mtimeMs - a.mtimeMs);
  } catch { return; }

  for (const file of files.slice(HISTORY_BACKUP_MAX_FILES)) {
    try { fs.rmSync(file.filePath, { force: true }); } catch {}
  }
}

function maybeBackupHistoryBeforeWrite(nextStoredHistory) {
  let currentHistoryJson = '';
  try { currentHistoryJson = fs.readFileSync(DB_PATH, 'utf-8'); } catch { return; }
  if (!currentHistoryJson) return;

  let currentSettingsJson = '';
  try { currentSettingsJson = fs.readFileSync(SETTINGS_PATH, 'utf-8'); } catch {}

  const contentHash = historyContentHash(currentHistoryJson, currentSettingsJson);
  if (contentHash === lastHistoryBackupHash) return;

  let currentHistory = [];
  try {
    const parsed = JSON.parse(currentHistoryJson);
    currentHistory = Array.isArray(parsed) ? parsed : [];
  } catch { return; }

  const currentSlots = slotFingerprintFromItems(currentHistory);
  const nextSlots = slotFingerprintFromItems(nextStoredHistory);
  const slotChanged = currentSlots !== nextSlots;
  const now = Date.now();
  if (!slotChanged && now - lastHistoryBackupAt < HISTORY_BACKUP_MIN_INTERVAL_MS) return;

  let currentSettings = null;
  try { currentSettings = currentSettingsJson ? JSON.parse(currentSettingsJson) : null; } catch {}

  const reason = slotChanged ? 'slots' : 'periodic';
  const stamp = new Date(now).toISOString().replace(/[:.]/g, '-');
  const backupPath = path.join(HISTORY_BACKUP_DIR, `${stamp}-${reason}-${contentHash.slice(0, 12)}.json`);
  try {
    fs.mkdirSync(HISTORY_BACKUP_DIR, { recursive: true });
    atomicWriteJson(backupPath, {
      createdAt: new Date(now).toISOString(),
      reason,
      source: {
        historyPath: DB_PATH,
        settingsPath: SETTINGS_PATH,
        historyHash: contentHash,
        slotChanged,
        currentSlots,
        nextSlots,
      },
      history: currentHistory,
      settings: currentSettings,
    });
    lastHistoryBackupAt = now;
    lastHistoryBackupHash = contentHash;
    pruneHistoryBackups();
  } catch {}
}

async function atomicWriteFileAsync(filePath, data) {
  const tmpPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  await fs.promises.writeFile(tmpPath, data);
  await fs.promises.rename(tmpPath, filePath);
}

function loadSettings() {
  try {
    return { ...DEFAULT_SETTINGS, ...JSON.parse(fs.readFileSync(SETTINGS_PATH, 'utf-8')) };
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}

function saveSettingsFile() {
  const startedAt = Date.now();
  const previousDiagnosticsEnabled = diagnostics.isEnabled();
  migrateSyncSettings();
  const s = { ...settings };
  s.tombstones = normalizeTombstones(s.tombstones);
  s.group_tombstones = normalizeGroupTombstones(s.group_tombstones);
  settings.tombstones = s.tombstones;
  settings.group_tombstones = s.group_tombstones;
  delete s.numpad_slots;
  atomicWriteJson(SETTINGS_PATH, s, 2);
  diagnostics.setEnabled(process.env.BOARDCLIP_DIAGNOSTICS === '1' || !!settings.diagnostics_enabled);
  diagnostics.slow('settings.save.slow', Date.now() - startedAt, {
    bytes: Buffer.byteLength(JSON.stringify(s)),
    diagnostics_changed: previousDiagnosticsEnabled !== diagnostics.isEnabled(),
  }, 50);
  dataRevision++;
  p2pNotifyLocalChange();
  notifyDataChanged();
  scheduleSyncMerge();
}

let settings = loadSettings();
const diagnostics = new Diagnostics({
  filePath: DIAGNOSTICS_PATH,
  enabled: process.env.BOARDCLIP_DIAGNOSTICS === '1' || !!settings.diagnostics_enabled,
});
let dataRevision = 0;
let cloudAccountsCache = [];
let cloudAccountsCacheAt = 0;
const CLOUD_ACCOUNTS_CACHE_TTL_MS = 5 * 60 * 1000;
const DEFAULT_SHOW_SHORTCUT = 'CommandOrControl+Shift+V';
let diagnosticsLoopExpectedAt = 0;
let diagnosticsCpu = process.cpuUsage();

function ensureP2PIdentity() {
  let changed = false;
  if (!settings.p2p_device_id) {
    settings.p2p_device_id = crypto.randomBytes(16).toString('hex');
    changed = true;
  }
  if (!settings.p2p_secret) {
    settings.p2p_secret = crypto.randomBytes(32).toString('hex');
    changed = true;
  }
  if (settings.p2p_enabled === undefined) {
    settings.p2p_enabled = true;
    changed = true;
  }
  return changed;
}

const p2pIdentityInitialized = ensureP2PIdentity();
if (p2pIdentityInitialized) {
  process.nextTick(() => {
    try { saveSettingsFile(); } catch {}
  });
}

function runtimeDiagnosticSnapshot() {
  const memory = process.memoryUsage();
  return {
    platform: process.platform,
    build: BUILD_INFO && BUILD_INFO.label,
    pid: process.pid,
    uptime_s: Math.round(process.uptime()),
    rss_mb: Math.round(memory.rss / 1048576),
    heap_used_mb: Math.round(memory.heapUsed / 1048576),
    history_items: history ? history.length : 0,
    groups: settings.groups ? settings.groups.length : 0,
    diagnostics_enabled: diagnostics.isEnabled(),
  };
}

function startDiagnosticsMonitor() {
  diagnostics.record('app.start', runtimeDiagnosticSnapshot(), { forceFile: true });
  diagnosticsLoopExpectedAt = Date.now() + 1000;
  const timer = setInterval(() => {
    const now = Date.now();
    const lag = now - diagnosticsLoopExpectedAt;
    diagnosticsLoopExpectedAt = now + 1000;
    const cpu = process.cpuUsage();
    const cpuDeltaUs = (cpu.user - diagnosticsCpu.user) + (cpu.system - diagnosticsCpu.system);
    diagnosticsCpu = cpu;
    const forceFile = lag > 250 || cpuDeltaUs > 800000;
    if (forceFile || diagnostics.isEnabled()) {
      diagnostics.record('main.heartbeat', {
        ...runtimeDiagnosticSnapshot(),
        event_loop_lag_ms: Math.max(0, Math.round(lag)),
        cpu_ms_last_s: Math.round(cpuDeltaUs / 1000),
      }, { forceFile });
    }
  }, 1000);
  if (timer.unref) timer.unref();
}

function defaultShowShortcut() {
  return process.platform === 'win32' ? 'Super+V' : DEFAULT_SHOW_SHORTCUT;
}

function defaultQuickPasteShortcut() {
  if (process.platform === 'darwin') return 'Command+Option+1';
  return '';
}

function effectiveShowShortcut() {
  return settings.show_shortcut || defaultShowShortcut();
}

function effectiveQuickPasteShortcut() {
  return settings.quick_paste_shortcut || defaultQuickPasteShortcut();
}

function globalShowShortcut() {
  if (process.platform === 'darwin' && shortcutUsesFn(settings.show_shortcut)) return '';
  return settings.show_shortcut || (process.platform === 'win32' ? '' : DEFAULT_SHOW_SHORTCUT);
}

function globalQuickPasteShortcut() {
  const shortcut = effectiveQuickPasteShortcut();
  if (shortcutUsesFn(shortcut)) return '';
  return shortcut;
}

function normalizeShowShortcut(shortcut) {
  const value = String(shortcut || '').trim();
  if (process.platform === 'win32' && value === defaultShowShortcut()) return '';
  if (process.platform !== 'win32' && value === DEFAULT_SHOW_SHORTCUT) return '';
  return value;
}

function normalizeQuickPasteShortcut(shortcut) {
  const value = String(shortcut || '').trim();
  if (!value || value === defaultQuickPasteShortcut()) return '';
  return value;
}

function shortcutUsesFn(shortcut) {
  return String(shortcut || '').split('+').some(part => {
    const value = part.trim().toLowerCase();
    return value === 'fn' || value === 'globe' || value === 'function';
  });
}

function shortcutHasKeyAndModifier(shortcut) {
  const parts = String(shortcut || '').split('+').map(p => p.trim()).filter(Boolean);
  const primaryModifiers = new Set([
    'commandorcontrol', 'commandorctrl', 'cmdorctrl',
    'command', 'cmd', 'control', 'ctrl', 'alt', 'option',
    'super', 'meta', 'fn', 'globe', 'function',
  ]);
  const allModifiers = new Set([...primaryModifiers, 'shift']);
  return parts.some(part => primaryModifiers.has(part.toLowerCase())) &&
         parts.some(part => !allModifiers.has(part.toLowerCase()));
}

function quickPasteSlotFromShortcut(shortcut) {
  const parts = String(shortcut || '').split('+').map(p => p.trim()).filter(Boolean);
  const key = parts[parts.length - 1] || '';
  const match = /^(?:num)?([1-9])$/i.exec(key);
  return match ? Number(match[1]) : null;
}

function quickPasteShortcutForSlot(shortcut, slot) {
  const parts = String(shortcut || '').split('+').map(p => p.trim()).filter(Boolean);
  if (!parts.length) return '';
  const keyIndex = parts.length - 1;
  if (quickPasteSlotFromShortcut(parts[keyIndex]) == null) return '';
  parts[keyIndex] = String(slot);
  return parts.join('+');
}

function normalizeSyncPath(syncPath) {
  return syncPaths.normalizeSyncPath(syncPath);
}

function migrateSyncSettings() {
  syncPaths.migrateSyncSettings(settings);
}

migrateSyncSettings();

function notifyDataChanged() {
  if (!win || win.isDestroyed() || !win.webContents || win.webContents.isDestroyed()) return;
  win.webContents.send('history-changed', dataRevision);
}

// --- History ---
function loadHistory() {
  try {
    const loaded = JSON.parse(fs.readFileSync(DB_PATH, 'utf-8'));
    return textBlobStore.hydrateHistory(Array.isArray(loaded) ? loaded : [], TEXT_DIR);
  } catch {
    return [];
  }
}

function writeHistoryStorageFile() {
  for (const item of history) ensureItemId(item);
  const storedHistory = textBlobStore.prepareHistoryForStorage(history, TEXT_DIR);
  maybeBackupHistoryBeforeWrite(storedHistory);
  atomicWriteJson(DB_PATH, storedHistory);
}

function saveHistory() {
  const startedAt = Date.now();
  writeHistoryStorageFile();
  diagnostics.slow('history.save.slow', Date.now() - startedAt, {
    items: history.length,
    file_bytes: fileSummary(DB_PATH).size || 0,
  }, 75);
  dataRevision++;
  p2pNotifyLocalChange();
  notifyDataChanged();
  scheduleSyncMerge();
  syncHookState();
}

// Reflect current history state into the Windows hook's shared buffer so the
// hook worker can synchronously decide whether closed-popup plain numpad
// presses should quick-paste assigned slots.
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

function clonePin(pin) {
  if (!pin) return pin;
  return {
    ...pin,
    groups: Array.isArray(pin.groups) ? [...pin.groups] : pin.groups,
  };
}

function updateTextItem(item, text) {
  if (!item || item.type === 'image') return null;
  const oldId = itemKey(item);
  const now = Date.now();
  const next = { ...item, text: text || '', updatedAt: now };
  textBlobStore.setInlineText(next, text);
  next.id = legacyContentKey(next);
  if (numpadSlotOf(next) != null) touchPinNumber(next, now);

  const existingIdx = history.findIndex(h => h !== item && itemKey(h) === next.id);
  if (existingIdx >= 0) {
    const existing = history[existingIdx];
    textBlobStore.setInlineText(existing, next.text);
    existing.ts = Math.max(existing.ts || 0, next.ts || 0);
    const existingPinUpdated = clipboardModel.pinUpdatedAt(existing);
    const nextPinUpdated = clipboardModel.pinUpdatedAt(next);
    existing.updatedAt = Math.max(existing.updatedAt || 0, next.updatedAt || 0);
    existing.pin = mergePins(existing.pin, next.pin, existingPinUpdated, nextPinUpdated);
    existing.pinUpdatedAt = Math.max(existingPinUpdated, nextPinUpdated) || undefined;
    const oldIdx = history.indexOf(item);
    if (oldIdx >= 0) history.splice(oldIdx, 1);
    addTombstone(oldId);
    return existing;
  }

  textBlobStore.setInlineText(item, next.text);
  item.id = next.id;
  item.updatedAt = next.updatedAt;
  if (numpadSlotOf(item) != null) touchPinNumber(item, now);
  if (oldId !== item.id) addTombstone(oldId);
  return item;
}

function getStorageBytes() {
  let total = 0;
  try { total = fs.statSync(DB_PATH).size; } catch {}
  return total + blobStore.directoryBytes(IMG_DIR) + blobStore.directoryBytes(TEXT_DIR);
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
  textBlobStore.removeLocalBlobIfUnreferenced(item, history, TEXT_DIR);
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
    const result = clipboardModel.migrateLegacyNumpadSlots(history, oldSlots, { now: Date.now() });
    delete settings.numpad_slots;
    if (result.changed) saveHistory();
    saveSettingsFile();
  } else if (!history.length) {
    for (const num of [9, 8, 7, 6, 5, 4, 3, 2, 1]) {
      if (AHK_PRESETS[num]) {
        const seededAt = DEFAULT_PRESET_SEED_AT_MS;
        history.unshift({ type: 'text', text: AHK_PRESETS[num], ts: seededAt / 1000, updatedAt: seededAt, pinUpdatedAt: seededAt, pin: { number: num, updatedAt: seededAt, numberUpdatedAt: seededAt } });
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

function tombstoneIds(list) {
  return clipboardModel.tombstoneIds(list);
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

function touchPin(item, now = Date.now()) {
  if (!item) return;
  item.updatedAt = now;
  item.pinUpdatedAt = now;
  if (item.pin) item.pin.updatedAt = now;
}

function touchPinNumber(item, now = Date.now()) {
  touchPin(item, now);
  if (item && item.pin) item.pin.numberUpdatedAt = now;
}

function touchPinGroups(item, now = Date.now()) {
  touchPin(item, now);
  if (item && item.pin) item.pin.groupsUpdatedAt = now;
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
  delete remoteSave.sync_custom_paths;
  delete remoteSave.sync_disabled_paths;
  delete remoteSave.show_shortcut;
  delete remoteSave.quick_paste_shortcut;
  delete remoteSave.p2p_device_id;
  return remoteSave;
}

function mergeSyncedSettings(remoteSettings) {
  if (!remoteSettings || typeof remoteSettings !== 'object') return false;
  const before = JSON.stringify(remoteSettingsPayload());
  settings.tombstones = normalizeTombstones([
    ...(settings.tombstones || []),
    ...(remoteSettings.tombstones || []),
  ]);
  settings.group_tombstones = normalizeGroupTombstones([
    ...(settings.group_tombstones || []),
    ...(remoteSettings.group_tombstones || []),
  ]);
  const secrets = [settings.p2p_secret, remoteSettings.p2p_secret].filter(Boolean).sort();
  if (secrets.length) settings.p2p_secret = secrets[0];
  if (remoteSettings.p2p_enabled !== undefined && settings.p2p_enabled === undefined) {
    settings.p2p_enabled = !!remoteSettings.p2p_enabled;
  }
  ensureP2PIdentity();
  return JSON.stringify(remoteSettingsPayload()) !== before;
}

function foldRemoteState(canonicalHistory, remoteHistory, remoteSettings) {
  mergeSyncedSettings(remoteSettings);
  const historyGroups = canonicalHistory.flatMap(h => groupsOf(h));
  settings.groups = mergeGroups(settings.groups, [...(remoteSettings && remoteSettings.groups || []), ...historyGroups]);
  return mergeHistories(canonicalHistory, remoteHistory);
}

async function refreshCloudAccounts() {
  cloudAccountsCache = await getCloudAccounts();
  cloudAccountsCacheAt = Date.now();
  return cloudAccountsCache;
}

async function getCachedCloudAccounts({ force = false } = {}) {
  if (
    force ||
    !cloudAccountsCacheAt ||
    Date.now() - cloudAccountsCacheAt > CLOUD_ACCOUNTS_CACHE_TTL_MS
  ) {
    return refreshCloudAccounts();
  }
  return cloudAccountsCache;
}

function addCustomSyncPath(syncPath) {
  return syncPaths.addCustomSyncPath(settings, syncPath);
}

function syncAccountsWithCustom(accounts) {
  return syncPaths.syncAccountsWithCustom(settings, accounts);
}

async function getCloudAccountsForSettings() {
  const accounts = syncAccountsWithCustom(await getCachedCloudAccounts({ force: true }));
  const disabled = syncDisabledPathSet();
  return accounts.map(acc => ({ ...acc, enabled: !disabled.has(normalizeSyncPath(acc.path)) }));
}

async function getEnabledSyncPaths() {
  const accounts = syncAccountsWithCustom(await getCachedCloudAccounts());
  const disabled = syncDisabledPathSet();
  return accounts
    .map(acc => normalizeSyncPath(acc.path))
    .filter(syncPath => syncPath && !disabled.has(syncPath));
}

function syncDisabledPathSet() {
  return syncPaths.syncDisabledPathSet(settings);
}

async function setSyncPathEnabled(syncPath, enabled) {
  const normalized = normalizeSyncPath(syncPath);
  if (!normalized) return;
  const disabled = syncDisabledPathSet();
  if (enabled) disabled.delete(normalized);
  else disabled.add(normalized);
  settings.sync_disabled_paths = [...disabled];
  saveSettingsFile();
  if (enabled) {
    try {
      if (!fs.existsSync(normalized)) fs.mkdirSync(normalized, { recursive: true });
    } catch {}
    await syncMerge({ force: true });
  }
}

async function copyMissingFilesAsync(fromDir, toDir, filter = () => true) {
  try { await fs.promises.mkdir(toDir, { recursive: true }); } catch { return; }
  let names = [];
  try { names = await fs.promises.readdir(fromDir); } catch { return; }
  for (const name of names) {
    if (!filter(name)) continue;
    const source = path.join(fromDir, name);
    const dest = path.join(toDir, name);
    try {
      const stats = await fs.promises.stat(source);
      if (!stats.isFile()) continue;
      try {
        await fs.promises.access(dest, fs.constants.F_OK);
      } catch {
        await fs.promises.copyFile(source, dest);
      }
    } catch {}
  }
}

async function syncMissingFilesAsync(localDir, remoteDir, filter) {
  await copyMissingFilesAsync(remoteDir, localDir, filter);
  await copyMissingFilesAsync(localDir, remoteDir, filter);
}

async function syncRemoteAssets(remoteImgDir, remoteTextDir) {
  await Promise.all([
    syncMissingFilesAsync(IMG_DIR, remoteImgDir),
    syncMissingFilesAsync(TEXT_DIR, remoteTextDir, name => !!textBlobStore.safeTextRef(name)),
  ]);
}

function pngSizeFromBuffer(buf) {
  if (
    !Buffer.isBuffer(buf) ||
    buf.length < 24 ||
    buf[0] !== 0x89 ||
    buf[1] !== 0x50 ||
    buf[2] !== 0x4e ||
    buf[3] !== 0x47 ||
    buf[12] !== 0x49 ||
    buf[13] !== 0x48 ||
    buf[14] !== 0x44 ||
    buf[15] !== 0x52
  ) {
    return null;
  }
  return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
}

async function canonicalizeRecoveredImage(name) {
  const match = CONTENT_IMAGE_RE.exec(name || '');
  if (!match) return null;
  const hash = match[1].toLowerCase();
  const canonical = `${hash}.png`;
  const source = path.join(IMG_DIR, name);
  const target = path.join(IMG_DIR, canonical);
  if (name !== canonical) {
    try {
      await fs.promises.access(target, fs.constants.F_OK);
    } catch {
      try { await fs.promises.copyFile(source, target); } catch { return null; }
    }
  }
  return canonical;
}

async function recoverRecentOrphanImages(items) {
  const now = Date.now();
  let names = [];
  try { names = await fs.promises.readdir(IMG_DIR); } catch { return 0; }
  const known = new Set((Array.isArray(items) ? items : [])
    .filter(item => item && item.type === 'image' && item.image)
    .map(item => item.image));
  const deleted = tombstoneIds(settings.tombstones);
  const candidates = [];

  for (const name of names) {
    const canonical = await canonicalizeRecoveredImage(name);
    if (!canonical || known.has(canonical) || deleted.has(`img:${canonical}`)) continue;
    try {
      const stats = await fs.promises.stat(path.join(IMG_DIR, canonical));
      if (!stats.isFile() || now - stats.mtimeMs > IMAGE_ORPHAN_RECOVERY_WINDOW_MS) continue;
      candidates.push({ canonical, mtimeMs: stats.mtimeMs });
    } catch {}
  }

  candidates.sort((a, b) => b.mtimeMs - a.mtimeMs);
  let recovered = 0;
  for (const candidate of candidates.slice(0, IMAGE_ORPHAN_RECOVERY_MAX_FILES)) {
    try {
      const header = await fs.promises.readFile(path.join(IMG_DIR, candidate.canonical), { start: 0, end: 31 });
      const size = pngSizeFromBuffer(header) || { width: 0, height: 0 };
      const item = {
        type: 'image',
        image: candidate.canonical,
        ts: candidate.mtimeMs / 1000,
        width: size.width,
        height: size.height,
        id: `img:${candidate.canonical}`,
        pin: null,
      };
      items.unshift(item);
      known.add(candidate.canonical);
      recovered++;
    } catch {}
  }
  if (recovered) {
    items.sort((a, b) => (b.ts || 0) - (a.ts || 0));
    diagnostics.record('sync.recover_orphan_images', { recovered, items: items.length });
  }
  return recovered;
}

let syncDebounceTimer = null;
let insideSync = false;
let applyingSyncState = false;
let syncDirtyVersion = 0;
let syncedDirtyVersion = 0;
let syncPending = false;
let syncPendingForce = false;
let lastSyncResult = null;
const syncIdleWaiters = [];
let lastFullSyncAt = 0;
const SYNC_FULL_INTERVAL_MS = 5 * 60 * 1000;
const syncProviderCache = new Map();

function scheduleSyncMerge() {
  if (applyingSyncState) return;
  syncDirtyVersion++;
  if (insideSync) {
    syncPending = true;
    return;
  }
  if (syncDebounceTimer) clearTimeout(syncDebounceTimer);
  syncDebounceTimer = setTimeout(syncMerge, 500);
}

async function fileSignature(filePath) {
  try {
    const stats = await fs.promises.stat(filePath);
    return { exists: true, size: stats.size, mtimeMs: Math.round(stats.mtimeMs) };
  } catch {
    return { exists: false, size: 0, mtimeMs: 0 };
  }
}

async function directorySignature(dirPath) {
  try {
    const stats = await fs.promises.stat(dirPath);
    return { exists: true, mtimeMs: Math.round(stats.mtimeMs) };
  } catch {
    return { exists: false, mtimeMs: 0 };
  }
}

async function syncProviderSignature(syncPath) {
  const [history, settingsFile, images] = await Promise.all([
    fileSignature(path.join(syncPath, 'clipboard-history.json')),
    fileSignature(path.join(syncPath, 'clipboard-settings.json')),
    directorySignature(path.join(syncPath, 'clipboard-images')),
  ]);
  return {
    history,
    settings: settingsFile,
    images,
  };
}

function syncProviderSignatureKey(signature) {
  return JSON.stringify(signature);
}

function waitForSyncIdle() {
  if (!insideSync && !syncPending) return Promise.resolve(lastSyncResult);
  return new Promise(resolve => syncIdleWaiters.push(resolve));
}

function resolveSyncIdle(result) {
  if (insideSync || syncPending || !syncIdleWaiters.length) return;
  const waiters = syncIdleWaiters.splice(0);
  for (const resolve of waiters) resolve(result);
}

async function updateSyncProviderCache(syncPath) {
  const signature = await syncProviderSignature(syncPath);
  syncProviderCache.set(syncPath, {
    signature,
    signatureKey: syncProviderSignatureKey(signature),
    checkedAt: Date.now(),
  });
}

async function readRemoteState(syncPath) {
  const remoteDbPath = path.join(syncPath, 'clipboard-history.json');
  const remoteSettingsPath = path.join(syncPath, 'clipboard-settings.json');
  let remoteHistory = [];
  try {
    const loaded = JSON.parse(await fs.promises.readFile(remoteDbPath, 'utf-8'));
    if (Array.isArray(loaded)) remoteHistory = textBlobStore.hydrateHistory(loaded, TEXT_DIR);
  } catch {}
  let remoteSettings = {};
  try { remoteSettings = JSON.parse(await fs.promises.readFile(remoteSettingsPath, 'utf-8')); } catch {}
  return { remoteHistory, remoteSettings };
}

function safeReadJson(filePath, fallback) {
  try { return JSON.parse(fs.readFileSync(filePath, 'utf-8')); } catch { return fallback; }
}

function fileSummary(filePath) {
  try {
    const stats = fs.statSync(filePath);
    return { exists: true, mtime: stats.mtime.toISOString(), size: stats.size };
  } catch {
    return { exists: false };
  }
}

function groupCountsFromHistory(items) {
  const counts = new Map();
  for (const item of Array.isArray(items) ? items : []) {
    const groups = item && item.pin && Array.isArray(item.pin.groups) ? item.pin.groups : [];
    for (const group of groups) counts.set(group, (counts.get(group) || 0) + 1);
  }
  return Object.fromEntries([...counts.entries()].sort((a, b) => a[0].localeCompare(b[0])));
}

function stateSummary(basePath) {
  const settingsPath = path.join(basePath, 'clipboard-settings.json');
  const historyPath = path.join(basePath, 'clipboard-history.json');
  const remoteSettings = safeReadJson(settingsPath, {});
  const remoteHistory = safeReadJson(historyPath, []);
  return {
    base_path: basePath,
    settings_file: fileSummary(settingsPath),
    history_file: fileSummary(historyPath),
    text_dir: fileSummary(path.join(basePath, textBlobStore.TEXT_BLOB_DIRNAME)),
    item_count: Array.isArray(remoteHistory) ? remoteHistory.length : null,
    settings_groups: Array.isArray(remoteSettings.groups) ? remoteSettings.groups : [],
    history_group_counts: groupCountsFromHistory(remoteHistory),
    group_tombstones: normalizeGroupTombstones(remoteSettings.group_tombstones),
  };
}

async function syncDiagnostics() {
  const accounts = await getCloudAccountsForSettings();
  return {
    generated_at: new Date().toISOString(),
    platform: process.platform,
    app_dir: SCRIPT_DIR,
    data_dir: DATA_DIR,
    build: BUILD_INFO,
    runtime: runtimeDiagnosticSnapshot(),
    p2p: p2pStatus(),
    diagnostics: diagnostics.snapshot({
      log_tail: diagnostics.fileTail(),
    }),
    local: stateSummary(DATA_DIR),
    sync_disabled_paths: settings.sync_disabled_paths || [],
    legacy_sync_path: settings.sync_path || '',
    custom_sync_paths: settings.sync_custom_paths || [],
    accounts: accounts.map(acc => ({
      provider: acc.provider,
      label: acc.label,
      email: acc.email,
      enabled: !!acc.enabled,
      path: acc.path,
      state: stateSummary(acc.path),
    })),
  };
}

async function readFileUtf8IfExists(filePath) {
  try { return await fs.promises.readFile(filePath, 'utf-8'); } catch { return null; }
}

async function writeRemoteState(syncPath, canonicalHistory, canonicalSettings) {
  const startedAt = Date.now();
  try { await fs.promises.mkdir(syncPath, { recursive: true }); } catch {}
  const remoteDbPath = path.join(syncPath, 'clipboard-history.json');
  const remoteSettingsPath = path.join(syncPath, 'clipboard-settings.json');
  const remoteImgDir = path.join(syncPath, 'clipboard-images');
  const remoteTextDir = path.join(syncPath, textBlobStore.TEXT_BLOB_DIRNAME);
  const nextHistoryJson = JSON.stringify(textBlobStore.prepareHistoryForStorage(canonicalHistory, TEXT_DIR));
  const nextSettingsJson = JSON.stringify(canonicalSettings, null, 2);
  const [currentHistoryJson, currentSettingsJson] = await Promise.all([
    readFileUtf8IfExists(remoteDbPath),
    readFileUtf8IfExists(remoteSettingsPath),
  ]);
  const wroteHistory = currentHistoryJson !== nextHistoryJson;
  const wroteSettings = currentSettingsJson !== nextSettingsJson;
  await Promise.all([
    wroteHistory ? atomicWriteFileAsync(remoteDbPath, nextHistoryJson) : Promise.resolve(),
    wroteSettings ? atomicWriteFileAsync(remoteSettingsPath, nextSettingsJson) : Promise.resolve(),
    syncRemoteAssets(remoteImgDir, remoteTextDir),
  ]);
  await updateSyncProviderCache(syncPath);
  diagnostics.slow('sync.write_remote.slow', Date.now() - startedAt, {
    path: syncPath,
    items: canonicalHistory.length,
    history_bytes: Buffer.byteLength(nextHistoryJson),
    settings_bytes: Buffer.byteLength(nextSettingsJson),
    wrote_history: wroteHistory,
    wrote_settings: wroteSettings,
  }, 150);
}

function withTimeout(promise, ms, label) {
  let timer = null;
  return Promise.race([
    promise.finally(() => {
      if (timer) clearTimeout(timer);
    }),
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
      if (timer.unref) timer.unref();
    }),
  ]);
}

const p2p = {
  server: null,
  socket: null,
  port: 0,
  announceTimer: null,
  announceSoonTimer: null,
  peers: new Map(),
  pulls: new Map(),
  started: false,
  revision: 1,
};

function p2pEnabled() {
  return !!settings.p2p_enabled && !!settings.p2p_secret && !!settings.p2p_device_id;
}

function p2pDeviceName() {
  return os.hostname() || `${process.platform}-${settings.p2p_device_id.slice(0, 6)}`;
}

function p2pSecretHash() {
  return crypto.createHash('sha256').update(String(settings.p2p_secret || '')).digest('hex').slice(0, 16);
}

function p2pHmac(payload) {
  return crypto.createHmac('sha256', String(settings.p2p_secret || '')).update(payload).digest('hex');
}

function p2pSignature(method, requestPath, timestamp, bodyHash) {
  return p2pHmac(`${method}\n${requestPath}\n${timestamp}\n${bodyHash || ''}`);
}

function safeImageName(name) {
  const value = path.basename(String(name || '').trim());
  return CONTENT_IMAGE_RE.test(value) ? value.toLowerCase().replace(/ \(\d+\)(?=\.png$)/, '') : '';
}

function p2pHistoryStorage() {
  return textBlobStore.prepareHistoryForStorage(history, TEXT_DIR);
}

function p2pTextRefsFromHistory(items) {
  const refs = new Set();
  for (const item of Array.isArray(items) ? items : []) {
    const ref = textBlobStore.safeTextRef(item && item.textRef);
    if (ref) refs.add(ref);
  }
  return [...refs];
}

function p2pImageNamesFromHistory(items) {
  const names = new Set();
  for (const item of Array.isArray(items) ? items : []) {
    if (!item || item.type !== 'image') continue;
    const name = safeImageName(item.image);
    if (name) names.add(name);
  }
  return [...names];
}

function p2pStatePayload() {
  const storedHistory = p2pHistoryStorage();
  return {
    protocol: P2P_PROTOCOL_VERSION,
    deviceId: settings.p2p_device_id,
    deviceName: p2pDeviceName(),
    build: BUILD_INFO.label,
    revision: p2p.revision,
    history: storedHistory,
    settings: remoteSettingsPayload(),
    images: p2pImageNamesFromHistory(storedHistory),
    texts: p2pTextRefsFromHistory(storedHistory),
  };
}

function p2pVerifyRequest(req, bodyBuffer) {
  const timestamp = Number(req.headers['x-boardclip-ts']) || 0;
  if (!timestamp || Math.abs(Date.now() - timestamp) > P2P_AUTH_WINDOW_MS) return false;
  const signature = String(req.headers['x-boardclip-sig'] || '');
  const bodyHash = crypto.createHash('sha256').update(bodyBuffer || Buffer.alloc(0)).digest('hex');
  const expected = p2pSignature(req.method, req.url, timestamp, bodyHash);
  try {
    return crypto.timingSafeEqual(Buffer.from(signature, 'hex'), Buffer.from(expected, 'hex'));
  } catch {
    return false;
  }
}

function p2pSendJson(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Content-Length': Buffer.byteLength(body),
  });
  res.end(body);
}

function p2pServeAsset(res, kind, name) {
  const safeName = kind === 'image' ? safeImageName(name) : textBlobStore.safeTextRef(name);
  if (!safeName) {
    res.writeHead(400);
    res.end('Bad asset name');
    return;
  }
  const baseDir = kind === 'image' ? IMG_DIR : TEXT_DIR;
  const filePath = path.join(baseDir, safeName);
  fs.readFile(filePath, (error, data) => {
    if (error) {
      res.writeHead(404);
      res.end('Not found');
      return;
    }
    res.writeHead(200, {
      'Content-Type': kind === 'image' ? 'image/png' : 'text/plain; charset=utf-8',
      'Content-Length': data.length,
    });
    res.end(data);
  });
}

function p2pRequestHandler(req, res) {
  const chunks = [];
  req.on('data', chunk => chunks.push(chunk));
  req.on('end', () => {
    const body = chunks.length ? Buffer.concat(chunks) : Buffer.alloc(0);
    if (!p2pEnabled() || !p2pVerifyRequest(req, body)) {
      res.writeHead(401);
      res.end('Unauthorized');
      return;
    }
    try {
      const url = new URL(req.url, 'http://127.0.0.1');
      if (req.method === 'GET' && url.pathname === '/manifest') {
        p2pSendJson(res, 200, {
          protocol: P2P_PROTOCOL_VERSION,
          deviceId: settings.p2p_device_id,
          deviceName: p2pDeviceName(),
          build: BUILD_INFO.label,
          revision: p2p.revision,
          items: history.length,
        });
        return;
      }
      if (req.method === 'GET' && url.pathname === '/state') {
        p2pSendJson(res, 200, p2pStatePayload());
        return;
      }
      const imagePrefix = '/asset/image/';
      const textPrefix = '/asset/text/';
      if (req.method === 'GET' && url.pathname.startsWith(imagePrefix)) {
        p2pServeAsset(res, 'image', decodeURIComponent(url.pathname.slice(imagePrefix.length)));
        return;
      }
      if (req.method === 'GET' && url.pathname.startsWith(textPrefix)) {
        p2pServeAsset(res, 'text', decodeURIComponent(url.pathname.slice(textPrefix.length)));
        return;
      }
      res.writeHead(404);
      res.end('Not found');
    } catch (error) {
      diagnostics.record('p2p.request.error', { error: error && error.message }, { forceFile: true });
      res.writeHead(500);
      res.end('Error');
    }
  });
}

function p2pAuthHeaders(method, requestPath, body = Buffer.alloc(0)) {
  const timestamp = Date.now();
  const bodyHash = crypto.createHash('sha256').update(body).digest('hex');
  return {
    'x-boardclip-device': settings.p2p_device_id,
    'x-boardclip-ts': String(timestamp),
    'x-boardclip-sig': p2pSignature(method, requestPath, timestamp, bodyHash),
  };
}

function p2pHttpRequest(peer, requestPath, { binary = false } = {}) {
  return new Promise((resolve, reject) => {
    const request = http.request({
      hostname: peer.host,
      port: peer.port,
      path: requestPath,
      method: 'GET',
      timeout: P2P_HTTP_TIMEOUT_MS,
      headers: p2pAuthHeaders('GET', requestPath),
    }, (response) => {
      const chunks = [];
      response.on('data', chunk => chunks.push(chunk));
      response.on('end', () => {
        const body = chunks.length ? Buffer.concat(chunks) : Buffer.alloc(0);
        if (response.statusCode < 200 || response.statusCode >= 300) {
          reject(new Error(`HTTP ${response.statusCode}`));
          return;
        }
        if (binary) {
          resolve(body);
          return;
        }
        try { resolve(JSON.parse(body.toString('utf8'))); } catch (error) { reject(error); }
      });
    });
    request.on('timeout', () => request.destroy(new Error('timeout')));
    request.on('error', reject);
    request.end();
  });
}

async function p2pFetchMissingAsset(peer, kind, name) {
  const safeName = kind === 'image' ? safeImageName(name) : textBlobStore.safeTextRef(name);
  if (!safeName) return false;
  const baseDir = kind === 'image' ? IMG_DIR : TEXT_DIR;
  const target = path.join(baseDir, safeName);
  try {
    await fs.promises.access(target, fs.constants.F_OK);
    return false;
  } catch {}
  const encoded = encodeURIComponent(safeName);
  const data = await p2pHttpRequest(peer, `/asset/${kind}/${encoded}`, { binary: true });
  await fs.promises.mkdir(baseDir, { recursive: true });
  await atomicWriteFileAsync(target, data);
  return true;
}

async function p2pPullPeer(peer, reason = 'discovery') {
  if (!p2pEnabled() || !peer || peer.deviceId === settings.p2p_device_id) return null;
  const existing = p2p.pulls.get(peer.deviceId);
  if (existing && Date.now() - existing.startedAt < P2P_PULL_THROTTLE_MS) return existing.promise;

  const promise = (async () => {
    const startedAt = Date.now();
    let fetchedAssets = 0;
    const state = await p2pHttpRequest(peer, '/state');
    if (!state || state.protocol !== P2P_PROTOCOL_VERSION || state.deviceId !== peer.deviceId) {
      throw new Error('invalid peer state');
    }
    for (const name of state.images || []) {
      if (await p2pFetchMissingAsset(peer, 'image', name)) fetchedAssets++;
    }
    for (const ref of state.texts || []) {
      if (await p2pFetchMissingAsset(peer, 'text', ref)) fetchedAssets++;
    }

    const remoteHistory = textBlobStore.hydrateHistory(Array.isArray(state.history) ? state.history : [], TEXT_DIR);
    const previousSettingsJson = JSON.stringify(remoteSettingsPayload());
    let canonicalHistory = foldRemoteState(history.slice(), remoteHistory, state.settings || {});
    const recoveredImages = await recoverRecentOrphanImages(canonicalHistory);
    const localChanged = JSON.stringify(canonicalHistory) !== JSON.stringify(history);
    const settingsChanged = JSON.stringify(remoteSettingsPayload()) !== previousSettingsJson;
    if (localChanged) {
      history.length = 0;
      history.push(...canonicalHistory);
    }
    if (localChanged || settingsChanged) {
      applyingSyncState = true;
      try {
        saveHistory();
        saveSettingsFile();
      } finally {
        applyingSyncState = false;
      }
      scheduleSyncMerge();
      p2pNotifyLocalChange();
    }
    diagnostics.record('p2p.pull', {
      peer: peer.deviceName || peer.deviceId,
      reason,
      ms: Date.now() - startedAt,
      remote_items: remoteHistory.length,
      local_changed: localChanged,
      settings_changed: settingsChanged,
      fetched_assets: fetchedAssets,
      recovered_images: recoveredImages,
      items: history.length,
    }, { forceFile: localChanged || fetchedAssets > 0 });
    return { ok: true, local_changed: localChanged, settings_changed: settingsChanged, fetched_assets: fetchedAssets };
  })().catch(error => {
    diagnostics.record('p2p.pull.error', {
      peer: peer.deviceName || peer.deviceId,
      reason,
      error: error && error.message,
    }, { forceFile: true });
    return { ok: false, error: error && error.message };
  }).finally(() => {
    const current = p2p.pulls.get(peer.deviceId);
    if (current && current.promise === promise) p2p.pulls.delete(peer.deviceId);
  });

  p2p.pulls.set(peer.deviceId, { startedAt: Date.now(), promise });
  return promise;
}

function p2pAnnouncementPayload() {
  return {
    app: 'boardclip',
    protocol: P2P_PROTOCOL_VERSION,
    deviceId: settings.p2p_device_id,
    deviceName: p2pDeviceName(),
    secretHash: p2pSecretHash(),
    port: p2p.port,
    revision: p2p.revision,
    build: BUILD_INFO.label,
    items: history.length,
  };
}

function p2pAnnounceNow() {
  if (!p2pEnabled() || !p2p.socket || !p2p.port) return;
  const body = Buffer.from(JSON.stringify(p2pAnnouncementPayload()));
  try {
    p2p.socket.send(body, 0, body.length, P2P_DISCOVERY_PORT, P2P_DISCOVERY_ADDR);
  } catch {}
}

function p2pNotifyLocalChange() {
  p2p.revision++;
  if (!p2pEnabled()) return;
  if (p2p.announceSoonTimer) clearTimeout(p2p.announceSoonTimer);
  p2p.announceSoonTimer = setTimeout(() => {
    p2p.announceSoonTimer = null;
    p2pAnnounceNow();
  }, 50);
  if (p2p.announceSoonTimer.unref) p2p.announceSoonTimer.unref();
}

function p2pHandleAnnouncement(message, rinfo) {
  if (!p2pEnabled()) return;
  let payload = null;
  try { payload = JSON.parse(message.toString('utf8')); } catch { return; }
  if (!payload || payload.app !== 'boardclip' || payload.protocol !== P2P_PROTOCOL_VERSION) return;
  if (!payload.deviceId || payload.deviceId === settings.p2p_device_id) return;
  if (payload.secretHash !== p2pSecretHash()) return;
  const port = Number(payload.port) || 0;
  if (port <= 0 || port > 65535) return;

  const previous = p2p.peers.get(payload.deviceId);
  const revision = Number(payload.revision) || 0;
  const peer = {
    deviceId: payload.deviceId,
    deviceName: payload.deviceName || payload.deviceId.slice(0, 8),
    host: rinfo.address,
    port,
    revision,
    build: payload.build || '',
    items: Number(payload.items) || 0,
    lastSeen: Date.now(),
    lastPulledRevision: previous ? previous.lastPulledRevision : 0,
  };
  p2p.peers.set(peer.deviceId, peer);
  if (!previous || previous.revision !== revision || previous.host !== peer.host || previous.port !== peer.port) {
    peer.lastPulledRevision = previous ? previous.lastPulledRevision : 0;
    if (revision && revision !== peer.lastPulledRevision) {
      peer.lastPulledRevision = revision;
      p2pPullPeer(peer, 'announcement');
    }
  }
}

function p2pPeerSummaries() {
  const cutoff = Date.now() - 30 * 1000;
  return [...p2p.peers.values()]
    .filter(peer => peer.lastSeen >= cutoff)
    .sort((a, b) => b.lastSeen - a.lastSeen)
    .map(peer => ({
      deviceId: peer.deviceId,
      deviceName: peer.deviceName,
      host: peer.host,
      port: peer.port,
      build: peer.build,
      items: peer.items,
      lastSeen: peer.lastSeen,
    }));
}

async function startP2PSync() {
  if (p2p.started || !p2pEnabled()) return;
  p2p.started = true;
  try {
    p2p.server = http.createServer(p2pRequestHandler);
    await new Promise((resolve, reject) => {
      p2p.server.once('error', reject);
      p2p.server.listen(0, '0.0.0.0', () => {
        p2p.server.off('error', reject);
        resolve();
      });
    });
    p2p.port = p2p.server.address().port;
    p2p.socket = dgram.createSocket({ type: 'udp4', reuseAddr: true });
    p2p.socket.on('message', p2pHandleAnnouncement);
    p2p.socket.on('error', error => {
      diagnostics.record('p2p.discovery.error', { error: error && error.message }, { forceFile: true });
    });
    await new Promise((resolve, reject) => {
      p2p.socket.once('error', reject);
      p2p.socket.bind(P2P_DISCOVERY_PORT, () => {
        p2p.socket.off('error', reject);
        try { p2p.socket.addMembership(P2P_DISCOVERY_ADDR); } catch {}
        try { p2p.socket.setMulticastTTL(1); } catch {}
        resolve();
      });
    });
    p2p.announceTimer = setInterval(p2pAnnounceNow, P2P_ANNOUNCE_INTERVAL_MS);
    if (p2p.announceTimer.unref) p2p.announceTimer.unref();
    p2pAnnounceNow();
    diagnostics.record('p2p.start', { port: p2p.port, device: p2pDeviceName() }, { forceFile: true });
  } catch (error) {
    diagnostics.record('p2p.start.error', { error: error && error.message }, { forceFile: true });
    stopP2PSync();
  }
}

function stopP2PSync() {
  p2p.started = false;
  if (p2p.announceTimer) clearInterval(p2p.announceTimer);
  if (p2p.announceSoonTimer) clearTimeout(p2p.announceSoonTimer);
  p2p.announceTimer = null;
  p2p.announceSoonTimer = null;
  try { if (p2p.socket) p2p.socket.close(); } catch {}
  try { if (p2p.server) p2p.server.close(); } catch {}
  p2p.socket = null;
  p2p.server = null;
  p2p.port = 0;
}

async function restartP2PSync() {
  stopP2PSync();
  if (p2pEnabled()) await startP2PSync();
}

async function setP2PEnabled(enabled) {
  settings.p2p_enabled = !!enabled;
  ensureP2PIdentity();
  saveSettingsFile();
  await restartP2PSync();
  return p2pStatus();
}

function p2pStatus() {
  return {
    enabled: !!settings.p2p_enabled,
    running: !!(p2p.started && p2p.server && p2p.socket),
    port: p2p.port,
    deviceId: settings.p2p_device_id,
    deviceName: p2pDeviceName(),
    peers: p2pPeerSummaries(),
  };
}

async function syncMerge(options = {}) {
  if (insideSync) {
    if (options && options.force) {
      syncPending = true;
      syncPendingForce = true;
    }
    diagnostics.record('sync.skip_inside_sync', { items: history.length }, { forceFile: true });
    return options && options.force ? waitForSyncIdle() : lastSyncResult;
  }
  insideSync = true;
  const startedAt = Date.now();
  const force = !!(options && options.force);
  const startedDirtyVersion = syncDirtyVersion;
  const hadLocalDirty = force || startedDirtyVersion !== syncedDirtyVersion;
  const fullSync = force || !lastFullSyncAt || Date.now() - lastFullSyncAt > SYNC_FULL_INTERVAL_MS;
  let syncPaths = [];
  let localChanged = false;
  let settingsChanged = false;
  let shouldWriteRemotes = false;
  let syncSucceeded = false;
  let recoveredImages = 0;
  let result = null;
  const providers = [];
  try {
    syncPaths = await getEnabledSyncPaths();
    if (!syncPaths.length) {
      syncSucceeded = true;
      result = {
        ok: true,
        paths: [],
        providers: [],
        local_changed: false,
        settings_changed: false,
        local_dirty: hadLocalDirty,
        full_sync: fullSync,
        wrote_remotes: false,
        items: history.length,
      };
      return result;
    }

    let canonicalHistory = history.slice();
    const previousSettingsJson = JSON.stringify(remoteSettingsPayload());

    for (const syncPath of syncPaths) {
      const providerStartedAt = Date.now();
      const signature = await syncProviderSignature(syncPath);
      const signatureKey = syncProviderSignatureKey(signature);
      const cached = syncProviderCache.get(syncPath);
      const remoteChanged = !cached || cached.signatureKey !== signatureKey;
      const shouldReadRemote = fullSync || remoteChanged;
      if (!shouldReadRemote && !hadLocalDirty) {
        providers.push({
          path: syncPath,
          skipped: true,
          remote_changed: false,
          full_sync: false,
          ms: Date.now() - providerStartedAt,
        });
        continue;
      }

      if (!shouldReadRemote) {
        providers.push({
          path: syncPath,
          skipped: true,
          remote_changed: false,
          local_dirty: hadLocalDirty,
          full_sync: false,
          ms: Date.now() - providerStartedAt,
        });
        continue;
      }

      const remoteTextDir = path.join(syncPath, textBlobStore.TEXT_BLOB_DIRNAME);
      const remoteImgDir = path.join(syncPath, 'clipboard-images');
      await syncRemoteAssets(remoteImgDir, remoteTextDir);
      const { remoteHistory, remoteSettings } = await readRemoteState(syncPath);
      canonicalHistory = foldRemoteState(canonicalHistory, remoteHistory, remoteSettings);
      await updateSyncProviderCache(syncPath);
      providers.push({
        path: syncPath,
        skipped: false,
        remote_changed: remoteChanged,
        full_sync: fullSync,
        remote_items: remoteHistory.length,
        canonical_items: canonicalHistory.length,
        ms: Date.now() - providerStartedAt,
      });
    }

    recoveredImages = await recoverRecentOrphanImages(canonicalHistory);
    localChanged = JSON.stringify(canonicalHistory) !== JSON.stringify(history);
    settingsChanged = JSON.stringify(remoteSettingsPayload()) !== previousSettingsJson;
    if (localChanged) {
      history.length = 0;
      history.push(...canonicalHistory);
    }
    if (localChanged || settingsChanged) {
      applyingSyncState = true;
      try {
        saveHistory();
        saveSettingsFile();
      } finally {
        applyingSyncState = false;
      }
    }

    shouldWriteRemotes = hadLocalDirty || localChanged || settingsChanged;
    const canonicalSettings = remoteSettingsPayload();
    if (shouldWriteRemotes) {
      for (const syncPath of syncPaths) {
        try {
          await withTimeout(
            writeRemoteState(syncPath, history, canonicalSettings),
            SYNC_REMOTE_WRITE_TIMEOUT_MS,
            `write ${syncPath}`
          );
        } catch (error) {
          diagnostics.record('sync.write_remote.error', {
            path: syncPath,
            error: error && error.message,
          }, { forceFile: true });
        }
      }
    }
    if (fullSync) lastFullSyncAt = Date.now();
    syncSucceeded = true;
    result = {
      ok: true,
      paths: syncPaths,
      providers,
      local_changed: localChanged,
      settings_changed: settingsChanged,
      local_dirty: hadLocalDirty,
      full_sync: fullSync,
      recovered_images: recoveredImages,
      wrote_remotes: shouldWriteRemotes,
      items: history.length,
    };
    return result;
  } catch (error) {
    diagnostics.record('sync.error', {
      error: error && error.message,
      stack: error && error.stack,
    }, { forceFile: true });
  } finally {
    const elapsed = Date.now() - startedAt;
    if (!result) {
      result = {
        ok: syncSucceeded,
        paths: syncPaths,
        providers,
        local_changed: localChanged,
        settings_changed: settingsChanged,
        local_dirty: hadLocalDirty,
        full_sync: fullSync,
        recovered_images: recoveredImages,
        wrote_remotes: shouldWriteRemotes,
        items: history.length,
      };
    }
    result.ms = elapsed;
    lastSyncResult = result;
    if (syncPaths.length || elapsed > 50 || diagnostics.isEnabled()) {
      diagnostics.record('sync.merge', {
        ms: elapsed,
        providers: providers.length,
        paths: syncPaths,
        local_changed: localChanged,
        settings_changed: settingsChanged,
        local_dirty: hadLocalDirty,
        full_sync: fullSync,
        recovered_images: recoveredImages,
        wrote_remotes: shouldWriteRemotes,
        items: history.length,
        provider_timings: providers,
        slow: elapsed > 250,
      }, { forceFile: elapsed > 250 });
    }
    insideSync = false;
    if (syncSucceeded && (hadLocalDirty || force) && syncDirtyVersion === startedDirtyVersion) {
      syncedDirtyVersion = syncDirtyVersion;
    }
    if (syncPending) {
      const pendingForce = syncPendingForce;
      syncPending = false;
      syncPendingForce = false;
      const timer = setTimeout(() => syncMerge({ force: pendingForce }), 0);
      if (timer.unref) timer.unref();
    } else {
      resolveSyncIdle(result);
    }
  }
}

// --- Image helpers ---
function imageHash(buffer) {
  return crypto.createHash('md5').update(buffer).digest('hex').slice(0, 12);
}

function saveClipboardImageBuffer(hash, buf, imageInfo) {
  const fname = `${hash}.png`;
  const fpath = path.join(IMG_DIR, fname);
  if (!fs.existsSync(fpath)) atomicWriteFile(fpath, buf);
  const size = imageInfo && typeof imageInfo.getSize === 'function'
    ? imageInfo.getSize()
    : { width: imageInfo && imageInfo.width || 0, height: imageInfo && imageInfo.height || 0 };
  return { fname, width: size.width, height: size.height };
}

// --- Clipboard polling ---
let lastText = '';
let lastImgHash = '';
let lastImageProbeToken = '';
let lastCapturedImageToken = '';
let lastImageProbeAt = 0;
let lastSlowPollLogAt = 0;
let pollGate = true;
const IMAGE_CLIPBOARD_PROBE_MS = 3000;
const SLOW_CLIPBOARD_POLL_MS = 250;

function clipboardFormats() {
  try {
    return clipboard.availableFormats();
  } catch {
    return [];
  }
}

function formatsContainImage(formatsKey) {
  return clipboardCapture.formatsSuggestImage(formatsKey);
}

function addToHistory(entry, matchFn) {
  const startedAt = Date.now();
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
    const existing = history[existIdx];
    entry.pin = clonePin(existing.pin);
    if (existing.pinUpdatedAt) entry.pinUpdatedAt = existing.pinUpdatedAt;
    entry.id = itemKey(existing);
    history.splice(existIdx, 1);
  }
  history.unshift(entry);
  pruneHistory();
  if (tombstoneRemoved) saveSettingsFile();
  saveHistory();
  diagnostics.record('history.add', {
    type: entry.type,
    text_length: entry.type === 'text' ? (entry.text || '').length : undefined,
    image: entry.type === 'image' ? { width: entry.width, height: entry.height } : undefined,
    items: history.length,
    ms: Date.now() - startedAt,
  });
}

function pollClipboard() {
  if (!pollGate) return;

  const startedAt = Date.now();
  let formatsKey = '';
  let action = 'none';
  try {
    const formats = clipboardFormats();
    formatsKey = clipboardCapture.formatsKey(formats);
    if (formatsContainImage(formatsKey)) {
      const now = Date.now();
      const probeToken = clipboardCapture.clipboardChangeToken(formats);
      if (probeToken && probeToken === lastCapturedImageToken) {
        action = 'image_probe_throttled';
        return;
      }
      if (probeToken === lastImageProbeToken && now - lastImageProbeAt < IMAGE_CLIPBOARD_PROBE_MS) {
        action = 'image_probe_throttled';
        return;
      }
      lastImageProbeToken = probeToken;
      lastImageProbeAt = now;

      const captured = clipboardCapture.readClipboardImage({ clipboard, nativeImage, formats });
      if (!captured) return;
      lastCapturedImageToken = probeToken;
      const buf = captured.buffer;
      const h = imageHash(buf);
      if (h !== lastImgHash) {
        action = 'image_added';
        lastImgHash = h;
        lastText = '';
        const { fname, width, height } = saveClipboardImageBuffer(h, buf, captured);
        addToHistory(
          { type: 'image', image: fname, ts: Date.now() / 1000, width, height },
          it => it.type === 'image' && it.image === fname
        );
      }
      return;
    }

    lastImageProbeToken = '';
    lastCapturedImageToken = '';
    const text = clipboard.readText();
    if (text && text !== lastText) {
      action = 'text_added';
      lastText = text;
      lastImgHash = '';
      addToHistory(
        { type: 'text', text, ts: Date.now() / 1000 },
        it => it.text === text
      );
    }
  } catch {
    action = 'error';
  } finally {
    const elapsed = Date.now() - startedAt;
    if (elapsed > SLOW_CLIPBOARD_POLL_MS && Date.now() - lastSlowPollLogAt > 5000) {
      lastSlowPollLogAt = Date.now();
      logSafe(`Slow clipboard poll: ${elapsed}ms (${formatsKey || 'unknown formats'})`);
      diagnostics.record('clipboard.poll.slow', {
        ms: elapsed,
        formats: formatsKey || 'unknown',
        action,
      }, { forceFile: true });
    } else if (diagnostics.isEnabled() && action !== 'none' && action !== 'image_probe_throttled') {
      diagnostics.record('clipboard.poll', {
        ms: elapsed,
        formats: formatsKey || 'unknown',
        action,
      });
    }
  }
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

function escapeAppleScriptString(value) {
  return String(value || '').replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

function getFrontmostMacAppName() {
  if (process.platform !== 'darwin') return Promise.resolve('');
  return new Promise(resolve => {
    exec(`osascript -e 'tell application "System Events" to get name of first application process whose frontmost is true'`, (error, stdout) => {
      resolve(error ? '' : String(stdout || '').trim());
    });
  });
}

function macWindowSnapshot() {
  if (!win || win.isDestroyed()) return { exists: false };
  return {
    exists: true,
    visible: win.isVisible(),
    focused: win.isFocused(),
    minimized: win.isMinimized(),
    bounds: win.getBounds(),
  };
}

let quickPasteTraceSeq = 0;

// --- Paste simulation ---
// Sends Ctrl+V (Cmd+V on mac) to the currently focused window. On Windows
// this uses a direct keybd_event call via koffi (microseconds, no side
// effects). On macOS we use osascript because there's no equivalent native
// Electron API — acceptable there because the Mac paste flow is less hot.
function simulatePaste(targetAppName = '') {
  if (process.platform === 'win32') {
    winPaste.sendCtrlV();
    return Promise.resolve();
  }
  return new Promise((resolve) => {
    const target = escapeAppleScriptString(targetAppName);
    const activateTarget = target
      ? `try\n            tell application "${target}" to activate\n            delay 0.05\n          end try`
      : '';
    exec(`osascript -e '
      tell application "System Events"
        ${activateTarget}
        keystroke "v" using command down
      end tell'`, (error) => resolve({ ok: !error, error: error && error.message }));
  });
}

// --- Numpad quick-paste ---
async function numpadPaste(slotNum, options = {}) {
  const trace = options.trace || {};
  // Drop the call if a previous paste is still in its restore window —
  // otherwise rapid Num-key presses race and the second call's "backup"
  // captures the first call's pasted content.
  if (!pollGate) {
    diagnostics.record('shortcut.quick_paste_blocked', { ...trace, slot: slotNum, reason: 'poll_gate' }, { forceFile: true });
    return;
  }
  const item = history.find(h => hasNumpadSlot(h, slotNum));
  if (!item) {
    diagnostics.record('shortcut.quick_paste_missing_slot', { ...trace, slot: slotNum }, { forceFile: true });
    return;
  }

  pollGate = false;
  let backup = null;
  try {
    backup = backupClipboard();
    setClipboardToItem(item);
    diagnostics.record('shortcut.quick_paste_clipboard_set', {
      ...trace,
      slot: slotNum,
      item_id: itemKey(item),
      item_type: item.type || 'text',
      text_len: item.type === 'image' ? undefined : String(item.text || '').length,
      backup_text_len: backup && backup.text ? backup.text.length : 0,
      window: macWindowSnapshot(),
    }, { forceFile: true });
  // Minimum delay for Windows clipboard propagation before paste. 15ms is
  // tight but reliable — clipboard.writeText is synchronous and Windows
  // WM_CLIPBOARDUPDATE propagates within a few ms on any modern system.
    await new Promise(r => setTimeout(r, 15));
    const pasteResult = await simulatePaste(options.targetAppName || '');
    const frontmostAfterPaste = process.platform === 'darwin' ? await getFrontmostMacAppName() : '';
    diagnostics.record('shortcut.quick_paste_pasted', {
      ...trace,
      slot: slotNum,
      target_app: options.targetAppName || '',
      frontmost_after_paste: frontmostAfterPaste,
      paste_ok: !pasteResult || pasteResult.ok !== false,
      paste_error: pasteResult && pasteResult.error,
      window: macWindowSnapshot(),
    }, { forceFile: true });
    await new Promise(r => setTimeout(r, 150));
  // Fire-and-forget restore: the target app needs ~100-150ms to read from
  // the clipboard after receiving Ctrl+V. We don't block the caller on that.
  } finally {
    try { restoreClipboard(backup); } catch {}
    const frontmostAfterRestore = process.platform === 'darwin' ? await getFrontmostMacAppName() : '';
    diagnostics.record('shortcut.quick_paste_restored', {
      ...trace,
      slot: slotNum,
      frontmost_after_restore: frontmostAfterRestore,
      window: macWindowSnapshot(),
    }, { forceFile: true });
    pollGate = true;
  }
}

// --- Window & state ---
const WIN_W = 460;
const WIN_H = 520;
let win = null;
let tray = null;

function currentColorScheme() {
  return nativeTheme.shouldUseDarkColors ? 'dark' : 'light';
}

function appBackgroundColor() {
  return nativeTheme.shouldUseDarkColors ? '#131313' : '#ffffff';
}

function notifyColorSchemeChanged() {
  if (!win || win.isDestroyed()) return;
  win.setBackgroundColor(appBackgroundColor());
  win.webContents.send('color-scheme-changed', currentColorScheme());
}

function configureMacPopupWindow(window) {
  if (process.platform !== 'darwin' || !window) return;
  window.setVisibleOnAllWorkspaces(true, {
    visibleOnFullScreen: true,
  });
  window.setAlwaysOnTop(true, 'pop-up-menu');
}

function createPopup() {
  win = new BrowserWindow({
    width: WIN_W,
    height: WIN_H,
    frame: false,
    alwaysOnTop: true,
    show: false,
    skipTaskbar: true,
    resizable: false,
    backgroundColor: appBackgroundColor(),
    icon: APP_ICON_PATH,
    webPreferences: {
      preload: path.join(SCRIPT_DIR, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  configureMacPopupWindow(win);
  win.loadFile(path.join(SCRIPT_DIR, 'index.html'));

  // Dev/source installs: auto-reload renderer files while iterating.
  let reloadTimer = null;
  const scheduleRendererReload = () => {
    if (reloadTimer) clearTimeout(reloadTimer);
    reloadTimer = setTimeout(() => {
      if (win && !win.isDestroyed()) win.webContents.reloadIgnoringCache();
    }, 300);
  };
  const rendererWatchers = [];
  if (!app.isPackaged) {
    for (const file of [
      path.join(SCRIPT_DIR, 'index.html'),
      path.join(SCRIPT_DIR, 'site', 'shared', 'clipboard-ui-core.js'),
      path.join(SCRIPT_DIR, 'site', 'shared', 'clipboard-popup.css'),
    ]) {
      try { rendererWatchers.push(fs.watch(file, scheduleRendererReload)); } catch {}
    }
  }
  win.rendererWatchers = rendererWatchers;
  win.on('closed', () => {
    for (const watcher of rendererWatchers) {
      try { watcher.close(); } catch {}
    }
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
      window.resetPopupState?.();
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

function resetPopupRendererState() {
  if (!win || win.isDestroyed() || !win.webContents || win.webContents.isDestroyed()) return Promise.resolve(false);
  const startedAt = Date.now();
  return win.webContents.executeJavaScript(`
    window.resetPopupState?.();
    window.focusSearch?.();
    true;
  `).then((result) => {
    diagnostics.slow('popup.renderer_reset.slow', Date.now() - startedAt, { result: !!result }, 100);
    return result;
  }).catch((error) => {
    diagnostics.record('popup.renderer_reset.error', { ms: Date.now() - startedAt, error: error && error.message }, { forceFile: true });
    return false;
  });
}

function ensurePopupRendererResponsive() {
  if (!win || win.isDestroyed() || !win.webContents || win.webContents.isDestroyed()) return;
  if (win.webContents.isLoading()) return;

  let settled = false;
  const timer = setTimeout(() => {
    if (settled || !win || win.isDestroyed() || !win.isVisible()) return;
    logSafe('BoardClip popup renderer did not respond after show; reloading.');
    diagnostics.record('popup.renderer_unresponsive', { timeout_ms: 800 }, { forceFile: true });
    win.webContents.once('did-finish-load', () => resetPopupRendererState());
    win.webContents.reloadIgnoringCache();
  }, 800);
  if (timer.unref) timer.unref();

  resetPopupRendererState()
    .then(() => {
      settled = true;
      clearTimeout(timer);
    })
    .catch(() => {
      settled = true;
      clearTimeout(timer);
    });
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
  diagnostics.record('popup.hide', { visible: !!(win && !win.isDestroyed() && win.isVisible()), items: history.length });
  if (win && !win.isDestroyed()) win.hide();
  if (windowsHook) windowsHook.setPopupVisible(false);
  stopClickAwayWatcher();
}

function showPopup() {
  if (!win) return;
  const startedAt = Date.now();
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

  configureMacPopupWindow(win);
  if (process.platform === 'darwin') {
    win.setIgnoreMouseEvents(false);
    win.setFocusable(true);
    app.focus({ steal: true });
  }
  win.setPosition(Math.round(x), Math.round(y));
  win.show();
  win.moveTop();
  if (process.platform === 'darwin') app.focus({ steal: true });
  win.focus();
  ensurePopupRendererResponsive();
  if (windowsHook) windowsHook.setPopupVisible(true);
  startClickAwayWatcher();
  diagnostics.record('popup.show', {
    ms: Date.now() - startedAt,
    items: history.length,
    platform: process.platform,
  });
}

function setClipboardToItem(item) {
  if (item.type === 'image') {
    const imgPath = path.join(IMG_DIR, item.image);
    if (fs.existsSync(imgPath)) clipboard.writeImage(nativeImage.createFromPath(imgPath));
  } else {
    textBlobStore.hydrateTextItem(item, TEXT_DIR);
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
  let trayIcon;
  if (fs.existsSync(APP_ICON_PATH)) {
    trayIcon = nativeImage.createFromPath(APP_ICON_PATH).resize({ width: 16, height: 16 });
  } else {
    trayIcon = nativeImage.createEmpty();
  }
  if (process.platform === 'darwin') trayIcon.setTemplateImage(true);

  tray = new Tray(trayIcon);
  refreshTray();
  tray.on('click', showPopup);
  tray.on('double-click', showPopup);
}

function refreshTray() {
  if (!tray) return;
  tray.setToolTip(`BoardClip ${BUILD_INFO.label}`);

  const contextMenu = Menu.buildFromTemplate([
    { label: 'Open', click: showPopup },
    { type: 'separator' },
    { label: `Build ${BUILD_INFO.label}`, enabled: false },
    { label: 'Check for Updates', click: () => autoUpdater.check({ manual: true }) },
    { type: 'separator' },
    { label: 'Quit', click: () => { app.isQuitting = true; app.quit(); } },
  ]);

  tray.setContextMenu(contextMenu);
}

// --- Open in editor ---
function openEditor(id) {
  const item = findHistoryItem(id);
  if (!item || item.type === 'image') return;
  textBlobStore.hydrateTextItem(item, TEXT_DIR);
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
    runtime_info: (() => {
      const support = updateSupport(SCRIPT_DIR, BUILD_INFO);
      return {
        app_dir: SCRIPT_DIR,
        data_dir: DATA_DIR,
        auto_update: support.supported,
        update_support: support,
        diagnostics_file: DIAGNOSTICS_PATH,
        p2p: p2pStatus(),
      };
    })(),
    shortcut_info: {
      show: effectiveShowShortcut(),
      custom: !!settings.show_shortcut,
      default: defaultShowShortcut(),
      quickPaste: effectiveQuickPasteShortcut(),
      quickPasteCustom: !!settings.quick_paste_shortcut,
      quickPasteDefault: defaultQuickPasteShortcut(),
      windows_hook: process.platform === 'win32',
    },
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
      touchPinNumber(item);
      saveHistory();
      return;
    } else {
      item.pin = null;
    }
    touchPin(item);
    saveHistory();
  });

  ipcMain.handle('numpad-assign', (_, id, slot) => {
    const item = findHistoryItem(id);
    if (typeof slot !== 'number' || slot < 1 || slot > 9 || !item) return;
    const now = Date.now();
    // Strip the slot from any other item without unpinning them.
    for (const h of history) {
      if (hasNumpadSlot(h, slot)) {
        delete h.pin.number;
        touchPinNumber(h, now);
      }
    }
    const pin = ensurePin(item);
    pin.number = slot;
    touchPinNumber(item, now);
    saveHistory();
  });

  ipcMain.handle('numpad-unassign', (_, slot) => {
    if (typeof slot !== 'number' || slot < 1 || slot > 9) return;
    for (const h of history) {
      if (hasNumpadSlot(h, slot)) {
        delete h.pin.number;
        touchPinNumber(h);
        saveHistory();
        break;
      }
    }
  });

  ipcMain.handle('save-settings', (_, body) => {
    if (body.max_age_days !== undefined) settings.max_age_days = Math.max(1, parseInt(body.max_age_days));
    if (body.max_size_gb !== undefined) settings.max_size_gb = Math.max(0.1, parseFloat(body.max_size_gb));
    if (body.regex_search !== undefined) settings.regex_search = !!body.regex_search;
    if (body.diagnostics_enabled !== undefined) settings.diagnostics_enabled = !!body.diagnostics_enabled;
    saveSettingsFile();
    pruneHistory();
  });

  ipcMain.handle('set-show-shortcut', (_, shortcut) => setShowShortcut(shortcut));
  ipcMain.handle('set-quick-paste-shortcut', (_, shortcut) => setQuickPasteShortcut(shortcut));
  ipcMain.handle('resolve-show-shortcut', (_, shortcut) => {
    const hook = getMacosHotkey();
    return hook ? hook.resolveShortcutFromCurrentModifiers(shortcut) : shortcut;
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
      const now = Date.now();
      for (const h of history) {
        if (h.pin && h.pin.groups) {
          h.pin.groups = h.pin.groups.filter(g => g !== name);
          if (h.pin.groups.length === 0) delete h.pin.groups;
          touchPinGroups(h, now);
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
    touchPinGroups(item);
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

  ipcMain.handle('set-sync-path', async (_, syncPath) => {
    if (syncPath) {
      const normalized = addCustomSyncPath(syncPath);
      if (normalized) await setSyncPathEnabled(normalized, true);
      return;
    }

    const accounts = syncAccountsWithCustom(await getCachedCloudAccounts({ force: true }));
    const disabled = syncDisabledPathSet();
    for (const acc of accounts) disabled.add(normalizeSyncPath(acc.path));
    settings.sync_disabled_paths = [...disabled];
    saveSettingsFile();
  });

  ipcMain.handle('choose-sync-folder', async () => {
    const result = await dialog.showOpenDialog(win, {
      title: 'Choose BoardClip sync folder',
      properties: ['openDirectory', 'createDirectory'],
      defaultPath: settings.sync_path || os.homedir(),
    });
    if (result.canceled || !result.filePaths || !result.filePaths[0]) return { canceled: true };
    const syncPath = addCustomSyncPath(result.filePaths[0]);
    if (!syncPath) return { canceled: true };
    await setSyncPathEnabled(syncPath, true);
    return { canceled: false, path: syncPath };
  });

  ipcMain.handle('set-sync-path-enabled', async (_, syncPath, enabled) => {
    await setSyncPathEnabled(syncPath, enabled);
  });

  ipcMain.handle('get-cloud-accounts', () => getCloudAccountsForSettings());
  ipcMain.handle('set-p2p-enabled', (_, enabled) => setP2PEnabled(enabled));
  ipcMain.handle('get-p2p-status', () => p2pStatus());
  ipcMain.handle('get-sync-diagnostics', () => syncDiagnostics());
  ipcMain.handle('record-diagnostics', (_, event, details) => {
    const forceFile = !!(details && details.slow && !diagnostics.isEnabled());
    if (!diagnostics.isEnabled() && !forceFile) return;
    diagnostics.record(`renderer.${event || 'event'}`, details || {}, { forceFile });
  });

  ipcMain.handle('sync-now', async () => {
    const peers = p2pPeerSummaries();
    await Promise.all(peers.map(peer => p2pPullPeer(peer, 'manual')));
    return syncMerge({ force: true });
  });

  ipcMain.handle('check-for-updates', async () => {
    const result = await autoUpdater.check({ manual: true });
    return {
      ok: !!result.ok,
      status: result.status || 'unknown',
      reason: result.reason || null,
      latest: result.latest || null,
      mode: result.mode || null,
      error: result.error ? result.error.message : null,
    };
  });

  ipcMain.handle('get-auto-launch', () => {
    return getAutoLaunchEnabled();
  });

  ipcMain.handle('set-auto-launch', (_, enabled) => {
    setAutoLaunchEnabled(enabled);
  });

  ipcMain.handle('get-color-scheme', () => currentColorScheme());
}

// --- Global shortcuts ---
let windowsHook = null;
let macosHotkey = null;

function getMacosHotkey() {
  if (process.platform !== 'darwin') return null;
  if (!macosHotkey) macosHotkey = require('./lib/macos-hotkey');
  return macosHotkey;
}

function handleNumpad(slot) {
  if (win && win.isVisible()) {
    // Popup open: assign numpad to selected item
    win.webContents.executeJavaScript(`window.assignNumpad(${slot})`).catch(() => {});
  } else {
    // Popup closed: quick-paste from slot
    numpadPaste(slot);
  }
}

async function handleQuickPaste(slot) {
  const trace = { seq: ++quickPasteTraceSeq };
  const targetAppName = process.platform === 'darwin' ? await getFrontmostMacAppName() : '';
  const popupVisible = !!(win && !win.isDestroyed() && win.isVisible());
  const popupFocused = popupVisible && win.isFocused();
  const hasItem = history.some(h => hasNumpadSlot(h, slot));
  diagnostics.record('shortcut.quick_paste', { ...trace, slot, popup_visible: popupVisible, popup_focused: popupFocused, has_item: hasItem, target_app: targetAppName, window: macWindowSnapshot() }, { forceFile: true });
  if (popupFocused) {
    win.webContents.executeJavaScript(`window.assignNumpad(${slot})`).catch(() => {});
    return;
  }
  if (popupVisible) hidePopup();
  await numpadPaste(slot, { targetAppName, trace });
  if (win && !win.isDestroyed() && win.isVisible()) {
    diagnostics.record('shortcut.quick_paste_force_hide', { ...trace, slot, window: macWindowSnapshot() }, { forceFile: true });
    hidePopup();
  }
}

function setShowShortcut(shortcut) {
  const previous = settings.show_shortcut || '';
  const next = normalizeShowShortcut(shortcut);
  if (next && shortcutUsesFn(next) && process.platform !== 'darwin') {
    return { ok: false, error: 'Globe shortcuts are only supported on macOS.' };
  }
  if (next && !shortcutHasKeyAndModifier(next)) {
    const modifiers = process.platform === 'darwin'
      ? 'Command, Control, Option, or Globe'
      : 'Command, Control, Alt, or Win';
    return { ok: false, error: `Use ${modifiers} with a key.` };
  }

  settings.show_shortcut = next;
  const result = registerShortcuts();
  if (!result.showShortcutRegistered) {
    settings.show_shortcut = previous;
    registerShortcuts();
    return { ok: false, error: 'Shortcut is already in use or not supported.' };
  }

  saveSettingsFile();
  return { ok: true, shortcut: effectiveShowShortcut(), custom: !!settings.show_shortcut };
}

function setQuickPasteShortcut(shortcut) {
  const previous = settings.quick_paste_shortcut || '';
  const next = normalizeQuickPasteShortcut(shortcut);
  if (next && shortcutUsesFn(next)) {
    return { ok: false, error: 'Globe shortcuts are only supported for the popup shortcut.' };
  }
  if (next && !shortcutHasKeyAndModifier(next)) {
    const modifiers = process.platform === 'darwin'
      ? 'Command, Control, or Option'
      : 'Command, Control, Alt, or Win';
    return { ok: false, error: `Use ${modifiers} with a number.` };
  }
  if (next && quickPasteSlotFromShortcut(next) == null) {
    return { ok: false, error: 'Press a shortcut ending in 1-9.' };
  }

  settings.quick_paste_shortcut = next;
  const result = registerShortcuts();
  if (!result.quickPasteRegistered) {
    settings.quick_paste_shortcut = previous;
    registerShortcuts();
    return { ok: false, error: 'Quick paste shortcut is already in use or not supported.' };
  }

  saveSettingsFile();
  return {
    ok: true,
    shortcut: effectiveQuickPasteShortcut(),
    custom: !!settings.quick_paste_shortcut,
  };
}

function registerShortcuts() {
  globalShortcut.unregisterAll();

  let showShortcutRegistered = true;
  let quickPasteRegistered = true;
  const showKey = globalShowShortcut();
  const quickPasteKey = globalQuickPasteShortcut();
  const macosFnShowKey = process.platform === 'darwin' && shortcutUsesFn(settings.show_shortcut)
    ? settings.show_shortcut
    : '';

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
  }

  if (process.platform === 'darwin') {
    const hook = getMacosHotkey();
    if (macosFnShowKey) {
      const result = hook.install({ shortcut: macosFnShowKey, onPressed: showPopup });
      showShortcutRegistered = !!result.ok;
      if (!result.ok) logSafe(`Warning: ${result.error}`);
    } else if (hook) {
      hook.clearRuntimeShortcut();
    }
  }

  if (showKey) {
    showShortcutRegistered = globalShortcut.register(showKey, showPopup);
    if (!showShortcutRegistered) logSafe(`Warning: Could not register popup shortcut ${showKey}`);
  }

  const quickPasteRegistrations = [];
  if (quickPasteKey) {
    for (let n = 1; n <= 9; n++) {
      const key = quickPasteShortcutForSlot(quickPasteKey, n);
      if (!key) {
        quickPasteRegistered = false;
        quickPasteRegistrations.push({ slot: n, key, registered: false });
        continue;
      }
      const registered = globalShortcut.register(key, () => {
        handleQuickPaste(n).catch(error => {
          diagnostics.record('shortcut.quick_paste_error', { slot: n, error: error && error.message }, { forceFile: true });
        });
      });
      quickPasteRegistrations.push({ slot: n, key, registered });
      if (!registered) {
        quickPasteRegistered = false;
        logSafe(`Warning: Could not register ${key}`);
      }
    }
  }
  diagnostics.record('shortcut.register', {
    platform: process.platform,
    show_key: showKey,
    show_registered: showShortcutRegistered,
    quick_paste_key: quickPasteKey,
    quick_paste_registered: quickPasteRegistered,
    quick_paste_registrations: quickPasteRegistrations,
  }, { forceFile: true });

  return {
    showShortcutRegistered,
    showShortcut: effectiveShowShortcut(),
    quickPasteRegistered,
    quickPasteShortcut: effectiveQuickPasteShortcut(),
  };
}

nativeTheme.on('updated', notifyColorSchemeChanged);

// --- Single instance lock ---
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  logSafe('Another instance is already running. Quitting.');
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
  writeHistoryStorageFile();
  setupIPC();
  createPopup();
  createTray();
  registerShortcuts();
  startDiagnosticsMonitor();
  startP2PSync();
  autoUpdater.start();

  // Sync with shared folder on startup + every 30s
  syncMerge({ force: true });
  pollClipboard();
  setInterval(pollClipboard, 400);
  setInterval(() => syncMerge(), 30000);

  logSafe(`BoardClip running. ${effectiveShowShortcut()} to open popup.`);
});

app.on('will-quit', () => {
  globalShortcut.unregisterAll();
  if (windowsHook) windowsHook.uninstall();
  if (macosHotkey) macosHotkey.uninstall();
  stopP2PSync();
});
app.on('window-all-closed', () => { /* keep running as tray app */ });
