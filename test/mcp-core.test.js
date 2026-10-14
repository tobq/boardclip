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
  assert.strictEqual('privateGroupCount' in ctx, false, 'no count of private groups (a free create_group would move it)');
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
  // The AI tool speaks the app's whole language (Advanced): /regex/, OR, groups.
  const regexHits = core.searchClips(history, settings, { query: '/c.ip/', scope: 'all' });
  assert.ok(regexHits.matches.length >= 1, 'a /regex/ term');
  assert.strictEqual(core.searchClips(history, settings, { query: 'c.ip', scope: 'all' }).matches.length, 0, 'plain text is literal');
  const either = core.searchClips(history, settings, { query: 'ungrouped OR zzznothing', scope: 'all' });
  assert.strictEqual(either.matches.length, 1, 'OR');
  // Legacy regex: true reads the free text as ONE regex.
  assert.ok(core.searchClips(history, settings, { query: 'c.ip', regex: true, scope: 'all' }).matches.length >= 1, 'legacy regex flag');
}
{
  // "clip" appears in shared (work, AI) and non-shared (private, ungrouped): only the
  // shared ones are searched, and the result says how many were not (any query).
  const res = core.searchClips(history, settings, { query: 'clip' });
  assert.ok(res.matches.every(m => m.shared));
  assert.strictEqual(res.nonSharedTotal, 2);
  assert.ok(/include_unshared: true/.test(res.hint), 'the hint says how to search them too');
  assert.strictEqual('nonSharedMatches' in res, false, 'no count of private matches');
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
  assert.strictEqual(hidden.nonSharedTotal, 1, 'private title is not searchable before all-scope approval');
  const approved = core.searchClips([privateTitle], settings, { query: 'Private Roadmap', scope: 'all' });
  assert.strictEqual(approved.matches.length, 1);
  assert.strictEqual(approved.matches[0].title, 'Private Roadmap');
  assert.strictEqual(approved.matches[0].viaApproval, true);
}
// --- fullTextResult: shared-only group filtering, shared by helper + app ---
{
  const item = textItem('full body here', { groups: ['AI', 'private'], ts: 9, title: 'Full title' });
  const r = core.fullTextResult(item, { settings });
  assert.strictEqual(r.title, 'Full title');
  assert.strictEqual(r.text, 'full body here');
  assert.deepStrictEqual(r.groups, ['AI']); // private filtered out
  assert.strictEqual(r.type, 'text');
}

// --- searchClips understands the shared query grammar (unified with the app) ---
{
  // title: scope — matches the shared clip's title, and the boundary still hides
  // non-shared titles unless scope:'all'.
  const byTitle = core.searchClips(history, settings, { query: 'title:Shared' });
  assert.strictEqual(byTitle.matches.length, 1);
  assert.strictEqual(byTitle.matches[0].title, 'Shared title');
  // is:pinned facet — only the numbered/pinned AI-bucket clip is shared + pinned
  const pinned = core.searchClips(history, settings, { query: 'is:numpad' });
  assert.ok(pinned.matches.every(m => m.numpad != null));
  assert.ok(pinned.matches.length >= 1);
  // negation: shared clips containing "clip" but not "second"
  const neg = core.searchClips(history, settings, { query: 'clip -second' });
  assert.ok(neg.matches.every(m => !/second/i.test(m.preview || '')));
  // since: bound (all our items have tiny ts, so since a huge past ms keeps them)
  const since = core.searchClips(history, settings, { query: 'clip since:1970-01-01' });
  assert.ok(since.matches.length >= 1);
  // a title: scope must NOT leak a non-shared title pre-approval
  const privateTitle = textItem('body no match', { groups: ['private'], title: 'Secret Plan' });
  assert.strictEqual(core.searchClips([privateTitle], settings, { query: 'title:Secret' }).matches.length, 0);
  assert.strictEqual(core.searchClips([privateTitle], settings, { query: 'title:Secret', scope: 'all' }).matches.length, 1);
}

// --- resolveForRead: a public id (real for a shared clip, opaque for any other) ---
{
  assert.strictEqual(core.resolveForRead(history, settings, model.itemKey(history[0])).reason, 'ok');
  assert.strictEqual(core.resolveForRead(history, settings, core.publicId(history[2], settings)).reason, 'not_shared');
  assert.strictEqual(core.resolveForRead(history, settings, model.itemKey(history[3])).reason, 'ok');
  assert.strictEqual(core.resolveForRead(history, settings, 'txt:nope').reason, 'not_found');
  // A private clip's real id (its content hash) answers exactly like a missing one.
  assert.deepStrictEqual(core.resolveForRead(history, settings, model.itemKey(history[2])), core.resolveForRead(history, settings, 'txt:nope'));
}

// --- rev on every view (shared, metadata-only, full text): the keyed public rev ---
{
  for (const item of history) {
    const rev = core.clipView(item, { settings }).rev;
    assert.strictEqual(rev, core.publicRev(item, settings), 'clipView carries the public rev');
    assert.notStrictEqual(rev, model.clipRevision(item), 'never the real rev');
    assert.ok(/^[0-9a-f]{16}$/.test(rev));
  }
  assert.strictEqual(core.clipView(history[2], { settings }).shared, false);
  assert.ok(core.clipView(history[2], { settings }).rev, 'metadata-only view still carries rev');
  assert.strictEqual(core.fullTextResult(history[0], { settings }).rev, core.publicRev(history[0], settings));
}

// --- flat tags: case-insensitive, several named at once, retired nested names ---
{
  const Search = require('../site/shared/clip-search');
  const tagSettings = {
    groups: ['AI', 'todo', 'forge', 'Work', 'secretproj', 'a, b'],
    groups_shared_with_ai: ['TODO', 'forge', 'work', 'a, b'],
    group_splits: [{ name: 'todo/forge', parts: ['todo', 'forge'], at: 1 }],
  };
  const both = textItem('both tags body', { groups: ['todo', 'forge'], ts: 30 });
  const onlyTodo = textItem('only todo body', { groups: ['Todo'], ts: 29 });
  const workPrivate = textItem('work and a private tag', { groups: ['work', 'secretproj'], ts: 28 });
  const comma = textItem('comma tag body', { groups: ['a, b'], ts: 27 });
  const tagged = [both, onlyTodo, workPrivate, comma];

  // Sharing ignores case both ways: shared 'TODO' covers 'Todo', 'work' covers 'Work'.
  const set = core.sharedGroupSet(tagSettings);
  assert.strictEqual(set.has('todo') && set.has('Todo') && set.has('WORK'), true, 'share list is case-insensitive');
  assert.strictEqual(core.isShared(onlyTodo, set), true);
  assert.strictEqual(core.buildContext(tagged, tagSettings).groups.find(g => g.name === 'todo').count, 2, 'context counts ignore case');

  // namedTags: commas split, a retired name means its parts, an existing name is whole.
  assert.deepStrictEqual(core.namedTags('todo, Forge', tagSettings), ['todo', 'forge'], 'each in its stored spelling, the app rule');
  assert.deepStrictEqual(core.namedTags('todo/forge', tagSettings), ['todo', 'forge']);
  assert.deepStrictEqual(core.namedTags('A, B', tagSettings), ['a, b'], 'a tag whose name holds a comma, named in full');

  // list_clips group: every named tag required, any case.
  const ids = res => res.clips.map(c => c.id);
  assert.deepStrictEqual(ids(core.listClips(tagged, tagSettings, { group: 'TODO, forge' })), [model.itemKey(both)], 'AND of the named tags');
  assert.deepStrictEqual(ids(core.listClips(tagged, tagSettings, { group: 'todo/forge' })), [model.itemKey(both)], 'a retired name = its parts');
  assert.deepStrictEqual(ids(core.listClips(tagged, tagSettings, { group: 'todo' })), [model.itemKey(both), model.itemKey(onlyTodo)]);
  assert.deepStrictEqual(ids(core.listClips(tagged, tagSettings, { group: 'WORK' })), [model.itemKey(workPrivate)]);
  assert.deepStrictEqual(ids(core.listClips(tagged, tagSettings, { group: 'a, b' })), [model.itemKey(comma)]);
  // A private tag name finds nothing, not even its shared clips (no membership probe).
  assert.strictEqual(core.listClips(tagged, tagSettings, { group: 'secretproj', includeNonShared: true }).clips.length, 0);

  // Search docs carry only the SHARED tag names: a private tag on a shared clip
  // is neither a group: filter nor a free word before an all-scope approval.
  assert.strictEqual(core.searchClips(tagged, tagSettings, { query: 'group:secretproj' }).matches.length, 0, 'private tag name hidden from group:');
  assert.strictEqual(core.searchClips(tagged, tagSettings, { query: 'secretproj' }).matches.length, 0, 'private tag name hidden from free text');
  assert.strictEqual(core.searchClips(tagged, tagSettings, { query: 'group:secretproj', scope: 'all' }).matches.length, 1, 'approved all-scope sees it');
  const view = core.searchClips(tagged, tagSettings, { query: 'group:work' }).matches[0];
  assert.deepStrictEqual(view.groups, ['work'], 'the view names shared tags only');
  assert.strictEqual(core.searchClips(tagged, tagSettings, { query: 'group:WORK' }).matches.length, 1, 'group: ignores case');

  // A retired nested name is searched as its parts, and the result says so.
  const retired = core.searchClips(tagged, tagSettings, { query: 'group:todo/forge' });
  assert.strictEqual(retired.rewrittenQuery, 'group:todo group:forge');
  assert.deepStrictEqual(retired.matches.map(m => m.id), [model.itemKey(both)]);
  const negated = core.searchClips(tagged, tagSettings, { query: 'body -g:Todo/Forge' });
  assert.strictEqual(negated.rewrittenQuery, 'body -(g:todo g:forge)');
  assert.deepStrictEqual(negated.matches.map(m => m.id), [model.itemKey(onlyTodo), model.itemKey(comma)], 'negated = not both');
  assert.strictEqual('rewrittenQuery' in core.searchClips(tagged, tagSettings, { query: 'group:todo' }), false, 'unchanged query, no rewrite');

  // The rewrite itself: quoting, OR sides, regex and quoted terms untouched.
  const splits = model.splitMapOf(tagSettings);
  const flat = q => Search.flattenRetiredGroupTokens(q, splits).query;
  assert.strictEqual(flat('group:todo/forge OR is:image'), '(group:todo group:forge) OR is:image');
  assert.strictEqual(flat('group:"todo/forge" x'), 'group:todo group:forge x');
  assert.strictEqual(flat('"group:todo/forge"'), '"group:todo/forge"', 'a quoted token is text');
  assert.strictEqual(flat('title:todo/forge /group:todo\\/forge/'), 'title:todo/forge /group:todo\\/forge/');
  assert.deepStrictEqual(Search.flattenRetiredGroupTokens('group:todo/forge', new Map()), { query: 'group:todo/forge', rewritten: false });
}

// ===========================================================================
// The boundary keeps private things private (review findings, 14 Oct 2026).
// ===========================================================================
const crypto = require('crypto');
const sha256 = text => crypto.createHash('sha256').update(String(text), 'utf8').digest('hex');
const secretSettings = (extra = {}) => ({
  mcp_secret: 'a'.repeat(64),
  groups: ['AI', 'work', 'divorce', 'medical', 'private'],
  groups_shared_with_ai: ['work'],
  ...extra,
});

// privacy #4: a shared clip's rev must not let an AI recover its private group names.
{
  const s = secretSettings();
  const clip = textItem('lawyer call notes', { groups: ['AI', 'divorce', 'medical'], ts: 40 });
  const view = core.clipView(clip, { settings: s });
  assert.deepStrictEqual(view.groups, ['AI'], 'private names withheld');
  // The old attack: every other rev input is in the view, so enumerate group sets.
  const words = ['divorce', 'medical', 'health', 'money', 'kids', 'tax', 'work', 'secret', 'legal', 'bank'];
  const recovered = [];
  for (let mask = 0; mask < (1 << words.length); mask++) {
    const groups = ['AI', ...words.filter((_, i) => mask & (1 << i))];
    const guess = { ...clip, pin: { groups } };
    if (model.clipRevision(guess) === view.rev) recovered.push(groups);
  }
  assert.deepStrictEqual(recovered, [], 'no candidate set reproduces the public rev');
  assert.strictEqual(model.clipRevision({ ...clip, pin: { groups: ['AI', 'divorce', 'medical'] } }), model.clipRevision(clip), '(the raw rev would have matched)');
  // Still a change detector: a private group change moves it, nothing else does.
  const retagged = { ...clip, pin: { groups: ['AI', 'divorce'] } };
  assert.notStrictEqual(core.publicRev(retagged, s), view.rev, 'a private group change moves the rev');
  assert.strictEqual(core.publicRev({ ...clip }, { ...s }), view.rev, 'the helper and the app (same secret) agree');
  assert.notStrictEqual(core.publicRev(clip, { ...s, mcp_secret: 'b'.repeat(64) }), view.rev, 'keyed by the install secret');
}

// privacy #6: a private clip's id is an opaque handle, not its content hash.
{
  const s = secretSettings();
  const pin = textItem('bank PIN 482913', { groups: ['private'], number: 3, ts: 50 });
  const shared = textItem('shared work note', { groups: ['work'], ts: 49 });
  const items = [pin, shared];
  const listed = core.listClips(items, s, { includeNonShared: true }).clips;
  const meta = listed.find(c => !c.shared);
  assert.ok(core.isOpaqueId(meta.id) && meta.id.startsWith(core.OPAQUE_ID_PREFIX), 'opaque handle');
  assert.notStrictEqual(meta.id, `txt:${sha256('bank PIN 482913')}`);
  // The old attack: enumerate the six-digit suffix against the id.
  let hit = null;
  for (let n = 482900; n <= 482999 && !hit; n++) {
    const guess = `bank PIN ${n}`;
    if (`txt:${sha256(guess)}` === meta.id || core.publicId(textItem(guess, { groups: ['private'] }), {}) === meta.id) hit = guess;
  }
  assert.strictEqual(hit, null, 'no guessed text reproduces the handle without the secret');
  assert.strictEqual(listed.find(c => c.shared).id, model.itemKey(shared), 'a shared clip keeps its real id');
  assert.strictEqual(core.buildContext(items, s).numpadSlots[3].id, meta.id, 'list_context numpad slots use the handle too');
  // Every tool resolves the handle back; the real id of a private clip names nothing.
  assert.strictEqual(core.resolvePublicId(items, s, meta.id).item, pin);
  assert.strictEqual(core.resolvePublicId(items, s, model.itemKey(pin)).item, null);
  assert.strictEqual(core.resolvePublicId(items, s, model.itemKey(shared)).item, shared);
  assert.strictEqual(core.resolvePublicId(items, { ...s, mcp_secret: 'c'.repeat(64) }, meta.id).item, null, 'a handle from another install names nothing');
  // A held handle survives the clip becoming shared.
  const nowShared = { ...pin, pin: { ...pin.pin, groups: ['private', 'work'] } };
  assert.strictEqual(core.resolvePublicId([nowShared, shared], s, meta.id).item, nowShared);
  // Edited away: the handle (or a shared clip's real id) says where the clip went.
  const edited = textItem('bank PIN 999999', { groups: ['private'], ts: 51 });
  const sup = { ...s, supersedes: [{ from: model.itemKey(pin), to: model.itemKey(edited), updatedAt: Date.now() }] };
  const moved = core.resolvePublicId([edited, shared], sup, meta.id);
  assert.strictEqual(moved.item, null);
  assert.strictEqual(moved.movedTo, core.publicId(edited, sup), 'movedTo is the new clip\'s handle');
  assert.strictEqual(core.resolvePublicId([edited, shared], sup, model.itemKey(pin)).movedTo, null, 'a guessed real id of a private clip learns nothing');
  const sharedEdit = textItem('shared work note v2', { groups: ['work'], ts: 52 });
  const sup2 = { ...s, supersedes: [{ from: model.itemKey(shared), to: model.itemKey(sharedEdit), updatedAt: Date.now() }] };
  assert.strictEqual(core.resolvePublicId([sharedEdit], sup2, model.itemKey(shared)).movedTo, model.itemKey(sharedEdit));
  // Without a secret (AI access never enabled) ids are still keyed; withBoundaryKey
  // hands a worker thread the same key.
  const noKey = { groups: ['private'] };
  assert.ok(core.isOpaqueId(core.publicId(pin, noKey)));
  const filled = core.withBoundaryKey(noKey);
  assert.ok(filled.mcp_secret && filled !== noKey && !noKey.mcp_secret);
  assert.strictEqual(core.publicId(pin, filled), core.publicId(pin, noKey));
  assert.strictEqual(core.withBoundaryKey(s), s, 'a settings object with a secret is used as is');
}

// privacy #5: a free search never reads private text, not even as a count.
{
  const s = secretSettings();
  const phrase = textItem('My recovery phrase: tiger lamp ocean', { groups: ['private'], ts: 60 });
  const shared = textItem('a shared clip', { groups: ['work'], ts: 59 });
  const items = [phrase, shared];
  const handle = core.publicId(phrase, s);
  const probe = q => core.searchClips(items, s, { query: q });
  const yes = probe(`id:${handle} /^my/`);
  const no = probe(`id:${handle} /^zz/`);
  assert.deepStrictEqual(yes, no, 'a true and a false guess answer the same');
  assert.deepStrictEqual(probe('tiger'), probe('nothingmatches'), 'private text is not searched');
  assert.strictEqual(yes.nonSharedTotal, 1);
  assert.strictEqual(core.searchClips(items, s, { query: 'tiger', scope: 'all' }).matches[0].id, handle, 'the approved search finds it, by its handle');
  assert.strictEqual(core.searchClips(items, s, { query: `id:${handle}`, scope: 'all' }).matches.length, 1, 'id: takes the handle');
}

// privacy #10: rewrittenQuery never confirms a private retired nested name.
{
  const s = secretSettings({
    groups: ['AI', 'work', 'health', 'therapy', 'todo', 'forge'],
    groups_shared_with_ai: ['work', 'todo', 'forge'],
    group_splits: [
      { name: 'health/therapy', parts: ['health', 'therapy'], at: 1 },
      { name: 'todo/forge', parts: ['todo', 'forge'], at: 1 },
      { name: 'work/health', parts: ['work', 'health'], at: 1 },
    ],
  });
  const items = [textItem('a shared clip', { groups: ['work'], ts: 70 })];
  const strip = r => ({ ...r, rewrittenQuery: undefined });
  const known = core.searchClips(items, s, { query: 'group:health/therapy' });
  const unknown = core.searchClips(items, s, { query: 'group:health/dentist' });
  assert.strictEqual('rewrittenQuery' in known, false, 'a private retired name is not rewritten');
  assert.deepStrictEqual(known, unknown, 'it answers exactly like an unknown name');
  assert.strictEqual('rewrittenQuery' in core.searchClips(items, s, { query: 'group:work/health' }), false, 'one private part is enough to hide it');
  assert.strictEqual(core.searchClips(items, s, { query: 'group:todo/forge' }).rewrittenQuery, 'group:todo group:forge', 'shared parts are rewritten');
  assert.deepStrictEqual(strip(core.searchClips(items, s, { query: 'group:health/therapy', scope: 'all' })), strip(core.searchClips(items, s, { query: 'group:health/dentist', scope: 'all' })));
}

// privacy #3 / completeness #13: what the group tools may say back.
{
  const withPrivate = secretSettings({ groups: ['AI', 'work', 'medical', 'Salary'] });
  const without = secretSettings({ groups: ['AI', 'work'] });
  // The answer: shared groups as stored, every other name only as typed, and the SAME
  // answer whether that private group existed or not.
  const view = (input, settingsFor, lists) => core.groupToolView(core.namedGroupTokens(input, settingsFor), settingsFor, lists);
  const a = view('WORK, MEDICAL', withPrivate, { added: ['medical'], removed: [] });
  assert.deepStrictEqual(a, { added: [], removed: [], notShared: ['MEDICAL'] }, 'the private stored spelling never comes back');
  assert.deepStrictEqual(view('WORK, MEDICAL', without, { added: ['MEDICAL'], removed: [] }), a, 'existed or not: the same answer');
  assert.deepStrictEqual(view('work, todo', without, { added: ['work', 'todo'], removed: [] }), { added: ['work'], removed: [], notShared: ['todo'] });
  assert.deepStrictEqual(view('salary', withPrivate, { groups: ['Salary'] }), view('salary', without, { groups: ['salary'] }), 'create_group: the same answer either way');
  assert.deepStrictEqual(view('salary', withPrivate, { groups: ['Salary'] }), { groups: [], notShared: ['salary'] });
  // A retired nested name is echoed as typed unless all its parts are shared.
  const split = secretSettings({ groups: ['AI', 'work', 'health'], group_splits: [{ name: 'work/health', parts: ['work', 'health'], at: 1 }] });
  assert.deepStrictEqual(view('work/health', split, { added: ['work', 'health'] }), { added: ['work'], notShared: ['work/health'] });
  assert.deepStrictEqual(view('work/dentist', split, { added: ['work/dentist'] }), { added: [], notShared: ['work/dentist'] });
}

console.log('mcp-core tests passed');
