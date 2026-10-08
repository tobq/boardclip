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

// ── literal by default, /regex/ per term, OR, groups, NOT (search modes) ──
{
  const items = [
    textItem('abc123', { id: 'a', ts: 1 }),
    textItem('xyz', { id: 'b', ts: 2 }),
    textItem('a.c', { id: 'c', ts: 3 }),
    textItem('rm -rf build', { id: 'd', ts: 4 }),
    textItem('line one\nline two', { id: 'e', ts: 5 }),
  ];
  const ids = (q) => idsOf(items, S.parseQuery(q)).sort();
  assert.deepStrictEqual(ids('/\\d+/'), ['txt:a'], 'a /regex/ term');
  assert.deepStrictEqual(ids('\\d+'), [], 'plain text is literal: no implicit regex');
  assert.deepStrictEqual(ids('a.c'), ['txt:c'], 'a dot is a dot');
  assert.deepStrictEqual(ids('/a.c/'), ['txt:a', 'txt:c']);
  assert.deepStrictEqual(ids('/one.line/'), [], '. never crosses a line break');
  assert.deepStrictEqual(ids('/[a-z/'), [], 'a broken regex matches nothing');
  assert.deepStrictEqual(ids('abc OR xyz'), ['txt:a', 'txt:b'], 'OR');
  assert.deepStrictEqual(ids('abc or xyz'), [], 'a lower-case or is a word');
  assert.deepStrictEqual(ids('line abc OR one'), ['txt:e'], 'OR binds tighter: line AND (abc OR one)');
  assert.deepStrictEqual(ids('(abc OR xyz) -/\\d/'), ['txt:b'], 'groups and a negated regex');
  assert.deepStrictEqual(ids('-(abc OR xyz)'), ['txt:c', 'txt:d', 'txt:e'], 'a negated group');
  assert.deepStrictEqual(ids('"-rf"'), ['txt:d'], 'a quoted token is literal');
  assert.deepStrictEqual(ids('-rf'), ['txt:a', 'txt:b', 'txt:c', 'txt:e'], 'an unquoted -word excludes');
  assert.deepStrictEqual(ids('"rm -rf"'), ['txt:d']);
  assert.deepStrictEqual(ids('((abc)) OR (xyz'), ['txt:a', 'txt:b'], 'nesting; an unclosed group closes at the end');
  // The parse keeps what pills and chips need.
  let p = S.parseQuery('group:Work OR group:Ideas pasta');
  assert.deepStrictEqual(p.anyOf.map((g) => [g.dim, g.values]), [['group', ['Work', 'Ideas']]]);
  assert.deepStrictEqual(p.groups, [], 'an OR pill is not an AND group');
  assert.deepStrictEqual(p.content.map((c) => c.value), ['pasta']);
  p = S.parseQuery('group:A OR is:image');
  assert.strictEqual(p.compound.length, 1, 'an OR across filters is a custom expression');
  assert.ok(S.anyFilterActive(p));
  assert.strictEqual(S.parseQuery('a OR b').compound.length, 1);
  assert.deepStrictEqual(S.parseQuery('a OR b').terms.map((t) => t.value), ['a', 'b'], 'terms inside an OR still highlight and rank');
  assert.deepStrictEqual(S.parseQuery('-(a OR b)').terms, [], 'terms under a NOT do not');
  assert.deepStrictEqual(S.parseQuery('/usr/bin').content.map((c) => [c.value, !!c.regex]), [['/usr/bin', false]], 'a path is text');
  assert.deepStrictEqual(S.parseQuery('title:/a b/').content.map((c) => [c.scope, c.value, !!c.regex]), [['title', 'a b', true]], 'a scoped regex with a space');
  assert.deepStrictEqual(S.parseQuery('f(x) y').content.map((c) => c.value), ['f(x)', 'y'], 'brackets inside a word stay in it');
  assert.deepStrictEqual(S.parseQuery('(f(x) b)').content.map((c) => c.value), ['f(x)', 'b']);
  // Repeated keys: AND, except an OR pill.
  const nums = [textItem('one', { id: 'n1', pin: { number: 1 } }), textItem('two', { id: 'n2', pin: { number: 2 } })];
  assert.deepStrictEqual(idsOf(nums, S.parseQuery('num:1 num:2')), [], 'two keys together: nothing (a clip has one key)');
  assert.deepStrictEqual(idsOf(nums, S.parseQuery('num:1 OR num:2')).sort(), ['txt:n1', 'txt:n2']);
  // A negated single-valued filter is ignored and flagged with its inverse.
  assert.strictEqual(S.parseQuery('-since:7d').since, null);
  const neg = S.validateQuery('-since:7d');
  assert.strictEqual(neg[0].kind, 'negated-filter');
  assert.strictEqual(neg[0].didYouMean, 'before:7d');
  assert.deepStrictEqual(neg[0].fix, { start: 0, end: 9, text: 'before:7d' });
  assert.strictEqual(S.validateQuery('-len:>5')[0].didYouMean, 'len:<=5');
  assert.strictEqual(S.validateQuery('num:1 num:2')[0].kind, 'num-and');
  assert.deepStrictEqual(S.validateQuery('num:1 num:2')[0].fix, { start: 6, end: 6, text: 'OR ' });
  assert.deepStrictEqual(S.validateQuery('num:1 OR num:2'), []);
  // Structure problems: pending while the caret ends them.
  assert.strictEqual(S.validateQuery('a OR')[0].kind, 'dangling-or');
  assert.ok(S.validateQuery('a OR', { caret: 4 })[0].pending);
  assert.strictEqual(S.validateQuery('(a b')[0].kind, 'unclosed');
  assert.ok(S.validateQuery('(a b', { caret: 4 })[0].pending);
  assert.strictEqual(S.validateQuery('/[a/')[0].kind, 'invalid-regex');
  assert.deepStrictEqual(S.validateQuery('[a'), [], 'a bracket in plain text is fine');
}

// ── ONE compile primitive (search, highlight, the editor's find) ──
{
  const lit = S.compileTerm('a.b');
  assert.ok(lit.test('xA.Bx') && !lit.test('axb'));
  assert.deepStrictEqual(lit.all('a.b A.B'), [{ start: 0, end: 3 }, { start: 4, end: 7 }]);
  const cs = S.compileTerm('Ab', { caseSensitive: true });
  assert.deepStrictEqual(cs.all('ab Ab AB'), [{ start: 3, end: 5 }]);
  const re = S.compileTerm('a.', { regex: true });
  assert.deepStrictEqual(re.all('a\nab'), [{ start: 2, end: 4 }], '. does not cross a line break');
  assert.deepStrictEqual(S.compileTerm('x*', { regex: true }).all('abc'), [], 'empty matches are skipped');
  const bad = S.compileTerm('(', { regex: true });
  assert.ok(!bad.valid && bad.error && !bad.test('('));
  // Every term of a query highlights (the old row highlight matched the whole query as one string).
  assert.deepStrictEqual(S.termSpans(S.parseQuery('foo bar'), 'hello foo and bar', 'body'), [{ start: 6, end: 9 }, { start: 14, end: 17 }]);
  assert.deepStrictEqual(S.termSpans(S.parseQuery('/\\d+/ is:text'), 'a 12 b', 'body'), [{ start: 2, end: 4 }]);
  assert.deepStrictEqual(S.termSpans(S.parseQuery('-foo bar'), 'foo bar', 'body'), [{ start: 4, end: 7 }], 'an excluded word is not highlighted');
  assert.deepStrictEqual(S.termSpans(S.parseQuery('title:x y'), 'x y', 'body'), [{ start: 2, end: 3 }], 'a title term does not mark the body');
  assert.strictEqual(S.firstMatchIndex(S.parseQuery('zz OR bb'), 'aa bb cc zz'), 3);
}

// ── the Regex toggle types /regex/ terms (the text stays the one query) ──
{
  const type = (text, caret, typed) => S.regexTypingEdit(text, caret, typed);
  assert.deepStrictEqual(type('', 0, 'c'), { text: '/c/', caret: 2 }, 'a fresh spot starts a /regex/, caret inside');
  assert.strictEqual(type('/c/', 2, 'o'), null, 'inside one: typed as usual');
  assert.deepStrictEqual(type('/co/', 2, '/'), { text: '/c\\/o/', caret: 4 }, 'a / inside is escaped');
  assert.deepStrictEqual(type('/co/', 3, '/'), { text: '/co/', caret: 4 }, 'a / at the closing slash steps over it');
  assert.strictEqual(type('/a\\/', 3, '/'), null, 'after a backslash a / is the user\'s own escape');
  assert.deepStrictEqual(type('/co/', 4, 'x'), { text: '/co/ /x/', caret: 7 }, 'right after one: a new term');
  assert.deepStrictEqual(type('foo ', 4, 'x'), { text: 'foo /x/', caret: 6 }, 'after a space: a new term');
  assert.strictEqual(type('foo', 3, 'x'), null, 'inside a plain word: typed as usual');
  assert.deepStrictEqual(type('title:', 6, 'x'), { text: 'title:/x/', caret: 8 }, 'after title: a scoped term');
  assert.strictEqual(type('group:', 6, 'x'), null, 'a filter value stays a value');
  assert.deepStrictEqual(type('-', 1, 'x'), { text: '-/x/', caret: 3 }, 'after a lone minus: an excluded term');
  assert.deepStrictEqual(type('(', 1, 'x'), { text: '(/x/', caret: 3 });
  assert.strictEqual(type('"ab', 3, 'x'), null, 'inside quotes: typed as usual');
  assert.strictEqual(type('', 0, ' '), null);
  assert.deepStrictEqual(type('', 0, '/'), { text: '//', caret: 1 }, 'a typed / opens an empty pair');
  assert.deepStrictEqual(type('', 0, 'a/b c'), { text: '/a\\/b c/', caret: 7 }, 'a paste is one term');
  assert.deepStrictEqual(S.regexBackspaceEdit('a //', 3), { text: 'a ', caret: 2 }, 'an emptied // goes as a pair');
  assert.strictEqual(S.regexBackspaceEdit('a/b', 2), null);
  assert.ok(S.parseQuery(type('', 0, 'c').text).content[0].regex, 'what it writes parses as a regex');
  // The toggle wraps / unwraps the word at the caret (as typed: now read as a pattern).
  assert.deepStrictEqual(S.toggleRegexAt('foo colou?r', 8, true), { text: 'foo /colou?r/', caret: 12 });
  assert.deepStrictEqual(S.toggleRegexAt('title:x', 3, true), { text: 'title:/x/', caret: 8 });
  assert.deepStrictEqual(S.toggleRegexAt('-"a b"', 2, true), { text: '-/a b/', caret: 5 });
  assert.strictEqual(S.toggleRegexAt('group:x', 3, true), null, 'a filter is not words');
  assert.deepStrictEqual(S.toggleRegexAt('foo /a b/', 6, false), { text: 'foo "a b"', caret: 9 }, 'off: back to text, quoted where needed');
  assert.deepStrictEqual(S.toggleRegexAt('/a\\/b/', 2, false), { text: 'a/b', caret: 3 });
  assert.strictEqual(S.toggleRegexAt('foo ', 4, true), null, 'no word at the caret');
  // The old regex flag (AI tools): the plain words as ONE regex.
  assert.strictEqual(S.legacyRegexQuery('\\d+ foo group:A'), '/\\d+ foo/ group:A');
  assert.strictEqual(S.legacyRegexQuery('group:A'), 'group:A');
  // The language still types with Regex on: '-', '(', ')' and a quote are its
  // own at a fresh spot, and a ':' ending a filter key turns the term back into it.
  for (const ch of ['-', '(', ')', '"']) assert.strictEqual(type('a ', 2, ch), null, `'${ch}' at a fresh spot is typed as usual`);
  assert.deepStrictEqual(type('a (', 3, 'x'), { text: 'a (/x/', caret: 5 });
  assert.strictEqual(type('"', 1, 'a'), null, 'a phrase is typed as usual');
  assert.deepStrictEqual(type('/group/', 6, ':'), { text: 'group:', caret: 6 }, 'a filter key unwraps');
  assert.deepStrictEqual(type('x -/is/', 6, ':'), { text: 'x -is:', caret: 6 });
  assert.strictEqual(type('group:', 6, 'w'), null, 'its value is typed as usual');
  assert.deepStrictEqual(type('/title/', 6, ':'), { text: 'title:', caret: 6 });
  assert.deepStrictEqual(type('title:', 6, 'x'), { text: 'title:/x/', caret: 8 }, 'a title: value is still a /regex/');
  assert.strictEqual(type('/foo/', 4, ':'), null, 'a word that is not a filter key keeps its colon in the pattern');
  assert.strictEqual(type('/gro/', 2, ':'), null, 'only at the end of the pattern');
  // An open quote is the scanner's: a quote inside a /regex/ never counts.
  assert.ok(!S.insideQuote('/a"b/ x', 7) && S.insideQuote('foo "ab c', 9) && !S.insideQuote('"ab" c', 6));
  assert.deepStrictEqual(type('/a"b/ ', 6, 'x'), { text: '/a"b/ /x/', caret: 8 });
  // Off in an empty // pair takes the pair away.
  assert.deepStrictEqual(S.toggleRegexAt('a //', 3, false), { text: 'a ', caret: 2 });
  // ONE escape-aware slash rule: an escaped \/ stays, a trailing lone backslash of
  // complete text is doubled, a single typed backslash waits for its next key.
  assert.deepStrictEqual(S.toggleRegexAt('a\\/b', 1, true), { text: '/a\\/b/', caret: 5 });
  assert.deepStrictEqual(S.toggleRegexAt('a\\', 1, true), { text: '/a\\\\/', caret: 4 });
  assert.deepStrictEqual(type('', 0, '\\'), { text: '/\\/', caret: 2 });
  assert.strictEqual(type('/\\/', 2, 'd'), null, 'then \\d completes it');
  assert.strictEqual(type('/ab/', 2, 'x\\/y'), null, 'a pasted \\/ is already escaped');
  assert.deepStrictEqual(type('/ab/', 3, 'c\\'), { text: '/abc\\\\/', caret: 6 }, 'a paste ending in a backslash cannot escape the closing slash');
}

// ── the or / and of an OR dimension (the chip row's leading toggle, the panel's Type row) ──
{
  assert.strictEqual(S.dimConnective(S.parseQuery('group:A'), 'group'), null, 'one value: nothing to join');
  assert.strictEqual(S.dimConnective(S.parseQuery('group:A OR group:B'), 'group'), 'or');
  assert.strictEqual(S.dimConnective(S.parseQuery('group:A x group:B'), 'group'), 'and');
  assert.strictEqual(S.dimConnective(S.parseQuery('-group:A group:B'), 'group'), null, 'an exclusion is not joined');
  assert.strictEqual(S.setDimConnective('x group:A OR group:B', 'group', 'and'), 'x group:A group:B');
  assert.strictEqual(S.setDimConnective('group:A x group:B', 'group', 'or'), 'group:A OR group:B x');
  assert.strictEqual(S.setDimConnective('is:text OR is:url', 'type', 'and'), 'is:text is:url');
  assert.strictEqual(S.setDimConnective('group:A', 'group', 'and'), 'group:A');
}

// ── the remembered or / and, and one choice per group family ──
{
  const g = (v) => ({ kind: 'group', value: v });
  const and = { joins: { group: 'and', type: 'and' } };
  assert.strictEqual(S.applyFacet('group:A', g('B'), 'include'), 'group:A OR group:B', 'default: either');
  assert.strictEqual(S.applyFacet('group:A', g('B'), 'include', and), 'group:A group:B', 'a remembered and joins the second value');
  assert.strictEqual(S.applyFacet('group:A OR group:B', g('C'), 'include', and), 'group:A OR group:B OR group:C', 'a written OR keeps its join');
  assert.strictEqual(S.applyFacet('is:text', { kind: 'is', value: 'url' }, 'include', and), 'is:text is:url');
  assert.strictEqual(S.applyFacet('num:1', { kind: 'num', value: 2 }, 'include', { joins: { num: 'and' } }), 'num:1 OR num:2', 'numpad keys are never remembered as and (a clip has one key)');
  assert.deepStrictEqual(S.normalizeJoins({ group: 'and', type: 'or', num: 'and', x: 'and' }), { group: 'and' });
  assert.deepStrictEqual(S.normalizeJoins(null), {});
  // A parent absorbs its selected sub-groups; a sub-group drills down from its parent.
  assert.strictEqual(S.applyFacet('x group:Work/Clients', g('Work'), 'include'), 'x group:Work');
  assert.strictEqual(S.applyFacet('group:Work', g('Work/Clients'), 'include'), 'group:Work/Clients');
  assert.strictEqual(S.applyFacet('group:Ideas OR group:Work/Clients', g('Work'), 'include'), 'group:Ideas OR group:Work', 'an OR keeps its join');
  assert.strictEqual(S.applyFacet('group:Ideas group:Work/Clients', g('Work'), 'include'), 'group:Ideas group:Work', 'an AND keeps its join');
  assert.strictEqual(S.applyFacet('group:Work/Clients', g('Work'), 'exclude'), '-group:Work', 'excluding a parent drops its selected sub-groups');
  assert.strictEqual(S.applyFacet('group:Work', g('Work/Clients'), 'exclude'), 'group:Work -group:Work/Clients', 'Work except Clients');
  assert.strictEqual(S.applyFacet('-group:Work/Clients', g('Work'), 'include'), 'group:Work -group:Work/Clients');
  assert.strictEqual(S.applyFacet('group:Workshop', g('Work'), 'include'), 'group:Work OR group:Workshop', 'a name prefix is not a family');
  // The census greys by the remembered join: with A selected, B counts A and B.
  const docs = [['A'], ['B'], ['A', 'B']].map((groups, i) => S.clipToDoc({ id: `t${i}`, type: 'text', text: `c${i}`, ts: 1, pin: { groups } }));
  const p = S.parseQuery('group:A');
  assert.strictEqual(S.facetCensus(docs, p, { groups: ['A', 'B'] }).count('group:B'), 2, 'or: what B adds');
  assert.strictEqual(S.facetCensus(docs, p, { groups: ['A', 'B'], joins: { group: 'and' } }).count('group:B'), 1, 'and: what A and B share');
}

// ── autocomplete + highlight of the one language ──
{
  assert.ok(S.suggestQuery('(gro', 4, {}).suggestions.some((s) => s.text === 'group:'));
  assert.strictEqual(S.suggestQuery('(gro', 4, {}).replaceStart, 1);
  assert.ok(S.suggestQuery('foo o', 5, {}).suggestions.some((s) => s.text === 'OR'));
  assert.ok(!S.suggestQuery('o', 1, {}).suggestions.some((s) => s.text === 'OR'), 'no OR before any term');
  assert.ok(S.suggestQuery('len:', 4, {}).suggestions.some((s) => s.text === 'len:>100'), 'size presets');
  assert.ok(S.suggestQuery('len:>', 5, {}).suggestions.every((s) => s.text.startsWith('len:>')));
  const lx = S.lexQuery('-(a OR /b./) title:/c/');
  assert.strictEqual(lx.map((s) => s.text).join(''), '-(a OR /b./) title:/c/');
  assert.ok(lx.some((s) => s.kind === 'op' && s.text === 'OR') && lx.some((s) => s.kind === 'op' && s.text === '('));
  assert.ok(lx.some((s) => s.kind === 'regex' && s.text === '.'));
  assert.ok(!S.lexQuery('a.c').some((s) => s.kind === 'regex'), 'plain text never paints regex metacharacters');
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
  const q = 'foo title:hi -is:image "a b" /\\d+/';
  const segs = S.lexQuery(q);
  assert.strictEqual(segs.map((s) => s.text).join(''), q);
  assert.ok(segs.some((s) => s.kind === 'prefix' && s.text === 'title:'));
  assert.ok(segs.some((s) => s.kind === 'neg' && s.text === '-'));
  assert.ok(segs.some((s) => s.kind === 'prefix' && s.text === 'is:'));
  assert.ok(segs.some((s) => s.kind === 'regex')); // the /\d+/ term's metachars
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
      if (opt.prompt) { assert.ok(S.RECOGNIZED_PREFIXES.has(opt.token.kind) && S.FIELD_EXAMPLE[opt.token.kind], `${opt.label}: ${opt.token.kind} is a recognised prefix with an example`); continue; }
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
  // Kinds join with OR by default: a picked kind never blocks another (either can match);
  // under a remembered "and" the pair that can never meet is structural.
  const andVerdict = (q, token) => S.facetOptionVerdict(S.facetCensus(docs, S.parseQuery(q), { now: NOW, groups: [], joins: { type: 'and' } }), S.parseQuery(q), token);
  assert.notStrictEqual(verdict('is:multiline', { kind: 'is', value: 'url' }).kind, 'structural', 'or: a multi-line clip or a link');
  assert.notStrictEqual(verdict('is:text', { kind: 'builtin', value: '__images__' }).kind, 'structural', 'or: text or an image');
  assert.strictEqual(andVerdict('is:multiline', { kind: 'is', value: 'url' }).kind, 'structural', 'and: a link is one line');
  assert.strictEqual(andVerdict('is:url', { kind: 'is', value: 'multiline' }).kind, 'structural');
  assert.strictEqual(andVerdict('is:text', { kind: 'builtin', value: '__images__' }).kind, 'structural', 'and: an image has no text');
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
  assert.strictEqual(viaAB, 'titel:foo "a b" group:alpha OR group:Zed', 'a second group ORs in, in name order');
  assert.strictEqual(S.applyFacet('group:A group:C', { kind: 'group', value: 'B' }, 'include'), 'group:A group:B group:C', 'two groups side by side (the pill\'s "and") take a third the same way');
  assert.strictEqual(S.applyFacet('group:A OR group:C', { kind: 'group', value: 'B' }, 'include'), 'group:A OR group:B OR group:C');
  assert.strictEqual(S.applyFacet('group:A OR group:B', { kind: 'group', value: 'A' }, 'include'), 'group:B', 'a click takes a value out of its OR');
  assert.strictEqual(S.applyFacet('group:A OR group:B x', { kind: 'group', value: 'A' }, 'exclude'), 'group:B x -group:A', 'right-click moves it to an exclusion');
  assert.strictEqual(S.applyFacet('is:image', { kind: 'builtin', value: '__pinned__' }, 'include'), 'is:pinned is:image', 'pinned is its own question: AND');
  assert.strictEqual(S.applyFacet('is:image', { kind: 'is', value: 'text' }, 'include'), 'is:image OR is:text', 'kinds of clip OR');
  assert.strictEqual(S.applyFacet('(group:A OR x) y', { kind: 'group', value: 'A' }, 'include'), '(group:A OR x) y group:A', 'a custom expression is left alone');
  assert.strictEqual(S.stripFacet('group:A OR group:B -group:A x', { kind: 'group', value: 'A' }), 'group:B x');
  assert.strictEqual(S.applyFacet('is:url foo', { kind: 'builtin', value: '__pinned__' }, 'include'), 'is:pinned is:url foo', 'a new token goes in at its canonical place; nothing typed moves');
  assert.strictEqual(S.applyFacet('foo since:1d bar since:7d', { kind: 'since', value: '30d' }, 'include'), 'foo bar since:30d', 'a single-valued facet replaces every token of its kind');
  assert.strictEqual(S.applyFacet('a   b is:url ', { kind: 'is', value: 'url' }, 'include'), 'a   b ', 'removing a token keeps the words as typed and a trailing space');

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
  // A broken regex: a /regex/ term, pending while the caret ends its token.
  assert.deepStrictEqual(val('ab('), [], 'plain text: never a regex');
  p = val('/(ab/');
  assert.strictEqual(p[0].kind, 'invalid-regex');
  assert.ok(/regular expression/.test(p[0].message));
  assert.ok(val('/(ab/', { caret: 5 })[0].pending, 'still being typed at the caret: pending');
  assert.ok(!val('/(ab/ x', { caret: 7 })[0].pending, 'a finished token is flagged at once');
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

// ── group usage: clips weighted by how recently they were used (one decay,
//    shared with the ranking's recency); orders chips, pickers, autocomplete
//    and nudges Best match ──
{
  const DAY = 86400;
  const now = 1800000000 * 1000;
  const nowS = now / 1000;
  const clip = (id, ago, groups, text) => ({ id, type: 'text', text: text || 'x', ts: nowS - ago * DAY, pin: groups ? { groups } : null });
  const clips = [clip('a', 1, ['Fresh']), clip('b', 60, ['Old']), clip('c', 61, ['Old']), clip('d', 2, ['Work/Docs'])];
  const w = S.groupWeights(clips, now);
  assert.ok(w.get('Fresh') > w.get('Old'), 'one fresh clip outweighs two from two months ago');
  assert.strictEqual(w.get('Work'), w.get('Work/Docs'), 'a parent counts its sub-groups');
  assert.strictEqual(w.max, w.get('Fresh'));
  assert.deepStrictEqual(['Old', 'Fresh', 'Empty', 'Work'].sort(S.compareGroupUse(w)), ['Fresh', 'Work', 'Old', 'Empty'], 'by use, then by name');
  assert.strictEqual(S.groupWeights(clips, now), w, 'kept per list and hour');
  assert.ok(Math.abs(S.decayWeight(3 * DAY * 1000, 3 * DAY * 1000) - Math.exp(-1)) < 1e-12);
  // Best match: the same words, the clip of a group you use first.
  const items = [clip('plain', 1, null, 'invoice'), clip('used', 1, ['Fresh'], 'invoice'), clip('fresh2', 0.5, ['Fresh'], 'other')];
  assert.deepStrictEqual(S.filterRankIndexes(items, S.parseQuery('invoice'), { now }).map((i) => items[i].id), ['used', 'plain']);
  // The group autocomplete: prefix first, then use.
  const sug = S.suggestQuery('group:', 6, { groups: ['Old', 'Fresh', 'Empty'], groupWeights: w });
  assert.deepStrictEqual(sug.suggestions.map((x) => x.text), ['group:Fresh', 'group:Old', 'group:Empty']);
}
console.log('clip-search.test.js: group usage passed');
