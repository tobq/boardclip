'use strict';
// Fast Windows paste primitives via koffi FFI.
//
// Replaces the previous `cscript` + VBScript SendKeys approach which had two
// problems:
//   1. Spawning cscript per paste costs 200-500ms (cold start). That was the
//      "delay" users noticed vs. the pre-Electron Python version which used
//      direct Win32 calls via ctypes.
//   2. VBScript `WshShell.SendKeys "^v"` has a documented Win32 quirk where
//      it can flip NumLock state on some systems, triggering OEM keyboard
//      software notifications (e.g. Logitech "NumLock ON" overlay).
//
// Uses SendInput (the modern Win32 API recommended for new code — see
// https://learn.microsoft.com/en-us/windows/win32/api/winuser/nf-winuser-sendinput).
// Benefits over the older keybd_event:
//   - Events are atomic: other input from the user or from other processes
//     cannot be interleaved between our Ctrl down / V down / V up / Ctrl up.
//   - Microsoft explicitly flags keybd_event as superseded for new dev.
//
// The INPUT struct uses a tagged union in C. We target x64 (the only arch
// Electron ships by default on Windows) and use a flat struct with explicit
// padding that matches the x64 memory layout (40 bytes total).

if (process.platform !== 'win32') {
  module.exports = {
    sendCtrlV() {},
    typeText() { return { ok: false, chars: 0, events: 0 }; },
    getForegroundWindow() { return null; },
    getForegroundWindowAddress() { return '0'; },
    setForegroundWindow() {},
    isMouseButtonDown() { return false; },
  };
  return;
}

const koffi = require('koffi');
const user32 = koffi.load('user32.dll');

// x64 INPUT struct layout (40 bytes):
//   offset 0:  type      (DWORD, 4)
//   offset 4:  padding   (4)      — union aligns to 8 (ULONG_PTR alignment)
//   offset 8:  wVk       (WORD, 2)
//   offset 10: wScan     (WORD, 2)
//   offset 12: dwFlags   (DWORD, 4)
//   offset 16: time      (DWORD, 4)
//   offset 20: padding   (4)      — align dwExtraInfo to 8
//   offset 24: dwExtraInfo (ULONG_PTR, 8)
//   offset 32: padding   (8)      — pad to 40, matching MOUSEINPUT's size
const INPUT = koffi.struct('INPUT', {
  type: 'uint32',
  _pad0: 'uint32',
  wVk: 'uint16',
  wScan: 'uint16',
  dwFlags: 'uint32',
  time: 'uint32',
  _pad1: 'uint32',
  dwExtraInfo: 'uintptr_t',
  _pad2: koffi.array('uint8', 8),
});

const INPUT_KEYBOARD = 1;
const VK_CONTROL = 0x11;
const VK_V = 0x56;
const VK_RETURN = 0x0D;
const VK_TAB = 0x09;
const VK_LBUTTON = 0x01;
const VK_RBUTTON = 0x02;
const KEYEVENTF_KEYUP = 0x0002;
const KEYEVENTF_UNICODE = 0x0004;

const SendInput = user32.func(
  'uint32 __stdcall SendInput(uint32 cInputs, INPUT *pInputs, int cbSize)'
);
const GetForegroundWindow = user32.func(
  'void * __stdcall GetForegroundWindow()'
);
const SetForegroundWindow = user32.func(
  'int __stdcall SetForegroundWindow(void *hWnd)'
);
const GetAsyncKeyState = user32.func(
  'int16 __stdcall GetAsyncKeyState(int vKey)'
);

const INPUT_SIZE = koffi.sizeof(INPUT);

function keyInput(vk, keyup) {
  return {
    type: INPUT_KEYBOARD,
    _pad0: 0,
    wVk: vk,
    wScan: 0,
    dwFlags: keyup ? KEYEVENTF_KEYUP : 0,
    time: 0,
    _pad1: 0,
    dwExtraInfo: 0,
    _pad2: [0, 0, 0, 0, 0, 0, 0, 0],
  };
}

function sendCtrlV() {
  // Four events delivered atomically: Ctrl down, V down, V up, Ctrl up.
  SendInput(4, [
    keyInput(VK_CONTROL, false),
    keyInput(VK_V, false),
    keyInput(VK_V, true),
    keyInput(VK_CONTROL, true),
  ], INPUT_SIZE);
}

// A single Unicode character injected via KEYEVENTF_UNICODE — inserts the exact
// codepoint as text, with no virtual-key mapping, so it is immune to keyboard
// layout AND to Tab/Enter "action" semantics (a literal tab/space is inserted,
// not a focus change). wVk MUST be 0 for unicode injection.
function unicodeInput(codeUnit, keyup) {
  return {
    type: INPUT_KEYBOARD,
    _pad0: 0,
    wVk: 0,
    wScan: codeUnit,
    dwFlags: KEYEVENTF_UNICODE | (keyup ? KEYEVENTF_KEYUP : 0),
    time: 0,
    _pad1: 0,
    dwExtraInfo: 0,
    _pad2: [0, 0, 0, 0, 0, 0, 0, 0],
  };
}

// Type text by synthesizing key events — bypassing the clipboard entirely, so
// there is no backup/restore race and the user's clipboard is never touched.
// The whole string is delivered in as few SendInput batches as possible (NOT
// one key at a time with delays), so it is effectively instant.
//
// Newlines are sent as a real VK_RETURN keypress (KEYEVENTF_UNICODE '\n' does
// not produce a newline in most apps). Everything else — including tab — goes
// through Unicode injection so a snippet's exact characters are inserted without
// triggering Tab-key focus behavior. Returns {ok, chars, events}.
function typeText(text) {
  const str = String(text == null ? '' : text);
  if (!str) return { ok: true, chars: 0, events: 0 };
  const events = [];
  for (let i = 0; i < str.length; i++) {
    const code = str.charCodeAt(i);
    if (code === 0x0d) continue;               // swallow CR; LF drives the newline
    if (code === 0x0a) {                        // LF -> real Enter keypress
      events.push(keyInput(VK_RETURN, false));
      events.push(keyInput(VK_RETURN, true));
      continue;
    }
    events.push(unicodeInput(code, false));
    events.push(unicodeInput(code, true));
  }
  if (!events.length) return { ok: true, chars: str.length, events: 0 };
  // Chunk so a single very large array can't overflow the input pipeline; each
  // SendInput call is atomic and there is no inter-key delay, so this stays fast.
  const CHUNK = 400;
  let sent = 0;
  for (let i = 0; i < events.length; i += CHUNK) {
    const batch = events.slice(i, i + CHUNK);
    sent += SendInput(batch.length, batch, INPUT_SIZE);
  }
  return { ok: sent === events.length, chars: str.length, events: events.length, sent };
}

function getForegroundWindow() {
  return GetForegroundWindow();
}

// Numeric address of the current foreground window, as a string (HWNDs can
// exceed Number range on x64). Used by tests to confirm the intended window is
// focused before injecting keystrokes, so injection can't leak into another app.
function getForegroundWindowAddress() {
  try { return String(koffi.address(GetForegroundWindow())); } catch { return '0'; }
}

function setForegroundWindow(hwnd) {
  if (!hwnd) return;
  SetForegroundWindow(hwnd);
}

function isMouseButtonDown() {
  return !!((GetAsyncKeyState(VK_LBUTTON) | GetAsyncKeyState(VK_RBUTTON)) & 0x8000);
}

module.exports = { sendCtrlV, typeText, getForegroundWindow, getForegroundWindowAddress, setForegroundWindow, isMouseButtonDown };
