'use strict';
// lib/windows-hook-policy.js: the Windows keyboard hook's claim decision, the
// chord table and the shared-state layout, run here without a hook (the live
// WH_KEYBOARD_LL path cannot run in a test or the QA sandbox; scripts/
// qa-hook-live.js drives the real one). The worker only reads Win32 state and
// acts on these verdicts; main's registerShortcuts decides what is in the table.
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const hookPolicy = require('../lib/windows-hook-policy');
const { STATE, VK, MOD, LLKHF_ALTDOWN, modBits, isWinChord, chordFromAccelerator, recordedChord,
  writeChords, createHookClaimer, modsFrom } = hookPolicy;

const read = (p) => fs.readFileSync(path.join(__dirname, '..', p), 'utf8');
const KEY_A = 0x41;
const KEY_1 = 0x31;
const NUMPAD = (n) => VK.NUMPAD1 + n - 1;
// Windows' defaults: Win+V shows the popup, Win+N opens a new note.
const DEFAULT_CHORDS = [
  { vk: VK.V, mods: MOD.WIN, type: 'show' },
  { vk: VK.N, mods: MOD.WIN, type: 'new-note' },
];

// A fake keyboard: which keys are down (what GetAsyncKeyState would say BEFORE
// the event the hook is deciding) and a count of the Win32 reads.
function rig({ chords = DEFAULT_CHORDS, popup = false, slots = [], recording = false } = {}) {
  const state = new Uint8Array(STATE.SIZE);
  writeChords(state, chords);
  state[STATE.POPUP_VISIBLE] = popup ? 1 : 0;
  state[STATE.RECORDING] = recording ? 1 : 0;
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

// 1) Modifier bits: what a chord matches on, Alt also from the event flags.
assert.strictEqual(modBits({ win: true, shift: true }), MOD.WIN | MOD.SHIFT);
assert.strictEqual(modBits({}), 0);
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

// 3) A chord fires only with EXACTLY its modifiers: Win+Ctrl/Shift/Alt+V and
//    +N stay Windows' (Win+Ctrl+V = sound output, Win+Ctrl+N = Narrator
//    settings): the keydown, its repeats and its keyup all pass, nothing
//    fires, the Win release is not touched. A chord also needs its Win.
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
  const plain = rig();
  assert.ok(pass(plain.send(vk, true)) && pass(plain.send(vk, false)), 'the letter alone types');
}

// 4) A chord fires only while it is in the table (Win+N off or replaced by a
//    recorded chord: Windows gets it), and a press keeps its verdict when the
//    table changes under it (a recording starts).
{
  const off = rig({ chords: [DEFAULT_CHORDS[0]] });
  off.send(VK.LWIN, true);
  assert.ok(pass(off.send(VK.N, true)), 'Win+N not in the table: Windows gets it');
  assert.ok(pass(off.send(VK.N, false)));
  assert.ok(pass(off.send(VK.LWIN, false)));
  const on = rig();
  on.send(VK.LWIN, true);
  assert.deepStrictEqual(on.send(VK.N, true), { swallow: true, post: { type: 'new-note' }, markWinUsed: false });
  assert.strictEqual(on.send(VK.N, true).post, null, 'one note per press');
  assert.strictEqual(on.send(VK.N, false).swallow, true);
  assert.strictEqual(on.send(VK.LWIN, false).markWinUsed, true);
  on.send(VK.LWIN, true);
  on.send(VK.N, true);
  writeChords(on.state, []);
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
  for (const vk of [KEY_A, VK.CONTROL, VK.SHIFT, KEY_1]) { r.send(vk, true); r.send(vk, false); }
  r.send(VK.LWIN, false);
  assert.deepStrictEqual(r.reads, { mods: 0, key: 0 });
  const off = rig({ chords: [] });
  off.send(VK.N, true);
  assert.strictEqual(off.reads.mods, 0, 'a chord not in the table is decided before any modifier read');
}

// 9) A recorded Win chord in the table: quick paste on Win+1-9 (Windows'
//    taskbar chords, which a globalShortcut cannot take).
{
  const chords = Array.from({ length: 9 }, (_, i) => ({ vk: KEY_1 + i, mods: MOD.WIN, type: 'quick-paste', slot: i + 1 }));
  const r = rig({ chords, popup: true });
  r.send(VK.LWIN, true);
  assert.deepStrictEqual(r.send(KEY_1 + 2, true), { swallow: true, post: { type: 'quick-paste', slot: 3 }, markWinUsed: false }, 'Win+3 = quick paste 3, popup open or not (like a globalShortcut)');
  r.send(KEY_1 + 2, false);
  assert.strictEqual(r.send(VK.LWIN, false).markWinUsed, true, 'no Start menu after it');
  r.send(VK.LWIN, true);
  r.hold(VK.SHIFT);
  assert.ok(pass(r.send(KEY_1 + 2, true)), 'Win+Shift+3 stays Windows');
  r.send(KEY_1 + 2, false);
  r.release(VK.SHIFT);
  r.send(VK.LWIN, false);
  assert.ok(pass(r.send(KEY_1 + 2, true)) && pass(r.send(KEY_1 + 2, false)), 'a plain 3 types');
}

// 10) Recording (the reported bug: Win+1 switched to a taskbar app, the popup
//     lost focus and hid before the recorder saw a key): while a row records
//     and the popup is open, every press with Win, Ctrl or Alt goes to it and
//     nowhere else; bare and Shift-only keys reach the page (Esc cancels, the
//     row hints), so do the modifiers themselves.
{
  const r = rig({ chords: [], popup: true, recording: true });
  assert.ok(pass(r.send(VK.LWIN, true)), 'Win down passes');
  assert.deepStrictEqual(r.send(KEY_1, true), { swallow: true, post: { type: 'record', vk: KEY_1, mods: MOD.WIN }, markWinUsed: false });
  assert.strictEqual(r.send(KEY_1, true).post, null, 'its repeat records nothing more');
  assert.strictEqual(r.send(KEY_1, false).swallow, true);
  assert.strictEqual(r.send(VK.LWIN, false).markWinUsed, true, 'the Start menu stays shut');
  r.hold(VK.CONTROL);
  r.hold(VK.SHIFT);
  assert.deepStrictEqual(r.send(0x4B, true).post, { type: 'record', vk: 0x4B, mods: MOD.CTRL | MOD.SHIFT }, 'Ctrl+Shift+K records (another app\'s hotkey never fires)');
  r.send(0x4B, false);
  assert.ok(pass(r.send(0xA2, true)) && pass(r.send(0xA2, false)), 'a sided modifier key passes');
  r.release(VK.CONTROL);
  assert.ok(pass(r.send(0x4B, true)), 'Shift+K reaches the page (its hint)');
  r.send(0x4B, false);
  r.release(VK.SHIFT);
  assert.ok(pass(r.send(0x1B, true)) && pass(r.send(0x1B, false)), 'Esc reaches the page (cancel)');
  assert.ok(pass(r.send(KEY_A, true)), 'a bare key reaches the page');
  r.send(KEY_A, false);
  const table = rig({ popup: true, recording: true });
  table.send(VK.LWIN, true);
  assert.strictEqual(table.send(VK.V, true).post.type, 'record', 'Win+V records instead of showing (it can be recorded now)');
  const closed = rig({ chords: [], popup: false, recording: true });
  closed.send(VK.LWIN, true);
  assert.ok(pass(closed.send(KEY_1, true)), 'a recording flag left with the popup closed takes nothing');
}

// 11) Accelerators: which chords are the hook's and how the table spells them.
{
  assert.ok(isWinChord('Super+1') && isWinChord('Meta+Shift+K') && isWinChord('super+v'));
  assert.ok(!isWinChord('Control+1') && !isWinChord('') && !isWinChord('CommandOrControl+Shift+V'));
  assert.deepStrictEqual(chordFromAccelerator('Super+V'), { vk: VK.V, mods: MOD.WIN });
  assert.deepStrictEqual(chordFromAccelerator('Super+num1'), { vk: VK.NUMPAD1, mods: MOD.WIN });
  assert.deepStrictEqual(chordFromAccelerator('Super+Control+Alt+Shift+F13'), { vk: 0x7C, mods: MOD.WIN | MOD.CTRL | MOD.ALT | MOD.SHIFT });
  assert.deepStrictEqual(chordFromAccelerator('Control+Shift+Plus'), { vk: VK.OEM_PLUS, mods: MOD.CTRL | MOD.SHIFT });
  for (const bad of ['V', 'Shift+V', 'Super+Nonsense', 'Super+A+B', 'Super', '']) {
    assert.strictEqual(chordFromAccelerator(bad), null, `${bad || '(empty)'} is no chord`);
  }
  assert.deepStrictEqual(recordedChord(KEY_1, MOD.WIN | MOD.SHIFT), { key: '1', shortcut: 'Super+Shift+1' });
  assert.deepStrictEqual(recordedChord(VK.OEM_PLUS, MOD.CTRL | MOD.SHIFT), { key: 'Plus', shortcut: 'Control+Shift+Plus' });
  assert.deepStrictEqual(recordedChord(KEY_A, MOD.SHIFT), { key: 'A', shortcut: '' }, 'Shift alone is no shortcut ("Add a shortcut modifier.")');
  assert.deepStrictEqual(recordedChord(0xFF, MOD.WIN), { key: '', shortcut: '' }, 'a key with no name ("Press a non-modifier key.")');
  assert.strictEqual(recordedChord(NUMPAD(4), MOD.WIN | MOD.CTRL | MOD.ALT).shortcut, 'Super+Control+Alt+num4', 'modifier order = the page recorder\'s');
  // Every key the hook can name round-trips through the table to the same key
  // (numpad operators read back as their main-keyboard twins, as Electron's do).
  for (let vk = 1; vk < 256; vk++) {
    const { shortcut } = recordedChord(vk, MOD.WIN);
    if (!shortcut || [0x6A, 0x6B, 0x6D, 0x6E, 0x6F].includes(vk)) continue;
    assert.strictEqual(chordFromAccelerator(shortcut).vk, vk, `${shortcut} reads back as 0x${vk.toString(16)}`);
  }
}

// 12) The hook names a key exactly as the page recorder does, so a chord
//     saves the same whichever of the two heard it (index.html's own
//     shortcutKeyFromEvent, run on the keyboard events that key sends).
{
  const app = read('index.html');
  const start = app.indexOf('function shortcutKeyFromEvent(e) {');
  const end = app.indexOf('\nfunction shortcutFromEvent(e) {', start);
  assert.ok(start >= 0 && end > start);
  const pageKey = new Function(`${app.slice(start, end)}\nreturn shortcutKeyFromEvent;`)();
  const events = [];
  for (let i = 0; i < 26; i++) events.push([0x41 + i, { code: `Key${String.fromCharCode(65 + i)}`, key: String.fromCharCode(97 + i) }]);
  for (let i = 0; i <= 9; i++) events.push([0x30 + i, { code: `Digit${i}`, key: String(i) }], [0x60 + i, { code: `Numpad${i}`, key: String(i) }]);
  for (let i = 1; i <= 24; i++) events.push([0x6F + i, { code: `F${i}`, key: `F${i}` }]);
  for (const [vk, code] of [[0xBD, 'Minus'], [0xBB, 'Equal'], [0xDB, 'BracketLeft'], [0xDD, 'BracketRight'], [0xDC, 'Backslash'],
    [0xBA, 'Semicolon'], [0xDE, 'Quote'], [0xC0, 'Backquote'], [0xBC, 'Comma'], [0xBE, 'Period'], [0xBF, 'Slash'],
    [0x6B, 'NumpadAdd'], [0x6D, 'NumpadSubtract'], [0x6A, 'NumpadMultiply'], [0x6F, 'NumpadDivide'], [0x6E, 'NumpadDecimal']]) {
    events.push([vk, { code, key: '?' }]);
  }
  for (const [vk, key] of [[0x20, ' '], [0x09, 'Tab'], [0x0D, 'Enter'], [0x08, 'Backspace'], [0x2E, 'Delete'], [0x2D, 'Insert'],
    [0x24, 'Home'], [0x23, 'End'], [0x21, 'PageUp'], [0x22, 'PageDown'], [0x26, 'ArrowUp'], [0x28, 'ArrowDown'],
    [0x25, 'ArrowLeft'], [0x27, 'ArrowRight'], [0x14, 'CapsLock'], [0x90, 'NumLock'], [0x91, 'ScrollLock']]) {
    events.push([vk, { code: '', key }]);
  }
  for (const [vk, e] of events) {
    for (const shiftKey of [false, true]) {
      assert.strictEqual(recordedChord(vk, MOD.CTRL | (shiftKey ? MOD.SHIFT : 0)).key, pageKey({ ...e, shiftKey }),
        `0x${vk.toString(16)} (${e.code || e.key}${shiftKey ? ' + Shift' : ''}) is named as the page names it`);
    }
  }
}

// 13) The chord table: whole writes, at most MAX_CHORDS.
{
  const state = new Uint8Array(STATE.SIZE);
  assert.strictEqual(writeChords(state, DEFAULT_CHORDS), true);
  assert.strictEqual(state[STATE.CHORD_COUNT], 2);
  const many = Array.from({ length: STATE.MAX_CHORDS + 1 }, (_, i) => ({ vk: 0x41 + i, mods: MOD.WIN, type: 'show' }));
  assert.strictEqual(writeChords(state, many), false, 'an overflow says so');
  assert.strictEqual(state[STATE.CHORD_COUNT], STATE.MAX_CHORDS);
  assert.ok(STATE.CHORDS + STATE.MAX_CHORDS * STATE.CHORD_BYTES <= STATE.SIZE, 'the table fits the buffer');
  assert.ok(STATE.MAX_CHORDS >= 11, 'room for show + new note + quick paste 1-9');
}

// 14) One layout: main and the worker both take it from the policy, no
//     duplicated byte indices.
{
  const main = read('lib/windows-hook.js');
  const worker = read('lib/windows-hook-worker.js');
  for (const [name, src] of [['windows-hook.js', main], ['windows-hook-worker.js', worker]]) {
    assert.ok(src.includes("require('./windows-hook-policy')"), `${name} requires the policy`);
    assert.ok(!/sharedState\[\d+\]|SharedArrayBuffer\(\d+\)|Uint8Array\(\d+\)/.test(src), `${name} has no literal shared-state index`);
  }
  assert.ok(!/0x56|0x4E|0x61|GetAsyncKeyState\(VK_/.test(worker), 'the worker keeps no key table of its own');
  assert.ok(/claimer\.event\(vk, keyDown, kb\.flags\)/.test(worker), 'the worker decides every key through the claimer');
  for (const type of ['show', 'numpad', 'quick-paste', 'new-note', 'record']) assert.ok(main.includes(`case '${type}':`), `main handles the hook's '${type}'`);
  assert.deepStrictEqual([STATE.POPUP_VISIBLE, STATE.SLOT_FIRST, STATE.SLOT_LAST], [0, 1, 9]);
}

// 15) main's registerShortcuts, run from main.js's own source against fakes on
//     both platforms: on Windows every Win chord (the defaults Win+V / Win+N,
//     any recorded one) goes to the hook's table, every other chord is a
//     globalShortcut; macOS never touches the hook.
{
  const main = read('main.js');
  const slice = (start, end) => {
    const a = main.indexOf(start);
    const b = main.indexOf(end, a + start.length);
    assert.ok(a >= 0 && b > a, `main.js has ${start}`);
    return main.slice(a, b);
  };
  const src = slice('function defaultShowShortcut() {', 'function normalizeSyncPath(')
    + slice('function registerShortcuts() {', 'function suspendShortcutsForRecording() {');
  const run = (platform, stored = {}, { suspended = false } = {}) => {
    const out = { electron: [], chords: null, recording: null, carbon: [] };
    const fakeHook = {
      setRecording: (on) => { out.recording = on; },
      setChords: (chords) => { out.chords = chords.map(c => `${c.type}${c.slot ? c.slot : ''}:${c.vk.toString(16)}/${c.mods}`); return true; },
    };
    const globalShortcut = { unregisterAll() {}, register: (key) => { out.electron.push(key); return true; } };
    const macos = { clear() {},
      install: ({ shortcut, namespace }) => { out.carbon.push(namespace === 'newNote' ? `note:${shortcut}` : shortcut); return { ok: true }; },
      installQuickPaste: ({ shortcuts }) => { out.carbon.push(...shortcuts); return { ok: true }; } };
    const result = new Function('process', 'settings', 'DEFAULT_SHOW_SHORTCUT', 'hookPolicy', 'globalShortcut', 'require',
      'diagnostics', 'shortcutsSuspended', 'getMacosHotkey', 'logSafe', 'syncHookState',
      'showPopup', 'handleNumpad', 'handleQuickPaste', 'handleNewNoteShortcut', 'handleHookRecordedKey',
      `let windowsHook = null;\n${src}\nreturn registerShortcuts();`)(
      { platform, env: {} }, { ...stored }, 'CommandOrControl+Shift+V', hookPolicy, globalShortcut,
      (m) => { assert.strictEqual(m, './lib/windows-hook'); return { install: () => fakeHook }; },
      { record() {}, isEnabled: () => false }, suspended, () => macos, () => {}, () => {},
      () => {}, () => {}, async () => {}, () => {}, () => {});
    return { ...out, result };
  };
  const win = run('win32');
  assert.deepStrictEqual(win.chords, ['show:56/1', 'new-note:4e/1'], 'Windows defaults: Win+V and Win+N through the hook');
  assert.deepStrictEqual(win.electron, [], 'nothing through globalShortcut');
  assert.strictEqual(win.recording, false, 'a registration ends any recording');
  assert.ok(win.result.showShortcutRegistered && win.result.quickPasteRegistered && win.result.newNoteRegistered);
  const winQuick = run('win32', { quick_paste_shortcut: 'Super+1' });
  assert.deepStrictEqual(winQuick.chords, ['show:56/1',
    ...Array.from({ length: 9 }, (_, i) => `quick-paste${i + 1}:${(0x31 + i).toString(16)}/1`), 'new-note:4e/1'], 'Win+1-9 quick paste: nine hook chords');
  assert.deepStrictEqual(winQuick.electron, []);
  assert.ok(winQuick.result.quickPasteRegistered);
  const winNum = run('win32', { quick_paste_shortcut: 'Super+num1' });
  assert.ok(winNum.chords.includes('quick-paste9:69/1'), 'Win+Numpad 1-9 keeps the numpad keys');
  const ctrl = run('win32', { quick_paste_shortcut: 'Control+1', show_shortcut: 'Control+Shift+V', new_note_shortcut: 'none' });
  assert.deepStrictEqual(ctrl.chords, [], 'no Win chord: an empty table (Win+V and Win+N back to Windows)');
  assert.deepStrictEqual(ctrl.electron, ['Control+Shift+V', ...Array.from({ length: 9 }, (_, i) => `Control+${i + 1}`)]);
  const numCtrl = run('win32', { quick_paste_shortcut: 'Control+Alt+num1' });
  assert.strictEqual(numCtrl.electron[8], 'Control+Alt+num9', 'a numpad digit stays a numpad digit for every slot');
  const clash = run('win32', { show_shortcut: 'Super+1', quick_paste_shortcut: 'Super+1' });
  assert.strictEqual(clash.result.showShortcutRegistered, true);
  assert.strictEqual(clash.result.quickPasteRegistered, false, 'a chord two shortcuts share fails the later one, like a taken globalShortcut');
  const recNote = run('win32', { new_note_shortcut: 'Super+Alt+N' });
  assert.ok(recNote.chords.includes('new-note:4e/5') && !recNote.chords.includes('new-note:4e/1'), 'a recorded Win chord replaces Win+N in the table');
  const suspended = run('win32', {}, { suspended: true });
  assert.strictEqual(suspended.chords, null, 'while suspended nothing is (re)armed');
  const mac = run('darwin', { quick_paste_shortcut: 'Command+Option+1' });
  assert.strictEqual(mac.chords, null, 'macOS never installs the hook');
  assert.deepStrictEqual(mac.carbon, ['CommandOrControl+Shift+V', ...Array.from({ length: 9 }, (_, i) => `Command+Option+${i + 1}`)],
    'macOS: popup + quick paste 1-9 through Carbon');
  assert.deepStrictEqual(mac.electron, []);
  const macNum = run('darwin', { quick_paste_shortcut: 'Control+num1' });
  assert.strictEqual(macNum.carbon[9], 'Control+num9', 'macOS: a numpad digit stays a numpad digit (Carbon got top-row 1-9 before)');
  const macNote = run('darwin', { new_note_shortcut: 'Command+Shift+N' });
  assert.ok(macNote.carbon.includes('note:Command+Shift+N') && macNote.result.newNoteRegistered, 'macOS: a recorded new-note chord is a Carbon hotkey');
  assert.deepStrictEqual(run('darwin').electron, [], 'macOS default: no new-note shortcut');
  // macOS never registers a globalShortcut, whatever is set: Chromium's listener
  // takes every Carbon hotkey event as its own and crashed on ours (NOTREACHED,
  // the 28 Oct Mac crashes: quick paste Cmd+1 beside a new-note globalShortcut).
  for (const stored of [{}, { show_shortcut: 'Alt+V', quick_paste_shortcut: 'Command+1', new_note_shortcut: 'Alt+N' },
    { show_shortcut: 'Fn+V', quick_paste_shortcut: 'Control+num1', new_note_shortcut: 'Command+Shift+N' }]) {
    const r = run('darwin', stored);
    assert.deepStrictEqual(r.electron, [], `macOS: nothing through globalShortcut for ${JSON.stringify(stored)}`);
    assert.ok(r.result.showShortcutRegistered && r.result.quickPasteRegistered && r.result.newNoteRegistered, `macOS: all registered for ${JSON.stringify(stored)}`);
  }
  const owner = run('darwin', { show_shortcut: 'Alt+V', quick_paste_shortcut: 'Command+1', new_note_shortcut: 'Alt+N' });
  assert.deepStrictEqual(owner.carbon, ['Alt+V', ...Array.from({ length: 9 }, (_, i) => `Command+${i + 1}`), 'note:Alt+N'], "the owner's Mac settings: all eleven through Carbon");
}

// 15b) The macOS hotkey module claims only its own events: handlers are keyed by
//      signature + id (Chromium numbers its hotkeys from 1 too), and any other
//      event goes on to the next handler (eventNotHandledErr), never swallowed.
{
  const src = read('lib/macos-hotkey.js');
  assert.ok(src.includes('handlers.get(hotKeyKey(hotKeyID.signature, hotKeyID.id))'), 'the callback matches signature + id');
  assert.ok(src.includes('return handler ? 0 : EVENT_NOT_HANDLED;') && src.includes('const EVENT_NOT_HANDLED = -9874;'), 'a foreign hotkey event is passed on');
  assert.ok(!/handlers\.(get|set)\(id\b/.test(src), 'no handler keyed by id alone');
  const mod = require('../lib/macos-hotkey');
  assert.deepStrictEqual(Object.keys(mod).sort(), ['clear', 'currentModifierParts', 'install', 'installQuickPaste', 'parseShortcut', 'resolveShortcutFromCurrentModifiers', 'uninstall', 'usesFn'].sort());
  assert.deepStrictEqual(mod.install({ shortcut: 'Alt+N', onPressed() {}, namespace: 'newNote' }).ok, false, 'off macOS install refuses (no Carbon)');
}

// 16) main's new-note shortcut values on both platforms: '' = the default
//     (Windows: Win+N), 'none' = off (stored only where the default is a
//     chord), else a recorded chord.
{
  const main = read('main.js');
  const a = main.indexOf('function defaultNewNoteShortcut() {');
  const b = main.indexOf('function globalQuickPasteShortcut() {', a);
  const c = main.indexOf('function normalizeNewNoteShortcut(shortcut) {');
  const d = main.indexOf('\n}\n', c);
  assert.ok(a >= 0 && b > a && c >= 0 && d > c);
  const load = (platform, stored) => new Function('process', 'settings', `${main.slice(a, b)}\n${main.slice(c, d)}\n}\n
    return { SHORTCUT_OFF, effective: effectiveNewNoteShortcut(), normalize: normalizeNewNoteShortcut };`)({ platform }, { new_note_shortcut: stored });
  assert.strictEqual(load('win32', '').SHORTCUT_OFF, 'none');
  assert.strictEqual(load('win32', '').effective, 'Super+N', 'Windows default: Win+N');
  assert.strictEqual(load('win32', 'none').effective, '', 'Windows off: no shortcut');
  assert.strictEqual(load('win32', 'Control+Alt+N').effective, 'Control+Alt+N');
  assert.strictEqual(load('win32', '').normalize('none'), 'none', 'Windows stores off');
  assert.strictEqual(load('win32', '').normalize(' None '), 'none');
  assert.strictEqual(load('win32', '').normalize('Super+N'), '', 'recording the default stores the default');
  assert.strictEqual(load('darwin', '').normalize('none'), '', 'macOS: off IS the default, nothing extra is stored');
  assert.strictEqual(load('darwin', '').effective, '', 'macOS default: none');
}

console.log('windows hook tests passed');
