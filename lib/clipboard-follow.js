'use strict';

// Keeps an open editor's note and the system clipboard in step. While the
// clipboard holds the note's text, every save of the note also puts the new
// text on the clipboard, so a pasted copy is never stale and the user never has
// to re-copy from the editor. It only ever writes over its OWN text: before each
// write it checks the clipboard still holds what it last saw there, and if the
// user copied something else in between it stops following instead of
// clobbering it. Pure + injected (readText/writeText), so it is unit-tested
// without Electron; main.js owns one per editor session.
//
// The clipboard "holds the note" when its text equals one of the note's
// current versions (the live draft or the last saved text), line endings
// ignored - Windows apps hand back CRLF for text the editor keeps as LF.

function normalizeEol(text) {
  return String(text == null ? '' : text).replace(/\r\n?/g, '\n');
}

function sameText(a, b) {
  return normalizeEol(a) === normalizeEol(b);
}

function createClipboardFollower({ readText, writeText } = {}) {
  let following = false;
  let lastSeen = null; // exact clipboard text last seen/written while following

  function read() {
    try { const text = readText(); return String(text == null ? '' : text); } catch { return null; }
  }
  function holdsNote(clip, texts) {
    return (texts || []).some(text => String(text || '').trim() && sameText(clip, text));
  }
  function result(event) {
    return { following, event };
  }
  function stop() {
    following = false;
    lastSeen = null;
    return result('stopped');
  }

  // The clipboard may have changed (a copy anywhere, the editor regaining
  // focus, the editor opening). `texts` = the note's current versions.
  // `clipText` lets a caller that already read the clipboard pass it in.
  function observe(texts, clipText) {
    const clip = clipText !== undefined ? String(clipText == null ? '' : clipText) : read();
    if (clip == null) return result('unknown');
    if (holdsNote(clip, texts) || (following && clip === lastSeen)) {
      const started = !following;
      following = true;
      lastSeen = clip;
      return result(started ? 'started' : 'following');
    }
    return following ? stop() : result('idle');
  }

  // The note was saved: `prevText` was its previous saved text, `text` the new.
  // Follows the save onto the clipboard if the clipboard holds this note.
  function afterSave(prevText, text) {
    const clip = read();
    if (clip == null) return result('unknown');
    const ours = (following && clip === lastSeen) || holdsNote(clip, [prevText, text]);
    if (!ours) return following ? stop() : result('idle');
    const started = !following;
    following = true;
    if (sameText(clip, text)) {
      lastSeen = clip;
      return result(started ? 'started' : 'following');
    }
    if (!writeText(String(text || ''))) {
      // Not written (e.g. a paste sequence holds the clipboard). Still ours,
      // so the next save retries.
      lastSeen = clip;
      return result('write_failed');
    }
    lastSeen = String(text || '');
    return result('written');
  }

  // The editor's Copy button: put the note on the clipboard and follow it.
  function adopt(text) {
    if (!String(text || '').trim()) return result(following ? 'following' : 'idle');
    if (!writeText(String(text))) return result('write_failed');
    following = true;
    lastSeen = String(text);
    return result('adopted');
  }

  return {
    observe,
    afterSave,
    adopt,
    isFollowing: () => following,
  };
}

module.exports = { createClipboardFollower, normalizeEol, sameText };
