'use strict';

// Session preload for a QA sandbox: qa-sandbox-main.js adds it to every
// session, so it runs in every page (app windows, the website demo). Pages
// reach the OS clipboard through Chromium itself (navigator.clipboard,
// document.execCommand copy / cut / paste), past the main-process fake, so in
// the page's MAIN world those calls are stubbed: writes resolve without
// writing, reads return nothing. Each call logs one console line the guard
// records as a `clipboard_api_blocked` event.

const { webFrame } = require('electron');

const STUB = `(() => {
  if (window.__qaClipboardStub) return;
  window.__qaClipboardStub = true;
  const note = (api) => { try { console.debug('__qa_clipboard_blocked ' + api); } catch {} };
  const clip = navigator.clipboard;
  if (clip) {
    const fake = {
      writeText: () => Promise.resolve(),
      write: () => Promise.resolve(),
      readText: () => Promise.resolve(''),
      read: () => Promise.resolve([]),
    };
    for (const [name, fn] of Object.entries(fake)) {
      try { Object.defineProperty(clip, name, { configurable: true, value: function () { note(name); return fn(); } }); } catch {}
    }
  }
  const exec = Document.prototype.execCommand;
  Document.prototype.execCommand = function execCommand(command, ...rest) {
    if (/^(copy|cut|paste)$/i.test(String(command))) { note(String(command).toLowerCase()); return false; }
    return exec.call(this, command, ...rest);
  };
})();`;

webFrame.executeJavaScript(STUB).catch(() => {});
