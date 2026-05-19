const { app, BrowserWindow, Tray, Menu, globalShortcut, clipboard, nativeImage,
        ipcMain, protocol, screen, shell, nativeTheme, dialog } = require('electron');
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
const clipboardCapture = require('./lib/clipboard-capture');
const { createAutoUpdater, updateSupport } = require('./lib/auto-update');
const syncPaths = require('./lib/sync-paths');

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
const DB_PATH = path.join(SCRIPT_DIR, 'clipboard-history.json');
const SETTINGS_PATH = path.join(SCRIPT_DIR, 'clipboard-settings.json');
const IMG_DIR = path.join(SCRIPT_DIR, 'clipboard-images');
const APP_ICON_PATH = path.join(SCRIPT_DIR, 'icon.png');

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
  migrateSyncSettings();
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
let cloudAccountsCache = [];
let cloudAccountsCacheAt = 0;
const CLOUD_ACCOUNTS_CACHE_TTL_MS = 5 * 60 * 1000;
const DEFAULT_SHOW_SHORTCUT = 'CommandOrControl+Shift+V';

function defaultShowShortcut() {
  return process.platform === 'win32' ? 'Super+V' : DEFAULT_SHOW_SHORTCUT;
}

function effectiveShowShortcut() {
  return settings.show_shortcut || defaultShowShortcut();
}

function globalShowShortcut() {
  if (process.platform === 'darwin' && shortcutUsesFn(settings.show_shortcut)) return '';
  return settings.show_shortcut || (process.platform === 'win32' ? '' : DEFAULT_SHOW_SHORTCUT);
}

function normalizeShowShortcut(shortcut) {
  const value = String(shortcut || '').trim();
  if (process.platform === 'win32' && value === defaultShowShortcut()) return '';
  if (process.platform !== 'win32' && value === DEFAULT_SHOW_SHORTCUT) return '';
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
  const next = { ...item, text: text || '', updatedAt: Date.now() };
  next.id = legacyContentKey(next);

  const existingIdx = history.findIndex(h => h !== item && itemKey(h) === next.id);
  if (existingIdx >= 0) {
    const existing = history[existingIdx];
    existing.text = next.text;
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
      const now = Date.now();
      if (slot.type === 'image') {
        const match = history.find(h => h.type === 'image' && h.image === slot.image);
        if (match) {
          ensurePin(match).number = num;
          touchPinNumber(match, now);
        } else {
          history.unshift({ type: 'image', image: slot.image, ts: now / 1000, updatedAt: now, pinUpdatedAt: now, pin: { number: num, updatedAt: now, numberUpdatedAt: now } });
        }
      } else {
        const text = slot.text || '';
        const match = history.find(h => h.type !== 'image' && h.text === text);
        if (match) {
          ensurePin(match).number = num;
          touchPinNumber(match, now);
        } else {
          history.unshift({ type: 'text', text, ts: now / 1000, updatedAt: now, pinUpdatedAt: now, pin: { number: num, updatedAt: now, numberUpdatedAt: now } });
        }
      }
    }
    delete settings.numpad_slots;
    saveHistory();
    saveSettingsFile();
  } else if (!history.length) {
    for (const num of [9, 8, 7, 6, 5, 4, 3, 2, 1]) {
      if (AHK_PRESETS[num]) {
        const now = Date.now();
        history.unshift({ type: 'text', text: AHK_PRESETS[num], ts: now / 1000, updatedAt: now, pinUpdatedAt: now, pin: { number: num, updatedAt: now, numberUpdatedAt: now } });
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
  return remoteSave;
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
    await syncMerge();
  }
}

function syncImages(remoteImgDir) {
  try {
    if (!fs.existsSync(remoteImgDir)) fs.mkdirSync(remoteImgDir, { recursive: true });
  } catch {
    return;
  }

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

let syncDebounceTimer = null;
let insideSync = false;

function scheduleSyncMerge() {
  if (insideSync) return;
  if (syncDebounceTimer) clearTimeout(syncDebounceTimer);
  syncDebounceTimer = setTimeout(syncMerge, 500);
}

function readRemoteState(syncPath) {
  const remoteDbPath = path.join(syncPath, 'clipboard-history.json');
  const remoteSettingsPath = path.join(syncPath, 'clipboard-settings.json');
  let remoteHistory = [];
  try {
    const loaded = JSON.parse(fs.readFileSync(remoteDbPath, 'utf-8'));
    if (Array.isArray(loaded)) remoteHistory = loaded;
  } catch {}
  let remoteSettings = {};
  try { remoteSettings = JSON.parse(fs.readFileSync(remoteSettingsPath, 'utf-8')); } catch {}
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
    build: BUILD_INFO,
    local: stateSummary(SCRIPT_DIR),
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

function writeRemoteState(syncPath, canonicalHistory, canonicalSettings) {
  if (!fs.existsSync(syncPath)) fs.mkdirSync(syncPath, { recursive: true });
  const remoteDbPath = path.join(syncPath, 'clipboard-history.json');
  const remoteSettingsPath = path.join(syncPath, 'clipboard-settings.json');
  const remoteImgDir = path.join(syncPath, 'clipboard-images');
  const nextHistoryJson = JSON.stringify(canonicalHistory);
  const nextSettingsJson = JSON.stringify(canonicalSettings, null, 2);
  let currentHistoryJson = null;
  let currentSettingsJson = null;
  try { currentHistoryJson = fs.readFileSync(remoteDbPath, 'utf-8'); } catch {}
  try { currentSettingsJson = fs.readFileSync(remoteSettingsPath, 'utf-8'); } catch {}
  if (currentHistoryJson !== nextHistoryJson) atomicWriteFile(remoteDbPath, nextHistoryJson);
  if (currentSettingsJson !== nextSettingsJson) atomicWriteFile(remoteSettingsPath, nextSettingsJson);
  syncImages(remoteImgDir);
}

async function syncMerge() {
  if (insideSync) return;
  insideSync = true;
  try {
    const syncPaths = await getEnabledSyncPaths();
    if (!syncPaths.length) return;

    let canonicalHistory = history;
    const previousSettingsJson = JSON.stringify(remoteSettingsPayload());

    for (const syncPath of syncPaths) {
      const { remoteHistory, remoteSettings } = readRemoteState(syncPath);
      settings.tombstones = normalizeTombstones([
        ...(settings.tombstones || []),
        ...(remoteSettings.tombstones || []),
      ]);
      settings.group_tombstones = normalizeGroupTombstones([
        ...(settings.group_tombstones || []),
        ...(remoteSettings.group_tombstones || []),
      ]);
      const historyGroups = canonicalHistory.flatMap(h => groupsOf(h));
      settings.groups = mergeGroups(settings.groups, [...(remoteSettings.groups || []), ...historyGroups]);
      canonicalHistory = mergeHistories(canonicalHistory, remoteHistory);
      syncImages(path.join(syncPath, 'clipboard-images'));
    }

    const localChanged = JSON.stringify(canonicalHistory) !== JSON.stringify(history);
    const settingsChanged = JSON.stringify(remoteSettingsPayload()) !== previousSettingsJson;
    if (localChanged) {
      history.length = 0;
      history.push(...canonicalHistory);
    }
    if (localChanged || settingsChanged) {
      saveHistory();
      saveSettingsFile();
    }

    const canonicalSettings = remoteSettingsPayload();
    for (const syncPath of syncPaths) {
      try { writeRemoteState(syncPath, history, canonicalSettings); } catch {}
    }
  } finally { insideSync = false; }
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
}

function pollClipboard() {
  if (!pollGate) return;

  const startedAt = Date.now();
  let formatsKey = '';
  try {
    const formats = clipboardFormats();
    formatsKey = clipboardCapture.formatsKey(formats);
    if (formatsContainImage(formatsKey)) {
      const now = Date.now();
      const probeToken = clipboardCapture.clipboardChangeToken(formats);
      if (probeToken && probeToken === lastCapturedImageToken) {
        return;
      }
      if (probeToken === lastImageProbeToken && now - lastImageProbeAt < IMAGE_CLIPBOARD_PROBE_MS) {
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
      lastText = text;
      lastImgHash = '';
      addToHistory(
        { type: 'text', text, ts: Date.now() / 1000 },
        it => it.text === text
      );
    }
  } catch {
  } finally {
    const elapsed = Date.now() - startedAt;
    if (elapsed > SLOW_CLIPBOARD_POLL_MS && Date.now() - lastSlowPollLogAt > 5000) {
      lastSlowPollLogAt = Date.now();
      logSafe(`Slow clipboard poll: ${elapsed}ms (${formatsKey || 'unknown formats'})`);
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
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  configureMacPopupWindow(win);
  win.loadFile('index.html');

  // Dev/source installs: auto-reload renderer files while iterating.
  let reloadTimer = null;
  const scheduleRendererReload = () => {
    if (reloadTimer) clearTimeout(reloadTimer);
    reloadTimer = setTimeout(() => {
      if (win && !win.isDestroyed()) win.webContents.reloadIgnoringCache();
    }, 300);
  };
  const rendererWatchers = [];
  for (const file of [
    path.join(__dirname, 'index.html'),
    path.join(__dirname, 'site', 'shared', 'clipboard-ui-core.js'),
    path.join(__dirname, 'site', 'shared', 'clipboard-popup.css'),
  ]) {
    try { rendererWatchers.push(fs.watch(file, scheduleRendererReload)); } catch {}
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
  return win.webContents.executeJavaScript(`
    window.resetPopupState?.();
    window.focusSearch?.();
    true;
  `).catch(() => false);
}

function ensurePopupRendererResponsive() {
  if (!win || win.isDestroyed() || !win.webContents || win.webContents.isDestroyed()) return;
  if (win.webContents.isLoading()) return;

  let settled = false;
  const timer = setTimeout(() => {
    if (settled || !win || win.isDestroyed() || !win.isVisible()) return;
    logSafe('BoardClip popup renderer did not respond after show; reloading.');
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
        auto_update: support.supported,
        update_support: support,
      };
    })(),
    shortcut_info: {
      show: effectiveShowShortcut(),
      custom: !!settings.show_shortcut,
      default: defaultShowShortcut(),
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
    saveSettingsFile();
    pruneHistory();
  });

  ipcMain.handle('set-show-shortcut', (_, shortcut) => setShowShortcut(shortcut));
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
  ipcMain.handle('get-sync-diagnostics', () => syncDiagnostics());

  ipcMain.handle('sync-now', async () => {
    await syncMerge();
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

function registerShortcuts() {
  globalShortcut.unregisterAll();

  let showShortcutRegistered = true;
  const showKey = globalShowShortcut();
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

  if (process.platform === 'win32') {
    return { showShortcutRegistered, showShortcut: effectiveShowShortcut() };
  }

  for (let n = 1; n <= 9; n++) {
    const key = `Super+num${n}`;
    const slot = n;
    const registered = globalShortcut.register(key, () => handleNumpad(slot));
    if (!registered) logSafe(`Warning: Could not register ${key}`);
  }

  return { showShortcutRegistered, showShortcut: effectiveShowShortcut() };
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
  setupIPC();
  createPopup();
  createTray();
  registerShortcuts();
  autoUpdater.start();

  // Sync with shared folder on startup + every 30s
  syncMerge();
  pollClipboard();
  setInterval(pollClipboard, 400);
  setInterval(() => syncMerge(), 30000);

  logSafe(`BoardClip running. ${effectiveShowShortcut()} to open popup.`);
});

app.on('will-quit', () => {
  globalShortcut.unregisterAll();
  if (windowsHook) windowsHook.uninstall();
  if (macosHotkey) macosHotkey.uninstall();
});
app.on('window-all-closed', () => { /* keep running as tray app */ });
