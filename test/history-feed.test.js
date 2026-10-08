'use strict';
// lib/history-feed.js + Core.applyHistoryDelta: the popup receives only what
// changed since the snapshot it holds, and applying that delta reproduces main's
// history exactly (order included). A renderer that is out of step (fresh,
// reloaded, missed a reply) always gets a full snapshot instead.
const assert = require('assert');
const { createHistoryFeed, rendererStamp } = require('../lib/history-feed');
const Core = require('../site/shared/clipboard-ui-core');

const clone = (list) => JSON.parse(JSON.stringify(list));
const feed = createHistoryFeed();
let history = [
  { id: 'a', type: 'text', text: 'alpha', ts: 3, rev: 'r1' },
  { id: 'b', type: 'text', text: 'beta', ts: 2, rev: 'r2', pin: { groups: ['work'] } },
  { id: 'c', type: 'image', image: 'c.png', ts: 1, rev: 'r3', width: 10, height: 10 },
];

// 1) First request: a full snapshot.
let renderer = [];
let rev = -1;
let reply = feed.stateFor('popup', rev, 1, clone(history));
assert.ok(!reply.delta && reply.items.length === 3, 'a fresh renderer gets everything');
renderer = Core.applyHistoryDelta(renderer, reply);
rev = reply.revision;

// 2) Nothing changed: unchanged, no payload.
assert.deepStrictEqual(feed.stateFor('popup', rev, 1, clone(history)), { revision: 1, unchanged: true });

// 3) A capture (new clip on top) + a pin change + a deletion: only the new and
//    the changed clip travel; order and removal come from the id order.
const keptObject = renderer.find((it) => it.id === 'c');
history = [
  { id: 'n', type: 'text', text: 'new clip', ts: 9, rev: 'r9' },
  { id: 'a', type: 'text', text: 'alpha', ts: 3, rev: 'r1b', pin: {} },
  { id: 'c', type: 'image', image: 'c.png', ts: 1, rev: 'r3', width: 10, height: 10 },
];
reply = feed.stateFor('popup', rev, 2, clone(history));
assert.strictEqual(reply.delta, true);
assert.deepStrictEqual(reply.items.map((it) => it.id), ['n', 'a'], 'only new/changed clips are sent');
assert.deepStrictEqual(reply.order, ['n', 'a', 'c']);
renderer = Core.applyHistoryDelta(renderer, reply);
rev = reply.revision;
assert.deepStrictEqual(renderer, history, 'the renderer now holds exactly main\'s history');
assert.strictEqual(renderer[2], keptObject, 'unchanged clips keep their object (per-clip caches stay valid)');

// 4) A re-copy only bumps ts (moves to the top): that counts as a change.
history = [{ ...history[2], ts: 20 }, history[0], history[1]];
reply = feed.stateFor('popup', rev, 3, clone(history));
assert.deepStrictEqual(reply.items.map((it) => it.id), ['c']);
renderer = Core.applyHistoryDelta(renderer, reply);
rev = reply.revision;
assert.deepStrictEqual(renderer, history);

// 5) Out of step (the renderer reports a revision the feed did not send it last):
//    full snapshot, never a delta onto unknown state.
reply = feed.stateFor('popup', 1, 4, clone(history));
assert.ok(!reply.delta && reply.items.length === 3, 'mismatched revision -> full snapshot');
// ...and each renderer is tracked on its own.
assert.ok(!feed.stateFor('other-window', -1, 4, clone(history)).delta);

// 6) The stamp ignores blob bodies but sees everything shown.
const base = { id: 'x', type: 'text', text: 'body', ts: 1, rev: 'r' };
assert.strictEqual(rendererStamp(base), rendererStamp({ ...base, text: 'body' }));
assert.notStrictEqual(rendererStamp(base), rendererStamp({ ...base, title: 'named' }));
assert.notStrictEqual(rendererStamp(base), rendererStamp({ ...base, html: '<b>body</b>' }));

// 7) Previews never flatten the whole text; the window sits on the match.
{
  const huge = `${'lorem ipsum\n'.repeat(200000)}NEEDLE here\n${'tail\n'.repeat(1000)}`;
  const t = Date.now();
  const preview = Core.collapsedPreviewText(huge, 'needle');
  assert.ok(preview.includes('NEEDLE here') && !preview.includes('\n'), 'centred on the match, one line');
  assert.ok(preview.length < 800, 'bounded window');
  const known = Core.collapsedPreviewText(huge, 'needle', { matchIndex: huge.indexOf('NEEDLE') });
  assert.strictEqual(known, preview, 'a known match index gives the same window');
  assert.ok(Date.now() - t < 500, 'no whole-text pass');
}

console.log('history-feed tests passed');
