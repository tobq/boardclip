'use strict';

// Sends each popup renderer only what changed in history since the state it
// already holds. Re-sending the whole history on every change cost the owner's
// popup ~1 s per refresh (13.9k clips, 70 MB of text cloned over IPC and
// re-indexed on the renderer's only thread), and a refresh fires on every
// capture, sync merge and settings save - typing froze behind each one.
//
// The feed remembers, per renderer, the revision + per-clip stamps it last
// sent. A request carrying exactly that revision gets a delta: the full id
// order plus only the clips whose stamp changed. Anything else (a fresh or
// reloaded renderer, a missed reply) gets a full snapshot, so a renderer can
// never apply a delta to state it does not have.

// Everything the renderer shows or acts on, minus the blob-sized bodies. Text
// changes always change the id (content-addressed); rich formats count by size.
function rendererStamp(item) {
  if (!item) return '';
  const { text, html, rtf, ...rest } = item;
  rest.htmlLen = typeof html === 'string' ? html.length : 0;
  rest.rtfLen = typeof rtf === 'string' ? rtf.length : 0;
  return JSON.stringify(rest);
}

function createHistoryFeed() {
  const sent = new Map(); // renderer key -> { revision, stamps: Map(id -> stamp) }

  // items: the renderer view of history (each with id + rev), in history order.
  function stateFor(key, knownRevision, revision, items) {
    if (knownRevision === revision) return { revision, unchanged: true };
    const list = items || [];
    const stamps = new Map();
    for (const item of list) stamps.set(item.id, rendererStamp(item));
    const prev = sent.get(key);
    sent.set(key, { revision, stamps });
    if (!prev || prev.revision !== knownRevision) return { revision, items: list };
    return {
      revision,
      delta: true,
      order: list.map(item => item.id),
      items: list.filter(item => prev.stamps.get(item.id) !== stamps.get(item.id)),
    };
  }

  return { stateFor, forget: (key) => sent.delete(key) };
}

module.exports = { createHistoryFeed, rendererStamp };
