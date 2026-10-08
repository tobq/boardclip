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
  onFind: (callback) => {
    const listener = (_, find) => callback(find || {});
    ipcRenderer.on('editor-find', listener);
    return () => ipcRenderer.removeListener('editor-find', listener);
  },
  onConflict: (callback) => {
    const listener = (_, conflict) => callback(conflict || {});
    ipcRenderer.on('editor-conflict', listener);
    return () => ipcRenderer.removeListener('editor-conflict', listener);
  },
  draft: (payload) => ipcRenderer.send('editor-draft', sessionId, payload),
  // invoke (not send): the promise resolves AFTER the clip write, with the
  // session's current (content-addressed) id — the title-bar tag strip's
  // commit-on-add awaits it before opening the group picker.
  commit: (payload) => ipcRenderer.invoke('editor-commit', sessionId, payload),
  resolveConflict: (payload) => ipcRenderer.invoke('resolve-conflict', payload),
  unifyStep: (payload) => ipcRenderer.invoke('unify-step', sessionId, payload),
  close: () => ipcRenderer.send('editor-close', sessionId),
  // The find bar's mode + match case, remembered per device.
  saveFindPrefs: (prefs) => ipcRenderer.invoke('save-settings', { find_mode: prefs && prefs.mode === 'regex' ? 'regex' : 'basic', find_case: !!(prefs && prefs.caseSensitive) }),
  // The bar's height + resolved colours, for the native window controls.
  windowChrome: (chrome) => ipcRenderer.send('window-chrome', chrome),
  // Clipboard follow: while the clipboard holds this note, saves update it.
  focused: () => ipcRenderer.send('editor-focus', sessionId),
  copyToClipboard: (payload) => ipcRenderer.invoke('editor-copy', sessionId, payload),
  onClipboardState: (callback) => {
    const listener = (_, state) => callback(state || {});
    ipcRenderer.on('editor-clipboard', listener);
    return () => ipcRenderer.removeListener('editor-clipboard', listener);
  },
  // Clip menu (shared with the popup + viewer). The clip id changes on every
  // committed edit (content-addressed), so the menu asks for the CURRENT id.
  currentId: () => ipcRenderer.invoke('editor-current-id', sessionId),
  state: (id) => ipcRenderer.invoke('clip-window-state', id),
  pin: (id, rev) => ipcRenderer.invoke('pin', id, rev),
  groupCreate: (name) => ipcRenderer.invoke('group-create', name),
  groupAssign: (id, group, rev) => ipcRenderer.invoke('group-assign', id, group, rev),
  numpadAssign: (id, slot, rev) => ipcRenderer.invoke('numpad-assign', id, slot, rev),
  numpadUnassign: (slot) => ipcRenderer.invoke('numpad-unassign', slot),
  deleteSelf: (rev) => ipcRenderer.invoke('editor-delete-clip', sessionId, rev),
  getColorScheme: () => ipcRenderer.invoke('get-color-scheme'),
  onColorSchemeChanged: (callback) => {
    const listener = (_, scheme) => callback(scheme);
    ipcRenderer.on('color-scheme-changed', listener);
    return () => ipcRenderer.removeListener('color-scheme-changed', listener);
  },
  // Appearance (accent, density, corners, theme mode, this window's surface):
  // one event whenever any of it changes - a setting, another device, the OS accent.
  onAppearanceChanged: (callback) => {
    const listener = (_, look) => callback(look || {});
    ipcRenderer.on('appearance-changed', listener);
    return () => ipcRenderer.removeListener('appearance-changed', listener);
  },
});
