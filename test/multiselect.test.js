'use strict';

// Unit guards for the multi-select logic that lives in the shared core: the
// tri-state group membership helper, the lifted selection state in
// createClipController (toggle / range / select-all / move / clear), and the
// bulk-menu tri-state rendering. Pure logic — runs headless in Node (the shared
// dialogs/menu degrade to no-ops when there's no document).

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const ui = require('../site/shared/clipboard-ui-core');
const read = (rel) => fs.readFileSync(path.join(__dirname, '..', rel), 'utf8');

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
  assert.strictEqual(c.focusedId(), 'b', 'select-all keeps the cursor where it was (never jumps to the last row)');

  c.moveFocus(1); // plain move clears the multi-set and advances focus
  assert.strictEqual(c.selection().count, 0, 'plain arrow move clears the multi-selection');
  assert.strictEqual(c.focusedId(), 'c', 'plain move advances from the kept cursor');

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
  // smartMergeChunk: what the automatic merge ("Merge & continue", the toolbar
  // merge-all) does with a 2-way chunk, line by line. Adds and rewords are
  // taken; lines Incoming only lacks are kept (a stale copy looks exactly like
  // that); only unrelated lines colliding are left for a person.
  const smart = (a, b) => ui.smartMergeChunk(a, b);
  assert.deepStrictEqual(smart('', 'new paragraph'), { verdict: 'apply', text: 'new paragraph' }, 'insertion is taken');
  assert.strictEqual(smart('ship the beta friday', 'ship the beta on monday').text, 'ship the beta on monday', 'a reworded line is taken');
  assert.strictEqual(smart('coder friends: alex, dan', 'coder friends: alex, dan, tanin\nhamza+angela').verdict, 'apply', 'a grown block is taken');
  assert.deepStrictEqual(smart('tobi lutke - recording screen\nencode office', ''), { verdict: 'keep', text: null }, 'incoming merely lacking lines never deletes them');
  assert.deepStrictEqual(smart('qa KEEPME line\nqa spacer\n', 'qa spacer\nqa incoming BETA\n'), { verdict: 'apply', text: 'qa KEEPME line\nqa spacer\nqa incoming BETA\n' },
    'a lacked line and an addition in one chunk merge as a union');
  assert.strictEqual(smart('use typesafe.ai launch as a reference', 'deep research into the launch of Jev and Instinct').verdict, 'conflict', 'unrelated replacement is a decision');
  assert.strictEqual(smart('kept line\nonly in result', 'kept line, reworded').verdict, 'conflict', 'a line with no counterpart is a decision');
  // losslessChange: what "Merge & continue" may pull into a Unify Result on its
  // own - insertions and grown lines yes, rewordings no.
  assert.strictEqual(ui.losslessChange('', 'new paragraph'), true, 'pure insertion is lossless');
  assert.strictEqual(ui.losslessChange('(due to extra', '(due to extra context usage deteriorating perf'), true, 'a grown line is lossless');
  assert.strictEqual(ui.losslessChange('one\ntwo', 'one\ntwo\nthree'), true, 'appended lines are lossless');
  assert.strictEqual(ui.losslessChange('one  \n\ntwo', 'one\ntwo more'), true, 'whitespace differences do not count');
  assert.strictEqual(ui.losslessChange('the old wording', 'a new wording'), false, 'a rewording is a decision');
  assert.strictEqual(ui.losslessChange('kept\ndropped', 'kept'), false, 'a removed line is a decision');
  assert.strictEqual(ui.losslessChange('something', ''), false, 'incoming blank never replaces text');
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
    let lastEditOpts = null;
    let lastOpenOpts = null;
    const c = ui.createClipController({
      itemById: (id) => byId[id],
      visibleIds: () => ['txt1', 'img1'],
      renderSelection: () => {},
      render() {},
      refresh() {},
      editClip: async (id, _el, options) => { lastEdit = id; lastEditOpts = options || null; },
      openImage: async (item, options) => { lastOpen = item; lastOpenOpts = options || null; },
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
    assert.deepStrictEqual(lastEditOpts, { keepPopup: true }, 'alt+click keeps the popup open (mouse-driven open)');

    // (b) Alt+click on image row -> openImage
    lastOpen = null;
    await c.onClick(makeEvent({ altKey: true, targetId: 'img1' }));
    assert.deepStrictEqual(lastOpen, imgItem, 'alt+click on image row calls openImage');
    assert.deepStrictEqual(lastOpenOpts, { keepPopup: true }, 'alt+click on an image keeps the popup open');

    // (c) Middle-click (button=1) on text row -> editClip
    lastEdit = null;
    await c.onAuxclick(makeEvent({ button: 1, targetId: 'txt1' }));
    assert.strictEqual(lastEdit, 'txt1', 'middle-click on text row calls editClip');
    assert.deepStrictEqual(lastEditOpts, { keepPopup: true }, 'middle-click keeps the popup open (mouse-driven open)');

    // (d) The row's primary open button (data-action=edit, NOT inside the menu) is
    //     the normal open: a hand-off with no keepPopup. The same action fired from
    //     a detached menu item keeps the popup.
    function makeActionEvent(action, { fromMenu = false, id = 'txt1' } = {}) {
      const row = { dataset: { id }, closest(sel) { return sel === '.item' ? this : null; } };
      const btn = { dataset: { id }, closest(sel) {
        if (sel === `[data-action="${action}"]`) return this;
        if (sel === '.item') return row;
        if (sel === '.bc-menu-item') return fromMenu ? this : null;
        return null;
      } };
      return { button: 0, target: btn, preventDefault() {}, stopPropagation() {} };
    }
    lastEdit = null; lastEditOpts = null;
    await c.onClick(makeActionEvent('edit'));
    assert.strictEqual(lastEdit, 'txt1', 'row edit button opens the editor');
    assert.strictEqual(lastEditOpts, null, 'row edit button is a hand-off (no keepPopup)');
    lastEdit = null; lastEditOpts = null;
    await c.onClick(makeActionEvent('edit', { fromMenu: true }));
    assert.strictEqual(lastEdit, 'txt1', 'menu Open in editor opens the editor');
    assert.deepStrictEqual(lastEditOpts, { keepPopup: true }, 'menu Open in editor keeps the popup');
    lastOpen = null; lastOpenOpts = null;
    await c.onClick(makeActionEvent('open-img', { id: 'img1' }));
    assert.deepStrictEqual(lastOpen, imgItem, 'row open-image button opens the viewer');
    assert.strictEqual(lastOpenOpts, null, 'row open-image button is a hand-off');
    lastOpen = null; lastOpenOpts = null;
    await c.onClick(makeActionEvent('open-img', { id: 'img1', fromMenu: true }));
    assert.deepStrictEqual(lastOpenOpts, { keepPopup: true }, 'menu Open image keeps the popup');

    // (e) Middle-click = armed mousedown (default prevented: no autoscroll widget)
    //     + in-place mouseup on the same row -> open with keepPopup. A dragged
    //     release (autoscroll gesture) opens nothing; a stray auxclick right after
    //     a mouseup-open is swallowed; auxclick with no prior mousedown still opens
    //     (fallback for consumers that do not route mousedown).
    let prevented = 0;
    const mk = (button, targetIsButton, x, y) => { const e = makeEvent({ button, targetId: 'txt1', targetIsButton }); e.clientX = x; e.clientY = y; e.preventDefault = () => { prevented++; }; return e; };
    assert.strictEqual(c.onMousedown(mk(1, false, 10, 10)), true, 'middle mousedown on a row is armed');
    assert.strictEqual(prevented, 1, 'middle mousedown default (autoscroll) is prevented');
    lastEdit = null; lastEditOpts = null;
    assert.strictEqual(await c.onMouseup(mk(1, false, 12, 11)), true, 'in-place middle mouseup opens');
    assert.strictEqual(lastEdit, 'txt1', 'middle mouseup opened the editor');
    assert.deepStrictEqual(lastEditOpts, { keepPopup: true }, 'middle-click keeps the popup');
    lastEdit = null;
    assert.strictEqual(await c.onAuxclick(mk(1, false, 12, 11)), true, 'auxclick right after the mouseup-open is swallowed');
    assert.strictEqual(lastEdit, null, 'no double open from the trailing auxclick');
    c.onMousedown(mk(1, false, 10, 10));
    lastEdit = null;
    assert.strictEqual(await c.onMouseup(mk(1, false, 10, 200)), false, 'a dragged middle release opens nothing');
    assert.strictEqual(lastEdit, null, 'drag did not open');
    assert.strictEqual(c.onMousedown(mk(0, false, 10, 10)), false, 'left mousedown passes through');
    assert.strictEqual(c.onMousedown(mk(1, true, 10, 10)), false, 'middle mousedown on an inner control passes through');
    assert.strictEqual(await c.onMouseup(mk(1, false, 10, 10)), false, 'mouseup without an armed press does nothing');

    // (f) The row's OWN open button: right-click and middle-click open with
    //     keepPopup and never fall through to the row context menu.
    const OPEN_BTN_SEL = '[data-action="edit"], [data-action="open-img"]';
    function makeOpenBtnEvent(button, action, id) {
      const row = { dataset: { id }, closest(sel) { return sel === '.item' ? this : null; } };
      const btn = { dataset: { id }, closest(sel) { if (sel === OPEN_BTN_SEL || sel === `[data-action="${action}"]`) return this; if (sel === '.item') return row; if (/button/.test(sel)) return this; return null; } };
      let prevented = false;
      const e = { button, clientX: 5, clientY: 5, target: btn, preventDefault() { prevented = true; }, stopPropagation() {} };
      e.wasPrevented = () => prevented;
      return e;
    }
    lastEdit = null; lastEditOpts = null;
    let rc = makeOpenBtnEvent(2, 'edit', 'txt1');
    assert.strictEqual(await c.onContextmenu(rc), true, 'right-click on the open button is handled');
    assert.ok(rc.wasPrevented(), 'right-click on the open button suppresses the context menu');
    assert.strictEqual(lastEdit, 'txt1', 'right-click on the open button opens the editor');
    assert.deepStrictEqual(lastEditOpts, { keepPopup: true }, 'right-click on the open button keeps the popup');
    lastOpen = null; lastOpenOpts = null;
    rc = makeOpenBtnEvent(2, 'open-img', 'img1');
    await c.onContextmenu(rc);
    assert.deepStrictEqual(lastOpen, imgItem, 'right-click on the image open button opens the viewer');
    assert.deepStrictEqual(lastOpenOpts, { keepPopup: true }, 'and keeps the popup');
    lastEdit = null; lastEditOpts = null;
    assert.strictEqual(c.onMousedown(makeOpenBtnEvent(1, 'edit', 'txt1')), true, 'middle mousedown on the open button arms');
    assert.strictEqual(await c.onMouseup(makeOpenBtnEvent(1, 'edit', 'txt1')), true, 'middle mouseup on the open button opens');
    assert.deepStrictEqual(lastEditOpts, { keepPopup: true }, 'middle-click on the open button keeps the popup');
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

  // A focused control (the options toggle, a panel chip, a row button) keeps its
  // native Enter / Space activation: the list keys never paste a clip from it.
  {
    const activated = [];
    const c3 = ui.createClipController({
      itemById: (id) => ({ id, type: 'text', text: id }),
      visibleIds: () => ['a', 'b'],
      renderSelection: () => {},
      render() {},
      refresh() {},
      activateClip: (id) => { activated.push(id); },
    });
    const key = (k, target) => {
      const ev = { key: k, ctrlKey: false, metaKey: false, altKey: false, shiftKey: false, target, prevented: false,
        preventDefault() { this.prevented = true; }, stopPropagation() {} };
      return ev;
    };
    const button = { tagName: 'BUTTON', closest: (sel) => (/\bbutton\b/.test(sel) ? button : null) };
    const field = { tagName: 'INPUT', value: '', closest: () => null };
    let ev = key('Enter', button);
    await c3.onKeydown(ev);
    assert.deepStrictEqual(activated, [], 'Enter on a focused button never pastes a clip');
    assert.strictEqual(ev.prevented, false, 'Enter on a focused button keeps its native activation');
    c3.toggle('a');
    ev = key(' ', button);
    await c3.onKeydown(ev);
    assert.strictEqual(ev.prevented, false, 'Space on a focused button keeps its native activation');
    assert.deepStrictEqual(c3.selection().ids, ['a'], 'Space on a focused button does not toggle the selection');
    c3.clearSelection();
    ev = key('Enter', field);
    await c3.onKeydown(ev);
    assert.deepStrictEqual(activated, ['a'], 'Enter in the search field still pastes the first clip');
    assert.strictEqual(ev.prevented, true);
  }

  // 9) Similar clips (D2): whitespace-collapsed, case-insensitive containment in
  //    either direction, both sides >= 12 chars, images and the clip itself
  //    excluded; a long target uses its 12-gram table (same answers), a clip
  //    too big to normalise is searched through its lowercase text in chunks.
  {
    const T = (id, text) => ({ id, type: 'text', text });
    const target = T('t', 'The quick brown fox jumps');
    const items = [
      target,
      T('wider', 'Preface. the   QUICK brown\nfox\tjumps over the lazy dog'), // contains the target
      T('inside', 'quick brown fox'),                                          // contained in the target
      T('short', 'brown fox'),                                                 // < 12 chars: never
      T('other', 'an unrelated note about lunch'),
      { id: 'img', type: 'image', text: 'The quick brown fox jumps' },
      T('t', 'The quick brown fox jumps'),                                     // same id as the target
      T('copy', '  the quick brown fox jumps  '),                              // identical once normalised
    ];
    assert.deepStrictEqual(ui.similarClipIds(target, items), ['wider', 'inside', 'copy'], 'containment both ways, ws/case-insensitive, >= 12 chars, no images, not itself');
    assert.deepStrictEqual(ui.similarClipIds({ id: 'x', type: 'text', text: 'tiny' }, items), [], 'a target under 12 chars has none');
    assert.deepStrictEqual(ui.similarClipIds({ id: 'i', type: 'image' }, items), [], 'an image target has none');
    assert.strictEqual(ui.similarText(items[1]), 'preface. the quick brown fox jumps over the lazy dog', 'normalised: whitespace collapsed + lowercase');
    assert.strictEqual(ui.similarText(items[1]), ui.similarText(items[1]), 'cached per item object');
    // A long target (>= 1024 chars) answers through its 12-gram table: the same
    // set as a plain scan, including a clip at its very end.
    const words = Array.from({ length: 400 }, (_, i) => `w${i}x`).join(' ');
    const longTarget = T('long', words);
    const pool = [longTarget, T('head', words.slice(0, 60)), T('tail', words.slice(-40)), T('mid', words.slice(700, 760)), T('miss', 'w1x w3x w2x w4x w5x w6x'), T('sup', `${words} and more`)];
    const expectIds = pool.filter((it) => it !== longTarget).filter((it) => {
      const n = (s) => s.toLowerCase().replace(/\s+/g, ' ').trim();
      const a = n(it.text);
      const b = n(longTarget.text);
      return a.length >= 12 && (a.includes(b) || b.includes(a));
    }).map((it) => it.id);
    assert.deepStrictEqual(ui.similarClipIds(longTarget, pool), expectIds, 'the 12-gram table gives the same answers as a plain scan');
    assert.ok(expectIds.includes('tail') && expectIds.includes('sup') && !expectIds.includes('miss'), 'sanity: the long-target fixture covers the end and a superset');
    // A clip over SIMILAR_MAX_CHARS: only "contains the target", through lowerOf, with any whitespace.
    const filler = 'z'.repeat(ui.SIMILAR_MAX_CHARS + 10);
    const huge = T('huge', `${filler} THE QUICK\n\nbrown fox   jumps ${filler}`);
    let asked = 0;
    const lowerOf = (it) => { asked += 1; return it.text.toLowerCase(); };
    assert.deepStrictEqual(ui.similarClipIds(target, [huge], { lowerOf }), ['huge'], 'a huge clip containing the target is found');
    assert.ok(asked === 1, 'the huge clip is read through lowerOf (the host\'s lowercase haystack)');
    assert.deepStrictEqual(ui.similarClipIds(huge, items), [], 'a huge target is never scanned against every clip');
    assert.ok(!/similarClipIds|similarText/.test(read('index.html') + read('site/index.html')), 'the consumers never run the similar scan themselves (the controller owns it)');
  }

  // 10) "Select N similar": the menu shows the count (a placeholder while it is
  //     being counted, nothing when 0), the action multi-selects the clip + its
  //     similar clips so Unify is one click; hidden ones clear the search first.
  {
    const T = (id, text) => ({ id, type: 'text', text });
    const items = [T('a', 'meeting notes for the launch'), T('b', 'Meeting notes for the launch, v2 with owners'), T('c', 'notes for the launch'), T('d', 'nothing alike at all here'), { id: 'e', type: 'image' }];
    const byId = Object.fromEntries(items.map((i) => [i.id, i]));
    let visible = ['a', 'b', 'd'];
    let cleared = 0;
    const c = ui.createClipController({
      itemById: (id) => byId[id],
      visibleIds: () => visible,
      allItems: () => items,
      renderSelection: () => {},
      render() {},
      refresh() {},
      clearFilters: () => { cleared += 1; visible = items.map((i) => i.id); },
    });
    const set = await new Promise((resolve) => c.whenSimilar('a', resolve));
    assert.deepStrictEqual([...set].sort(), ['b', 'c'], 'similar set over ALL items (c is outside the current results)');
    c.selectSimilar('a');
    assert.strictEqual(cleared, 1, 'a similar clip outside the results clears the search first');
    assert.deepStrictEqual(c.selection().ids.slice().sort(), ['a', 'b', 'c'], 'the clip + its similar clips are multi-selected');
    assert.strictEqual(c.selection().hasImage, false, 'all text -> the selection bar offers Unify');
    assert.strictEqual(c.focusedId(), 'a', 'the cursor stays on the clip');
    const none = await new Promise((resolve) => c.whenSimilar('d', resolve));
    assert.strictEqual(none.size, 0);
    const menuFor = (count) => ui.renderClipMenu(items[0], { items, groups: [], numpadMap: {}, similarCount: count });
    assert.ok(/data-action="select-similar"[^>]*>.*Select 2 similar/.test(menuFor(2)), 'menu: Select N similar');
    assert.ok(!menuFor(0).includes('select-similar') && !menuFor(undefined).includes('select-similar'), 'menu: no row when there are none (or for images / other windows)');
    assert.ok(/data-action="select-similar"[^>]*disabled aria-busy="true"/.test(menuFor(null)), 'menu: a disabled placeholder while counting');
    // The hover / cursor target paints the set on the next selection paint.
    c.clearSelection();
    c.moveFocus(1); // keyboard cursor onto the first visible row ('a')
    await new Promise((r) => setTimeout(r, 220));
    assert.strictEqual(c.similar().target, 'a', 'the keyboard cursor row is the similar target');
    assert.deepStrictEqual(c.similar().ids.sort(), ['b', 'c'], 'its similar set is painted (cached)');
    c.onMouseover({ target: { closest: (sel) => (sel === '.item' ? { dataset: { id: 'd' } } : null) } });
    assert.strictEqual(c.similar().target, 'd', 'hover takes over the target');
    assert.deepStrictEqual(c.similar().ids, [], 'the previous tint goes at once');
    c.onMouseout({ relatedTarget: null, currentTarget: null });
    c.clearSelection();
    assert.strictEqual(c.similar().target, null, 'leaving the rows (and no cursor) clears the target');
    // A cursor the list drops (the new query hides its row) takes its tint
    // along: a lone result must not look like the cursor while Enter does nothing.
    visible = ['a', 'b', 'c', 'd'];
    c.moveFocus(1);
    await new Promise((r) => setTimeout(r, 220));
    assert.strictEqual(c.similar().target, 'a', 'sanity: the cursor row is the target');
    visible = ['b'];
    c.onQueryChange();
    c.reconcileVisible({ keepCursor: false });
    assert.strictEqual(c.focusedId(), null, 'the hidden cursor is dropped');
    assert.strictEqual(c.similar().target, null, 'its similar target goes with it');
    assert.deepStrictEqual(c.similar().ids, [], 'no row keeps the tint');
    // A hovered row the rebuild hid is no target either.
    visible = ['a', 'b', 'c', 'd'];
    c.onMouseover({ target: { closest: (sel) => (sel === '.item' ? { dataset: { id: 'a' } } : null) } });
    await new Promise((r) => setTimeout(r, 220));
    assert.strictEqual(c.similar().target, 'a');
    visible = ['b'];
    c.reconcileVisible({ keepCursor: false });
    assert.strictEqual(c.similar().target, null, 'a hidden hover row is no target');
  }

  // 11) A scan that throws still answers its waiters (an empty set, so the
  //     menu row goes instead of staying on "Looking for similar clips..."),
  //     and a huge clip is searched without building a pattern from the target
  //     (a 25K+ char RegExp does not compile: "Stack overflow").
  {
    const T = (id, text) => ({ id, type: 'text', text });
    let r = '';
    for (let i = 0; r.length < 40000; i += 1) r += `word${i % 97}x${i} `;
    const big = T('big', r.trim());
    const huge = T('huge', `${'q'.repeat(ui.SIMILAR_MAX_CHARS)} lead-in ${r.trim().replace(/ /g, '\n  ')} tail`);
    const miss = T('miss', `${'q'.repeat(ui.SIMILAR_MAX_CHARS)} ${r.trim().replace('word5x5', 'word5y5')}`);
    assert.deepStrictEqual(ui.similarClipIds(big, [big, huge, miss]), ['huge'], 'a 40K target found in a huge clip across whitespace runs, a one-char difference is not');
    // The anchor (the target's longest space-free run) straddles the 1 MB chunk edge.
    const edge = T('edge', `${'q'.repeat((1 << 20) - 8)}abcdefghijklmnop\t\tqrs tuv`);
    assert.deepStrictEqual(ui.similarClipIds(T('t', 'ABCDEFGHIJKLMNOP qrs tuv'), [edge]), ['edge'], 'an anchor across a chunk edge is found');
    assert.deepStrictEqual(ui.similarClipIds(T('t', 'abcdefghijklmnop qrs tuvw'), [edge]), [], 'and the text after it must match too');
    const items = [T('a', 'meeting notes for the launch'), T('b', 'meeting notes for the launch, v2')];
    const byId = Object.fromEntries(items.map((i) => [i.id, i]));
    let throwOn = true;
    const c = ui.createClipController({
      itemById: (id) => byId[id], visibleIds: () => ['a', 'b'], allItems: () => items, renderSelection: () => {}, render() {}, refresh() {},
      lowerOf: () => { if (throwOn) throw new Error('boom'); return ''; },
    });
    items.push(T('h', 'x'.repeat(ui.SIMILAR_MAX_CHARS + 1)));
    byId.h = items[2];
    const errors = [];
    const onUncaught = (e) => errors.push(e && e.message);
    process.on('uncaughtException', onUncaught);
    const got = await new Promise((resolve) => c.whenSimilar('a', resolve));
    await new Promise((res) => setTimeout(res, 20));
    process.removeListener('uncaughtException', onUncaught);
    assert.ok(got instanceof Set && got.size === 0, 'a failed scan answers with an empty set');
    assert.deepStrictEqual(errors, ['boom'], 'the error is still reported (rethrown on its own tick)');
    throwOn = false;
    const again = await new Promise((resolve) => c.whenSimilar('a', resolve));
    assert.strictEqual(again, got, 'the answer is cached: no stuck scan, no retry storm');
  }

  console.log('multiselect.test.js: all multi-select guards passed');
})().catch((err) => { console.error(err); process.exitCode = 1; });
