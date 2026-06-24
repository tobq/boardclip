'use strict';

const assert = require('assert');
const model = require('../lib/clipboard-model');
const core = require('../lib/mcp-core');

// Assembled so no full provider-token literal sits in source (push protection).
const GHP = 'ghp' + '_AbCdEf0123456789AbCdEf0123456789abcd';

function textItem(text, { groups, number, ts = 1, shareAnyway } = {}) {
  const item = { type: 'text', text, ts };
  if (groups || number != null) item.pin = {};
  if (groups) item.pin.groups = groups;
  if (number != null) item.pin.number = number;
  if (shareAnyway) item.shareAnyway = true;
  model.ensureItemId(item);
  return item;
}

const settings = { groups: ['AI', 'work', 'private'], groups_shared_with_ai: ['work'] };

const history = [
  textItem('shared work clip body', { groups: ['work'], ts: 5 }),
  textItem('ai bucket clip', { groups: ['AI'], number: 1, ts: 4 }),
  textItem('private secret stuff', { groups: ['private'], ts: 3 }),
  textItem(GHP, { groups: ['work'], ts: 2 }), // secret in shared group
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

// Secret in a shared group -> withheld
{
  const v = core.clipView(history[3], { sharedSet: core.sharedGroupSet(settings) });
  assert.strictEqual(v.shared, true);
  assert.strictEqual(v.secret, true);
  assert.strictEqual(v.preview, '[likely secret, hidden]');
}

// shareAnyway override exposes a would-be secret
{
  const item = textItem(GHP, { groups: ['work'], ts: 9, shareAnyway: true });
  const v = core.clipView(item, { sharedSet: core.sharedGroupSet(settings) });
  assert.strictEqual(v.secret, undefined);
  assert.ok(v.preview.startsWith('ghp_'));
}

// --- buildContext ---
{
  const ctx = core.buildContext(history, settings);
  assert.strictEqual(ctx.totalClips, 5);
  assert.strictEqual(ctx.sharedClips, 3); // work x2 + AI x1
  assert.strictEqual(ctx.withheldSecrets, 1);
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
  // SECURITY: a withheld-secret clip in a shared group must NOT appear in search
  // results (its presence would be a match-oracle for the hidden value).
  const res = core.searchClips(history, settings, { query: 'ghp_AbCdEf', regex: false });
  assert.strictEqual(res.matches.length, 0, 'secret clip not revealed via search');
  assert.strictEqual(res.withheldSecretMatches, 1);
  // Even a regex prefix-probe (the char-by-char reconstruction attack) reveals nothing.
  const probe = core.searchClips(history, settings, { query: '^ghp_A', regex: true });
  assert.strictEqual(probe.matches.length, 0);
  assert.strictEqual(probe.withheldSecretMatches, 1);
  // shareAnyway clears the withhold so it becomes a normal shared match.
  const okItem = textItem(GHP, { groups: ['work'], ts: 7, shareAnyway: true });
  const withOverride = core.searchClips([okItem], settings, { query: 'ghp_AbCdEf' });
  assert.strictEqual(withOverride.matches.length, 1);
  assert.strictEqual(withOverride.matches[0].secret, undefined);
}

// --- fullTextResult: shared-only group filtering, shared by helper + app ---
{
  const item = textItem('full body here', { groups: ['AI', 'private'], ts: 9 });
  const r = core.fullTextResult(item, core.sharedGroupSet(settings));
  assert.strictEqual(r.text, 'full body here');
  assert.deepStrictEqual(r.groups, ['AI']); // private filtered out
  assert.strictEqual(r.type, 'text');
}

// --- resolveForRead ---
{
  assert.strictEqual(core.resolveForRead(history, settings, model.itemKey(history[0])).reason, 'ok');
  assert.strictEqual(core.resolveForRead(history, settings, model.itemKey(history[2])).reason, 'not_shared');
  assert.strictEqual(core.resolveForRead(history, settings, model.itemKey(history[3])).reason, 'secret_hidden');
  assert.strictEqual(core.resolveForRead(history, settings, 'txt:nope').reason, 'not_found');
}

console.log('mcp-core tests passed');
