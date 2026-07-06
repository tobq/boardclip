const { app, BrowserWindow, Tray, Menu, globalShortcut, clipboard, nativeImage,
        ipcMain, protocol, screen, shell, nativeTheme, dialog, Notification } = require('electron');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const os = require('os');
const http = require('http');
const dgram = require('dgram');
const { exec, execFile } = require('child_process');

// Windows-specific fast input (keybd_event, Get/SetForegroundWindow).
// Module is a no-op on non-Windows platforms so it's safe to require unconditionally.
const winPaste = require('./lib/windows-paste');
const macPaste = require('./lib/macos-paste');
const winClipboard = require('./lib/windows-clipboard');
const keystrokeInject = require('./lib/keystroke-inject');
const { createQuickPaster } = require('./lib/quick-paste');
const getBuildInfo = require('./lib/build-info');
const getCloudAccounts = require('./lib/cloud-accounts');
const blobStore = require('./lib/blob-store');
const clipboardModel = require('./lib/clipboard-model');
const clipboardCapture = require('./lib/clipboard-capture');
const textBlobStore = require('./lib/text-blob-store');
const { planRetention } = require('./lib/retention');
const { createAutoUpdater, updateSupport } = require('./lib/auto-update');
const syncPaths = require('./lib/sync-paths');
const { Diagnostics } = require('./lib/diagnostics');
const { ensureDirectory } = require('./lib/ensure-directory');
const hmacAuth = require('./lib/hmac-auth');
const mcpCore = require('./lib/mcp-core');
const mcpPaths = require('./lib/mcp-paths');
const mcpInstallers = require('./lib/mcp-installers');
const conflictModel = require('./lib/conflict-model');
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
const CONFLICTS_PATH = path.join(DATA_DIR, 'clipboard-conflicts.json');
const IMG_DIR = path.join(DATA_DIR, 'clipboard-images');
const TEXT_DIR = path.join(DATA_DIR, textBlobStore.TEXT_BLOB_DIRNAME);
const HISTORY_BACKUP_DIR = path.join(DATA_DIR, 'clipboard-backups');
// Retention buffer of raw external-edit text. Editor temps are ARCHIVED here on
// finish (not deleted), so a saved buffer is recoverable straight off disk even
// if every in-memory defence failed. LRU-pruned to a size cap + max age.
const EDIT_ARCHIVE_DIR = path.join(DATA_DIR, 'clipboard-edit-archive');
const EDIT_ARCHIVE_MAX_BYTES = 100 * 1024 * 1024; // 100 MB
const EDIT_ARCHIVE_MAX_AGE_MS = 365 * 86400 * 1000; // 1 year
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

// Enumerate a retention dir, apply a planRetention policy, and unlink the
// evicted files. Shared by every on-disk buffer (history backups, edit archive)
// so the "list -> decide -> delete" loop lives in exactly one place.
function pruneDirectory(dir, policy, { ext } = {}) {
  let entries;
  try {
    entries = fs.readdirSync(dir)
      .filter(name => !ext || name.endsWith(ext))
      .map(name => {
        const filePath = path.join(dir, name);
        try { const st = fs.statSync(filePath); return { filePath, mtimeMs: st.mtimeMs, size: st.size }; }
        catch { return null; }
      })
      .filter(Boolean);
  } catch { return; }

  for (const e of planRetention(entries, policy)) {
    try { fs.rmSync(e.filePath, { force: true }); } catch {}
  }
}

function pruneHistoryBackups() {
  pruneDirectory(HISTORY_BACKUP_DIR, { maxFiles: HISTORY_BACKUP_MAX_FILES }, { ext: '.json' });
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

// Overwrite an existing file IN PLACE (open-truncate-write), never via a
// cross-name rename. Google Drive File Stream implements rename-over-existing
// by orphaning the old Drive object and creating a NEW one, so tmp+rename in a
// Drive folder silently forks `clipboard-history.json` into two same-named
// objects that different devices then bind to permanently (the sync split).
// In place, DriveFS updates the SAME object. A crash mid-write is self-healing:
// the local authoritative copy re-writes the remote on the next sync, and a
// concurrent reader that sees a torn file just fails JSON.parse and treats the
// remote as empty (union-with-local loses nothing). Used for cloud writes only;
// local (real-FS) writes keep atomic tmp+rename.
async function writeInPlace(filePath, data) {
  const fh = await fs.promises.open(filePath, 'w');
  try {
    await fh.writeFile(data);
    try { await fh.sync(); } catch {}
  } finally {
    await fh.close();
  }
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

function loadConflicts() {
  try {
    return conflictModel.normalizeConflictState(JSON.parse(fs.readFileSync(CONFLICTS_PATH, 'utf-8')));
  } catch {
    return conflictModel.normalizeConflictState({});
  }
}

function saveConflictsFile() {
  const startedAt = Date.now();
  conflicts = conflictModel.normalizeConflictState(conflicts);
  atomicWriteJson(CONFLICTS_PATH, conflicts, 2);
  diagnostics.slow('conflicts.save.slow', Date.now() - startedAt, {
    records: conflicts.records.length,
    tombstones: conflicts.tombstones.length,
    file_bytes: fileSummary(CONFLICTS_PATH).size || 0,
  }, 50);
  dataRevision++;
  if (!suppressP2PNotify) p2pNotifyLocalChange();
  notifyDataChanged();
  scheduleSyncMerge();
}

function addConflictRecord(record, { save = true } = {}) {
  const normalized = conflictModel.createConflictRecord(record);
  conflicts = conflictModel.upsertConflictRecord(conflicts, normalized);
  if (save) saveConflictsFile();
  return normalized;
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
let conflicts = loadConflicts();

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
function titleOf(item) {
  return clipboardModel.titleOf(item);
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

function applyExternalTextEdit({ id, originalText, originalTitle, sourceGroups, newText, newTitle, writeClipboard = true }) {
  const result = clipboardModel.applyTextEdit(history, {
    id,
    originalText,
    originalTitle,
    newText,
    newTitle,
    sourceGroups,
    groupTombstones: settings.group_tombstones,
    now: Date.now(),
    ignoreBlank: true,
  });
  if (!result.changed) return result;

  if (result.conflict) {
    result.conflictRecord = addConflictRecord({
      ...result.conflict,
      source: 'editor',
    });
  }
  for (const tombstoneId of result.tombstoneIds || []) addTombstone(tombstoneId);
  if (result.tombstoneIds && result.tombstoneIds.length) saveSettingsFile();
  saveHistory();
  // Only put the edited text on the clipboard for a deliberate finish (editor
  // close / final save), not every intermediate auto-captured Ctrl+S.
  if (writeClipboard) writeEditedTextToClipboard(newText);
  diagnostics.record('editor.text_applied', {
    reason: result.reason,
    conflict: !!result.conflictRecord,
    tombstones: (result.tombstoneIds || []).length,
    text_len: String(newText || '').length,
  }, { forceFile: diagnostics.isEnabled() });
  return result;
}

// Edit an existing TEXT history item in place, preserving its pin/groups/numpad +
// title. The single item-based entry to the content-addressed edit: hydrates the
// blob once, then routes through applyExternalTextEdit (which re-derives the
// content-key id and tombstones the old one). `newText` may be a string or a
// (currentText) => string resolver, so callers that transform the existing body
// (e.g. append) reuse the hydrated text without a second blob read. Shared by
// conflict/unify resolution + the MCP edit_clip tool.
function applyTextEditToItem(item, { newText, newTitle } = {}) {
  textBlobStore.hydrateTextItem(item, TEXT_DIR);
  const current = String(item.text || '');
  const resolved = typeof newText === 'function' ? newText(current) : String(newText != null ? newText : current);
  return applyExternalTextEdit({
    id: itemKey(item),
    originalText: current,
    originalTitle: titleOf(item),
    sourceGroups: groupsOf(item),
    newText: resolved,
    newTitle: newTitle !== undefined ? newTitle : titleOf(item),
    writeClipboard: false, // an edit-by-id never hijacks the user's clipboard
  });
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
  const maxBytes = settings.max_size_gb * 1024 ** 3;
  let changed = false;

  const agePlan = clipboardModel.planHistoryPrune(history, settings);
  if (clipboardModel.isDestructivePrune(history, agePlan)) {
    diagnostics.record('history.prune_refused', {
      reason: 'destructive_age_prune',
      planned: agePlan.length,
      items: history.length,
      max_age_days: settings.max_age_days,
    }, { forceFile: true });
  } else {
    for (const { index } of agePlan) {
      deleteHistoryIndex(index, { tombstone: false });
      changed = true;
    }
  }

  while (getStorageBytes() > maxBytes) {
    let idx = -1;
    for (let i = history.length - 1; i >= 0; i--) {
      if (!isPinned(history[i])) { idx = i; break; }
    }
    if (idx < 0) break;
    deleteHistoryIndex(idx, { tombstone: false });
    changed = true;
  }

  if (changed) {
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
  delete remoteSave.quick_paste_mode;
  delete remoteSave.quick_paste_restore;
  delete remoteSave.quick_paste_restore_delay_ms;
  delete remoteSave.p2p_device_id;
  delete remoteSave.popup_size;
  delete remoteSave.editor_bounds;
  // Appearance variants: per-machine (glass support is hardware-dependent; the
  // rest are dev-only auditioning knobs), never synced.
  delete remoteSave.surface_style;
  delete remoteSave.accent_variant;
  delete remoteSave.ui_density;
  delete remoteSave.ui_corners;
  delete remoteSave.ui_borders;
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

function mergeSyncedConflicts(remoteConflicts) {
  const before = JSON.stringify(conflicts);
  conflicts = conflictModel.mergeConflictStates(conflicts, remoteConflicts || {});
  return JSON.stringify(conflicts) !== before;
}

function captureTitleConflicts(localHistory, remoteHistory, source) {
  const localById = new Map();
  for (const item of Array.isArray(localHistory) ? localHistory : []) {
    migrateItemPin(item);
    ensureItemId(item);
    localById.set(itemKey(item), item);
  }
  for (const item of Array.isArray(remoteHistory) ? remoteHistory : []) {
    migrateItemPin(item);
    ensureItemId(item);
    const local = localById.get(itemKey(item));
    if (!local || !clipboardModel.titleConflict(local, item)) continue;
    addConflictRecord({
      kind: 'title',
      source,
      targetId: itemKey(local),
      left: clipboardModel.conflictSnapshot(local),
      right: clipboardModel.conflictSnapshot(item),
    }, { save: false });
  }
}

function foldRemoteState(canonicalHistory, remoteHistory, remoteSettings, remoteConflicts) {
  mergeSyncedSettings(remoteSettings);
  mergeSyncedConflicts(remoteConflicts);
  captureTitleConflicts(canonicalHistory, remoteHistory, 'sync');
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
  const [history, settingsFile, conflictsFile, images] = await Promise.all([
    fileSignature(path.join(syncPath, 'clipboard-history.json')),
    fileSignature(path.join(syncPath, 'clipboard-settings.json')),
    fileSignature(path.join(syncPath, 'clipboard-conflicts.json')),
    directorySignature(path.join(syncPath, 'clipboard-images')),
  ]);
  return {
    history,
    settings: settingsFile,
    conflicts: conflictsFile,
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

// Google Drive File Stream can leave a sync folder with FORKED same-name objects
// (`clipboard-history (1).json`, `clipboard-settings (2).json`) and orphaned
// `<name>.<pid>.<ts>.tmp` files from interrupted renames. Different devices then
// bind to different forks and never see each other's writes (the sync split this
// codebase was built to survive). Before every remote read, fold any fork/tmp
// content back into the canonical file and delete the strays, so a folder that
// duplicated once self-heals to a single object on the next sync. No-op (one
// readdir) when the folder is clean, which is the overwhelmingly common case.
// Fork-name matching (paren + Windows space-number variants + leaked tmps) is
// single-sourced in lib/fork-names.js so main.js and the tests share ONE matcher
// and it can never silently drift narrow again.
const {
  FORK_HISTORY_RE, FORK_SETTINGS_RE, LEAKED_HISTORY_TMP_RE, LEAKED_SETTINGS_TMP_RE,
} = require('./lib/fork-names');

async function healForkedSyncFiles(syncPath) {
  let names;
  try { names = await fs.promises.readdir(syncPath); } catch { return; }
  const historyForks = names.filter(n => FORK_HISTORY_RE.test(n) || LEAKED_HISTORY_TMP_RE.test(n));
  const settingsForks = names.filter(n => FORK_SETTINGS_RE.test(n) || LEAKED_SETTINGS_TMP_RE.test(n));
  if (!historyForks.length && !settingsForks.length) return;

  const canonHistoryPath = path.join(syncPath, 'clipboard-history.json');
  const canonSettingsPath = path.join(syncPath, 'clipboard-settings.json');
  const readJson = async (p) => { try { return JSON.parse(await fs.promises.readFile(p, 'utf-8')); } catch { return null; } };
  const unlink = async (n) => { try { await fs.promises.unlink(path.join(syncPath, n)); } catch {} };
  const healed = { path: syncPath, historyForks: historyForks.length, settingsForks: settingsForks.length, itemsRecovered: 0 };

  if (historyForks.length) {
    let merged = Array.isArray(await readJson(canonHistoryPath)) ? await readJson(canonHistoryPath) : [];
    const before = merged.length;
    for (const n of historyForks) {
      const forkItems = await readJson(path.join(syncPath, n));
      // Pure structural union (no tombstones): a heal must NEVER drop a clip.
      // Tombstone-based deletion is applied afterward by the normal conflict-
      // aware syncMerge, not here.
      if (Array.isArray(forkItems) && forkItems.length) merged = clipboardModel.mergeHistories(merged, forkItems, {});
    }
    healed.itemsRecovered = merged.length - before;
    await writeInPlace(canonHistoryPath, JSON.stringify(merged));
    for (const n of historyForks) await unlink(n);
  }

  if (settingsForks.length) {
    const canon = (await readJson(canonSettingsPath)) || {};
    for (const n of settingsForks) {
      const fork = await readJson(path.join(syncPath, n));
      if (!fork || typeof fork !== 'object') continue;
      canon.tombstones = normalizeTombstones([...(canon.tombstones || []), ...(fork.tombstones || [])]);
      canon.group_tombstones = normalizeGroupTombstones([...(canon.group_tombstones || []), ...(fork.group_tombstones || [])]);
      // Deterministically converge the shared P2P secret (min wins) so a fork
      // that carried a different secret can't leave the two devices unable to
      // pair over LAN — the exact failure that made this split unrecoverable.
      const secrets = [canon.p2p_secret, fork.p2p_secret].filter(Boolean).sort();
      if (secrets.length) canon.p2p_secret = secrets[0];
    }
    await writeInPlace(canonSettingsPath, JSON.stringify(canon, null, 2));
    for (const n of settingsForks) await unlink(n);
  }

  diagnostics.record('sync.heal_forks', healed, { forceFile: true });
}

async function readRemoteState(syncPath) {
  await healForkedSyncFiles(syncPath);
  const remoteDbPath = path.join(syncPath, 'clipboard-history.json');
  const remoteSettingsPath = path.join(syncPath, 'clipboard-settings.json');
  const remoteConflictsPath = path.join(syncPath, 'clipboard-conflicts.json');
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
  let remoteConflicts = {};
  try { remoteConflicts = JSON.parse(await fs.promises.readFile(remoteConflictsPath, 'utf-8')); } catch {}
  return { remoteHistory, remoteSettings, remoteConflicts: conflictModel.normalizeConflictState(remoteConflicts) };
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
  const conflictsPath = path.join(basePath, 'clipboard-conflicts.json');
  const remoteSettings = safeReadJson(settingsPath, {});
  const remoteHistory = safeReadJson(historyPath, []);
  const remoteConflicts = conflictModel.normalizeConflictState(safeReadJson(conflictsPath, {}));
  return {
    base_path: basePath,
    settings_file: fileSummary(settingsPath),
    history_file: fileSummary(historyPath),
    conflicts_file: fileSummary(conflictsPath),
    text_dir: fileSummary(path.join(basePath, textBlobStore.TEXT_BLOB_DIRNAME)),
    item_count: Array.isArray(remoteHistory) ? remoteHistory.length : null,
    conflict_count: remoteConflicts.records.length,
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
  const remoteConflictsPath = path.join(syncPath, 'clipboard-conflicts.json');
  const remoteImgDir = path.join(syncPath, 'clipboard-images');
  const remoteTextDir = path.join(syncPath, textBlobStore.TEXT_BLOB_DIRNAME);
  const storedHistory = textBlobStore.prepareHistoryForStorage(canonicalHistory, TEXT_DIR);
  const nextHistoryJson = JSON.stringify(storedHistory);
  const nextSettingsJson = JSON.stringify(canonicalSettings, null, 2);
  const nextConflictsJson = JSON.stringify(conflictModel.normalizeConflictState(conflicts), null, 2);
  const [currentHistoryJson, currentSettingsJson, currentConflictsJson] = await Promise.all([
    readFileUtf8IfExists(remoteDbPath),
    readFileUtf8IfExists(remoteSettingsPath),
    readFileUtf8IfExists(remoteConflictsPath),
  ]);
  let currentStoredHistory = null;
  try {
    const parsed = currentHistoryJson ? JSON.parse(currentHistoryJson) : null;
    if (Array.isArray(parsed)) currentStoredHistory = parsed;
  } catch {}
  const pushHistory = historyAssetDelta(storedHistory, currentStoredHistory);
  const wroteHistory = currentHistoryJson !== nextHistoryJson;
  const wroteSettings = currentSettingsJson !== nextSettingsJson;
  const wroteConflicts = currentConflictsJson !== nextConflictsJson;
  await Promise.all([
    wroteHistory ? writeInPlace(remoteDbPath, nextHistoryJson) : Promise.resolve(),
    wroteSettings ? writeInPlace(remoteSettingsPath, nextSettingsJson) : Promise.resolve(),
    wroteConflicts ? writeInPlace(remoteConflictsPath, nextConflictsJson) : Promise.resolve(),
    syncRemoteAssets(remoteImgDir, remoteTextDir, { pushHistory }),
  ]);
  await updateSyncProviderCache(syncPath);
  diagnostics.slow('sync.write_remote.slow', Date.now() - startedAt, {
    path: syncPath,
    items: canonicalHistory.length,
    history_bytes: Buffer.byteLength(nextHistoryJson),
    settings_bytes: Buffer.byteLength(nextSettingsJson),
    conflicts_bytes: Buffer.byteLength(nextConflictsJson),
    assets_to_push: pushHistory.length,
    wrote_history: wroteHistory,
    wrote_settings: wroteSettings,
    wrote_conflicts: wroteConflicts,
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
    conflicts: conflictModel.normalizeConflictState(conflicts),
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
  const previousConflictsJson = JSON.stringify(conflictModel.normalizeConflictState(conflicts));
  const canonicalHistory = foldRemoteState(history.slice(), remoteHistory, state.settings || {}, state.conflicts || {});
  const recoveredImages = await recoverRecentOrphanImages(canonicalHistory);
  const localChanged = JSON.stringify(canonicalHistory) !== JSON.stringify(history);
  const settingsChanged = JSON.stringify(remoteSettingsPayload()) !== previousSettingsJson;
  const conflictsChanged = JSON.stringify(conflictModel.normalizeConflictState(conflicts)) !== previousConflictsJson;
  if (localChanged) {
    history.length = 0;
    history.push(...canonicalHistory);
  }
  if (localChanged || settingsChanged || conflictsChanged) {
    applyingSyncState = true;
    suppressP2PNotify = !notifyPeers;
    try {
      if (localChanged) saveHistory();
      if (settingsChanged) saveSettingsFile();
      if (conflictsChanged) saveConflictsFile();
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
    conflicts_changed: conflictsChanged,
    fetched_assets: fetchedAssets,
    recovered_images: recoveredImages,
    items: history.length,
  }, { forceFile: localChanged || fetchedAssets > 0 });
  return { ok: true, local_changed: localChanged, settings_changed: settingsChanged, conflicts_changed: conflictsChanged, fetched_assets: fetchedAssets };
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
  let conflictsChanged = false;
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
    const previousConflictsJson = JSON.stringify(conflictModel.normalizeConflictState(conflicts));

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

          const { remoteHistory, remoteSettings, remoteConflicts } = await readRemoteState(syncPath);
          await updateSyncProviderCache(syncPath);
          return {
            path: syncPath,
            skipped: false,
            remote_changed: remoteChanged,
            full_sync: fullSync,
            remote_items: remoteHistory.length,
            remote_conflicts: remoteConflicts.records.length,
            remote_history: remoteHistory,
            remote_settings: remoteSettings,
            remote_conflicts_state: remoteConflicts,
            ms: Date.now() - providerStartedAt,
          };
        })(), SYNC_PROVIDER_READ_TIMEOUT_MS, `read ${syncPath}`);

        if (!providerResult.skipped) {
          canonicalHistory = foldRemoteState(canonicalHistory, providerResult.remote_history, providerResult.remote_settings, providerResult.remote_conflicts_state);
          providerResult.canonical_items = canonicalHistory.length;
          delete providerResult.remote_history;
          delete providerResult.remote_settings;
          delete providerResult.remote_conflicts_state;
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
    conflictsChanged = JSON.stringify(conflictModel.normalizeConflictState(conflicts)) !== previousConflictsJson;
    if (localChanged) {
      history.length = 0;
      history.push(...canonicalHistory);
    }
    if (localChanged || settingsChanged || conflictsChanged) {
      applyingSyncState = true;
      try {
        if (localChanged) saveHistory();
        if (settingsChanged) saveSettingsFile();
        if (conflictsChanged) saveConflictsFile();
      } finally {
        applyingSyncState = false;
      }
    }

    shouldWriteRemotes = hadLocalDirty || localChanged || settingsChanged || conflictsChanged;
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
      conflicts_changed: conflictsChanged,
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
        conflicts_changed: conflictsChanged,
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
        conflicts_changed: conflictsChanged,
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
// Does the clipboard currently hold this item's content? Used to (a) confirm a
// macro landed before we paste, and (b) confirm it's still ours before we
// overwrite it with the restored previous clipboard.
function clipboardMatchesItem(item) {
  try {
    if (!item) return false;
    if (item.type === 'image') return !clipboard.readImage().isEmpty();
    textBlobStore.hydrateTextItem(item, TEXT_DIR);
    return clipboard.readText() === String(item.text || '');
  } catch { return false; }
}

function clampRestoreDelay(value) {
  const n = parseInt(value, 10);
  if (!Number.isFinite(n)) return 400;
  return Math.min(2000, Math.max(0, n));
}

// Pause clipboard polling for the duration of a quick-paste so our own macro
// write + restore aren't re-captured as new history entries. Ref-counted
// because the orchestrator serializes but callers may overlap around it.
let quickPasteActive = 0;
function beginQuickPaste() { quickPasteActive += 1; pollGate = false; }
function endQuickPaste() {
  quickPasteActive = Math.max(0, quickPasteActive - 1);
  if (quickPasteActive === 0) pollGate = true;
}

// Longest text we'll inject as keystrokes. Beyond this, a huge key-event burst
// is neither efficient nor reliable, so we fall back to the clipboard path.
const QUICK_PASTE_TYPE_MAX_CHARS = 2000;

// Keystroke-injection strategy: type the macro's text directly, never touching
// the clipboard — so the restore race is structurally impossible and the user's
// clipboard is preserved. Only accepts plain-text items within the length cap
// when quick_paste_mode is 'type' and the platform supports injection; images /
// long text / 'clipboard' mode fall through to the timed clipboard path.
const injectStrategy = {
  skipClipboard: true,
  accepts(item) {
    if ((settings.quick_paste_mode || 'type') !== 'type') return false;
    if (!item || item.type === 'image') return false;
    if (!keystrokeInject.isSupported()) return false;
    textBlobStore.hydrateTextItem(item, TEXT_DIR);
    const text = String(item.text || '');
    return text.length > 0 && text.length <= QUICK_PASTE_TYPE_MAX_CHARS;
  },
  async deliver({ item, trace }) {
    textBlobStore.hydrateTextItem(item, TEXT_DIR);
    const text = String(item.text || '');
    const result = keystrokeInject.typeText(text);
    const ok = !!(result && result.ok);
    diagnostics.record('shortcut.quick_paste_injected', {
      ...(trace || {}),
      chars: text.length,
      ok,
      error: result && result.error,
    }, { forceFile: true });
    // If injection failed (e.g. UIPI-blocked target, or an FFI error), decline
    // so the orchestrator falls back to the clipboard paste path — the user
    // still gets their macro rather than nothing.
    if (!ok) return { fallback: true };
    // consumed:true — the text is delivered directly to the app; there is no
    // clipboard hand-off to wait on.
    return { consumed: true, injected: true };
  },
};

let quickPaster = null;
function getQuickPasteStrategy() {
  return injectStrategy;
}
function getQuickPaster() {
  if (quickPaster) return quickPaster;
  quickPaster = createQuickPaster({
    snapshot: () => backupClipboard(),
    restore: (backup) => restoreClipboard(backup),
    writeItem: (item) => setClipboardToItem(item),
    clipboardMatchesItem,
    paste: () => simulatePaste(''),
    sleep: (ms) => new Promise(r => { const t = setTimeout(r, ms); if (t.unref) t.unref(); }),
    now: () => Date.now(),
    log: (event, data) => {
      const name = event.startsWith('quick_paste') ? `shortcut.${event}` : event;
      diagnostics.record(name, data || {}, { forceFile: true });
    },
    getConfig: () => ({
      restore: settings.quick_paste_restore !== false,
      minRestoreDelayMs: clampRestoreDelay(settings.quick_paste_restore_delay_ms),
    }),
    strategy: getQuickPasteStrategy(),
  });
  return quickPaster;
}

async function numpadPaste(slotNum, options = {}) {
  const trace = options.trace || {};
  const item = history.find(h => hasNumpadSlot(h, slotNum));
  if (!item) {
    diagnostics.record('shortcut.quick_paste_missing_slot', { ...trace, slot: slotNum }, { forceFile: true });
    return;
  }
  const targetAppName = options.targetAppName || '';
  beginQuickPaste();
  try {
    return await getQuickPaster().request(item, {
      coalesceKey: `slot:${slotNum}`,
      trace: {
        ...trace,
        slot: slotNum,
        item_id: itemKey(item),
        item_type: item.type || 'text',
        text_len: item.type === 'image' ? undefined : String(item.text || '').length,
      },
      // macOS needs the frontmost app name captured at request time.
      paste: () => simulatePaste(targetAppName),
    });
  } finally {
    endQuickPaste();
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
  return nativeTheme.shouldUseDarkColors ? '#14171b' : '#ffffff';
}

// --- Native frosted glass for the popup pane -----------------------------
// macOS gets real vibrancy (already wired); Windows 11 gets an acrylic
// backdrop that blurs whatever sits behind the window (other apps + desktop).
// Everything below is centralized so the popup window-creation site, the
// live toggle, and the colour-scheme refresh all agree on one source of truth.
function glassSupport() {
  if (process.platform === 'darwin') return 'vibrancy';
  if (process.platform === 'win32') {
    const parts = String(os.release()).split('.');
    if (Number(parts[0]) >= 10 && Number(parts[2] || 0) >= 22000) return 'acrylic';
  }
  return 'none';
}
function surfaceStylePref() {
  return settings.surface_style === 'glass' || settings.surface_style === 'solid'
    ? settings.surface_style
    : 'auto';
}
function glassOn() {
  if (surfaceStylePref() === 'solid') return false;
  return glassSupport() !== 'none'; // 'auto' | 'glass' -> on wherever supported
}
function resolvedSurfaceStyle() { return glassOn() ? 'glass' : 'solid'; }
// BrowserWindow options for the popup, spread into createPopup(). macOS keeps
// transparent:true ALWAYS (transparent can't change post-creation), and toggles
// the material at runtime instead, so glass<->solid never needs a window
// recreate. Windows uses acrylic (transparent stays false).
function popupSurfaceOptions() {
  const support = glassSupport();
  const on = glassOn();
  if (support === 'vibrancy') {
    return { transparent: true, vibrancy: on ? 'popover' : undefined, visualEffectState: 'active', backgroundColor: '#00000000' };
  }
  if (support === 'acrylic' && on) {
    return { backgroundMaterial: 'acrylic', backgroundColor: '#00000000' };
  }
  return { backgroundColor: appBackgroundColor() };
}
// Re-apply the surface material to the live popup window without recreating it,
// then tell the renderer to flip its data-surface attribute.
function applySurfaceToPopup() {
  if (!win || win.isDestroyed()) return;
  const support = glassSupport();
  const on = glassOn();
  try {
    if (support === 'vibrancy' && win.setVibrancy) win.setVibrancy(on ? 'popover' : null);
    else if (support === 'acrylic' && win.setBackgroundMaterial) win.setBackgroundMaterial(on ? 'acrylic' : 'none');
    win.setBackgroundColor(on ? '#00000000' : appBackgroundColor());
  } catch {}
  try { win.webContents.send('surface-changed', resolvedSurfaceStyle()); } catch {}
}

function notifyColorSchemeChanged() {
  if (!win || win.isDestroyed()) return;
  // Don't stamp an opaque background over a live acrylic/transparent window.
  if (!glassOn()) win.setBackgroundColor(appBackgroundColor());
  win.webContents.send('color-scheme-changed', currentColorScheme());
}

// Non-surface appearance variants (accent/density/corners/borders), shared by
// the editor + conflict windows so they match the popup. Surface stays solid on
// those windows (a text editor / merge view reads better opaque).
function appearanceVariantPayload() {
  return {
    accentVariant: settings.accent_variant,
    uiDensity: settings.ui_density,
    uiCorners: settings.ui_corners,
    uiBorders: settings.ui_borders,
  };
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
    ...popupSurfaceOptions(),
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
      path.join(SCRIPT_DIR, 'site', 'shared', 'clipboard-tokens.css'),
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
        if (win && !win.isDestroyed() && !win.isFocused()) {
          // Focus moved to one of BoardClip's OWN windows (e.g. an editor opened
          // from the popup)? Keep the popup open so the user can open several
          // items in a row. It still dismisses when focus leaves to another app
          // (getFocusedWindow() is null then) or via Escape / the close button.
          const focused = BrowserWindow.getFocusedWindow();
          if (focused && focused !== win) return;
          win.hide();
        }
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

// True if the point falls inside ANY visible BoardClip window (the popup or an
// open editor/conflict/unify window). Used by the click-away watcher so working
// across BoardClip's own windows doesn't dismiss the popup - only a click on
// another app / the desktop does.
function pointInAnyOwnWindow(point) {
  for (const w of BrowserWindow.getAllWindows()) {
    if (!w || w.isDestroyed() || !w.isVisible()) continue;
    if (pointInWindowBounds(point, w.getBounds())) return true;
  }
  return false;
}

// Keep the popup open across a deliberate "open" action (launching the external
// image viewer, or our own editor window) instead of blur-hiding it, so the user
// can open several items in a row. Reuses the ignoreBlurUntil guard showPopup
// already uses. The window is generous so a COLD-STARTING external image viewer
// (which can take a couple of seconds to foreground and only then blur us) is
// still covered. This only defers the passive blur-hide - the popup still
// dismisses instantly via Escape, the close button, or clicking away to another
// app (the click-away watcher is not gated by ignoreBlurUntil).
function keepPopupOpenBriefly(ms = 3000) {
  ignoreBlurUntil = Math.max(ignoreBlurUntil, Date.now() + ms);
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

    if (!pointInAnyOwnWindow(screen.getCursorScreenPoint())) {
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

// Hide the popup and paste whatever is on the clipboard into the app that was
// frontmost before we showed. Shared by single paste + multi "Paste all".
async function hideAndPasteForeground() {
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
}

async function pasteAndHide(id) {
  const item = findHistoryItem(id);
  if (!item) return;

  pollGate = false;
  try {
    setClipboardToItem(item);
    await hideAndPasteForeground();
  } finally {
    pollGate = true;
  }
}

// "Paste all": join the selected TEXT clips (newline-separated) and paste them in
// one go. Images can't concatenate into text, so they're skipped.
async function pasteMany(ids) {
  const parts = [];
  for (const id of (Array.isArray(ids) ? ids : [])) {
    const item = findHistoryItem(id);
    if (!item || item.type === 'image') continue;
    textBlobStore.hydrateTextItem(item, TEXT_DIR);
    parts.push(item.text || '');
  }
  const text = parts.join('\n');
  if (!text) { hidePopup(); return; }
  pollGate = false;
  try {
    clipboard.writeText(text);
    lastText = text;   // don't re-capture our own joined paste as a new clip
    lastImgHash = '';
    await hideAndPasteForeground();
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
// Built-in clip editor. Editing a clip opens BoardClip's OWN editor window
// (editor.html, which mounts the shared Core.createEditor - the same editor the
// website demo uses). Edits are captured live: the renderer streams a draft on
// EVERY keystroke (persisted to a crash-safe file under EDIT_ARCHIVE_DIR) and
// commits to the clip on idle / Ctrl+S / close. This closes the unsaved-keystroke
// gap an external editor (Notepad) left open. Layered defences, all anchored on
// the base-content hash captured at open:
//   1. One window per clip - re-triggering edit focuses the open window.
//   2. Fork on divergence - a commit whose base no longer matches the live clip
//      forks into a new clip instead of overwriting (applyTextEdit is conflict-safe).
//   3. Live draft - every keystroke hits disk, surviving a crash/restart.
//   4. Orphan recovery - a draft never committed (crash mid-edit) is re-applied
//      on next startup (in-flight `boardclip-edit-*`; committed ones get a `done-`
//      prefix so they're retained but not resurrected).
//   5. Disk retention - finished drafts are kept (LRU-pruned) as a last resort.
//
// editSessions: sessionId -> session. editWindowsByClip: originalId -> sessionId
// (enforces one window per clip). A session re-anchors baseText/currentId after
// each commit so the chain stays contiguous (in-place, not a fork).
const editSessions = new Map();
const editWindowsByClip = new Map();
const conflictWindows = new Map();
const EDIT_DRAFT_RE = /^boardclip-edit-[0-9a-f]{12}-\d+\.txt$/;   // in-flight drafts only
let editSessionSeq = 0;

// LRU-prune the edit archive (size cap + max age). Runs on every draft finish
// ("auto clean") so the buffer self-bounds without a timer. Reuses the shared
// pruneDirectory / planRetention path - same machinery as the history backups.
function pruneEditArchive() {
  pruneDirectory(EDIT_ARCHIVE_DIR, {
    maxBytes: EDIT_ARCHIVE_MAX_BYTES,
    maxAgeMs: EDIT_ARCHIVE_MAX_AGE_MS,
    now: Date.now(),
  });
}

function editorPayloadFrom(value, fallback = {}) {
  if (value && typeof value === 'object') {
    return {
      text: String(value.text == null ? (fallback.text || '') : value.text),
      title: clipboardModel.titleOf({ title: value.title }),
    };
  }
  return {
    text: String(value == null ? (fallback.text || '') : value),
    title: clipboardModel.titleOf({ title: fallback.title }),
  };
}

function writeDraftFile(session) {
  try {
    fs.mkdirSync(EDIT_ARCHIVE_DIR, { recursive: true });
    fs.writeFileSync(session.draftPath, JSON.stringify({
      version: 1,
      text: session.draftText != null ? session.draftText : '',
      title: session.draftTitle || '',
    }), 'utf-8');
  } catch {}
}

function readDraftFile(sessionOrPath, fallback = {}) {
  const draftPath = typeof sessionOrPath === 'string' ? sessionOrPath : sessionOrPath && sessionOrPath.draftPath;
  let raw = null;
  try { raw = fs.readFileSync(draftPath, 'utf-8'); } catch { return null; }
  try {
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === 'object' && parsed.version === 1) return editorPayloadFrom(parsed, fallback);
  } catch {}
  return editorPayloadFrom(raw, fallback);
}

function showEditNotification(title, body) {
  try {
    if (Notification && Notification.isSupported && Notification.isSupported()) {
      new Notification({ title, body, silent: true }).show();
    }
  } catch {}
}

// Surface the conflict-fork outcome so a stale-based commit is never mistaken
// for a clobber: the user's edit was kept as a new clip, untouched.
function notifyEditOutcome(result) {
  if (!result || (result.reason !== 'conflict_created' && result.reason !== 'conflict_merged')) return;
  showEditNotification(
    'BoardClip - saved as a separate clip',
    'This clip changed while you were editing, so your version was kept as a new clip instead of overwriting. Nothing was lost.'
  );
}

// Commit `text` to the clip, re-anchoring the session chain so the next commit
// descends from this one (in-place, not a fork). For a new-note session the
// first non-blank commit creates the clip.
function commitEditSession(session, payload, { final = false } = {}) {
  const next = editorPayloadFrom(payload, { text: session.lastCommitted, title: session.lastCommittedTitle });
  if (next.text === session.lastCommitted && next.title === session.lastCommittedTitle) return null;
  const result = applyExternalTextEdit({
    id: session.currentId,
    originalText: session.baseText,
    originalTitle: session.baseTitle,
    sourceGroups: session.sourceGroups,
    newText: next.text,
    newTitle: next.title,
    writeClipboard: final,   // only a deliberate finish puts the text on the clipboard
  });
  if (result && result.changed) {
    session.lastCommitted = next.text;
    session.lastCommittedTitle = next.title;
    session.baseText = next.text;
    session.baseTitle = next.title;
    if (result.item) { session.currentId = itemKey(result.item); session.isNew = false; }
    notifyEditOutcome(result);
    if (result.conflictRecord && session.win && !session.win.isDestroyed()) {
      session.inConflict = true;
      try { session.win.webContents.send('editor-conflict', conflictModel.normalizeConflictRecord(result.conflictRecord)); } catch {}
    }
  }
  return result;
}

// Editor window bounds persistence (full bounds, unlike the cursor-positioned
// popup which only stores size). Debounced like schedulePopupSizeSave.
function editorBoundsFromSettings() {
  const b = settings.editor_bounds && typeof settings.editor_bounds === 'object' ? settings.editor_bounds : {};
  const width = Math.max(360, Math.round(Number(b.width) || 560));
  const height = Math.max(240, Math.round(Number(b.height) || 520));
  const out = { width, height };
  if (Number.isFinite(Number(b.x)) && Number.isFinite(Number(b.y))) { out.x = Math.round(Number(b.x)); out.y = Math.round(Number(b.y)); }
  return out;
}
let saveEditorBoundsTimer = null;
function scheduleEditorBoundsSave(editorWin) {
  if (!editorWin || editorWin.isDestroyed()) return;
  if (saveEditorBoundsTimer) clearTimeout(saveEditorBoundsTimer);
  saveEditorBoundsTimer = setTimeout(() => {
    saveEditorBoundsTimer = null;
    if (!editorWin || editorWin.isDestroyed()) return;
    const { x, y, width, height } = editorWin.getBounds();
    settings.editor_bounds = { x, y, width: Math.max(360, width), height: Math.max(240, height) };
    saveSettingsFile();
  }, 300);
  if (saveEditorBoundsTimer.unref) saveEditorBoundsTimer.unref();
}

function createEditorWindow(session) {
  const editorWin = new BrowserWindow({
    ...editorBoundsFromSettings(),
    minWidth: 360,
    minHeight: 240,
    frame: false,
    resizable: true,
    show: false,
    skipTaskbar: false,
    title: 'BoardClip - editor',
    ...popupSurfaceOptions(),
    icon: APP_ICON_PATH,
    webPreferences: {
      preload: path.join(SCRIPT_DIR, 'editor-preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  session.win = editorWin;
  editorWin.loadFile(path.join(SCRIPT_DIR, 'editor.html'));
  // Show + focus the editor, then dismiss the popup so it doesn't linger behind
  // the editor window (focus is already on the editor, so hiding ours is safe).
  editorWin.once('ready-to-show', () => { try { editorWin.show(); editorWin.focus(); hidePopup(); } catch {} });
  editorWin.webContents.on('did-finish-load', () => {
    try {
      editorWin.webContents.send('editor-init', {
        sessionId: session.id,
        text: session.baseText,
        noteTitle: session.baseTitle,
        find: session.initialFind || '',
        findRegex: !!session.initialFindRegex,
        focusTitle: !!session.initialFocusTitle,
        title: session.isNew ? 'New clip' : 'Edit clip',
        isNew: session.isNew,
        themeMode: settings.theme_mode || 'system',
        surfaceStyle: resolvedSurfaceStyle(),
        ...appearanceVariantPayload(),
      });
    } catch {}
  });
  editorWin.on('resize', () => scheduleEditorBoundsSave(editorWin));
  editorWin.on('move', () => scheduleEditorBoundsSave(editorWin));
  editorWin.on('closed', () => {
    editSessions.delete(session.id);
    if (session.originalId != null && editWindowsByClip.get(session.originalId) === session.id) {
      editWindowsByClip.delete(session.originalId);
    }
    // Safety net: commit the latest on-disk draft (the IPC commit may have raced
    // the window teardown), then mark the draft finished so it's retained but not
    // re-recovered, and prune.
    const draftPayload = session.inConflict ? null : readDraftFile(session, { text: session.draftText, title: session.draftTitle });
    if (draftPayload != null) commitEditSession(session, draftPayload, { final: true });
    try {
      const done = path.join(path.dirname(session.draftPath), `done-${path.basename(session.draftPath)}`);
      fs.renameSync(session.draftPath, done);
    } catch {}
    pruneEditArchive();
  });
}

function sourceGroupsForNewNote(options) {
  return [...new Set((Array.isArray(options && options.sourceGroups) ? options.sourceGroups : [])
    .map(group => String(group || '').split('/').map(part => part.trim()).filter(Boolean).join('/'))
    .filter(group => group && !group.startsWith('__')))];
}

// Open the editor for clip `id`, or a blank new-note editor when id is null.
function openEditor(id, options = {}) {
  // Opening the editor is a deliberate hand-off: the editor becomes the focus,
  // so dismiss the popup rather than leaving it lingering behind the editor
  // window (that felt "sticky" - you had to click back to the popup + Escape).
  if (id != null) {
    const openSessionId = editWindowsByClip.get(id);
    if (openSessionId) {
      const s = editSessions.get(openSessionId);
      if (s && s.win && !s.win.isDestroyed()) {
        try {
          s.win.show();
          s.win.focus();
          if (options && options.find) s.win.webContents.send('editor-find', { query: options.find, regex: !!options.regex });
          if (options && options.focusTitle) s.win.webContents.send('editor-find', { focusTitle: true });
          hidePopup();
        } catch {}
        return;
      }
    }
  }
  let baseText = '';
  let baseTitle = '';
  let sourceGroups = [];
  let isNew = true;
  let originalId = null;
  if (id != null) {
    const item = findHistoryItem(id);
    if (!item || item.type === 'image') return;
    textBlobStore.hydrateTextItem(item, TEXT_DIR);
    baseText = item.text || '';
    baseTitle = titleOf(item);
    sourceGroups = [...groupsOf(item)];
    isNew = false;
    originalId = itemKey(item);
  } else {
    sourceGroups = sourceGroupsForNewNote(options);
    for (const group of sourceGroups) {
      if (!settings.groups || !settings.groups.includes(group)) applyGroupCreate(group);
    }
  }
  const baseHash = clipboardModel.textHashForText(baseText);
  editSessionSeq += 1;
  const session = {
    id: `e${editSessionSeq}`,
    originalId,
    currentId: originalId || '',
    baseText,
    baseTitle,
    lastCommitted: baseText,
    lastCommittedTitle: baseTitle,
    sourceGroups,
    isNew,
    draftText: baseText,
    draftTitle: baseTitle,
    inConflict: false,
    initialFind: options && options.find ? String(options.find) : '',
    initialFindRegex: !!(options && options.regex),
    initialFocusTitle: !!(options && options.focusTitle),
    // Tag the draft with the base-content hash (the chain anchor) so its lineage
    // is explicit and recoverable straight from the filename.
    draftPath: path.join(EDIT_ARCHIVE_DIR, `boardclip-edit-${baseHash.slice(0, 12)}-${Date.now()}-${editSessionSeq}.txt`),
    win: null,
  };
  writeDraftFile(session);
  editSessions.set(session.id, session);
  if (originalId != null) editWindowsByClip.set(originalId, session.id);
  createEditorWindow(session);
}

function applyConflictResolution(resolution) {
  const payload = resolution && typeof resolution === 'object' ? resolution : {};
  const conflictId = String(payload.id || '');
  const record = conflicts.records.find(conflict => conflict.id === conflictId);
  if (!record) return { ok: false, reason: 'not_found' };
  const action = payload.action || 'save';
  let snapshot = null;
  if (action === 'accept_left') snapshot = record.left;
  else if (action === 'accept_right') snapshot = record.right;

  if (action === 'save' || snapshot) {
    const text = snapshot ? String(snapshot.text || '') : String(payload.text || '');
    const title = snapshot ? titleOf(snapshot) : clipboardModel.titleOf({ title: payload.title });
    const targetId = record.targetId || snapshot && snapshot.id || record.right && record.right.id || record.left && record.left.id || '';
    const target = findHistoryItem(targetId);
    if (target && target.type !== 'image') {
      applyTextEditToItem(target, { newText: text, newTitle: title });
    } else if (text.trim()) {
      applyExternalTextEdit({
        id: '',
        originalText: '',
        originalTitle: '',
        sourceGroups: snapshot && snapshot.groups || [],
        newText: text,
        newTitle: title,
        writeClipboard: false,
      });
    }
  }

  conflicts = conflictModel.removeConflictRecord(conflicts, conflictId);
  saveConflictsFile();
  return { ok: true };
}

// Records go to the renderer as-is (normalized): the reconciliation view
// computes its own diff (vendored CM merge addon), so no server-side hunks.
function conflictListForRenderer() {
  return conflictModel.normalizeConflictState(conflicts).records;
}

function openConflictWindow(conflictId) {
  const id = String(conflictId || '');
  const record = conflictListForRenderer().find(conflict => conflict.id === id);
  if (!record) return { ok: false, reason: 'not_found' };
  const existing = conflictWindows.get(id);
  if (existing && !existing.isDestroyed()) {
    try { existing.show(); existing.focus(); } catch {}
    return { ok: true };
  }
  const conflictWin = new BrowserWindow({
    ...editorBoundsFromSettings(),
    minWidth: 520,
    minHeight: 340,
    frame: false,
    resizable: true,
    show: false,
    skipTaskbar: false,
    title: 'BoardClip - resolve conflict',
    ...popupSurfaceOptions(),
    icon: APP_ICON_PATH,
    webPreferences: {
      preload: path.join(SCRIPT_DIR, 'editor-preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  conflictWindows.set(id, conflictWin);
  const sessionId = `conflict:${id}`;
  conflictWin.loadFile(path.join(SCRIPT_DIR, 'editor.html'));
  conflictWin.once('ready-to-show', () => { try { conflictWin.show(); conflictWin.focus(); } catch {} });
  conflictWin.webContents.on('did-finish-load', () => {
    try {
      conflictWin.webContents.send('editor-init', {
        sessionId,
        text: '',
        noteTitle: '',
        title: 'Resolve conflict',
        themeMode: settings.theme_mode || 'system',
        surfaceStyle: resolvedSurfaceStyle(),
        ...appearanceVariantPayload(),
      });
      conflictWin.webContents.send('editor-conflict', record);
    } catch {}
  });
  conflictWin.on('resize', () => scheduleEditorBoundsSave(conflictWin));
  conflictWin.on('move', () => scheduleEditorBoundsSave(conflictWin));
  conflictWin.on('closed', () => {
    if (conflictWindows.get(id) === conflictWin) conflictWindows.delete(id);
  });
  return { ok: true };
}

// ===========================================================================
// Unify: fold N selected TEXT clips into one, pairwise, through the SAME
// reconciliation window + view the sync-conflict flow uses. Oldest -> newest,
// atomic: the sources aren't touched until the final step is confirmed, so
// closing/canceling any step leaves the history unchanged.
// ===========================================================================
const unifySessions = new Map();
let unifySeq = 0;

function unifyRecord(session) {
  const right = session.remaining[session.step];
  return {
    id: `${session.id}:${session.step}`,
    unify: true,
    title: `Unify - step ${session.step + 1} of ${session.total}`,
    saveLabel: session.step + 1 >= session.total ? 'Merge all' : 'Merge & continue',
    left: { id: 'acc', type: 'text', title: session.acc.title, text: session.acc.text, groups: session.acc.groups },
    right: { id: right.id, type: 'text', title: right.title, text: right.text, groups: right.groups },
    // No hunks here: createReconciliationView computes its own line diff
    // (shared Core.diffLineHunks) for the staging panes.
    result: { title: session.acc.title || right.title },
  };
}

function startUnify(ids) {
  const items = (Array.isArray(ids) ? ids : []).map(findHistoryItem).filter(it => it && it.type !== 'image');
  for (const it of items) textBlobStore.hydrateTextItem(it, TEXT_DIR);
  const sorted = items.slice().sort((a, b) => (a.ts || 0) - (b.ts || 0)); // oldest -> newest
  if (sorted.length < 2) return { ok: false, reason: 'need_two_text' };
  const numbered = sorted.find(it => numpadSlotOf(it) != null);
  const session = {
    id: `unify:${++unifySeq}`,
    sourceIds: sorted.map(itemKey),
    unionGroups: [...new Set(sorted.flatMap(groupsOf))],
    numberSlot: numbered ? numpadSlotOf(numbered) : null,
    pinned: sorted.some(isPinned),
    acc: { title: titleOf(sorted[0]), text: sorted[0].text || '', groups: groupsOf(sorted[0]) },
    remaining: sorted.slice(1).map(it => ({ id: itemKey(it), title: titleOf(it), text: it.text || '', groups: groupsOf(it) })),
    total: sorted.length - 1,
    step: 0,
    win: null,
  };
  unifySessions.set(session.id, session);
  openUnifyWindow(session);
  return { ok: true };
}

function openUnifyWindow(session) {
  const unifyWin = new BrowserWindow({
    ...editorBoundsFromSettings(),
    minWidth: 520,
    minHeight: 340,
    frame: false,
    resizable: true,
    show: false,
    skipTaskbar: false,
    title: 'BoardClip - unify clips',
    ...popupSurfaceOptions(),
    icon: APP_ICON_PATH,
    webPreferences: {
      preload: path.join(SCRIPT_DIR, 'editor-preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  session.win = unifyWin;
  unifyWin.loadFile(path.join(SCRIPT_DIR, 'editor.html'));
  unifyWin.once('ready-to-show', () => { try { unifyWin.show(); unifyWin.focus(); } catch {} });
  unifyWin.webContents.on('did-finish-load', () => {
    try {
      unifyWin.webContents.send('editor-init', {
        sessionId: session.id,
        text: '',
        noteTitle: '',
        title: 'Unify clips',
        themeMode: settings.theme_mode || 'system',
        surfaceStyle: resolvedSurfaceStyle(),
        ...appearanceVariantPayload(),
      });
      unifyWin.webContents.send('editor-conflict', unifyRecord(session));
    } catch {}
  });
  unifyWin.on('resize', () => scheduleEditorBoundsSave(unifyWin));
  unifyWin.on('move', () => scheduleEditorBoundsSave(unifyWin));
  unifyWin.on('closed', () => { unifySessions.delete(session.id); });
}

// One resolved step: fold the merged result into the accumulator and advance, or
// commit the whole unify on the last step. Returns the next record (or done).
function unifyStep(sessionId, resolution) {
  const session = unifySessions.get(String(sessionId || ''));
  if (!session) return { done: true };
  const payload = resolution && typeof resolution === 'object' ? resolution : {};
  session.acc = {
    title: clipboardModel.titleOf({ title: payload.title }),
    text: String(payload.text || ''),
    groups: session.acc.groups,
  };
  session.step += 1;
  if (session.step >= session.total) {
    applyUnify(session);
    unifySessions.delete(session.id);
    // Close the window from HERE: the renderer's editorApi.close() arrives
    // after the session is gone, where the editor-close branch would no-op —
    // leaving a frameless window with no working close path.
    const win = session.win;
    if (win && !win.isDestroyed()) { try { win.close(); } catch {} }
    return { done: true };
  }
  return { done: false, nextRecord: unifyRecord(session) };
}

function applyUnify(session) {
  const mergedText = String(session.acc.text || '');
  const mergedTitle = clipboardModel.titleOf({ title: session.acc.title });
  for (const id of session.sourceIds) {
    const index = findHistoryIndex(id);
    if (index >= 0) deleteHistoryIndex(index); // deliberate merge: sources replaced by the union
  }
  // Persist the source tombstones deleteHistoryIndex just added — without this
  // a crash before the next unrelated settings save lets sync resurrect the
  // merged-away sources (mirrors applyDeleteItems).
  saveSettingsFile();
  if (mergedText.trim()) {
    const now = Date.now();
    addToHistory({ type: 'text', text: mergedText, ts: now / 1000, updatedAt: now }, it => it.type !== 'image' && it.text === mergedText);
    const item = history.find(it => it.type !== 'image' && it.text === mergedText);
    if (item) {
      if (mergedTitle) clipboardModel.setTitleMetadata(item, mergedTitle);
      for (const group of session.unionGroups) {
        if (!settings.groups || !settings.groups.includes(group)) applyGroupCreate(group);
        const pin = ensurePin(item);
        if (!pin.groups) pin.groups = [];
        if (!pin.groups.includes(group)) pin.groups.push(group);
      }
      if (session.unionGroups.length) touchPinGroups(item);
      if (session.pinned && !item.pin) item.pin = {};
      saveHistory();
      if (session.numberSlot != null) applyNumpadAssign(itemKey(item), session.numberSlot);
    }
  } else {
    saveHistory();
  }
}

// ORPHAN RECOVERY: re-apply any in-flight edit draft left behind by a previous
// session (BoardClip died/restarted while an editor was open, so it never
// committed). Committed drafts carry a `done-` prefix and are skipped here.
// Also migrates any legacy Notepad temps from os.tmpdir. Runs once at startup.
function recoverOrphanedEdits() {
  let recovered = 0;
  for (const dir of [EDIT_ARCHIVE_DIR, os.tmpdir()]) {
    let files;
    try { files = fs.readdirSync(dir); } catch { continue; }
    for (const name of files) {
      if (!EDIT_DRAFT_RE.test(name)) continue;
      const p = path.join(dir, name);
      const draft = readDraftFile(p);
      if (!draft) continue;
      // Recover only if not already a live clip (i.e. never committed). Add as a
      // new clip - fork-safe, never overwrites.
      if (draft.text.trim() && !history.some(it => (it.text || '') === draft.text)) {
        const result = applyExternalTextEdit({ id: '', originalText: '', originalTitle: '', sourceGroups: [], newText: draft.text, newTitle: draft.title, writeClipboard: false });
        if (result && result.changed) recovered++;
      }
      // Retire the draft: rename to done- in the archive dir (retained, not re-recovered).
      try {
        fs.mkdirSync(EDIT_ARCHIVE_DIR, { recursive: true });
        const done = path.join(EDIT_ARCHIVE_DIR, `done-${name}`);
        fs.renameSync(p, done);
      } catch { try { fs.unlinkSync(p); } catch {} }
    }
  }
  pruneEditArchive();
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
  if (!settings.groups || !settings.groups.includes(group)) applyGroupCreate(group);
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

function cloneHistoryItem(item) {
  return { ...item, pin: clonePin(item.pin) };
}

// Batch delete used by the multi-select UI (single + bulk both route here for the
// Undo toast). Returns snapshots so the Undo can restore them. Deliberately
// RETAINS the underlying text/image blobs (no removeItemImage / blob prune) so a
// restore always has its content; content-addressed files dedupe on re-add.
function applyDeleteItems(ids) {
  const snapshots = [];
  let changed = false;
  for (const id of (Array.isArray(ids) ? ids : [])) {
    const index = findHistoryIndex(id);
    if (index < 0) continue;
    const item = history[index];
    if (item.type !== 'image') textBlobStore.hydrateTextItem(item, TEXT_DIR); // capture full text for restore
    snapshots.push(cloneHistoryItem(item));
    addTombstone(itemKey(item));
    history.splice(index, 1);
    changed = true;
  }
  if (changed) { saveSettingsFile(); saveHistory(); }
  return snapshots;
}

// Restore clips removed by applyDeleteItems (the Undo path). Clears each item's
// tombstone so a later sync can't resurrect the deletion.
function applyRestoreItems(snapshots) {
  let changed = false;
  for (const snap of (Array.isArray(snapshots) ? snapshots : [])) {
    if (!snap) continue;
    const restored = cloneHistoryItem(snap);
    ensureItemId(restored);
    const id = itemKey(restored);
    if (findHistoryIndex(id) >= 0) continue;
    settings.tombstones = normalizeTombstones(settings.tombstones).filter(t => t.id !== id);
    history.push(restored);
    changed = true;
  }
  if (changed) {
    history.sort((a, b) => (b.ts || 0) - (a.ts || 0));
    // A restored clip may carry a numpad slot that was reassigned during the
    // undo window — the shared dedupe keeps one owner per slot.
    dedupeNumpadSlots(history);
    saveSettingsFile();
    saveHistory();
  }
  return changed;
}

// Explicit (non-toggle) group membership, mirroring applyGroupAssign's pin
// bookkeeping. Returns true if it changed the item.
function setItemGroupMembership(item, group, shouldHave) {
  const pin = ensurePin(item);
  if (!pin.groups) pin.groups = [];
  const idx = pin.groups.indexOf(group);
  const has = idx >= 0;
  if (!!shouldHave === has) return false;
  if (shouldHave) pin.groups.push(group);
  else { pin.groups.splice(idx, 1); if (pin.groups.length === 0) delete pin.groups; }
  touchPinGroups(item);
  return true;
}

// Bulk add/remove a group across many clips in one save (smart tri-state toggle
// decided in the shared controller). Reuses the single-item group bookkeeping.
function applyGroupAssignMany(ids, group, shouldHave) {
  if (!group) return false;
  if (!settings.groups || !settings.groups.includes(group)) applyGroupCreate(group);
  let changed = false;
  for (const id of (Array.isArray(ids) ? ids : [])) {
    const item = findHistoryItem(id);
    if (item && setItemGroupMembership(item, group, !!shouldHave)) changed = true;
  }
  if (changed) saveHistory();
  return changed;
}

// Name a clip (text OR image). Reuses the model's title helper so the name +
// sync-merge metadata (titleUpdatedAt) match the editor's title-edit path.
function applyClipTitle(id, title) {
  const item = findHistoryItem(id);
  if (!item) return false;
  clipboardModel.setTitleMetadata(item, title);
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
      try {
        modal.webContents.send('approval-settings', {
          theme: settings.theme_mode === 'light' || settings.theme_mode === 'dark' ? settings.theme_mode : currentColorScheme(),
          accent: settings.accent_variant, density: settings.ui_density, corners: settings.ui_corners, borders: settings.ui_borders,
        });
      } catch {}
      try { modal.webContents.send('approval-request', payload); } catch {}
    });
    modal.on('closed', () => finish('deny'));
  });
}

function buildApprovalRequest(tool, args, targetItem, client) {
  const dangerTools = new Set(['delete_clip', 'edit_clip', 'copy_to_clipboard', 'paste_clip']);
  // Read tools (list_context/list_clips/get_clip-shared/search-shared) are served
  // locally in the helper and never reach this function - so only forwarded/gated
  // tools need entries here.
  const meta = {
    add_clip: 'Add a new clip to your history',
    edit_clip: 'Edit the text of a clip',
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
  else if (tool === 'edit_clip') detail = `${args.append ? 'Append' : 'New text'}:\n${String(args.text || '')}`;
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
// edit_clip overwrites existing clip content (lossy), so it prompts every time
// like delete_clip rather than being free-on-shared. Users can still grant a
// per-tool "always allow" from the modal to make repeated edits frictionless.
const MCP_ALWAYS_GATED = new Set(['delete_clip', 'edit_clip', 'copy_to_clipboard', 'paste_clip', 'read_clip', 'search_all', 'image_path']);
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
    case 'edit_clip': {
      const item = findHistoryItem(args.id);
      if (!item) throw new Error('not_found');
      if (item.type === 'image') throw new Error('not_a_text_clip');
      // append newline-joins onto the hydrated body; otherwise replace. Metadata
      // (pin/groups/numpad/title) is preserved by applyTextEditToItem.
      const result = applyTextEditToItem(item, {
        newText: cur => (args.append && cur ? `${cur}\n${args.text}` : String(args.text)),
        newTitle: args.title != null ? String(args.title) : undefined,
      });
      const saved = result && result.item ? result.item : item;
      return { ok: !!(result && result.changed), reason: result && result.reason, id: itemKey(saved) };
    }
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
        surface_style: resolvedSurfaceStyle(),
        surface_supported: glassSupport() !== 'none',
        debug_variants: (!app.isPackaged || !!process.env.BOARDCLIP_DEBUG_VARIANTS),
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

  ipcMain.handle('set-clip-title', (_, id, title) => applyClipTitle(id, title));

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
    if (body.quick_paste_mode !== undefined && ['type', 'clipboard'].includes(body.quick_paste_mode)) {
      settings.quick_paste_mode = body.quick_paste_mode;
    }
    if (body.quick_paste_restore !== undefined) settings.quick_paste_restore = !!body.quick_paste_restore;
    if (body.quick_paste_restore_delay_ms !== undefined) {
      settings.quick_paste_restore_delay_ms = Math.min(2000, Math.max(0, parseInt(body.quick_paste_restore_delay_ms) || 0));
    }
    // Appearance variants (per-machine; not synced). surface_style is a real
    // user setting; the others are dev-only auditioning knobs that persist so a
    // chosen combo survives a restart.
    let surfaceChanged = false;
    if (body.surface_style !== undefined && ['auto', 'glass', 'solid'].includes(body.surface_style)) {
      surfaceChanged = settings.surface_style !== body.surface_style;
      settings.surface_style = body.surface_style;
    }
    if (body.accent_variant !== undefined && ['blue', 'teal', 'mono'].includes(body.accent_variant)) settings.accent_variant = body.accent_variant;
    if (body.ui_density !== undefined && ['normal', 'compact'].includes(body.ui_density)) settings.ui_density = body.ui_density;
    if (body.ui_corners !== undefined && ['soft', 'sharp'].includes(body.ui_corners)) settings.ui_corners = body.ui_corners;
    if (body.ui_borders !== undefined && ['bordered', 'borderless'].includes(body.ui_borders)) settings.ui_borders = body.ui_borders;
    saveSettingsFile();
    if (surfaceChanged) applySurfaceToPopup();
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

  ipcMain.handle('open-editor', (_, id, options) => {
    openEditor(id, options || {});
  });
  ipcMain.handle('new-note', (_, options) => {
    openEditor(null, options || {});
  });

  // Built-in editor window streams: draft on every keystroke (crash-safe),
  // commit on idle/save/close, close. Keyed by the session id main assigned.
  ipcMain.on('editor-draft', (_, sessionId, payload) => {
    const session = editSessions.get(sessionId);
    if (!session) return;
    const next = editorPayloadFrom(payload, { text: session.draftText, title: session.draftTitle });
    session.draftText = next.text;
    session.draftTitle = next.title;
    writeDraftFile(session);
  });
  ipcMain.on('editor-commit', (_, sessionId, payload) => {
    const session = editSessions.get(sessionId);
    if (!session) return;
    const next = editorPayloadFrom(payload, { text: session.draftText, title: session.draftTitle });
    session.draftText = next.text;
    session.draftTitle = next.title;
    writeDraftFile(session);
    commitEditSession(session, next);
  });
  ipcMain.on('editor-close', (event, sessionId) => {
    if (String(sessionId || '').startsWith('conflict:')) {
      const conflictId = String(sessionId).slice('conflict:'.length);
      const conflictWin = conflictWindows.get(conflictId);
      if (conflictWin && !conflictWin.isDestroyed()) { try { conflictWin.close(); } catch {} }
      return;
    }
    if (String(sessionId || '').startsWith('unify:')) {
      // Closing a unify window before the final step aborts it (no changes).
      const session = unifySessions.get(String(sessionId));
      unifySessions.delete(String(sessionId));
      if (session && session.win && !session.win.isDestroyed()) { try { session.win.close(); } catch {} return; }
      // Session already finished/aborted server-side: fall through to close the
      // sender's window so the frameless X always works.
    }
    const session = editSessions.get(sessionId);
    if (session && session.win && !session.win.isDestroyed()) { try { session.win.close(); } catch {} return; }
    // Fallback for any frameless editor-family window whose session is gone.
    const senderWin = BrowserWindow.fromWebContents(event.sender);
    if (senderWin && !senderWin.isDestroyed()) { try { senderWin.close(); } catch {} }
  });
  ipcMain.handle('resolve-conflict', (_, payload) => applyConflictResolution(payload));
  ipcMain.handle('get-conflicts', () => conflictListForRenderer());
  ipcMain.handle('open-conflict', (_, id) => openConflictWindow(id));

  // Multi-select bulk operations.
  ipcMain.handle('delete-items', (_, ids) => applyDeleteItems(ids));
  ipcMain.handle('restore-items', (_, snaps) => applyRestoreItems(snaps));
  ipcMain.handle('group-assign-many', (_, ids, group, shouldHave) => applyGroupAssignMany(ids, group, shouldHave));
  ipcMain.handle('paste-many', (_, ids) => pasteMany(ids));
  ipcMain.handle('start-unify', (_, ids) => startUnify(ids));
  ipcMain.handle('unify-step', (_, sessionId, payload) => unifyStep(sessionId, payload));

  ipcMain.handle('open-image', (_, id) => {
    const item = findHistoryItem(id);
    if (!item || item.type !== 'image') return;
    const imgPath = path.join(IMG_DIR, item.image);
    if (fs.existsSync(imgPath)) {
      // The external viewer stealing focus must not blur-hide the popup, so the
      // user can open several images without the tray closing under them.
      keepPopupOpenBriefly();
      shell.openPath(imgPath);
    }
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
  // Hardware numpad key from the Windows LL hook. Route through the shared
  // dispatcher (same as the panel number keys / global shortcut) so it gets
  // full tracing, popup-focus assignment, and the serialized robust paste —
  // rather than a bespoke second path that bypassed all of it.
  runNumpadSlotAction(slot, { source: 'hook' }).catch(err => {
    diagnostics.record('shortcut.quick_paste_error', { slot, source: 'hook', error: err && err.message }, { forceFile: true });
  });
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
