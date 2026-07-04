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
  decide: (id, choice) => ipcRenderer.send('approval-decide', id, choice),
  resize: (height) => ipcRenderer.send('approval-resize', height),
});
