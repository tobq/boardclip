'use strict';

// End-to-end QA for editing a note that changed underneath its editor, on the
// REAL app in a throwaway sandbox (scripts/lib/qa-sandbox.js: temp data, cloaked
// windows, notifications recorded and never shown, no real clipboard).
// 1. Reopening a note after a save brings its editor forward: one window per
//    note, whatever id it has now (a second editor on the same note went stale
//    and forked it, 12 Oct 2026).
// 2. A save from an editor whose base was edited since gets a conflict record
//    against the note's newest version, the editor turns into the merge view,
//    and the notification carries a Merge button (Windows toast XML / macOS
//    actions) whose click shows that merge view.
// 3. Resolving folds the two copies back into ONE note that keeps its groups,
//    numpad key and title, with a supersede link from the fork.
//
// Usage: node scripts/qa-edit-conflict.js

const fs = require('fs');
const path = require('path');
const qa = require('./lib/qa-sandbox');
const conflictModel = require('../lib/conflict-model');

const { check, summary } = qa.createChecks();
const sleep = qa.sleep;

const editorWindowCount = `__qa.electron.BrowserWindow.getAllWindows().filter((w) => !w.isDestroyed() && /editor\\.html/.test(w.webContents.getURL())).length`;

async function main() {
  const now = Date.now();
  const noteText = 'qa shopping: eggs';
  const otherText = 'qa todo: call the bank';
  const noteId = qa.txtId(noteText);
  // A sync-style conflict on the note itself: resolving it moves the note to a
  // new version (new id + supersede link) underneath an open editor, as an edit
  // from another device would.
  const elsewhere = conflictModel.createConflictRecord({
    kind: 'merge',
    targetId: noteId,
    left: { id: noteId, type: 'text', text: noteText, title: 'qa list' },
    right: { id: noteId, type: 'text', text: 'qa shopping: eggs, milk', title: 'qa list' },
  });
  const sb = await qa.launch({
    name: 'editconflict',
    settings: { groups: ['home', 'qa-fork'], max_age_days: 30, max_size_gb: 1 },
    history: [
      { type: 'text', text: noteText, title: 'qa list', ts: now / 1000 - 100, updatedAt: now - 100000, pin: { number: 3, groups: ['home'], updatedAt: now - 100000 } },
      { type: 'text', text: otherText, ts: now / 1000 - 50, updatedAt: now - 50000 },
    ],
    conflicts: { records: [elsewhere], tombstones: [] },
  });
  console.log(`sandbox: ${sb.dir}`);
  try {
    const popup = await sb.popup();
    await popup.waitFor(`!!(window.api && document.querySelectorAll('.item').length >= 2)`, 'popup rendered', 20000);
    const state = async () => (await popup.eval('window.api.getHistoryState()')).items;
    const openEditor = async (id) => sb.newPage(/editor\.html/, () => popup.eval(`window.api.openEditor(${JSON.stringify(id)})`), { label: `editor for ${id.slice(0, 16)}` });
    const editorReady = (page) => page.waitFor(`!!(window.editorApi && document.querySelector('.bc-editor textarea'))`, 'editor mounted', 20000);

    // --- 1. One editor per note across saves -------------------------------
    const otherId = qa.txtId(otherText);
    const c = await openEditor(otherId);
    await editorReady(c);
    const otherNext = await c.eval(`window.editorApi.commit({ text: ${JSON.stringify(`${otherText} at 3pm`)}, title: '' })`);
    check('a save moves the note to a new id', otherNext && otherNext !== otherId, otherNext);
    await popup.eval(`window.api.openEditor(${JSON.stringify(otherNext)})`);
    await popup.eval(`window.api.openEditor(${JSON.stringify(otherId)})`);
    await sleep(1500);
    check('reopening by the new or the old id brings the same editor forward', await sb.mainEval(editorWindowCount) === 1, `editor windows: ${await sb.mainEval(editorWindowCount)}`);
    await c.eval('window.editorApi.close()');
    await qa.waitFor(async () => (await sb.mainEval(editorWindowCount)) === 0, 'editor closed', 10000);

    // --- 2. A stale editor's save -> conflict record + Merge notification ---
    const a = await openEditor(noteId);
    await editorReady(a);
    const moved = await a.eval(`window.editorApi.resolveConflict({ id: ${JSON.stringify(elsewhere.id)}, action: 'accept_right' })`);
    const afterMove = await state();
    const head = afterMove.find((it) => it.text === 'qa shopping: eggs, milk');
    check('the note moved underneath the open editor', moved && moved.ok && head && !afterMove.some((it) => it.id === noteId), JSON.stringify(moved));

    const notesBefore = (await sb.events()).filter((e) => e.type === 'notification_blocked').length;
    await a.eval(`window.editorApi.commit({ text: 'qa shopping: eggs, bread', title: 'qa list' })`);
    const afterFork = await state();
    const fork = afterFork.find((it) => it.text === 'qa shopping: eggs, bread');
    check('the stale save is kept beside the note', fork && afterFork.some((it) => it.id === head.id), afterFork.map((it) => it.text).join(' | '));
    const conflicts = await popup.eval('window.api.getConflicts()');
    const record = (conflicts || []).find((r) => r.kind === 'editor');
    check('an editor conflict record joins the note and the fork', record && record.left.id === head.id && record.targetId === fork.id && record.base && record.base.text === noteText, JSON.stringify(record && { left: record.left.id, target: record.targetId }));
    await a.waitFor(`!!document.querySelector('.CodeMirror-merge')`, 'the editor turned into the merge view', 15000);
    check('the editor turned into the merge view', true);

    const notes = (await sb.events()).filter((e) => e.type === 'notification_blocked');
    const note = notes[notes.length - 1];
    check('one notification for the fork', notes.length === notesBefore + 1, JSON.stringify(note));
    if (process.platform === 'win32') {
      check('Windows toast carries a Merge button', note && /<action content="Merge"[^>]*activationType="foreground"/.test(note.toastXml), note && note.toastXml);
    } else if (process.platform === 'darwin') {
      check('macOS notification carries a Merge action', note && note.actions.includes('Merge'), JSON.stringify(note && note.actions));
    }
    check('the notification says what happened', note && /changed while you were editing/.test(note.title), note && note.title);

    const windowsBefore = await sb.mainEval(editorWindowCount);
    await sb.mainEval(`(__qa.notifications[__qa.notifications.length - 1].emit('click'), true)`);
    await sleep(800);
    check('Merge brings the editor already showing the merge view forward (no second window)', await sb.mainEval(editorWindowCount) === windowsBefore, `windows ${windowsBefore} -> ${await sb.mainEval(editorWindowCount)}`);

    // Closed without resolving: the conflict list (or a later Merge) opens a conflict window.
    await a.eval('window.editorApi.close()');
    await qa.waitFor(async () => (await sb.mainEval(editorWindowCount)) === 0, 'merge editor closed', 10000);
    const conflictWin = await sb.newPage(/editor\.html/, () => popup.eval(`window.api.openConflict(${JSON.stringify(record.id)})`), { label: 'conflict window' });
    await conflictWin.waitFor(`!!document.querySelector('.CodeMirror-merge')`, 'conflict window merge view', 15000);
    check('after the editor closed, the conflict opens in its own merge window', true);

    // --- 3. Resolving makes them one note again -----------------------------
    await popup.eval(`(async () => {
      const revs = new Map((await window.api.getHistoryState()).items.map((x) => [x.id, x.rev]));
      return window.api.groupAssignMany([{ id: ${JSON.stringify(fork.id)}, rev: revs.get(${JSON.stringify(fork.id)}) }], 'qa-fork', true);
    })()`);
    const resolved = await conflictWin.eval(`window.editorApi.resolveConflict({ id: ${JSON.stringify(record.id)}, action: 'save', text: 'qa shopping: eggs, milk, bread', title: 'qa list' })`);
    const final = await state();
    const shopping = final.filter((it) => /^qa shopping/.test(it.text || ''));
    const merged = shopping[0];
    check('resolving leaves ONE note', resolved && resolved.ok && shopping.length === 1 && merged.text === 'qa shopping: eggs, milk, bread', shopping.map((it) => it.text).join(' | '));
    check('the note keeps its numpad key, title and groups, plus the fork\'s', merged && merged.pin && merged.pin.number === 3 && merged.title === 'qa list'
      && ['home', 'qa-fork'].every((g) => (merged.pin.groups || []).includes(g)), JSON.stringify(merged && { pin: merged.pin, title: merged.title }));
    check('the record is gone', ((await popup.eval('window.api.getConflicts()')) || []).length === 0);
    const settings = JSON.parse(fs.readFileSync(path.join(sb.dataDir, 'clipboard-settings.json'), 'utf8'));
    check('the fork supersedes into the note (a stale copy or editor follows it)', (settings.supersedes || []).some((s) => s.from === fork.id && s.to === merged.id), JSON.stringify((settings.supersedes || []).slice(-3)));
  } finally {
    const result = await sb.finish();
    if (!result.ok) process.exitCode = 1;
  }
  const { failed } = summary();
  if (failed) process.exitCode = 1;
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
