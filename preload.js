const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
  getHistory: () => ipcRenderer.invoke('get-history'),
  getHistoryState: () => ipcRenderer.invoke('get-history-state'),
  onHistoryChanged: (callback) => {
    const listener = (_, revision) => callback(revision);
    ipcRenderer.on('history-changed', listener);
    return () => ipcRenderer.removeListener('history-changed', listener);
  },
  getSettings: () => ipcRenderer.invoke('get-settings'),
  paste: (id) => ipcRenderer.invoke('paste', id),
  pasteAndHide: (id) => ipcRenderer.invoke('paste-and-hide', id),
  hidePopup: () => ipcRenderer.invoke('hide-popup'),
  copy: (text) => ipcRenderer.invoke('copy', text),
  deleteItem: (id) => ipcRenderer.invoke('delete-item', id),
  deleteAll: () => ipcRenderer.invoke('delete-all'),
  pin: (id) => ipcRenderer.invoke('pin', id),
  numpadAssign: (id, slot) => ipcRenderer.invoke('numpad-assign', id, slot),
  numpadUnassign: (slot) => ipcRenderer.invoke('numpad-unassign', slot),
  saveSettings: (settings) => ipcRenderer.invoke('save-settings', settings),
  setShowShortcut: (shortcut) => ipcRenderer.invoke('set-show-shortcut', shortcut),
  resolveShowShortcut: (shortcut) => ipcRenderer.invoke('resolve-show-shortcut', shortcut),
  groupCreate: (name) => ipcRenderer.invoke('group-create', name),
  groupDelete: (name) => ipcRenderer.invoke('group-delete', name),
  groupAssign: (id, group) => ipcRenderer.invoke('group-assign', id, group),
  copyImagePath: (id) => ipcRenderer.invoke('copy-image-path', id),
  openEditor: (id) => ipcRenderer.invoke('open-editor', id),
  openImage: (id) => ipcRenderer.invoke('open-image', id),
  platform: process.platform,
  setSyncPath: (path) => ipcRenderer.invoke('set-sync-path', path),
  setSyncPathEnabled: (path, enabled) => ipcRenderer.invoke('set-sync-path-enabled', path, enabled),
  getCloudAccounts: () => ipcRenderer.invoke('get-cloud-accounts'),
  getSyncDiagnostics: () => ipcRenderer.invoke('get-sync-diagnostics'),
  syncNow: () => ipcRenderer.invoke('sync-now'),
  getAutoLaunch: () => ipcRenderer.invoke('get-auto-launch'),
  setAutoLaunch: (enabled) => ipcRenderer.invoke('set-auto-launch', enabled),
  getColorScheme: () => ipcRenderer.invoke('get-color-scheme'),
  onColorSchemeChanged: (callback) => {
    const listener = (_, scheme) => callback(scheme);
    ipcRenderer.on('color-scheme-changed', listener);
    return () => ipcRenderer.removeListener('color-scheme-changed', listener);
  },
});
