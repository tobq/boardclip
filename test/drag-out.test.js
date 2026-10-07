'use strict';
// Dragging clips out of BoardClip: file names for dragged images
// (lib/drag-files.js), the shared controller's dragstart routing (images ->
// the host's native file drag, text -> text, a 2+ selection drags every
// selected clip of the grabbed kind, controls never drag), and the main-process
// wiring (temporary copies, the navigation guard that stops a file dropped on
// a BoardClip window from replacing it).
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { dragFileNames, safeBaseName, localStamp } = require('../lib/drag-files');
const ui = require('../site/shared/clipboard-ui-core');

// 1) Names: the clip's title, made Windows-safe; untitled -> local date time;
//    duplicates within one drag get " (2)"; the extension follows the file.
{
  const ts = Math.floor(new Date(2026, 9, 7, 16, 5, 9).getTime() / 1000);
  assert.strictEqual(localStamp(ts), '2026-10-07 16.05.09');
  assert.deepStrictEqual(dragFileNames([
    { title: 'Q3: revenue/chart?', image: 'abc.png', ts },
    { image: 'def.png', ts },
    { title: 'q3  revenue chart', image: 'x.PNG', ts },
    { title: 'Q3 revenue chart', image: 'y.jpg', ts },
    { title: '   ', image: 'z', ts },
  ]), [
    'Q3 revenue chart.png',
    'BoardClip image 2026-10-07 16.05.09.png',
    'q3 revenue chart (2).png',
    'Q3 revenue chart.jpg',
    'BoardClip image 2026-10-07 16.05.09 (2).png',
  ]);
  assert.strictEqual(safeBaseName('trailing dots...  '), 'trailing dots');
  assert.strictEqual(safeBaseName('CON'), 'CON image', 'reserved device names are never used bare');
  assert.strictEqual(safeBaseName('a'.repeat(200)).length, 80);
}

// 2) Controller dragstart routing (fake DOM: an element knows its own
//    selector matches; closest() walks up to the row).
function fakeEvent({ rowId, onControl = false }) {
  const row = { dataset: { id: rowId } };
  const target = {
    nodeType: 1,
    closest: (sel) => {
      if (sel === '.item') return row;
      return onControl ? {} : null;
    },
  };
  const data = {};
  return {
    target,
    prevented: false,
    preventDefault() { this.prevented = true; },
    dataTransfer: { setData: (type, value) => { data[type] = value; }, data, effectAllowed: 'all' },
  };
}
{
  const items = {
    t1: { id: 't1', type: 'text', text: 'first' },
    t2: { id: 't2', type: 'text', text: 'second', html: '<b>second</b>' },
    i1: { id: 'i1', type: 'image', image: 'a.png' },
    i2: { id: 'i2', type: 'image', image: 'b.png' },
  };
  const order = ['t1', 'i1', 't2', 'i2'];
  const dragged = [];
  const c = ui.createClipController({
    itemById: (id) => items[id],
    visibleIds: () => order,
    renderSelection() {},
    dragImages: (ids, event) => { event.preventDefault(); dragged.push(ids); return true; },
  });

  let ev = fakeEvent({ rowId: 't2' });
  c.onDragstart(ev);
  assert.strictEqual(ev.dataTransfer.data['text/plain'], 'second', 'a text row drags its text');
  assert.strictEqual(ev.dataTransfer.data['text/html'], '<b>second</b>', '...and its HTML when it has one');
  assert.strictEqual(ev.dataTransfer.effectAllowed, 'all', 'text drags allow copy AND move: a composer asking for move must not refuse the drop');
  assert.strictEqual(ev.prevented, false, 'a text drag stays a native page drag');

  ev = fakeEvent({ rowId: 'i2' });
  c.onDragstart(ev);
  assert.deepStrictEqual(dragged.pop(), ['i2'], 'an image row goes to the host file drag');
  assert.strictEqual(ev.prevented, true);

  // A 2+ selection drags every selected clip of the grabbed kind, in list order.
  c.toggle('i2'); c.toggle('t2'); c.toggle('i1'); c.toggle('t1');
  ev = fakeEvent({ rowId: 'i2' });
  c.onDragstart(ev);
  assert.deepStrictEqual(dragged.pop(), ['i1', 'i2'], 'images only, list order');
  ev = fakeEvent({ rowId: 't1' });
  c.onDragstart(ev);
  assert.strictEqual(ev.dataTransfer.data['text/plain'], 'first\nsecond', 'texts joined like Paste all');
  assert.strictEqual(ev.dataTransfer.data['text/html'], undefined, 'no HTML for a multi-clip text drag');
  // A row outside the selection drags alone.
  c.clearSelection();
  c.toggle('t1'); c.toggle('t2');
  ev = fakeEvent({ rowId: 'i1' });
  c.onDragstart(ev);
  assert.deepStrictEqual(dragged.pop(), ['i1']);

  // Pressing on a row's own control (star, picker, tag, menu) never drags.
  ev = fakeEvent({ rowId: 't1', onControl: true });
  c.onDragstart(ev);
  assert.strictEqual(ev.prevented, true);
  assert.strictEqual(ev.dataTransfer.data['text/plain'], undefined);

  // A host without file-drag support refuses an image drag outright.
  const bare = ui.createClipController({ itemById: (id) => items[id], visibleIds: () => order, renderSelection() {} });
  ev = fakeEvent({ rowId: 'i1' });
  bare.onDragstart(ev);
  assert.strictEqual(ev.prevented, true, 'no bare internal image URL drag');

  assert.ok(ui.renderClipItem(items.t1, {}).includes('draggable="true"'), 'rows are draggable');
}

// 3) Main wiring: temporary copies (never the original file), one subfolder
//    per drag, pruning, and the navigation guard on every window.
{
  const main = fs.readFileSync(path.join(__dirname, '../main.js'), 'utf8');
  assert.ok(main.includes("ipcMain.on('start-drag'"), 'start-drag must be ipcMain.on (send), not handle');
  assert.ok(/function startImageDrag\([\s\S]{0,1500}fs\.copyFileSync\(path\.join\(IMG_DIR, items\[i\]\.image\), dest\)/.test(main), 'drags hand the OS a COPY');
  assert.ok(/sender\.startDrag\(\{ file: files\[0\], files, icon \}\)/.test(main));
  assert.ok(main.includes("contents.on('will-navigate'") && /web-contents-created[\s\S]{0,300}event\.preventDefault\(\)/.test(main), 'no BoardClip window may navigate away (a dropped file replaced it)');
  const viewerPreload = fs.readFileSync(path.join(__dirname, '../viewer-preload.js'), 'utf8');
  assert.ok(viewerPreload.includes("ipcRenderer.send('start-drag', [clipId])"));
  const viewerHtml = fs.readFileSync(path.join(__dirname, '../viewer.html'), 'utf8');
  assert.ok(viewerHtml.includes('onDragOut:'), 'the viewer window wires drag-out');
}

console.log('drag-out tests passed');
