'use strict';

const assert = require('assert');
const { planEditArchivePrune } = require('../lib/edit-archive');

const NOW = 1_000_000_000_000;
const DAY = 86400 * 1000;
const names = (entries) => entries.map((e) => e.name);

// nothing to do when under cap and within age
{
  const entries = [
    { name: 'a', mtimeMs: NOW - DAY, size: 10 },
    { name: 'b', mtimeMs: NOW - 2 * DAY, size: 10 },
  ];
  const remove = planEditArchivePrune(entries, { maxBytes: 1000, maxAgeMs: 365 * DAY, now: NOW });
  assert.deepStrictEqual(remove, [], 'under cap + fresh -> keep all');
}

// max-age eviction: anything older than maxAge goes, regardless of size headroom
{
  const entries = [
    { name: 'old', mtimeMs: NOW - 400 * DAY, size: 1 },
    { name: 'fresh', mtimeMs: NOW - DAY, size: 1 },
  ];
  const remove = planEditArchivePrune(entries, { maxBytes: 1_000_000, maxAgeMs: 365 * DAY, now: NOW });
  assert.deepStrictEqual(names(remove), ['old'], 'past max age is evicted');
}

// LRU size eviction: oldest evicted first until under the byte cap
{
  const entries = [
    { name: 'newest', mtimeMs: NOW - 1 * DAY, size: 40 },
    { name: 'middle', mtimeMs: NOW - 2 * DAY, size: 40 },
    { name: 'oldest', mtimeMs: NOW - 3 * DAY, size: 40 },
  ];
  // cap 100: total 120 -> must drop 20+; oldest first -> drop 'oldest' (80 left)
  const remove = planEditArchivePrune(entries, { maxBytes: 100, maxAgeMs: 365 * DAY, now: NOW });
  assert.deepStrictEqual(names(remove), ['oldest'], 'LRU evicts oldest until under cap');
}

// combined: age-evict first, then LRU on the survivors
{
  const entries = [
    { name: 'ancient', mtimeMs: NOW - 500 * DAY, size: 30 },  // age-evicted
    { name: 'big-old', mtimeMs: NOW - 3 * DAY, size: 70 },
    { name: 'big-new', mtimeMs: NOW - 1 * DAY, size: 70 },
  ];
  // after age-evict: survivors total 140, cap 100 -> evict oldest survivor 'big-old'
  const remove = planEditArchivePrune(entries, { maxBytes: 100, maxAgeMs: 365 * DAY, now: NOW });
  assert.deepStrictEqual(names(remove).sort(), ['ancient', 'big-old'], 'age-evict then LRU');
}

// the newest file is never evicted just to fit if it alone is within cap
{
  const entries = [
    { name: 'keep', mtimeMs: NOW - DAY, size: 90 },
    { name: 'drop', mtimeMs: NOW - 5 * DAY, size: 90 },
  ];
  const remove = planEditArchivePrune(entries, { maxBytes: 100, maxAgeMs: 365 * DAY, now: NOW });
  assert.deepStrictEqual(names(remove), ['drop'], 'keeps newest, drops oldest');
}

console.log('edit archive tests passed');
