'use strict';
// Worker thread running a Win32 low-level keyboard hook (WH_KEYBOARD_LL).
//
// This exists because Electron's `globalShortcut.register('Super+V')` fails
// on Windows — Windows Clipboard History has already claimed Win+V via the
// built-in RegisterHotKey API. A low-level hook sits *below* that system
// shortcut layer and can swallow the key before Windows Clipboard History
// sees it.
//
// Why a worker thread (not Electron's main thread):
//   1. LL hooks are called via messages posted to the installing thread, so
//      that thread must pump its own GetMessage loop. Electron's main thread
//      has a Chromium message pump that doesn't guarantee LL hook delivery
//      and can starve it under load.
//   2. LowLevelHooksTimeout defaults to 300ms — if any JS task on the main
//      thread runs longer, Windows silently unregisters the hook. Isolating
//      it in a worker with a dedicated GetMessage loop removes that risk.
//
// State sharing with main thread uses a SharedArrayBuffer rather than
// postMessage because the worker is blocked in a synchronous GetMessageW
// call and can't process its JS event loop.

const { parentPort, workerData } = require('worker_threads');
const koffi = require('koffi');

// --- Shared state (worker reads, main writes) ---
// Layout: [popupVisible, slot1, slot2, ..., slot9, reserved, ...]
const sharedState = workerData && workerData.sharedStateBuffer
  ? new Uint8Array(workerData.sharedStateBuffer)
  : new Uint8Array(16);

// --- Win32 constants ---
const WH_KEYBOARD_LL = 13;
const WM_KEYDOWN = 0x0100;
const WM_KEYUP = 0x0101;
const WM_SYSKEYDOWN = 0x0104;
const WM_SYSKEYUP = 0x0105;
const VK_LWIN = 0x5B;
const VK_RWIN = 0x5C;
const VK_CONTROL = 0x11;
const VK_V = 0x56;
const VK_NUMPAD1 = 0x61;
const VK_NUMPAD9 = 0x69;
const KEYEVENTF_KEYUP = 0x0002;

// --- koffi types ---
// KBDLLHOOKSTRUCT is the struct Windows passes to a WH_KEYBOARD_LL hook via
// lParam. We declare it so koffi can decode the pointer in the callback.
const KBDLLHOOKSTRUCT = koffi.struct('KBDLLHOOKSTRUCT', {
  vkCode: 'uint32',
  scanCode: 'uint32',
  flags: 'uint32',
  time: 'uint32',
  dwExtraInfo: 'uintptr_t',
});

// MSG is needed for the GetMessageW pump loop below.
const MSG = koffi.struct('MSG', {
  hwnd: 'void *',
  message: 'uint32',
  wParam: 'uintptr_t',
  lParam: 'intptr_t',
  time: 'uint32',
  pt_x: 'int32',
  pt_y: 'int32',
  lPrivate: 'uint32',
});

// Hook procedure prototype. Declaring lParam as KBDLLHOOKSTRUCT* means koffi
// gives us an External we can both decode *and* pass straight back through
// to CallNextHookEx without reinterpreting the pointer ourselves.
const HookProc = koffi.proto(
  'intptr_t __stdcall HookProc(int nCode, uintptr_t wParam, KBDLLHOOKSTRUCT *lParam)'
);

// --- Load user32.dll and bind functions ---
let user32;
try {
  user32 = koffi.load('user32.dll');
} catch (err) {
  parentPort.postMessage({ type: 'error', error: 'koffi.load user32.dll: ' + String(err) });
  process.exit(1);
}

const SetWindowsHookExW = user32.func(
  'void * __stdcall SetWindowsHookExW(int idHook, HookProc *lpfn, void *hmod, uint32 dwThreadId)'
);
const UnhookWindowsHookEx = user32.func(
  'int __stdcall UnhookWindowsHookEx(void *hhk)'
);
const CallNextHookEx = user32.func(
  'intptr_t __stdcall CallNextHookEx(void *hhk, int nCode, uintptr_t wParam, KBDLLHOOKSTRUCT *lParam)'
);
const GetMessageW = user32.func(
  'int __stdcall GetMessageW(_Out_ MSG *lpMsg, void *hWnd, uint32 wMsgFilterMin, uint32 wMsgFilterMax)'
);
const TranslateMessage = user32.func(
  'int __stdcall TranslateMessage(MSG *lpMsg)'
);
const DispatchMessageW = user32.func(
  'intptr_t __stdcall DispatchMessageW(MSG *lpMsg)'
);
const GetAsyncKeyState = user32.func(
  'int16 __stdcall GetAsyncKeyState(int vKey)'
);
const keybd_event = user32.func(
  'void __stdcall keybd_event(uint8 bVk, uint8 bScan, uint32 dwFlags, uintptr_t dwExtraInfo)'
);

let winVChordActive = false;
let winVChordConsumed = false;

// Auto-repeat suppression for numpad quick-paste. When a key is physically
// held, Windows emits repeated WM_KEYDOWN with no intervening WM_KEYUP. Without
// tracking this, one held (or lag-stretched) press fires the paste many times.
// numpadHeld = keys currently down; numpadIntercepted = keys whose keydown we
// swallowed, so we also swallow their paired keyup.
const numpadHeld = new Set();
const numpadIntercepted = new Set();

function isWinHeld() {
  return (GetAsyncKeyState(VK_LWIN) & 0x8000) !== 0 ||
         (GetAsyncKeyState(VK_RWIN) & 0x8000) !== 0;
}

function markWinKeyUsed() {
  // If V is swallowed, Windows can still react to the original Win release.
  // A tiny Ctrl tap marks the Win key as used while allowing the real Win-up
  // through, so we avoid both Clipboard History and stuck modifier state.
  try {
    keybd_event(VK_CONTROL, 0, 0, 0);
    keybd_event(VK_CONTROL, 0, KEYEVENTF_KEYUP, 0);
  } catch {}
}

// --- Hook callback ---
// Fires synchronously on this worker thread each time a keyboard event is
// delivered to the thread's message queue. Return non-zero to swallow the
// event (it will not propagate to the rest of the hook chain or any app).
const hookCallback = koffi.register((nCode, wParam, lParamExt) => {
  try {
    if (nCode >= 0) {
      const kb = koffi.decode(lParamExt, KBDLLHOOKSTRUCT);
      const vk = kb.vkCode;
      const keyDown = wParam === WM_KEYDOWN || wParam === WM_SYSKEYDOWN;
      const keyUp = wParam === WM_KEYUP || wParam === WM_SYSKEYUP;

      if (!keyDown && !keyUp) {
        return CallNextHookEx(null, nCode, wParam, lParamExt);
      }

      const isWinKey = vk === VK_LWIN || vk === VK_RWIN;

      // Win+V → show popup. Checked before Windows Clipboard History can.
      if (isWinKey && keyUp && winVChordConsumed) {
        markWinKeyUsed();
        winVChordConsumed = false;
      }

      if (vk === VK_V) {
        if (keyDown) {
          if (isWinHeld() || winVChordActive) {
            if (!winVChordActive) {
              winVChordActive = true;
              winVChordConsumed = true;
              parentPort.postMessage({ type: 'show' });
            }
            return 1;
          }
        } else if (winVChordActive) {
          winVChordActive = false;
          return 1;
        }
      }

      // Plain Numpad1-9 -> quick-paste when a slot is assigned and the popup
      // is closed. When the popup is visible, pass through so the search box
      // can accept normal numpad typing. Auto-repeat (held key) fires the paste
      // exactly once — repeats are swallowed but not re-dispatched.
      if (vk >= VK_NUMPAD1 && vk <= VK_NUMPAD9) {
        const slot = vk - VK_NUMPAD1 + 1;
        if (keyDown) {
          const popupVisible = sharedState[0] === 1;
          const slotAssigned = sharedState[slot] === 1;
          if (!popupVisible && slotAssigned) {
            if (numpadHeld.has(vk)) return 1; // auto-repeat: swallow, don't re-fire
            numpadHeld.add(vk);
            numpadIntercepted.add(vk);
            parentPort.postMessage({ type: 'numpad', slot });
            return 1;
          }
          // Not intercepting this press (popup open or slot unassigned): let it
          // type normally and don't track it.
        } else if (keyUp) {
          numpadHeld.delete(vk);
          if (numpadIntercepted.has(vk)) {
            numpadIntercepted.delete(vk);
            return 1; // swallow the keyup paired with a swallowed keydown
          }
        }
      }
    }
  } catch (err) {
    // Never let JS exceptions escape the hook — Windows will stall the
    // whole keyboard chain. Best-effort report and fall through to
    // CallNextHookEx so the key still reaches its target.
    try { parentPort.postMessage({ type: 'error', error: String(err) }); } catch {}
  }
  return CallNextHookEx(null, nCode, wParam, lParamExt);
}, koffi.pointer(HookProc));

// --- Install hook ---
// hMod=null + dwThreadId=0 → install a global LL hook owned by the current
// process. LL hooks are the one case where a null hMod is explicitly allowed.
const hook = SetWindowsHookExW(WH_KEYBOARD_LL, hookCallback, null, 0);
if (!hook) {
  parentPort.postMessage({ type: 'error', error: 'SetWindowsHookExW returned null' });
  process.exit(1);
}

parentPort.postMessage({ type: 'ready' });

// --- Message pump ---
// Blocks this worker thread pumping messages so Windows can deliver hook
// callbacks. Exits on WM_QUIT or worker termination from the main thread.
const msg = {};
while (true) {
  const ret = GetMessageW(msg, null, 0, 0);
  if (ret <= 0) break;
  TranslateMessage(msg);
  DispatchMessageW(msg);
}

// --- Cleanup (only reached on clean WM_QUIT; worker.terminate skips this) ---
try { UnhookWindowsHookEx(hook); } catch {}
try { koffi.unregister(hookCallback); } catch {}
