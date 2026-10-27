'use strict';
// Main-thread wrapper around the Win32 keyboard hook worker.
//
// On Windows we can't use Electron's `globalShortcut.register('Super+V')`
// because Windows Clipboard History owns Win+V at the RegisterHotKey layer
// and silently rejects our registration. This module installs a
// WH_KEYBOARD_LL hook on a dedicated worker thread which intercepts every
// Win chord BoardClip uses (Win+V, Win+N and any recorded one, see the chord
// table in lib/windows-hook-policy.js), the numpad slot keys, and the chord a
// Settings row is recording, *before* Windows' own handlers see them.
//
// See lib/windows-hook-worker.js for the hook implementation and the
// rationale for running it in a worker.
//
// Shared state (popup visible, which numpad slots are assigned, recording,
// the chord table; layout = STATE in lib/windows-hook-policy.js) is passed via a
// SharedArrayBuffer because the worker is synchronously blocked in
// GetMessageW and can't process postMessage events from its JS event loop.

const { Worker } = require('worker_threads');
const path = require('path');
const { STATE, writeChords } = require('./windows-hook-policy');

let currentHook = null;

function install({ onShowPopup, onNumpadPaste, onQuickPaste, onNewNote, onRecordKey }) {
  if (process.platform !== 'win32') {
    // Non-Windows platforms use Electron's globalShortcut; no-op API here.
    return {
      setPopupVisible() {},
      setSlotAssignments() {},
      setChords() { return true; },
      setRecording() {},
      uninstall() {},
    };
  }
  if (currentHook) return currentHook;

  const sharedStateBuffer = new SharedArrayBuffer(STATE.SIZE);
  const sharedState = new Uint8Array(sharedStateBuffer);

  const worker = new Worker(path.join(__dirname, 'windows-hook-worker.js'), {
    workerData: { sharedStateBuffer },
  });

  worker.on('message', (msg) => {
    switch (msg.type) {
      case 'show':
        try { onShowPopup(); } catch (e) { console.error('[windows-hook] onShowPopup:', e); }
        break;
      case 'numpad':
        try { onNumpadPaste(msg.slot); } catch (e) { console.error('[windows-hook] onNumpadPaste:', e); }
        break;
      case 'quick-paste':
        try { onQuickPaste(msg.slot); } catch (e) { console.error('[windows-hook] onQuickPaste:', e); }
        break;
      case 'new-note':
        try { onNewNote(); } catch (e) { console.error('[windows-hook] onNewNote:', e); }
        break;
      case 'record':
        try { onRecordKey(msg.vk, msg.mods); } catch (e) { console.error('[windows-hook] onRecordKey:', e); }
        break;
      case 'ready':
        // Hook installed successfully — no action needed.
        break;
      case 'error':
        console.error('[windows-hook]', msg.error);
        break;
    }
  });

  worker.on('error', (err) => {
    console.error('[windows-hook] worker crashed:', err);
    currentHook = null;
  });

  worker.on('exit', (code) => {
    if (code !== 0) console.error(`[windows-hook] worker exited with code ${code}`);
    currentHook = null;
  });

  currentHook = {
    setPopupVisible(visible) {
      sharedState[STATE.POPUP_VISIBLE] = visible ? 1 : 0;
    },
    setSlotAssignments(assignedSet) {
      // assignedSet: Set<number> of assigned numpad slot numbers (1-9)
      for (let n = 1; n <= 9; n++) {
        sharedState[STATE.SLOT_FIRST + n - 1] = assignedSet && assignedSet.has(n) ? 1 : 0;
      }
    },
    // The Win chords the hook claims: [{ vk, mods, type, slot? }] (main's
    // registerShortcuts; empty while a recording runs). False = some did not fit.
    setChords(chords) {
      return writeChords(sharedState, chords);
    },
    // A Settings row is recording: every Win/Ctrl/Alt press goes to it.
    setRecording(on) {
      sharedState[STATE.RECORDING] = on ? 1 : 0;
    },
    uninstall() {
      if (!currentHook) return;
      currentHook = null;
      // worker.terminate() kills the thread; Windows reclaims the hook on
      // thread exit. A cleaner PostThreadMessageW(WM_QUIT) would require
      // exposing the worker thread ID — not worth the extra FFI surface.
      worker.terminate().catch(() => {});
    },
  };

  return currentHook;
}

module.exports = { install };
