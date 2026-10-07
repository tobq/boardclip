'use strict';
// lib/windows-dwm.js + the popup's park/unpark wiring: on Windows a closed
// popup is PARKED (cloaked + WS_EX_NOACTIVATE, still shown, content painted)
// instead of hidden, so opening is an uncloak with no Windows show animation.
// setParked never throws and is a no-op off Windows (macOS keeps hide/show).
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { setParked, hwndFromHandle, DWMWA_CLOAK, WS_EX_NOACTIVATE } = require('../lib/windows-dwm');

const handle = Buffer.alloc(8);
handle.writeBigUInt64LE(0x1a2b3cn, 0);
assert.strictEqual(hwndFromHandle(handle), 0x1a2b3cn);
const win = { isDestroyed: () => false, getNativeWindowHandle: () => handle };

const TOOLWINDOW = 0x80;
let exStyle = TOOLWINDOW;
const calls = [];
const native = {
  setAttribute: (hwnd, attr, value, size) => { calls.push({ hwnd, attr, on: value.readInt32LE(0), size }); return 0; },
  getExStyle: () => exStyle,
  setExStyle: (_hwnd, style) => { exStyle = style; },
};
assert.deepStrictEqual(setParked(win, true, { platform: 'win32', native }), { ok: true, hr: 0, noActivate: true });
assert.deepStrictEqual(calls, [{ hwnd: 0x1a2b3cn, attr: DWMWA_CLOAK, on: 1, size: 4 }], 'park = cloak');
assert.strictEqual(exStyle, TOOLWINDOW | WS_EX_NOACTIVATE, 'a parked popup can never be handed the focus');
assert.deepStrictEqual(setParked(win, false, { platform: 'win32', native }), { ok: true, hr: 0, noActivate: true });
assert.strictEqual(calls[1].on, 0, 'unpark = uncloak');
assert.strictEqual(exStyle, TOOLWINDOW, 'unpark restores the original style, nothing else touched');

const refused = { ...native, setAttribute: () => 0x80070006 };
assert.strictEqual(setParked(win, true, { platform: 'win32', native: refused }).ok, false, 'a refused cloak reports !ok so the caller hides instead');
assert.deepStrictEqual(setParked(win, true, { platform: 'darwin', native }), { ok: false, reason: 'not-win32' });
assert.deepStrictEqual(setParked(win, true, { platform: 'win32', native: { setAttribute: () => { throw new Error('dwm unavailable'); } } }),
  { ok: false, reason: 'dwm unavailable' }, 'never throws');

// Wiring guards (source): park after the first load, unpark on show, and every
// "is the popup open" check uses popupOpen - a parked popup IS visible to Windows.
const main = fs.readFileSync(path.join(__dirname, '../main.js'), 'utf8');
assert.ok(/function createPopup\(\)[\s\S]{0,3000}once\('did-finish-load', \(\) => \{ if \(!popupOpen\) parkPopup\('startup'\); \}\)/.test(main),
  'the popup parks as soon as its page has loaded');
assert.ok(/function parkPopup[\s\S]{0,400}windowsDwm\.setParked\(win, true\)[\s\S]{0,300}win\.showInactive\(\)/.test(main), 'park = setParked + showInactive');
assert.ok(/function hidePopup\(\)[\s\S]{0,900}parkPopup\('hide'\)[\s\S]{0,300}setForegroundWindow\(savedForegroundWindow\)\) win\.blur\(\)[\s\S]{0,200}win\.hide\(\)/.test(main),
  'hide parks (handing focus back) and falls back to a real hide');
assert.ok(/function showPopup\(\)[\s\S]{0,400}if \(isPopupOpen\(\)\)/.test(main), 'the toggle asks "open?", not "visible?"');
assert.ok(/function unparkPopup[\s\S]{0,100}windowsDwm\.setParked\(win, false\)/.test(main), 'unpark = setParked(false)');
// Move FIRST, uncloak second: uncloaking first showed one frame at the last spot.
assert.ok(/function showPopup\(\)[\s\S]{0,2500}win\.setPosition\(px, py \+ POPUP_SLIDE_PX\);[\s\S]{0,200}const reveal = \(\) => \{[\s\S]{0,120}unparkPopup\(\);[\s\S]{0,200}slidePopupInto\(px, py\)/.test(main),
  'show moves the cloaked window, then unparks, then slides');
assert.ok(/win\.on\('blur'[\s\S]{0,200}!isPopupOpen\(\)\) return;/.test(main), 'a blur after parking does not run the close path again');
for (const fn of ['startClickAwayWatcher', 'runNumpadSlotAction']) {
  const body = main.slice(main.indexOf(`function ${fn}`), main.indexOf('\n}\n', main.indexOf(`function ${fn}`)));
  assert.ok(body.length > 50, fn);
  assert.ok(!/\bwin\.isVisible\(\)/.test(body), `${fn} must use isPopupOpen(), not win.isVisible()`);
}

console.log('windows-dwm tests passed');
