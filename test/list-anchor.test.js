'use strict';
// Keep-your-place list + image zoom: the pure pieces behind Core.createClipList
// (resolveListAnchor, Search.rankMode), the controller's cursor rules across a
// query change, the zoom helpers and preview markup, and the main.js wiring
// for the per-machine preview-height setting and the editor clipboard follow.
// The DOM half (windowed rendering, pixel-exact restore) is measured in the
// sandbox QA run, not here.
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const ui = require('../site/shared/clipboard-ui-core');

const ids = ['n1', 'n2', 'n3', 'n4', 'n5', 'n6'];
const ts = { n1: 600, n2: 500, n3: 400, n4: 300, n5: 200, n6: 100 };
const tsAt = (list) => (i) => ts[list[i]];

// 1) rankMode: one definition of "is this list time-ordered".
{
  const p = (q) => ui.search.parseQuery(q);
  assert.strictEqual(ui.search.rankMode(p('')), 'none');
  assert.strictEqual(ui.search.rankMode(p('group:work')), 'none', 'facets only -> history order');
  assert.strictEqual(ui.search.rankMode(p('invoice')), 'best');
  assert.strictEqual(ui.search.rankMode(p('invoice sort:new')), 'new');
  assert.strictEqual(ui.search.rankMode(p('invoice'), 'new'), 'new', 'the Best/Recent toggle wins');
}

// 2) resolveListAnchor: the agreed rules.
{
  const r = (o) => ui.resolveListAnchor({ tsAt: tsAt(o.ids || ids), ids, ...o });
  // Background rebuild keeps the anchored clip at its offset.
  assert.deepStrictEqual(r({ anchor: { id: 'n4', offset: 37, ts: 300 }, prevMode: 'none', nextMode: 'none' }), { index: 3, offset: 37, reason: 'kept' });
  // Unscrolled with no cursor: stays at the top so new clips show.
  assert.strictEqual(r({ anchor: { id: 'n1', offset: 0, ts: 600, atTop: true }, prevMode: 'none', nextMode: 'none' }).index, -1);
  // Starting a search (or flipping to Best) begins at the best match.
  assert.deepStrictEqual(r({ anchor: { id: 'n4', offset: 10, ts: 300 }, prevMode: 'none', nextMode: 'best' }).reason, 'search-start');
  assert.strictEqual(r({ anchor: { id: 'n4', offset: 10, ts: 300 }, prevMode: 'new', nextMode: 'best' }).index, -1);
  // Clearing lands on the clip you were on, in full history, EVEN unscrolled.
  const cleared = r({ anchor: { id: 'n3', offset: 0, ts: 400, atTop: true }, prevMode: 'best', nextMode: 'none', cleared: true });
  assert.deepStrictEqual(cleared, { index: 2, offset: 0, reason: 'kept' });
  // Removing the search text but keeping a facet counts as leaving the search.
  assert.strictEqual(r({ anchor: { id: 'n5', offset: 0, ts: 200, atTop: true }, prevMode: 'best', nextMode: 'none' }).index, 4);
  // Refining keeps the clip while it still matches...
  assert.strictEqual(r({ anchor: { id: 'n2', offset: 5, ts: 500 }, prevMode: 'best', nextMode: 'best' }).index, 1);
  // ...a time-ordered list whose clip dropped out goes to the nearest in time...
  const near = ['n1', 'n2', 'n5', 'n6'];
  assert.deepStrictEqual(ui.resolveListAnchor({ ids: near, tsAt: tsAt(near), anchor: { id: 'n4', offset: 12, ts: 300 }, prevMode: 'none', nextMode: 'none' }),
    { index: 2, offset: 12, reason: 'nearest' }, 'n4 (300) dropped -> n5 (200) is nearer than n2 (500)');
  // ...ties go to the newer clip; a ranked list goes to the top.
  const tie = ['n1', 'n3', 'n5'];
  assert.strictEqual(ui.resolveListAnchor({ ids: tie, tsAt: tsAt(tie), anchor: { id: 'n4', offset: 0, ts: 300 }, prevMode: 'new', nextMode: 'new' }).index, 1);
  assert.strictEqual(r({ ids: ['n1', 'n2'], anchor: { id: 'n6', offset: 0, ts: 100 }, prevMode: 'best', nextMode: 'best' }).index, -1);
  // Nothing to keep / nothing to show.
  assert.strictEqual(r({ anchor: null, prevMode: 'none', nextMode: 'none' }).index, -1);
  assert.strictEqual(ui.resolveListAnchor({ ids: [], anchor: { id: 'n1' } }).reason, 'empty');
}

// 3) Controller cursor rules: a query change drops the multi-selection at once;
//    the rebuild keeps the cursor only when the list says so and it is still
//    shown; a background rebuild prunes ids that disappeared; and with no
//    cursor, the first arrow press starts on the first row ON SCREEN.
{
  let visible = ['a', 'b', 'c', 'd'];
  let firstOnScreen = null;
  const c = ui.createClipController({
    itemById: (id) => ({ id, type: 'text' }),
    visibleIds: () => visible,
    firstVisibleId: () => firstOnScreen,
    renderSelection() {},
  });
  c.toggle('b');
  c.toggle('c');
  c.onQueryChange();
  assert.strictEqual(c.selection().count, 0, 'query change clears the multi-selection');
  assert.strictEqual(c.focusedId(), 'c', 'the cursor waits for the rebuild');
  c.reconcileVisible({ keepCursor: true });
  assert.strictEqual(c.focusedId(), 'c', 'cursor kept: still visible and the list kept it');
  c.reconcileVisible({ keepCursor: false });
  assert.strictEqual(c.focusedId(), null, 'the list did not keep it in place -> no hidden cursor for Enter to paste');
  c.moveFocus(1);
  visible = ['a', 'b', 'd'];
  c.toggle('d');
  c.reconcileVisible();
  assert.strictEqual(c.focusedId(), 'd');
  visible = ['a', 'b'];
  c.reconcileVisible();
  assert.strictEqual(c.focusedId(), null, 'a clip that vanished takes the cursor with it');
  assert.strictEqual(c.selection().count, 0, '...and its checked state');
  visible = ['a', 'b', 'c', 'd', 'e'];
  firstOnScreen = 'c';
  c.moveFocus(1);
  assert.strictEqual(c.focusedId(), 'c', 'first arrow press starts at the first row on screen');
  c.clearSelection();
  firstOnScreen = null;
  c.moveFocus(1);
  assert.strictEqual(c.focusedId(), 'a', 'without a host hint it starts at the top as before');
}

// 4) Zoom helpers + key routing: Ctrl+wheel and the zoom chords are claimed
//    (default prevented) so the PAGE never zooms; plain wheel/keys pass.
{
  assert.deepStrictEqual(ui.IMAGE_ZOOM, { min: 40, max: 600, def: 60, wheelStep: 1.15, keyStep: 1.25 });
  assert.strictEqual(ui.clampImageHeight(10), 40);
  assert.strictEqual(ui.clampImageHeight(9000), 600);
  assert.strictEqual(ui.clampImageHeight('abc'), 60);
  assert.strictEqual(ui.clampImageHeight(''), 60);
  const key = (k, extra) => ({ key: k, code: '', ctrlKey: true, metaKey: false, altKey: false, ...extra });
  assert.strictEqual(ui.imageZoomKey(key('=')), 'in');
  assert.strictEqual(ui.imageZoomKey(key('+')), 'in');
  assert.strictEqual(ui.imageZoomKey(key('-')), 'out');
  assert.strictEqual(ui.imageZoomKey(key('0')), 'reset');
  assert.strictEqual(ui.imageZoomKey(key('', { code: 'NumpadAdd' })), 'in');
  assert.strictEqual(ui.imageZoomKey(key('=', { ctrlKey: false })), null, 'no modifier -> typing');
  assert.strictEqual(ui.imageZoomKey(key('a')), null);

  const saved = [];
  const toasts = [];
  const zoom = ui.createImageZoom({ initial: 60, save: (v) => saved.push(v), toast: (m) => toasts.push(m) });
  let prevented = 0;
  const wheel = (deltaY, ctrlKey) => ({ deltaY, deltaMode: 0, ctrlKey, metaKey: false, clientY: 0, preventDefault: () => { prevented += 1; } });
  assert.strictEqual(zoom.onWheel(wheel(-100, false)), false, 'a plain wheel scrolls the list');
  assert.strictEqual(prevented, 0);
  assert.strictEqual(zoom.onWheel(wheel(-100, true)), true);
  assert.strictEqual(prevented, 1, 'Ctrl+wheel never reaches the page zoom');
  assert.strictEqual(zoom.get(), 69, 'one notch = x1.15');
  for (let i = 0; i < 50; i += 1) zoom.onWheel(wheel(-2, true)); // trackpad: tiny deltas still add up
  assert.ok(zoom.get() > 69, 'small trackpad deltas accumulate instead of rounding away');
  const kd = (k) => ({ ...key(k), preventDefault: () => { prevented += 1; } });
  assert.strictEqual(zoom.onKeydown(kd('0')), true);
  assert.strictEqual(zoom.get(), 60, 'Ctrl+0 resets');
  zoom.onKeydown(kd('-'));
  assert.strictEqual(zoom.get(), 48, 'Ctrl+- = /1.25');
  for (let i = 0; i < 20; i += 1) zoom.onKeydown(kd('-'));
  assert.strictEqual(zoom.get(), 40, 'clamped at the minimum');
  assert.ok(toasts[toasts.length - 1] === 'Image previews: 40px');
  zoom.load(200);
  assert.strictEqual(zoom.get(), 200, 'a loaded setting applies');
}

// 5) Preview markup: known dims reserve space + drive the CSS sizing vars;
//    legacy clips without dims fall back to the plain rule.
{
  const withDims = ui.renderClipItem({ id: 'img:a.png', type: 'image', image: 'a.png', width: 1600, height: 400, ts: 1 }, { imageSrc: () => 'x.png' });
  assert.ok(withDims.includes('width="1600" height="400"'), 'intrinsic size attributes reserve the row');
  assert.ok(/<span class="preview-img" style="--ar:4;--nw:1600px"><img [^>]*width="1600" height="400"/.test(withDims),
    'aspect ratio + natural width vars on the picture box (the row buttons float over it)');
  const legacy = ui.renderClipItem({ id: 'img:b.png', type: 'image', image: 'b.png', ts: 1 }, { imageSrc: () => 'y.png' });
  assert.ok(!legacy.includes('--ar') && !legacy.includes('width="'), 'no dims -> no sizing vars');
  const css = fs.readFileSync(path.join(__dirname, '../site/shared/clipboard-popup.css'), 'utf8');
  assert.ok(/\.preview-img\s*\{[^}]*--img-h:\s*min\(var\(--clip-img-h/.test(css), 'previews size from --clip-img-h (capped)');
  assert.ok(/\.preview-img\[style\*="--ar"\]\s*\{[^}]*width:\s*min\(100%,\s*calc\(var\(--img-h\) \* var\(--ar\)\),\s*var\(--nw\)\)/.test(css),
    'width = min(row, height x ratio, real width): ratio kept, no sideways overflow, no upscaling');
  assert.ok(/\.preview-img\[style\*="--ar"\] img\s*\{[^}]*width:\s*100%/.test(css), 'the picture fills its sized box');
  assert.ok(!/max-height:\s*60px/.test(css), 'no hard-coded 60px preview cap left');
}

// 6) main.js wiring: preview height is per machine (default, clamped save,
//    never synced); the editor reaches the clipboard ONLY through the follower.
{
  const model = require('../lib/clipboard-model');
  assert.strictEqual(model.DEFAULT_SETTINGS.image_preview_height, 60);
  const main = fs.readFileSync(path.join(__dirname, '../main.js'), 'utf8');
  assert.ok(main.includes('delete remoteSave.image_preview_height;'), 'image_preview_height must stay out of synced settings');
  assert.ok(/body\.image_preview_height[\s\S]{0,200}Math\.min\(600, Math\.max\(40, px\)\)/.test(main), 'save-settings clamps image_preview_height to 40-600');
  assert.ok(!/writeClipboard/.test(main), 'edits never write the clipboard directly (the follower decides)');
  assert.ok(/function commitEditSession\([\s\S]{0,1200}followEditorSave\(session, prevText, next\.text\)/.test(main), 'every editor save goes through the clipboard follower');
  assert.ok((main.match(/observeEditorsClipboard\(/g) || []).length >= 4, 'the poller re-checks open editors on every text/image capture');
  assert.ok(main.includes("ipcMain.on('editor-focus'") && main.includes("ipcMain.handle('editor-copy'"), 'focus re-check + Copy button IPC');
  // macOS AND Windows: the zoom chords are claimed in main before the app menu
  // (macOS key equivalents fire before the page) and routed to the shared zoom.
  assert.ok(/before-input-event[\s\S]{0,400}BoardClipCore\.imageZoomKey\(\{ ctrlKey: input\.control, metaKey: input\.meta/.test(main), 'main claims Ctrl/Cmd zoom chords with the shared chord test');
  assert.ok(/before-input-event[\s\S]{0,700}event\.preventDefault\(\);[\s\S]{0,120}webContents\.send\('image-zoom-key', act\)/.test(main), 'claimed chords never reach the page zoom and go to the previews');
  const preload = fs.readFileSync(path.join(__dirname, '../preload.js'), 'utf8');
  assert.ok(preload.includes("ipcRenderer.on('image-zoom-key', listener)"));
  const app = fs.readFileSync(path.join(__dirname, '../index.html'), 'utf8');
  assert.ok(app.includes('window.api.onImageZoomKey((act) => imageZoom.applyKey(act))'));
  assert.ok(!/decoding="async"/.test(fs.readFileSync(path.join(__dirname, '../site/shared/clipboard-ui-core.js'), 'utf8')), 'no async image decode: rebuilt rows must not paint blank image boxes');
}

console.log('list-anchor tests passed');
