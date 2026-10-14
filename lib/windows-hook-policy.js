'use strict';
// What the main thread (lib/windows-hook.js) and the hook worker
// (lib/windows-hook-worker.js) must agree on, and the hook's whole claim
// decision, kept Win32-free so it is unit-tested without installing a hook
// (test/windows-hook.test.js):
//   - STATE: the SharedArrayBuffer layout main writes and the worker reads;
//   - createHookClaimer: which key presses the hook takes.

// --- Shared state layout (one byte each; main writes, the worker reads) ---
const STATE = Object.freeze({
  POPUP_VISIBLE: 0,    // the popup is open: plain numpad keys type into it
  SLOT_FIRST: 1,       // bytes 1-9: numpad slot N holds a clip
  SLOT_LAST: 9,
  NEW_NOTE_HOTKEY: 10, // Win+N is the new-note shortcut (not off, not a recorded chord, not recording)
  SIZE: 16,
});

const VK = Object.freeze({
  SHIFT: 0x10, CONTROL: 0x11, MENU: 0x12,
  LWIN: 0x5B, RWIN: 0x5C,
  N: 0x4E, V: 0x56,
  NUMPAD1: 0x61, NUMPAD9: 0x69,
});
const LLKHF_ALTDOWN = 0x20;

// A claimed key fires only with EXACTLY its modifiers: never with Ctrl, Shift
// or Alt held, and Win as `win` says (true = held, false = up, null = either).
// A Win chord is Win alone (Win+Ctrl+N is Windows' Narrator settings, Win+Ctrl+V
// its sound output panel: those stay Windows'); a numpad slot is a plain digit
// or Win+digit (both documented), never Alt+digit (Alt codes) or Ctrl+digit.
// mods = { win, ctrl, shift, alt } as held at the keydown.
function exactModifiers(mods, { win = false } = {}) {
  if (mods.ctrl || mods.shift || mods.alt) return false;
  return win == null || !!mods.win === win;
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
// reads (GetAsyncKeyState), called only when a decision needs them, so a key
// the hook never takes costs a Map lookup.
//   Win+V      -> post { type: 'show' }, Clipboard History never opens;
//   Win+N      -> post { type: 'new-note' } while STATE.NEW_NOTE_HOTKEY;
//   Numpad1-9  -> post { type: 'numpad', slot } with the popup closed and the
//                 slot assigned (open, the digit types into the search).
// The Win key itself always passes. A press swallowed while Win was held
// leaves Windows a bare Win tap, so the Win release after one says
// markWinUsed and the worker taps a key that keeps the Start menu shut.
// Returns { swallow, post, markWinUsed }.
const PASS = Object.freeze({ swallow: false, post: null, markWinUsed: false });
function createHookClaimer(state, io) {
  // Win+<key> chords taken before Windows sees them: Win+V (Clipboard
  // History's) shows the popup; Win+N (the notification panel's) opens a new
  // note while main says it is the new-note shortcut. win = the Win rule for
  // exactModifiers; ready() = main wants the key now.
  const KEYS = new Map([
    [VK.V, { type: 'show', win: true, ready: () => true }],
    [VK.N, { type: 'new-note', win: true, ready: () => state[STATE.NEW_NOTE_HOTKEY] === 1 }],
  ]);
  for (let slot = 1; slot <= 9; slot++) {
    KEYS.set(VK.NUMPAD1 + slot - 1, { type: 'numpad', slot, win: null,
      ready: () => state[STATE.POPUP_VISIBLE] !== 1 && state[STATE.SLOT_FIRST + slot - 1] === 1 });
  }
  const tracker = createPressTracker();
  let winUsed = false;
  return {
    event(vk, down, flags = 0) {
      if (vk === VK.LWIN || vk === VK.RWIN) {
        if (down || !winUsed) return PASS;
        winUsed = false;
        return { swallow: false, post: null, markWinUsed: true };
      }
      const key = KEYS.get(vk);
      if (!key) return PASS;
      let mods = null;
      const r = tracker.event(vk, down,
        () => key.ready() && exactModifiers(mods = io.readMods(flags), { win: key.win }),
        () => io.isKeyDown(vk));
      if (!r.swallow) return PASS;
      if (r.fire && mods.win) winUsed = true;
      const post = !r.fire ? null : key.slot ? { type: key.type, slot: key.slot } : { type: key.type };
      return { swallow: true, post, markWinUsed: false };
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

module.exports = { STATE, VK, LLKHF_ALTDOWN, exactModifiers, createPressTracker, createHookClaimer, modsFrom };
