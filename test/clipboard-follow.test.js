'use strict';
// Core.createClipboardFollow: the clipboard follows its clip. While the
// clipboard holds a clip, a change that replaces that clip (an editor save,
// Unify, a conflict resolved, an AI edit, an edit synced from another device)
// puts the clip's newest version on the clipboard, unless it already shows that
// text; it never writes over anything else. Two hosts drive it:
//   app  - content-addressed ids + edit lineage (old id -> new id, with the
//          link's time), as main.js (checkClipboardFollow / newestClipVersion /
//          heldClipsFor) does, using the model's own rebornAfterLink;
//   demo - stable ids edited in place + a Unify lineage map, as site/index.html.
const assert = require('assert');
const Core = require('../site/shared/clipboard-ui-core');
const { rebornAfterLink } = require('../lib/clipboard-model');
const { createClipboardFollow, sameText, normalizeEol } = Core;

// The app: live clips keyed by content ('txt:' + text) with a mutation clock,
// lineage links { to, updatedAt }, clips whose text file has not arrived, and the
// poller's view of the clipboard. check() mirrors main's checkClipboardFollow:
// the clipboard holds every live clip of its text in any line-ending form.
function appHost(initialHistory = []) {
  let clock = 1000;
  const live = new Map(initialHistory.map((t) => [`txt:${t}`, { text: t, clock: clock++ }]));
  const links = new Map(); // from -> { to, updatedAt }
  const missing = new Set(); // ids whose text is only a preview so far
  const board = { text: '', writes: [], blocked: false, os: null };
  const headOf = (id) => {
    let at = id;
    const seen = new Set();
    while (links.has(at) && !seen.has(at)) { seen.add(at); at = links.get(at).to; }
    return at === id ? null : at;
  };
  const follow = createClipboardFollow({
    newestOf: (id, heldText, since) => {
      if (live.has(id)) return { id, text: heldText, since };
      const link = links.get(id);
      if (!link || rebornAfterLink(since, { updatedAt: link.updatedAt })) return null;
      const head = headOf(id);
      if (!head || !live.has(head)) return null;
      if (missing.has(head)) return { pending: true };
      return { id: head, text: live.get(head).text, since: live.get(head).clock };
    },
    readText: () => (board.os != null ? board.os : board.text),
    writeText: (text) => {
      if (board.blocked) return false;
      board.text = text;
      board.writes.push(text);
      return true;
    },
  });
  const heldClipsFor = (text) => {
    const lf = normalizeEol(text);
    return [...new Set([text, lf, lf.replace(/\n/g, '\r\n')])]
      .map((t) => `txt:${t}`).filter((id) => live.has(id)).map((id) => ({ id, since: live.get(id).clock }));
  };
  return {
    live, links, missing, board, follow,
    tick(ms = 10000) { clock += ms; },
    // A copy the poller captures: the clip is (re)added, live, with a new clock.
    copy(text) { board.text = text; board.os = null; live.set(`txt:${text}`, { text, clock: clock++ }); },
    // A page's Ctrl+C on Windows: the clipboard gets the CRLF form, captured as its own clip.
    copyAsCRLF(text) { this.copy(text.replace(/\r?\n/g, '\r\n')); },
    // A change: drop `from` clips, add `to`, link each dropped clip to it.
    replace(fromTexts, toText) {
      const at = clock++;
      for (const t of fromTexts) { live.delete(`txt:${t}`); if (t !== toText) links.set(`txt:${t}`, { to: `txt:${toText}`, updatedAt: at }); }
      live.set(`txt:${toText}`, { text: toText, clock: at });
    },
    check() {
      const held = follow.held();
      if (board.text !== held.text || (!held.ids.length && board.text)) follow.hold(heldClipsFor(board.text), board.text);
      return follow.check();
    },
  };
}

// 1. Unify: the clipboard held one of the merged clips -> it gets the result.
{
  const h = appHost(['alpha', 'beta', 'other']);
  h.copy('alpha');
  assert.strictEqual(h.check(), 'same', 'a live clip on the clipboard: nothing to do');
  h.replace(['alpha', 'beta'], 'alpha\nbeta');
  assert.strictEqual(h.check(), 'written');
  assert.strictEqual(h.board.text, 'alpha\nbeta');
  assert.deepStrictEqual(h.follow.held().ids, ['txt:alpha\nbeta'], 'the clipboard now holds the result');
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

// 4. The result already matches the clipboard (line endings ignored) -> no
//    write, and the clipboard now holds the result, so later edits of it follow.
{
  assert.ok(sameText('a\r\nb', 'a\nb') && sameText('a\rb', 'a\nb') && !sameText('a b', 'a\nb'));
  const big = 'x'.repeat(1000);
  assert.ok(sameText(big, big), 'the same string is the same text without normalising it');
  const h = appHost(['x\r\ny', 'z']);
  h.copy('x\r\ny');
  h.check();
  h.replace(['x\r\ny', 'z'], 'x\ny');
  assert.strictEqual(h.check(), 'same');
  assert.deepStrictEqual(h.board.writes, []);
  assert.deepStrictEqual(h.follow.held().ids, ['txt:x\ny']);
  h.replace(['x\ny'], 'x\ny\nmore');
  assert.strictEqual(h.check(), 'written');
  assert.strictEqual(h.board.text, 'x\ny\nmore');
}

// 5. Windows: Ctrl+C in the editor writes the note as CRLF, captured as its own
//    clip. The note (LF) is held too, so the next save still follows (the old
//    editor-only follower matched text this way).
{
  const h = appHost(['note\nline']);
  h.copyAsCRLF('note\nline');
  assert.strictEqual(h.check(), 'same');
  assert.deepStrictEqual(h.follow.held().ids.sort(), ['txt:note\nline', 'txt:note\r\nline'].sort());
  h.replace(['note\nline'], 'note\nline\nedited');
  assert.strictEqual(h.check(), 'written');
  assert.strictEqual(h.board.text, 'note\nline\nedited');
}

// 6. A plain delete (no newer version) leaves the clipboard as it is.
{
  const h = appHost(['gone soon']);
  h.copy('gone soon');
  h.check();
  h.live.delete('txt:gone soon');
  assert.strictEqual(h.check(), 'gone');
  assert.strictEqual(h.board.text, 'gone soon');
  assert.deepStrictEqual(h.board.writes, []);
}

// 7. An OLD lineage link is not about a later copy of the same text: A was
//    edited to B, then A was copied again (captured, live, newer clock) and then
//    deleted. The clipboard keeps A; it is never "followed" to B. Unify of such
//    a re-copied clip follows to the Unify result, not the old head.
{
  const h = appHost(['A text']);
  h.replace(['A text'], 'B text');
  h.tick();
  h.copy('A text');
  h.check();
  h.live.delete('txt:A text');
  assert.strictEqual(h.check(), 'gone', 'the old A -> B link predates this copy of A');
  assert.deepStrictEqual(h.board.writes, []);
  const u = appHost(['S text', 'partner']);
  u.replace(['S text'], 'old head');
  u.tick();
  u.copy('S text');
  u.check();
  u.tick();
  u.replace(['S text', 'partner'], 'unified'); // the newer link wins (the ledger keeps the newest per clip)
  assert.strictEqual(u.check(), 'written');
  assert.strictEqual(u.board.text, 'unified');
}

// 8. The user copied something the host has not seen yet: never overwritten.
{
  const h = appHost(['note']);
  h.copy('note');
  h.check();
  h.replace(['note'], 'note 2');
  h.board.os = 'a URL the user just copied';
  assert.strictEqual(h.check(), 'changed');
  assert.deepStrictEqual(h.board.writes, []);
}

// 9. A write that cannot land (a paste sequence holds the clipboard) is retried;
//    meanwhile shownText() is already the result (an open editor of it keeps
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

// 10. A synced long note whose text file has not arrived: never write its
//     preview; wait ('pending'), then write the full text once it is readable.
{
  const h = appHost(['long note']);
  h.copy('long note');
  h.check();
  h.replace(['long note'], 'long note, edited on the Mac');
  h.missing.add('txt:long note, edited on the Mac');
  assert.strictEqual(h.check(), 'pending');
  assert.deepStrictEqual(h.board.writes, []);
  h.missing.clear();
  assert.strictEqual(h.check(), 'written');
  assert.strictEqual(h.board.text, 'long note, edited on the Mac');
}

// 11. Editor saves, one check per save, follow every version; edits synced from
//     another device that arrive as a chain jump straight to the newest.
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

// 12. Nothing to hold: an empty clipboard or an image ('' to the poller), a
//     text that is no live clip (a "Copy all" join), a blank result.
{
  const h = appHost(['a']);
  h.copy('');
  assert.strictEqual(h.check(), 'idle');
  h.board.text = 'a\nb joined';
  assert.strictEqual(h.check(), 'idle');
  const f = createClipboardFollow({ newestOf: () => ({ id: 'b', text: '   ' }), writeText: () => true });
  f.hold('a', 'a');
  assert.strictEqual(f.check(), 'gone', 'a blank newest version is never written');
}

// 13. The demo: stable ids edited in place, Unify recorded as lineage; it cannot
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
  assert.deepStrictEqual(f.held(), { ids: [3], text: 'demo merged' });
}

// 14. A host error never escapes: a throwing writeText is a failed write.
{
  const f = createClipboardFollow({ newestOf: () => ({ id: 'b', text: 'b' }), writeText: () => { throw new Error('busy'); } });
  f.hold('a', 'a');
  assert.strictEqual(f.check(), 'write_failed');
}

console.log('clipboard-follow tests passed');
