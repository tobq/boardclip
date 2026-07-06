'use strict';
// Cross-platform "type this text" via synthesized key events, bypassing the
// clipboard entirely. This is the race-free quick-paste path: because the
// clipboard is never written, there is no backup/restore window for a laggy
// target app to read the wrong thing, and the user's real clipboard is left
// untouched. The whole string is injected in a few batched calls (NOT one key
// at a time with delays), so it is effectively instant.
//
// Windows: SendInput + KEYEVENTF_UNICODE (lib/windows-paste.js).
// macOS:   CGEventKeyboardSetUnicodeString (lib/macos-paste.js).
// Other:   unsupported -> callers fall back to the clipboard paste path.

const winPaste = require('./windows-paste');
const macPaste = require('./macos-paste');

function isSupported() {
  return process.platform === 'win32' || process.platform === 'darwin';
}

// Returns { ok, chars, ... }. Never throws.
function typeText(text) {
  try {
    if (process.platform === 'win32') return winPaste.typeText(text);
    if (process.platform === 'darwin') return macPaste.typeText(text);
    return { ok: false, chars: 0, unsupported: true };
  } catch (error) {
    return { ok: false, chars: 0, error: error && error.message };
  }
}

module.exports = { isSupported, typeText };
