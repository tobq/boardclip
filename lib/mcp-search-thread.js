'use strict';

// search_clips for the MCP helper and the app's approved full search, with a
// query that holds a /regex/ run on a worker thread: one pattern can backtrack
// for minutes on a long line (12 Oct 2026, the popup froze on
// y.*t.*b.*\?.*t= against a 20,000-char line), and on the calling thread that
// would hang the helper, or the app's main process for an approved search.
// The worker ends when the caller gives up (its abort signal) or, as a
// backstop for a caller that never does, after MAX_MS. A query without a regex
// runs right here, as before (a literal scan is linear).
//
// This file is also the worker's entry (workerData.mcpSearch).

const { Worker, isMainThread, parentPort, workerData } = require('worker_threads');
const mcpCore = require('./mcp-core');
const search = require('../site/shared/clip-search');

const MAX_MS = 2 * 60 * 1000;

if (!isMainThread && workerData && workerData.mcpSearch) {
  const { history, settings, opts } = workerData.mcpSearch;
  parentPort.postMessage(mcpCore.searchClips(history, settings, opts));
}

function hasRegex(opts) {
  const o = opts || {};
  return search.hasRegexTerm(search.parseQuery(o.regex ? search.legacyRegexQuery(o.query) : o.query));
}

// Resolves to searchClips' result; rejects with a message for the AI client
// when the pattern ran past the caller's patience.
function searchClipsOffThread(history, settings, opts, { signal, maxMs = MAX_MS } = {}) {
  if (!hasRegex(opts)) return Promise.resolve(mcpCore.searchClips(history, settings, opts));
  return new Promise((resolve, reject) => {
    const worker = new Worker(__filename, { workerData: { mcpSearch: { history, settings, opts } } });
    let done = false;
    const finish = (fn, value) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      if (signal) signal.removeEventListener('abort', onAbort);
      worker.terminate().catch(() => {});
      fn(value);
    };
    const tooSlow = () => new Error('This regular expression took too long on the clips (a few .* in a row backtrack on long lines). Narrow it, e.g. anchor it with literal text.');
    const onAbort = () => finish(reject, new Error('cancelled'));
    const timer = setTimeout(() => finish(reject, tooSlow()), maxMs);
    if (signal) {
      if (signal.aborted) { onAbort(); return; }
      signal.addEventListener('abort', onAbort);
    }
    worker.once('message', (result) => finish(resolve, result));
    worker.once('error', (error) => finish(reject, error));
    worker.once('exit', (code) => finish(reject, new Error(`search worker exited (${code})`)));
  });
}

module.exports = { searchClipsOffThread, MAX_MS };
