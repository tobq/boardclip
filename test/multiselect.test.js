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

// 6) + 7) Open-in-editor gestures (async): wrapped in an async IIFE so the CJS
//    file can use await without becoming a top-level ES module.
(async () => {
  // 6) alt+click and middle-click (onAuxclick) on a clip row call editClip;
  //    image rows call openImage; inner controls are not intercepted.
  {
    const textItem = { id: 'txt1', type: 'text', text: 'hello' };
    const imgItem  = { id: 'img1', type: 'image' };
    const byId = { txt1: textItem, img1: imgItem };
    let lastEdit = null;
    let lastOpen = null;
    const c = ui.createClipController({
      itemById: (id) => byId[id],
      visibleIds: () => ['txt1', 'img1'],
      renderSelection: () => {},
      render() {},
      refresh() {},
      editClip: async (id) => { lastEdit = id; },
      openImage: async (item) => { lastOpen = item; },
    });

    // Helper: minimal fake event + DOM surface the controller needs.
    function makeEvent(opts) {
      const { button = 0, altKey = false, ctrlKey = false, metaKey = false, shiftKey = false, targetId, targetIsButton = false } = opts;
      const row = targetId ? { dataset: { id: targetId }, closest(sel) { return sel === '.item' ? this : null; } } : null;
      // inner control — returns itself on the "button|..." guard selector
      const inner = targetIsButton ? { closest(sel) { return /button/.test(sel) ? this : null; } } : null;
      const t = inner || {
        closest(sel) {
          if (sel === '.item') return row;
          return null; // not an inner control
        },
      };
      return { button, altKey, ctrlKey, metaKey, shiftKey, target: t, preventDefault() {}, stopPropagation() {} };
    }

    // (a) Alt+click on text row -> editClip
    lastEdit = null;
    await c.onClick(makeEvent({ altKey: true, targetId: 'txt1' }));
    assert.strictEqual(lastEdit, 'txt1', 'alt+click on text row calls editClip');

    // (b) Alt+click on image row -> openImage
    lastOpen = null;
    await c.onClick(makeEvent({ altKey: true, targetId: 'img1' }));
    assert.deepStrictEqual(lastOpen, imgItem, 'alt+click on image row calls openImage');

    // (c) Middle-click (button=1) on text row -> editClip
    lastEdit = null;
    await c.onAuxclick(makeEvent({ button: 1, targetId: 'txt1' }));
    assert.strictEqual(lastEdit, 'txt1', 'middle-click on text row calls editClip');

    // (d) Middle-click on image row -> openImage
    lastOpen = null;
    await c.onAuxclick(makeEvent({ button: 1, targetId: 'img1' }));
    assert.deepStrictEqual(lastOpen, imgItem, 'middle-click on image row calls openImage');

    // (e) Non-middle auxclick (button=2 = right) is ignored
    lastEdit = null;
    await c.onAuxclick(makeEvent({ button: 2, targetId: 'txt1' }));
    assert.strictEqual(lastEdit, null, 'right-auxclick is ignored');

    // (f) Alt+click on an inner control (button) is NOT intercepted
    lastEdit = null;
    await c.onClick(makeEvent({ altKey: true, targetId: 'txt1', targetIsButton: true }));
    assert.strictEqual(lastEdit, null, 'alt+click on an inner button is not intercepted');
  }

  // 7) Ctrl+Enter / Alt+Enter on focused clip -> editClip; on image -> openImage.
  {
    const textItem = { id: 'ta', type: 'text', text: 'test' };
    const imgItem  = { id: 'ia', type: 'image' };
    const byId2 = { ta: textItem, ia: imgItem };
    let lastEdit2 = null;
    let lastOpen2 = null;
    const c2 = ui.createClipController({
      itemById: (id) => byId2[id],
      visibleIds: () => ['ta', 'ia'],
      renderSelection: () => {},
      render() {},
      refresh() {},
      editClip: async (id) => { lastEdit2 = id; },
      openImage: async (item) => { lastOpen2 = item; },
    });
    function makeKey(opts) {
      const { key, ctrlKey = false, metaKey = false, altKey = false, shiftKey = false } = opts;
      return {
        key, ctrlKey, metaKey, altKey, shiftKey,
        target: { tagName: 'DIV', value: '', closest: () => null },
        preventDefault() {}, stopPropagation() {},
      };
    }

    // toggle() sets focusId (and selectedIds). The Ctrl+Enter branch uses focusId
    // directly - no need to clear selection first.
    c2.toggle('ta');
    lastEdit2 = null;
    await c2.onKeydown(makeKey({ key: 'Enter', ctrlKey: true }));
    assert.strictEqual(lastEdit2, 'ta', 'Ctrl+Enter on focused text clip calls editClip');

    // Move focus to image clip
    c2.toggle('ia');
    lastOpen2 = null;
    await c2.onKeydown(makeKey({ key: 'Enter', altKey: true }));
    assert.deepStrictEqual(lastOpen2, imgItem, 'Alt+Enter on focused image clip calls openImage');
  }

  console.log('multiselect.test.js: all multi-select guards passed');
})().catch((err) => { console.error(err); process.exitCode = 1; });
