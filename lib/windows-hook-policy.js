'use strict';
// What the main thread (lib/windows-hook.js) and the hook worker
// (lib/windows-hook-worker.js) must agree on, and the hook's whole claim
// decision, kept Win32-free so it is unit-tested without installing a hook
// (test/windows-hook.test.js):
//   - STATE: the SharedArrayBuffer layout main writes and the worker reads;
//   - the chord table: the Win chords main hands the hook (writeChords) and
//     the accelerator <-> key-code names both sides read them by;
//   - createHookClaimer: which key presses the hook takes.

// --- Shared state layout (one byte each; main writes, the worker reads) ---
const STATE = Object.freeze({
  POPUP_VISIBLE: 0,    // the popup is open: plain numpad keys type into it
  SLOT_FIRST: 1,       // bytes 1-9: numpad slot N holds a clip
  SLOT_LAST: 9,
  RECORDING: 10,       // a Settings shortcut row is recording: chords go to it
  CHORD_COUNT: 11,     // live entries in the chord table
  CHORDS: 12,          // CHORD_BYTES each: key code, MOD bits, action, slot
  CHORD_BYTES: 4,
  MAX_CHORDS: 12,      // show + new note + quick paste 1-9 = 11
  SIZE: 64,
});

const VK = Object.freeze({
  SHIFT: 0x10, CONTROL: 0x11, MENU: 0x12,
  LWIN: 0x5B, RWIN: 0x5C,
  N: 0x4E, V: 0x56,
  NUMPAD1: 0x61, NUMPAD9: 0x69,
  OEM_PLUS: 0xBB,
});
const LLKHF_ALTDOWN = 0x20;
// The modifiers held at a keydown, as bits (a chord matches on all four).
const MOD = Object.freeze({ WIN: 1, CTRL: 2, ALT: 4, SHIFT: 8 });
const PRIMARY = MOD.WIN | MOD.CTRL | MOD.ALT; // what makes a press a shortcut
// Shift / Ctrl / Alt, generic and left / right (the hook sees the sided codes).
const MODIFIER_KEYS = new Set([VK.SHIFT, VK.CONTROL, VK.MENU, 0xA0, 0xA1, 0xA2, 0xA3, 0xA4, 0xA5]);

function modBits(mods) {
  return (mods.win ? MOD.WIN : 0) | (mods.ctrl ? MOD.CTRL : 0) | (mods.alt ? MOD.ALT : 0) | (mods.shift ? MOD.SHIFT : 0);
}

// --- Key names: the accelerator spelling of each key code ---
// The names the Settings recorder writes for a key it sees (index.html
// shortcutKeyFromEvent), so a chord the hook hears while recording reads and
// saves exactly like one the page heard; punctuation at its US position.
const KEY_NAMES = new Map([
  [0x08, 'Backspace'], [0x09, 'Tab'], [0x0D, 'Enter'], [0x14, 'Capslock'], [0x20, 'Space'],
  [0x21, 'PageUp'], [0x22, 'PageDown'], [0x23, 'End'], [0x24, 'Home'],
  [0x25, 'Left'], [0x26, 'Up'], [0x27, 'Right'], [0x28, 'Down'], [0x2D, 'Insert'], [0x2E, 'Delete'],
  [0x90, 'Numlock'], [0x91, 'Scrolllock'],
  [0xBA, ';'], [VK.OEM_PLUS, '='], [0xBC, ','], [0xBD, 'Minus'], [0xBE, '.'], [0xBF, '/'], [0xC0, '`'],
  [0xDB, '['], [0xDC, 'Backslash'], [0xDD, ']'], [0xDE, "'"],
]);
for (let i = 0; i <= 9; i++) KEY_NAMES.set(0x30 + i, String(i));
for (let i = 0; i < 26; i++) KEY_NAMES.set(0x41 + i, String.fromCharCode(0x41 + i));
for (let i = 1; i <= 24; i++) KEY_NAMES.set(0x6F + i, `F${i}`);
for (let i = 0; i <= 9; i++) KEY_NAMES.set(0x60 + i, `num${i}`);
// Numpad operators last: the page names them like the main keys, so a saved
// name reads back as the main key (what Electron registers for it too).
for (const [vk, name] of [[0x6A, '*'], [0x6B, 'Plus'], [0x6D, 'Minus'], [0x6E, '.'], [0x6F, '/']]) KEY_NAMES.set(vk, name);

const KEY_CODES = new Map([['plus', VK.OEM_PLUS], ['esc', 0x1B], ['escape', 0x1B], ['return', 0x0D],
  ['numadd', 0x6B], ['numsub', 0x6D], ['nummult', 0x6A], ['numdiv', 0x6F], ['numdec', 0x6E]]);
for (const [vk, name] of KEY_NAMES) if (!KEY_CODES.has(name.toLowerCase())) KEY_CODES.set(name.toLowerCase(), vk);

const MOD_NAMES = new Map([
  ['super', MOD.WIN], ['meta', MOD.WIN],
  ['control', MOD.CTRL], ['ctrl', MOD.CTRL], ['commandorcontrol', MOD.CTRL], ['commandorctrl', MOD.CTRL], ['cmdorctrl', MOD.CTRL],
  ['alt', MOD.ALT], ['option', MOD.ALT],
  ['shift', MOD.SHIFT],
]);

function acceleratorParts(accelerator) {
  return String(accelerator || '').split('+').map(p => p.trim().toLowerCase()).filter(Boolean);
}

// A Win chord: Windows' shell holds most of them at the RegisterHotKey layer
// (Win+V Clipboard History, Win+N notifications, Win+1-9 the taskbar), where
// a globalShortcut silently loses, so on Windows every one is the hook's.
function isWinChord(accelerator) {
  return acceleratorParts(accelerator).some(part => MOD_NAMES.get(part) === MOD.WIN);
}

// accelerator -> { vk, mods } for the chord table; null when it is not one
// key with a shortcut modifier, or names a key the hook has no code for.
function chordFromAccelerator(accelerator) {
  let mods = 0;
  let vk = 0;
  for (const part of acceleratorParts(accelerator)) {
    if (MOD_NAMES.has(part)) { mods |= MOD_NAMES.get(part); continue; }
    if (vk || !KEY_CODES.has(part)) return null;
    vk = KEY_CODES.get(part);
  }
  return vk && (mods & PRIMARY) ? { vk, mods } : null;
}

// What a recording heard, as the page recorder writes it: Super, Control,
// Alt, Shift, then the key. key '' = a key with no name ("Press a
// non-modifier key."); shortcut '' with a key = no shortcut modifier.
function recordedChord(vk, mods) {
  const key = vk === VK.OEM_PLUS && (mods & MOD.SHIFT) ? 'Plus' : (KEY_NAMES.get(vk) || '');
  const parts = [[MOD.WIN, 'Super'], [MOD.CTRL, 'Control'], [MOD.ALT, 'Alt'], [MOD.SHIFT, 'Shift']]
    .filter(([bit]) => mods & bit).map(([, name]) => name);
  return { key, shortcut: key && (mods & PRIMARY) ? [...parts, key].join('+') : '' };
}

// --- Chord table (main writes it whole, the hook reads it per key) ---
const ACTIONS = Object.freeze(['show', 'new-note', 'quick-paste']); // stored as index + 1

// chords = [{ vk, mods, type, slot? }]. The count drops to 0 while the
// entries change, so the hook never reads a half-written one. Returns
// whether every chord fit.
function writeChords(state, chords) {
  const list = chords.slice(0, STATE.MAX_CHORDS);
  Atomics.store(state, STATE.CHORD_COUNT, 0);
  list.forEach((chord, i) => {
    const at = STATE.CHORDS + i * STATE.CHORD_BYTES;
    state[at] = chord.vk;
    state[at + 1] = chord.mods;
    state[at + 2] = ACTIONS.indexOf(chord.type) + 1;
    state[at + 3] = chord.slot || 0;
  });
  Atomics.store(state, STATE.CHORD_COUNT, list.length);
  return list.length === chords.length;
}

// One verdict per press: a key's auto-repeats and its keyup follow its first
// keydown's verdict, so a claimed press fires once and swallows its keyup, and
// an unclaimed one passes untouched to its end (letting go of Ctrl while
// Win+Ctrl+N is held never turns the repeats into a Win+N).
//   claim()   decides a fresh press (only then: repeats read nothing);
//   wasDown() says the key was already down before this keydown. Asked only
//             for an UNCLAIMED held key, whose keydown reached the system: up
//             means its keyup never reached us (released on a desktop the hook
//             cannot see), so this is a fresh press. A claimed key's keydowns
//             were swallowed, so its state says nothing.
function createPressTracker() {
  const held = new Map(); // vk -> claimed, for keys down since their first keydown
  return {
    holds(vk) { return held.has(vk); },
    event(vk, down, claim, wasDown) {
      if (!down) {
        const claimed = held.get(vk) === true;
        held.delete(vk);
        return { swallow: claimed, fire: false };
      }
      if (held.has(vk)) {
        const claimed = held.get(vk);
        if (claimed || !wasDown || wasDown()) return { swallow: claimed, fire: false };
      }
      const claimed = !!claim();
      held.set(vk, claimed);
      return { swallow: claimed, fire: claimed };
    },
  };
}

// The hook's claim decision for one key event. `state` is the shared-state
// byte array; io.readMods(flags) and io.isKeyDown(vk) are the worker's Win32
// reads (GetAsyncKeyState), called only for a key the shared bytes say could
// be claimed, so any other key costs a few byte reads.
//   recording  -> every press with Win, Ctrl or Alt, while the popup is open:
//                 post { type: 'record', vk, mods } (Windows never acts on it,
//                 so Win+1 records instead of switching to a taskbar app);
//   a chord    -> its EXACT modifiers: post { type } ('show', 'new-note') or
//                 { type: 'quick-paste', slot };
//   Numpad1-9  -> plain or with Win, the popup closed and the slot assigned:
//                 post { type: 'numpad', slot } (open, the digit types into
//                 the search; Ctrl/Shift/Alt+digit stay the apps', Alt codes).
// The Win key itself always passes. A press swallowed while Win was held
// leaves Windows a bare Win tap, so the Win release after one says
// markWinUsed and the worker taps a key that keeps the Start menu shut.
// Returns { swallow, post, markWinUsed }.
const PASS = Object.freeze({ swallow: false, post: null, markWinUsed: false });
function createHookClaimer(state, io) {
  const recording = () => state[STATE.RECORDING] === 1 && state[STATE.POPUP_VISIBLE] === 1;
  // The table entry for vk (with exactly `mods`, or any when null), else -1.
  const chordIndex = (vk, mods) => {
    const count = Math.min(state[STATE.CHORD_COUNT], STATE.MAX_CHORDS);
    for (let i = 0; i < count; i++) {
      const at = STATE.CHORDS + i * STATE.CHORD_BYTES;
      if (state[at] === vk && (mods == null || state[at + 1] === mods)) return i;
    }
    return -1;
  };
  const isNumpadDigit = (vk) => vk >= VK.NUMPAD1 && vk <= VK.NUMPAD9;
  const numpadSlot = (vk) => {
    const slot = isNumpadDigit(vk) ? vk - VK.NUMPAD1 + 1 : 0;
    return slot && state[STATE.POPUP_VISIBLE] !== 1 && state[STATE.SLOT_FIRST + slot - 1] === 1 ? slot : 0;
  };
  // Tracked keys get one verdict per press. A numpad digit always is, so a
  // press that began as a digit stays one when the popup closes mid-press.
  const tracked = (vk) => !MODIFIER_KEYS.has(vk) && (recording() || isNumpadDigit(vk) || chordIndex(vk, null) >= 0);
  // Whether this press could be claimed at all, from the shared bytes alone:
  // only then are the modifiers read.
  const claimable = (vk) => recording() || numpadSlot(vk) > 0 || chordIndex(vk, null) >= 0;
  const decide = (vk, mods) => {
    if (recording()) return mods & PRIMARY ? { type: 'record', vk, mods } : null;
    const i = chordIndex(vk, mods);
    if (i >= 0) {
      const at = STATE.CHORDS + i * STATE.CHORD_BYTES;
      const type = ACTIONS[state[at + 2] - 1];
      if (type === 'quick-paste') return { type, slot: state[at + 3] };
      if (type) return { type };
    }
    const slot = numpadSlot(vk);
    return slot && !(mods & (MOD.CTRL | MOD.ALT | MOD.SHIFT)) ? { type: 'numpad', slot } : null;
  };
  const tracker = createPressTracker();
  let winUsed = false;
  return {
    event(vk, down, flags = 0) {
      if (vk === VK.LWIN || vk === VK.RWIN) {
        if (down || !winUsed) return PASS;
        winUsed = false;
        return { swallow: false, post: null, markWinUsed: true };
      }
      if (!tracker.holds(vk) && !(down && tracked(vk))) return PASS;
      let mods = 0;
      let post = null;
      const r = tracker.event(vk, down,
        () => claimable(vk) && !!(post = decide(vk, mods = modBits(io.readMods(flags)))),
        () => io.isKeyDown(vk));
      if (!r.swallow) return PASS;
      if (r.fire && (mods & MOD.WIN)) winUsed = true;
      return { swallow: true, post: r.fire ? post : null, markWinUsed: false };
    },
  };
}

// The worker's io.readMods: GetAsyncKeyState-style isKeyDown(vk) + the hook
// event's flags (LLKHF_ALTDOWN covers an Alt the async state has not caught).
function modsFrom(isKeyDown, flags) {
  return {
    win: isKeyDown(VK.LWIN) || isKeyDown(VK.RWIN),
    ctrl: isKeyDown(VK.CONTROL),
    shift: isKeyDown(VK.SHIFT),
    alt: (flags & LLKHF_ALTDOWN) !== 0 || isKeyDown(VK.MENU),
  };
}

module.exports = {
  STATE, VK, MOD, LLKHF_ALTDOWN, modBits, isWinChord, chordFromAccelerator, recordedChord,
  writeChords, createPressTracker, createHookClaimer, modsFrom,
};
