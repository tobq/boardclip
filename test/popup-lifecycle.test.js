'use strict';

// Regression guard for Win+V opening a persistent popup. A normal popup show
// may reset UI state asynchronously, but it must never turn scheduler latency
// into a full renderer reload. Actual renderer-process exits recover through
// Electron's native lifecycle event instead.

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const mainJs = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8');

function between(source, start, end) {
  const from = source.indexOf(start);
  assert.notStrictEqual(from, -1, `Missing source marker: ${start}`);
  const to = source.indexOf(end, from);
  assert.notStrictEqual(to, -1, `Missing source marker: ${end}`);
  return source.slice(from, to);
}

// The old latency watchdog was exactly the user-visible bug: 800ms passed,
// then reloadIgnoringCache destroyed the live popup renderer.
assert.ok(!mainJs.includes('function ensurePopupRendererResponsive()'),
  'Popup show must not retain a synthetic renderer responsiveness watchdog');
assert.ok(!mainJs.includes("popup.renderer_unresponsive', { timeout_ms: 800"),
  'Popup show must not reload after an arbitrary 800ms deadline');

// Normal show has only a best-effort reset; it contains no reload path.
{
  const showPopup = between(mainJs, 'function showPopup() {', 'function setClipboardToItem(');
  assert.ok(showPopup.includes('resetPopupAfterShow();'),
    'showPopup must request the non-blocking post-show reset');
  assert.ok(!showPopup.includes('reloadIgnoringCache'),
    'showPopup must never hard-reload the renderer');
  assert.ok(!showPopup.includes('.reload('),
    'showPopup must never reload the renderer by any path');
}
{
  const resetAfterShow = between(mainJs, 'function resetPopupAfterShow() {', 'function startClickAwayWatcher() {');
  assert.ok(resetAfterShow.includes('resetPopupRendererState();'),
    'Post-show work should retain the state reset and search focus');
  assert.ok(!resetAfterShow.includes('setTimeout('),
    'Post-show reset must not have a latency watchdog');
  assert.ok(!/webContents\.reload(?:IgnoringCache)?\s*\(/.test(resetAfterShow),
    'Post-show reset must never reload the renderer');
}

// Crash recovery is registered separately on the WebContents lifecycle. This
// keeps recovery from actual termination while making ordinary Win+V harmless.
{
  const popupSetup = between(mainJs, 'function createPopup() {', '  // Dev/source installs: auto-reload renderer files while iterating.');
  assert.ok(popupSetup.includes("win.webContents.on('render-process-gone'"),
    'createPopup must recover only from Electron render-process-gone');
  assert.ok(popupSetup.includes("reason === 'clean-exit'"),
    'Clean renderer exits must not be treated as crashes');
  assert.ok(popupSetup.includes('win.webContents.reload();'),
    'Actual renderer-process exits should reload for recovery');
  assert.ok(!popupSetup.includes('reloadIgnoringCache'),
    'Crash recovery should not use the user-visible cache-busting reload');
  assert.ok(popupSetup.includes('if (popupRendererRecovery) popupRendererRecovery.cancel();'),
    'a second crash during recovery must cancel stale listeners and retry');
  assert.ok(popupSetup.includes("win.webContents.on('unresponsive'"),
    'Native unresponsive events should be observed for diagnostics');
  assert.ok(popupSetup.includes("win.webContents.on('responsive'"),
    'Native responsive events should be observed for diagnostics');
}

// Quitting is process-wide, including updater-driven app.exit(), so renderer
// recovery cannot revive a window while BoardClip is intentionally exiting.
assert.ok(between(mainJs, "app.on('before-quit'", "app.on('will-quit'").includes('app.isQuitting = true;'),
  'before-quit must mark the app as quitting for renderer recovery');
assert.ok(between(mainJs, "app.on('before-quit'", "app.on('will-quit'").includes("diagnostics.record('app.quit'"),
  'before-quit must record app.quit so a silent death is distinguishable from a quit');
assert.ok(between(mainJs, 'function relaunchAfterUpdate() {', 'function developerUpdateMode() {').includes('app.isQuitting = true;'),
  'updater relaunch must mark the app as quitting before app.exit()');

// Popup-open + save hot-path cost guards (2026-09-02 freeze investigation). Each
// of these was a measured multi-hundred-ms main-thread or renderer stall on a
// ~10k-item history, on EVERY popup open or clipboard capture.
{
  const indexHtml = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
  const preloadJs = fs.readFileSync(path.join(__dirname, '..', 'preload.js'), 'utf8');
  assert.ok(/ipcMain\.handle\('get-history-state', \(_, knownRevision\)/.test(mainJs),
    'get-history-state must take the renderer\'s known revision and short-circuit when unchanged');
  assert.ok(mainJs.includes('{ revision: dataRevision, unchanged: true }'),
    'unchanged history must answer without cloning the items');
  assert.ok(preloadJs.includes("getHistoryState: (knownRevision) => ipcRenderer.invoke('get-history-state', knownRevision)"),
    'preload must forward the known revision');
  assert.ok(indexHtml.includes('window.api.getHistoryState(dataRevision)'),
    'renderer must pass its revision to get-history-state');
  assert.ok(indexHtml.includes('let refreshInFlight = null;') && indexHtml.includes('refreshQueued'),
    'renderer refreshes must coalesce (one in flight + one queued)');
  assert.ok(mainJs.includes('...rendererSettingsView(),') && mainJs.includes("const RENDERER_HIDDEN_SETTINGS = ['tombstones', 'group_tombstones', 'supersedes']"),
    'get-settings must not ship the sync ledgers to the renderer');
  assert.ok(mainJs.includes('storage_bytes: cachedStorageBytes()'),
    'get-settings must not walk the data dir on every call');
  assert.ok(mainJs.includes('refreshBuildInfo({ maxAgeMs: 60 * 1000 })'),
    'get-settings must not spawn git on every call');
  // The backup snapshot (hash ~10k items + retention) must never run inline on the save path.
  const decide = between(mainJs, 'function maybeBackupHistoryBeforeWrite(', 'function runBackupSnapshotInWorker(');
  assert.ok(!decide.includes('backupStore.writeSnapshot('), 'the save path must not snapshot inline');
  assert.ok(decide.includes('if (currentHistoryJson == null) {') && decide.split('readFileSync(DB_PATH').length === 2,
    'the save path may read the history file only once, to seed the in-memory copy');
  assert.ok(mainJs.includes("new Worker(path.join(__dirname, 'lib', 'backup-worker.js')"),
    'backup snapshots run on a worker thread');
}

console.log('popup lifecycle tests passed');
