'use strict';

// Detach from a console this process merely INHERITED on Windows.
//
// electron.exe attaches to whatever console its parent had. Launched from an
// agent tool shell, a scheduled task or a helper cmd, the tray app then lives or
// dies with that console: when it is closed, Windows sends a console control
// event to every attached process and the whole tree stops within a second,
// with no crash record (2026-09-03: two "random crashes" 26 and 58 min after
// such launches; the Network Service child logged exit code 0xC000013A =
// STATUS_CONTROL_C_EXIT). FreeConsole() makes the process independent of that
// console for good.
//
// Policy (pure, unit-tested): if OTHER processes share the console it is
// somebody else's (a shell that may close it) -> detach. If we are the only
// process attached, the console is ours (the Startup VBS / start.bat path,
// where cmd has already exited) and harmless -> keep. BOARDCLIP_KEEP_CONSOLE=1
// keeps any console; a developer who wants `npx electron .` output in the
// terminal sets it. A "visible window" heuristic was tried first and is WRONG:
// an agent shell's hidden console still reports WS_VISIBLE. main.js guards
// process.stdout/stderr against write errors and logs only via logSafe, so a
// freed console never throws back into JS.

function decideConsoleDetach({ platform = process.platform, env = process.env, hwnd = null, attached = 0 } = {}) {
  if (platform !== 'win32') return { action: 'none', reason: 'not-windows' };
  if (env && env.BOARDCLIP_KEEP_CONSOLE === '1') return { action: 'kept', reason: 'env' };
  if (!hwnd) return { action: 'none', reason: 'no-console' };
  if (attached > 1) return { action: 'detach', reason: 'shared-console' };
  return { action: 'kept', reason: 'own-console' };
}

function loadNative() {
  const koffi = require('koffi');
  const kernel32 = koffi.load('kernel32.dll');
  const getConsoleProcessList = kernel32.func('uint32 __stdcall GetConsoleProcessList(_Out_ uint32 *list, uint32 count)');
  return {
    getConsoleWindow: kernel32.func('void * __stdcall GetConsoleWindow()'),
    freeConsole: kernel32.func('int __stdcall FreeConsole()'),
    attachedProcessCount: () => {
      const list = new Uint32Array(64);
      return getConsoleProcessList(list, list.length);
    },
  };
}

// Returns what was done, for the app.start diagnostic. Never throws.
function detachInheritedConsole({ platform = process.platform, env = process.env, native = null } = {}) {
  if (platform !== 'win32') return { action: 'none', reason: 'not-windows' };
  let api = native;
  try {
    if (!api) api = loadNative();
    const hwnd = api.getConsoleWindow();
    const attached = hwnd ? Number(api.attachedProcessCount()) || 0 : 0;
    const decision = decideConsoleDetach({ platform, env, hwnd, attached });
    if (decision.action !== 'detach') return { ...decision, attached };
    const ok = !!api.freeConsole();
    return { action: ok ? 'detached' : 'detach-failed', reason: decision.reason, attached };
  } catch (error) {
    return { action: 'error', reason: error && error.message };
  }
}

module.exports = { decideConsoleDetach, detachInheritedConsole, loadNative };
