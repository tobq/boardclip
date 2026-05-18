'use strict';

const assert = require('assert');
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
  const local = text('clip', { pin: null, pinUpdatedAt: 300, ts: 200, updatedAt: 300 });
  const remote = text('clip', { pin: { groups: ['todo'], updatedAt: 120 }, pinUpdatedAt: 120, ts: 100, updatedAt: 100 });
  const merged = model.mergeHistories([local], [remote], {});
  assert.strictEqual(merged[0].pin, null);
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
  assert.deepStrictEqual(ui.filterItems(base, { filters: new Set(['work']), query: 'invoice', regex: false }).map(i => i.id), ['a']);
  assert.strictEqual(ui.addClipboardText(base, 'new clip')[0].text, 'new clip');
  assert.strictEqual(ui.touchItem(base, 'a', 30)[0].id, 'a');
  assert.strictEqual(ui.numpadMap(ui.assignNumpad(base, 'a', 2, 40))[2], 'a');
  assert.strictEqual(ui.togglePin(base, 'a', 50).find(i => i.id === 'a').pinUpdatedAt, 50);
  assert.strictEqual(ui.togglePin([{ id: 'a', type: 'text', text: 'x', ts: 1, pin: { updatedAt: 1 } }], 'a', 60)[0].pinUpdatedAt, 60);
  assert.strictEqual(ui.ago(100, 102), 'now');
  assert.strictEqual(ui.ago(100, 165), '1m');
  assert.strictEqual(ui.nextAgoDelayMs(100, 130), 1000);
  assert.strictEqual(ui.nextAgoDelayMs(100, 165), 55050);
}

{
  assert.strictEqual(autoUpdate.updateScriptPath('C:\\App', 'win32'), 'C:\\App\\update.bat');
  assert.strictEqual(autoUpdate.updateScriptPath('/app', 'linux'), '/app/update.sh');
  assert.strictEqual(autoUpdate.canAutoUpdate(__dirname, { fullCommit: 'abc', dirty: true }), false);
}

console.log('clipboard model tests passed');
