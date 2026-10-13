'use strict';

// Where a clip window opens (lib/window-placement.js). Owner 2026-10-13:
// "spawns under BC itself" (a window opened while the popup stays up sat under
// the always-on-top popup) and "multi spawning they dont stack, it jsut all
// sits on top" (every editor opened at the one saved spot).

const assert = require('assert');
const { placeClipWindowBounds, rectsOverlap, CASCADE_STEP } = require('../lib/window-placement');

const area = { x: 0, y: 0, width: 1920, height: 1040 };
const editor = { x: 300, y: 200, width: 560, height: 520 };

// 1. Nothing open: the saved spot.
assert.deepStrictEqual(placeClipWindowBounds(editor, { area }), editor, 'alone, a window opens where it was last left');

// 2. A window already at the saved spot: one cascade step on; a second one, two.
const one = placeClipWindowBounds(editor, { area, taken: [{ x: 300, y: 200 }] });
assert.deepStrictEqual([one.x, one.y], [300 + CASCADE_STEP, 200 + CASCADE_STEP], 'the second window cascades one step');
const two = placeClipWindowBounds(editor, { area, taken: [{ x: 300, y: 200 }, { x: one.x, y: one.y }] });
assert.deepStrictEqual([two.x, two.y], [300 + 2 * CASCADE_STEP, 200 + 2 * CASCADE_STEP], 'the third, two steps');

// 3. A window somewhere else does not move the new one.
const elsewhere = placeClipWindowBounds(editor, { area, taken: [{ x: 900, y: 100 }] });
assert.deepStrictEqual([elsewhere.x, elsewhere.y], [300, 200], 'only a window at the same spot pushes it on');

// 4. The cascade wraps inside the work area: every window stays fully on screen
// and no two share a spot, however many are open.
{
  const taken = [];
  for (let i = 0; i < 40; i += 1) {
    const b = placeClipWindowBounds(editor, { area, taken });
    assert.ok(b.x >= area.x && b.y >= area.y && b.x + b.width <= area.x + area.width && b.y + b.height <= area.y + area.height, `window ${i} on screen: ${JSON.stringify(b)}`);
    assert.ok(!taken.some((t) => t.x === b.x && t.y === b.y), `window ${i} has its own spot`);
    taken.push({ x: b.x, y: b.y });
  }
}

// 5. The popup stays up and the saved spot is under it: beside it, never under.
const popup = { x: 250, y: 150, width: 460, height: 520 };
const beside = placeClipWindowBounds(editor, { area, avoid: popup });
assert.ok(!rectsOverlap(beside, popup), `not under the popup: ${JSON.stringify(beside)}`);
assert.strictEqual(beside.x, popup.x + popup.width + 8, 'right of the popup when there is room');

// 6. No room on the right (popup at the screen's right edge): left of it, and
// several fan out away from the popup.
{
  const right = { x: 1440, y: 300, width: 460, height: 520 };
  const taken = [];
  for (let i = 0; i < 3; i += 1) {
    const b = placeClipWindowBounds({ ...editor, x: 1400, y: 300 }, { area, taken, avoid: right });
    assert.ok(!rectsOverlap(b, right), `window ${i} not under the popup: ${JSON.stringify(b)}`);
    assert.ok(b.x + b.width <= right.x, `window ${i} left of the popup`);
    taken.push({ x: b.x, y: b.y });
  }
}

// 7. The saved spot is clear of the popup: it is used as is.
const clear = placeClipWindowBounds({ ...editor, x: 1000, y: 200 }, { area, avoid: popup });
assert.deepStrictEqual([clear.x, clear.y], [1000, 200], 'a spot clear of the popup is kept');

// 8. No saved spot: centred on the work area (of the display main picked).
const centred = placeClipWindowBounds({ width: 560, height: 520 }, { area: { x: 1920, y: 0, width: 2560, height: 1400 } });
assert.deepStrictEqual([centred.x, centred.y], [1920 + 1000, 440], 'no saved spot = centred on that display');

// 9. A saved spot half off the work area is pulled back on.
const off = placeClipWindowBounds({ ...editor, x: 1700, y: 900 }, { area });
assert.ok(off.x + off.width <= 1920 && off.y + off.height <= 1040, 'pulled fully on screen');

// 10. Beside the popup, however many open: none ever lands under it.
{
  const mid = { x: 700, y: 260, width: 460, height: 520 };
  const taken = [];
  for (let i = 0; i < 30; i += 1) {
    const b = placeClipWindowBounds({ ...editor, x: 700, y: 260 }, { area, taken, avoid: mid });
    assert.ok(!rectsOverlap(b, mid), `window ${i} not under the popup: ${JSON.stringify(b)}`);
    taken.push({ x: b.x, y: b.y });
  }
}

console.log('window-placement tests passed');
