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
  groupCreate: (name) => ipcRenderer.invoke('group-create', name),
  groupDelete: (name) => ipcRenderer.invoke('group-delete', name),
  groupAssign: (id, group) => ipcRenderer.invoke('group-assign', id, group),
  copyImagePath: (id) => ipcRenderer.invoke('copy-image-path', id),
  openEditor: (id) => ipcRenderer.invoke('open-editor', id),
  openImage: (id) => ipcRenderer.invoke('open-image', id),
  platform: process.platform,
  setSyncPath: (path) => ipcRenderer.invoke('set-sync-path', path),
  getCloudAccounts: () => ipcRenderer.invoke('get-cloud-accounts'),
  syncNow: () => ipcRenderer.invoke('sync-now'),
  getAutoLaunch: () => ipcRenderer.invoke('get-auto-launch'),
  setAutoLaunch: (enabled) => ipcRenderer.invoke('set-auto-launch', enabled),
});
