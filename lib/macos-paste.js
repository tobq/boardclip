'use strict';

if (process.platform !== 'darwin') {
  module.exports = {
    sendCommandV() { return { ok: true }; },
    typeText() { return { ok: false, chars: 0 }; },
  };
  return;
}

const koffi = require('koffi');

let coreGraphics = null;
let coreFoundation = null;

const KEY_V = 0x09;
const KEY_COMMAND = 0x37;
const kCGHIDEventTap = 0;
const kCGEventFlagMaskCommand = 1 << 20;

function loadFrameworks() {
  if (coreGraphics) return;
  coreGraphics = koffi.load('/System/Library/Frameworks/CoreGraphics.framework/CoreGraphics');
  coreFoundation = koffi.load('/System/Library/Frameworks/CoreFoundation.framework/CoreFoundation');

  coreGraphics.CGEventCreateKeyboardEvent = coreGraphics.func(
    'void *CGEventCreateKeyboardEvent(void *source, uint16 virtualKey, bool keyDown)'
  );
  coreGraphics.CGEventSetFlags = coreGraphics.func(
    'void CGEventSetFlags(void *event, uint64 flags)'
  );
  coreGraphics.CGEventPost = coreGraphics.func(
    'void CGEventPost(uint32 tap, void *event)'
  );
  // Sets the Unicode payload of a keyboard event: posting it inserts the exact
  // string as text (layout-independent), the macOS analogue of Windows'
  // KEYEVENTF_UNICODE. UniChar is uint16, so we pass a UTF-16 code-unit buffer.
  coreGraphics.CGEventKeyboardSetUnicodeString = coreGraphics.func(
    'void CGEventKeyboardSetUnicodeString(void *event, uintptr_t length, uint16 *string)'
  );
  coreFoundation.CFRelease = coreFoundation.func(
    'void CFRelease(void *cf)'
  );
}

function postKey(keyCode, keyDown, flags) {
  const event = coreGraphics.CGEventCreateKeyboardEvent(null, keyCode, keyDown);
  if (!event) throw new Error(`CGEventCreateKeyboardEvent failed for key ${keyCode}`);
  try {
    coreGraphics.CGEventSetFlags(event, flags);
    coreGraphics.CGEventPost(kCGHIDEventTap, event);
  } finally {
    coreFoundation.CFRelease(event);
  }
}

function sendCommandV() {
  try {
    loadFrameworks();
    postKey(KEY_COMMAND, true, kCGEventFlagMaskCommand);
    postKey(KEY_V, true, kCGEventFlagMaskCommand);
    postKey(KEY_V, false, kCGEventFlagMaskCommand);
    postKey(KEY_COMMAND, false, 0);
    return { ok: true };
  } catch (error) {
    return { ok: false, error: error && error.message };
  }
}

// Post a chunk of text as a single keyboard event carrying its Unicode string.
// The whole chunk is delivered in one event (not char-by-char), so it is fast.
function postUnicodeChunk(str) {
  const units = [];
  for (let i = 0; i < str.length; i++) units.push(str.charCodeAt(i));
  const buf = Uint16Array.from(units);
  const down = coreGraphics.CGEventCreateKeyboardEvent(null, 0, true);
  if (!down) throw new Error('CGEventCreateKeyboardEvent failed');
  try {
    coreGraphics.CGEventKeyboardSetUnicodeString(down, buf.length, buf);
    coreGraphics.CGEventPost(kCGHIDEventTap, down);
  } finally {
    coreFoundation.CFRelease(down);
  }
  const up = coreGraphics.CGEventCreateKeyboardEvent(null, 0, false);
  if (!up) return;
  try {
    coreGraphics.CGEventKeyboardSetUnicodeString(up, buf.length, buf);
    coreGraphics.CGEventPost(kCGHIDEventTap, up);
  } finally {
    coreFoundation.CFRelease(up);
  }
}

// Type text by synthesizing keyboard events carrying the Unicode string —
// bypassing the clipboard entirely (no backup/restore race, clipboard
// untouched). Chunked so a huge string doesn't overflow a single event.
function typeText(text) {
  const str = String(text == null ? '' : text);
  if (!str) return { ok: true, chars: 0 };
  try {
    loadFrameworks();
    const CHUNK = 200;
    for (let i = 0; i < str.length; i += CHUNK) {
      postUnicodeChunk(str.slice(i, i + CHUNK));
    }
    return { ok: true, chars: str.length };
  } catch (error) {
    return { ok: false, chars: str.length, error: error && error.message };
  }
}

module.exports = { sendCommandV, typeText };
