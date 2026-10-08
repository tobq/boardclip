'use strict';

// Windows only: PARK a window instead of hiding it. A parked window is cloaked
// (DWMWA_CLOAK): it stays "shown" to Windows and Chromium - so its content stays
// painted - but is not drawn, is not hit-tested (clicks go to the windows
// beneath) and is not in Alt-Tab. It also gets WS_EX_NOACTIVATE while parked,
// so Windows never hands it the focus when the foreground window closes or
// minimizes (keystrokes would vanish into an invisible window). Unparking clears
// both, and the window appears complete in ONE frame.
//
// Why (measured 2026-10-07 with a ~100 fps screen recording of the open): every
// ShowWindow of the acrylic popup drew the glass backdrop at full size at once
// while Windows scaled + faded the web CONTENT in ~130-200 ms later - the "opens
// twice" rim the owner kept seeing. Neither DWMWA_TRANSITIONS_FORCEDISABLED nor
// switching acrylic to mica changed it.
//
// Also here: the layered-window alpha a SOLID popup fades in with
// (setWindowAlpha, then clearLayered) - see setWindowAlpha below.

const DWMWA_CLOAK = 13;
const GWL_EXSTYLE = -20;
const WS_EX_NOACTIVATE = 0x08000000;
const WS_EX_LAYERED = 0x00080000;
const LWA_ALPHA = 0x2;
const RDW_INVALIDATE = 0x1;
const RDW_ERASE = 0x4;
const RDW_ALLCHILDREN = 0x80;
const RDW_FRAME = 0x400;
// Predefined HKEYs are sign-extended LONGs: 64-bit needs the full pointer value.
const HKEY_CURRENT_USER = process.arch === 'x64' || process.arch === 'arm64' ? 0xFFFFFFFF80000001n : 0x80000001;
const RRF_RT_REG_DWORD = 0x10;
let api = null;

function loadNative() {
  const koffi = require('koffi');
  const dwmapi = koffi.load('dwmapi.dll');
  const user32 = koffi.load('user32.dll');
  // 64-bit user32 has the *Ptr variants; 32-bit only exports the plain ones.
  let getLong;
  let setLong;
  try {
    getLong = user32.func('intptr_t __stdcall GetWindowLongPtrW(uintptr_t hwnd, int index)');
    setLong = user32.func('intptr_t __stdcall SetWindowLongPtrW(uintptr_t hwnd, int index, intptr_t value)');
  } catch {
    getLong = user32.func('long __stdcall GetWindowLongW(uintptr_t hwnd, int index)');
    setLong = user32.func('long __stdcall SetWindowLongW(uintptr_t hwnd, int index, long value)');
  }
  const setLayered = user32.func('int __stdcall SetLayeredWindowAttributes(uintptr_t hwnd, uint32 key, uint8 alpha, uint32 flags)');
  const getLayered = user32.func('int __stdcall GetLayeredWindowAttributes(uintptr_t hwnd, _Out_ uint32 *key, _Out_ uint8 *alpha, _Out_ uint32 *flags)');
  const redraw = user32.func('int __stdcall RedrawWindow(uintptr_t hwnd, void *rect, void *region, uint32 flags)');
  const regGetValue = koffi.load('advapi32.dll').func('int32 __stdcall RegGetValueW(uintptr_t hkey, str16 subKey, str16 value, uint32 flags, void *type, _Out_ uint32 *data, _Inout_ uint32 *size)');
  return {
    setAttribute: dwmapi.func('int32 __stdcall DwmSetWindowAttribute(uintptr_t hwnd, uint32 attr, void *value, uint32 size)'),
    getExStyle: (hwnd) => Number(getLong(hwnd, GWL_EXSTYLE)),
    setExStyle: (hwnd, style) => setLong(hwnd, GWL_EXSTYLE, style),
    setLayeredAlpha: (hwnd, alpha) => setLayered(hwnd, 0, alpha, LWA_ALPHA) !== 0,
    getLayeredAlpha: (hwnd) => {
      const key = [0];
      const alpha = [0];
      const flags = [0];
      if (!getLayered(hwnd, key, alpha, flags)) return null;
      return (flags[0] & LWA_ALPHA) ? alpha[0] : 255;
    },
    redraw: (hwnd) => redraw(hwnd, null, null, RDW_ERASE | RDW_INVALIDATE | RDW_FRAME | RDW_ALLCHILDREN) !== 0,
    // HKCU DWORD value, or null when it is missing.
    readDword: (key, name) => {
      const data = [0];
      const size = [4];
      return regGetValue(HKEY_CURRENT_USER, key, name, RRF_RT_REG_DWORD, null, data, size) === 0 ? data[0] >>> 0 : null;
    },
  };
}

// Electron's getNativeWindowHandle() is a Buffer holding the HWND value.
function hwndFromHandle(buf) {
  if (!buf || !buf.length) return 0n;
  return buf.length >= 8 ? buf.readBigUInt64LE(0) : BigInt(buf.readUInt32LE(0));
}

// -> { ok, hr?, noActivate?, reason? }. `ok` is the cloak result (the part that
// matters); the focus guard is best effort. Never throws: a caller that gets
// !ok falls back to an ordinary hide/show.
function setParked(win, parked, { platform = process.platform, native = null } = {}) {
  if (platform !== 'win32') return { ok: false, reason: 'not-win32' };
  if (!win || (typeof win.isDestroyed === 'function' && win.isDestroyed())) return { ok: false, reason: 'no-window' };
  try {
    const n = native || api || (api = loadNative());
    const hwnd = hwndFromHandle(win.getNativeWindowHandle());
    let noActivate = false;
    try {
      const style = n.getExStyle(hwnd);
      n.setExStyle(hwnd, parked ? (style | WS_EX_NOACTIVATE) : (style & ~WS_EX_NOACTIVATE));
      noActivate = true;
    } catch {}
    const value = Buffer.alloc(4);
    value.writeInt32LE(parked ? 1 : 0, 0);
    const hr = n.setAttribute(hwnd, DWMWA_CLOAK, value, 4);
    return { ok: hr === 0, hr, noActivate };
  } catch (error) {
    return { ok: false, reason: error && error.message };
  }
}

// The open fade of a SOLID window (plan I): a constant window alpha through
// WS_EX_LAYERED, done here rather than with BrowserWindow.setOpacity, which
// sets the style once and records it as set for good - after clearLayered()
// its next setOpacity would quietly do nothing. Electron never learns of the
// style, so its own opacity stays 1. Never on glass: a layered window drops
// the acrylic (recorded frame by frame 2026-10-07).
// -> { ok, alpha?, reason? }; alpha 0..1. Never throws.
function setWindowAlpha(win, alpha, { platform = process.platform, native = null } = {}) {
  if (platform !== 'win32') return { ok: false, reason: 'not-win32' };
  if (!win || (typeof win.isDestroyed === 'function' && win.isDestroyed())) return { ok: false, reason: 'no-window' };
  try {
    const n = native || api || (api = loadNative());
    const hwnd = hwndFromHandle(win.getNativeWindowHandle());
    const byte = Math.max(0, Math.min(255, Math.round((Number(alpha) || 0) * 255)));
    const style = n.getExStyle(hwnd);
    if (!(style & WS_EX_LAYERED)) n.setExStyle(hwnd, style | WS_EX_LAYERED);
    return { ok: !!n.setLayeredAlpha(hwnd, byte), alpha: byte };
  } catch (error) {
    return { ok: false, reason: error && error.message };
  }
}

// Ends a fade: drops WS_EX_LAYERED (the alpha goes with it, the window is a
// normal opaque window again) and invalidates it, the documented way out of
// layering. -> { ok, wasLayered?, reason? }. Never throws.
function clearLayered(win, { platform = process.platform, native = null } = {}) {
  if (platform !== 'win32') return { ok: false, reason: 'not-win32' };
  if (!win || (typeof win.isDestroyed === 'function' && win.isDestroyed())) return { ok: false, reason: 'no-window' };
  try {
    const n = native || api || (api = loadNative());
    const hwnd = hwndFromHandle(win.getNativeWindowHandle());
    const style = n.getExStyle(hwnd);
    if (!(style & WS_EX_LAYERED)) return { ok: true, wasLayered: false };
    n.setExStyle(hwnd, style & ~WS_EX_LAYERED);
    n.redraw(hwnd);
    return { ok: !(n.getExStyle(hwnd) & WS_EX_LAYERED), wasLayered: true };
  } catch (error) {
    return { ok: false, reason: error && error.message };
  }
}

// -> { layered, alpha (0-255; 255 when not layered) } or null. For QA checks.
function layeredState(win, { platform = process.platform, native = null } = {}) {
  if (platform !== 'win32' || !win || (typeof win.isDestroyed === 'function' && win.isDestroyed())) return null;
  try {
    const n = native || api || (api = loadNative());
    const hwnd = hwndFromHandle(win.getNativeWindowHandle());
    const layered = !!(n.getExStyle(hwnd) & WS_EX_LAYERED);
    return { layered, alpha: layered ? n.getLayeredAlpha(hwnd) : 255 };
  } catch {
    return null;
  }
}

// The Windows accent colour as Settings > Personalization > Colors shows it.
// Electron's systemPreferences.getAccentColor() returns DwmGetColorizationColor,
// a BLENDED title-bar colorization (measured 2026-10-08: 0xe3006fc4 for the
// 0078d4 accent the Settings palette shows), so the value Settings writes is
// read instead. The DWORDs are 0xAABBGGRR. -> '#rrggbb' | null. Never throws.
const ACCENT_VALUES = [
  ['Software\\Microsoft\\Windows\\DWM', 'AccentColor'],
  ['Software\\Microsoft\\Windows\\CurrentVersion\\Explorer\\Accent', 'AccentColorMenu'],
];
function abgrToHex(dword) {
  const n = Number(dword) >>> 0;
  return `#${[n & 0xff, (n >>> 8) & 0xff, (n >>> 16) & 0xff].map((c) => c.toString(16).padStart(2, '0')).join('')}`;
}
function readAccentColor({ platform = process.platform, native = null } = {}) {
  if (platform !== 'win32') return null;
  try {
    const n = native || api || (api = loadNative());
    for (const [key, name] of ACCENT_VALUES) {
      const dword = n.readDword(key, name);
      if (dword != null) return abgrToHex(dword);
    }
  } catch {}
  return null;
}

module.exports = { setParked, setWindowAlpha, clearLayered, layeredState, readAccentColor, abgrToHex, hwndFromHandle, DWMWA_CLOAK, WS_EX_NOACTIVATE, WS_EX_LAYERED };
