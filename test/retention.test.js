'use strict';

const assert = require('assert');
const { planRetention } = require('../lib/retention');

const NOW = 1_000_000_000_000;
const DAY = 86400 * 1000;
const names = (entries) => entries.map((e) => e.name).sort();

// no policy -> nothing removed
{
  const entries = [{ name: 'a', mtimeMs: NOW, size: 5 }];
  assert.deepStrictEqual(planRetention(entries, {}), []);
}

// maxFiles: keep newest N, evict oldest excess (the history-backup policy)
{
  const entries = [
    { name: 'newest', mtimeMs: NOW - 1 * DAY, size: 1 },
    { name: 'mid', mtimeMs: NOW - 2 * DAY, size: 1 },
    { name: 'old', mtimeMs: NOW - 3 * DAY, size: 1 },
    { name: 'oldest', mtimeMs: NOW - 4 * DAY, size: 1 },
  ];
  const remove = planRetention(entries, { maxFiles: 2 });
  assert.deepStrictEqual(names(remove), ['old', 'oldest'], 'keep newest 2');
}

// maxAgeMs: drop anything past the cutoff regardless of size headroom
{
  const entries = [
    { name: 'ancient', mtimeMs: NOW - 400 * DAY, size: 1 },
    { name: 'fresh', mtimeMs: NOW - 1 * DAY, size: 1 },
  ];
  const remove = planRetention(entries, { maxAgeMs: 365 * DAY, now: NOW });
  assert.deepStrictEqual(names(remove), ['ancient']);
}

// maxBytes: LRU evict oldest until under the byte cap (the edit-archive policy)
{
  const entries = [
    { name: 'newest', mtimeMs: NOW - 1 * DAY, size: 40 },
    { name: 'middle', mtimeMs: NOW - 2 * DAY, size: 40 },
    { name: 'oldest', mtimeMs: NOW - 3 * DAY, size: 40 },
  ];
  const remove = planRetention(entries, { maxBytes: 100 }); // 120 -> drop oldest -> 80
  assert.deepStrictEqual(names(remove), ['oldest']);
}

// combined age + bytes: age first, then LRU on survivors
{
  const entries = [
    { name: 'ancient', mtimeMs: NOW - 500 * DAY, size: 30 }, // age-evicted
    { name: 'big-old', mtimeMs: NOW - 3 * DAY, size: 70 },
    { name: 'big-new', mtimeMs: NOW - 1 * DAY, size: 70 },
  ];
  // survivors total 140 > 100 -> evict oldest survivor 'big-old'
  const remove = planRetention(entries, { maxBytes: 100, maxAgeMs: 365 * DAY, now: NOW });
  assert.deepStrictEqual(names(remove), ['ancient', 'big-old']);
}

// newest is kept even if it alone fills the cap
{
  const entries = [
    { name: 'keep', mtimeMs: NOW - 1 * DAY, size: 90 },
    { name: 'drop', mtimeMs: NOW - 5 * DAY, size: 90 },
  ];
  const remove = planRetention(entries, { maxBytes: 100 });
  assert.deepStrictEqual(names(remove), ['drop'], 'keeps newest, drops oldest');
}

// missing sizes are treated as 0 (count/age policies don't need size)
{
  const entries = [
    { name: 'a', mtimeMs: NOW - 1 * DAY },
    { name: 'b', mtimeMs: NOW - 2 * DAY },
    { name: 'c', mtimeMs: NOW - 3 * DAY },
  ];
  const remove = planRetention(entries, { maxFiles: 1 });
  assert.deepStrictEqual(names(remove), ['b', 'c']);
}

console.log('retention tests passed');
