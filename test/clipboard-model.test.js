'use strict';

const assert = require('assert');
const model = require('../lib/clipboard-model');

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

console.log('clipboard model tests passed');
