const { contextBridge, ipcRenderer } = require('electron');

// Bridge for the in-app image viewer window (viewer.html). Main pushes the
// image + theme via 'viewer-init'; the clip menu reuses the SAME mutation IPC
// channels the popup uses (pin/group-assign/numpad-assign/...), so the two
// surfaces cannot drift.
let clipId = null;

contextBridge.exposeInMainWorld('viewerApi', {
  onInit: (callback) => {
    ipcRenderer.on('viewer-init', (_, init) => {
      clipId = init && init.id;
      callback(init || {});
    });
  },
  // Light snapshot (items/groups/numpad map) for the shared clip menu.
  state: () => ipcRenderer.invoke('clip-window-state', clipId),
  pin: (id) => ipcRenderer.invoke('pin', id),
  groupCreate: (name) => ipcRenderer.invoke('group-create', name),
  groupAssign: (id, group) => ipcRenderer.invoke('group-assign', id, group),
  numpadAssign: (id, slot) => ipcRenderer.invoke('numpad-assign', id, slot),
  numpadUnassign: (slot) => ipcRenderer.invoke('numpad-unassign', slot),
  setClipTitle: (id, title) => ipcRenderer.invoke('set-clip-title', id, title),
  deleteItems: (ids) => ipcRenderer.invoke('delete-items', ids),
  copyImagePath: (id) => ipcRenderer.invoke('copy-image-path', id),
  openImageExternal: (id) => ipcRenderer.invoke('open-image-external', id),
  close: () => ipcRenderer.send('viewer-close'),
  getColorScheme: () => ipcRenderer.invoke('get-color-scheme'),
  onColorSchemeChanged: (callback) => {
    const listener = (_, scheme) => callback(scheme);
    ipcRenderer.on('color-scheme-changed', listener);
    return () => ipcRenderer.removeListener('color-scheme-changed', listener);
  },
});
