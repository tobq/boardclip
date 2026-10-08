const { contextBridge, ipcRenderer } = require('electron');

// Bridge for the AI-action approval modal (mcp-approval.html). The main process
// pushes the request to render; the renderer sends back exactly one decision.
contextBridge.exposeInMainWorld('approval', {
  onRequest: (callback) => {
    ipcRenderer.on('approval-request', (_, request) => callback(request));
  },
  onSettings: (callback) => {
    ipcRenderer.on('approval-settings', (_, s) => callback(s));
  },
  // Appearance (accent, density, corners, theme mode, this window's surface):
  // one event whenever any of it changes - a setting, another device, the OS accent.
  onAppearanceChanged: (callback) => {
    const listener = (_, look) => callback(look || {});
    ipcRenderer.on('appearance-changed', listener);
    return () => ipcRenderer.removeListener('appearance-changed', listener);
  },
  decide: (id, choice) => ipcRenderer.send('approval-decide', id, choice),
  hold: (id, held, remainingSec) => ipcRenderer.send('approval-hold', id, held, remainingSec),
  resize: (height) => ipcRenderer.send('approval-resize', height),
});
