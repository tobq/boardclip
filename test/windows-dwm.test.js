'use strict';
// lib/windows-dwm.js + the popup's park/unpark wiring: on Windows a closed
// popup is PARKED (cloaked + WS_EX_NOACTIVATE, still shown, content painted)
// instead of hidden, so opening is an uncloak with no Windows show animation.
// setParked never throws and is a no-op off Windows (macOS keeps hide/show).
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { setParked, setWindowAlpha, clearLayered, layeredState, readAccentColor, abgrToHex, hwndFromHandle, DWMWA_CLOAK, WS_EX_NOACTIVATE, WS_EX_LAYERED } = require('../lib/windows-dwm');

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

// The solid popup's open fade: a layered alpha set natively, then CLEARED so the
// window is never left layered (a layered window drops the acrylic if the
// surface later goes glass, and Electron's own setOpacity would not re-add the
// style after a clear).
{
  let style = TOOLWINDOW;
  const log = [];
  const fake = {
    getExStyle: () => style,
    setExStyle: (_hwnd, next) => { log.push(['style', next]); style = next; },
    setLayeredAlpha: (hwnd, byte) => { log.push(['alpha', byte]); return hwnd === 0x1a2b3cn; },
    getLayeredAlpha: () => 128,
    redraw: (hwnd) => { log.push(['redraw', hwnd]); return true; },
  };
  assert.deepStrictEqual(setWindowAlpha(win, 0, { platform: 'win32', native: fake }), { ok: true, alpha: 0 });
  assert.strictEqual(style, TOOLWINDOW | WS_EX_LAYERED, 'the fade makes the window layered');
  assert.deepStrictEqual(setWindowAlpha(win, 0.5, { platform: 'win32', native: fake }), { ok: true, alpha: 128 });
  assert.strictEqual(log.filter((e) => e[0] === 'style').length, 1, 'the layered style is added once, not per frame');
  assert.strictEqual(setWindowAlpha(win, 7, { platform: 'win32', native: fake }).alpha, 255, 'alpha clamps to 0..1');
  assert.strictEqual(setWindowAlpha(win, NaN, { platform: 'win32', native: fake }).alpha, 0);
  assert.deepStrictEqual(layeredState(win, { platform: 'win32', native: fake }), { layered: true, alpha: 128 });
  log.length = 0;
  assert.deepStrictEqual(clearLayered(win, { platform: 'win32', native: fake }), { ok: true, wasLayered: true });
  assert.strictEqual(style, TOOLWINDOW, 'clear drops WS_EX_LAYERED and touches nothing else');
  assert.deepStrictEqual(log, [['style', TOOLWINDOW], ['redraw', 0x1a2b3cn]], 'then asks the window to repaint (the documented way out of layering)');
  assert.deepStrictEqual(layeredState(win, { platform: 'win32', native: fake }), { layered: false, alpha: 255 }, 'a cleared window is fully opaque');
  assert.deepStrictEqual(clearLayered(win, { platform: 'win32', native: fake }), { ok: true, wasLayered: false }, 'clearing twice is a no-op');
  const stuck = { ...fake, setExStyle: () => {} };
  style = TOOLWINDOW | WS_EX_LAYERED;
  assert.strictEqual(clearLayered(win, { platform: 'win32', native: stuck }).ok, false, 'a style that will not clear reports !ok');
  assert.deepStrictEqual(setWindowAlpha(win, 1, { platform: 'darwin', native: fake }), { ok: false, reason: 'not-win32' });
  assert.deepStrictEqual(clearLayered(win, { platform: 'linux', native: fake }), { ok: false, reason: 'not-win32' });
  assert.strictEqual(layeredState(win, { platform: 'darwin', native: fake }), null);
  const throwing = { getExStyle: () => { throw new Error('user32 gone'); } };
  assert.deepStrictEqual(setWindowAlpha(win, 1, { platform: 'win32', native: throwing }), { ok: false, reason: 'user32 gone' }, 'never throws');
  assert.deepStrictEqual(clearLayered(win, { platform: 'win32', native: throwing }), { ok: false, reason: 'user32 gone' }, 'never throws');
  const gone = { isDestroyed: () => true, getNativeWindowHandle: () => handle };
  assert.deepStrictEqual(setWindowAlpha(gone, 1, { platform: 'win32', native: fake }), { ok: false, reason: 'no-window' });
}

// The Windows accent: the value Settings writes (0xAABBGGRR), not DWM's blended
// colorization colour that Electron's getAccentColor returns.
{
  assert.strictEqual(abgrToHex(0xffd47800), '#0078d4');
  assert.strictEqual(abgrToHex(0x00112233), '#332211', 'alpha ignored, byte order reversed');
  const reads = [];
  const reg = (values) => ({ readDword: (key, name) => { reads.push(name); return values[name] === undefined ? null : values[name]; } });
  assert.strictEqual(readAccentColor({ platform: 'win32', native: reg({ AccentColor: 0xffd47800 }) }), '#0078d4');
  assert.deepStrictEqual(reads, ['AccentColor'], 'the DWM accent first');
  assert.strictEqual(readAccentColor({ platform: 'win32', native: reg({ AccentColorMenu: 0xff2b1cc4 }) }), '#c41c2b', 'then the Explorer accent');
  assert.strictEqual(readAccentColor({ platform: 'win32', native: reg({}) }), null, 'neither: null (main falls back to Electron)');
  assert.strictEqual(readAccentColor({ platform: 'win32', native: { readDword: () => { throw new Error('no advapi32'); } } }), null, 'never throws');
  assert.strictEqual(readAccentColor({ platform: 'darwin', native: reg({ AccentColor: 1 }) }), null);
}

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
assert.ok(/function showPopup\(\)[\s\S]{0,2800}win\.setPosition\(px, motion === 'none' \? py : py \+ POPUP_SLIDE_PX\);[\s\S]{0,200}const reveal = \(\) => \{[\s\S]{0,260}const fade = motion === 'fade' && beginPopupFade\(\);\s*unparkPopup\(\);[\s\S]{0,200}slidePopupInto\(px, py, \{ fade \}\)/.test(main),
  'show moves the cloaked window, sets a solid window\'s alpha to 0 while still cloaked, then unparks, then slides (+ fades)');
// The motion per open (plan I): glass on Windows never fades (a layered window
// drops the acrylic), macOS and solid Windows fade (recorded clean on screen
// 2026-10-08; BOARDCLIP_SOLID_FADE=0 turns it off), reduced motion does neither.
{
  const at = main.indexOf('function popupOpenMotion()');
  const motion = main.slice(at, main.indexOf('\n}\n', at));
  assert.ok(/getAnimationSettings\(\)[\s\S]{0,120}prefersReducedMotion[\s\S]{0,80}return 'none'/.test(motion), 'reduced motion skips the open animation');
  assert.ok(/process\.platform === 'darwin'\) return 'fade'/.test(motion), 'macOS fades (window alpha; vibrancy survives)');
  assert.ok(/return glassOn\(\) \|\| !solidFadeEnabled\(\) \? 'slide' : 'fade';/.test(motion), 'Windows: glass slides only, solid fades only when enabled');
  assert.ok(/function solidFadeEnabled\(\) \{\s*return process\.env\.BOARDCLIP_SOLID_FADE !== '0';\s*\}/.test(main), 'the Windows Solid fade is on by default (recorded clean), BOARDCLIP_SOLID_FADE=0 turns it off');
  assert.ok(/function setPopupAlpha[\s\S]{0,200}windowsDwm\.setWindowAlpha\(win, alpha\)[\s\S]{0,80}win\.setOpacity\(alpha\)/.test(main), 'Windows alpha goes through windows-dwm, macOS through setOpacity');
  assert.ok(/function endPopupFade[\s\S]{0,300}windowsDwm\.clearLayered\(win\)[\s\S]{0,250}win\.setOpacity\(1\)/.test(main), 'the fade always ends opaque and, on Windows, no longer layered');
  assert.ok(/else \{\s*popupSlideTarget = null;\s*if \(fade\) endPopupFade\(\);/.test(main), 'the finished slide ends the fade');
  assert.ok(/win\.hide\(\); \/\/ the 'hide' event runs onPopupClosed\s*\}\s*endPopupFade\(\);/.test(main), 'a close mid-fade ends it once the window is parked / hidden');
  assert.ok(/function settlePopupSlide[\s\S]{0,250}endPopupFade\(\);/.test(main), 'a drag that settles the slide ends the fade');
  const show = main.slice(main.indexOf('function showPopup()'), main.indexOf('function setClipboardToItem('));
  assert.ok(!/\bwin\.setOpacity\(/.test(show), 'showPopup never sets the opacity directly (setPopupAlpha / endPopupFade own it)');
  // Anywhere else neither: Electron's setOpacity on Windows would leave the
  // window layered for good (lib/windows-dwm.js setWindowAlpha).
  assert.strictEqual(main.split('win.setOpacity(').length - 1, 2, 'win.setOpacity only in setPopupAlpha (macOS) and endPopupFade (macOS)');
  assert.ok(/if \(fade\) setPopupAlpha\(eased\);/.test(main), 'the slide steps the alpha through setPopupAlpha');
  assert.ok(/const fade = process\.platform === 'darwin' && motion === 'fade' && beginPopupFade\(\);/.test(show), 'macOS: the plain-show path fades + slides');
}
assert.ok(/win\.on\('blur'[\s\S]{0,200}!isPopupOpen\(\)\) return;/.test(main), 'a blur after parking does not run the close path again');
for (const fn of ['startClickAwayWatcher', 'runNumpadSlotAction']) {
  const body = main.slice(main.indexOf(`function ${fn}`), main.indexOf('\n}\n', main.indexOf(`function ${fn}`)));
  assert.ok(body.length > 50, fn);
  assert.ok(!/\bwin\.isVisible\(\)/.test(body), `${fn} must use isPopupOpen(), not win.isVisible()`);
}

console.log('windows-dwm tests passed');
