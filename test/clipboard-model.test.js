'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const model = require('../lib/clipboard-model');
const ui = require('../site/shared/clipboard-ui-core');
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
  assert.strictEqual(model.numpadSlotOf(history[0]), null);
  assert.deepStrictEqual(model.groupsOf(history[0]), ['work', 'ideas']);
  assert.deepStrictEqual(result.tombstoneIds, []);
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
  const base = [
    { id: 'a', type: 'text', text: 'alpha invoice', ts: 10, pin: { groups: ['work'] } },
    { id: 'b', type: 'text', text: 'beta macro', ts: 20, pin: { number: 2, groups: ['code'] } },
  ];
  assert.deepStrictEqual(ui.groupsOf({ id: 'legacy', type: 'text', text: 'legacy', ts: 1, labels: ['work'], pin: null }), []);
  assert.deepStrictEqual(ui.groupsOf(base[0]), model.groupsOf(base[0]));
  assert.deepStrictEqual(ui.filterItems(base, { filters: new Set(['__numbered__']), query: '', regex: false }).map(i => i.id), ['b']);
  assert.deepStrictEqual(ui.BUILTIN_FILTERS.map(f => f.id), ['__pinned__', '__numbered__', '__images__']);
  assert.deepStrictEqual(ui.builtinFilters(base, new Set(['__numbered__'])).map(f => [f.id, f.count, f.active]), [
    ['__pinned__', 2, false],
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
  const picker = ui.renderItemPicker(base[1], { items: base, groups: ['code', 'work'] });
  assert(picker.includes('class="np-btn current" data-n="2"'));
  assert(picker.includes('class="gp-btn assigned" data-group="code"'));
  assert(picker.includes('data-action="add-group"'));
  assert.deepStrictEqual(ui.filterItems(base, { filters: new Set(['work']), query: 'invoice', regex: false }).map(i => i.id), ['a']);
  assert.deepStrictEqual(ui.filterItemIndexes(base, { filters: new Set(['__numbered__', 'code']), query: 'macro', regex: false }), [1]);
  assert.deepStrictEqual(ui.filterItemIndexes(base, { filters: new Set(['__numbered__', 'work']), query: '', regex: false }), []);
  assert.deepStrictEqual(ui.filterItems(base, { filters: new Set(['code']), query: 'text', regex: false }).map(i => i.id), ['b']);
  const filterState = { filters: new Set(), excludedFilters: new Set() };
  assert.strictEqual(ui.hasActiveFilters(filterState), false);
  assert.strictEqual(ui.applyFilterIntent(filterState, 'work', 'include'), true);
  assert.deepStrictEqual([...filterState.filters], ['work']);
  assert.deepStrictEqual(ui.filterItems(base, { ...filterState, query: '', regex: false }).map(i => i.id), ['a']);
  assert.strictEqual(ui.applyFilterIntent(filterState, 'code', 'exclude'), true);
  assert.deepStrictEqual([...filterState.excludedFilters], ['code']);
  assert.deepStrictEqual(ui.filterItems(base, { ...filterState, query: '', regex: false }).map(i => i.id), ['a']);
  assert.strictEqual(ui.applyFilterIntent(filterState, 'work', 'exclude'), true);
  assert.deepStrictEqual([...filterState.filters], []);
  assert.deepStrictEqual([...filterState.excludedFilters].sort(), ['code', 'work']);
  assert.deepStrictEqual(ui.filterItems(base, { ...filterState, query: '', regex: false }).map(i => i.id), []);
  assert.strictEqual(ui.applyFilterIntent(filterState, 'work', 'include'), true);
  assert.deepStrictEqual([...filterState.excludedFilters], ['code']);
  assert.deepStrictEqual(ui.filterItems(base, { ...filterState, query: '', regex: false }).map(i => i.id), ['a']);
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
  assert(appHtml.includes('id="quickPasteRecord"'));
  assert(appHtml.includes('window.api.setQuickPasteShortcut'));
  assert(appHtml.includes('Quick paste'));
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

console.log('clipboard model tests passed');
