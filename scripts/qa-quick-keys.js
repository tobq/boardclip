'use strict';

// Sandbox QA for the popup's quick keys (the shared controller's armQuickKeys /
// onPointerdown), against the REAL popup of a throwaway instance
// (scripts/lib/qa-sandbox.js: isolated data + profile, cloaked never-focused
// windows, no OS clipboard), driven over CDP with real key and mouse events:
// - right after the popup opens (resetPopupState), 1 with slot 1 assigned
//   pastes it and is not typed; N opens a new note;
// - a click on the search first, then 1: it types 1;
// - an arrow first, then N: it types n; Shift+N types N; a digit whose slot is
//   empty types it; a lone Shift first keeps them;
// - one real N goes through the app's own New note path (an editor window);
// - a shortcut recording ends when the popup resets or Settings closes;
// - the demo (site/index.html): not armed on load (nothing in it has focus);
//   opened from the dock, 1 copies slot 1 (nothing typed), N opens its note
//   window, a click on its search first makes 1 type.
// The slot paste is stubbed in the page (appAdapter.quickPaste counts and
// never calls through), so no paste or clipboard write happens at all.
//
// Usage: node scripts/qa-quick-keys.js

const path = require('path');
const qa = require('./lib/qa-sandbox');

const { check, summary } = qa.createChecks();
const sleep = qa.sleep;
const J = JSON.stringify;

// One key press as CDP sends a real one: keyDown with text types it (unless
// the page prevents it), rawKeyDown for keys that type nothing.
const VK = { ArrowDown: 40, Shift: 16 };
const CODE = { ArrowDown: 'ArrowDown', Shift: 'ShiftLeft' };
async function press(page, key, { shift = false } = {}) {
  const modifiers = shift ? 8 : 0;
  if (VK[key]) {
    await page.send('Input.dispatchKeyEvent', { type: 'rawKeyDown', key, code: CODE[key], windowsVirtualKeyCode: VK[key], modifiers });
    await page.send('Input.dispatchKeyEvent', { type: 'keyUp', key, code: CODE[key], windowsVirtualKeyCode: VK[key], modifiers });
    return;
  }
  const code = /^[0-9]$/.test(key) ? `Digit${key}` : `Key${key.toUpperCase()}`;
  const vk = key.toUpperCase().charCodeAt(0);
  await page.send('Input.dispatchKeyEvent', { type: 'keyDown', key, code, text: key, unmodifiedText: key.toLowerCase(), windowsVirtualKeyCode: vk, modifiers });
  await page.send('Input.dispatchKeyEvent', { type: 'keyUp', key, code, windowsVirtualKeyCode: vk, modifiers });
}

async function main() {
  const now = Math.floor(Date.now() / 1000);
  const history = [];
  for (let i = 0; i < 12; i += 1) history.push({ type: 'text', text: `qa quick key clip ${i}`, ts: now - i * 60 });
  for (const it of history) it.id = qa.txtId(it.text);
  history[3].pin = { number: 1 }; // slot 1 holds clip 3; slot 2 is empty
  const sb = await qa.launch({ name: 'quickkeys', history, settings: { surface_style: 'solid' } });
  let ok = false;
  try {
    const popup = await sb.openPopup({ focus: true });
    await popup.waitFor(`!!(window.api && document.querySelectorAll('.item').length >= 10 && typeof appAdapter === 'object')`, 'popup rows');
    // The stubs: count, never call through (no paste, no clipboard write).
    await popup.eval(`(() => {
      window.__qk = [];
      window.__qkReal = { newNote: appAdapter.newNote };
      appAdapter.quickPaste = (slot) => { __qk.push('paste ' + slot); };
      appAdapter.newNote = () => { __qk.push('note'); };
      return true;
    })()`);
    // Each scenario starts from a fresh open (the app's own reset) with an empty search.
    const open = () => popup.eval(`(appAdapter.setQuery(''), window.resetPopupState(), __qk.length = 0, true)`);
    const state = () => popup.eval(`({ calls: __qk.slice(), value: document.getElementById('search').value, armed: controller.quickKeysArmed() })`);

    await open();
    check('the popup opens armed', (await state()).armed);
    await press(popup, '1');
    await sleep(150);
    let s = await state();
    check('after an open, 1 (slot 1 assigned) pastes slot 1 and is not typed', J(s.calls) === J(['paste 1']) && s.value === '', J(s));
    await press(popup, '1');
    await sleep(150);
    s = await state();
    check('one quick key per open: a second 1 types', J(s.calls) === J(['paste 1']) && s.value === '1', J(s));

    await open();
    await press(popup, 'n');
    await sleep(150);
    s = await state();
    check('after an open, N opens a new note and is not typed', J(s.calls) === J(['note']) && s.value === '', J(s));

    await open();
    await popup.click('#search');
    await sleep(150);
    check('a click on the search ends them', !(await state()).armed);
    await press(popup, '1');
    await sleep(150);
    s = await state();
    check('a click on the search, then 1: 1 is typed, nothing pasted', !s.calls.length && s.value === '1', J(s));

    await open();
    await press(popup, 'ArrowDown');
    await press(popup, 'n');
    await sleep(150);
    s = await state();
    check('an arrow first, then n: n is typed, no note', !s.calls.length && s.value === 'n', J(s));

    await open();
    await press(popup, 'N', { shift: true });
    await sleep(150);
    s = await state();
    check('Shift+N types N', !s.calls.length && s.value === 'N', J(s));

    await open();
    await press(popup, '2');
    await sleep(150);
    s = await state();
    check('a digit whose slot is empty types it', !s.calls.length && s.value === '2', J(s));

    await open();
    await press(popup, 'Shift', { shift: true });
    await press(popup, 'n');
    await sleep(150);
    s = await state();
    check('a lone Shift first keeps them: n still opens a note', J(s.calls) === J(['note']) && s.value === '', J(s));

    // An IME (Japanese, Chinese, Korean) starts a composition on the N key with
    // key 'Process' / keyCode 229: it types into the composition, opens no note.
    await open();
    await popup.send('Input.dispatchKeyEvent', { type: 'rawKeyDown', key: 'Process', code: 'KeyN', windowsVirtualKeyCode: 229 });
    await popup.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Process', code: 'KeyN', windowsVirtualKeyCode: 229 });
    await sleep(150);
    s = await state();
    check('IME: the N key starting a composition opens no note and ends them', !s.calls.length && !s.armed, J(s));

    // One real N through the app's own New note path: an editor window opens.
    await popup.eval(`(appAdapter.newNote = __qkReal.newNote, true)`);
    await open();
    const editor = await sb.newPage(/editor\.html/, () => press(popup, 'n'), { label: 'editor window', timeoutMs: 15000 }).catch(() => null);
    check('a real N opens a new note window (the New note path)', !!editor, editor ? editor.url : 'no editor window');
    if (editor) {
      const isNew = await editor.waitFor(`!!document.querySelector('.bc-editor-area') && document.querySelector('.bc-editor-area').value === ''`, 'blank editor', 10000).then(() => true, () => false);
      check('the new note is blank', isNew);
    }
    const blocked = (await sb.events()).filter((e) => e.type === 'paste_blocked' || e.type === 'clipboard_write');
    check('no paste and no clipboard write was attempted', blocked.length === 0, J(blocked.slice(0, 3)));

    // Settings: the New note shortcut row beside Quick paste shortcut, showing
    // this platform's default (Win+N on Windows, none elsewhere). On Windows its
    // reset slot offers Turn off (the default is a chord Windows owns too):
    // off shows "Not set" and the slot turns into the reset back to Win+N.
    const readRow = () => popup.eval(`(async () => {
      const rec = document.getElementById('newNoteShortcutRecord');
      const reset = document.getElementById('newNoteShortcutReset');
      const info = (await window.api.getSettings()).shortcut_info || {};
      return { text: rec.textContent, unset: rec.classList.contains('unset'), reset: getComputedStyle(reset).visibility,
        resetTitle: reset.title, resetGlyph: reset.textContent.trim(), label: rec.closest('.setting-row').textContent.trim(),
        platform: window.api.platform, effective: info.newNote, custom: !!info.newNoteCustom };
    })()`);
    const clickReset = async () => {
      await popup.eval(`(document.getElementById('newNoteShortcutReset').click(), true)`);
      await sleep(500);
    };
    await popup.eval(`(async () => { await openSettings(); return true; })()`);
    let row = await readRow();
    if (row.platform === 'win32') {
      check('Settings: "New note shortcut" shows Win + N, the slot offers Turn off',
        row.text === 'Win + N' && !row.unset && row.reset === 'visible' && row.resetTitle === 'Turn off' && row.resetGlyph === 'close' && /New note shortcut/.test(row.label), J(row));
      await clickReset();
      row = await readRow();
      check('Settings: Turn off shows "Not set" and offers the reset back',
        row.text === 'Not set' && row.unset && row.effective === '' && row.custom && row.reset === 'visible' && row.resetGlyph === 'restart_alt' && row.resetTitle !== 'Turn off', J(row));
      const stored = JSON.parse(require('fs').readFileSync(path.join(sb.dataDir, 'clipboard-settings.json'), 'utf8').replace(/^﻿/, ''));
      check('Settings: off persists per device as new_note_shortcut "none"', stored.new_note_shortcut === 'none', J({ new_note_shortcut: stored.new_note_shortcut }));
      await clickReset();
      row = await readRow();
      check('Settings: the reset brings Win + N back with Turn off', row.text === 'Win + N' && row.effective === 'Super+N' && !row.custom && row.resetTitle === 'Turn off', J(row));
    } else {
      check('Settings: "New note shortcut" shows Not set, no reset (off is the default here)', row.text === 'Not set' && row.unset && row.reset === 'hidden' && /New note shortcut/.test(row.label), J(row));
    }
    await popup.eval(`(closeSettings(), true)`);

    // A shortcut recording never outlives its row: the popup hiding or showing
    // (resetPopupState) or Settings closing cancels it the way Esc does (the
    // label back, the shortcuts resumed), so the next keys type into the search
    // instead of being recorded as a global shortcut.
    const rec = await popup.eval(`(async () => {
      const recEl = document.getElementById('newNoteShortcutRecord');
      await openSettings();
      await startShortcutRecording('newNote');
      const during = { recording: shortcutRecording, label: recEl.textContent };
      window.resetPopupState();
      await new Promise((r) => setTimeout(r, 400));
      const afterReset = { recording: shortcutRecording, label: recEl.textContent, cls: recEl.classList.contains('recording') };
      await openSettings();
      await startShortcutRecording('show');
      closeSettings();
      await new Promise((r) => setTimeout(r, 400));
      appAdapter.setQuery('');
      return { during, afterReset, afterClose: shortcutRecording, starting: shortcutRecordStarting };
    })()`);
    check('a recording ends when the popup resets or Settings closes', rec.during.recording === 'newNote' && rec.during.label === 'Press keys'
      && rec.afterReset.recording === null && !rec.afterReset.cls && rec.afterReset.label !== 'Press keys' && rec.afterClose === null && !rec.starting, J(rec));
    await popup.eval(`(document.getElementById('search').focus(), true)`);
    await press(popup, 'h');
    await sleep(150);
    s = await state();
    check('after a cancelled recording, keys type into the search again', s.value === 'h', J(s));
    await popup.eval(`(appAdapter.setQuery(''), true)`);

    // --- the demo: the same controller --------------------------------------
    const site = await qa.startStaticServer(path.join(qa.ROOT, 'site'));
    try {
      const page = await sb.openWindow(site.url, { width: 1280, height: 900, focus: true });
      await page.waitFor(`document.readyState === 'complete' && !!document.getElementById('demo-search') && document.querySelectorAll('#demo-window .item').length > 3`, 'site loaded');
      // The sandbox stubs the page's clipboard (each call is recorded in main,
      // nothing reaches the OS clipboard): the copy shows as those records.
      await page.eval(`(document.getElementById('demo-window').scrollIntoView({ block: 'center' }), true)`);
      const copies = async () => (await sb.events()).filter((e) => e.type === 'clipboard_api_blocked' && /^write/.test(e.api || '')).length;
      const demo = () => page.eval(`({ value: document.getElementById('demo-search').value, clipwin: !document.getElementById('demo-clipwin').hidden,
        armed: controller.quickKeysArmed(), focused: document.activeElement.id })`);
      // Close the demo popup, then open it again from the dock, with real clicks
      // (the visitor's path: openPopup arms the quick keys and focuses the search).
      const reopen = async () => {
        await page.click('#demo-close-button');
        await sleep(450);
        await page.eval(`(document.getElementById('demo-dock-app').scrollIntoView({ block: 'nearest' }), true)`);
        await page.click('#demo-dock-app');
        await sleep(450);
        await page.eval(`(document.getElementById('demo-window').scrollIntoView({ block: 'center' }), true)`);
      };
      const slot1 = await page.eval(`!!Core.numpadMap(clips)[1]`);
      let d = await demo();
      // On load the popup is open but nothing in it has focus, and the click
      // that would focus it ends quick keys: they arm when it is opened.
      check('demo: on load the popup is open, the quick keys not armed yet', !d.armed && d.focused !== 'demo-search' && slot1, J(d));
      await reopen();
      d = await demo();
      check('demo: opened from the dock, armed with the search focused', d.armed && d.focused === 'demo-search', J(d));
      const before = await copies();
      await press(page, '1');
      const copied = await qa.waitFor(async () => (await copies()) > before, 'demo copy', 5000, 150).catch(() => false);
      d = await demo();
      check('demo: after an open, 1 (slot 1) copies it and is not typed', d.value === '' && !d.clipwin && !!copied, J({ ...d, copied: !!copied }));
      await reopen();
      await press(page, 'n');
      await sleep(400);
      d = await demo();
      check('demo: reopened, N opens a new note window and is not typed', d.value === '' && d.clipwin, J(d));
      await page.eval(`(() => { const close = document.querySelector('#demo-clipwin [data-x="close"]'); if (close) close.click(); return true; })()`);
      await sleep(400);
      // A press in the popup (the search field) ends them there too.
      await reopen();
      await page.click('#demo-search');
      await sleep(150);
      await press(page, '1');
      await sleep(200);
      d = await demo();
      check('demo: a click on the search, then 1: 1 is typed', d.value === '1', J(d));
    } finally {
      await site.close();
    }

    const rendererErrors = sb.diagnostics().filter((e) => e.event === 'renderer.error');
    check('no renderer errors during the run', rendererErrors.length === 0, rendererErrors.map((e) => JSON.stringify(e).slice(0, 200)).join(' | '));
    ok = true;
  } finally {
    const cleanup = await sb.finish();
    check('sandbox cleaned up (no leftovers)', cleanup.ok, cleanup.problems.join('; '));
  }
  const s = summary();
  process.exit(ok && s.failed === 0 ? 0 : 1);
}

main().catch((error) => { console.error('qa-quick-keys error:', error.stack || error.message); process.exit(1); });
