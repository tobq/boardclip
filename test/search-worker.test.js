'use strict';

// A /regex/ never runs on a page's (or the MCP host's) thread: 12 Oct 2026,
// y.*t.*b.*\?.*t= backtracked for minutes on a 20,000-char line and froze the
// popup for good. Covers Search.hasRegexTerm / searchJob, the page host
// Core.createSearchWorker (with a stand-in Worker) and the MCP side
// (lib/mcp-search-thread, a real worker thread).

const assert = require('assert');
const path = require('path');
const { Worker: NodeWorker } = require('worker_threads');
const Search = require('../site/shared/clip-search');
const Core = require('../site/shared/clipboard-ui-core');
const mcpCore = require('../lib/mcp-core');
const { searchClipsOffThread } = require('../lib/mcp-search-thread');

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// One line long enough that the user's pattern backtracks for minutes on it.
const SLOW_LINE = ('ytb ' + 'x'.repeat(30) + ' ').repeat(600);
const SLOW_PATTERN = '/y.*t.*b.*\\?.*t\\=/';

(async () => {
  // hasRegexTerm: a regex anywhere (top level, excluded, inside OR / groups).
  {
    const has = (q) => Search.hasRegexTerm(Search.parseQuery(q));
    assert.strictEqual(has('plain words'), false);
    assert.strictEqual(has('"/not a regex/"'), false, 'a quoted slash phrase is text');
    assert.strictEqual(has('/a.b/'), true);
    assert.strictEqual(has('-/a.b/'), true, 'an excluded regex still runs');
    assert.strictEqual(has('title:/a.b/'), true);
    assert.strictEqual(has('x OR /a.b/'), true, 'inside an OR');
    assert.strictEqual(has('(x (y OR -/a.b/))'), true, 'deep in a custom expression');
    assert.strictEqual(has('group:Work since:7d'), false);
  }

  // searchJob = filterRankIndexes + where each match first sits in its body.
  {
    const items = [
      { id: 'a', type: 'text', text: 'alpha beta', ts: 3 },
      { id: 'b', type: 'text', text: 'no match here', ts: 2 },
      { id: 'c', type: 'text', title: 'Beta notes', text: 'lead in then beta', ts: 1 },
      { id: 'i', type: 'image', ts: 4 },
    ];
    const docs = items.map(Search.clipToDoc);
    const hays = docs.map((d) => Search.docSearchText(d).toLowerCase());
    const now = 10 * 1000;
    for (const query of ['/b.ta/', 'beta', '/b.ta/ -alpha', 'title:/^beta/']) {
      const job = Search.searchJob(docs, hays, { query, now });
      const direct = Search.filterRankIndexes(null, Search.parseQuery(query), { docs, searchTextLower: hays, now });
      assert.deepStrictEqual(job.indexes, direct, `searchJob ranks as filterRankIndexes: ${query}`);
      job.indexes.forEach((ri, k) => assert.strictEqual(job.first[k], Search.firstMatchIndex(Search.parseQuery(query), docs[ri].body), `first match of ${items[ri].id}`));
    }
    const none = Search.searchJob(docs, hays, { query: '/zzz/ is:pinned', now });
    assert.deepStrictEqual(none.indexes, []);
    assert.ok('relax' in none, 'an empty result carries the nudge (or null)');
  }

  // createSearchWorker with a stand-in Worker: latest wins, a stuck job that is
  // no longer wanted is ended after the grace, the next starts on a fresh one.
  {
    const made = [];
    class FakeWorker {
      constructor(url) { this.url = url; this.posted = []; this.terminated = false; made.push(this); }
      postMessage(m) {
        this.posted.push(m);
        if (m.type === 'sync') return;
        if (m.query === 'stuck') return; // never answers, like a pattern backtracking for hours
        setTimeout(() => {
          if (this.terminated) return;
          this.onmessage({ data: m.type === 'find'
            ? { type: 'find', id: m.id, matches: [{ start: 0, end: 1 }], valid: true }
            : { type: 'search', id: m.id, indexes: [1, 0], first: [5, -1], relax: null } });
        }, 5);
      }
      terminate() { this.terminated = true; }
    }
    global.Worker = FakeWorker;
    try {
      const busy = [];
      const host = Core.createSearchWorker({ url: 'search-worker.js', graceMs: 40, busyMs: 10, onBusy: (b) => busy.push(b) });
      const docsA = [{ id: 'x' }, { id: 'y' }];
      const got = [];
      host.search({ docs: docsA, query: 'stuck' }, () => got.push('stuck'));
      await sleep(20);
      assert.deepStrictEqual(busy, [true], 'busy once a wanted result is outstanding');
      host.search({ docs: docsA, query: '/fine/' }, (r) => got.push(r.indexes));
      assert.strictEqual(made.length, 1, 'the new job waits while the stuck one has its grace');
      await sleep(80);
      assert.ok(made[0].terminated, 'the stuck worker is ended once its result is not wanted');
      assert.strictEqual(made.length, 2, 'a fresh worker runs the next job');
      assert.deepStrictEqual(made[1].posted[0].add.map((a) => a[0]), [1, 2], 'the fresh worker gets every doc again');
      await host.whenIdle();
      assert.deepStrictEqual(got, [[1, 0]], 'only the latest result is delivered');
      assert.strictEqual(busy[busy.length - 1], false, 'not busy once it is in');

      // A new history revision sends only the clips the worker does not have.
      const docsB = [docsA[0], { id: 'z' }];
      host.search({ docs: docsB, query: '/fine/' }, () => {});
      await host.whenIdle();
      const sync = made[1].posted.filter((m) => m.type === 'sync').pop();
      assert.deepStrictEqual(sync.order, [1, 3], 'docs keep their key');
      assert.deepStrictEqual(sync.add.map((a) => a[0]), [3], 'only the new clip is sent');

      // cancel(): a stuck job nobody wants any more is ended too (no worker
      // left spinning at 100% CPU in the background).
      host.search({ docs: docsB, query: 'stuck' }, () => got.push('late'));
      await sleep(5);
      host.cancel();
      await sleep(80);
      assert.ok(made[1].terminated, 'cancel ends a stuck worker after the grace');
      assert.ok(!got.includes('late'), 'a cancelled result never arrives');

      const found = await new Promise((resolve) => host.find({ text: 'abc', query: 'a', regex: true }, resolve));
      assert.deepStrictEqual(found.matches, [{ start: 0, end: 1 }], 'the find bar asks the same worker kind');
      host.dispose();
    } finally {
      delete global.Worker;
    }
    // No Worker at all (it failed to load): the job runs here, as before.
    const local = Core.createSearchWorker({ url: '' });
    const docs = [Search.clipToDoc({ id: 'a', type: 'text', text: 'hello world', ts: 1 })];
    let res = null;
    local.search({ docs, query: '/wor.d/' }, (r) => { res = r; });
    assert.deepStrictEqual(res && res.indexes, [0], 'the fallback answers at once');
  }

  // The real worker script answers a search and a find (Node stands in for the
  // browser's importScripts/self).
  {
    const workerPath = path.join(__dirname, '..', 'site', 'shared', 'search-worker.js');
    const shim = `
      const { parentPort } = require('worker_threads');
      const path = require('path');
      const fs = require('fs');
      const dir = ${JSON.stringify(path.dirname(workerPath))};
      global.self = global;
      global.importScripts = (f) => { global.BoardClipSearch = require(path.join(dir, f)); };
      global.postMessage = (m) => parentPort.postMessage(m);
      eval(fs.readFileSync(${JSON.stringify(workerPath)}, 'utf8'));
      parentPort.on('message', (m) => self.onmessage({ data: m }));
    `;
    const w = new NodeWorker(shim, { eval: true });
    const ask = (m) => new Promise((resolve) => { w.once('message', resolve); w.postMessage(m); });
    const docs = [{ id: 'a', type: 'text', text: 'one two', ts: 2 }, { id: 'b', type: 'text', text: 'three', ts: 1 }].map(Search.clipToDoc);
    w.postMessage({ type: 'sync', order: [1, 2], add: [[1, docs[0], null], [2, docs[1], null]] });
    const r = await ask({ type: 'search', id: 7, query: '/t.o/' });
    assert.strictEqual(r.id, 7);
    assert.deepStrictEqual(r.indexes, [0], 'the worker searches its synced docs');
    assert.deepStrictEqual(r.first, [4]);
    const f = await ask({ type: 'find', id: 8, text: 'a1 b2', query: '[0-9]', regex: true });
    assert.deepStrictEqual(f.matches, [{ start: 1, end: 2 }, { start: 4, end: 5 }]);
    await w.terminate();
  }

  // MCP: a regex search runs on a worker thread; a pattern that would hang is
  // ended (the host stays responsive), a normal one matches searchClips.
  {
    const history = [
      { id: 'txt:a', type: 'text', text: 'clip one', ts: 1, pin: { groups: ['AI'] } },
      { id: 'txt:slow', type: 'text', text: SLOW_LINE, ts: 2, pin: { groups: ['AI'] } },
    ];
    const settings = { groups: ['AI'], groups_shared_with_ai: ['AI'] };
    const plain = await searchClipsOffThread(history, settings, { query: 'clip' });
    assert.deepStrictEqual(plain, mcpCore.searchClips(history, settings, { query: 'clip' }), 'no regex: answered in place');
    const re = await searchClipsOffThread(history, settings, { query: '/cl.p/' });
    assert.strictEqual(re.matches.length, 1, 'a regex search answers from the worker');

    let ticks = 0;
    const ticker = setInterval(() => { ticks += 1; }, 20);
    const startedAt = Date.now();
    await assert.rejects(searchClipsOffThread(history, settings, { query: SLOW_PATTERN }, { maxMs: 600 }), /took too long/);
    clearInterval(ticker);
    assert.ok(Date.now() - startedAt < 3000, 'the slow pattern is ended near its limit');
    assert.ok(ticks >= 15, `this thread kept running meanwhile (${ticks} ticks)`);

    const ctl = new AbortController();
    const pending = searchClipsOffThread(history, settings, { query: SLOW_PATTERN }, { signal: ctl.signal });
    setTimeout(() => ctl.abort(), 100);
    await assert.rejects(pending, /cancelled/, 'the caller giving up ends the worker');
  }

  console.log('search-worker tests passed');
})().catch((error) => { console.error(error); process.exit(1); });
