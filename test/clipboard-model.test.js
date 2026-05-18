'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const model = require('../lib/clipboard-model');
const ui = require('../site/shared/clipboard-ui-core');
const autoUpdate = require('../lib/auto-update');

function text(text, extra = {}) {
  const item = { type: 'text', text, ts: 1, ...extra };
  model.ensureItemId(item);
  return item;
}

{
  const item = { type: 'text', text: 'old', pinned: 3, group: 'work' };
  model.migrateItemPin(item);
  assert.deepStrictEqual(item.pin, { number: 3, groups: ['work'] });
  assert.strictEqual(item.pinned, undefined);
  assert.strictEqual(item.group, undefined);
}

{
  const keep = text('keep');
  const deleted = text('deleted');
  const merged = model.mergeHistories([keep], [deleted], {
    tombstones: [{ id: deleted.id, deletedAt: Date.now() }],
  });
  assert.deepStrictEqual(merged.map(i => i.id), [keep.id]);
}

{
  const local = text('clip', { pin: { groups: ['local'], updatedAt: 10 }, ts: 10 });
  const remote = text('clip', { pin: { groups: ['remote'], number: 4, updatedAt: 20 }, ts: 20 });
  const merged = model.mergeHistories([local], [remote], {});
  assert.strictEqual(merged.length, 1);
  assert.deepStrictEqual(merged[0].pin.groups.sort(), ['local', 'remote']);
  assert.strictEqual(merged[0].pin.number, 4);
}

{
  const local = text('clip', { pin: null, ts: 200, updatedAt: 200 });
  const remote = text('clip', { pin: { groups: ['todo'], updatedAt: 120 }, pinUpdatedAt: 120, ts: 100, updatedAt: 100 });
  const merged = model.mergeHistories([local], [remote], {});
  assert.deepStrictEqual(merged[0].pin.groups, ['todo']);
}

{
  const local = text('star', { pin: null, ts: 200, updatedAt: 200 });
  const remote = text('star', { pin: { updatedAt: 120 }, pinUpdatedAt: 120, ts: 100, updatedAt: 100 });
  const merged = model.mergeHistories([local], [remote], {});
  assert.strictEqual(model.isPinned(merged[0]), true);
}

{
  const local = text('clip', { pin: null, pinUpdatedAt: 300, ts: 200, updatedAt: 300 });
  const remote = text('clip', { pin: { groups: ['todo'], updatedAt: 120 }, pinUpdatedAt: 120, ts: 100, updatedAt: 100 });
  const merged = model.mergeHistories([local], [remote], {});
  assert.strictEqual(merged[0].pin, null);
}

{
  const local = text('clip', {
    pin: { number: 2, numberUpdatedAt: 200, groups: ['card'], groupsUpdatedAt: 300, updatedAt: 300 },
    pinUpdatedAt: 300,
  });
  const remote = text('clip', {
    pin: { number: 2, numberUpdatedAt: 200, groups: ['card', 'todo'], groupsUpdatedAt: 100, updatedAt: 100 },
    pinUpdatedAt: 100,
  });
  const merged = model.mergeHistories([local], [remote], {});
  assert.deepStrictEqual(merged[0].pin.groups, ['card']);
  assert.strictEqual(merged[0].pin.number, 2);
}

{
  const local = text('clip', {
    pin: { groups: ['todo'], groupsUpdatedAt: 100, numberUpdatedAt: 300, updatedAt: 300 },
    pinUpdatedAt: 300,
  });
  const remote = text('clip', {
    pin: { number: 4, numberUpdatedAt: 100, groups: ['todo'], groupsUpdatedAt: 100, updatedAt: 100 },
    pinUpdatedAt: 100,
  });
  const merged = model.mergeHistories([local], [remote], {});
  assert.strictEqual(model.numpadSlotOf(merged[0]), null);
  assert.deepStrictEqual(merged[0].pin.groups, ['todo']);
}

{
  const local = text('clip', {
    pin: { number: 1, numberUpdatedAt: 300, updatedAt: 300 },
    pinUpdatedAt: 300,
  });
  const remote = text('clip', {
    pin: { groups: ['todo'], groupsUpdatedAt: 100, updatedAt: 100 },
    pinUpdatedAt: 100,
  });
  const merged = model.mergeHistories([local], [remote], {});
  assert.deepStrictEqual(merged[0].pin.groups, ['todo']);
  assert.strictEqual(merged[0].pin.number, 1);
}

{
  const one = { number: 1, numberUpdatedAt: 10, updatedAt: 10 };
  const two = { number: 2, numberUpdatedAt: 10, updatedAt: 10 };
  assert.strictEqual(model.mergePins(one, two, 10, 10).number, 2);
  assert.strictEqual(model.mergePins(two, one, 10, 10).number, 2);
}

{
  const local = text('a', { pin: { number: 1, updatedAt: 10 }, ts: 10 });
  const remote = text('b', { pin: { number: 1, updatedAt: 20 }, ts: 20 });
  const merged = model.mergeHistories([local], [remote], {});
  assert.strictEqual(model.numpadSlotOf(merged.find(i => i.text === 'b')), 1);
  assert.strictEqual(model.numpadSlotOf(merged.find(i => i.text === 'a')), null);
}

{
  const merged = model.mergeGroups(['keep', 'gone'], ['remote', 'gone'], [
    { name: 'gone', deletedAt: Date.now() },
  ]);
  assert.deepStrictEqual(merged.sort(), ['keep', 'remote']);
}

{
  const base = [
    { id: 'a', type: 'text', text: 'alpha invoice', ts: 10, labels: ['work'], pin: null },
    { id: 'b', type: 'text', text: 'beta macro', ts: 20, labels: ['code'], pin: { number: 2 } },
  ];
  assert.deepStrictEqual(ui.filterItems(base, { filters: new Set(['__numbered__']), query: '', regex: false }).map(i => i.id), ['b']);
  assert.deepStrictEqual(ui.BUILTIN_FILTERS.map(f => f.id), ['__pinned__', '__numbered__', '__images__']);
  assert.deepStrictEqual(ui.builtinFilters(base, new Set(['__numbered__'])).map(f => [f.id, f.count, f.active]), [
    ['__pinned__', 1, false],
    ['__numbered__', 1, true],
  ]);
  const filterBar = ui.renderFilterBar({ items: base, groups: ['code'], activeFilters: new Set(['__numbered__']), query: '' });
  assert(filterBar.includes('data-filter="__numbered__"'));
  assert(filterBar.includes('data-group="code"'));
  assert(!filterBar.includes('data-filter="image"'));
  assert(!filterBar.includes('class="chip'));
  const clipItem = ui.renderClipItem(base[1], { imageSrc: () => '' });
  assert(clipItem.includes('class="item has-pin"'));
  assert(clipItem.includes('class="numpad-tag">#2</span>'));
  assert(clipItem.includes('class="group-tag">code</span>'));
  assert.deepStrictEqual(ui.filterItems(base, { filters: new Set(['work']), query: 'invoice', regex: false }).map(i => i.id), ['a']);
  assert.deepStrictEqual(ui.filterItemIndexes(base, { filters: new Set(['__numbered__', 'code']), query: 'macro', regex: false }), [1]);
  assert.deepStrictEqual(ui.filterItemIndexes(base, { filters: new Set(['__numbered__', 'work']), query: '', regex: false }), []);
  assert.deepStrictEqual(ui.filterItems(base, { filters: new Set(['code']), query: 'text', regex: false }).map(i => i.id), ['b']);
  assert.strictEqual(ui.addClipboardText(base, 'new clip')[0].text, 'new clip');
  assert.strictEqual(ui.touchItem(base, 'a', 30)[0].id, 'a');
  assert.strictEqual(ui.numpadMap(ui.assignNumpad(base, 'a', 2, 40))[2], 'a');
  assert.strictEqual(ui.togglePin(base, 'a', 50).find(i => i.id === 'a').pinUpdatedAt, 50);
  assert.strictEqual(ui.togglePin([{ id: 'a', type: 'text', text: 'x', ts: 1, pin: { updatedAt: 1 } }], 'a', 60)[0].pinUpdatedAt, 60);
  assert.strictEqual(ui.assignNumpad(base, 'a', 2, 70).find(i => i.id === 'a').pin.numberUpdatedAt, 70);
  assert.strictEqual(ui.toggleGroup(base, 'a', 'todo', 80).find(i => i.id === 'a').pin.groupsUpdatedAt, 80);
  assert.strictEqual(ui.ago(100, 102), 'now');
  assert.strictEqual(ui.ago(100, 165), '1m');
  assert.strictEqual(ui.nextAgoDelayMs(100, 130), 1000);
  assert.strictEqual(ui.nextAgoDelayMs(100, 165), 55050);
}

{
  assert.strictEqual(autoUpdate.updateScriptPath('C:\\App', 'win32'), 'C:\\App\\update.bat');
  assert.strictEqual(autoUpdate.updateScriptPath('/app', 'linux'), '/app/update.sh');
  assert.strictEqual(autoUpdate.canAutoUpdate(__dirname, { fullCommit: 'abc', dirty: true }), false);
  const appDir = fs.mkdtempSync(path.join(os.tmpdir(), 'boardclip-update-'));
  try {
    assert.deepStrictEqual(autoUpdate.updateSupport(appDir, { fullCommit: 'abc' }, 'linux'), { supported: false, reason: 'not-git-checkout' });
    fs.mkdirSync(path.join(appDir, '.git'));
    assert.deepStrictEqual(autoUpdate.updateSupport(appDir, { fullCommit: 'abc' }, 'linux'), { supported: false, reason: 'missing-update-script' });
    fs.writeFileSync(path.join(appDir, 'update.sh'), '');
    assert.deepStrictEqual(autoUpdate.updateSupport(appDir, { fullCommit: 'abc', dirty: true }, 'linux'), { supported: false, reason: 'dirty-checkout' });
    assert.deepStrictEqual(autoUpdate.updateSupport(appDir, { fullCommit: 'abc', dirty: false }, 'linux'), { supported: true, reason: 'supported' });
  } finally {
    fs.rmSync(appDir, { recursive: true, force: true });
  }
  assert.strictEqual(autoUpdate.updateModeForChangedFiles(['index.html']), 'reload');
  assert.strictEqual(autoUpdate.updateModeForChangedFiles(['site/shared/clipboard-ui-core.js']), 'reload');
  assert.strictEqual(autoUpdate.updateModeForChangedFiles(['main.js']), 'relaunch');
  assert.strictEqual(autoUpdate.updateModeForChangedFiles([]), 'none');
}

console.log('clipboard model tests passed');
