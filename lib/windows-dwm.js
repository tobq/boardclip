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

const DWMWA_CLOAK = 13;
const GWL_EXSTYLE = -20;
const WS_EX_NOACTIVATE = 0x08000000;
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
  return {
    setAttribute: dwmapi.func('int32 __stdcall DwmSetWindowAttribute(uintptr_t hwnd, uint32 attr, void *value, uint32 size)'),
    getExStyle: (hwnd) => Number(getLong(hwnd, GWL_EXSTYLE)),
    setExStyle: (hwnd, style) => setLong(hwnd, GWL_EXSTYLE, style),
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

module.exports = { setParked, hwndFromHandle, DWMWA_CLOAK, WS_EX_NOACTIVATE };
