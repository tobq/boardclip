'use strict';

// Windows only: switch OFF the DWM show/hide transition for one window.
// Windows 11 animates a window in (scale up from ~95% + fade). On the frameless
// acrylic popup the system backdrop is drawn at full size at once while the web
// content scales in, so every open showed a flickering rim around the edge
// (owner, 2026-10-07: "like the webview is expanding to fill"). A popup should
// just appear, the way Windows' own Win+V clipboard does.
// DWMWA_TRANSITIONS_FORCEDISABLED is the documented per-window switch.

const DWMWA_TRANSITIONS_FORCEDISABLED = 3;
let api = null;

function loadNative() {
  const koffi = require('koffi');
  const dwmapi = koffi.load('dwmapi.dll');
  return {
    setAttribute: dwmapi.func('int32 __stdcall DwmSetWindowAttribute(uintptr_t hwnd, uint32 attr, void *value, uint32 size)'),
  };
}

// Electron's getNativeWindowHandle() is a Buffer holding the HWND value.
function hwndFromHandle(buf) {
  if (!buf || !buf.length) return 0n;
  return buf.length >= 8 ? buf.readBigUInt64LE(0) : BigInt(buf.readUInt32LE(0));
}

// -> { ok, hr?, reason? }. Never throws: an animation is cosmetic.
function disableWindowTransitions(win, { platform = process.platform, native = null } = {}) {
  if (platform !== 'win32') return { ok: false, reason: 'not-win32' };
  if (!win || (typeof win.isDestroyed === 'function' && win.isDestroyed())) return { ok: false, reason: 'no-window' };
  try {
    const n = native || api || (api = loadNative());
    const value = Buffer.alloc(4);
    value.writeInt32LE(1, 0);
    const hr = n.setAttribute(hwndFromHandle(win.getNativeWindowHandle()), DWMWA_TRANSITIONS_FORCEDISABLED, value, 4);
    return { ok: hr === 0, hr };
  } catch (error) {
    return { ok: false, reason: error && error.message };
  }
}

module.exports = { disableWindowTransitions, hwndFromHandle, DWMWA_TRANSITIONS_FORCEDISABLED };
