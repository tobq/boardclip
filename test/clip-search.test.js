'use strict';
// Unit tests for the shared search engine (site/shared/clip-search.js).
const assert = require('assert');
const S = require('../site/shared/clip-search');
const fs = require('fs');
const path = require('path');

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
  // A value row keeps the key as typed (g:work, not group:work), so it continues
  // the typed token: ghost + unique auto-fill work on short aliases too.
  r = S.suggestQuery('g:wo', 4, { groups });
  assert.ok(r && r.suggestions.some((s) => s.text === 'g:work' && s.continuation), 'g: completes group values');
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

// Per-keystroke speed (2026-10-07: 430-840 ms per keystroke on a 70 MB history).
// The fast paths must give the SAME answers as the slow ones: a precomputed
// lowercase haystack is never lowercased again, body positions come from it,
// and lines/words/url are computed lazily, once per doc.
{
  const ui = require('../site/shared/clipboard-ui-core');
  const items = [
    { id: 'txt:1', type: 'text', title: 'Forge Plan', text: 'Ship the LAUNCH notes\nline two\nline three', ts: 100 },
    { id: 'txt:2', type: 'text', title: '', text: 'nothing about it', ts: 90 },
    { id: 'txt:3', type: 'text', title: 'launch', text: 'body mentions forge once', ts: 80 },
    { id: 'txt:4', type: 'text', text: 'https://boardclip.app/download', ts: 70 },
    { id: 'img:a.png', type: 'image', image: 'a.png', title: 'launch shot', ts: 60 },
  ];
  const hay = items.map((it) => ui.itemSearchText(it).toLowerCase());
  const docs = items.map(S.clipToDoc);
  const ids = (q, withHay) => S.filterRankIndexes(items, S.parseQuery(q), withHay ? { docs, searchTextLower: hay } : {}).map((i) => items[i].id);
  for (const q of ['launch', 'forge', 'text:launch', 'body:forge', 'title:launch', '-launch', 'LAUNCH NOTES', 'lines:>2', 'words:<4', 'is:url', 'is:multiline', 'forge launch']) {
    assert.deepStrictEqual(ids(q, true), ids(q, false), `fast path == slow path for "${q}"`);
  }
  assert.deepStrictEqual(ids('body:launch', true), ['txt:1'], 'body: scope reads the body region of the haystack, not the title');
  assert.deepStrictEqual(ids('lines:>2', true), ['txt:1'], 'lines computed lazily');
  assert.deepStrictEqual(ids('is:url', true), ['txt:4'], 'is:url computed lazily');
  assert.strictEqual(S.clipToDoc(items[0]).lines, undefined, 'clipToDoc no longer splits every body up front');
  // Matchers are compiled once per query; an already-lowercase haystack is used as is.
  const m = S.matchDoc(docs[0], S.parseQuery('launch'), { searchText: 'forge plan ship the launch notes', matchers: undefined });
  assert.strictEqual(m, true);
  const app = fs.readFileSync(path.join(__dirname, '../index.html'), 'utf8');
  assert.ok(/filterItemIndexes\(items, \{[^}]*docs: searchDocs/.test(app), 'the popup passes its cached search docs (built per history revision, not per keystroke)');
  assert.ok(/function searchIndexFor\(item\)[\s\S]{0,400}searchIndexCache\.get\(item\)[\s\S]{0,400}Core\.search\.clipToDoc\(item\)/.test(app),
    'search docs + haystacks are cached per clip object (only new/changed clips are indexed on a refresh)');
  assert.ok(/function rebuildItemIndexes\(\)[\s\S]{0,1500}searchDocs\.push\(entry\.doc\)/.test(app), 'rebuildItemIndexes reads the per-clip cache');
}

// Search options panel facets: single-valued tokens (since/before/len/lines/words)
// replace and toggle through the SAME applyFacet the chip bar uses; their state
// reads back through facetTokenState; the panel's toggle lights from optionFacetsActive.
{
  let q = S.applyFacet('invoice', { kind: 'since', value: '24h' }, 'include');
  assert.strictEqual(q, 'invoice since:24h', 'a date chip adds its token');
  q = S.applyFacet(q, { kind: 'since', value: '7d' }, 'include');
  assert.strictEqual(q, 'invoice since:7d', 'another date chip REPLACES the single-valued token');
  assert.strictEqual(S.applyFacet(q, { kind: 'since', value: '7D' }, 'include'), 'invoice', 'the same chip again clears it (case-insensitive)');
  q = S.applyFacet('x', { kind: 'len', value: '>500' }, 'include');
  assert.strictEqual(q, 'x len:>500');
  assert.strictEqual(S.applyFacet(q, { kind: 'len', value: '<80' }, 'include'), 'x len:<80', 'a size chip replaces the len bound');
  assert.strictEqual(S.applyFacet(q, { kind: 'len', value: '>500' }, 'include'), 'x', 'the same bound again clears it');
  assert.strictEqual(S.applyFacet('x', { kind: 'lines', value: '>10' }, 'exclude'), 'x lines:>10', 'single-valued facets have no exclude: they just toggle');
  // is: facets keep include/exclude (right-click), like the chip bar.
  q = S.applyFacet('x', { kind: 'is', value: 'url' }, 'exclude');
  assert.strictEqual(q, 'x -is:url');
  const p = S.parseQuery('note since:7d len:>500 -is:url group:Work before:2026-01-31');
  assert.strictEqual(S.facetTokenState(p, { kind: 'since', value: '7d' }), 'include');
  assert.strictEqual(S.facetTokenState(p, { kind: 'since', value: '24h' }), null);
  assert.strictEqual(S.facetTokenState(p, { kind: 'before' }), 'include', 'a valueless probe asks whether the facet is set at all');
  assert.strictEqual(S.facetTokenState(p, { kind: 'len', value: '>500' }), 'include');
  assert.strictEqual(S.facetTokenState(p, { kind: 'is', value: 'url' }), 'exclude');
  assert.strictEqual(S.facetTokenState(p, { kind: 'builtin', value: '__images__' }), null);
  assert.strictEqual(S.facetTokenState(p, { kind: 'group', value: 'Work' }), 'include', 'group state reads like the chip bar');
  assert.ok(S.optionFacetsActive(p), 'a panel-owned filter lights the options toggle');
  assert.ok(!S.optionFacetsActive(S.parseQuery('note group:Work num:2 is:pinned')), 'chip-bar-only filters do not light it');
  assert.ok(!S.optionFacetsActive(S.parseQuery('is:image')), 'the chip bar\'s Images filter does not light it either');
  for (const opt of S.OPTION_FACETS.flatMap((row) => row.options)) {
    assert.ok(!(opt.token.kind === 'is' && S.IS_TO_BUILTIN[opt.token.value]), `${opt.label}: is:${opt.token.value} belongs to the chip bar, not the options panel`);
  }
  assert.ok(S.optionFacetsActive(S.parseQuery('before:7d')) && S.optionFacetsActive(S.parseQuery('lines:>3')));
  // Every option is a real grammar token: its text parses back to the same state.
  for (const row of S.OPTION_FACETS) {
    for (const opt of row.options) {
      if (opt.prompt) { assert.ok(S.RECOGNIZED_PREFIXES.has(opt.prompt.replace(':', '')), `${opt.label}: ${opt.prompt} is a recognised prefix`); continue; }
      const text = S.facetTokenText(opt.token);
      assert.strictEqual(S.facetTokenState(S.parseQuery(text), opt.token), 'include', `${opt.label}: "${text}" parses back to its own chip`);
      assert.strictEqual(S.applyFacet('', opt.token, 'include'), text, `${opt.label}: the chip writes "${text}"`);
    }
  }
}

// ── Search behaviour from Forge (phase 4): census, verdict, validation,
//    suggest rules, relaxation, paste quoting, canonical chip order,
//    incremental refinement ──
{
  const NOW = Date.UTC(2026, 9, 8, 12, 0, 0);
  const sec = (msAgo) => Math.floor((NOW - msAgo) / 1000);
  const H = 3600000;
  const D = 24 * H;
  const items = [
    textItem('a short note', { id: 'n1', ts: sec(2 * H), pin: { groups: ['Work'] } }),
    textItem('line one\nline two\nline three', { id: 'n2', ts: sec(3 * D), pin: { groups: ['Work/Docs'] } }),
    textItem('https://example.com/x', { id: 'n3', ts: sec(10 * D) }),
    textItem('x'.repeat(600), { id: 'n4', ts: sec(40 * D), pin: { number: 3 } }),
    imageItem('pic', { ts: sec(1 * H) }),
  ];
  const docs = items.map(S.clipToDoc);
  const census = (q, groups) => S.facetCensus(docs, S.parseQuery(q), { now: NOW, groups: groups || ['Work', 'Work/Docs', 'Empty'] });
  const verdict = (q, token, groups) => S.facetOptionVerdict(census(q, groups), S.parseQuery(q), token);

  // Census: counts under the OTHER filters, one pass. No filters = history totals.
  let c = census('');
  assert.strictEqual(c.count('is:image'), 1);
  assert.strictEqual(c.count('is:text'), 4);
  assert.strictEqual(c.count('is:url'), 1);
  assert.strictEqual(c.count('is:multiline'), 1);
  assert.strictEqual(c.count('is:pinned'), 3);
  assert.strictEqual(c.count('group:Work'), 2, 'a parent group counts its sub-groups');
  assert.strictEqual(c.count('group:Work/Docs'), 1);
  assert.strictEqual(c.count('since:24h'), 2);
  assert.strictEqual(c.count('since:7d'), 3);
  assert.strictEqual(c.count('len:>500'), 1);
  assert.ok(c.present('is:url') && !c.present('is:rich'), 'present = exists anywhere in history');
  // A single-valued facet holds its own dim open: with since:24h active, the
  // 7d and 30d presets still count what THEY would show.
  c = census('since:24h');
  assert.strictEqual(c.count('since:7d'), 3, 'own dim (since) left open');
  assert.strictEqual(c.count('since:30d'), 4);
  assert.strictEqual(c.count('is:url'), 0, 'an AND facet counts under every other filter');
  assert.strictEqual(c.count('group:Work'), 1);
  // Free text is not part of the census.
  assert.strictEqual(census('whatever words since:24h').count('since:7d'), 3);
  // FAILURE_CAP: a doc failing two filters counts for neither.
  c = census('since:24h group:Work/Docs');
  assert.strictEqual(c.count('since:7d'), 1, 'n2 fails only since');
  assert.strictEqual(S.FAILURE_CAP, 2);
  // Empty history = permissive: nothing greys.
  const empty = S.facetCensus([], S.parseQuery('is:image'), { now: NOW });
  assert.ok(empty.permissive);
  assert.ok(S.facetOptionVerdict(empty, S.parseQuery('is:image'), { kind: 'is', value: 'url' }).enabled);

  // Verdicts: transient (nothing now), structural (never), hidden (absent kind),
  // the current selection never greyed, counts carried.
  let v = verdict('since:24h', { kind: 'is', value: 'url' });
  assert.deepStrictEqual([v.enabled, v.kind, v.reason], [false, 'transient', 'No matches with the current filters']);
  v = verdict('is:image', { kind: 'len', value: '>500' });
  assert.deepStrictEqual([v.enabled, v.kind], [false, 'structural'], 'an image has no length');
  assert.ok(/is:image/.test(v.reason), 'the structural reason names the blocking filter');
  assert.strictEqual(verdict('lines:>3', { kind: 'builtin', value: '__images__' }).kind, 'structural', 'is:image with lines:>3 can never match');
  assert.strictEqual(verdict('is:multiline', { kind: 'is', value: 'url' }).kind, 'structural', 'a link is one line');
  assert.strictEqual(verdict('is:url', { kind: 'is', value: 'multiline' }).kind, 'structural');
  assert.strictEqual(verdict('-is:pinned', { kind: 'builtin', value: '__numbered__' }).kind, 'structural', 'a numpad clip is pinned');
  assert.ok(verdict('is:image', { kind: 'len', value: '<80' }).enabled, 'len:<80 still fits an image (length 0)');
  v = verdict('', { kind: 'is', value: 'rich' });
  assert.ok(v.hidden, 'a kind absent from all history is hidden');
  v = verdict('is:rich', { kind: 'is', value: 'rich' });
  assert.ok(v.enabled && !v.hidden, 'a selected option stays visible (and enabled) so it can be cleared');
  v = verdict('since:24h is:url', { kind: 'is', value: 'url' });
  assert.ok(v.enabled, 'the current selection is never greyed, even with nothing behind it');
  v = verdict('', { kind: 'group', value: 'Empty' });
  assert.deepStrictEqual([v.enabled, v.hidden, v.count], [true, undefined, 0], 'with no other filter a group with no clips stays live (its click shows the empty-group state)');
  v = verdict('is:text', { kind: 'group', value: 'Empty' });
  assert.deepStrictEqual([v.enabled, v.hidden, v.reason], [false, undefined, 'No clips in this group yet'], 'under other filters a group with no clips is greyed, not hidden');
  assert.strictEqual(verdict('since:7d', { kind: 'group', value: 'Work' }).count, 2);

  // Incremental refinement: same result as a full pass, fewer clips tested.
  const cache = {};
  const full = (q) => S.filterRankIndexes(items, S.parseQuery(q), { docs, now: NOW });
  const step = (q) => S.filterRankIndexes(items, S.parseQuery(q), { docs, now: NOW, cache });
  for (const q of ['l', 'li', 'lin', 'line t', 'line tw', 'line two', 'line', 'line -x', 'line -xy', 'is:text no', 'is:text not']) {
    assert.deepStrictEqual(step(q), full(q), `refined "${q}" equals a full pass`);
  }
  step('li'); step('lin');
  assert.ok(cache.refined, 'typing more of a term refines the last result');
  step('li');
  assert.ok(!cache.refined, 'deleting a character widens: full pass');
  step('line -x'); step('line -xy');
  assert.ok(!cache.refined, 'a negative term that grows widens: full pass');
  step('before:1d li'); step('before:1d lin');
  assert.ok(!cache.refined, 'before: never refines (its relative bound widens with time)');

  // facetKey: the filters alone, canonical.
  assert.strictEqual(S.facetKey(S.parseQuery('foo is:image bar group:B group:a')), S.facetKey(S.parseQuery('group:a is:image group:B')));
  assert.strictEqual(S.facetKey(S.parseQuery('just words')), '');

  // Canonical chip order: chips toggled in any order write the same text, and
  // the typed words (unknown prefixes and quotes too) stay exactly as typed.
  const viaAB = S.applyFacet(S.applyFacet('titel:foo "a b"', { kind: 'group', value: 'Zed' }, 'include'), { kind: 'group', value: 'alpha' }, 'include');
  const viaBA = S.applyFacet(S.applyFacet('titel:foo "a b"', { kind: 'group', value: 'alpha' }, 'include'), { kind: 'group', value: 'Zed' }, 'include');
  assert.strictEqual(viaAB, viaBA);
  assert.strictEqual(viaAB, 'titel:foo "a b" group:alpha group:Zed');
  assert.strictEqual(S.applyFacet('is:url foo', { kind: 'builtin', value: '__pinned__' }, 'include'), 'is:pinned is:url foo', 'a new token goes in at its canonical place; nothing typed moves');
  assert.strictEqual(S.applyFacet('foo since:1d bar since:7d', { kind: 'since', value: '30d' }, 'include'), 'foo bar since:30d', 'a single-valued facet replaces every token of its kind');
  assert.strictEqual(S.applyFacet('a   b is:url ', { kind: 'is', value: 'url' }, 'include'), 'a b ', 'removing a token keeps the words and a trailing space');

  // Validation + did-you-mean; a valid prefix is never flagged mid-typing.
  const val = (q, o) => S.validateQuery(q, o || {});
  let p = val('titel:foo');
  assert.strictEqual(p.length, 1);
  assert.strictEqual(p[0].kind, 'unknown-key');
  assert.strictEqual(p[0].didYouMean, 'title:');
  assert.deepStrictEqual(S.problemRanges(p), [{ start: 0, end: 6 }], 'an unknown key flags the KEY only');
  assert.ok(/Did you mean title:\?/.test(S.describeProblem(p[0])));
  p = val('-is:imgae');
  assert.strictEqual(p[0].didYouMean, 'is:image');
  assert.deepStrictEqual(S.problemRanges(p), [{ start: 4, end: 9 }], 'a bad value flags the VALUE only');
  p = val('is:bogus');
  assert.ok(/Valid: pinned, image/.test(S.describeProblem(p[0])), 'no close match: the valid values are listed');
  for (const ok of ['is:pin', 'is:', 'since:7', 'since:2026-0', 'since:7d', 'len:>', 'len:5-', 'len:5..', 'len:>5', 'num:3', 'sort:be', 'group:wo', 'https://x.y', 'mailto:a@b', 'id:txt:9f', 'C:\\path']) {
    assert.deepStrictEqual(val(ok, { groups: ['Work'] }), [], `"${ok}" is valid (or a valid prefix)`);
  }
  for (const bad of ['is:pinx', 'num:12', 'num:0', 'since:7x', 'len:abc', 'sort:xyz', 'lines:>>3']) {
    assert.strictEqual(val(bad).length, 1, `"${bad}" is flagged`);
  }
  p = val('group:wrk', { groups: ['Work', 'Personal'] });
  assert.strictEqual(p[0].didYouMean, 'group:Work', 'a group typo suggests the nearest group');
  // Group names match exactly: a whole name in the wrong case is flagged with
  // the right one, the list keeps offering it, and a prefix in any case is fine.
  const caseGroups = ['Work', 'Work/Clients', 'Ideas'];
  p = val('group:work', { groups: caseGroups });
  assert.deepStrictEqual([p.length, p[0] && p[0].kind, p[0] && p[0].didYouMean], [1, 'invalid-value', 'group:Work'], 'group:work is flagged with group:Work');
  assert.deepStrictEqual(val('g:work/clients', { groups: caseGroups }).map((x) => x.didYouMean), ['g:Work/Clients'], 'a sub-group too, through the short alias');
  assert.deepStrictEqual(val('group:wor', { groups: caseGroups }), [], 'a prefix in any case is still being typed');
  assert.deepStrictEqual(val('group:Work', { groups: caseGroups }), []);
  assert.deepStrictEqual(val('group:Work', { groups: ['Work/Clients'] }), [], 'a parent path is a valid group');
  assert.deepStrictEqual(S.suggestQuery('group:work', 10, { groups: caseGroups }).suggestions.map((s) => s.text), ['group:Work', 'group:Work/Clients'], 'the wrong case is not complete: the list offers the right one');
  assert.strictEqual(S.filterRankIndexes([{ id: 'txt:w', type: 'text', text: 'x', ts: 1, pin: { groups: ['Work'] } }], S.parseQuery('group:work'), {}).length, 0, 'matching is exact, which is why the case is flagged');
  // Unknown keys: "did you mean" only for a likely filter whose value is valid
  // there, never a 1-2 letter alias, and never for a key the parser keeps as text.
  const dym = (q) => val(q).map((x) => x.didYouMean);
  assert.deepStrictEqual(dym('type:image'), ['is:'], 'a known guess');
  assert.deepStrictEqual(dym('size:>5'), ['len:'], 'size: means len:');
  assert.deepStrictEqual(dym('tag:x'), ['group:'], 'tag: means group:');
  assert.deepStrictEqual(val('tag:Nope', { groups: ['Work'] }).map((x) => x.didYouMean), [undefined], 'but not when group:Nope would itself be wrong');
  assert.deepStrictEqual(dym('wrods:<5'), ['words:']);
  assert.deepStrictEqual(dym('ids:txt'), ['id:']);
  for (const q of ['foo:bar', 'to:x', 'time:x', 'todo:x', 'fix:x', 'pin:x', 'in:x', 'ts:1', 'ref:x', 'type:bogus', 'size:big']) {
    assert.deepStrictEqual(dym(q), [undefined], `"${q}" gets no key suggestion`);
  }
  // A hyphenated key is plain text everywhere (parser, validator, highlight).
  for (const q of ['Content-Type:application/json', 'font-size:12px', 'foo-bar:baz']) {
    assert.deepStrictEqual(val(q), [], `"${q}" is valid (searched as typed)`);
    assert.deepStrictEqual(S.parseQuery(q).content.map((c) => c.value), [q]);
    assert.ok(S.lexQuery(q).every((s) => s.kind !== 'unknown' && s.kind !== 'prefix'), `"${q}" is not painted as a key`);
  }
  // Dates: only an ISO-like date or a 7d span; V8's Date.parse reads '>5' as 2001.
  for (const bad of ['since:>5', 'before:5-', 'since:May', 'since:2026/01/31']) {
    assert.strictEqual(val(bad).length, 1, `"${bad}" is flagged`);
  }
  assert.strictEqual(S.resolveTimeMs('>5'), null);
  assert.strictEqual(S.resolveTimeMs('7'), null, 'bare digits are not a date');
  assert.strictEqual(S.resolveTimeMs('2026-01-31'), Date.parse('2026-01-31'));
  assert.ok(S.resolveTimeMs('2026-01-31T10:30') != null && S.resolveTimeMs('2026-01') != null);
  assert.deepStrictEqual(val('since:2026-01-31 before:2026-02-01T09:00Z'), []);
  assert.strictEqual(S.filterRankIndexes([{ id: 'txt:o', type: 'text', text: 'old', ts: 1 }], S.parseQuery('since:7'), {}).length, 1, 'a pending since:7 filters nothing (not 2001)');
  // A broken regex: only in regex mode, pending while the caret ends its token.
  assert.deepStrictEqual(val('(ab'), [], 'not regex mode: plain text');
  p = val('(ab', { regex: true });
  assert.strictEqual(p[0].kind, 'invalid-regex');
  assert.ok(/regular expression/.test(p[0].message));
  assert.ok(val('(ab', { regex: true, caret: 3 })[0].pending, 'still being typed at the caret: pending');
  assert.ok(!val('(ab x', { regex: true, caret: 5 })[0].pending, 'a finished token is flagged at once');
  // The highlight paints exactly the invalid range.
  const segs = S.lexQuery('is:pinx foo');
  assert.deepStrictEqual(segs.filter((s) => s.kind === 'unknown').map((s) => s.text), ['pinx']);
  assert.ok(S.lexQuery('is:pin').every((s) => s.kind !== 'unknown'), 'a valid prefix is never painted');

  // Suggest rules: empty box / mid-token = nothing; complete value = nothing.
  assert.strictEqual(S.suggestQuery('', 0, {}), null);
  assert.strictEqual(S.suggestQuery('is:pinned', 9, {}), null, 'a complete value offers nothing more');
  assert.strictEqual(S.suggestQuery('since:7d', 8, {}), null);
  assert.strictEqual(S.suggestQuery('num:3', 5, {}), null);
  assert.strictEqual(S.suggestQuery('group:Work', 10, { groups: ['Work', 'Work/Docs'] }), null, 'an exact group is complete');
  assert.strictEqual(S.suggestQuery('is:pi foo', 4, {}), null, 'caret inside a token: nothing');
  assert.ok(S.suggestQuery('foo is:pi', 9, {}), 'caret at the end of a token: suggestions');
  const hints = S.suggestQuery('is:', 3, {}).suggestions.map((s) => s.hint);
  assert.strictEqual(new Set(hints).size, hints.length, 'every row has its own hint (no repeated hint)');
  // Ghost: the top row's rest, only with the caret at the very end.
  let r = S.suggestQuery('is:mu', 5, {});
  assert.strictEqual(S.ghostCompletion('is:mu', 5, r), 'ltiline');
  assert.strictEqual(S.ghostCompletion('is:mu x', 5, S.suggestQuery('is:mu x', 5, {})), '', 'no ghost mid-text');
  r = S.suggestQuery('ti', 2, {});
  assert.strictEqual(S.ghostCompletion('ti', 2, r), 'tle:', 'a key ghost');
  // A unique value auto-fills with the inserted part selected; never a key,
  // never a quoted fragment, never bare digits of a time.
  r = S.suggestQuery('is:mu', 5, {});
  assert.deepStrictEqual(S.uniqueCompletion('is:mu', r), { text: 'is:multiline', selectionStart: 5, selectionEnd: 12 });
  assert.strictEqual(S.uniqueCompletion('is:', S.suggestQuery('is:', 3, {})), null, 'an empty value shows choices');
  assert.strictEqual(S.uniqueCompletion('ti', S.suggestQuery('ti', 2, {})), null, 'a key never auto-fills');
  assert.strictEqual(S.uniqueCompletion('since:7', S.suggestQuery('since:7', 7, {})), null, '7 could still be 7h or 7w');
  r = S.suggestQuery('foo -g:wo', 9, { groups: ['Work'] });
  assert.strictEqual(S.uniqueCompletion('foo -g:wo', r).text, 'foo -g:Work');
  // Accepting: a key keeps the caret after ':'; a value ends with a space.
  r = S.suggestQuery('ti', 2, {});
  assert.deepStrictEqual(S.applySuggestion('ti', r, r.suggestions[0]), { text: 'title:', caret: 6 });
  r = S.suggestQuery('is:pi', 5, {});
  assert.deepStrictEqual(S.applySuggestion('is:pi', r, r.suggestions[0]), { text: 'is:pinned ', caret: 10 });

  // The empty-result nudge: the one facet that brings back the most clips.
  let rel = S.bestRelaxation(docs, 'since:24h is:url', { now: NOW });
  assert.deepStrictEqual([rel.label, rel.count, rel.time, rel.query], ['is:url', 2, false, 'since:24h'], 'dropping is:url brings back 2, since:24h only 1');
  rel = S.bestRelaxation(docs, 'since:24h is:multiline', { now: NOW });
  assert.deepStrictEqual([rel.label, rel.count, rel.time], ['is:multiline', 2, false]);
  rel = S.bestRelaxation(docs, 'since:24h is:text -group:Work', { now: NOW });
  assert.deepStrictEqual([rel.label, rel.count, rel.time, rel.query], ['since:24h', 2, true, 'is:text -group:Work'], 'a time filter is reported as one (outside this range)');
  rel = S.bestRelaxation(docs, 'example since:24h', { now: NOW });
  assert.strictEqual(rel.query, 'example', 'free text stays, the blocking facet goes');
  assert.strictEqual(rel.count, 1);
  rel = S.bestRelaxation(docs, 'nothingmatches since:24h', { now: NOW });
  assert.strictEqual(rel, null, 'free text still has to match: no nudge');
  assert.strictEqual(S.bestRelaxation(docs, 'just words', { now: NOW }), null, 'no filters, no nudge');
  rel = S.bestRelaxation(docs, 'group:Work/Docs is:url', { now: NOW });
  assert.ok(rel && rel.count === 1 && !rel.time);

  // The nudge's refine cache: typing more of the words equals a full pass.
  const relCache = {};
  for (const q of ['since:24h e', 'since:24h ex', 'since:24h exa', 'since:24h example', 'since:24h exam', 'since:24h example zz', 'is:url since:24h l']) {
    assert.deepStrictEqual(S.bestRelaxation(docs, q, { now: NOW, cache: relCache }), S.bestRelaxation(docs, q, { now: NOW }), `cached nudge for "${q}" equals a full pass`);
  }

  // Paste quoting.
  assert.strictEqual(S.quotePastedText('hello big world'), '"hello big world"');
  assert.strictEqual(S.quotePastedText('  hello big world\n'), '"hello big world"', 'outer whitespace is trimmed');
  for (const spaced of ['hello   big\nworld', 'a\tb', 'two  spaces', 'line one\r\nline two']) {
    assert.strictEqual(S.quotePastedText(spaced), null, `"${JSON.stringify(spaced)}" pastes raw: a phrase could not match across it`);
  }
  {
    // Pasting a multi-line clip's own text still finds that clip (the field
    // turns its line breaks into spaces; the words are AND-ed).
    const clip = { id: 'txt:ml', type: 'text', text: 'const a = 1;\nconst b = 2;', ts: NOW / 1000 };
    assert.strictEqual(S.quotePastedText(clip.text), null);
    assert.deepStrictEqual(S.filterRankIndexes([clip], S.parseQuery(clip.text.replace(/\r?\n/g, ' ')), { now: NOW }), [0]);
  }
  assert.strictEqual(S.quotePastedText('single'), null);
  assert.strictEqual(S.quotePastedText('is:image foo'), null, 'query syntax pastes raw');
  assert.strictEqual(S.quotePastedText('title:x y'), null);
  assert.strictEqual(S.quotePastedText('Error: something broke'), '"Error: something broke"', 'an unknown prefix is the misparse quoting fixes');
  assert.strictEqual(S.quotePastedText('say "hi" now'), '"say hi now"');
  assert.ok(S.insideQuote('foo "ba', 7) && !S.insideQuote('foo "ba" ', 9));

  // Hints come from ONE table.
  assert.strictEqual(S.PREFIX_HINTS['title:'], S.FIELD_INFO.title.desc);
  assert.ok(Object.keys(S.FIELD_INFO).every((k) => S.RECOGNIZED_PREFIXES.has(k)), 'every documented field is a real prefix');
}

console.log('clip-search.test.js: all assertions passed');
