'use strict';
// lib/windows-dwm.js: the popup's Windows open/close animation is switched off
// (DWMWA_TRANSITIONS_FORCEDISABLED) with the HWND Electron hands out, never
// throws, and is a no-op off Windows (macOS shows its panel without it).
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { disableWindowTransitions, hwndFromHandle, DWMWA_TRANSITIONS_FORCEDISABLED } = require('../lib/windows-dwm');

const handle = Buffer.alloc(8);
handle.writeBigUInt64LE(0x1a2b3cn, 0);
assert.strictEqual(hwndFromHandle(handle), 0x1a2b3cn);
const win = { isDestroyed: () => false, getNativeWindowHandle: () => handle };

const calls = [];
const native = { setAttribute: (hwnd, attr, value, size) => { calls.push({ hwnd, attr, on: value.readInt32LE(0), size }); return 0; } };
assert.deepStrictEqual(disableWindowTransitions(win, { platform: 'win32', native }), { ok: true, hr: 0 });
assert.deepStrictEqual(calls, [{ hwnd: 0x1a2b3cn, attr: DWMWA_TRANSITIONS_FORCEDISABLED, on: 1, size: 4 }]);

assert.deepStrictEqual(disableWindowTransitions(win, { platform: 'darwin', native }), { ok: false, reason: 'not-win32' });
assert.strictEqual(calls.length, 1, 'nothing is called off Windows');
const failing = { setAttribute: () => { throw new Error('dwm unavailable'); } };
assert.deepStrictEqual(disableWindowTransitions(win, { platform: 'win32', native: failing }), { ok: false, reason: 'dwm unavailable' }, 'cosmetic: never throws');

const main = fs.readFileSync(path.join(__dirname, '../main.js'), 'utf8');
assert.ok(/function createPopup\(\)[\s\S]{0,2500}windowsDwm\.disableWindowTransitions\(win\)/.test(main), 'the popup turns its open animation off at creation');

console.log('windows-dwm tests passed');
