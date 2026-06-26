const { contextBridge, ipcRenderer } = require('electron');

// Bridge for the built-in editor window (editor.html). Main pushes the initial
// text via 'editor-init'; the renderer streams drafts (every keystroke, for
// crash-safety) and commits (idle/save/close, to write the clip), keyed by the
// session id main assigned at open.
let sessionId = null;

contextBridge.exposeInMainWorld('editorApi', {
  onInit: (callback) => {
    ipcRenderer.on('editor-init', (_, init) => {
      sessionId = init && init.sessionId;
      callback(init || {});
    });
  },
  draft: (text) => ipcRenderer.send('editor-draft', sessionId, text),
  commit: (text) => ipcRenderer.send('editor-commit', sessionId, text),
  close: () => ipcRenderer.send('editor-close', sessionId),
  getColorScheme: () => ipcRenderer.invoke('get-color-scheme'),
  onColorSchemeChanged: (callback) => {
    const listener = (_, scheme) => callback(scheme);
    ipcRenderer.on('color-scheme-changed', listener);
    return () => ipcRenderer.removeListener('color-scheme-changed', listener);
  },
});
