'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const model = require('../lib/clipboard-model');
const ui = require('../site/shared/clipboard-ui-core');
const conflictModel = require('../lib/conflict-model');
const autoUpdate = require('../lib/auto-update');
const syncPaths = require('../lib/sync-paths');
const clipboardCapture = require('../lib/clipboard-capture');
const windowsClipboard = require('../lib/windows-clipboard');
const textBlobStore = require('../lib/text-blob-store');
const { Diagnostics } = require('../lib/diagnostics');

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
  // Version-guarded tombstone: re-copying the same content AFTER a delete must
  // survive the (still-syncing) tombstone — the cross-device "no more surprises"
  // fix. A content-hash id that is touched later than the delete beats it.
  const now = Date.now();
  const recopied = text('recycle', { ts: Math.floor(now / 1000), updatedAt: now + 10_000 });
  const merged = model.mergeHistories([recopied], [], {
    tombstones: [{ id: recopied.id, deletedAt: now }],
  });
  assert.deepStrictEqual(merged.map(i => i.text), ['recycle'], 'newer re-add beats an older tombstone');
}

{
  // The resurrection guard still holds: a STALE pre-delete copy (clock <= the
  // delete) stays deleted, so a lagging provider can never revive a deletion.
  const now = Date.now();
  const stale = text('recycle-stale', { ts: 1, updatedAt: now - 10_000 });
  const merged = model.mergeHistories([stale], [], {
    tombstones: [{ id: stale.id, deletedAt: now }],
  });
  assert.deepStrictEqual(merged.map(i => i.text), [], 'stale pre-delete copy stays deleted');
}

{
  // A pin/metadata touch newer than the delete also keeps the item (any mutation
  // clock counts, not just text capture).
  const now = Date.now();
  const repinned = text('repin', {
    ts: 1,
    pin: { number: 3, updatedAt: now + 10_000, numberUpdatedAt: now + 10_000 },
    pinUpdatedAt: now + 10_000,
  });
  const merged = model.mergeHistories([repinned], [], {
    tombstones: [{ id: repinned.id, deletedAt: now }],
  });
  assert.deepStrictEqual(merged.map(i => i.text), ['repin'], 'a pin touched after the delete keeps the item');
}

{
  const oldUnpinned = Array.from({ length: 60 }, (_, i) => text(`old-${i}`, { ts: 1, pin: null }));
  const pinned = text('pinned', { ts: 1, pin: { updatedAt: 10 } });
  const fresh = text('fresh', { ts: 1_000_000, pin: null });
  const history = [fresh, pinned, ...oldUnpinned];
  const plan = model.planHistoryPrune(history, { max_age_days: 7 }, { now: 1_000_000 });
  assert.strictEqual(plan.length, oldUnpinned.length);
  assert.strictEqual(plan.some(({ index }) => history[index].id === pinned.id), false);
  assert.strictEqual(model.isDestructivePrune(history, plan), true);
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
  const repaired = text('image-hash', { type: 'image', image: 'hash.png', ts: 100, tsUpdatedAt: 300 });
  const staleInflated = text('image-hash', { type: 'image', image: 'hash.png', ts: 500 });
  repaired.id = staleInflated.id = 'img:hash.png';
  const merged = model.mergeHistories([repaired], [staleInflated], {});
  assert.strictEqual(merged[0].ts, 100);
  assert.strictEqual(merged[0].tsUpdatedAt, 300);
}

{
  const olderRecapture = text('image-hash', { type: 'image', image: 'hash.png', ts: 200, tsUpdatedAt: 200 });
  const newerRecapture = text('image-hash', { type: 'image', image: 'hash.png', ts: 400, tsUpdatedAt: 400 });
  olderRecapture.id = newerRecapture.id = 'img:hash.png';
  const merged = model.mergeHistories([olderRecapture], [newerRecapture], {});
  assert.strictEqual(merged[0].ts, 400);
  assert.strictEqual(merged[0].tsUpdatedAt, 400);
}

{
  const a = text('image-hash', { type: 'image', image: 'hash.png', ts: 200, tsUpdatedAt: 300 });
  const b = text('image-hash', { type: 'image', image: 'hash.png', ts: 400, tsUpdatedAt: 300 });
  a.id = b.id = 'img:hash.png';
  assert.strictEqual(model.mergeHistories([a], [b], {})[0].ts, 400);
  assert.strictEqual(model.mergeHistories([b], [a], {})[0].ts, 400);
}

{
  const target = text('edited', { ts: 100, tsUpdatedAt: 500 });
  const stale = text('old', { ts: 900 });
  const merged = model.mergeHistories([target], [stale], {
    tombstones: [{ id: stale.id, deletedAt: Date.now() }],
    supersedes: [{ from: stale.id, to: target.id, updatedAt: Date.now() }],
  });
  assert.strictEqual(merged[0].id, target.id);
  assert.strictEqual(merged[0].ts, 100);
  assert.strictEqual(merged[0].tsUpdatedAt, 500);
}

{
  const legacyA = text('legacy', { ts: 100 });
  const legacyB = text('legacy', { ts: 200 });
  assert.strictEqual(model.mergeHistories([legacyA], [legacyB], {})[0].ts, 200);
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
  const seededDefault = text('seeded default', {
    ts: 0.001,
    updatedAt: 1,
    pinUpdatedAt: 1,
    pin: { number: 7, updatedAt: 1, numberUpdatedAt: 1 },
  });
  const legacyUserMacro = text('real user macro', {
    ts: 100,
    pin: { number: 7 },
  });
  const merged = model.mergeHistories([seededDefault], [legacyUserMacro], {});
  assert.strictEqual(model.numpadSlotOf(merged.find(i => i.text === 'real user macro')), 7);
  assert.strictEqual(model.numpadSlotOf(merged.find(i => i.text === 'seeded default')), null);
}

{
  const userMacro = text('real user macro', {
    ts: 200,
    pin: { number: 7 },
  });
  const staleDefault = text('seeded default', { ts: 1 });
  const result = model.migrateLegacyNumpadSlots(
    [userMacro, staleDefault],
    { 7: { type: 'text', text: 'seeded default' } },
    { now: 1000 }
  );
  assert.strictEqual(result.skipped, 1);
  assert.strictEqual(model.numpadSlotOf(userMacro), 7);
  assert.strictEqual(model.numpadSlotOf(staleDefault), null);
}

{
  const oldMacro = text('old macro', { pin: null });
  const result = model.migrateLegacyNumpadSlots(
    [oldMacro],
    { 3: { type: 'text', text: 'old macro' } },
    { now: 1000 }
  );
  assert.strictEqual(result.changed, true);
  assert.strictEqual(result.migrated, 1);
  assert.strictEqual(model.numpadSlotOf(oldMacro), 3);
  assert.strictEqual(oldMacro.pin.numberUpdatedAt, 1000);
}

{
  const unchanged = text('unchanged', { ts: 10, updatedAt: 10000 });
  const other = text('other', { ts: 20, updatedAt: 20000 });
  const history = [other, unchanged];
  const before = JSON.stringify(history);
  const result = model.applyTextEdit(history, {
    id: unchanged.id,
    originalText: 'unchanged',
    newText: 'unchanged',
    now: 50000,
  });
  assert.strictEqual(result.changed, false);
  assert.strictEqual(result.reason, 'unchanged');
  assert.strictEqual(JSON.stringify(history), before);
}

{
  const item = text('nonblank', { ts: 10, updatedAt: 10000 });
  const history = [item];
  const before = JSON.stringify(history);
  const result = model.applyTextEdit(history, {
    id: item.id,
    originalText: 'nonblank',
    newText: ' \n\t ',
    now: 50000,
  });
  assert.strictEqual(result.changed, false);
  assert.strictEqual(result.reason, 'blank');
  assert.strictEqual(JSON.stringify(history), before);
}

{
  const other = text('top', { ts: 100, updatedAt: 100000 });
  const item = text('old macro', {
    ts: 10,
    updatedAt: 10000,
    pinUpdatedAt: 9000,
    pin: { number: 3, groups: ['work'], updatedAt: 9000, numberUpdatedAt: 9000 },
  });
  const oldId = item.id;
  const history = [other, item];
  const result = model.applyTextEdit(history, {
    id: oldId,
    originalText: 'old macro',
    newText: 'new macro',
    now: 50000,
  });
  assert.strictEqual(result.changed, true);
  assert.strictEqual(result.reason, 'updated');
  assert.strictEqual(history[0].text, 'new macro');
  assert.strictEqual(history[0].ts, 50);
  assert.strictEqual(history[0].updatedAt, 50000);
  assert.strictEqual(model.numpadSlotOf(history[0]), 3);
  assert.deepStrictEqual(model.groupsOf(history[0]), ['work']);
  assert.strictEqual(history[0].pin.numberUpdatedAt, 50000);
  assert.deepStrictEqual(result.tombstoneIds, [oldId]);
}

{
  const duplicate = text('same', { ts: 10, updatedAt: 10000, pin: { groups: ['dest'], updatedAt: 10000 } });
  const item = text('old', { ts: 20, updatedAt: 20000, pin: { groups: ['source'], updatedAt: 20000 } });
  const oldId = item.id;
  const history = [item, duplicate];
  const result = model.applyTextEdit(history, {
    id: oldId,
    originalText: 'old',
    newText: 'same',
    now: 60000,
  });
  assert.strictEqual(result.changed, true);
  assert.strictEqual(result.reason, 'merged');
  assert.strictEqual(history.length, 1);
  assert.strictEqual(history[0].text, 'same');
  assert.strictEqual(history[0].ts, 60);
  assert.deepStrictEqual(model.groupsOf(history[0]).sort(), ['dest', 'source']);
  assert.deepStrictEqual(result.tombstoneIds, [oldId]);
}

{
  const changedElsewhere = text('changed elsewhere', { ts: 30, updatedAt: 30000, pin: { number: 5, groups: ['old'], updatedAt: 30000 } });
  const history = [changedElsewhere];
  const result = model.applyTextEdit(history, {
    id: changedElsewhere.id,
    originalText: 'opened text',
    newText: 'editor result',
    sourceGroups: ['work', 'ideas'],
    now: 70000,
  });
  assert.strictEqual(result.changed, true);
  assert.strictEqual(result.reason, 'conflict_created');
  assert.strictEqual(history.length, 2);
  assert.strictEqual(history[0].text, 'editor result');
  // The diverged live clip must SURVIVE - a stale-based save forks, never
  // overwrites. This is the guarantee that stops a second editor's stale
  // buffer from destroying newer work.
  assert.ok(history.some(h => h.text === 'changed elsewhere'), 'diverged clip preserved on conflict');
  assert.strictEqual(model.numpadSlotOf(history[0]), null);
  assert.deepStrictEqual(model.groupsOf(history[0]), ['work', 'ideas']);
  assert.deepStrictEqual(result.tombstoneIds, []);
}

{
  // Capture-on-save chain: the editor auto-saves several times. Each save is
  // anchored to what the PREVIOUS save produced (originalText = prior newText),
  // so the chain stays in-place (no spurious forks) and the clip ends on the
  // latest content - the data-preservation path that makes intermediate saves
  // survive an unclean close / app restart.
  let history = [text('v0 base', { ts: 10, updatedAt: 10000 })];
  let base = 'v0 base';
  let curId = model.itemKey(history[0]);
  for (const [i, next] of ['v0 base draft', 'v0 base draft more', 'v0 base draft more FINAL'].entries()) {
    const r = model.applyTextEdit(history, { id: curId, originalText: base, newText: next, sourceGroups: [], now: 20000 + i * 1000 });
    assert.strictEqual(r.changed, true);
    assert.strictEqual(r.reason, 'updated', `save ${i} should chain in-place, not fork`);
    base = next;                       // re-anchor like captureExternalEdit does
    curId = model.itemKey(r.item);
  }
  assert.strictEqual(history.length, 1, 'chained saves stay one clip');
  assert.strictEqual(history[0].text, 'v0 base draft more FINAL');

  // But a writer still anchored on the ORIGINAL base (a stale second editor)
  // must fork, not bury the chained-forward content.
  const stale = model.applyTextEdit(history, { id: curId, originalText: 'v0 base', newText: 'stale short', sourceGroups: [], now: 26000 });
  assert.strictEqual(stale.reason, 'conflict_created');
  assert.ok(history.some(h => h.text === 'v0 base draft more FINAL'), 'chained content survives a stale forked save');
}

{
  const changedToSameText = text('editor result', {
    ts: 30,
    updatedAt: 30000,
    pin: { number: 5, updatedAt: 30000, numberUpdatedAt: 30000 },
  });
  const other = text('other', { ts: 40, updatedAt: 40000 });
  const history = [other, changedToSameText];
  const result = model.applyTextEdit(history, {
    id: changedToSameText.id,
    originalText: 'opened text',
    newText: 'editor result',
    sourceGroups: ['work'],
    now: 75000,
  });
  assert.strictEqual(result.changed, true);
  assert.strictEqual(result.reason, 'conflict_merged');
  assert.strictEqual(history.length, 2);
  assert.strictEqual(history[0].text, 'editor result');
  assert.strictEqual(model.numpadSlotOf(history[0]), 5);
  assert.deepStrictEqual(model.groupsOf(history[0]), ['work']);
  assert.deepStrictEqual(result.tombstoneIds, []);
}

{
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'boardclip-edit-'));
  try {
    const longText = 'a'.repeat(textBlobStore.TEXT_BLOB_THRESHOLD_BYTES + 20);
    const editedText = 'b'.repeat(textBlobStore.TEXT_BLOB_THRESHOLD_BYTES + 40);
    const item = text(longText, { ts: 10, updatedAt: 10000 });
    const stored = textBlobStore.prepareHistoryForStorage([item], dir);
    const hydrated = textBlobStore.hydrateHistory(stored, dir);
    assert.strictEqual(hydrated[0].text, longText);

    const result = model.applyTextEdit(hydrated, {
      id: hydrated[0].id,
      originalText: longText,
      newText: editedText,
      now: 80000,
    });
    assert.strictEqual(result.changed, true);
    const restored = textBlobStore.prepareHistoryForStorage(hydrated, dir);
    assert(restored[0].textRef);
    assert.strictEqual(fs.readFileSync(path.join(dir, restored[0].textRef), 'utf8'), editedText);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

{
  const winner = text('winner', { ts: 200, pin: { number: 7 } });
  const loser = text('loser', { ts: 100, pin: { number: 7 } });
  assert.strictEqual(model.dedupeNumpadSlots([winner, loser]), true);
  assert.strictEqual(model.numpadSlotOf(winner), 7);
  assert.strictEqual(model.numpadSlotOf(loser), null);
  assert(loser.pin.numberUpdatedAt > 0);

  const staleLoser = text('loser', { ts: 100, pin: { number: 7 } });
  const merged = model.mergeHistories([loser], [staleLoser], {});
  assert.strictEqual(model.numpadSlotOf(merged.find(i => i.text === 'loser')), null);
}

{
  const merged = model.mergeGroups(['keep', 'gone'], ['remote', 'gone'], [
    { name: 'gone', deletedAt: Date.now() },
  ]);
  assert.deepStrictEqual(merged.sort(), ['keep', 'remote']);
}

{
  const item = text('body', { ts: 10, updatedAt: 10000, title: 'Old title', titleUpdatedAt: 10000 });
  const history = [item];
  const result = model.applyTextEdit(history, {
    id: item.id,
    originalText: 'body',
    originalTitle: 'Old title',
    newText: 'body',
    newTitle: 'New title',
    now: 50000,
  });
  assert.strictEqual(result.changed, true);
  assert.strictEqual(result.reason, 'updated');
  assert.strictEqual(history[0].text, 'body');
  assert.strictEqual(model.titleOf(history[0]), 'New title');
  assert.strictEqual(model.itemKey(history[0]), item.id, 'title metadata does not affect text identity');
}

{
  const item = text('body', { ts: 10, updatedAt: 10000, title: 'Keep me', titleUpdatedAt: 10000 });
  const history = [item];
  const result = model.applyTextEdit(history, {
    id: item.id,
    originalText: 'body',
    newText: 'body edited',
    now: 51000,
  });
  assert.strictEqual(result.changed, true);
  assert.strictEqual(model.titleOf(history[0]), 'Keep me', 'body-only edits preserve existing title metadata');
}

{
  const local = text('same body', { ts: 10, updatedAt: 10000, title: 'Local title', titleUpdatedAt: 30000 });
  const remote = text('same body', { ts: 20, updatedAt: 20000, title: 'Remote title', titleUpdatedAt: 20000 });
  const merged = model.mergeHistories([local], [remote], {});
  assert.strictEqual(merged.length, 1);
  assert.strictEqual(model.titleOf(merged[0]), 'Local title', 'newer title metadata wins without changing body identity');
  assert.strictEqual(model.titleConflict(local, remote), true);
}

{
  assert.deepStrictEqual(ui.sourceGroupsFromFilters(new Set(['work/api', '__pinned__'])), ['work/api']);
}

{
  const record = conflictModel.createConflictRecord({ kind: 'title', left: { text: 'a' }, right: { text: 'b' } }, { now: 1000 });
  const stateA = conflictModel.normalizeConflictState({ records: [record] });
  const stateB = conflictModel.removeConflictRecord(stateA, record.id, 2000);
  const recurring = conflictModel.createConflictRecord({ kind: 'title', left: { text: 'a' }, right: { text: 'b' } }, { now: 3000 });
  assert.strictEqual(recurring.id, record.id, 'same conflict content gets stable id');
  const merged = conflictModel.mergeConflictStates({ records: [recurring] }, stateB, 4000);
  assert.strictEqual(merged.records.length, 0, 'conflict tombstone removes old unresolved record');
  assert.strictEqual(merged.tombstones.length, 1);
}

{
  const base = [
    { id: 'a', type: 'text', text: 'alpha invoice', ts: 10, pin: { groups: ['work'] } },
    { id: 'b', type: 'text', text: 'beta macro', ts: 20, pin: { number: 2, groups: ['code'] } },
    { id: 'c', type: 'text', title: 'API plan', text: 'gamma note', ts: 30, pin: { groups: ['work/api'] } },
  ];
  assert.deepStrictEqual(ui.groupsOf({ id: 'legacy', type: 'text', text: 'legacy', ts: 1, labels: ['work'], pin: null }), []);
  assert.deepStrictEqual(ui.groupsOf(base[0]), model.groupsOf(base[0]));
  assert.deepStrictEqual(ui.filterItems(base, { filters: new Set(['__numbered__']), query: '', regex: false }).map(i => i.id), ['b']);
  assert.deepStrictEqual(ui.BUILTIN_FILTERS.map(f => f.id), ['__pinned__', '__numbered__', '__images__']);
  assert.strictEqual(ui.builtinFilterTitle({ id: '__pinned__', label: 'Pinned', count: 2 }), '2 pinned items');
  assert.deepStrictEqual(ui.builtinFilters(base, new Set(['__numbered__'])).map(f => [f.id, f.count, f.active]), [
    ['__pinned__', 3, false],
    ['__numbered__', 1, true],
  ]);
  const filterBar = ui.renderFilterBar({ items: base, groups: ['code', 'work/api'], activeFilters: new Set(['__numbered__']), query: '' });
  assert(filterBar.includes('data-filter="__numbered__"'));
  assert(filterBar.includes('data-group="code"'));
  assert(filterBar.includes('data-group="work"'));
  assert(filterBar.includes('data-group="work/api"'));
  assert(filterBar.includes('class="tag-submenu"'));
  assert(!filterBar.includes('data-action="toggle-tag-parent"'));
  assert(!filterBar.includes('data-filter="image"'));
  assert(!filterBar.includes('class="chip'));
  const clipItem = ui.renderClipItem(base[1], { imageSrc: () => '' });
  assert(clipItem.includes('class="item has-pin"'));
  assert(clipItem.includes('class="numpad-tag">#2</span>'));
  assert(clipItem.includes('class="filter-tag group-tag" data-group="code"'));
  const picker = ui.renderItemPicker(base[1], { items: base, groups: ['code', 'work/api'] });
  assert(picker.includes('class="np-btn current" data-n="2"'));
  assert(/class="gp-btn assigned[^"]*" data-group="code"/.test(picker));
  assert(picker.includes('data-group="work/api"'));
  assert(picker.includes('class="tag-submenu"'));
  assert(picker.includes('data-action="add-group"'));
  assert.deepStrictEqual(ui.filterItems(base, { filters: new Set(['work']), query: 'invoice', regex: false }).map(i => i.id), ['a']);
  assert.deepStrictEqual(ui.filterItems(base, { filters: new Set(['work']), query: '', regex: false }).map(i => i.id).sort(), ['a', 'c']);
  assert.deepStrictEqual(ui.filterItems(base, { excludedFilters: new Set(['work']), query: '', regex: false }).map(i => i.id), ['b']);
  assert.deepStrictEqual(ui.filterItems(base, { filters: new Set(), query: 'api plan', regex: false }).map(i => i.id), ['c']);
  assert.deepStrictEqual(ui.filterItemIndexes(base, { filters: new Set(['__numbered__', 'code']), query: 'macro', regex: false }), [1]);
  assert.deepStrictEqual(ui.filterItemIndexes(base, { filters: new Set(['__numbered__', 'work']), query: '', regex: false }), []);
  assert.deepStrictEqual(ui.filterItems(base, { filters: new Set(['code']), query: 'text', regex: false }).map(i => i.id), ['b']);
  const filterState = { filters: new Set(), excludedFilters: new Set() };
  assert.strictEqual(ui.hasActiveFilters(filterState), false);
  assert.strictEqual(ui.applyFilterIntent(filterState, 'work', 'include'), true);
  assert.deepStrictEqual([...filterState.filters], ['work']);
  assert.deepStrictEqual(ui.filterItems(base, { ...filterState, query: '', regex: false }).map(i => i.id).sort(), ['a', 'c']);
  assert.strictEqual(ui.applyFilterIntent(filterState, 'code', 'exclude'), true);
  assert.deepStrictEqual([...filterState.excludedFilters], ['code']);
  assert.deepStrictEqual(ui.filterItems(base, { ...filterState, query: '', regex: false }).map(i => i.id).sort(), ['a', 'c']);
  assert.strictEqual(ui.applyFilterIntent(filterState, 'work', 'exclude'), true);
  assert.deepStrictEqual([...filterState.filters], []);
  assert.deepStrictEqual([...filterState.excludedFilters].sort(), ['code', 'work']);
  assert.deepStrictEqual(ui.filterItems(base, { ...filterState, query: '', regex: false }).map(i => i.id), []);
  assert.strictEqual(ui.applyFilterIntent(filterState, 'work', 'include'), true);
  assert.deepStrictEqual([...filterState.excludedFilters], ['code']);
  assert.deepStrictEqual(ui.filterItems(base, { ...filterState, query: '', regex: false }).map(i => i.id).sort(), ['a', 'c']);
  assert.strictEqual(ui.applyFilterIntent(filterState, 'code', 'exclude'), true);
  assert.strictEqual(ui.hasActiveFilters(filterState), false);
  assert.strictEqual(ui.itemCountLabel(2, 1, { excludedFilters: new Set(['code']) }), '1 of 2 items');
  const excludedBar = ui.renderFilterBar({ items: base, groups: ['work'], excludedFilters: new Set(['__numbered__', 'work']), query: '' });
  assert(excludedBar.includes('excluded'));
  assert(excludedBar.includes('data-action="clear-search-filters"'));
  ui.clearFilterState(filterState);
  assert.strictEqual(ui.hasActiveFilters(filterState), false);
  const searchTexts = base.map(ui.itemSearchText);
  const searchTextLower = searchTexts.map(s => s.toLowerCase());
  assert.deepStrictEqual(ui.filterItemIndexes(base, { filters: new Set(), query: 'INVOICE', regex: false, searchTexts, searchTextLower }), [0]);
  assert.deepStrictEqual(ui.filterItemIndexes(base, { filters: new Set(), query: '[', regex: true, searchTexts, searchTextLower }), []);
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
  const appHtml = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
  const siteHtml = fs.readFileSync(path.join(__dirname, '..', 'site', 'index.html'), 'utf8');
  const siteCss = fs.readFileSync(path.join(__dirname, '..', 'site', 'styles.css'), 'utf8');
  const sharedCss = fs.readFileSync(path.join(__dirname, '..', 'site', 'shared', 'clipboard-popup.css'), 'utf8');
  assert(appHtml.includes('site/shared/clipboard-popup.css'));
  assert(siteHtml.includes('/shared/clipboard-popup.css'));
  assert(appHtml.includes('Core.renderFilterBar'));
  // The settings markup now lives in the shared renderer (Core.renderSettingsBody),
  // not inline in index.html — but the app still wires its handlers.
  assert(appHtml.includes('Core.renderSettingsBody'));
  assert(siteHtml.includes('Core.renderSettingsBody'));
  assert(ui.renderSettingsBody().includes('id="quickPasteRecord"'));
  assert(ui.renderSettingsBody().includes('Quick paste'));
  assert(appHtml.includes('window.api.setQuickPasteShortcut'));
  assert(siteHtml.includes('Core.renderFilterBar'));
  assert(appHtml.includes('Core.renderClipItem'));
  assert(siteHtml.includes('Core.renderClipItem'));
  assert(appHtml.includes('Core.renderItemPicker'));
  assert(siteHtml.includes('Core.renderItemPicker'));
  assert(appHtml.includes('Core.renderPopupShell'));
  assert(siteHtml.includes('Core.renderPopupShell'));
  const shellHtml = ui.renderPopupShell({ headerActionsHtml: '<button id="syncHeaderBtn"></button>' });
  assert(shellHtml.includes('id="syncHeaderBtn"'));
  assert(shellHtml.indexOf('id="syncHeaderBtn"') < shellHtml.indexOf('id="settingsBtn"'));
  assert(!siteHtml.includes('window-head'));
  assert(!siteHtml.includes('icon-settings'));
  assert(!siteHtml.includes('demo-settings-note'));
  for (const selector of ['main-view', 'sticky', 'count', 'close-btn', 'icon-btn', 'search-row', 'search', 'filter-tag', 'item', 'preview', 'meta', 'star', 'numpad-picker', 'np-row', 'np-btn', 'gp-row', 'gp-btn', 'empty', 'settings-view', 'setting-row', 'switch', 'np-slot', 'group-slot', 'sync-account']) {
    assert(sharedCss.includes(`.${selector}`), `shared popup css owns .${selector}`);
    assert(!new RegExp(`^\\s*\\.${selector}(?![-\\w])`, 'm').test(appHtml), `app must not redefine .${selector}`);
    assert(!new RegExp(`^\\s*\\.${selector}(?![-\\w])`, 'm').test(siteCss), `site css must not redefine .${selector}`);
  }
}

{
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'boardclip-text-blobs-'));
  try {
    const longText = `header\n${'x'.repeat(textBlobStore.TEXT_BLOB_THRESHOLD_BYTES + 32)}\nfooter`;
    const item = text(longText, { ts: 123, updatedAt: 123 });
    const stored = textBlobStore.prepareHistoryForStorage([item], dir);
    assert.strictEqual(stored.length, 1);
    assert.strictEqual(stored[0].text.length, textBlobStore.TEXT_PREVIEW_CHARS);
    assert.strictEqual(stored[0].textPreview, stored[0].text);
    assert.strictEqual(stored[0].textSize, Buffer.byteLength(longText, 'utf8'));
    assert.strictEqual(stored[0].id, `txt:${stored[0].textHash}`);
    assert(fs.existsSync(path.join(dir, stored[0].textRef)));

    const hydrated = textBlobStore.hydrateHistory(JSON.parse(JSON.stringify(stored)), dir);
    assert.strictEqual(hydrated[0].text, longText);
    assert.strictEqual(model.itemKey(hydrated[0]), item.id);

    const remotePreviewOnly = { ...stored[0], text: stored[0].textPreview, ts: 200, updatedAt: 200 };
    const merged = model.mergeHistories([hydrated[0]], [remotePreviewOnly], {});
    assert.strictEqual(merged[0].text, longText);
    assert.strictEqual(merged[0].updatedAt, 200);

    const missingBlobItem = { ...stored[0], text: stored[0].textPreview };
    const preserved = textBlobStore.prepareHistoryForStorage([missingBlobItem], path.join(dir, 'missing-out'))[0];
    assert.strictEqual(preserved.textHash, stored[0].textHash);
    assert.strictEqual(preserved.textRef, stored[0].textRef);
    assert.strictEqual(preserved.text, stored[0].textPreview);

    const blockedDir = path.join(dir, 'not-a-dir');
    fs.writeFileSync(blockedDir, 'file blocks directory creation');
    const fallback = textBlobStore.prepareHistoryForStorage([item], blockedDir)[0];
    assert.strictEqual(fallback.text, longText);
    assert.strictEqual(fallback.textRef, undefined);
    assert.strictEqual(fallback.textHash, undefined);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

{
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'boardclip-diagnostics-'));
  const file = path.join(dir, 'diagnostics.jsonl');
  try {
    const diagnostics = new Diagnostics({ filePath: file, enabled: false });
    diagnostics.record('ignored', { value: 'nope' });
    assert.strictEqual(fs.existsSync(file), false);
    diagnostics.slow('slow-path', 101, { value: 'ok' }, 100);
    assert(fs.readFileSync(file, 'utf8').includes('"event":"slow-path"'));
    diagnostics.setEnabled(true);
    diagnostics.record('enabled-path', { secret: 'x'.repeat(600) });
    const lines = fs.readFileSync(file, 'utf8');
    assert(lines.includes('"event":"enabled-path"'));
    assert(!lines.includes('x'.repeat(600)));
    assert.strictEqual(diagnostics.snapshot().recent_events.length, 4);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

{
  const settings = {
    sync_path: '.',
    sync_custom_paths: ['.', path.join(os.tmpdir(), 'boardclip-sync-a'), path.join(os.tmpdir(), 'boardclip-sync-a')],
    sync_disabled_paths: ['.', path.join(os.tmpdir(), 'boardclip-sync-b')],
  };
  syncPaths.migrateSyncSettings(settings);
  assert.deepStrictEqual(settings.sync_custom_paths, [path.join(os.tmpdir(), 'boardclip-sync-a')]);
  assert.strictEqual(settings.sync_path, path.join(os.tmpdir(), 'boardclip-sync-a'));
  assert.deepStrictEqual(settings.sync_disabled_paths, [path.join(os.tmpdir(), 'boardclip-sync-b')]);
  assert.strictEqual(syncPaths.addCustomSyncPath(settings, '.'), '');
  assert.strictEqual(syncPaths.addCustomSyncPath(settings, path.join(os.tmpdir(), 'boardclip-sync-c')), path.join(os.tmpdir(), 'boardclip-sync-c'));
  assert(settings.sync_custom_paths.includes(path.join(os.tmpdir(), 'boardclip-sync-c')));
}

{
  assert(clipboardCapture.formatsSuggestImage(['image/png']));
  assert(clipboardCapture.formatsSuggestImage(['FileDrop']));
  assert(clipboardCapture.formatsSuggestImage(['FileGroupDescriptorW', 'FileContents']));
  assert(clipboardCapture.formatsSuggestImage(['text/uri-list']));
  assert(clipboardCapture.formatsSuggestFileTransfer(['FileGroupDescriptorW', 'FileContents']));
  assert(clipboardCapture.formatsSuggestFileTransfer(['text/uri-list']));
  assert(!clipboardCapture.formatsSuggestFileTransfer(['image/png']));
  assert(!clipboardCapture.formatsSuggestImage(['text/plain']));
  assert.strictEqual(clipboardCapture.formatsKey(['b', 'a']), 'a|b');

  const emptyImage = {
    isEmpty: () => true,
    toPNG: () => Buffer.alloc(0),
    getSize: () => ({ width: 0, height: 0 }),
  };
  const capturedImage = {
    isEmpty: () => false,
    toPNG: () => Buffer.from('png-bytes'),
    getSize: () => ({ width: 12, height: 8 }),
  };
  const fakeNativeImage = {
    createFromBuffer: buffer => buffer && buffer.length ? capturedImage : emptyImage,
  };
  let readImageCalls = 0;
  const fakeClipboard = {
    availableFormats: () => ['FileDrop'],
    readImage: () => {
      readImageCalls += 1;
      return emptyImage;
    },
  };
  const captured = clipboardCapture.readClipboardImage({
    clipboard: fakeClipboard,
    nativeImage: fakeNativeImage,
    platform: 'win32',
    windowsClipboard: {
      readImageCandidate: () => ({ buffer: Buffer.from('fake-image'), source: 'win32-file', path: 'C:\\tmp\\photo.png' }),
    },
  });
  assert.strictEqual(captured.source, 'win32-file');
  assert.strictEqual(captured.width, 12);
  assert.strictEqual(captured.height, 8);
  assert.strictEqual(captured.path, 'C:\\tmp\\photo.png');
  assert.strictEqual(readImageCalls, 0);

  const dib = Buffer.alloc(40);
  dib.writeUInt32LE(40, 0);
  dib.writeInt32LE(1, 4);
  dib.writeInt32LE(1, 8);
  dib.writeUInt16LE(1, 12);
  dib.writeUInt16LE(32, 14);
  const bmp = windowsClipboard.dibToBmpBuffer(dib);
  assert.strictEqual(bmp.toString('ascii', 0, 2), 'BM');
  assert.strictEqual(bmp.readUInt32LE(10), 54);
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
  assert.strictEqual(autoUpdate.updateModeForChangedFiles(['site/shared/clipboard-popup.css']), 'reload');
  assert.strictEqual(autoUpdate.updateModeForChangedFiles(['main.js']), 'relaunch');
  assert.strictEqual(autoUpdate.updateModeForChangedFiles([]), 'none');
}


{
  // Regression for the 2026-07 sync loss: content-hash edits used to look like
  // delete(old-id) + create(new-id). A stale provider carrying the old item could
  // then lose the live edited item through the tombstone race. Supersedes must
  // tell mergeHistories that old-id is an EDIT lineage, not a hard delete.
  const now = Date.now();
  const oldItem = text('launch note verbose stale old body', { ts: Math.floor(now / 1000) - 100, updatedAt: now - 100000, pin: { groups: ['todo'], updatedAt: now - 100000 }, pinUpdatedAt: now - 100000 });
  const editedItem = text('v2', { ts: Math.floor(now / 1000), updatedAt: now, pin: { groups: ['todo'], updatedAt: now }, pinUpdatedAt: now });
  const tombstone = { id: oldItem.id, deletedAt: now };
  const supersede = { from: oldItem.id, to: editedItem.id, updatedAt: now };

  const withoutSupersedes = model.mergeHistories([editedItem], [oldItem], { tombstones: [tombstone] });
  assert.deepStrictEqual(withoutSupersedes.map(i => i.text), ['v2'], 'baseline: hard tombstone still deletes the stale old copy');

  const merged = model.mergeHistories([editedItem], [oldItem], { tombstones: [tombstone], supersedes: [supersede] });
  assert.strictEqual(merged.length, 1, 'stale old copy should merge into the edited item, not duplicate or delete it');
  assert.strictEqual(merged[0].id, editedItem.id);
  assert.strictEqual(merged[0].text, 'v2');
  assert.deepStrictEqual(model.groupsOf(merged[0]), ['todo']);
}

{
  const item = text('rename me', { ts: 10, updatedAt: 10000 });
  const history = [item];
  const result = model.applyTextEdit(history, {
    id: item.id,
    originalText: 'rename me',
    newText: 'renamed',
    now: 50000,
  });
  assert.strictEqual(result.changed, true);
  assert.strictEqual(result.tombstoneIds.length, 1);
  assert.deepStrictEqual(result.supersedes, [{ from: result.tombstoneIds[0], to: result.item.id, updatedAt: 50000 }]);
}

{
  // CAS guarantee ('delete clobbering guarded by hash'): ids ARE content hashes,
  // so an edit with a stale originalText must NEVER overwrite the live body —
  // it records a conflict instead (compare-and-swap semantics).
  const item = text('live body v2', { ts: 10, updatedAt: 10000 });
  const history = [item];
  const result = model.applyTextEdit(history, {
    id: item.id,
    originalText: 'stale body v1', // caller's outdated view
    newText: 'attacker overwrite',
    now: 50000,
  });
  assert.strictEqual(result.changed, true);
  assert.notStrictEqual(result.reason, 'updated', 'stale-view edit must not update in place');
  assert.ok(result.conflict, 'stale-view edit surfaces a conflict');
  assert.strictEqual(history.some(i => i.text === 'live body v2'), true, 'live body survives');
}

{
  // Deleting the OLD id of an edited clip must not kill the edited version:
  // tombstone(oldId) + supersede(oldId -> newId) = edit lineage, new survives.
  const now = Date.now();
  const edited = text('kept new version', { ts: Math.floor(now / 1000), updatedAt: now });
  const oldId = 'txt:' + '0'.repeat(64);
  const merged = model.mergeHistories([edited], [], {
    tombstones: [{ id: oldId, deletedAt: now }],
    supersedes: [{ from: oldId, to: edited.id, updatedAt: now }],
  });
  assert.deepStrictEqual(merged.map(i => i.text), ['kept new version']);
}

console.log('clipboard model tests passed');
