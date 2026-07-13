'use strict';
// Unit tests for the shared search engine (site/shared/clip-search.js).
const assert = require('assert');
const S = require('../site/shared/clip-search');

function textItem(text, extra = {}) {
  return { type: 'text', text, ts: extra.ts || 1000, id: 'txt:' + (extra.id || text.slice(0, 8)), pin: extra.pin || null, title: extra.title };
}
function imageItem(name, extra = {}) {
  return { type: 'image', image: name + '.png', width: 10, height: 10, ts: extra.ts || 1000, id: 'img:' + name, pin: extra.pin || null, title: extra.title };
}
const idsOf = (items, parsed, opts) => S.filterRankIndexes(items, parsed, opts).map((i) => items[i].id);

// ── tokenizer + parse ──
{
  assert.deepStrictEqual(S.tokenizeQuery('foo "bar baz" qux'), ['foo', 'bar baz', 'qux']);
  const p = S.parseQuery('title:hello text:"multi word" group:work -is:image num:3 since:7d len:>100 id:txt: sort:new foo -bar');
  assert.deepStrictEqual(p.content.find((c) => c.scope === 'title'), { scope: 'title', value: 'hello', neg: false });
  assert.deepStrictEqual(p.content.find((c) => c.scope === 'body'), { scope: 'body', value: 'multi word', neg: false });
  assert.deepStrictEqual(p.groups, ['work']);
  assert.deepStrictEqual(p.negIs, ['image']);
  assert.deepStrictEqual(p.nums, [3]);
  assert.strictEqual(p.since, '7d');
  assert.deepStrictEqual(p.len, { op: '>', n: 100 });
  assert.strictEqual(p.id, 'txt:');
  assert.strictEqual(p.sort, 'new');
  assert.ok(p.content.some((c) => c.value === 'foo' && !c.neg));
  assert.ok(p.content.some((c) => c.value === 'bar' && c.neg));
}

// ── unknown prefix is stripped to free text + recorded ──
{
  const p = S.parseQuery('titel:foo');
  assert.ok(p.content.some((c) => c.value === 'foo'));
  assert.deepStrictEqual(p.unknown, ['titel']);
}

// ── short aliases fold to the same canonical facets as the long forms ──
{
  const long = S.parseQuery('title:hi text:body group:work num:3 since:7d before:1d len:>10 sort:new is:pinned');
  const short = S.parseQuery('t:hi b:body g:work n:3 s:7d bf:1d l:>10 o:new is:pinned');
  assert.deepStrictEqual(short.content, long.content, 't:/b: fold to title/body');
  assert.deepStrictEqual(short.groups, long.groups, 'g: folds to group');
  assert.deepStrictEqual(short.nums, long.nums, 'n: folds to num');
  assert.strictEqual(short.since, long.since, 's: folds to since');
  assert.strictEqual(short.before, long.before, 'bf: folds to before');
  assert.deepStrictEqual(short.len, long.len, 'l: folds to len');
  assert.strictEqual(short.sort, long.sort, 'o: folds to sort');
  assert.strictEqual(short.unknown.length, 0, 'no short alias is treated as unknown');
  // b: and body: are both the body scope
  assert.strictEqual(S.parseQuery('body:x').content[0].scope, 'body');
  assert.strictEqual(S.parseQuery('b:x').content[0].scope, 'body');
}

// ── URL / windows path left verbatim (not a filter) ──
{
  const p = S.parseQuery('https://example.com/x C:\\path\\file');
  assert.ok(p.content.some((c) => c.value === 'https://example.com/x'));
  assert.ok(p.content.some((c) => c.value === 'C:\\path\\file'));
  assert.strictEqual(p.unknown.length, 0);
}

// ── serialize round-trips deterministically ──
{
  const q = 'foo title:hi group:work -is:image num:2 since:7d len:>50 sort:best';
  const p1 = S.parseQuery(q);
  const s = S.serializeQuery(p1);
  const p2 = S.parseQuery(s);
  assert.deepStrictEqual(S.serializeQuery(p2), s); // stable
}

// ── applyFacet: chip <-> query token toggling ──
{
  assert.strictEqual(S.applyFacet('', { kind: 'group', value: 'work' }, 'include'), 'group:work');
  assert.strictEqual(S.applyFacet('group:work', { kind: 'group', value: 'work' }, 'include'), ''); // toggle off
  assert.strictEqual(S.applyFacet('', { kind: 'group', value: 'work' }, 'exclude'), '-group:work');
  assert.strictEqual(S.applyFacet('group:work', { kind: 'group', value: 'work' }, 'exclude'), '-group:work'); // include -> exclude
  assert.strictEqual(S.applyFacet('', { kind: 'builtin', value: '__pinned__' }, 'include'), 'is:pinned');
  assert.strictEqual(S.applyFacet('', { kind: 'builtin', value: '__images__' }, 'exclude'), '-is:image');
  // facetState reflects it for the chip bar
  const fs = S.facetState(S.parseQuery('group:work -group:old is:pinned -is:image'));
  assert.ok(fs.active.has('work') && fs.active.has('__pinned__'));
  assert.ok(fs.excluded.has('old') && fs.excluded.has('__images__'));
}

// ── strict AND filter over content + facets ──
{
  const items = [
    textItem('invoice for work project', { id: 'a', pin: { groups: ['work'] }, ts: 300 }),
    textItem('random note about api plan', { id: 'b', pin: { number: 2 }, ts: 200 }),
    textItem('another work item', { id: 'c', pin: { groups: ['work'] }, ts: 100 }),
    imageItem('shot1', { id: 'd', pin: { groups: ['work'] }, ts: 250 }),
  ];
  assert.deepStrictEqual(idsOf(items, S.parseQuery('is:numpad')), ['txt:b']);
  assert.deepStrictEqual(idsOf(items, S.parseQuery('group:work is:text')).sort(), ['txt:a', 'txt:c']);
  assert.deepStrictEqual(idsOf(items, S.parseQuery('group:work -is:image')).sort(), ['txt:a', 'txt:c']);
  assert.deepStrictEqual(idsOf(items, S.parseQuery('is:image')), ['img:shot1']);
  assert.deepStrictEqual(idsOf(items, S.parseQuery('num:2')), ['txt:b']);
  // free text AND
  assert.deepStrictEqual(idsOf(items, S.parseQuery('work invoice')), ['txt:a']);
  // negation excludes
  assert.deepStrictEqual(idsOf(items, S.parseQuery('group:work -invoice')).sort(), ['img:shot1', 'txt:c']);
}

// ── title: vs text: scoping ──
{
  const items = [
    textItem('body has apple', { id: 'a', title: 'Fruit note' }),
    textItem('body has banana', { id: 'b', title: 'Apple title' }),
  ];
  assert.deepStrictEqual(idsOf(items, S.parseQuery('title:apple')), ['txt:b']);
  assert.deepStrictEqual(idsOf(items, S.parseQuery('text:apple')), ['txt:a']);
}

// ── since / before / len ──
{
  const now = 10_000_000_000_000; // fixed "now" in ms
  const nowSec = now / 1000;
  const items = [
    textItem('recent', { id: 'a', ts: nowSec - 3600 }),      // 1h ago
    textItem('old', { id: 'b', ts: nowSec - 10 * 86400 }),   // 10d ago
    textItem('x'.repeat(500), { id: 'c', ts: nowSec - 3600 }),
  ];
  assert.deepStrictEqual(S.filterRankIndexes(items, S.parseQuery('since:24h'), { now }).map((i) => items[i].id).sort(), ['txt:a', 'txt:c']);
  assert.deepStrictEqual(S.filterRankIndexes(items, S.parseQuery('before:7d'), { now }).map((i) => items[i].id), ['txt:b']);
  assert.deepStrictEqual(idsOf(items, S.parseQuery('len:>100')), ['txt:c']);
}

// ── ranking: relevance when searching, recency when idle ──
{
  const items = [
    textItem('the invoice is here', { id: 'old', ts: 100 }),                 // body substring, old
    textItem('unrelated', { id: 'mid', ts: 200, title: 'Weekly Invoice' }),  // title hit, newer
    textItem('nothing', { id: 'new', ts: 300 }),
  ];
  // empty query -> caller's original order preserved (the app passes history/recency order)
  assert.deepStrictEqual(idsOf(items, S.parseQuery('')), ['txt:old', 'txt:mid', 'txt:new']);
  // sort:new over a facet-only query re-sorts by recency
  assert.deepStrictEqual(idsOf(items, S.parseQuery('is:text sort:new')), ['txt:new', 'txt:mid', 'txt:old']);
  // query 'invoice' -> title hit (mid) should outrank body hit (old) despite recency
  const ranked = idsOf(items, S.parseQuery('invoice'));
  assert.deepStrictEqual(ranked.slice().sort(), ['txt:mid', 'txt:old']);
  assert.strictEqual(ranked[0], 'txt:mid');
  // sort:new override -> recency among matches
  assert.deepStrictEqual(idsOf(items, S.parseQuery('invoice sort:new')), ['txt:mid', 'txt:old']);
}

// ── regex flag ──
{
  const items = [textItem('abc123', { id: 'a' }), textItem('xyz', { id: 'b' })];
  assert.deepStrictEqual(idsOf(items, S.parseQuery('\\d+'), { regex: true }), ['txt:a']);
  assert.deepStrictEqual(idsOf(items, S.parseQuery('\\d+'), { regex: false }), []); // literal
}

// ── fuzzy matcher (IntelliJ camel-hump) ──
{
  const fm = S.fuzzyMatch('sdi', 'Sync Data-loss Incident');
  assert.ok(fm && fm.score > 0);
  assert.strictEqual(S.fuzzyMatch('idebar', 'Sidebar'), null); // interior, not a boundary
  assert.ok(S.fuzzyMatch('search', 'Search') !== null);
}

// ── fuzzy IDF ranking (AI no-key) with relevance floor ──
{
  const items = [
    textItem('how to fix the sync data-loss incident in clipboard', { id: 'a' }),
    textItem('the quick brown fox the the the', { id: 'b' }),  // only common words
    textItem('clipboard sync bug', { id: 'c' }),
  ];
  const idf = S.buildIdf(items.map(S.clipToDoc));
  const ranked = S.rankFuzzyIndexes(items, 'sync data loss', { idf }).map((i) => items[i].id);
  assert.ok(ranked[0] === 'txt:a');
  assert.ok(!ranked.includes('txt:b')); // common-word-only doc doesn't clear the floor
}

// ── lexQuery: segments concatenate back to the exact input ──
{
  const q = 'foo title:hi -is:image "a b" \\d+';
  const segs = S.lexQuery(q, { regex: true });
  assert.strictEqual(segs.map((s) => s.text).join(''), q);
  assert.ok(segs.some((s) => s.kind === 'prefix' && s.text === 'title:'));
  assert.ok(segs.some((s) => s.kind === 'neg' && s.text === '-'));
  assert.ok(segs.some((s) => s.kind === 'prefix' && s.text === 'is:'));
  assert.ok(segs.some((s) => s.kind === 'regex')); // \d+ metachars under regex mode
  // unknown prefix colored distinctly
  assert.ok(S.lexQuery('titel:foo').some((s) => s.kind === 'unknown' && s.text === 'titel:'));
  // URL left as plain value (not a prefix)
  assert.ok(!S.lexQuery('https://x.com/a').some((s) => s.kind === 'prefix'));
}

// ── suggestQuery ──
{
  const groups = ['work', 'work/api', 'personal'];
  let r = S.suggestQuery('gro', 3, { groups });
  assert.ok(r && r.suggestions.some((s) => s.text === 'group:'));
  r = S.suggestQuery('group:wo', 8, { groups });
  assert.ok(r && r.suggestions.some((s) => s.text === 'group:work'));
  r = S.suggestQuery('is:', 3, { groups });
  assert.ok(r && r.suggestions.some((s) => s.text === 'is:pinned'));
  r = S.suggestQuery('since:', 6, {});
  assert.ok(r && r.suggestions.some((s) => s.text === 'since:7d'));
  r = S.suggestQuery('-group:wo', 9, { groups });
  assert.ok(r && r.suggestions.every((s) => s.text.startsWith('-group:')));
  assert.strictEqual(S.suggestQuery('', 0, { groups }), null);
  // Short aliases autocomplete: typing g:/t: resolves like the long form, and a
  // bare short letter offers the canonical prefix.
  r = S.suggestQuery('g:wo', 4, { groups });
  assert.ok(r && r.suggestions.some((s) => s.text === 'group:work'), 'g: completes group values');
  r = S.suggestQuery('t', 1, { groups });
  assert.ok(r && r.suggestions.some((s) => s.text === 'title:'), 't offers title:');
  r = S.suggestQuery('g', 1, { groups });
  assert.ok(r && r.suggestions.some((s) => s.text === 'group:'), 'g offers group:');
}

// ── lexQuery colors short-alias prefixes too ──
{
  assert.ok(S.lexQuery('t:hi').some((s) => s.kind === 'prefix' && s.text === 't:'), 't: is a recognized prefix');
  assert.ok(S.lexQuery('g:work').some((s) => s.kind === 'prefix' && s.text === 'g:'), 'g: is a recognized prefix');
}

console.log('clip-search.test.js: all assertions passed');
