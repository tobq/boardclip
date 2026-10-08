'use strict';

const assert = require('assert');
const ui = require('../site/shared/clipboard-ui-core');

// findAllMatches: returns every {start,end} span (drives the editor find bar).
{
  assert.deepStrictEqual(ui.findAllMatches('', 'x'), [], 'empty text -> no matches');
  assert.deepStrictEqual(ui.findAllMatches('abc', ''), [], 'empty query -> no matches');

  const m = ui.findAllMatches('the cat sat on the mat', 'at');
  assert.deepStrictEqual(m, [
    { start: 5, end: 7 },   // cAT
    { start: 9, end: 11 },  // sAT
    { start: 20, end: 22 }, // mAT
  ], 'finds every occurrence');

  // case-insensitive
  assert.strictEqual(ui.findAllMatches('Foo foo FOO', 'foo').length, 3);

  // literal by default: regex metachars are escaped (not interpreted)
  assert.deepStrictEqual(ui.findAllMatches('a.b a-b', '.'), [{ start: 1, end: 2 }], 'dot is literal by default');

  // regex mode when opted in
  assert.strictEqual(ui.findAllMatches('a1 b2 c3', '[0-9]', { regex: true }).length, 3, 'regex mode honoured');

  // zero-width patterns can't loop forever
  assert.deepStrictEqual(ui.findAllMatches('abc', 'x*', { regex: true }), [], 'empty matches are skipped, no infinite loop');

  // invalid regex degrades to no matches
  assert.deepStrictEqual(ui.findAllMatches('abc', '(', { regex: true }), [], 'invalid regex -> []');

  // match case (the find bar's Aa), literal and regex
  assert.deepStrictEqual(ui.findAllMatches('Foo foo FOO', 'foo', { caseSensitive: true }), [{ start: 4, end: 7 }]);
  assert.strictEqual(ui.findAllMatches('Ab ab', '[A-Z]b', { regex: true, caseSensitive: true }).length, 1);
  // . never crosses a line break
  assert.deepStrictEqual(ui.findAllMatches('a\nb', 'a.b', { regex: true }), []);
}

// editorFindFor: what a search hands the find bar (its words and patterns,
// never its filters).
{
  assert.deepStrictEqual(ui.editorFindFor(''), {});
  assert.deepStrictEqual(ui.editorFindFor('group:work is:text'), {}, 'filters are not text in the clip');
  assert.deepStrictEqual(ui.editorFindFor('invoice group:work'), { find: 'invoice', findMode: 'basic' });
  assert.deepStrictEqual(ui.editorFindFor('"a b" group:work'), { find: 'a b', findMode: 'basic' });
  assert.deepStrictEqual(ui.editorFindFor('/inv(oice)?/'), { find: 'inv(oice)?', findMode: 'regex' });
  assert.deepStrictEqual(ui.editorFindFor('foo a.b'), { find: 'foo|a\\.b', findMode: 'regex' }, 'several terms: one alternation, every term found');
  assert.deepStrictEqual(ui.editorFindFor('foo -bar title:x'), { find: 'foo', findMode: 'basic' }, 'excluded and title-only terms are left out');
}

// countWords: footer word count.
{
  assert.strictEqual(ui.countWords(''), 0);
  assert.strictEqual(ui.countWords('   '), 0);
  assert.strictEqual(ui.countWords('hello'), 1);
  assert.strictEqual(ui.countWords('  hello   world  '), 2);
  assert.strictEqual(ui.countWords('a\nb\tc  d'), 4, 'splits on any whitespace');
}

// Editor find jump: browsers can select a textarea range without scrolling it,
// so Core.createEditor uses this pure line-based fallback to force the match
// into view while keeping focus in the find input.
{
  const text = Array.from({ length: 120 }, (_, i) => `line ${i + 1}`).join('\n');
  const idx = text.indexOf('line 90');
  assert.strictEqual(ui.lineNumberAtIndex(text, idx), 89);
  assert.strictEqual(ui.editorScrollTopForIndex(text, idx, 20, 100, 10), 1755);
  assert.strictEqual(ui.editorScrollTopForIndex(text, 0, 20, 100, 10), 0);
}

console.log('editor find tests passed');
