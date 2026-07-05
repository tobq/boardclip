'use strict';

// Unit guards for the multi-select logic that lives in the shared core: the
// tri-state group membership helper, the lifted selection state in
// createClipController (toggle / range / select-all / move / clear), and the
// bulk-menu tri-state rendering. Pure logic — runs headless in Node (the shared
// dialogs/menu degrade to no-ops when there's no document).

const assert = require('assert');
const ui = require('../site/shared/clipboard-ui-core');

// 1) groupMembership: all / some / none across a selection.
{
  const A = { id: 'a', pin: { groups: ['x', 'y'] } };
  const B = { id: 'b', pin: { groups: ['x'] } };
  const C = { id: 'c', pin: null };
  assert.strictEqual(ui.groupMembership([A, B], 'x'), 'all');
  assert.strictEqual(ui.groupMembership([A, B], 'y'), 'some');
  assert.strictEqual(ui.groupMembership([A, B, C], 'x'), 'some');
  assert.strictEqual(ui.groupMembership([C], 'x'), 'none');
  assert.strictEqual(ui.groupMembership([], 'x'), 'none');
}

// 2) Controller selection state: toggle, shift-range (over visibleIds), image
//    detection, select-all, plain move clears the multi-set, clear resets focus.
{
  const items = [
    { id: 'a', type: 'text' },
    { id: 'b', type: 'text' },
    { id: 'c', type: 'image' },
    { id: 'd', type: 'text' },
  ];
  const byId = Object.fromEntries(items.map((i) => [i.id, i]));
  let painted = null;
  const c = ui.createClipController({
    itemById: (id) => byId[id],
    visibleIds: () => items.map((i) => i.id),
    renderSelection: (state) => { painted = state; },
    render() {},
    refresh() {},
  });

  c.toggle('b');
  assert.deepStrictEqual(c.selection().ids, ['b'], 'toggle selects one');
  assert.strictEqual(c.focusedId(), 'b', 'toggle sets focus');

  c.selectRange('d'); // anchor b .. d
  assert.deepStrictEqual(c.selection().ids.slice().sort(), ['b', 'c', 'd'], 'shift-range fills anchor..target');
  assert.strictEqual(c.selection().hasImage, true, 'range includes the image row -> hasImage');

  c.toggle('b'); // remove b
  assert.ok(!c.selection().ids.includes('b'), 'toggle removes an already-selected id');

  c.selectAll();
  assert.strictEqual(c.selection().count, 4, 'select-all selects every visible id');

  c.moveFocus(1); // plain move clears the multi-set and advances focus
  assert.strictEqual(c.selection().count, 0, 'plain arrow move clears the multi-selection');
  assert.strictEqual(c.focusedId(), 'd', 'focus clamps to the last row');

  c.clearSelection();
  assert.strictEqual(c.selection().count, 0);
  assert.strictEqual(c.focusedId(), null, 'clearSelection drops the focus cursor too');
  assert.ok(painted, 'renderSelection hook was driven');
}

// 3) Bulk group tree renders tri-state classes (all -> assigned, some -> partial).
{
  const sel = [
    { id: 'a', pin: { groups: ['Work'] } },
    { id: 'b', pin: { groups: ['Work', 'Ideas'] } },
  ];
  const menu = ui.renderBulkMenu({ count: 2, hasImage: false }, { groups: ['Work', 'Ideas'], selectedItems: sel });
  assert.ok(menu.includes('assigned'), 'Work is in ALL selected -> assigned (check) state');
  assert.ok(menu.includes('partial'), 'Ideas is in SOME selected -> partial (dash) state');
  assert.ok(menu.includes('data-action="bulk-group" data-group="Work"'), 'bulk group nodes carry data-action + data-group');
}

// 4) diffLineHunks: the shared line diff behind the IntelliJ-style merge panes.
{
  const segs = ui.diffLineHunks('a\nb\nc\nd', 'a\nX\nY\nc\nd');
  assert.deepStrictEqual(segs.map((s) => s.type), ['same', 'change', 'same'], 'prefix/suffix trim yields same-change-same');
  assert.deepStrictEqual(segs[1].leftLines, ['b']);
  assert.deepStrictEqual(segs[1].rightLines, ['X', 'Y']);
  // Reconstruction: taking one side across all segments reproduces that input.
  const take = (side) => segs.flatMap((s) => s.type === 'same' ? s.lines : s[`${side}Lines`]).join('\n');
  assert.strictEqual(take('left'), 'a\nb\nc\nd');
  assert.strictEqual(take('right'), 'a\nX\nY\nc\nd');
  // Identical inputs -> one same segment; pure insertion -> one-sided change
  assert.deepStrictEqual(ui.diffLineHunks('x\ny', 'x\ny').map((s) => s.type), ['same']);
  const ins = ui.diffLineHunks('a\nc', 'a\nb\nc').find((s) => s.type === 'change');
  assert.deepStrictEqual(ins.leftLines, [], 'insertion has empty left side');
  assert.deepStrictEqual(ins.rightLines, ['b']);
}

// 5) Whitespace-insensitive matching (default ON): CRLF vs LF, trailing spaces,
//    and indentation must NOT defeat the diff (the all-green-panes bug: clips of
//    the same text copied from different sources matched zero lines).
{
  const crlf = ui.diffLineHunks('a \r\nb\r\nc', 'a\nb\nc plus');
  assert.deepStrictEqual(crlf.map((s) => s.type), ['same', 'change'], 'CRLF + trailing space still matches');
  assert.deepStrictEqual(crlf[0].leftLines, ['a ', 'b'], 'same segs keep the LEFT originals');
  assert.deepStrictEqual(crlf[0].rightLines, ['a', 'b'], 'same segs keep the RIGHT originals too');
  // exact mode (toggle OFF) treats the trailing space as a real difference
  const exact = ui.diffLineHunks('a \nb', 'a\nb', { ignoreWhitespace: false });
  assert.strictEqual(exact[0].type, 'change', 'exact mode sees whitespace differences');
  // union merge (the Unify seed + "Keep both"): shared region once, both tails
  const union = ui.unionMergeText('intro\nshared\nleft tail', 'intro\nshared\nright tail');
  assert.strictEqual(union, 'intro\nshared\nleft tail\nright tail', 'union keeps shared once + both sides of changes');
  assert.strictEqual(ui.unionMergeText('same\ntext', 'same\ntext'), 'same\ntext', 'identical inputs union to themselves');
}

console.log('multiselect.test.js: all multi-select guards passed');
