'use strict';

const assert = require('assert');
const model = require('../lib/clipboard-model');
const core = require('../lib/mcp-core');

function textItem(text, { groups, number, ts = 1, title } = {}) {
  const item = { type: 'text', text, ts };
  if (title) item.title = title;
  if (groups || number != null) item.pin = {};
  if (groups) item.pin.groups = groups;
  if (number != null) item.pin.number = number;
  model.ensureItemId(item);
  return item;
}

const settings = { groups: ['AI', 'work', 'private'], groups_shared_with_ai: ['work'] };

const history = [
  textItem('shared work clip body', { groups: ['work'], ts: 5, title: 'Shared title' }),
  textItem('ai bucket clip', { groups: ['AI'], number: 1, ts: 4 }),
  textItem('private secret stuff', { groups: ['private'], ts: 3 }),
  textItem('second work clip', { groups: ['work'], ts: 2 }),
  textItem('totally ungrouped clip', { ts: 1 }),
];

// --- isShared / clipView ---
{
  const set = core.sharedGroupSet(settings);
  assert.strictEqual(set.has('work'), true);
  assert.strictEqual(set.has('AI'), true, 'AI group always shared');
  assert.strictEqual(set.has('private'), false);
}

// Shared clip -> preview + groups present
{
  const v = core.clipView(history[0], { sharedSet: core.sharedGroupSet(settings) });
  assert.strictEqual(v.shared, true);
  assert.strictEqual(v.title, 'Shared title');
  assert.strictEqual(v.preview, 'shared work clip body');
  assert.deepStrictEqual(v.groups, ['work']);
}

// Non-shared clip -> metadata only, no preview, no group names
{
  const v = core.clipView(history[2], { sharedSet: core.sharedGroupSet(settings) });
  assert.strictEqual(v.shared, false);
  assert.strictEqual(v.preview, undefined);
  assert.strictEqual(v.groups, undefined);
  assert.strictEqual(v.type, 'text');
  assert.ok('ts' in v);
}

// A second shared clip in the same group -> preview present (opt-in = shared as-is)
{
  const v = core.clipView(history[3], { sharedSet: core.sharedGroupSet(settings) });
  assert.strictEqual(v.shared, true);
  assert.strictEqual(v.preview, 'second work clip');
}

// --- buildContext ---
{
  const ctx = core.buildContext(history, settings);
  assert.strictEqual(ctx.totalClips, 5);
  assert.strictEqual(ctx.sharedClips, 3); // work x2 + AI x1
  assert.deepStrictEqual(ctx.numpadSlots[1].type, 'text');
  const work = ctx.groups.find(g => g.name === 'work');
  assert.strictEqual(work.shared, true);
  assert.strictEqual(work.count, 2);
  // Private group NAMES are never exposed - only a count.
  assert.strictEqual(ctx.groups.find(g => g.name === 'private'), undefined);
  assert.strictEqual(ctx.privateGroupCount, 1);
}

// clipView exposes only SHARED group names of a shared clip, never private ones.
{
  const item = textItem('multi-group clip', { groups: ['AI', 'private'], ts: 9 });
  const v = core.clipView(item, { sharedSet: core.sharedGroupSet(settings) });
  assert.deepStrictEqual(v.groups, ['AI']); // 'private' withheld
}

// --- listClips ---
{
  const { clips, nonSharedTotal } = core.listClips(history, settings, {});
  // shared only by default: work x2 + AI x1 = 3
  assert.strictEqual(clips.length, 3);
  assert.strictEqual(nonSharedTotal, 2);
  assert.ok(clips.every(c => c.shared === true));
}
{
  const { clips } = core.listClips(history, settings, { includeNonShared: true });
  assert.strictEqual(clips.length, 5);
  assert.strictEqual(clips.filter(c => !c.shared).length, 2);
}
{
  const { clips } = core.listClips(history, settings, { group: 'work' });
  assert.strictEqual(clips.length, 2);
}

// --- searchClips ---
{
  // "clip" appears in shared (work, AI) and non-shared (private, ungrouped)
  const res = core.searchClips(history, settings, { query: 'clip' });
  assert.ok(res.matches.every(m => m.shared));
  assert.ok(res.nonSharedMatches >= 1);
}
{
  // scope:'all' (post-approval) returns non-shared previews too
  const res = core.searchClips(history, settings, { query: 'ungrouped', scope: 'all' });
  assert.strictEqual(res.matches.length, 1);
  assert.strictEqual(res.matches[0].viaApproval, true);
  assert.strictEqual(res.matches[0].preview, 'totally ungrouped clip');
}
{
  const res = core.searchClips(history, settings, { query: 'Shared title' });
  assert.strictEqual(res.matches.length, 1);
  assert.strictEqual(res.matches[0].title, 'Shared title');
}
{
  const privateTitle = textItem('body does not match', { groups: ['private'], title: 'Private Roadmap' });
  const hidden = core.searchClips([privateTitle], settings, { query: 'Private Roadmap' });
  assert.strictEqual(hidden.matches.length, 0);
  assert.strictEqual(hidden.nonSharedMatches, 0, 'private title is not searchable before all-scope approval');
  const approved = core.searchClips([privateTitle], settings, { query: 'Private Roadmap', scope: 'all' });
  assert.strictEqual(approved.matches.length, 1);
  assert.strictEqual(approved.matches[0].title, 'Private Roadmap');
  assert.strictEqual(approved.matches[0].viaApproval, true);
}
// --- fullTextResult: shared-only group filtering, shared by helper + app ---
{
  const item = textItem('full body here', { groups: ['AI', 'private'], ts: 9, title: 'Full title' });
  const r = core.fullTextResult(item, core.sharedGroupSet(settings));
  assert.strictEqual(r.title, 'Full title');
  assert.strictEqual(r.text, 'full body here');
  assert.deepStrictEqual(r.groups, ['AI']); // private filtered out
  assert.strictEqual(r.type, 'text');
}

// --- resolveForRead ---
{
  assert.strictEqual(core.resolveForRead(history, settings, model.itemKey(history[0])).reason, 'ok');
  assert.strictEqual(core.resolveForRead(history, settings, model.itemKey(history[2])).reason, 'not_shared');
  assert.strictEqual(core.resolveForRead(history, settings, model.itemKey(history[3])).reason, 'ok');
  assert.strictEqual(core.resolveForRead(history, settings, 'txt:nope').reason, 'not_found');
}

console.log('mcp-core tests passed');
