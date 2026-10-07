'use strict';
// lib/clipboard-follow.js: an open editor keeps the clipboard in step with its
// note while (and only while) the clipboard holds that note, and never writes
// over something the user copied elsewhere. A fake clipboard stands in for the
// system one; two followers on one clipboard model two open editors.
const assert = require('assert');
const { createClipboardFollower, sameText } = require('../lib/clipboard-follow');

function fakeClipboard(initial = '') {
  const board = { text: initial, writes: [], blocked: false };
  board.api = () => ({
    readText: () => board.text,
    writeText: (text) => {
      if (board.blocked) return false;
      board.text = text;
      board.writes.push(text);
      return true;
    },
  });
  return board;
}

// 1. The note is on the clipboard when the editor opens -> every save follows.
{
  const board = fakeClipboard('draft v1');
  const f = createClipboardFollower(board.api());
  assert.deepStrictEqual(f.observe(['draft v1']), { following: true, event: 'started' });
  assert.deepStrictEqual(f.afterSave('draft v1', 'draft v2'), { following: true, event: 'written' });
  assert.strictEqual(board.text, 'draft v2');
  assert.strictEqual(f.afterSave('draft v2', 'draft v3').event, 'written');
  assert.deepStrictEqual(board.writes, ['draft v2', 'draft v3']);
}

// 2. A note that is NOT on the clipboard never touches it.
{
  const board = fakeClipboard('something else');
  const f = createClipboardFollower(board.api());
  assert.strictEqual(f.observe(['my note']).event, 'idle');
  assert.deepStrictEqual(f.afterSave('my note', 'my note edited'), { following: false, event: 'idle' });
  assert.strictEqual(board.text, 'something else');
  assert.deepStrictEqual(board.writes, []);
}

// 3. The user copies something else mid-edit -> following stops, nothing is
//    overwritten, and later saves leave the clipboard alone.
{
  const board = fakeClipboard('note');
  const f = createClipboardFollower(board.api());
  f.observe(['note']);
  f.afterSave('note', 'note 2');
  board.text = 'a URL the user copied';
  assert.deepStrictEqual(f.afterSave('note 2', 'note 3'), { following: false, event: 'stopped' });
  assert.strictEqual(board.text, 'a URL the user copied');
  assert.strictEqual(f.afterSave('note 3', 'note 4').event, 'idle');
  assert.deepStrictEqual(board.writes, ['note 2']);
  // observe() reports the stop the moment the copy happens, too.
  const g = createClipboardFollower(board.api());
  board.text = 'x';
  g.observe(['x']);
  assert.strictEqual(g.observe(['x'], 'copied elsewhere').event, 'stopped');
}

// 4. Copying the note itself later (Ctrl+C in the editor, pasting it from the
//    popup) makes it the clipboard -> following starts then.
{
  const board = fakeClipboard('unrelated');
  const f = createClipboardFollower(board.api());
  assert.strictEqual(f.observe(['the note']).event, 'idle');
  board.text = 'the note';
  assert.strictEqual(f.observe(['the note'], board.text).event, 'started');
  assert.strictEqual(f.afterSave('the note', 'the note, edited').event, 'written');
  assert.strictEqual(board.text, 'the note, edited');
  // A save that finds the PREVIOUS saved text on the clipboard adopts it even if
  // no observe() ran (a copy path the poller never saw).
  const board2 = fakeClipboard('saved text');
  const g = createClipboardFollower(board2.api());
  assert.strictEqual(g.afterSave('saved text', 'saved text plus').event, 'written');
  assert.strictEqual(board2.text, 'saved text plus');
}

// 5. Line endings are ignored when matching (Windows apps hand back CRLF).
{
  assert.ok(sameText('a\r\nb', 'a\nb'));
  const board = fakeClipboard('line one\r\nline two');
  const f = createClipboardFollower(board.api());
  assert.strictEqual(f.observe(['line one\nline two']).event, 'started');
  assert.strictEqual(f.afterSave('line one\nline two', 'line one\nline two\nthree').event, 'written');
}

// 6. Two editors on one clipboard: Copy in editor B takes the clipboard, editor
//    A stops at its next save instead of overwriting B's note.
{
  const board = fakeClipboard('note A');
  const a = createClipboardFollower(board.api());
  const b = createClipboardFollower(board.api());
  assert.strictEqual(a.observe(['note A']).event, 'started');
  assert.strictEqual(b.observe(['note B']).event, 'idle');
  assert.deepStrictEqual(b.adopt('note B'), { following: true, event: 'adopted' });
  assert.strictEqual(board.text, 'note B');
  assert.strictEqual(a.afterSave('note A', 'note A2').event, 'stopped');
  assert.strictEqual(board.text, 'note B', 'A never clobbers B');
  assert.strictEqual(b.afterSave('note B', 'note B2').event, 'written');
  assert.strictEqual(board.text, 'note B2');
}

// 7. Blank notes never start following (an empty clipboard + a new empty note
//    must not count as "on the clipboard").
{
  const board = fakeClipboard('');
  const f = createClipboardFollower(board.api());
  assert.strictEqual(f.observe(['']).event, 'idle');
  assert.strictEqual(f.adopt('   ').event, 'idle');
  assert.deepStrictEqual(board.writes, []);
}

// 8. A write that cannot land (a paste sequence holds the clipboard) keeps
//    following and retries on the next save; a title-only save writes nothing.
{
  const board = fakeClipboard('t');
  const f = createClipboardFollower(board.api());
  f.observe(['t']);
  board.blocked = true;
  assert.deepStrictEqual(f.afterSave('t', 't2'), { following: true, event: 'write_failed' });
  board.blocked = false;
  assert.strictEqual(f.afterSave('t', 't2').event, 'written');
  assert.strictEqual(f.afterSave('t2', 't2').event, 'following', 'unchanged text -> no write');
  assert.deepStrictEqual(board.writes, ['t2']);
}

console.log('clipboard-follow tests passed');
