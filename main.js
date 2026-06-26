const { app, BrowserWindow, Tray, Menu, globalShortcut, clipboard, nativeImage,
        ipcMain, protocol, screen, shell, nativeTheme, dialog, Notification } = require('electron');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const os = require('os');
const http = require('http');
const dgram = require('dgram');
const { exec, execFile, spawn } = require('child_process');

// Windows-specific fast input (keybd_event, Get/SetForegroundWindow).
// Module is a no-op on non-Windows platforms so it's safe to require unconditionally.
const winPaste = require('./lib/windows-paste');
const macPaste = require('./lib/macos-paste');
const getBuildInfo = require('./lib/build-info');
const getCloudAccounts = require('./lib/cloud-accounts');
const blobStore = require('./lib/blob-store');
const clipboardModel = require('./lib/clipboard-model');
const clipboardCapture = require('./lib/clipboard-capture');
const textBlobStore = require('./lib/text-blob-store');
const { createAutoUpdater, updateSupport } = require('./lib/auto-update');
const syncPaths = require('./lib/sync-paths');
const { Diagnostics } = require('./lib/diagnostics');
const { ensureDirectory } = require('./lib/ensure-directory');
const hmacAuth = require('./lib/hmac-auth');
const mcpCore = require('./lib/mcp-core');
const mcpPaths = require('./lib/mcp-paths');
const mcpInstallers = require('./lib/mcp-installers');
const secretGuard = require('./lib/secret-guard');
const { ControlServer } = require('./lib/control-server');

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
// BOARDCLIP_DATA_DIR points the app at a custom data directory (used for an
// isolated test/second instance, or to relocate data); otherwise packaged builds
// use Electron's per-user data dir and source checkouts use the checkout itself.
const DATA_DIR = process.env.BOARDCLIP_DATA_DIR || (app.isPackaged ? app.getPath('userData') : SCRIPT_DIR);
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
const SYNC_PROVIDER_READ_TIMEOUT_MS = 12000;
const SYNC_ASSET_COPY_CONCURRENCY = 8;
const CONTENT_IMAGE_RE = /^([a-f0-9]{12})(?: \(\d+\))?\.png$/i;
const P2P_DISCOVERY_ADDR = '239.255.43.21';
const P2P_DISCOVERY_PORT = 45454;
const P2P_PROTOCOL_VERSION = 1;
const P2P_ANNOUNCE_INTERVAL_MS = 2000;
const P2P_PULL_THROTTLE_MS = 1000;
const P2P_HTTP_TIMEOUT_MS = 5000;
const P2P_MANUAL_PULL_TIMEOUT_MS = 10000;
const P2P_ASSET_FETCH_CONCURRENCY = 8;
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

ensureDirectory(IMG_DIR);
ensureDirectory(TEXT_DIR);

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
  if (!suppressP2PNotify) p2pNotifyLocalChange();
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

function writeEditedTextToClipboard(text) {
  if (!pollGate) {
    diagnostics.record('editor.clipboard_sync_skipped', { reason: 'poll_gate' }, { forceFile: diagnostics.isEnabled() });
    return false;
  }
  pollGate = false;
  try {
    clipboard.writeText(String(text || ''));
    lastText = String(text || '');
    lastImgHash = '';
    lastCapturedImageToken = '';
    diagnostics.record('editor.clipboard_synced', { text_len: lastText.length }, { forceFile: diagnostics.isEnabled() });
    return true;
  } catch (error) {
    diagnostics.record('editor.clipboard_sync_error', { error: error && error.message }, { forceFile: true });
    return false;
  } finally {
    const timer = setTimeout(() => { pollGate = true; }, 150);
    if (timer.unref) timer.unref();
  }
}

function applyExternalTextEdit({ id, originalText, sourceGroups, newText, writeClipboard = true }) {
  const result = clipboardModel.applyTextEdit(history, {
    id,
    originalText,
    newText,
    sourceGroups,
    groupTombstones: settings.group_tombstones,
    now: Date.now(),
    ignoreBlank: true,
  });
  if (!result.changed) return result;

  for (const tombstoneId of result.tombstoneIds || []) addTombstone(tombstoneId);
  if (result.tombstoneIds && result.tombstoneIds.length) saveSettingsFile();
  saveHistory();
  // Only put the edited text on the clipboard for a deliberate finish (editor
  // close / final save), not every intermediate auto-captured Ctrl+S.
  if (writeClipboard) writeEditedTextToClipboard(newText);
  diagnostics.record('editor.text_applied', {
    reason: result.reason,
    tombstones: (result.tombstoneIds || []).length,
    text_len: String(newText || '').length,
  }, { forceFile: diagnostics.isEnabled() });
  return result;
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
  delete remoteSave.popup_size;
  // AI Access: per-machine, never synced. (groups_shared_with_ai DOES sync - it
  // is user curation that should travel between machines.)
  delete remoteSave.mcp_secret;
  delete remoteSave.ai_access_enabled;
  delete remoteSave.ai_always_allow;
  delete remoteSave.ai_approval_timeout_sec;
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

async function copyNamedFilesAsync(fromDir, toDir, names, filter = () => true) {
  const safeNames = [...new Set(Array.isArray(names) ? names : [])].filter(name => name && filter(name));
  if (!safeNames.length) return 0;
  try { await fs.promises.mkdir(toDir, { recursive: true }); } catch { return 0; }
  let copied = 0;
  await runWithConcurrency(safeNames, SYNC_ASSET_COPY_CONCURRENCY, async name => {
    const safeName = path.basename(String(name));
    if (!safeName || safeName !== name || !filter(safeName)) return;
    const source = path.join(fromDir, safeName);
    const dest = path.join(toDir, safeName);
    try {
      try {
        await fs.promises.access(dest, fs.constants.F_OK);
        return;
      } catch {}
      const stats = await fs.promises.stat(source);
      if (!stats.isFile()) return;
      await fs.promises.copyFile(source, dest);
      copied++;
    } catch {}
  });
  return copied;
}

async function syncRemoteAssets(remoteImgDir, remoteTextDir, { pullHistory = [], pushHistory = [] } = {}) {
  const pullImages = historyImageNames(pullHistory);
  const pullTexts = historyTextRefs(pullHistory);
  const pushImages = historyImageNames(pushHistory);
  const pushTexts = historyTextRefs(pushHistory);
  await Promise.all([
    copyNamedFilesAsync(remoteImgDir, IMG_DIR, pullImages, name => !!safeImageName(name)),
    copyNamedFilesAsync(remoteTextDir, TEXT_DIR, pullTexts, name => !!textBlobStore.safeTextRef(name)),
    copyNamedFilesAsync(IMG_DIR, remoteImgDir, pushImages, name => !!safeImageName(name)),
    copyNamedFilesAsync(TEXT_DIR, remoteTextDir, pushTexts, name => !!textBlobStore.safeTextRef(name)),
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
let suppressP2PNotify = false;
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
  const remoteImgDir = path.join(syncPath, 'clipboard-images');
  const remoteTextDir = path.join(syncPath, textBlobStore.TEXT_BLOB_DIRNAME);
  let remoteHistory = [];
  try {
    const loaded = JSON.parse(await fs.promises.readFile(remoteDbPath, 'utf-8'));
    if (Array.isArray(loaded)) {
      await syncRemoteAssets(remoteImgDir, remoteTextDir, { pullHistory: loaded });
      remoteHistory = textBlobStore.hydrateHistory(loaded, TEXT_DIR);
    }
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

function diagnosticsDeviceFileName() {
  const device = String(settings.p2p_device_id || os.hostname() || 'device').replace(/[^a-z0-9_-]+/ig, '-').slice(0, 48);
  const host = String(os.hostname() || process.platform).replace(/[^a-z0-9_-]+/ig, '-').slice(0, 48);
  return `${host}-${device}.json`;
}

async function writeSyncedDiagnostics(syncPaths, lastResult) {
  if (!diagnostics.isEnabled() || !Array.isArray(syncPaths) || !syncPaths.length) return;
  const payload = JSON.stringify({
    generated_at: new Date().toISOString(),
    device: {
      id: settings.p2p_device_id || '',
      name: p2pDeviceName(),
      hostname: os.hostname(),
      platform: process.platform,
    },
    build: BUILD_INFO,
    runtime: runtimeDiagnosticSnapshot(),
    p2p: p2pStatus(),
    local: stateSummary(DATA_DIR),
    last_sync_result: lastResult || lastSyncResult,
    diagnostics: diagnostics.snapshot({
      log_tail: diagnostics.fileTail(96 * 1024),
    }),
  }, null, 2);
  const fileName = diagnosticsDeviceFileName();
  await Promise.all(syncPaths.map(async syncPath => {
    try {
      const dir = path.join(syncPath, 'boardclip-diagnostics');
      await fs.promises.mkdir(dir, { recursive: true });
      await atomicWriteFileAsync(path.join(dir, fileName), payload);
    } catch {}
  }));
}

function scheduleSyncedDiagnostics(syncPaths, lastResult) {
  if (!diagnostics.isEnabled()) return;
  const timer = setTimeout(() => {
    writeSyncedDiagnostics(syncPaths, lastResult).catch(() => {});
  }, 0);
  if (timer.unref) timer.unref();
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
  const storedHistory = textBlobStore.prepareHistoryForStorage(canonicalHistory, TEXT_DIR);
  const nextHistoryJson = JSON.stringify(storedHistory);
  const nextSettingsJson = JSON.stringify(canonicalSettings, null, 2);
  const [currentHistoryJson, currentSettingsJson] = await Promise.all([
    readFileUtf8IfExists(remoteDbPath),
    readFileUtf8IfExists(remoteSettingsPath),
  ]);
  let currentStoredHistory = null;
  try {
    const parsed = currentHistoryJson ? JSON.parse(currentHistoryJson) : null;
    if (Array.isArray(parsed)) currentStoredHistory = parsed;
  } catch {}
  const pushHistory = historyAssetDelta(storedHistory, currentStoredHistory);
  const wroteHistory = currentHistoryJson !== nextHistoryJson;
  const wroteSettings = currentSettingsJson !== nextSettingsJson;
  await Promise.all([
    wroteHistory ? atomicWriteFileAsync(remoteDbPath, nextHistoryJson) : Promise.resolve(),
    wroteSettings ? atomicWriteFileAsync(remoteSettingsPath, nextSettingsJson) : Promise.resolve(),
    syncRemoteAssets(remoteImgDir, remoteTextDir, { pushHistory }),
  ]);
  await updateSyncProviderCache(syncPath);
  diagnostics.slow('sync.write_remote.slow', Date.now() - startedAt, {
    path: syncPath,
    items: canonicalHistory.length,
    history_bytes: Buffer.byteLength(nextHistoryJson),
    settings_bytes: Buffer.byteLength(nextSettingsJson),
    assets_to_push: pushHistory.length,
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
  pushSoonTimer: null,
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

function p2pSignature(method, requestPath, timestamp, bodyHash) {
  return hmacAuth.sign(settings.p2p_secret, method, requestPath, timestamp, bodyHash);
}

function safeImageName(name) {
  const value = path.basename(String(name || '').trim());
  return CONTENT_IMAGE_RE.test(value) ? value.toLowerCase().replace(/ \(\d+\)(?=\.png$)/, '') : '';
}

function p2pHistoryStorage() {
  return textBlobStore.prepareHistoryForStorage(history, TEXT_DIR);
}

function historyTextRefs(items) {
  const refs = new Set();
  for (const item of Array.isArray(items) ? items : []) {
    const ref = textBlobStore.safeTextRef(item && item.textRef);
    if (ref) refs.add(ref);
  }
  return [...refs];
}

function historyImageNames(items) {
  const names = new Set();
  for (const item of Array.isArray(items) ? items : []) {
    if (!item || item.type !== 'image') continue;
    const name = safeImageName(item.image);
    if (name) names.add(name);
  }
  return [...names];
}

function historyAssetDelta(nextHistory, currentHistory) {
  if (!Array.isArray(currentHistory)) return Array.isArray(nextHistory) ? nextHistory : [];
  const currentImages = new Set(historyImageNames(currentHistory));
  const currentTexts = new Set(historyTextRefs(currentHistory));
  return (Array.isArray(nextHistory) ? nextHistory : []).filter(item => {
    if (!item) return false;
    if (item.type === 'image') {
      const name = safeImageName(item.image);
      return !!name && !currentImages.has(name);
    }
    const ref = textBlobStore.safeTextRef(item.textRef);
    return !!ref && !currentTexts.has(ref);
  });
}

function p2pStatePayload() {
  const storedHistory = p2pHistoryStorage();
  return {
    protocol: P2P_PROTOCOL_VERSION,
    deviceId: settings.p2p_device_id,
    deviceName: p2pDeviceName(),
    build: BUILD_INFO.label,
    port: p2p.port,
    revision: p2p.revision,
    history: storedHistory,
    settings: remoteSettingsPayload(),
    images: historyImageNames(storedHistory),
    texts: historyTextRefs(storedHistory),
  };
}

function p2pVerifyRequest(req, bodyBuffer) {
  return hmacAuth.verify(settings.p2p_secret, {
    method: req.method,
    path: req.url,
    timestamp: Number(req.headers['x-boardclip-ts']) || 0,
    signature: String(req.headers['x-boardclip-sig'] || ''),
    body: bodyBuffer || Buffer.alloc(0),
    windowMs: P2P_AUTH_WINDOW_MS,
  });
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
  req.on('end', async () => {
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
      if (req.method === 'POST' && url.pathname === '/state') {
        let state = null;
        try { state = JSON.parse(body.toString('utf8')); } catch {}
        if (!state || state.protocol !== P2P_PROTOCOL_VERSION || !state.deviceId || state.deviceId === settings.p2p_device_id) {
          res.writeHead(400);
          res.end('Bad state');
          return;
        }
        const port = Number(state.port) || 0;
        if (port > 0 && port <= 65535) {
          const previous = p2p.peers.get(state.deviceId);
          p2p.peers.set(state.deviceId, {
            deviceId: state.deviceId,
            deviceName: state.deviceName || state.deviceId.slice(0, 8),
            host: req.socket && req.socket.remoteAddress || previous && previous.host || '',
            port,
            revision: Number(state.revision) || 0,
            build: state.build || '',
            items: Array.isArray(state.history) ? state.history.length : 0,
            lastSeen: Date.now(),
            lastPulledRevision: previous ? previous.lastPulledRevision : 0,
          });
        }
        const result = await p2pApplyState(state, {
          peerName: state.deviceName || state.deviceId,
          reason: 'push',
          fetchedAssets: 0,
          notifyPeers: false,
        });
        p2pSendJson(res, 200, result);
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
  return hmacAuth.signedHeaders(settings.p2p_secret, settings.p2p_device_id, method, requestPath, body);
}

function p2pHttpRequest(peer, requestPath, { binary = false, method = 'GET', body = Buffer.alloc(0) } = {}) {
  const requestBody = Buffer.isBuffer(body) ? body : Buffer.from(String(body || ''));
  return new Promise((resolve, reject) => {
    const request = http.request({
      hostname: peer.host,
      port: peer.port,
      path: requestPath,
      method,
      timeout: P2P_HTTP_TIMEOUT_MS,
      headers: {
        ...p2pAuthHeaders(method, requestPath, requestBody),
        ...(requestBody.length ? {
          'Content-Type': 'application/json',
          'Content-Length': requestBody.length,
        } : {}),
      },
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
    request.end(requestBody.length ? requestBody : undefined);
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

async function runWithConcurrency(items, limit, worker) {
  const list = Array.isArray(items) ? items : [];
  const workerCount = Math.min(Math.max(1, limit || 1), list.length);
  let nextIndex = 0;
  await Promise.all(Array.from({ length: workerCount }, async () => {
    while (nextIndex < list.length) {
      const item = list[nextIndex++];
      await worker(item);
    }
  }));
}

async function p2pApplyState(state, { peerName, reason, fetchedAssets = 0, notifyPeers = true } = {}) {
  const startedAt = Date.now();
  if (!state || state.protocol !== P2P_PROTOCOL_VERSION || !state.deviceId || state.deviceId === settings.p2p_device_id) {
    throw new Error('invalid peer state');
  }
  const remoteHistory = textBlobStore.hydrateHistory(Array.isArray(state.history) ? state.history : [], TEXT_DIR);
  const previousSettingsJson = JSON.stringify(remoteSettingsPayload());
  const canonicalHistory = foldRemoteState(history.slice(), remoteHistory, state.settings || {});
  const recoveredImages = await recoverRecentOrphanImages(canonicalHistory);
  const localChanged = JSON.stringify(canonicalHistory) !== JSON.stringify(history);
  const settingsChanged = JSON.stringify(remoteSettingsPayload()) !== previousSettingsJson;
  if (localChanged) {
    history.length = 0;
    history.push(...canonicalHistory);
  }
  if (localChanged || settingsChanged) {
    applyingSyncState = true;
    suppressP2PNotify = !notifyPeers;
    try {
      saveHistory();
      saveSettingsFile();
    } finally {
      suppressP2PNotify = false;
      applyingSyncState = false;
    }
    scheduleSyncMerge();
  }
  diagnostics.record('p2p.state_apply', {
    peer: peerName || state.deviceName || state.deviceId,
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
    const assets = [
      ...(state.images || []).map(name => ({ kind: 'image', name })),
      ...(state.texts || []).map(name => ({ kind: 'text', name })),
    ];
    await runWithConcurrency(assets, P2P_ASSET_FETCH_CONCURRENCY, async asset => {
      if (await p2pFetchMissingAsset(peer, asset.kind, asset.name)) fetchedAssets++;
    });
    const result = await p2pApplyState(state, {
      peerName: peer.deviceName || peer.deviceId,
      reason,
      fetchedAssets,
      notifyPeers: true,
    });
    diagnostics.record('p2p.pull', {
      peer: peer.deviceName || peer.deviceId,
      reason,
      ms: Date.now() - startedAt,
      ...result,
    }, { forceFile: result.local_changed || fetchedAssets > 0 });
    return result;
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

async function p2pPushPeer(peer, reason = 'local-change') {
  if (!p2pEnabled() || !peer || peer.deviceId === settings.p2p_device_id) return null;
  const body = Buffer.from(JSON.stringify(p2pStatePayload()));
  try {
    const result = await p2pHttpRequest(peer, '/state', { method: 'POST', body });
    diagnostics.record('p2p.push', {
      peer: peer.deviceName || peer.deviceId,
      reason,
      ok: !!(result && result.ok),
      local_changed: result && result.local_changed,
      settings_changed: result && result.settings_changed,
    }, { forceFile: result && result.local_changed });
    return result;
  } catch (error) {
    diagnostics.record('p2p.push.error', {
      peer: peer.deviceName || peer.deviceId,
      reason,
      error: error && error.message,
    }, { forceFile: true });
    return { ok: false, error: error && error.message };
  }
}

function p2pPushPeersSoon(reason = 'local-change') {
  if (!p2pEnabled()) return;
  if (p2p.pushSoonTimer) clearTimeout(p2p.pushSoonTimer);
  p2p.pushSoonTimer = setTimeout(() => {
    p2p.pushSoonTimer = null;
    const peers = p2pPeerSummaries();
    for (const peer of peers) p2pPushPeer(peer, reason);
  }, 150);
  if (p2p.pushSoonTimer.unref) p2p.pushSoonTimer.unref();
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
  p2pPushPeersSoon('local-change');
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
  const startedDataRevision = dataRevision;
  const hadLocalDirty = startedDirtyVersion !== syncedDirtyVersion;
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
        force_read: force,
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
      try {
        const providerResult = await withTimeout((async () => {
          const signature = await syncProviderSignature(syncPath);
          const signatureKey = syncProviderSignatureKey(signature);
          const cached = syncProviderCache.get(syncPath);
          const remoteChanged = !cached || cached.signatureKey !== signatureKey;
          const shouldReadRemote = fullSync || remoteChanged;
          if (!shouldReadRemote && !hadLocalDirty) {
            return {
              path: syncPath,
              skipped: true,
              remote_changed: false,
              full_sync: false,
              ms: Date.now() - providerStartedAt,
            };
          }

          if (!shouldReadRemote) {
            return {
              path: syncPath,
              skipped: true,
              remote_changed: false,
              local_dirty: hadLocalDirty,
              full_sync: false,
              ms: Date.now() - providerStartedAt,
            };
          }

          const { remoteHistory, remoteSettings } = await readRemoteState(syncPath);
          await updateSyncProviderCache(syncPath);
          return {
            path: syncPath,
            skipped: false,
            remote_changed: remoteChanged,
            full_sync: fullSync,
            remote_items: remoteHistory.length,
            remote_history: remoteHistory,
            remote_settings: remoteSettings,
            ms: Date.now() - providerStartedAt,
          };
        })(), SYNC_PROVIDER_READ_TIMEOUT_MS, `read ${syncPath}`);

        if (!providerResult.skipped) {
          canonicalHistory = foldRemoteState(canonicalHistory, providerResult.remote_history, providerResult.remote_settings);
          providerResult.canonical_items = canonicalHistory.length;
          delete providerResult.remote_history;
          delete providerResult.remote_settings;
        }
        providers.push(providerResult);
      } catch (error) {
        providers.push({
          path: syncPath,
          skipped: true,
          error: error && error.message,
          timed_out: error && /timed out/.test(error.message),
          ms: Date.now() - providerStartedAt,
        });
        diagnostics.record('sync.provider_read.error', {
          path: syncPath,
          error: error && error.message,
        }, { forceFile: true });
      }
    }

    if (syncDirtyVersion !== startedDirtyVersion || dataRevision !== startedDataRevision) {
      canonicalHistory = mergeHistories(history.slice(), canonicalHistory);
      diagnostics.record('sync.merge_rebased_local', {
        started_dirty_version: startedDirtyVersion,
        current_dirty_version: syncDirtyVersion,
        started_revision: startedDataRevision,
        current_revision: dataRevision,
        items: canonicalHistory.length,
      }, { forceFile: true });
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
      await Promise.all(syncPaths.map(syncPath => (
        withTimeout(
            writeRemoteState(syncPath, history, canonicalSettings),
            SYNC_REMOTE_WRITE_TIMEOUT_MS,
            `write ${syncPath}`
        ).catch(error => {
          diagnostics.record('sync.write_remote.error', {
            path: syncPath,
            error: error && error.message,
          }, { forceFile: true });
        })
      )));
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
      force_read: force,
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
        force_read: force,
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
        force_read: force,
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
    scheduleSyncedDiagnostics(syncPaths, result);
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
let lastPollGateLogAt = 0;
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

function textLooksLikeLink(text) {
  return /^(?:https?:\/\/|www\.|mailto:|file:\/\/)/i.test(String(text || '').trim());
}

function historyEntryDiagnostics(entry) {
  if (!entry) return {};
  if (entry.type === 'image') {
    return {
      type: 'image',
      image: entry.image,
      width: entry.width,
      height: entry.height,
    };
  }
  const text = String(entry.text || '');
  return {
    type: 'text',
    text_length: text.length,
    text_hash: crypto.createHash('sha256').update(text).digest('hex').slice(0, 16),
    looks_like_link: textLooksLikeLink(text),
  };
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
    diagnostics.record('history.add_skipped', {
      reason: 'already_top',
      ...historyEntryDiagnostics(entry),
      items: history.length,
      ms: Date.now() - startedAt,
    }, { forceFile: true });
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
    ...historyEntryDiagnostics(entry),
    moved_existing: existIdx >= 0,
    items: history.length,
    ms: Date.now() - startedAt,
  }, { forceFile: true });
}

function pollClipboard() {
  if (!pollGate) {
    if (Date.now() - lastPollGateLogAt > 5000) {
      lastPollGateLogAt = Date.now();
      diagnostics.record('clipboard.poll_blocked', { reason: 'poll_gate' }, { forceFile: true });
    }
    return;
  }

  const startedAt = Date.now();
  let formatsKey = '';
  let action = 'none';
  try {
    const formats = clipboardFormats();
    formatsKey = clipboardCapture.formatsKey(formats);
    const hasImageFormat = formatsContainImage(formatsKey);
    const text = clipboard.readText();
    const preferText = !!text && text !== lastText && (!hasImageFormat || textLooksLikeLink(text));
    if (preferText) {
      action = hasImageFormat ? 'text_added_preferred_over_image' : 'text_added';
      lastText = text;
      lastImgHash = '';
      addToHistory(
        { type: 'text', text, ts: Date.now() / 1000 },
        it => it.text === text
      );
      return;
    }

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
      if (!captured) {
        action = text ? 'image_capture_empty_with_text' : 'image_capture_empty';
        return;
      }
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

function runAppleScript(script, timeoutMs = 1500) {
  return new Promise(resolve => {
    const startedAt = Date.now();
    execFile('osascript', ['-e', script], { timeout: timeoutMs }, (error, stdout) => {
      resolve({
        ok: !error,
        error: error && error.message,
        stdout: String(stdout || '').trim(),
        ms: Date.now() - startedAt,
      });
    });
  });
}

function getFrontmostMacAppName() {
  if (process.platform !== 'darwin') return Promise.resolve('');
  return runAppleScript('tell application "System Events" to get name of first application process whose frontmost is true').then(result => {
    if (result.ms > 250 || !result.ok) {
      diagnostics.record('macos.frontmost_app.slow', {
        ms: result.ms,
        ok: result.ok,
        error: result.error,
      }, { forceFile: true });
    }
    return result.ok ? result.stdout : '';
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
// Sends Ctrl+V (Cmd+V on mac) to the currently focused window. The hot path
// uses native OS event APIs; AppleScript is only a macOS fallback when we must
// re-activate a previously frontmost app after hiding the popup.
function simulatePaste(targetAppName = '') {
  if (process.platform === 'win32') {
    winPaste.sendCtrlV();
    return Promise.resolve();
  }
  if (process.platform === 'darwin' && !targetAppName) {
    const startedAt = Date.now();
    const result = macPaste.sendCommandV();
    result.ms = Date.now() - startedAt;
    if (result.ok) return Promise.resolve(result);
    diagnostics.record('macos.simulate_paste.native_failed', {
      ms: result.ms,
      error: result.error,
    }, { forceFile: true });
  }
  const target = escapeAppleScriptString(targetAppName);
  const script = target ? `
      tell application "System Events"
        try
          tell application "${target}" to activate
          delay 0.05
        end try
        keystroke "v" using command down
      end tell`
    : 'tell application "System Events" to keystroke "v" using command down';
  return runAppleScript(script, 2000).then(result => {
    if (process.platform === 'darwin' && !targetAppName && result.ok) {
      diagnostics.record('macos.simulate_paste.native_fallback_ok', {
        ms: result.ms,
      }, { forceFile: true });
    }
    if (result.ms > 250 || !result.ok) {
      diagnostics.record('macos.simulate_paste.slow', {
        ms: result.ms,
        ok: result.ok,
        target_app: targetAppName || '',
        error: result.error,
      }, { forceFile: true });
    }
    return result;
  });
}

// --- Numpad quick-paste ---
async function numpadPaste(slotNum, options = {}) {
  const trace = options.trace || {};
  const startedAt = Date.now();
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
  let pasteResult = null;
  try {
    const backupStartedAt = Date.now();
    backup = backupClipboard();
    const setStartedAt = Date.now();
    setClipboardToItem(item);
    const clipboardSetMs = Date.now() - setStartedAt;
    diagnostics.record('shortcut.quick_paste_clipboard_set', {
      ...trace,
      slot: slotNum,
      item_id: itemKey(item),
      item_type: item.type || 'text',
      text_len: item.type === 'image' ? undefined : String(item.text || '').length,
      backup_text_len: backup && backup.text ? backup.text.length : 0,
      backup_ms: setStartedAt - backupStartedAt,
      clipboard_set_ms: clipboardSetMs,
      since_received_ms: trace.received_at ? Date.now() - trace.received_at : undefined,
      window: macWindowSnapshot(),
    }, { forceFile: true });
  // Minimum delay for Windows clipboard propagation before paste. 15ms is
  // tight but reliable — clipboard.writeText is synchronous and Windows
  // WM_CLIPBOARDUPDATE propagates within a few ms on any modern system.
    await new Promise(r => setTimeout(r, 15));
    const pasteStartedAt = Date.now();
    pasteResult = await simulatePaste(options.targetAppName || '');
    const pasteMs = Date.now() - pasteStartedAt;
    const shouldCheckFrontmost = process.platform === 'darwin' && (options.targetAppName || (pasteResult && pasteResult.ok === false));
    const frontmostStartedAt = Date.now();
    const frontmostAfterPaste = shouldCheckFrontmost ? await getFrontmostMacAppName() : '';
    const frontmostMs = shouldCheckFrontmost ? Date.now() - frontmostStartedAt : 0;
    diagnostics.record('shortcut.quick_paste_pasted', {
      ...trace,
      slot: slotNum,
      target_app: options.targetAppName || '',
      frontmost_after_paste: frontmostAfterPaste,
      paste_ok: !pasteResult || pasteResult.ok !== false,
      paste_error: pasteResult && pasteResult.error,
      paste_ms: pasteMs,
      frontmost_ms: frontmostMs,
      since_received_ms: trace.received_at ? Date.now() - trace.received_at : undefined,
      window: macWindowSnapshot(),
    }, { forceFile: true });
    await new Promise(r => setTimeout(r, 150));
  // Fire-and-forget restore: the target app needs ~100-150ms to read from
  // the clipboard after receiving Ctrl+V. We don't block the caller on that.
  } finally {
    const restoreStartedAt = Date.now();
    try { restoreClipboard(backup); } catch {}
    const restoreMs = Date.now() - restoreStartedAt;
    const shouldCheckFrontmost = process.platform === 'darwin' && (options.targetAppName || (pasteResult && pasteResult.ok === false));
    const frontmostStartedAt = Date.now();
    const frontmostAfterRestore = shouldCheckFrontmost ? await getFrontmostMacAppName() : '';
    const frontmostMs = shouldCheckFrontmost ? Date.now() - frontmostStartedAt : 0;
    diagnostics.record('shortcut.quick_paste_restored', {
      ...trace,
      slot: slotNum,
      frontmost_after_restore: frontmostAfterRestore,
      restore_ms: restoreMs,
      frontmost_ms: frontmostMs,
      total_ms: Date.now() - startedAt,
      since_received_ms: trace.received_at ? Date.now() - trace.received_at : undefined,
      window: macWindowSnapshot(),
    }, { forceFile: true });
    pollGate = true;
  }
}

// --- Window & state ---
const WIN_W = 460;
const WIN_H = 520;
const MIN_WIN_W = 360;
const MIN_WIN_H = 360;
const MAX_WIN_W = 900;
const MAX_WIN_H = 900;
let win = null;
let tray = null;

function popupSizeFromSettings() {
  const size = settings.popup_size && typeof settings.popup_size === 'object' ? settings.popup_size : {};
  const width = Math.min(MAX_WIN_W, Math.max(MIN_WIN_W, Math.round(Number(size.width) || WIN_W)));
  const height = Math.min(MAX_WIN_H, Math.max(MIN_WIN_H, Math.round(Number(size.height) || WIN_H)));
  return { width, height };
}

let savePopupSizeTimer = null;
function schedulePopupSizeSave() {
  if (!win || win.isDestroyed()) return;
  if (savePopupSizeTimer) clearTimeout(savePopupSizeTimer);
  savePopupSizeTimer = setTimeout(() => {
    savePopupSizeTimer = null;
    if (!win || win.isDestroyed()) return;
    const { width, height } = win.getBounds();
    const next = {
      width: Math.min(MAX_WIN_W, Math.max(MIN_WIN_W, Math.round(width))),
      height: Math.min(MAX_WIN_H, Math.max(MIN_WIN_H, Math.round(height))),
    };
    const current = popupSizeFromSettings();
    if (next.width === current.width && next.height === current.height) return;
    settings.popup_size = next;
    saveSettingsFile();
    diagnostics.record('popup.resize_saved', next, { forceFile: diagnostics.isEnabled() });
  }, 250);
  if (savePopupSizeTimer.unref) savePopupSizeTimer.unref();
}

function currentColorScheme() {
  return nativeTheme.shouldUseDarkColors ? 'dark' : 'light';
}

function appBackgroundColor() {
  if (process.platform === 'darwin') return '#00000000';
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
  const initialSize = popupSizeFromSettings();
  win = new BrowserWindow({
    width: initialSize.width,
    height: initialSize.height,
    minWidth: MIN_WIN_W,
    minHeight: MIN_WIN_H,
    maxWidth: MAX_WIN_W,
    maxHeight: MAX_WIN_H,
    frame: false,
    alwaysOnTop: true,
    show: false,
    skipTaskbar: true,
    resizable: true,
    transparent: process.platform === 'darwin',
    vibrancy: process.platform === 'darwin' ? 'popover' : undefined,
    visualEffectState: process.platform === 'darwin' ? 'active' : undefined,
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
  win.on('resize', schedulePopupSizeSave);

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
  const { width, height } = win.getBounds();
  const popupWidth = Math.min(width, ww);
  const popupHeight = Math.min(height, wh);

  const x = Math.min(Math.max(wx, cursor.x - popupWidth / 2), wx + ww - popupWidth);
  const y = Math.min(Math.max(wy, cursor.y - 50), wy + wh - popupHeight);

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

function validNumpadSlot(slot) {
  const slotNum = Number(slot);
  return Number.isInteger(slotNum) && slotNum >= 1 && slotNum <= 9 ? slotNum : null;
}

async function runNumpadSlotAction(slot, options = {}) {
  const slotNum = validNumpadSlot(slot);
  if (slotNum == null) return;

  const trace = {
    seq: ++quickPasteTraceSeq,
    received_at: Date.now(),
    source: options.source || 'shortcut',
  };
  diagnostics.record('shortcut.quick_paste_received', { ...trace, slot: slotNum }, { forceFile: true });

  const popupVisible = !!(win && !win.isDestroyed() && win.isVisible());
  const popupFocused = popupVisible && win.isFocused();
  const hasItem = history.some(h => hasNumpadSlot(h, slotNum));
  const assignWhenFocused = options.assignWhenFocused !== false;
  const shouldAssign = assignWhenFocused && popupFocused;
  const shouldCaptureMacTarget = process.platform === 'darwin' && popupVisible && !popupFocused;
  const frontmostStartedAt = Date.now();
  const targetAppName = shouldCaptureMacTarget ? await getFrontmostMacAppName() : '';
  const frontmostMs = Date.now() - frontmostStartedAt;

  diagnostics.record('shortcut.quick_paste', {
    ...trace,
    slot: slotNum,
    popup_visible: popupVisible,
    popup_focused: popupFocused,
    has_item: hasItem,
    target_app: targetAppName,
    frontmost_ms: frontmostMs,
    since_received_ms: Date.now() - trace.received_at,
    window: macWindowSnapshot(),
  }, { forceFile: true });

  if (shouldAssign) {
    win.webContents.executeJavaScript(`window.assignNumpad(${slotNum})`).catch(() => {});
    return;
  }

  if (popupVisible) hidePopup();
  if (process.platform === 'win32' && popupVisible && savedForegroundWindow) {
    winPaste.setForegroundWindow(savedForegroundWindow);
  }
  await new Promise(r => setTimeout(r, 15));
  await numpadPaste(slotNum, { targetAppName, trace });
  if (win && !win.isDestroyed() && win.isVisible()) {
    diagnostics.record('shortcut.quick_paste_force_hide', { ...trace, slot: slotNum, window: macWindowSnapshot() }, { forceFile: true });
    hidePopup();
  }
}

async function numpadPasteAndHide(slot) {
  await runNumpadSlotAction(slot, {
    source: 'panel_number',
    assignWhenFocused: false,
  });
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
// External text editing is the classic place to lose work, so it's defended in
// layers (a hash-chain, anchored on the base-content hash captured at open):
//
//   1. FIRST defence - one window per clip. If the user triggers an editor for a
//      clip that's already being edited, we focus/re-surface the EXISTING editor
//      on the SAME temp file instead of spawning a second window. One window =
//      one base = divergence is structurally impossible.
//   2. SECOND defence - if a divergence IS detected (the live clip's hash no
//      longer matches the base hash this edit descends from, e.g. a sync or a
//      second writer moved it), the save FORKS into a new clip instead of
//      overwriting - the write path (applyTextEdit) is conflict-safe.
//   3. CAPTURE ON SAVE, not just on exit. We watch the temp file and persist
//      every Ctrl+S immediately, then re-anchor the chain to what we just saved.
//      So a saved buffer survives even an unclean editor close or a BoardClip
//      restart mid-edit (which would otherwise never reach the exit handler).
//   4. ORPHAN RECOVERY on startup - any boardclip-edit-* temp left behind by a
//      previous session (app died while an editor was open) is re-applied.
//
// activeEdits: originalId(at open) -> session. The session's `baseText`/`currentId`
// are re-anchored after each captured save so the chain stays contiguous.
const activeEdits = new Map();
const EDIT_TMP_RE = /^boardclip-edit-[0-9a-f]{12}-\d+\.txt$/;

function spawnTextEditor(tmpPath) {
  const cmd = process.platform === 'darwin' ? 'open' : 'notepad.exe';
  const args = process.platform === 'darwin' ? ['-t', '-W', tmpPath] : [tmpPath];
  return spawn(cmd, args, { detached: true, stdio: 'ignore' });
}

function showEditNotification(title, body) {
  try {
    if (Notification && Notification.isSupported && Notification.isSupported()) {
      new Notification({ title, body, silent: true }).show();
    }
  } catch {}
}

// Surface the conflict-fork outcome so a stale-based save is never again
// mistaken for a clobber: the user's edit was kept as a new clip, untouched.
function notifyEditOutcome(result) {
  if (!result || (result.reason !== 'conflict_created' && result.reason !== 'conflict_merged')) return;
  showEditNotification(
    'BoardClip - saved as a separate clip',
    'This clip changed while you were editing, so your version was kept as a new clip instead of overwriting. Nothing was lost.'
  );
}

// Persist the editor's current on-disk content (a Ctrl+S, or the final read on
// exit). Re-anchors the session chain so the next save descends from this one
// (otherwise every intermediate save would look diverged and needlessly fork).
function captureExternalEdit(session, { final = false } = {}) {
  let newText;
  try { newText = fs.readFileSync(session.tmpPath, 'utf-8'); } catch { return; }
  if (newText === session.lastCaptured) return;
  const result = applyExternalTextEdit({
    id: session.currentId,
    originalText: session.baseText,
    sourceGroups: session.sourceGroups,
    newText,
    writeClipboard: final,   // don't hijack the clipboard on intermediate auto-saves
  });
  if (result && result.changed) {
    session.lastCaptured = newText;
    session.baseText = newText;                                  // re-anchor the chain
    if (result.item) session.currentId = itemKey(result.item);
    notifyEditOutcome(result);
  } else if (final && result && result.reason === 'blank') {
    // editor saved an empty buffer then closed - leave the clip as-is.
  }
}

function openEditor(id) {
  const item = findHistoryItem(id);
  if (!item || item.type === 'image') return;
  textBlobStore.hydrateTextItem(item, TEXT_DIR);
  const originalId = itemKey(item);

  // FIRST defence: same clip already open -> focus the existing editor on the
  // same temp file rather than spawning a second window with its own base.
  const existing = activeEdits.get(originalId);
  if (existing) {
    try { const p = spawnTextEditor(existing.tmpPath); p.unref(); } catch {}
    return;
  }

  const originalText = item.text || '';
  const sourceGroups = [...groupsOf(item)];
  // Tag the temp with the base-content hash (the chain anchor) so an edit's
  // lineage is explicit and recoverable straight from the filename.
  const baseHash = clipboardModel.textHashForText(originalText);
  const tmpPath = path.join(os.tmpdir(), `boardclip-edit-${baseHash.slice(0, 12)}-${Date.now()}.txt`);
  fs.writeFileSync(tmpPath, originalText, 'utf-8');

  const proc = spawnTextEditor(tmpPath);
  const session = { tmpPath, proc, currentId: originalId, baseText: originalText, lastCaptured: originalText, sourceGroups };

  // CAPTURE ON SAVE: persist each Ctrl+S immediately (debounced - fs.watch can
  // fire several events per write). Means a saved buffer is never lost to an
  // unclean close or an app restart that the exit handler would miss.
  let saveTimer = null;
  try {
    session.watcher = fs.watch(tmpPath, () => {
      clearTimeout(saveTimer);
      saveTimer = setTimeout(() => { if (activeEdits.get(originalId) === session) captureExternalEdit(session); }, 250);
    });
  } catch {}

  activeEdits.set(originalId, session);

  proc.on('exit', () => {
    activeEdits.delete(originalId);
    clearTimeout(saveTimer);
    try { if (session.watcher) session.watcher.close(); } catch {}
    captureExternalEdit(session, { final: true });
    try { fs.unlinkSync(tmpPath); } catch {}
  });

  proc.unref();
}

// ORPHAN RECOVERY: re-apply any external-edit temp left behind by a previous
// session (BoardClip died/restarted while an editor was still open, so the
// exit handler never ran). Called once after history is loaded at startup.
function recoverOrphanedEdits() {
  let files;
  try { files = fs.readdirSync(os.tmpdir()); } catch { return; }
  let recovered = 0;
  for (const name of files) {
    if (!EDIT_TMP_RE.test(name)) continue;
    const p = path.join(os.tmpdir(), name);
    let text;
    try { text = fs.readFileSync(p, 'utf-8'); } catch { continue; }
    // Only recover if the content isn't already present as a live clip (i.e. it
    // really never got applied). Add as a new clip - fork-safe, never overwrites.
    if (text.trim() && !history.some(it => (it.text || '') === text)) {
      const result = applyExternalTextEdit({ id: '', originalText: '', sourceGroups: [], newText: text, writeClipboard: false });
      if (result && result.changed) recovered++;
    }
    try { fs.unlinkSync(p); } catch {}
  }
  if (recovered > 0) {
    showEditNotification(
      'BoardClip - recovered unsaved edits',
      `${recovered} edit${recovered === 1 ? '' : 's'} from a previous session ${recovered === 1 ? 'was' : 'were'} restored as new clip${recovered === 1 ? '' : 's'}.`
    );
  }
}

// ===========================================================================
// AI Access - local MCP server
//
// The standalone stdio MCP helper (mcp/boardclip-mcp.js) reads shared clips
// straight from the data files. For anything beyond the allowlist, any mutation,
// and any clipboard write, it calls this process over the local control channel
// (named pipe / Unix socket), where the action is gated behind the approval
// modal. All mutation logic is REUSED from the apply* helpers below, which the
// IPC handlers also use - no duplication.
// ===========================================================================

// ---- Reusable mutation primitives (shared by IPC + MCP) ----
function applyPinToggle(id) {
  const item = findHistoryItem(id);
  if (!item) return false;
  if (!item.pin) {
    item.pin = {};
  } else if (typeof item.pin.number === 'number') {
    delete item.pin.number;
    touchPinNumber(item);
    saveHistory();
    return true;
  } else {
    item.pin = null;
  }
  touchPin(item);
  saveHistory();
  return true;
}

function applyNumpadAssign(id, slot) {
  const item = findHistoryItem(id);
  if (typeof slot !== 'number' || slot < 1 || slot > 9 || !item) return false;
  const now = Date.now();
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
  return true;
}

function applyGroupCreate(name) {
  if (!name) return false;
  if (!settings.groups) settings.groups = [];
  settings.group_tombstones = normalizeGroupTombstones(settings.group_tombstones)
    .filter(t => t.name !== name);
  if (!settings.groups.includes(name)) settings.groups.push(name);
  saveSettingsFile();
  return true;
}

function applyGroupDelete(name) {
  const groups = settings.groups || [];
  const idx = groups.indexOf(name);
  if (idx < 0) return false;
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
  // Keep the AI-share allowlist consistent when a group is removed.
  if (Array.isArray(settings.groups_shared_with_ai)) {
    settings.groups_shared_with_ai = settings.groups_shared_with_ai.filter(g => g !== name);
  }
  saveSettingsFile();
  saveHistory();
  return true;
}

// Toggle membership in a group. Multi-group: an item can belong to many.
function applyGroupAssign(id, group) {
  const item = findHistoryItem(id);
  if (!item || !group) return false;
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
  return true;
}

function applyDeleteItem(id) {
  const index = findHistoryIndex(id);
  if (index < 0) return false;
  deleteHistoryIndex(index);
  saveSettingsFile();
  saveHistory();
  return true;
}

function applyAddText(text, group) {
  const value = String(text || '');
  if (!value) return false;
  addToHistory({ type: 'text', text: value, ts: Date.now() / 1000 }, it => it.type !== 'image' && it.text === value);
  if (group) {
    const item = history.find(it => it.type !== 'image' && it.text === value);
    if (item) {
      if (!settings.groups || !settings.groups.includes(group)) applyGroupCreate(group);
      const pin = ensurePin(item);
      if (!pin.groups) pin.groups = [];
      if (!pin.groups.includes(group)) {
        pin.groups.push(group);
        touchPinGroups(item);
        saveHistory();
      }
    }
  }
  return true;
}

// ---- MCP identity + runtime command ----
function ensureMcpIdentity() {
  if (!settings.mcp_secret) {
    settings.mcp_secret = crypto.randomBytes(32).toString('hex');
    return true;
  }
  return false;
}

// The exact command an MCP client should spawn. Electron-as-node works for both
// source checkouts and packaged builds (no `node` on PATH required, pure-JS
// requires resolve through asar), so one unified command covers every install.
function mcpRuntimeCommand() {
  const entry = path.join(SCRIPT_DIR, 'mcp', 'boardclip-mcp.js');
  return { command: process.execPath, args: [entry], env: { ELECTRON_RUN_AS_NODE: '1' } };
}

// ---- Control server lifecycle ----
let mcpControlServer = null;
const mcpSessionAllow = new Set();
let approvalSeq = 0;
const pendingApprovals = new Map();

function clampApprovalTimeout(value) {
  const n = Math.round(Number(value));
  if (!Number.isFinite(n)) return 60;
  return Math.min(600, Math.max(5, n));
}

function writeMcpDiscovery(pipePath) {
  const cmd = mcpRuntimeCommand();
  try {
    mcpPaths.writeDiscovery({
      dataDir: DATA_DIR,
      pipePath,
      secret: settings.mcp_secret,
      appVersion: BUILD_INFO.label,
      command: cmd.command,
      args: cmd.args,
      env: cmd.env,
      pid: process.pid,
    });
  } catch (error) {
    diagnostics.record('mcp.discovery.write_failed', { error: error && error.message }, { forceFile: true });
  }
}

async function startMcpControlServer() {
  if (mcpControlServer) return;
  if (ensureMcpIdentity()) saveSettingsFile();
  const pipePath = mcpPaths.defaultPipePath();
  const server = new ControlServer({
    pipePath,
    secret: settings.mcp_secret,
    handleRequest: mcpHandleRequest,
    onError: error => diagnostics.record('mcp.control.error', { error: error && error.message }, { forceFile: true }),
  });
  try {
    await server.start();
    mcpControlServer = server;
    writeMcpDiscovery(pipePath);
    diagnostics.record('mcp.control.started', { pipe: pipePath }, { forceFile: true });
  } catch (error) {
    diagnostics.record('mcp.control.start_failed', { error: error && error.message }, { forceFile: true });
  }
}

async function stopMcpControlServer() {
  if (mcpControlServer) {
    try { await mcpControlServer.stop(); } catch {}
    mcpControlServer = null;
  }
  mcpPaths.clearDiscovery();
}

// ---- Client registration ----
function mcpAutoRegister() {
  try { return mcpInstallers.enableDetected(mcpRuntimeCommand()); } catch { return []; }
}

function mcpUnregisterAll() {
  try { mcpInstallers.disableAll(); } catch {}
}

// ---- Allowlist / AI group ----
function ensureAiGroupShared() {
  let changed = false;
  if (!settings.groups) settings.groups = [];
  if (!settings.groups.includes(mcpCore.AI_GROUP_NAME)) {
    applyGroupCreate(mcpCore.AI_GROUP_NAME);
  }
  if (!Array.isArray(settings.groups_shared_with_ai)) settings.groups_shared_with_ai = [];
  if (!settings.groups_shared_with_ai.includes(mcpCore.AI_GROUP_NAME)) {
    settings.groups_shared_with_ai.push(mcpCore.AI_GROUP_NAME);
    changed = true;
  }
  if (changed) saveSettingsFile();
}

function setGroupSharedWithAi(name, shared) {
  if (!name) return;
  if (!Array.isArray(settings.groups_shared_with_ai)) settings.groups_shared_with_ai = [];
  const has = settings.groups_shared_with_ai.includes(name);
  if (shared && !has) settings.groups_shared_with_ai.push(name);
  else if (!shared && has) settings.groups_shared_with_ai = settings.groups_shared_with_ai.filter(g => g !== name);
  else return;
  saveSettingsFile();
  notifyAiAccessChanged();
}

function isItemSharedWithAi(item) {
  return item ? mcpCore.isShared(item, mcpCore.sharedGroupSet(settings)) : false;
}

async function setAiAccessEnabled(enabled) {
  settings.ai_access_enabled = !!enabled;
  saveSettingsFile();
  if (settings.ai_access_enabled) {
    ensureAiGroupShared();
    await startMcpControlServer();
    mcpAutoRegister();
  } else {
    await stopMcpControlServer();
    mcpUnregisterAll();
  }
  notifyAiAccessChanged();
  return aiAccessState();
}

function aiAccessState() {
  return {
    enabled: !!settings.ai_access_enabled,
    running: !!mcpControlServer,
    clients: mcpInstallers.statuses(),
    sharedGroups: Array.isArray(settings.groups_shared_with_ai) ? settings.groups_shared_with_ai.slice() : [],
    aiGroup: mcpCore.AI_GROUP_NAME,
    alwaysAllow: Array.isArray(settings.ai_always_allow) ? settings.ai_always_allow.slice() : [],
    timeoutSec: clampApprovalTimeout(settings.ai_approval_timeout_sec),
    command: mcpRuntimeCommand(),
  };
}

function notifyAiAccessChanged() {
  if (win && !win.isDestroyed()) {
    try { win.webContents.send('ai-access-changed'); } catch {}
  }
}

// Ids of clips the secret guard would withhold - surfaced so the UI can badge
// risky clips. Computed on a copy; never mutates or persists the history items.
function aiSecretFlags() {
  const ids = [];
  for (const item of history) {
    if (item.type === 'image' || item.shareAnyway) continue;
    if (secretGuard.isLikelySecret(item.text != null ? item.text : item.textPreview)) ids.push(itemKey(item));
  }
  return ids;
}

// ---- Approval modal ----
function requestApproval(request) {
  return new Promise(resolve => {
    const id = `appr-${++approvalSeq}`;
    const timeoutSec = clampApprovalTimeout(settings.ai_approval_timeout_sec);
    const payload = { ...request, id, timeoutSec };
    let settled = false;
    const finish = decision => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      pendingApprovals.delete(id);
      try { if (modal && !modal.isDestroyed()) modal.close(); } catch {}
      diagnostics.record('mcp.approval', { tool: request.tool, client: request.client, decision }, { forceFile: true });
      resolve(decision);
    };
    const timer = setTimeout(() => finish('timeout'), (timeoutSec + 3) * 1000);

    const modal = new BrowserWindow({
      width: 440,
      height: 360,
      useContentSize: true,
      frame: false,
      resizable: false,
      maximizable: false,
      fullscreenable: false,
      alwaysOnTop: true,
      center: true,
      show: false,
      skipTaskbar: false,
      title: 'BoardClip - approve AI action',
      backgroundColor: appBackgroundColor(),
      icon: APP_ICON_PATH,
      webPreferences: {
        preload: path.join(SCRIPT_DIR, 'mcp-approval-preload.js'),
        contextIsolation: true,
        nodeIntegration: false,
      },
    });
    modal.setAlwaysOnTop(true, 'screen-saver');
    pendingApprovals.set(id, { finish });
    modal.loadFile(path.join(SCRIPT_DIR, 'mcp-approval.html'));
    modal.once('ready-to-show', () => { try { modal.show(); modal.focus(); } catch {} });
    modal.webContents.on('did-finish-load', () => {
      try { modal.webContents.send('approval-request', payload); } catch {}
    });
    modal.on('closed', () => finish('deny'));
  });
}

function buildApprovalRequest(tool, args, targetItem, client) {
  const dangerTools = new Set(['delete_clip', 'copy_to_clipboard', 'paste_clip']);
  // Read tools (list_context/list_clips/get_clip-shared/search-shared) are served
  // locally in the helper and never reach this function - so only forwarded/gated
  // tools need entries here.
  const meta = {
    add_clip: 'Add a new clip to your history',
    pin_clip: 'Pin / unpin a clip',
    set_numpad: 'Assign a clip to a numpad slot',
    assign_group: 'Change a clip\'s group',
    create_group: 'Create a group',
    delete_group: 'Delete a group',
    delete_clip: 'Delete a clip from your history',
    copy_to_clipboard: 'Put content on your system clipboard',
    paste_clip: 'Put a clip on the clipboard and paste it',
    read_clip: 'Read the full text of a clip you have NOT shared with AI',
    search_all: 'Search across ALL clips, including ones not shared with AI',
    image_path: 'Get the file path of an image clip',
  };
  let detail = '';
  if (tool === 'add_clip') detail = String(args.text || '');
  else if (tool === 'copy_to_clipboard') detail = args.text != null ? String(args.text) : previewForItem(targetItem);
  else if (tool === 'search_all') detail = `Query: ${args.query || ''}`;
  else if (tool === 'create_group' || tool === 'delete_group') detail = `Group: ${args.name || ''}`;
  else if (targetItem) detail = previewForItem(targetItem);
  return {
    tool,
    client: client || 'an AI assistant',
    title: meta[tool] || `Run ${tool}`,
    summary: meta[tool] || tool,
    detail: detail.length > 4000 ? `${detail.slice(0, 4000)}…` : detail,
    danger: dangerTools.has(tool),
  };
}

function previewForItem(item) {
  if (!item) return '';
  if (item.type === 'image') return `[image ${item.image || ''}]`;
  textBlobStore.hydrateTextItem(item, TEXT_DIR);
  const text = String(item.text || '');
  return text.length > 600 ? `${text.slice(0, 600)}…` : text;
}

// ---- Action gating + dispatch ----
const MCP_ALWAYS_GATED = new Set(['delete_clip', 'copy_to_clipboard', 'paste_clip', 'read_clip', 'search_all', 'image_path']);
const MCP_MANAGE_FREE_ON_SHARED = new Set(['pin_clip', 'set_numpad', 'assign_group', 'create_group', 'delete_group', 'add_clip']);

function mcpNeedsApproval(tool, targetItem) {
  if (mcpSessionAllow.has(tool)) return false;
  if (Array.isArray(settings.ai_always_allow) && settings.ai_always_allow.includes(tool)) return false;
  if (MCP_ALWAYS_GATED.has(tool)) return true;
  if (MCP_MANAGE_FREE_ON_SHARED.has(tool)) {
    if (!targetItem) return false;          // create/delete group, add_clip with no clip target
    return !isItemSharedWithAi(targetItem); // free on shared clips, gated on non-shared
  }
  return true;
}

async function mcpHandleRequest(reqPath, payload) {
  const { tool, args = {}, client } = payload || {};
  if (!tool) throw new Error('missing_tool');
  if (!settings.ai_access_enabled) throw new Error('ai_access_disabled');
  const targetId = args.id || null;
  const targetItem = targetId ? findHistoryItem(targetId) : null;

  let decision = 'auto';
  if (mcpNeedsApproval(tool, targetItem)) {
    decision = await requestApproval(buildApprovalRequest(tool, args, targetItem, client));
    if (decision === 'deny') throw new Error('denied');
    if (decision === 'timeout') throw new Error('timed_out');
    if (decision === 'session') mcpSessionAllow.add(tool);
    if (decision === 'always') {
      if (!Array.isArray(settings.ai_always_allow)) settings.ai_always_allow = [];
      if (!settings.ai_always_allow.includes(tool)) { settings.ai_always_allow.push(tool); saveSettingsFile(); }
      notifyAiAccessChanged();
    }
  }
  diagnostics.record('mcp.tool', { tool, client, decision }, { forceFile: true });
  // Re-check after the (possibly long) approval await: if AI access was toggled
  // off while the modal was open, refuse before performing the action.
  if (!settings.ai_access_enabled) throw new Error('ai_access_disabled');
  return mcpExecute(tool, args);
}

function mcpExecute(tool, args) {
  switch (tool) {
    case 'read_clip': {
      const item = findHistoryItem(args.id);
      if (!item) throw new Error('not_found');
      const sharedSet = mcpCore.sharedGroupSet(settings);
      if (item.type === 'image') return mcpCore.clipView(item, { sharedSet });
      textBlobStore.hydrateTextItem(item, TEXT_DIR);
      return { ...mcpCore.fullTextResult(item, sharedSet), viaApproval: true };
    }
    case 'search_all':
      return mcpCore.searchClips(history, settings, { query: args.query, regex: !!args.regex, scope: 'all', limit: args.limit || mcpCore.DEFAULT_LIST_LIMIT });
    case 'image_path': {
      const item = findHistoryItem(args.id);
      if (!item || item.type !== 'image') throw new Error('not_an_image');
      const p = path.join(IMG_DIR, item.image);
      if (!fs.existsSync(p)) throw new Error('image_missing');
      return { path: p };
    }
    case 'add_clip':
      return { ok: applyAddText(args.text, args.group || null) };
    case 'pin_clip':
      return { ok: applyPinToggle(args.id) };
    case 'set_numpad':
      return { ok: applyNumpadAssign(args.id, args.slot) };
    case 'assign_group':
      return { ok: applyGroupAssign(args.id, args.group) };
    case 'create_group':
      return { ok: applyGroupCreate(args.name) };
    case 'delete_group':
      return { ok: applyGroupDelete(args.name) };
    case 'delete_clip':
      return { ok: applyDeleteItem(args.id) };
    case 'copy_to_clipboard': {
      if (args.text != null) { clipboard.writeText(String(args.text)); return { ok: true }; }
      const item = findHistoryItem(args.id);
      if (!item) throw new Error('not_found');
      setClipboardToItem(item);
      return { ok: true };
    }
    case 'paste_clip': {
      if (!findHistoryItem(args.id)) throw new Error('not_found');
      return pasteAndHide(args.id).then(() => ({ ok: true }));
    }
    default:
      throw new Error(`unknown_tool:${tool}`);
  }
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
  ipcMain.handle('numpad-paste-and-hide', (_, slot) => numpadPasteAndHide(slot));

  ipcMain.handle('hide-popup', () => hidePopup());

  ipcMain.handle('copy', (_, text) => clipboard.writeText(text || ''));

  ipcMain.handle('delete-item', (_, id) => applyDeleteItem(id));

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
  ipcMain.handle('pin', (_, id) => applyPinToggle(id));

  ipcMain.handle('numpad-assign', (_, id, slot) => applyNumpadAssign(id, slot));

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
    if (body.theme_mode !== undefined && ['system', 'light', 'dark'].includes(body.theme_mode)) settings.theme_mode = body.theme_mode;
    if (body.diagnostics_enabled !== undefined) settings.diagnostics_enabled = !!body.diagnostics_enabled;
    saveSettingsFile();
    pruneHistory();
  });

  ipcMain.handle('set-show-shortcut', (_, shortcut) => setShowShortcut(shortcut));
  ipcMain.handle('set-quick-paste-shortcut', (_, shortcut) => setQuickPasteShortcut(shortcut));
  ipcMain.handle('suspend-shortcuts', () => suspendShortcutsForRecording());
  ipcMain.handle('resume-shortcuts', () => resumeShortcutsAfterRecording());
  ipcMain.handle('resolve-show-shortcut', (_, shortcut) => {
    const hook = getMacosHotkey();
    return hook ? hook.resolveShortcutFromCurrentModifiers(shortcut) : shortcut;
  });

  ipcMain.handle('group-create', (_, name) => applyGroupCreate(name));

  ipcMain.handle('group-delete', (_, name) => applyGroupDelete(name));

  ipcMain.handle('group-assign', (_, id, group) => applyGroupAssign(id, group));

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
    const p2pResults = await Promise.all(peers.flatMap(peer => ([
      withTimeout(
        p2pPullPeer(peer, 'manual'),
        P2P_MANUAL_PULL_TIMEOUT_MS,
        `p2p pull ${peer.deviceName || peer.deviceId}`
      ).catch(error => {
        diagnostics.record('p2p.manual_pull.error', {
          peer: peer.deviceName || peer.deviceId,
          error: error && error.message,
        }, { forceFile: true });
        return { ok: false, peer: peer.deviceName || peer.deviceId, error: error && error.message };
      }),
      p2pPushPeer(peer, 'manual'),
    ])));
    const result = await syncMerge({ force: true });
    if (result) result.p2p = p2pResults;
    return result;
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

  // --- AI Access (MCP) ---
  ipcMain.handle('get-ai-access', () => aiAccessState());
  ipcMain.handle('set-ai-access-enabled', (_, enabled) => setAiAccessEnabled(enabled));
  ipcMain.handle('set-mcp-client-enabled', (_, id, enabled) => {
    try {
      if (enabled) mcpInstallers.enable(id, mcpRuntimeCommand());
      else mcpInstallers.disable(id);
    } catch (error) {
      diagnostics.record('mcp.client.toggle_failed', { id, error: error && error.message }, { forceFile: true });
    }
    return aiAccessState();
  });
  ipcMain.handle('set-group-shared-ai', (_, name, shared) => {
    setGroupSharedWithAi(name, shared);
    return aiAccessState();
  });
  ipcMain.handle('revoke-ai-always-allow', (_, tool) => {
    if (Array.isArray(settings.ai_always_allow)) {
      settings.ai_always_allow = settings.ai_always_allow.filter(t => t !== tool);
      saveSettingsFile();
    }
    mcpSessionAllow.delete(tool);
    return aiAccessState();
  });
  ipcMain.handle('set-ai-approval-timeout', (_, sec) => {
    settings.ai_approval_timeout_sec = clampApprovalTimeout(sec);
    saveSettingsFile();
    return aiAccessState();
  });
  ipcMain.handle('get-ai-secret-ids', () => aiSecretFlags());
  ipcMain.handle('set-clip-share-anyway', (_, id, value) => {
    const item = findHistoryItem(id);
    if (!item) return false;
    if (value) item.shareAnyway = true;
    else delete item.shareAnyway;
    saveHistory();
    return true;
  });

  // Approval modal -> main bridge.
  ipcMain.on('approval-decide', (_, id, choice) => {
    const pending = pendingApprovals.get(id);
    if (pending) pending.finish(choice);
  });
  // Modal asks to size itself to its content so there is never an empty gap.
  ipcMain.on('approval-resize', (event, height) => {
    const w = BrowserWindow.fromWebContents(event.sender);
    if (!w || w.isDestroyed()) return;
    const h = Math.max(180, Math.min(560, Math.round(Number(height) || 360)));
    try {
      const [width] = w.getContentSize();
      w.setContentSize(width, h);
      w.center();
    } catch {}
  });
}

// --- Global shortcuts ---
let windowsHook = null;
let macosHotkey = null;
let shortcutsSuspended = false;

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
  await runNumpadSlotAction(slot, { source: 'shortcut' });
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
  if (shortcutsSuspended) {
    return {
      showShortcutRegistered: true,
      showShortcut: effectiveShowShortcut(),
      quickPasteRegistered: true,
      quickPasteShortcut: effectiveQuickPasteShortcut(),
    };
  }
  globalShortcut.unregisterAll();

  let showShortcutRegistered = true;
  let quickPasteRegistered = true;
  const macosShowKey = process.platform === 'darwin' ? effectiveShowShortcut() : '';
  const showKey = process.platform === 'darwin' ? '' : globalShowShortcut();
  const quickPasteKey = globalQuickPasteShortcut();

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
    hook.clearRuntimeShortcut();
    hook.clearQuickPasteShortcuts();
    if (macosShowKey) {
      const result = hook.install({ shortcut: macosShowKey, onPressed: showPopup });
      showShortcutRegistered = !!result.ok;
      if (!result.ok) logSafe(`Warning: ${result.error}`);
    }
  }

  if (showKey) {
    showShortcutRegistered = globalShortcut.register(showKey, showPopup);
    if (!showShortcutRegistered) logSafe(`Warning: Could not register popup shortcut ${showKey}`);
  }

  const quickPasteRegistrations = [];
  if (quickPasteKey) {
    if (process.platform === 'darwin') {
      const hook = getMacosHotkey();
      const result = hook.installQuickPaste({
        shortcut: quickPasteKey,
        onSlot: slot => {
          handleQuickPaste(slot).catch(error => {
            diagnostics.record('shortcut.quick_paste_error', { slot, error: error && error.message }, { forceFile: true });
          });
        },
      });
      quickPasteRegistered = !!result.ok;
      for (let n = 1; n <= 9; n++) {
        quickPasteRegistrations.push({
          slot: n,
          key: quickPasteShortcutForSlot(quickPasteKey, n),
          registered: quickPasteRegistered,
          backend: 'carbon',
        });
      }
      if (!result.ok) logSafe(`Warning: ${result.error}`);
    } else {
      for (let n = 1; n <= 9; n++) {
        const key = quickPasteShortcutForSlot(quickPasteKey, n);
        if (!key) {
          quickPasteRegistered = false;
          quickPasteRegistrations.push({ slot: n, key, registered: false, backend: 'electron' });
          continue;
        }
        const registered = globalShortcut.register(key, () => {
          handleQuickPaste(n).catch(error => {
            diagnostics.record('shortcut.quick_paste_error', { slot: n, error: error && error.message }, { forceFile: true });
          });
        });
        quickPasteRegistrations.push({ slot: n, key, registered, backend: 'electron' });
        if (!registered) {
          quickPasteRegistered = false;
          logSafe(`Warning: Could not register ${key}`);
        }
      }
    }
  }
  diagnostics.record('shortcut.register', {
    platform: process.platform,
    show_key: macosShowKey || showKey,
    show_registered: showShortcutRegistered,
    show_backend: macosShowKey ? 'carbon' : (showKey ? 'electron' : ''),
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

function suspendShortcutsForRecording() {
  shortcutsSuspended = true;
  globalShortcut.unregisterAll();
  if (macosHotkey) {
    macosHotkey.clearRuntimeShortcut();
    macosHotkey.clearQuickPasteShortcuts();
  }
  diagnostics.record('shortcut.suspend_for_recording', {}, { forceFile: diagnostics.isEnabled() });
  return { ok: true };
}

function resumeShortcutsAfterRecording() {
  shortcutsSuspended = false;
  const result = registerShortcuts();
  diagnostics.record('shortcut.resume_after_recording', result, { forceFile: diagnostics.isEnabled() });
  return { ok: true, ...result };
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
  recoverOrphanedEdits();   // restore any external edit orphaned by a prior crash/restart
  writeHistoryStorageFile();
  setupIPC();
  createPopup();
  createTray();
  registerShortcuts();
  startDiagnosticsMonitor();
  startP2PSync();
  autoUpdater.start();

  // AI Access: if enabled, bring up the control channel + idempotently repair the
  // MCP registration in every detected client (also refreshes the discovery file
  // so the helper always has current paths).
  if (settings.ai_access_enabled) {
    ensureAiGroupShared();
    startMcpControlServer().then(() => { mcpAutoRegister(); }).catch(() => {});
  }

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
  // Best-effort: stop the control server and clear the discovery file so a stale
  // pipe/secret isn't left advertised after the app exits.
  if (mcpControlServer) { try { mcpControlServer.stop(); } catch {} mcpControlServer = null; }
  try { mcpPaths.clearDiscovery(); } catch {}
});
app.on('window-all-closed', () => { /* keep running as tray app */ });
