'use strict';
// lib/windows-hook-policy.js: the Windows keyboard hook's claim decision and
// the shared-state layout, run here without a hook (the live WH_KEYBOARD_LL
// path cannot run in a test or the QA sandbox). The worker only reads Win32
// state and acts on these verdicts.
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { STATE, VK, LLKHF_ALTDOWN, exactModifiers, createHookClaimer, modsFrom } = require('../lib/windows-hook-policy');

const KEY_A = 0x41;
const NUMPAD = (n) => VK.NUMPAD1 + n - 1;

// A fake keyboard: which keys are down (what GetAsyncKeyState would say BEFORE
// the event the hook is deciding) and a count of the Win32 reads.
function rig({ newNote = true, popup = false, slots = [] } = {}) {
  const state = new Uint8Array(STATE.SIZE);
  state[STATE.NEW_NOTE_HOTKEY] = newNote ? 1 : 0;
  state[STATE.POPUP_VISIBLE] = popup ? 1 : 0;
  for (const n of slots) state[STATE.SLOT_FIRST + n - 1] = 1;
  const down = new Set();
  const reads = { mods: 0, key: 0 };
  const isKeyDown = (vk) => down.has(vk);
  const claimer = createHookClaimer(state, {
    isKeyDown: (vk) => { reads.key += 1; return isKeyDown(vk); },
    readMods: (flags) => { reads.mods += 1; return modsFrom(isKeyDown, flags); },
  });
  // Deliver one event to the claimer, then apply it to the key state the way
  // the system would (a swallowed keydown never reaches the async state).
  const send = (vk, isDown, flags = 0) => {
    const v = claimer.event(vk, isDown, flags);
    if (!isDown) down.delete(vk);
    else if (!v.swallow) down.add(vk);
    return v;
  };
  const hold = (vk) => down.add(vk);   // a modifier already held
  const release = (vk) => down.delete(vk);
  return { state, send, hold, release, reads, down };
}
const pass = (v) => !v.swallow && !v.post && !v.markWinUsed;

// 1) exactModifiers: Win alone for a chord; a numpad digit plain or with Win.
assert.ok(exactModifiers({ win: true }, { win: true }));
for (const m of ['ctrl', 'shift', 'alt']) {
  assert.ok(!exactModifiers({ win: true, [m]: true }, { win: true }), `Win+${m} is not the chord`);
  assert.ok(!exactModifiers({ [m]: true }, { win: null }), `${m}+numpad is not a slot press`);
}
assert.ok(!exactModifiers({}, { win: true }), 'a chord needs Win');
assert.ok(!exactModifiers({ win: true }), 'win: false means Win up');
assert.ok(exactModifiers({}) && exactModifiers({}, { win: null }) && exactModifiers({ win: true }, { win: null }));
assert.strictEqual(modsFrom(() => false, LLKHF_ALTDOWN).alt, true, 'LLKHF_ALTDOWN counts as Alt held');

// 2) Plain Win+V: one show per press, its repeats and keyup swallowed, and the
//    Win release marks Win used (no Start menu). Win itself always passes.
{
  const r = rig();
  assert.ok(pass(r.send(VK.LWIN, true)));
  const first = r.send(VK.V, true);
  assert.deepStrictEqual(first, { swallow: true, post: { type: 'show' }, markWinUsed: false });
  assert.deepStrictEqual(r.send(VK.V, true), { swallow: true, post: null, markWinUsed: false }, 'auto-repeat: swallowed, not re-fired');
  assert.deepStrictEqual(r.send(VK.V, false), { swallow: true, post: null, markWinUsed: false }, 'the paired keyup is swallowed');
  assert.deepStrictEqual(r.send(VK.LWIN, false), { swallow: false, post: null, markWinUsed: true }, 'Win up after a chord: mark it used, let it through');
  assert.ok(pass(r.send(VK.LWIN, true)) && pass(r.send(VK.LWIN, false)), 'a later bare Win press is untouched');
  // Right Win works the same.
  r.send(VK.RWIN, true);
  assert.deepStrictEqual(r.send(VK.V, true).post, { type: 'show' });
  r.send(VK.V, false);
  assert.strictEqual(r.send(VK.RWIN, false).markWinUsed, true);
}

// 3) Win+Ctrl/Shift/Alt+V and +N stay Windows' (Win+Ctrl+V = sound output,
//    Win+Ctrl+N = Narrator settings): the keydown, its repeats and its keyup
//    all pass, nothing fires, the Win release is not touched.
for (const vk of [VK.V, VK.N]) {
  for (const mod of [VK.CONTROL, VK.SHIFT, VK.MENU]) {
    const r = rig();
    r.send(VK.LWIN, true);
    r.hold(mod);
    assert.ok(pass(r.send(vk, true)), `Win+${mod.toString(16)}+${String.fromCharCode(vk)} passes`);
    assert.ok(pass(r.send(vk, true)), 'its repeat passes');
    r.release(mod);
    assert.ok(pass(r.send(vk, true)), 'letting go of the modifier mid-press never turns the repeats into the chord');
    assert.ok(pass(r.send(vk, false)), 'its keyup passes');
    assert.ok(pass(r.send(VK.LWIN, false)), 'no Start-menu tap: Windows handled its own chord');
  }
  // Alt seen only through the event flags (LLKHF_ALTDOWN).
  const r = rig();
  r.send(VK.LWIN, true);
  assert.ok(pass(r.send(vk, true, LLKHF_ALTDOWN)), 'Win+Alt (flag only) passes');
}

// 4) Win+N fires only while main says it is the new-note shortcut.
{
  const off = rig({ newNote: false });
  off.send(VK.LWIN, true);
  assert.ok(pass(off.send(VK.N, true)), 'Win+N off: Windows gets it');
  assert.ok(pass(off.send(VK.N, false)));
  assert.ok(pass(off.send(VK.LWIN, false)));
  const on = rig({ newNote: true });
  on.send(VK.LWIN, true);
  assert.deepStrictEqual(on.send(VK.N, true), { swallow: true, post: { type: 'new-note' }, markWinUsed: false });
  assert.strictEqual(on.send(VK.N, true).post, null, 'one note per press');
  assert.strictEqual(on.send(VK.N, false).swallow, true);
  assert.strictEqual(on.send(VK.LWIN, false).markWinUsed, true);
  // The flag turns off mid-press (a recording starts): the press keeps its verdict.
  on.send(VK.LWIN, true);
  on.send(VK.N, true);
  on.state[STATE.NEW_NOTE_HOTKEY] = 0;
  assert.strictEqual(on.send(VK.N, false).swallow, true, 'the claimed press still swallows its keyup');
}

// 5) Press identity: V typed first, then Win while V repeats, is not Win+V.
{
  const r = rig();
  assert.ok(pass(r.send(VK.V, true)), 'a plain v types');
  r.send(VK.LWIN, true);
  assert.ok(pass(r.send(VK.V, true)), 'its repeat with Win now held still passes');
  assert.ok(pass(r.send(VK.V, false)));
  assert.strictEqual(r.send(VK.V, true).post.type, 'show', 'the next press is a real Win+V');
}

// 6) A keyup the hook never saw (released on a desktop it cannot see): an
//    unclaimed held key whose async state is up is a fresh press, so the next
//    Win+V is not mistaken for an old repeat. A claimed key's keydowns never
//    reached the async state, so it is never asked.
{
  const r = rig();
  r.send(VK.V, true);          // a typed v, unclaimed, tracked
  r.down.delete(VK.V);         // released where the hook could not see it
  r.send(VK.LWIN, true);
  assert.strictEqual(r.send(VK.V, true).post.type, 'show', 'stale unclaimed press: the new Win+V fires');
  const before = r.reads.key;
  r.send(VK.V, true);          // genuine repeat of the claimed press
  assert.strictEqual(r.reads.key, before, 'a claimed repeat reads no key state');
}

// 7) Numpad slots: a plain digit or Win+digit, popup closed, slot assigned.
{
  const r = rig({ slots: [1, 3] });
  assert.deepStrictEqual(r.send(NUMPAD(1), true), { swallow: true, post: { type: 'numpad', slot: 1 }, markWinUsed: false });
  assert.deepStrictEqual(r.send(NUMPAD(1), true), { swallow: true, post: null, markWinUsed: false }, 'held: pastes once');
  assert.strictEqual(r.send(NUMPAD(1), false).swallow, true, 'its keyup is swallowed');
  assert.ok(pass(r.send(NUMPAD(2), true)) && pass(r.send(NUMPAD(2), false)), 'an empty slot types its digit');
  for (const mod of [VK.CONTROL, VK.SHIFT, VK.MENU]) {
    r.hold(mod);
    assert.ok(pass(r.send(NUMPAD(3), true)), `modifier ${mod.toString(16)} + Numpad3 passes (Alt codes, app chords)`);
    assert.ok(pass(r.send(NUMPAD(3), false)));
    r.release(mod);
  }
  assert.ok(pass(r.send(NUMPAD(3), true, LLKHF_ALTDOWN)) && pass(r.send(NUMPAD(3), false)), 'Alt seen only through the flags passes too');
  assert.strictEqual(r.send(NUMPAD(3), true).post.slot, 3, 'plain again: it pastes');
  r.send(NUMPAD(3), false);
  r.hold(VK.LWIN);
  assert.strictEqual(r.send(NUMPAD(3), true).post.slot, 3, 'Win+Numpad3 pastes too (README: Win+Numpad 1-9)');
  r.send(NUMPAD(3), false);
  assert.strictEqual(r.send(VK.LWIN, false).markWinUsed, true, 'its swallowed press left a bare Win tap: mark Win used (no Start menu)');
  r.hold(VK.LWIN);
  assert.ok(pass(r.send(NUMPAD(2), true)) && pass(r.send(NUMPAD(2), false)), 'Win+an empty slot passes');
  assert.ok(pass(r.send(VK.LWIN, false)), 'Windows saw that key itself: no tap');
  const open = rig({ popup: true, slots: [1] });
  assert.ok(pass(open.send(NUMPAD(1), true)), 'popup open: the digit types into the search');
  open.state[STATE.POPUP_VISIBLE] = 0;
  assert.ok(pass(open.send(NUMPAD(1), true)), 'the same held press stays a digit after the popup closes');
  assert.ok(pass(open.send(NUMPAD(1), false)));
}

// 8) Keys the hook never takes cost no Win32 read.
{
  const r = rig();
  r.send(VK.LWIN, true);
  for (const vk of [KEY_A, VK.CONTROL, VK.SHIFT]) { r.send(vk, true); r.send(vk, false); }
  r.send(VK.LWIN, false);
  assert.deepStrictEqual(r.reads, { mods: 0, key: 0 });
  const off = rig({ newNote: false });
  off.send(VK.N, true);
  assert.strictEqual(off.reads.mods, 0, 'a disabled chord is decided before any modifier read');
}

// 9) One layout: main and the worker both take it from the policy, no
//    duplicated byte indices.
{
  const read = (p) => fs.readFileSync(path.join(__dirname, '..', p), 'utf8');
  const main = read('lib/windows-hook.js');
  const worker = read('lib/windows-hook-worker.js');
  for (const [name, src] of [['windows-hook.js', main], ['windows-hook-worker.js', worker]]) {
    assert.ok(src.includes("require('./windows-hook-policy')"), `${name} requires the policy`);
    assert.ok(!/sharedState\[\d+\]|NEW_NOTE_HOTKEY = \d|SharedArrayBuffer\(\d+\)|Uint8Array\(\d+\)/.test(src), `${name} has no literal shared-state index`);
  }
  assert.ok(!/0x56|0x4E|0x61|GetAsyncKeyState\(VK_/.test(worker), 'the worker keeps no key table of its own');
  assert.ok(/claimer\.event\(vk, keyDown, kb\.flags\)/.test(worker), 'the worker decides every key through the claimer');
  assert.deepStrictEqual([STATE.POPUP_VISIBLE, STATE.SLOT_FIRST, STATE.SLOT_LAST, STATE.NEW_NOTE_HOTKEY], [0, 1, 9, 10]);
  assert.ok(STATE.SIZE > STATE.NEW_NOTE_HOTKEY);
}

// 10) main's new-note shortcut values, run from main.js's own source on both
//     platforms: '' = the default (Windows: the hook's Win+N), 'none' = off
//     (stored only where the default is a chord), else a recorded chord.
{
  const main = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8');
  const slice = (start, end) => {
    const a = main.indexOf(start);
    const b = main.indexOf(end, a + start.length);
    assert.ok(a >= 0 && b > a, `main.js has ${start}`);
    return main.slice(a, b);
  };
  const values = slice('function defaultNewNoteShortcut() {', 'function globalShowShortcut() {');
  const normalize = slice('function normalizeNewNoteShortcut(shortcut) {', '\n}\n') + '\n}\n';
  const hookLine = slice('  const newNoteHookKey = ', '\n');
  assert.strictEqual(hookLine, "  const newNoteHookKey = process.platform === 'win32' && !settings.new_note_shortcut;",
    'the hook takes Win+N only at the default (off and a recorded chord leave it to Windows)');
  const load = (platform, stored) => new Function('process', 'settings', `${values}\n${normalize}
    const newNoteHookKey = process.platform === 'win32' && !settings.new_note_shortcut;
    return { SHORTCUT_OFF, effective: effectiveNewNoteShortcut(), recorded: recordedNewNoteShortcut(), hook: newNoteHookKey, normalize: normalizeNewNoteShortcut };`)({ platform }, { new_note_shortcut: stored });
  const win = (stored) => load('win32', stored);
  const mac = (stored) => load('darwin', stored);
  assert.strictEqual(win('').SHORTCUT_OFF, 'none');
  assert.deepStrictEqual([win('').effective, win('').recorded, win('').hook], ['Super+N', '', true], 'Windows default: Win+N through the hook');
  assert.deepStrictEqual([win('none').effective, win('none').recorded, win('none').hook], ['', '', false], 'Windows off: no shortcut, the hook leaves Win+N alone');
  assert.deepStrictEqual([win('Control+Alt+N').effective, win('Control+Alt+N').recorded, win('Control+Alt+N').hook], ['Control+Alt+N', 'Control+Alt+N', false], 'a recorded chord is a global shortcut, not the hook');
  assert.strictEqual(win('').normalize('none'), 'none', 'Windows stores off');
  assert.strictEqual(win('').normalize(' None '), 'none');
  assert.strictEqual(win('').normalize('Super+N'), '', 'recording the default stores the default');
  assert.strictEqual(mac('').normalize('none'), '', 'macOS: off IS the default, nothing extra is stored');
  assert.deepStrictEqual([mac('').effective, mac('').hook], ['', false], 'macOS default: none');
}

console.log('windows hook tests passed');
