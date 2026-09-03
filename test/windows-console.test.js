'use strict';
// The tray app must never die with a console it merely inherited (agent
// shells, scheduled tasks), while a console it owns outright is kept. Policy +
// the detach call, with the Win32 calls injected.
const assert = require('assert');
const { decideConsoleDetach, detachInheritedConsole } = require('../lib/windows-console');

const HWND = { fake: true };
assert.deepStrictEqual(decideConsoleDetach({ platform: 'darwin', hwnd: HWND, attached: 3 }), { action: 'none', reason: 'not-windows' });
assert.deepStrictEqual(decideConsoleDetach({ platform: 'win32', env: {}, hwnd: null }), { action: 'none', reason: 'no-console' });
assert.deepStrictEqual(decideConsoleDetach({ platform: 'win32', env: {}, hwnd: HWND, attached: 1 }), { action: 'kept', reason: 'own-console' });
assert.deepStrictEqual(decideConsoleDetach({ platform: 'win32', env: {}, hwnd: HWND, attached: 2 }), { action: 'detach', reason: 'shared-console' });
assert.deepStrictEqual(decideConsoleDetach({ platform: 'win32', env: { BOARDCLIP_KEEP_CONSOLE: '1' }, hwnd: HWND, attached: 5 }), { action: 'kept', reason: 'env' });

function fakeNative({ hwnd, attached, freeResult = 1 }) {
  const calls = [];
  return {
    calls,
    getConsoleWindow: () => { calls.push('get'); return hwnd; },
    attachedProcessCount: () => { calls.push('count'); return attached; },
    freeConsole: () => { calls.push('free'); return freeResult; },
  };
}

let n = fakeNative({ hwnd: HWND, attached: 2 });
assert.deepStrictEqual(detachInheritedConsole({ platform: 'win32', env: {}, native: n }), { action: 'detached', reason: 'shared-console', attached: 2 });
assert.deepStrictEqual(n.calls, ['get', 'count', 'free'], 'a shared console is freed');

n = fakeNative({ hwnd: HWND, attached: 1 });
assert.deepStrictEqual(detachInheritedConsole({ platform: 'win32', env: {}, native: n }), { action: 'kept', reason: 'own-console', attached: 1 });
assert.ok(!n.calls.includes('free'), 'a console we own alone is never freed');

n = fakeNative({ hwnd: null, attached: 0 });
assert.deepStrictEqual(detachInheritedConsole({ platform: 'win32', env: {}, native: n }), { action: 'none', reason: 'no-console', attached: 0 });

n = fakeNative({ hwnd: HWND, attached: 3, freeResult: 0 });
assert.strictEqual(detachInheritedConsole({ platform: 'win32', env: {}, native: n }).action, 'detach-failed');

assert.strictEqual(detachInheritedConsole({ platform: 'win32', env: {}, native: { getConsoleWindow() { throw new Error('boom'); } } }).action, 'error', 'a native failure never throws');
assert.deepStrictEqual(detachInheritedConsole({ platform: 'linux' }), { action: 'none', reason: 'not-windows' });

console.log('windows-console tests passed');
