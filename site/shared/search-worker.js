// BoardClip search worker: runs every search that holds a /regex/, and the
// editor find bar's regex, off the page's thread. Hosted by
// Core.createSearchWorker (clipboard-ui-core.js), which ends this worker when a
// pattern runs on after its result is no longer wanted. Messages:
//   { type: 'sync', order: [key], add: [[key, doc, hay]] }  the docs, by key
//   { type: 'search', id, query, sortMode, now } -> { type, id, indexes, first, relax }
//   { type: 'find', id, text, query, regex, caseSensitive } -> { type, id, matches, valid, error }
importScripts('clip-search.js');
const Search = self.BoardClipSearch;
const byKey = new Map();
let docs = [];
let hays = null;

self.onmessage = (event) => {
  const m = event.data || {};
  if (m.type === 'sync') {
    for (const [key, doc, hay] of m.add) byKey.set(key, { doc, hay });
    const keep = new Set(m.order);
    for (const key of byKey.keys()) if (!keep.has(key)) byKey.delete(key);
    const entries = m.order.map((key) => byKey.get(key) || { doc: null, hay: null });
    docs = entries.map((e) => e.doc);
    hays = entries.some((e) => e.hay != null) ? entries.map((e) => e.hay) : null;
    return;
  }
  if (m.type === 'search') {
    self.postMessage({ type: 'search', id: m.id, ...Search.searchJob(docs, hays, m) });
    return;
  }
  if (m.type === 'find') {
    const term = Search.compileTerm(m.query, { regex: !!m.regex, caseSensitive: !!m.caseSensitive });
    self.postMessage({ type: 'find', id: m.id, matches: term.all(String(m.text || '')), valid: term.valid, error: term.error });
  }
};
