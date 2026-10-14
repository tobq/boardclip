'use strict';

// Flat tags (14 Oct 2026): the one tag rule (site/shared/clip-search.js), the cutover
// plan (clipboardModel.planTagState) and how merges keep history safe. Every scenario
// here is one a mapping pass proved could lose, revive or fork clips if done wrong.

const assert = require('assert');
const Tags = require('../site/shared/clip-search');
const M = require('../lib/clipboard-model');
const mcpCore = require('../lib/mcp-core');

const T0 = 1791000000000;
const text = (id, groups, extra = {}) => ({
  id: `txt:${id}`, type: 'text', text: id, ts: T0 / 1000, updatedAt: T0,
  pin: groups ? { groups, groupsUpdatedAt: T0, updatedAt: T0 } : null,
  ...extra,
});
const clone = (v) => JSON.parse(JSON.stringify(v));

// 1) The tag rule.
{
  assert.deepStrictEqual(Tags.splitTagInput(' todo, forge ,todo,, Forge '), ['todo', 'forge'], 'commas separate tags, one per tag (case-insensitive)');
  assert.deepStrictEqual(Tags.splitTagInput('AC/DC'), ['AC/DC'], 'a slash is a plain character in a new name');
  assert.strictEqual(Tags.tagKey('  Forge '), 'forge');
  assert.ok(Tags.sameTag('Notes', 'notes'));
  assert.strictEqual(Tags.preferredSpelling('Notes', 'notes'), 'notes', 'fewest capitals wins');
  assert.strictEqual(Tags.preferredSpelling('BC launch', 'Bc Launch'), 'BC launch', 'then code-point order, the same on every device');
  const list = ['todo', 'forge'];
  assert.strictEqual(Tags.expandTagNames(list, new Map(), Tags.tagSpellings([list])), list, 'an untouched list is returned as is (same JSON, same rev)');
  const splits = new Map([['todo/forge', ['todo', 'forge']]]);
  assert.deepStrictEqual(Tags.expandTagNames(['forge', 'Todo/Forge', 'x'], splits, Tags.tagSpellings([['todo', 'forge', 'x']])), ['forge', 'todo', 'x'], 'a retired name becomes its parts, deduped, first occurrence first');
  assert.deepStrictEqual(Tags.nestedNameParts(' a / b //c/ '), ['a', 'b', 'c']);
  const doc = Tags.clipToDoc(text('a', ['Forge']));
  assert.ok(Tags.docInGroup(doc, 'forge') && Tags.docInGroup(doc, 'FORGE'), 'group: matches in any case');
  assert.ok(!Tags.docInGroup(Tags.clipToDoc(text('b', ['todo/forge'])), 'todo'), 'no family: a literal slash name is not under its prefix');
}

// 2) The cutover plan on a copy of the owner's shape.
const settingsBefore = () => ({
  groups: ['todo', 'AI', 'todo/forge', 'forge', 'todo/done', 'twoshot/support', 'twoshot', 'Notes', 'notes', 'private', 'x/AI'],
  groups_shared_with_ai: ['todo', 'AI', 'todo/forge', 'forge', 'todo/done', 'twoshot/support', 'twoshot'],
  group_tombstones: [{ name: 'gone', deletedAt: T0 - 1000 }],
  facet_joins: { group: 'or', type: 'and' },
});
const historyBefore = () => [
  text('a', ['todo/forge']),
  text('b', ['todo', 'todo/forge', 'todo/done']),
  text('c', ['forge']),
  text('d', ['twoshot/support']),
  text('e', ['Notes']),
  text('f', ['notes', 'private']),
  text('g', ['x/AI']),
  text('h', null),
  text('i', ['private']),
];
{
  const history = historyBefore();
  const raw = clone(history);
  const plan = M.planTagState(history, settingsBefore(), { now: T0 + 5000, aiGroupName: 'AI' });
  assert.deepStrictEqual(history, raw, 'the plan never mutates its input');
  const tags = plan.history.map(h => M.groupsOf(h));
  assert.deepStrictEqual(tags, [['todo', 'forge'], ['todo', 'forge', 'done'], ['forge'], ['twoshot', 'support'], ['notes'], ['notes', 'private'], ['x'], [], ['private']]);
  assert.strictEqual(plan.history[2], history[2], 'an untouched clip is the very same object');
  assert.strictEqual(plan.history[7], history[7]);
  assert.strictEqual(plan.history[8], history[8]);
  for (let i = 0; i < history.length; i++) {
    assert.strictEqual(M.itemMutationClock(plan.history[i]), M.itemMutationClock(history[i]), 'no clock moves (a stamp would revive clips deleted elsewhere)');
    assert.strictEqual(M.itemKey(plan.history[i]), M.itemKey(history[i]), 'ids never change');
    if (history[i].pin) assert.ok(plan.history[i].pin, 'a pin is never removed (an unpinned clip can be age-pruned)');
  }
  assert.deepStrictEqual(plan.settings.groups, ['todo', 'AI', 'forge', 'done', 'twoshot', 'support', 'notes', 'private', 'x'], 'each nested entry replaced in place by its new parts; case twins become one');
  assert.deepStrictEqual(plan.settings.group_splits.map(r => r.name).sort(), ['todo/done', 'todo/forge', 'twoshot/support', 'x/AI']);
  assert.ok(plan.settings.groups_flattened_at === T0 + 5000, 'the cutover is recorded');
  assert.deepStrictEqual(plan.settings.facet_joins, { type: 'and' }, 'a remembered group join is reset once (tags now AND by default)');
  // Sharing: unanimous, and nothing private becomes visible.
  assert.deepStrictEqual(plan.settings.groups_shared_with_ai, ['todo', 'AI', 'forge', 'done', 'twoshot', 'support']);
  assert.deepStrictEqual(plan.settings.group_splits.find(r => r.name === 'x/AI').parts, ['x'], 'a split never carries the AI tag: x/AI is x, everywhere, from every copy');
  const before = mcpCore.sharedGroupSet({ groups_shared_with_ai: settingsBefore().groups_shared_with_ai });
  const after = mcpCore.sharedGroupSet(plan.settings);
  const oldVisible = history.filter(h => M.groupsOf(h).some(g => settingsBefore().groups_shared_with_ai.includes(g) || g === 'AI')).map(h => h.id);
  const newVisible = plan.history.filter(h => mcpCore.isShared(h, after)).map(h => h.id);
  assert.deepStrictEqual(newVisible, oldVisible, 'the same clips are AI-visible before and after');
  assert.ok(before.has('todo/forge') && !after.has('todo/forge'));
  assert.deepStrictEqual(plan.undo.map(u => u.id).sort(), ['txt:a', 'txt:b', 'txt:d', 'txt:e', 'txt:g'], 'the undo record lists every changed clip (f was already in stored form)');
  assert.deepStrictEqual(plan.undo.find(u => u.id === 'txt:b').groups, ['todo', 'todo/forge', 'todo/done'], 'with its old tags');
  // Idempotent: a second start changes nothing.
  const again = M.planTagState(plan.history, { ...settingsBefore(), ...plan.settings }, { now: T0 + 9000, aiGroupName: 'AI' });
  assert.strictEqual(again.changed, false, 'running it again changes nothing');
  assert.ok(again.history.every((h, i) => h === plan.history[i]));
  // A start that died between its two writes (settings first), or an MCP read between
  // them: the new settings beside the old clips give exactly the clips the full start gave.
  // Nothing the cutover does is a one-off edit, so every later read re-derives it.
  const torn = M.planTagState(historyBefore(), { ...settingsBefore(), ...plan.settings }, { now: T0 + 7000 });
  assert.deepStrictEqual(torn.history.map(h => M.groupsOf(h)), tags, 'the half-written start finishes the same way');
  assert.deepStrictEqual(torn.settings.groups_shared_with_ai, plan.settings.groups_shared_with_ai, 'with the same AI share list');
  assert.deepStrictEqual(torn.settings.groups, plan.settings.groups);
  // After the cutover a new slash name is literal; a retired name still splits.
  const later = M.planTagState([...plan.history, text('j', ['AC/DC']), text('k', ['todo/forge'])], { ...settingsBefore(), ...plan.settings, groups: [...plan.settings.groups, 'AC/DC'] }, { now: T0 + 9000 });
  assert.deepStrictEqual(M.groupsOf(later.history.at(-2)), ['AC/DC'], 'a slash made after the cutover is a plain character');
  assert.deepStrictEqual(M.groupsOf(later.history.at(-1)), ['todo', 'forge'], 'an agent still filing todo/forge lands as todo + forge');
  // A private part never shares: a shared parent with a private nested child.
  const mixed = M.planTagState([text('m', ['work/secret']), text('n', ['work'])], { groups: ['work', 'work/secret'], groups_shared_with_ai: ['work'] }, { now: T0 });
  assert.deepStrictEqual(mixed.settings.groups_shared_with_ai, [], 'a tag fed by a private name is not shared (privacy wins)');
  assert.ok(!mcpCore.isShared(mixed.history[0], mcpCore.sharedGroupSet(mixed.settings)), 'the private clip stays private');
}

// 3) Merges: copies from an old build or a stale provider.
const ctxSettings = () => ({ groups: ['todo', 'forge', 'urgent'], group_splits: [{ name: 'todo/forge', parts: ['todo', 'forge'], at: T0 + 5000 }], tombstones: [], group_tombstones: [], supersedes: [] });
{
  // Equal clocks: the old copy unions in, and its nested name is split again.
  const local = [text('a', ['todo', 'forge'])];
  const remote = [text('a', ['todo/forge'])];
  const remoteRaw = clone(remote);
  const merged = M.mergeHistories(local, remote, ctxSettings());
  assert.deepStrictEqual(M.groupsOf(merged[0]), ['todo', 'forge']);
  assert.deepStrictEqual(remote, remoteRaw, 'normalised by copy, the input untouched');
  // A tag edit still in transit from the old device (newer clock) survives in full.
  const edited = text('a', ['todo/forge', 'urgent']);
  edited.pin.groupsUpdatedAt = T0 + 7000; edited.pin.updatedAt = T0 + 7000;
  const notedLocal = text('a', ['todo', 'forge']);
  notedLocal.updatedAt = T0 + 9000; // a later text/title change: its clock runs ahead of its tags
  assert.deepStrictEqual(M.groupsOf(M.mergeHistories([notedLocal], [edited], ctxSettings())[0]), ['todo', 'forge', 'urgent'], 'no clock bump, so the real edit clock decides and nothing is lost');
}
{
  // A clip deleted on another device before the cutover stays deleted.
  const deletedAt = T0 + 2000;
  const s = { ...ctxSettings(), tombstones: [{ id: 'txt:a', deletedAt }] };
  assert.strictEqual(M.mergeHistories([text('a', ['todo', 'forge'])], [], s).length, 0, 'the flattened local copy does not outrank the delete');
  // Clock skew: a delete made by an old build carries the rev of the NESTED copy.
  const nested = text('a', ['todo/forge']);
  nested.updatedAt = T0 + 50000; nested.pin.updatedAt = T0 + 50000; nested.pin.groupsUpdatedAt = T0 + 50000;
  const skewed = { ...ctxSettings(), tombstones: [{ id: 'txt:a', deletedAt: T0 + 1000, rev: M.clipRevision(nested), revClock: T0 + 50000 }] };
  assert.strictEqual(M.mergeHistories([], [nested], skewed).length, 0, 'the delete still matches the copy it saw (raw rev)');
}
{
  // Group tombstones written by this build: any spelling, one record per tag.
  const t = M.normalizeGroupTombstones([{ name: 'Done', deletedAt: T0, anyCase: true }, { name: 'done', deletedAt: T0 - 5, restoredAt: T0 + 10, anyCase: true }]);
  assert.strictEqual(t.length, 1, 'one record per tag in any case');
  assert.strictEqual(t[0].restoredAt, T0 + 10);
  const del = { ...ctxSettings(), group_tombstones: [{ name: 'Urgent', deletedAt: T0 + 3000, anyCase: true }] };
  const stale = text('a', ['todo', 'urgent']);
  const later = text('b', ['urgent', 'todo']);
  later.pin.groupsUpdatedAt = T0 + 4000; later.pin.updatedAt = T0 + 4000; // another tag changed after the delete
  const merged = M.mergeHistories([stale, later], [], del);
  assert.deepStrictEqual(M.groupsOf(merged.find(h => h.id === 'txt:a')), ['todo'], 'a copy tagged before the delete loses the tag');
  assert.deepStrictEqual(M.groupsOf(merged.find(h => h.id === 'txt:b')), ['todo'], 'so does a copy changed after it: until the tag is re-created it is gone (no clip keeps a tag the tag list no longer has)');
  assert.deepStrictEqual(M.mergeGroups(['todo', 'urgent'], [], del.group_tombstones), ['todo']);
  const report = [];
  M.mergeHistories([stale], [], del, report);
  const event = report.find(e => e.event === 'normalised' && e.id === 'txt:a');
  assert.ok(event && !event.split, 'a local clip put in stored form is reported (the caller saves it); a delete is not a retired name');
  // Re-created: stale pre-delete copies still cannot bring the old memberships back.
  const recreated = { ...ctxSettings(), group_tombstones: [{ name: 'urgent', deletedAt: T0 + 3000, restoredAt: T0 + 5000, anyCase: true }] };
  const again = M.mergeHistories([stale, later], [], recreated);
  assert.deepStrictEqual(M.groupsOf(again.find(h => h.id === 'txt:a')), ['todo'], 'after a re-create a copy last tagged before the delete still loses it');
  assert.deepStrictEqual(M.groupsOf(again.find(h => h.id === 'txt:b')), ['urgent', 'todo'], 'a copy tagged after the delete keeps it');
  assert.deepStrictEqual(M.mergeGroups(['todo', 'urgent'], [], recreated.group_tombstones), ['todo', 'urgent'], 'the re-created tag is listed');
}
{
  // A delete made by a build before 14 Oct (no anyCase) meant that exact spelling: Work and
  // work were two tags then, so the live twin survives it.
  const s = { ...ctxSettings(), groups: ['work', 'todo'], group_tombstones: [{ name: 'Work', deletedAt: T0 + 3000 }] };
  const live = text('a', ['work']);
  const staleTwin = text('b', ['Work', 'todo']);
  const merged = M.mergeHistories([live, staleTwin], [], s);
  assert.deepStrictEqual(M.groupsOf(merged.find(h => h.id === 'txt:a')), ['work'], 'the live twin keeps its tag');
  assert.deepStrictEqual(M.groupsOf(merged.find(h => h.id === 'txt:b')), ['todo'], 'the deleted spelling goes');
  assert.deepStrictEqual(M.mergeGroups(['Work', 'work', 'todo'], [], s.group_tombstones), ['work', 'todo']);
  const plan = M.planTagState([live, staleTwin], s, { now: T0 + 9000 });
  assert.deepStrictEqual(plan.history.map(h => M.groupsOf(h)), [['work'], ['todo']], 'the cutover applies it the same way');
  assert.strictEqual(M.normalizeGroupTombstones([{ name: 'Work', deletedAt: 1 }, { name: 'work', deletedAt: 2, anyCase: true }], 5).length, 2, 'an exact record and an any-case record are kept apart');
}
{
  // The AI tag never comes out of a retired name or another spelling, from any copy.
  const s = { groups: ['AI', 'drafts'], groups_shared_with_ai: ['AI'], group_splits: [{ name: 'AI/drafts', parts: ['AI', 'drafts'], at: T0 }], groups_flattened_at: T0 };
  const local = text('a', ['drafts']);
  const staleNested = text('a', ['AI/drafts']);
  const merged = M.mergeHistories([local], [staleNested], s);
  assert.deepStrictEqual(M.groupsOf(merged[0]), ['drafts'], 'a stale copy holding AI/drafts does not make the clip AI-visible');
  const torn = M.planTagState([text('t', ['AI/drafts'])], s, { now: T0 + 1 });
  assert.deepStrictEqual(M.groupsOf(torn.history[0]), ['drafts'], 'nor does a history file still nested beside flat settings (a torn write, an MCP read)');
  const cut = M.planTagState([text('c', ['AI/drafts']), text('d', ['ai', 'x']), text('e', ['AI'])], { groups: ['AI', 'AI/drafts', 'ai', 'x'], groups_shared_with_ai: ['AI'] }, { now: T0 });
  assert.deepStrictEqual(cut.history.map(h => M.groupsOf(h)), [['drafts'], ['ai (old)', 'x'], ['AI']], 'an old private ai tag keeps its clips under its own name');
  assert.ok(!mcpCore.isShared(cut.history[1], mcpCore.sharedGroupSet(cut.settings)), 'and stays private');
  assert.deepStrictEqual(M.groupsOf(M.mergeHistories([cut.history[1]], [text('d', ['ai', 'x'])], { ...cut.settings })[0]), ['ai (old)', 'x'], 'from a stale copy too');
  assert.deepStrictEqual(M.tagInputNames('ai', { groups: [] }), ['AI'], 'typed ai is the AI tag');
  assert.deepStrictEqual(M.tagInputNames('ai, notes', { groups: ['AI'] }), ['AI', 'notes']);
}
{
  // A name made with a plain '/' on a flat device is never retired by a late cutover.
  const literal = { name: 'AC/DC', at: T0 + 100 };
  const late = M.planTagState([text('a', ['AC/DC', 'todo/forge'])], { groups: ['AC/DC', 'todo/forge'], group_literals: [literal] }, { now: T0 + 200 });
  assert.deepStrictEqual(M.groupsOf(late.history[0]), ['AC/DC', 'todo', 'forge'], 'a known literal is kept; a nested name splits');
  assert.deepStrictEqual(late.settings.group_splits.map(r => r.name), ['todo/forge']);
  // The late device did not know it yet (its old build dropped the record) and split it,
  // with no clock moved.
  const blind = M.planTagState([text('a', ['AC/DC', 'x']), text('b', ['AC', 'DC'])], { groups: ['AC/DC', 'x', 'AC', 'DC'] }, { now: T0 + 200 });
  assert.deepStrictEqual(blind.history.map(h => M.groupsOf(h)), [['AC', 'DC', 'x'], ['AC', 'DC']]);
  const flat = { groups: ['AC/DC', 'x', 'AC', 'DC'], group_literals: [literal], group_splits: blind.settings.group_splits, groups_flattened_at: T0 };
  const onFlat = [text('a', ['AC/DC', 'x']), text('b', ['AC', 'DC'])];
  // Whichever side meets the other first, the copies join back into the name.
  const atFlat = M.mergeHistories(onFlat, blind.history, flat);
  assert.deepStrictEqual(atFlat.map(h => M.groupsOf(h)), [['AC/DC', 'x'], ['AC', 'DC']], 'the flat device keeps the name, no stray AC / DC; a clip really tagged AC + DC is untouched');
  const lateSettings = { ...blind.settings, group_literals: [literal] };
  const report = [];
  const atLate = M.mergeHistories(blind.history, onFlat, lateSettings, report);
  assert.deepStrictEqual(atLate.map(h => M.groupsOf(h)), [['AC/DC', 'x'], ['AC', 'DC']], 'the late device puts the name back once the record arrives');
  assert.ok(report.some(e => e.event === 'normalised' && e.id === 'txt:a'), 'its local clip is reported, so it is saved');
  assert.strictEqual(M.itemMutationClock(atLate[0]), M.itemMutationClock(blind.history[0]), 'no clock moves');
  const edited = clone(blind.history[0]);
  edited.pin.groups = ['AC', 'DC', 'x', 'new']; edited.pin.groupsUpdatedAt = T0 + 9000; // tagged after the split: a real edit
  assert.deepStrictEqual(M.groupsOf(M.mergeHistories([edited], [onFlat[0]], lateSettings)[0]), ['AC', 'DC', 'x', 'new'], 'a real edit (newer clock) is never rewritten');
  assert.ok(!M.splitMapOf(lateSettings).has('ac/dc'), 'the late split no longer applies anywhere');
  // Its own clips, which the other device never sends again (they did not change there),
  // go back from its cutover's undo ledger, only where they still hold what the cutover gave.
  const touched = clone(blind.history[1]);
  touched.pin.groupsUpdatedAt = T0 + 300; // tagged AC + DC all along (and since): left alone
  const own = M.unsplitLiterals([blind.history[0], touched], blind.undo, { ...lateSettings, groups_flattened_at: T0 + 200 });
  assert.deepStrictEqual(own.history.map(h => M.groupsOf(h)), [['AC/DC', 'x'], ['AC', 'DC']]);
  assert.deepStrictEqual(own.ids, ['txt:a']);
  assert.strictEqual(M.itemMutationClock(own.history[0]), M.itemMutationClock(blind.history[0]), 'no clock moves');
  assert.strictEqual(M.unsplitLiterals(own.history, blind.undo, { ...lateSettings, groups_flattened_at: T0 + 200 }).ids.length, 0, 'idempotent');
  // The parts the late cutover listed leave the tag list once no clip holds them.
  const listed = ['x', 'AC', 'DC', 'AC/DC'];
  assert.deepStrictEqual(M.pruneLiteralParts(listed, lateSettings, ['AC/DC', 'x']), ['x', 'AC/DC']);
  assert.deepStrictEqual(M.pruneLiteralParts(listed, lateSettings, ['AC/DC', 'AC', 'DC']), listed, 'a part a clip holds stays');
  assert.strictEqual(M.pruneLiteralParts(listed, { group_literals: [literal] }, []), listed, 'nothing goes unless some device split the name');
}
{
  // A split reaching a device after its cutover follows the cutover's share rule.
  const r = M.shareListAfterNewSplits(['forge', 'AI'], [{ name: 'secret/forge', parts: ['secret', 'forge'] }], ['secret/forge', 'forge']);
  assert.deepStrictEqual(r, { shared: ['AI'], unshared: ['forge'] }, 'a private name split into a shared tag unshares it');
  const list = ['forge'];
  assert.strictEqual(M.shareListAfterNewSplits(list, [{ name: 'secret/forge', parts: ['secret', 'forge'] }], ['forge']).shared, list, 'a name not held here changes nothing');
  assert.strictEqual(M.shareListAfterNewSplits(['forge', 'secret/forge'], [{ name: 'secret/forge', parts: ['forge'] }], ['secret/forge']).unshared.length, 0, 'nor does a name that was shared here');
}
{
  // New clips' tags (a new note, a fork, Keep both) drop deleted tags.
  const edit = M.applyTextEdit([], { id: '', originalText: '', newText: 'n', sourceGroups: ['todo', 'Urgent', 'todo'], groupTombstones: [{ name: 'urgent', deletedAt: T0 - 1, anyCase: true }], now: T0 });
  assert.deepStrictEqual(M.groupsOf(edit.item), ['todo']);
}
{
  // settings.groups across a merge.
  const s = ctxSettings();
  assert.deepStrictEqual(M.mergeGroups(['todo', 'forge'], ['todo/forge', 'Urgent', 'urgent'], [], M.tagContext(s, [['Urgent', 'urgent']])), ['todo', 'forge', 'urgent']);
}

// 4) AI share switches sync per tag.
{
  const a = { forge: { name: 'forge', shared: true, at: T0 } };
  const b = { forge: { name: 'Forge', shared: false, at: T0 + 1 }, seo: { name: 'seo', shared: true, at: T0 } };
  const merged = M.mergeShareStamps(a, b);
  assert.strictEqual(merged.forge.shared, false, 'the newest flip wins');
  assert.strictEqual(M.mergeShareStamps({ x: { name: 'x', shared: true, at: 5 } }, { x: { name: 'x', shared: false, at: 5 } }).x.shared, false, 'a tie never shares');
  assert.deepStrictEqual(M.applyShareStamps(['forge', 'todo'], merged), ['todo', 'seo']);
  const list = ['todo'];
  assert.strictEqual(M.applyShareStamps(list, {}), list, 'no stamps, no change (a device keeps its own list until a switch is flipped)');
  assert.ok(mcpCore.isShared(text('z', ['FORGE']), mcpCore.sharedGroupSet({ groups_shared_with_ai: ['forge'] })), 'sharing matches a tag in any case');
}

console.log('flat-tags tests passed');
