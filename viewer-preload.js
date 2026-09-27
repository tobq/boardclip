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
  pin: (id, rev) => ipcRenderer.invoke('pin', id, rev),
  groupCreate: (name) => ipcRenderer.invoke('group-create', name),
  groupAssign: (id, group, rev) => ipcRenderer.invoke('group-assign', id, group, rev),
  numpadAssign: (id, slot, rev) => ipcRenderer.invoke('numpad-assign', id, slot, rev),
  numpadUnassign: (slot) => ipcRenderer.invoke('numpad-unassign', slot),
  setClipTitle: (id, title, rev) => ipcRenderer.invoke('set-clip-title', id, title, rev),
  deleteItems: (targets) => ipcRenderer.invoke('delete-items', targets), // [{ id, rev }]
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
