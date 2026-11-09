'use strict';
// Core.createClipboardFollow: the clipboard follows its clip. While the
// clipboard holds a clip, a change that replaces that clip (an editor save,
// Unify, a conflict resolved, an AI edit, an edit synced from another device)
// puts the clip's newest version on the clipboard, unless it already shows that
// text; it never writes over anything else. Two hosts drive it:
//   app  - content-addressed ids + edit lineage (old id -> new id), as main.js
//          (checkClipboardFollow / newestClipVersion) does;
//   demo - stable ids edited in place + a Unify lineage map, as site/index.html.
const assert = require('assert');
const Core = require('../site/shared/clipboard-ui-core');
const { createClipboardFollow, sameText } = Core;

// The app: history keyed by content (id = 'txt:' + text), lineage links, and
// the poller's view of the clipboard. check() mirrors main's checkClipboardFollow:
// the clipboard holds a clip only while that text is a live clip.
function appHost(initialHistory = []) {
  const live = new Map(initialHistory.map((t) => [`txt:${t}`, t]));
  const links = new Map(); // from -> to
  const board = { text: '', writes: [], blocked: false, os: null };
  const headOf = (id) => {
    let at = id;
    const seen = new Set();
    while (links.has(at) && !seen.has(at)) { seen.add(at); at = links.get(at); }
    return at === id ? null : at;
  };
  const follow = createClipboardFollow({
    newestOf: (id, heldText) => {
      if (live.has(id)) return { id, text: heldText };
      const head = headOf(id);
      return head && live.has(head) ? { id: head, text: live.get(head) } : null;
    },
    readText: () => (board.os != null ? board.os : board.text),
    writeText: (text) => {
      if (board.blocked) return false;
      board.text = text;
      board.writes.push(text);
      return true;
    },
  });
  const host = {
    live, links, board, follow,
    copy(text) { board.text = text; board.os = null; },
    // A change: drop `from` ids, add `to`, link each dropped id to it.
    replace(fromTexts, toText) {
      for (const t of fromTexts) { live.delete(`txt:${t}`); if (t !== toText) links.set(`txt:${t}`, `txt:${toText}`); }
      live.set(`txt:${toText}`, toText);
    },
    check() {
      const held = follow.held();
      if (board.text !== held.text || (held.id == null && board.text)) follow.hold(live.has(`txt:${board.text}`) ? `txt:${board.text}` : null, board.text);
      return follow.check();
    },
  };
  return host;
}

// 1. Unify: the clipboard held one of the merged clips -> it gets the result.
{
  const h = appHost(['alpha', 'beta', 'other']);
  h.copy('alpha');
  assert.strictEqual(h.check(), 'same', 'a live clip on the clipboard: nothing to do');
  h.replace(['alpha', 'beta'], 'alpha\nbeta');
  assert.strictEqual(h.check(), 'written');
  assert.strictEqual(h.board.text, 'alpha\nbeta');
  assert.strictEqual(h.follow.held().id, 'txt:alpha\nbeta', 'the clipboard now holds the result');
  assert.strictEqual(h.check(), 'same', 'and stays put');
  assert.deepStrictEqual(h.board.writes, ['alpha\nbeta']);
}

// 2. Any of the sources, not only the first.
{
  const h = appHost(['alpha', 'beta']);
  h.copy('beta');
  h.check();
  h.replace(['alpha', 'beta'], 'merged');
  assert.strictEqual(h.check(), 'written');
  assert.strictEqual(h.board.text, 'merged');
}

// 3. A clipboard holding something else is never touched (a replace of a clip
//    that is NOT on the clipboard writes nothing: two editors, or a Unify of
//    other clips).
{
  const h = appHost(['alpha', 'beta', 'mine']);
  h.copy('mine');
  h.check();
  h.replace(['alpha', 'beta'], 'merged');
  assert.strictEqual(h.check(), 'same');
  assert.strictEqual(h.board.text, 'mine');
  assert.deepStrictEqual(h.board.writes, []);
}

// 4. The result already matches the clipboard (line endings ignored: Windows
//    hands back CRLF for text BoardClip keeps as LF) -> no write, and the
//    clipboard now holds the result, so later edits of it follow.
{
  assert.ok(sameText('a\r\nb', 'a\nb') && sameText('a\rb', 'a\nb') && !sameText('a b', 'a\nb'));
  const h = appHost(['x\r\ny', 'z']);
  h.copy('x\r\ny');
  h.check();
  h.replace(['x\r\ny', 'z'], 'x\ny');
  assert.strictEqual(h.check(), 'same');
  assert.deepStrictEqual(h.board.writes, []);
  assert.strictEqual(h.follow.held().id, 'txt:x\ny');
  h.replace(['x\ny'], 'x\ny\nmore');
  assert.strictEqual(h.check(), 'written');
  assert.strictEqual(h.board.text, 'x\ny\nmore');
}

// 5. A plain delete (no newer version) leaves the clipboard as it is.
{
  const h = appHost(['gone soon']);
  h.copy('gone soon');
  h.check();
  h.live.delete('txt:gone soon');
  assert.strictEqual(h.check(), 'gone');
  assert.strictEqual(h.board.text, 'gone soon');
  assert.deepStrictEqual(h.board.writes, []);
}

// 6. The user copied something the host has not seen yet: never overwritten.
{
  const h = appHost(['note']);
  h.copy('note');
  h.check();
  h.replace(['note'], 'note 2');
  h.board.os = 'a URL the user just copied';
  assert.strictEqual(h.check(), 'changed');
  assert.deepStrictEqual(h.board.writes, []);
}

// 7. A write that cannot land (a paste sequence holds the clipboard) is retried:
//    the clipboard still holds the replaced clip, so the next check writes.
//    Meanwhile shownText() is already the result (an open editor of it keeps
//    saying "On clipboard" instead of flashing "changed elsewhere").
{
  const h = appHost(['t']);
  h.copy('t');
  h.check();
  h.replace(['t'], 't2');
  h.board.blocked = true;
  assert.strictEqual(h.check(), 'write_failed');
  assert.strictEqual(h.follow.shownText(), 't2');
  h.board.blocked = false;
  assert.strictEqual(h.check(), 'written');
  assert.deepStrictEqual(h.board.writes, ['t2']);
}

// 8. Editor saves, one check per save, follow every version; edits synced from
//    another device that arrive as a chain (v1 -> v2 -> v3 in one merge) jump
//    straight to the newest.
{
  const h = appHost(['v1']);
  h.copy('v1');
  h.check();
  h.replace(['v1'], 'v2');
  assert.strictEqual(h.check(), 'written');
  h.replace(['v2'], 'v3');
  assert.strictEqual(h.check(), 'written');
  assert.deepStrictEqual(h.board.writes, ['v2', 'v3']);
  const s = appHost(['s1']);
  s.copy('s1');
  s.check();
  s.replace(['s1'], 's2');
  s.replace(['s2'], 's3');
  assert.strictEqual(s.check(), 'written');
  assert.deepStrictEqual(s.board.writes, ['s3']);
}

// 9. An OLD version on the clipboard (copied from somewhere else after the clip
//    was edited, and not a live clip) is never "followed" to the newer one: only
//    a replacement of the clip the clipboard actually held moves it.
{
  const h = appHost(['old']);
  h.replace(['old'], 'new');
  h.copy('old');
  assert.strictEqual(h.check(), 'idle');
  h.replace(['new'], 'newer');
  assert.strictEqual(h.check(), 'idle');
  assert.deepStrictEqual(h.board.writes, []);
}

// 10. Nothing to hold: an empty clipboard or an image ('' to the poller), a
//     blank result.
{
  const h = appHost(['a']);
  h.copy('');
  assert.strictEqual(h.check(), 'idle');
  const f = createClipboardFollow({ newestOf: () => ({ id: 'b', text: '   ' }), writeText: () => true });
  f.hold('a', 'a');
  assert.strictEqual(f.check(), 'gone', 'a blank newest version is never written');
}

// 11. The demo: stable ids edited in place, Unify recorded as lineage; it cannot
//     read the clipboard (no readText), it knows what it copied.
{
  const clips = new Map([[1, 'demo one'], [2, 'demo two']]);
  const unified = new Map();
  const writes = [];
  const f = createClipboardFollow({
    newestOf: (id) => {
      let at = id;
      const seen = new Set();
      while (at != null && !seen.has(at)) {
        if (clips.has(at)) return { id: at, text: clips.get(at) };
        seen.add(at);
        at = unified.get(at);
      }
      return null;
    },
    writeText: (text) => { writes.push(text); return true; },
  });
  f.hold(1, 'demo one');
  clips.set(1, 'demo one, edited');
  assert.strictEqual(f.check(), 'written');
  clips.delete(1); clips.delete(2); clips.set(3, 'demo merged');
  unified.set(1, 3); unified.set(2, 3);
  assert.strictEqual(f.check(), 'written');
  assert.deepStrictEqual(writes, ['demo one, edited', 'demo merged']);
  assert.deepStrictEqual(f.held(), { id: 3, text: 'demo merged' });
}

// 12. A host error never escapes: a throwing writeText is a failed write.
{
  const f = createClipboardFollow({ newestOf: () => ({ id: 'b', text: 'b' }), writeText: () => { throw new Error('busy'); } });
  f.hold('a', 'a');
  assert.strictEqual(f.check(), 'write_failed');
}

console.log('clipboard-follow tests passed');
