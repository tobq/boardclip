const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
  getHistory: () => ipcRenderer.invoke('get-history'),
  getHistoryState: (knownRevision) => ipcRenderer.invoke('get-history-state', knownRevision),
  onHistoryChanged: (callback) => {
    const listener = (_, revision) => callback(revision);
    ipcRenderer.on('history-changed', listener);
    return () => ipcRenderer.removeListener('history-changed', listener);
  },
  getSettings: () => ipcRenderer.invoke('get-settings'),
  paste: (id) => ipcRenderer.invoke('paste', id),
  pasteAndHide: (id) => ipcRenderer.invoke('paste-and-hide', id),
  numpadPasteAndHide: (slot) => ipcRenderer.invoke('numpad-paste-and-hide', slot),
  hidePopup: () => ipcRenderer.invoke('hide-popup'),
  copy: (text) => ipcRenderer.invoke('copy', text),
  deleteItem: (id, rev) => ipcRenderer.invoke('delete-item', id, rev),
  deleteItems: (targets) => ipcRenderer.invoke('delete-items', targets), // [{ id, rev }]
  restoreItems: (snaps) => ipcRenderer.invoke('restore-items', snaps),
  groupAssignMany: (targets, group, shouldHave) => ipcRenderer.invoke('group-assign-many', targets, group, shouldHave), // [{ id, rev }]
  pasteMany: (ids) => ipcRenderer.invoke('paste-many', ids),
  startUnify: (ids) => ipcRenderer.invoke('start-unify', ids),
  deleteAll: () => ipcRenderer.invoke('delete-all'),
  pin: (id, rev) => ipcRenderer.invoke('pin', id, rev),
  numpadAssign: (id, slot, rev) => ipcRenderer.invoke('numpad-assign', id, slot, rev),
  numpadUnassign: (slot) => ipcRenderer.invoke('numpad-unassign', slot),
  saveSettings: (settings) => ipcRenderer.invoke('save-settings', settings),
  setShowShortcut: (shortcut) => ipcRenderer.invoke('set-show-shortcut', shortcut),
  setQuickPasteShortcut: (shortcut) => ipcRenderer.invoke('set-quick-paste-shortcut', shortcut),
  suspendShortcuts: () => ipcRenderer.invoke('suspend-shortcuts'),
  resumeShortcuts: () => ipcRenderer.invoke('resume-shortcuts'),
  resolveShowShortcut: (shortcut) => ipcRenderer.invoke('resolve-show-shortcut', shortcut),
  groupCreate: (name) => ipcRenderer.invoke('group-create', name),
  groupDelete: (name) => ipcRenderer.invoke('group-delete', name),
  groupAssign: (id, group, rev) => ipcRenderer.invoke('group-assign', id, group, rev),
  copyImagePath: (id) => ipcRenderer.invoke('copy-image-path', id),
  openEditor: (id, options) => ipcRenderer.invoke('open-editor', id, options || {}),
  newNote: (options) => ipcRenderer.invoke('new-note', options || {}),
  getConflicts: () => ipcRenderer.invoke('get-conflicts'),
  openConflict: (id) => ipcRenderer.invoke('open-conflict', id),
  openImage: (id, options) => ipcRenderer.invoke('open-image', id, options || {}),
  // Native file drag of image clips (send, not invoke: main must call
  // startDrag while the renderer's drag gesture is still live).
  startDrag: (ids) => ipcRenderer.send('start-drag', ids),
  // Ctrl/Cmd+= / - / 0, claimed by main before the app menu (macOS key
  // equivalents would otherwise zoom the whole page): 'in' | 'out' | 'reset'.
  onImageZoomKey: (callback) => {
    const listener = (_, act) => callback(act);
    ipcRenderer.on('image-zoom-key', listener);
    return () => ipcRenderer.removeListener('image-zoom-key', listener);
  },
  openImageExternal: (id) => ipcRenderer.invoke('open-image-external', id),
  platform: process.platform,
  setSyncPath: (path) => ipcRenderer.invoke('set-sync-path', path),
  chooseSyncFolder: () => ipcRenderer.invoke('choose-sync-folder'),
  setSyncPathEnabled: (path, enabled) => ipcRenderer.invoke('set-sync-path-enabled', path, enabled),
  getCloudAccounts: () => ipcRenderer.invoke('get-cloud-accounts'),
  setP2PEnabled: (enabled) => ipcRenderer.invoke('set-p2p-enabled', enabled),
  getP2PStatus: () => ipcRenderer.invoke('get-p2p-status'),
  getSyncDiagnostics: () => ipcRenderer.invoke('get-sync-diagnostics'),
  recordDiagnostics: (event, details) => ipcRenderer.invoke('record-diagnostics', event, details),
  syncNow: () => ipcRenderer.invoke('sync-now'),
  onSyncProgress: (callback) => {
    const listener = (_, payload) => callback(payload);
    ipcRenderer.on('sync-progress', listener);
    return () => ipcRenderer.removeListener('sync-progress', listener);
  },
  checkForUpdates: () => ipcRenderer.invoke('check-for-updates'),
  setUpdateMode: (mode) => ipcRenderer.invoke('set-update-mode', mode),
  getAutoLaunch: () => ipcRenderer.invoke('get-auto-launch'),
  setAutoLaunch: (enabled) => ipcRenderer.invoke('set-auto-launch', enabled),
  getColorScheme: () => ipcRenderer.invoke('get-color-scheme'),
  onColorSchemeChanged: (callback) => {
    const listener = (_, scheme) => callback(scheme);
    ipcRenderer.on('color-scheme-changed', listener);
    return () => ipcRenderer.removeListener('color-scheme-changed', listener);
  },
  onSurfaceChanged: (callback) => {
    const listener = (_, style) => callback(style);
    ipcRenderer.on('surface-changed', listener);
    return () => ipcRenderer.removeListener('surface-changed', listener);
  },
  // AI Access (MCP)
  getAiAccess: () => ipcRenderer.invoke('get-ai-access'),
  setAiAccessEnabled: (enabled) => ipcRenderer.invoke('set-ai-access-enabled', enabled),
  setMcpClientEnabled: (id, enabled) => ipcRenderer.invoke('set-mcp-client-enabled', id, enabled),
  setGroupSharedAi: (name, shared) => ipcRenderer.invoke('set-group-shared-ai', name, shared),
  revokeAiAlwaysAllow: (tool) => ipcRenderer.invoke('revoke-ai-always-allow', tool),
  setClipTitle: (id, title, rev) => ipcRenderer.invoke('set-clip-title', id, title, rev),
  setAiApprovalTimeout: (sec) => ipcRenderer.invoke('set-ai-approval-timeout', sec),
  onAiAccessChanged: (callback) => {
    const listener = () => callback();
    ipcRenderer.on('ai-access-changed', listener);
    return () => ipcRenderer.removeListener('ai-access-changed', listener);
  },
});
