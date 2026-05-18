'use strict';

// macOS Carbon hotkeys cover one shortcut shape Electron does not expose:
// Globe/Fn as a modifier. Unlike a Quartz event tap, this should not require
// Input Monitoring permission.

const koffi = require('koffi');

const MOD_COMMAND = 1 << 8;
const MOD_SHIFT = 1 << 9;
const MOD_ALT = 1 << 11;
const MOD_CONTROL = 1 << 12;
const MOD_FN = 1 << 17;

const KEY_CODE_BY_NAME = {
  A: 0x00, S: 0x01, D: 0x02, F: 0x03, H: 0x04, G: 0x05, Z: 0x06, X: 0x07,
  C: 0x08, V: 0x09, B: 0x0B, Q: 0x0C, W: 0x0D, E: 0x0E, R: 0x0F, Y: 0x10,
  T: 0x11, 1: 0x12, 2: 0x13, 3: 0x14, 4: 0x15, 6: 0x16, 5: 0x17,
  '=': 0x18, 9: 0x19, 7: 0x1A, Minus: 0x1B, 8: 0x1C, 0: 0x1D, ']': 0x1E,
  O: 0x1F, U: 0x20, '[': 0x21, I: 0x22, P: 0x23, L: 0x25, J: 0x26,
  "'": 0x27, K: 0x28, ';': 0x29, Backslash: 0x2A, ',': 0x2B, '/': 0x2C,
  N: 0x2D, M: 0x2E, '.': 0x2F, '`': 0x32,
  Enter: 0x24, Tab: 0x30, Space: 0x31, Backspace: 0x33, Escape: 0x35,
  Delete: 0x75, Home: 0x73, End: 0x77, PageUp: 0x74, PageDown: 0x79,
  Left: 0x7B, Right: 0x7C, Down: 0x7D, Up: 0x7E,
  F1: 0x7A, F2: 0x78, F3: 0x63, F4: 0x76, F5: 0x60, F6: 0x61,
  F7: 0x62, F8: 0x64, F9: 0x65, F10: 0x6D, F11: 0x67, F12: 0x6F,
  F13: 0x69, F14: 0x6B, F15: 0x71, F16: 0x6A, F17: 0x40, F18: 0x4F,
  F19: 0x50, F20: 0x5A,
  num0: 0x52, num1: 0x53, num2: 0x54, num3: 0x55, num4: 0x56,
  num5: 0x57, num6: 0x58, num7: 0x59, num8: 0x5B, num9: 0x5C,
};

let carbon = null;
let target = null;
let handlerCallback = null;
let handlerRef = null;
let hotKeyRef = null;
let onPressed = null;

function fourCharCode(value) {
  return (
    (value.charCodeAt(0) << 24) |
    (value.charCodeAt(1) << 16) |
    (value.charCodeAt(2) << 8) |
    value.charCodeAt(3)
  ) >>> 0;
}

const EventHotKeyID = koffi.struct('EventHotKeyID', {
  signature: 'uint32',
  id: 'uint32',
});

const EventTypeSpec = koffi.struct('EventTypeSpec', {
  eventClass: 'uint32',
  eventKind: 'uint32',
});

function loadCarbon() {
  if (carbon) return;
  carbon = koffi.load('/System/Library/Frameworks/Carbon.framework/Carbon');
  const EventHandlerProc = koffi.proto('int EventHandlerProc(void *nextHandler, void *event, void *userData)');

  carbon.GetApplicationEventTarget = carbon.func('void *GetApplicationEventTarget()');
  carbon.InstallEventHandler = carbon.func(
    'int InstallEventHandler(void *target, EventHandlerProc *handler, uint32 numTypes, EventTypeSpec *list, void *userData, _Out_ void **outHandlerRef)'
  );
  carbon.RemoveEventHandler = carbon.func('int RemoveEventHandler(void *handlerRef)');
  carbon.RegisterEventHotKey = carbon.func(
    'int RegisterEventHotKey(uint32 code, uint32 modifiers, EventHotKeyID hotKeyID, void *target, uint32 options, _Out_ void **outRef)'
  );
  carbon.UnregisterEventHotKey = carbon.func('int UnregisterEventHotKey(void *hotKey)');
  carbon.GetCurrentKeyModifiers = carbon.func('uint32 GetCurrentKeyModifiers()');

  target = carbon.GetApplicationEventTarget();
  handlerCallback = koffi.register(() => {
    try { if (onPressed) onPressed(); } catch (err) { console.error('[macos-hotkey] onPressed:', err); }
    return 0;
  }, koffi.pointer(EventHandlerProc));
}

function normalizeShortcutPart(part) {
  const value = String(part || '').trim();
  const lower = value.toLowerCase();
  if (lower === 'globe' || lower === 'function') return 'Fn';
  if (lower === 'cmd') return 'Command';
  if (lower === 'ctrl') return 'Control';
  if (lower === 'option') return 'Alt';
  if (lower === 'super' || lower === 'meta') return 'Command';
  if (lower === 'return') return 'Enter';
  if (lower === 'esc') return 'Escape';
  if (lower === 'plus') return 'Plus';
  if (lower === 'minus') return 'Minus';
  if (/^num[0-9]$/i.test(value)) return value.toLowerCase();
  if (/^f([1-9]|1[0-9]|20)$/i.test(value)) return value.toUpperCase();
  if (value.length === 1 && /[a-z]/i.test(value)) return value.toUpperCase();
  return value;
}

function modifierMask(part) {
  switch (normalizeShortcutPart(part)) {
    case 'Command':
    case 'CommandOrControl':
    case 'CommandOrCtrl':
    case 'CmdOrCtrl':
      return MOD_COMMAND;
    case 'Control': return MOD_CONTROL;
    case 'Alt': return MOD_ALT;
    case 'Shift': return MOD_SHIFT;
    case 'Fn': return MOD_FN;
    default: return 0;
  }
}

function usesFn(shortcut) {
  return String(shortcut || '').split('+').some(part => normalizeShortcutPart(part) === 'Fn');
}

function parseShortcut(shortcut) {
  const parts = String(shortcut || '').split('+').map(normalizeShortcutPart).filter(Boolean);
  let modifiers = 0;
  let keyName = '';
  for (const part of parts) {
    const mask = modifierMask(part);
    if (mask) modifiers |= mask;
    else keyName = part;
  }
  if (keyName === 'Plus') keyName = '=';
  const keyCode = KEY_CODE_BY_NAME[keyName];
  if (typeof keyCode !== 'number') return null;
  return { keyCode, modifiers };
}

function installHandler() {
  if (handlerRef) return { ok: true };
  const out = [null];
  const status = carbon.InstallEventHandler(target, handlerCallback, 1, [{
    eventClass: fourCharCode('keyb'),
    eventKind: 5,
  }], null, out);
  if (status !== 0) return { ok: false, error: `Could not install macOS hotkey handler (${status}).` };
  handlerRef = out[0];
  return { ok: true };
}

function clearRuntimeShortcut() {
  if (hotKeyRef) {
    try { carbon.UnregisterEventHotKey(hotKeyRef); } catch {}
  }
  hotKeyRef = null;
  onPressed = null;
}

function install({ shortcut, onPressed: handler }) {
  if (process.platform !== 'darwin') return { ok: false, error: 'macOS hotkeys are only available on macOS.' };
  const parsed = parseShortcut(shortcut);
  if (!parsed || !usesFn(shortcut)) return { ok: false, error: 'Shortcut does not need the macOS Fn hotkey path.' };

  loadCarbon();
  const handlerResult = installHandler();
  if (!handlerResult.ok) return handlerResult;

  clearRuntimeShortcut();
  const out = [null];
  const status = carbon.RegisterEventHotKey(parsed.keyCode, parsed.modifiers, {
    signature: fourCharCode('BChk'),
    id: 1,
  }, target, 0, out);

  if (status !== 0) {
    const error = status === -9878
      ? 'Shortcut is already in use.'
      : `Could not register macOS Fn shortcut (${status}).`;
    return { ok: false, error };
  }

  hotKeyRef = out[0];
  onPressed = handler;
  return { ok: true };
}

function currentModifierParts() {
  if (process.platform !== 'darwin') return [];
  loadCarbon();
  const modifiers = carbon.GetCurrentKeyModifiers();
  const parts = [];
  if (modifiers & MOD_FN) parts.push('Fn');
  if (modifiers & MOD_COMMAND) parts.push('Command');
  if (modifiers & MOD_CONTROL) parts.push('Control');
  if (modifiers & MOD_ALT) parts.push('Alt');
  if (modifiers & MOD_SHIFT) parts.push('Shift');
  return parts;
}

function resolveShortcutFromCurrentModifiers(shortcut) {
  const parts = String(shortcut || '').split('+').map(normalizeShortcutPart).filter(Boolean);
  const keyName = parts.reverse().find(part => !modifierMask(part));
  if (!keyName) return shortcut;
  const modifiers = currentModifierParts();
  return modifiers.length ? [...modifiers, keyName].join('+') : shortcut;
}

function uninstall() {
  clearRuntimeShortcut();
  if (handlerRef && carbon) {
    try { carbon.RemoveEventHandler(handlerRef); } catch {}
  }
  handlerRef = null;
  if (handlerCallback) {
    try { koffi.unregister(handlerCallback); } catch {}
  }
  handlerCallback = null;
}

module.exports = {
  install,
  clearRuntimeShortcut,
  currentModifierParts,
  resolveShortcutFromCurrentModifiers,
  uninstall,
  usesFn,
  parseShortcut,
};
