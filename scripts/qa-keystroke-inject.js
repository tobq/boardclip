'use strict';
// Real-Electron end-to-end check of keystroke injection (lib/keystroke-inject).
// Opens a focused, always-on-top window with a textarea, waits until OUR window
// is genuinely the OS foreground window (so injected keys cannot leak into
// another app), injects text via the native path (SendInput / CGEvent — NOT the
// clipboard), then reads the textarea back and asserts it matches, including
// Unicode, a surrogate-pair emoji, and a newline. Also asserts the clipboard is
// untouched. Requires a real desktop session.
// Run: node_modules/electron/dist/electron.exe scripts/qa-keystroke-inject.js

const { app, BrowserWindow, clipboard } = require('electron');
const keystrokeInject = require('../lib/keystroke-inject');
const winPaste = require('../lib/windows-paste');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const EXPECT = 'Hello \u20ac\u00f1 \u4f60\u597d\nLine2 \ud83d\ude00 end';

function ourHwndAddress(win) {
  if (process.platform !== 'win32') return null;
  try { return String(win.getNativeWindowHandle().readBigUInt64LE(0)); } catch { return null; }
}

async function waitForForeground(win, timeoutMs) {
  if (process.platform !== 'win32') { await sleep(600); return true; }
  const ours = ourHwndAddress(win);
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    win.setAlwaysOnTop(true, 'screen-saver');
    win.show(); win.focus(); win.moveTop();
    if (winPaste.getForegroundWindowAddress() === ours) return true;
    await sleep(150);
  }
  return winPaste.getForegroundWindowAddress() === ours;
}

app.whenReady().then(async () => {
  if (!keystrokeInject.isSupported()) { console.log('injection unsupported — SKIP'); app.exit(0); return; }
  const clipboardBefore = 'SENTINEL-' + Date.now();
  clipboard.writeText(clipboardBefore);

  const win = new BrowserWindow({ width: 520, height: 300, show: true, alwaysOnTop: true });
  await win.loadURL('data:text/html,' + encodeURIComponent(
    '<!doctype html><meta charset="utf-8"><body style="margin:0">' +
    '<textarea id="t" style="width:100%;height:100%;font-size:16px"></textarea>' +
    '<script>const t=document.getElementById("t");t.focus();window.__f=()=>t.focus();</script>'
  ));

  const foreground = await waitForForeground(win, 4000);
  if (!foreground) {
    console.log('could not bring test window to foreground — SKIP (cannot verify safely)');
    app.exit(0);
    return;
  }
  await win.webContents.executeJavaScript('window.__f && window.__f()');
  await sleep(250);

  const res = keystrokeInject.typeText(EXPECT);
  await sleep(800); // let all injected events drain into the textarea

  const got = await win.webContents.executeJavaScript('document.getElementById("t").value');
  const clipboardAfter = clipboard.readText();

  const textOk = got === EXPECT;
  const clipboardOk = clipboardAfter === clipboardBefore;
  console.log('inject result       :', JSON.stringify(res));
  console.log('expected            :', JSON.stringify(EXPECT));
  console.log('got                 :', JSON.stringify(got));
  console.log('text match          :', textOk ? 'PASS' : 'FAIL');
  console.log('clipboard untouched :', clipboardOk ? 'PASS' : `FAIL (${JSON.stringify(clipboardAfter)})`);
  app.exit(textOk && clipboardOk ? 0 : 1);
});
