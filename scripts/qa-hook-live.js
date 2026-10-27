'use strict';
// Drives the REAL Windows keyboard hook (lib/windows-hook.js, its worker and
// lib/windows-hook-policy.js) with injected key presses: the unit test runs
// the claim decision, this runs the real WH_KEYBOARD_LL path end to end. A
// second low-level hook, installed BEFORE the real one, observes what got
// through (low-level hooks run newest first, so a swallowed key never reaches
// it). Only F13 is pressed (nothing on a stock Windows answers it), with Ctrl,
// Shift or Win; every injected modifier is released at the end, pass or fail.
// It runs beside a live BoardClip: the real hook here is called first and
// swallows what it claims, so the live app never sees those presses.
//   node scripts/qa-hook-live.js
if (process.platform !== 'win32') {
  console.log('qa-hook-live: Windows only, skipped');
  process.exit(0);
}
const { Worker } = require('worker_threads');
const koffi = require('koffi');
const { install } = require('../lib/windows-hook');
const { MOD } = require('../lib/windows-hook-policy');

const F13 = 0x7C;
const VK = { CONTROL: 0x11, SHIFT: 0x10, LWIN: 0x5B };
const SIDED = { [VK.CONTROL]: [0xA2, 0xA3], [VK.SHIFT]: [0xA0, 0xA1], [VK.LWIN]: [VK.LWIN] };
const user32 = koffi.load('user32.dll');
const keybd_event = user32.func('void __stdcall keybd_event(uint8 bVk, uint8 bScan, uint32 dwFlags, uintptr_t dwExtraInfo)');
const KEYUP = 0x2;
const press = (vk) => keybd_event(vk, 0, 0, 0);
const lift = (vk) => keybd_event(vk, 0, KEYUP, 0);
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

// The observer: every key event that reaches it, posted to this thread.
const observer = new Worker(`
  const { parentPort } = require('worker_threads');
  const koffi = require(${JSON.stringify(require.resolve('koffi'))});
  const user32 = koffi.load('user32.dll');
  const KB = koffi.struct('QA_KB', { vkCode: 'uint32', scanCode: 'uint32', flags: 'uint32', time: 'uint32', dwExtraInfo: 'uintptr_t' });
  const MSG = koffi.struct('QA_MSG', { hwnd: 'void *', message: 'uint32', wParam: 'uintptr_t', lParam: 'intptr_t', time: 'uint32', x: 'int32', y: 'int32', p: 'uint32' });
  const Proc = koffi.proto('intptr_t __stdcall QA_Proc(int nCode, uintptr_t wParam, QA_KB *lParam)');
  const SetHook = user32.func('void * __stdcall SetWindowsHookExW(int, QA_Proc *, void *, uint32)');
  const Next = user32.func('intptr_t __stdcall CallNextHookEx(void *, int, uintptr_t, QA_KB *)');
  const GetMsg = user32.func('int __stdcall GetMessageW(_Out_ QA_MSG *, void *, uint32, uint32)');
  const cb = koffi.register((n, w, l) => {
    if (n >= 0) {
      const kb = koffi.decode(l, KB);
      parentPort.postMessage({ vk: kb.vkCode, down: w === 0x100 || w === 0x104 });
    }
    return Next(null, n, w, l);
  }, koffi.pointer(Proc));
  if (!SetHook(13, cb, null, 0)) process.exit(1);
  parentPort.postMessage({ ready: true });
  const m = {};
  while (GetMsg(m, null, 0, 0) > 0) {}
`, { eval: true });

const seen = [];
const calls = [];
let observerReady = false;
observer.on('message', (m) => { if (m.ready) observerReady = true; else seen.push(m); });

const results = [];
function check(name, ok, detail) {
  results.push({ name, ok: !!ok, ...(ok ? {} : { detail }) });
}
// The observer's view of a scenario: F13 events, and whether a Ctrl tap (the
// worker's Start-menu suppression) arrived while Win was down.
function view(from) {
  const events = seen.slice(from);
  return { f13: events.filter(e => e.vk === F13).length, events };
}

(async () => {
  let hook = null;
  const held = new Set();
  const hold = (vk) => { press(vk); held.add(vk); };
  const release = (vk) => { lift(vk); held.delete(vk); };
  const timer = setTimeout(() => { console.error('qa-hook-live: timed out'); finish(1); }, 20000);
  // End the process outright: a worker blocked in GetMessageW never sees a
  // terminate(), and Node's process.exit waits for it for ever. The process
  // ending is what removes both hooks.
  function finish(code) {
    clearTimeout(timer);
    for (const vk of [...held]) lift(vk);
    const summary = JSON.stringify({ passed: results.filter(r => r.ok).length, failed: results.filter(r => !r.ok), checks: results.map(r => r.name) }, null, 2);
    require('fs').writeSync(1, summary + '\n');
    const kernel32 = koffi.load('kernel32.dll');
    kernel32.func('int __stdcall TerminateProcess(void *hProcess, uint32 uExitCode)')(
      kernel32.func('void * __stdcall GetCurrentProcess()')(), code);
  }
  try {
    for (let i = 0; i < 50 && !observerReady; i++) await sleep(20);
    if (!observerReady) throw new Error('observer hook did not install');
    hook = install({
      onShowPopup: () => calls.push({ type: 'show' }),
      onNumpadPaste: (slot) => calls.push({ type: 'numpad', slot }),
      onQuickPaste: (slot) => calls.push({ type: 'quick-paste', slot }),
      onNewNote: () => calls.push({ type: 'new-note' }),
      onRecordKey: (vk, mods) => calls.push({ type: 'record', vk, mods }),
    });
    await sleep(800); // the worker installs its hook and starts pumping

    // 1) Nothing claimed: a plain F13 goes through, nothing fires.
    let at = seen.length;
    press(F13); lift(F13);
    await sleep(300);
    check('plain F13 passes through the real hook', view(at).f13 === 2 && calls.length === 0, { ...view(at), calls });

    // 2) Recording (the reported bug): Ctrl+F13 goes to the recorder only.
    hook.setPopupVisible(true);
    hook.setRecording(true);
    at = seen.length; calls.length = 0;
    hold(VK.CONTROL); press(F13); lift(F13); release(VK.CONTROL);
    await sleep(300);
    check('recording: Ctrl+F13 is recorded', JSON.stringify(calls) === JSON.stringify([{ type: 'record', vk: F13, mods: MOD.CTRL }]), calls);
    check('recording: Ctrl+F13 never reaches anything after the hook', view(at).f13 === 0, view(at));

    // 3) Recording a Win chord: recorded, swallowed, and the Win release gets
    //    the Ctrl tap that keeps the Start menu shut.
    at = seen.length; calls.length = 0;
    hold(VK.LWIN); press(F13); lift(F13); release(VK.LWIN);
    await sleep(300);
    const winView = view(at);
    const winDown = winView.events.findIndex(e => e.vk === VK.LWIN && e.down);
    const winUp = winView.events.findIndex(e => e.vk === VK.LWIN && !e.down);
    const tap = winView.events.findIndex((e, i) => i > winDown && SIDED[VK.CONTROL].concat(VK.CONTROL).includes(e.vk) && e.down);
    check('recording: Win+F13 is recorded', JSON.stringify(calls) === JSON.stringify([{ type: 'record', vk: F13, mods: MOD.WIN }]), calls);
    check('recording: Win+F13 never reaches anything after the hook', winView.f13 === 0, winView);
    check('recording: a Ctrl tap lands before the Win release (no Start menu)', winDown >= 0 && tap > winDown && tap < winUp, winView);

    // 4) A plain key while recording reaches the page (Esc cancels, hints).
    at = seen.length; calls.length = 0;
    press(F13); lift(F13);
    await sleep(300);
    check('recording: a bare F13 still reaches the page', view(at).f13 === 2 && calls.length === 0, { ...view(at), calls });

    // 5) The chord table: Ctrl+Shift+F13 as the popup shortcut fires once,
    //    exact modifiers only.
    hook.setRecording(false);
    hook.setPopupVisible(false);
    hook.setChords([{ vk: F13, mods: MOD.CTRL | MOD.SHIFT, type: 'show' }]);
    at = seen.length; calls.length = 0;
    hold(VK.CONTROL); hold(VK.SHIFT); press(F13); lift(F13); release(VK.SHIFT); release(VK.CONTROL);
    await sleep(300);
    check('table: Ctrl+Shift+F13 fires its action once', JSON.stringify(calls) === JSON.stringify([{ type: 'show' }]), calls);
    check('table: and is swallowed', view(at).f13 === 0, view(at));
    at = seen.length; calls.length = 0;
    hold(VK.CONTROL); press(F13); lift(F13); release(VK.CONTROL);
    await sleep(300);
    check('table: Ctrl+F13 (a different chord) passes', view(at).f13 === 2 && calls.length === 0, { ...view(at), calls });

    // 6) A Win chord in the table (what Win+1-9 quick paste is).
    hook.setChords([{ vk: F13, mods: MOD.WIN, type: 'quick-paste', slot: 4 }]);
    at = seen.length; calls.length = 0;
    hold(VK.LWIN); press(F13); lift(F13); release(VK.LWIN);
    await sleep(300);
    check('table: Win+F13 quick-pastes slot 4', JSON.stringify(calls) === JSON.stringify([{ type: 'quick-paste', slot: 4 }]), calls);
    check('table: Win+F13 is swallowed', view(at).f13 === 0, view(at));
    hook.setChords([]);

    finish(results.every(r => r.ok) ? 0 : 1);
  } catch (error) {
    check('ran', false, String(error && error.stack || error));
    finish(1);
  }
})();
