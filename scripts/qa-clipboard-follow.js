'use strict';

// End-to-end QA for "the clipboard follows its clip" (Core.createClipboardFollow
// + main's checkClipboardFollow), on the REAL app in throwaway sandboxes
// (scripts/lib/qa-sandbox.js: temp data, cloaked windows, an in-memory clipboard
// that is never the user's). One rule: the clipboard holds a clip, a change
// replaces it, so its newest version goes onto the clipboard unless it already
// shows that text; nothing else is ever overwritten.
//   1. Unify with a source on the clipboard -> the merged text; lineage links
//      source -> merged; no duplicate clip captured.
//   2. Unify of OTHER clips -> the clipboard is untouched.
//   3. Unify whose result is already the clipboard's text (CRLF vs LF) -> no write.
//   4. Unify closed before the last step -> untouched.
//   5. Conflict resolved (accept incoming) / 6. Keep both -> the resolved text.
//   7. An open editor: saves follow, the footer says "On clipboard"; a copy of
//      something else stops it; the footer's Copy brings it back.
//   8. An editor still open on a Unify source: typing there gives the merge view
//      against the merged clip (a conflict record), not a silent duplicate.
//   9. An AI edit_clip, allowed in the prompt -> the edited text.
//  12. A Unify that lands while a numpad quick paste holds the clipboard: the
//      check waits for the paste to end, so its restore cannot leave the old
//      text there; the merged text arrives right after.
//  13. Windows: Ctrl+C in the editor puts the note on the clipboard as CRLF (a
//      page's copy), captured as its own clip; the next save still follows.
//  14. An old version copied again and then deleted: an old edit link from that
//      text is not "followed" (the clipboard keeps what the user copied).
//  15. A clean editor left on a unified-away clip: opening the merged clip shows
//      the merged text (the stale editor is replaced, not brought forward).
//  10. An edit made on ANOTHER device (second sandbox, shared cloud folder) ->
//      this device's clipboard follows once the edit syncs.
//  11. The website demo: Unify and an edit of the clip the page copied write the
//      visitor's clipboard (writeBrowserClipboard recorded, never the real one).
//
// Usage: node scripts/qa-clipboard-follow.js

const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const qa = require('./lib/qa-sandbox');
const conflictModel = require('../lib/conflict-model');

const { check, summary } = qa.createChecks();
const sleep = qa.sleep;
const now = Date.now() / 1000;
const txt = (text, age, pin) => ({ id: qa.txtId(text), type: 'text', text, ts: now - age, updatedAt: (now - age) * 1000, ...(pin ? { pin } : {}) });

const T = {
  u1: 'qa unify\nline one', u2: 'qa unify\nline one\nline two', merged1: 'qa unify\nline one\nline two\nline three',
  o1: 'qa other one', o2: 'qa other two', keep: 'qa unrelated keep me',
  s1: 'qa same\nline', s2: 'qa same\r\nline',
  a1: 'qa abort one', a2: 'qa abort two',
  note: 'qa note v1',
  e1: 'qa stale source', e2: 'qa stale source\nplus a partner line', eMerged: 'qa stale merged result',
  cBase: 'qa conflict base', cIncoming: 'qa conflict base + incoming',
  kBase: 'qa keepboth base', kIncoming: 'qa keepboth incoming', kBoth: 'qa keepboth base\nqa keepboth incoming',
  ai: 'qa ai clip', aiEdited: 'qa ai clip, edited by the AI',
  q1: 'qa quick source', q2: 'qa quick partner', qMerged: 'qa quick source\nqa quick partner', macro: 'qa numpad macro',
  w: 'qa crlf note\nsecond line', wEdited: 'qa crlf note\nsecond line\nthird line',
  r: 'qa reborn text', rEdited: 'qa reborn text, edited',
  v1: 'qa clean source', v2: 'qa clean partner', vMerged: 'qa clean source + partner',
};
const editorWindowCount = `__qa.electron.BrowserWindow.getAllWindows().filter((w) => !w.isDestroyed() && /editor\\.html/.test(w.webContents.getURL())).length`;

// Real-app helpers on one sandbox.
function helpers(sb) {
  const clip = () => sb.mainEval('({ text: __qa.clipboard.text, writes: __qa.clipboard.writes })');
  // A copy in another app: the in-memory clipboard changes, the poller captures it.
  const copyAs = async (text) => {
    await sb.mainEval(`(() => { const f = __qa.clipboard; f.text = ${JSON.stringify(text)}; f.html = ''; f.rtf = ''; f.image = null; f.seq += 1; return true; })()`);
    await qa.waitFor(async () => {
      const items = await sb.historyState();
      return items.length && items[0].text === text;
    }, `poller captured ${JSON.stringify(text.slice(0, 24))}`, 10000);
    await sleep(500);
  };
  const items = () => sb.historyState();
  const byText = async (text) => (await items()).find((it) => it.text === text);
  const settings = () => { try { return JSON.parse(fs.readFileSync(path.join(sb.dataDir, 'clipboard-settings.json'), 'utf8')); } catch { return {}; } };
  const clipboardBecomes = (text, label, ms = 10000) => qa.waitFor(async () => (await clip()).text === text, label, ms).then(() => true, () => false);
  return { clip, copyAs, items, byText, settings, clipboardBecomes };
}

async function appScenarios() {
  const recC = conflictModel.createConflictRecord({
    kind: 'merge', targetId: qa.txtId(T.cBase),
    left: { id: qa.txtId(T.cBase), type: 'text', text: T.cBase }, right: { id: qa.txtId(T.cBase), type: 'text', text: T.cIncoming },
  });
  const recK = conflictModel.createConflictRecord({
    kind: 'merge', targetId: qa.txtId(T.kBase),
    left: { id: qa.txtId(T.kBase), type: 'text', text: T.kBase }, right: { id: qa.txtId(T.kBase), type: 'text', text: T.kIncoming },
  });
  const sb = await qa.launch({
    name: 'clipfollow',
    ai: true,
    // A wide quick-paste restore window, so scenario 12 lands inside it.
    settings: { groups: ['AI'], diagnostics_enabled: true, max_age_days: 30, max_size_gb: 1, surface_style: 'solid', quick_paste_restore_delay_ms: 1500 },
    history: [
      txt(T.v2, 790), txt(T.v1, 800), txt(T.r, 810), txt(T.w, 820),
      txt(T.macro, 830, { number: 5 }), txt(T.q2, 840), txt(T.q1, 850),
      txt(T.ai, 860, { groups: ['AI'] }),
      txt(T.kBase, 870), txt(T.cBase, 880),
      txt(T.e2, 890), txt(T.e1, 900),
      txt(T.note, 910),
      txt(T.a2, 920), txt(T.a1, 930),
      txt(T.s2, 940), txt(T.s1, 950),
      txt(T.keep, 960), txt(T.o2, 970), txt(T.o1, 980),
      txt(T.u2, 990), txt(T.u1, 1000),
    ],
    conflicts: { records: [recC, recK], tombstones: [] },
  });
  console.log(`sandbox: ${sb.dir}`);
  const h = helpers(sb);
  try {
    const popup = await sb.popup();
    await popup.waitFor(`!!(window.api && document.querySelectorAll('.item').length >= 10)`, 'popup rendered', 30000);
    const unifyWindow = (ids) => sb.newPage(/editor\.html/, () => popup.eval(`window.api.startUnify(${JSON.stringify(ids)})`), { label: 'unify window', timeoutMs: 20000 });
    const unifyReady = (page) => page.waitFor(`!!(window.editorApi && window.editorApi.unifyStep && document.querySelector('.bc-reconcile'))`, 'unify view mounted', 20000);
    const openEditor = (id) => sb.newPage(/editor\.html/, () => popup.eval(`window.api.openEditor(${JSON.stringify(id)})`), { label: `editor ${id.slice(0, 14)}` });
    const editorReady = (page) => page.waitFor(`!!(window.editorApi && document.querySelector('.bc-editor textarea'))`, 'editor mounted', 20000);
    const footerOn = (page) => page.eval(`!!document.querySelector('.bc-editor-clip.on')`);
    const typeAndSave = (page, text) => page.eval(`(() => { const ta = document.querySelector('.bc-editor textarea'); ta.value = ${JSON.stringify(text)}; ta.dispatchEvent(new Event('input', { bubbles: true })); editor.commit(); return true; })()`);

    // --- 1. Unify, a source on the clipboard --------------------------------
    await h.copyAs(T.u1);
    let before = await h.clip();
    let page = await unifyWindow([qa.txtId(T.u1), qa.txtId(T.u2)]);
    await unifyReady(page);
    const done1 = await page.eval(`window.editorApi.unifyStep({ text: ${JSON.stringify(T.merged1)}, title: '' })`);
    const followed1 = await h.clipboardBecomes(T.merged1, 'clipboard = the unified text');
    let after = await h.clip();
    check('1. Unify with a source on the clipboard: the clipboard gets the merged text', done1 && done1.done && followed1, JSON.stringify({ done1, clip: after.text }));
    check('1. ...in exactly one write', after.writes === before.writes + 1, `writes ${before.writes} -> ${after.writes}`);
    const mergedId = qa.txtId(T.merged1);
    const links = h.settings().supersedes || [];
    check('1. Unify records each source -> the merged clip', [T.u1, T.u2].every((t) => links.some((l) => l.from === qa.txtId(t) && l.to === mergedId)), JSON.stringify(links.slice(-3)));
    await sleep(1200); // two polls: the written text must not come back as a new clip
    const list1 = await h.items();
    check('1. no duplicate captured, sources gone', list1.filter((it) => it.text === T.merged1).length === 1 && !list1.some((it) => it.text === T.u1 || it.text === T.u2), list1.slice(0, 4).map((it) => it.text).join(' | '));

    // --- 2. Unify of other clips leaves the clipboard alone -----------------
    await h.copyAs(T.keep);
    before = await h.clip();
    page = await unifyWindow([qa.txtId(T.o1), qa.txtId(T.o2)]);
    await unifyReady(page);
    await page.eval(`window.editorApi.unifyStep({ text: ${JSON.stringify(`${T.o1}\n${T.o2}`)}, title: '' })`);
    await sleep(1200);
    after = await h.clip();
    check('2. Unify of clips NOT on the clipboard: untouched', after.text === T.keep && after.writes === before.writes, JSON.stringify(after));

    // --- 3. Result already on the clipboard (CRLF vs LF folds silently) ------
    await h.copyAs(T.s1);
    before = await h.clip();
    const res3 = await popup.eval(`window.api.startUnify(${JSON.stringify([qa.txtId(T.s1), qa.txtId(T.s2)])})`);
    await sleep(1200);
    after = await h.clip();
    const list3 = await h.items();
    check('3. Unify whose result is the clipboard text (line endings aside): no write', res3 && res3.done && after.text === T.s1 && after.writes === before.writes && list3.filter((it) => /^qa same/.test(it.text || '')).length === 1, JSON.stringify({ res3, after }));

    // --- 4. Unify closed before the last step -------------------------------
    await h.copyAs(T.a1);
    before = await h.clip();
    page = await unifyWindow([qa.txtId(T.a1), qa.txtId(T.a2)]);
    await unifyReady(page);
    await page.eval('(window.editorApi.close(), true)').catch(() => {});
    await sleep(1200);
    after = await h.clip();
    const list4 = await h.items();
    check('4. Unify closed before finishing: clipboard and clips untouched', after.text === T.a1 && after.writes === before.writes && [T.a1, T.a2].every((t) => list4.some((it) => it.text === t)), JSON.stringify(after));

    // --- 5. + 6. Conflicts --------------------------------------------------
    await h.copyAs(T.cBase);
    const conflictWin = await sb.newPage(/editor\.html/, () => popup.eval(`window.api.openConflict(${JSON.stringify(recC.id)})`), { label: 'conflict window' });
    await conflictWin.waitFor('!!(window.editorApi && window.editorApi.resolveConflict)', 'conflict window api', 20000);
    const r5 = await conflictWin.eval(`window.editorApi.resolveConflict({ id: ${JSON.stringify(recC.id)}, action: 'accept_right' })`);
    check('5. Conflict resolved (accept incoming) with its clip on the clipboard: the resolved text', r5 && r5.ok && await h.clipboardBecomes(T.cIncoming, 'clipboard = resolved'), JSON.stringify(await h.clip()));
    await h.copyAs(T.kBase);
    const r6 = await conflictWin.eval(`window.editorApi.resolveConflict({ id: ${JSON.stringify(recK.id)}, action: 'keep_both', text: ${JSON.stringify(T.kBoth)} })`);
    check('6. Keep both: the union text', r6 && r6.ok && await h.clipboardBecomes(T.kBoth, 'clipboard = keep both'), JSON.stringify(await h.clip()));
    await conflictWin.eval('(window.editorApi.close(), true)').catch(() => {});

    // --- 7. An open editor --------------------------------------------------
    await h.copyAs(T.note);
    const ed = await openEditor(qa.txtId(T.note));
    await editorReady(ed);
    check('7. editor opened on the note on the clipboard says "On clipboard"', await footerOn(ed));
    await typeAndSave(ed, 'qa note v2');
    check('7. a save follows onto the clipboard', await h.clipboardBecomes('qa note v2', 'editor save followed'), JSON.stringify(await h.clip()));
    check('7. ...and the footer still says "On clipboard"', await footerOn(ed));
    await h.copyAs('qa copied something else');
    const off = await qa.waitFor(async () => !(await footerOn(ed)), 'footer leaves "On clipboard"', 5000).then(() => true, () => false);
    before = await h.clip();
    await typeAndSave(ed, 'qa note v3');
    await sleep(800);
    after = await h.clip();
    check('7. after copying something else: footer stops, saves leave the clipboard alone', off && after.text === 'qa copied something else' && after.writes === before.writes, JSON.stringify(after));
    // The "Clipboard changed elsewhere" notice shows for 2.5 s, then the Copy button.
    await ed.waitFor(`!!document.querySelector('.bc-editor-copy')`, 'footer Copy button', 8000);
    await ed.eval(`(document.querySelector('.bc-editor-copy').click(), true)`);
    const copied = await h.clipboardBecomes('qa note v3', 'footer Copy');
    const onAgain = await qa.waitFor(() => footerOn(ed), 'footer back on', 5000).then(() => true, () => false);
    check('7. the footer\'s Copy puts the note back and follows it again', copied && onAgain, JSON.stringify(await h.clip()));
    await typeAndSave(ed, 'qa note v4');
    check('7. ...so the next save follows', await h.clipboardBecomes('qa note v4', 'save after Copy followed'), JSON.stringify(await h.clip()));
    await ed.eval('(window.editorApi.close(), true)').catch(() => {});

    // --- 8. An editor still open on a Unify source --------------------------
    const stale = await openEditor(qa.txtId(T.e1));
    await editorReady(stale);
    page = await unifyWindow([qa.txtId(T.e1), qa.txtId(T.e2)]);
    await unifyReady(page);
    await page.eval(`window.editorApi.unifyStep({ text: ${JSON.stringify(T.eMerged)}, title: '' })`);
    await sleep(600);
    await stale.eval(`window.editorApi.commit({ text: 'qa stale source, typed after the unify', title: '' })`);
    const conflicts8 = (await popup.eval('window.api.getConflicts()')) || [];
    const rec8 = conflicts8.find((r) => r.kind === 'editor' && r.left && r.left.id === qa.txtId(T.eMerged));
    const merge8 = await stale.waitFor(`!!document.querySelector('.CodeMirror-merge')`, 'stale editor merge view', 10000).then(() => true, () => false);
    check('8. typing in an editor left open on a Unify source: merge view against the merged clip', !!rec8 && merge8, JSON.stringify(conflicts8.map((r) => ({ kind: r.kind, left: r.left && r.left.id.slice(0, 14) }))));
    await stale.eval('(window.editorApi.close(), true)').catch(() => {});

    // --- 9. An AI edit_clip, allowed ----------------------------------------
    await h.copyAs(T.ai);
    const ref = await sb.aiRef(await h.byText(T.ai));
    let req = null;
    const modal = await sb.newPage(/mcp-approval\.html/, () => {
      req = sb.mcp('edit_clip', { ...ref, text: T.aiEdited }, { client: 'Claude (follow QA)', timeoutMs: 60000 });
      req.catch(() => {});
    }, { label: 'edit prompt', timeoutMs: 15000 });
    await modal.waitFor(`!!document.getElementById('allowOnce') && !document.getElementById('allowOnce').disabled`, 'allow armed', 15000);
    await modal.click('#allowOnce').catch(() => {});
    const res9 = await req.catch((e) => ({ error: e.message }));
    check('9. an AI edit you allow, of the clip on the clipboard: the edited text', await h.clipboardBecomes(T.aiEdited, 'AI edit followed'), JSON.stringify({ res: res9 && (res9.error || res9.ok), clip: (await h.clip()).text }));

    // --- 12. A Unify during a numpad quick paste ----------------------------
    await h.copyAs(T.q1);
    page = await unifyWindow([qa.txtId(T.q1), qa.txtId(T.q2)]);
    await unifyReady(page);
    const pastesBefore = (await sb.events()).filter((e) => e.type === 'paste_blocked').length;
    const quick = popup.eval('window.api.numpadPasteAndHide(5)').catch(() => null);
    const inFlight = await h.clipboardBecomes(T.macro, 'quick paste holds the clipboard', 5000);
    await page.eval(`window.editorApi.unifyStep({ text: ${JSON.stringify(T.qMerged)}, title: '' })`);
    const during = (await h.clip()).text;
    await quick;
    const followed12 = await h.clipboardBecomes(T.qMerged, 'merged text after the quick paste', 8000);
    const pasted = (await sb.events()).filter((e) => e.type === 'paste_blocked').length > pastesBefore;
    await sleep(1200);
    const settled = await h.clip();
    check('12. Unify during a quick paste: nothing written mid-paste, the merged text once it ends (not the restored old text)',
      inFlight && pasted && during === T.macro && followed12 && settled.text === T.qMerged,
      JSON.stringify({ inFlight, pasted, during, settled: settled.text }));

    // --- 13. Windows: a CRLF copy from the editor ---------------------------
    const crlfEd = await openEditor(qa.txtId(T.w));
    await editorReady(crlfEd);
    await h.copyAs(T.w.replace(/\n/g, '\r\n'));
    const crlfOn = await qa.waitFor(() => footerOn(crlfEd), 'footer on for the CRLF copy', 5000).then(() => true, () => false);
    await typeAndSave(crlfEd, T.wEdited);
    check('13. Ctrl+C in the editor as CRLF (Windows), then a save: the clipboard follows', crlfOn && await h.clipboardBecomes(T.wEdited, 'CRLF copy followed'), JSON.stringify({ crlfOn, clip: (await h.clip()).text }));
    await crlfEd.eval('(window.editorApi.close(), true)').catch(() => {});

    // --- 14. An old version copied again, then deleted ----------------------
    const rEd = await openEditor(qa.txtId(T.r));
    await editorReady(rEd);
    await typeAndSave(rEd, T.rEdited); // lineage: r -> rEdited
    await qa.waitFor(async () => !!(await h.byText(T.rEdited)), 'r edited', 5000);
    await rEd.eval('(window.editorApi.close(), true)').catch(() => {});
    await sleep(5600); // past the reborn slack: the copy below is a NEW copy of that text
    await h.copyAs(T.r);
    before = await h.clip();
    const rItem = await h.byText(T.r);
    await popup.eval(`window.api.deleteItems([{ id: ${JSON.stringify(rItem.id)}, rev: ${JSON.stringify(rItem.rev)} }])`);
    await sleep(1200);
    after = await h.clip();
    const rGone = !(await h.items()).some((it) => it.text === T.r);
    check('14. an old version copied again and then deleted: the clipboard keeps it (no stale edit followed)', rGone && after.text === T.r && after.writes === before.writes, JSON.stringify({ rGone, after }));

    // --- 15. A clean editor left on a unified-away clip ---------------------
    const vEd = await openEditor(qa.txtId(T.v1));
    await editorReady(vEd);
    page = await unifyWindow([qa.txtId(T.v1), qa.txtId(T.v2)]);
    await unifyReady(page);
    await page.eval(`window.editorApi.unifyStep({ text: ${JSON.stringify(T.vMerged)}, title: '' })`);
    await sleep(600);
    const fresh = await sb.newPage(/editor\.html/, () => popup.eval(`window.api.openEditor(${JSON.stringify(qa.txtId(T.vMerged))})`), { label: 'editor for the merged clip', timeoutMs: 8000 }).catch(() => null);
    if (fresh) await editorReady(fresh);
    const shows = fresh ? await fresh.eval(`document.querySelector('.bc-editor textarea').value`) : null;
    const editorsLeft = await qa.waitFor(async () => ((await sb.mainEval(editorWindowCount)) === 1 ? 1 : null), 'stale editor closed', 8000).catch(() => sb.mainEval(editorWindowCount));
    check('15. opening the merged clip while a clean editor shows a source: one editor, showing the merged text', shows === T.vMerged && editorsLeft === 1, JSON.stringify({ shows, editorsLeft }));
    if (fresh) await fresh.eval('(window.editorApi.close(), true)').catch(() => {});

    const followErrors = sb.diagnostics().filter((e) => e.event === 'clipboard.follow_error');
    check('no clipboard.follow_error logged', followErrors.length === 0, JSON.stringify(followErrors[0]));

    // --- 11. The website demo (in this sandbox) -----------------------------
    const site = await qa.startStaticServer(path.join(qa.ROOT, 'site'));
    try {
      const web = await sb.openWindow(site.url);
      await web.waitFor(`document.readyState === 'complete' && typeof runDemoUnify === 'function' && !!window.CodeMirror`, 'demo loaded', 30000);
      const ids = await web.eval(`(() => {
        window.__w = [];
        writeBrowserClipboard = async (t) => { window.__w.push(t); return true; };
        addCopiedText('qa demo\\nline one\\nline two');
        addCopiedText('qa demo\\nline one');
        const a = clips.find((c) => c.text === 'qa demo\\nline one');
        const b = clips.find((c) => c.text === 'qa demo\\nline one\\nline two');
        runDemoUnify([Core.itemId(a), Core.itemId(b)]);
        return [Core.itemId(a), Core.itemId(b)];
      })()`);
      await web.waitFor(`!!document.querySelector('#demo-clipwin-body [data-x="save"]')`, 'demo unify view', 15000);
      await sleep(400);
      await web.eval(`(document.querySelector('#demo-clipwin-body [data-x="save"]').click(), true)`);
      const demoUnify = await qa.waitFor(() => web.eval(`window.__w.includes('qa demo\\nline one\\nline two') ? window.__w.slice() : null`), 'demo unify wrote', 10000).catch(() => null);
      check('11. demo: Unify of the clip the page copied writes the visitor\'s clipboard', !!demoUnify, JSON.stringify({ ids, writes: await web.eval('window.__w') }));
      const demoEdit = await web.eval(`(async () => {
        const merged = clips.find((c) => c.text === 'qa demo\\nline one\\nline two');
        openDemoEditor(Core.itemId(merged));
        await new Promise((r) => setTimeout(r, 300));
        const ta = document.querySelector('#demo-clipwin-body textarea');
        ta.value = 'qa demo, edited';
        ta.dispatchEvent(new Event('input', { bubbles: true }));
        demoEditor.commit();
        await new Promise((r) => setTimeout(r, 100));
        return window.__w.slice();
      })()`);
      check('11. demo: an edit of that clip writes it too', demoEdit[demoEdit.length - 1] === 'qa demo, edited', JSON.stringify(demoEdit));
      const demoOther = await web.eval(`(async () => {
        const n = window.__w.length;
        addCopiedText('qa demo unrelated');
        const others = clips.filter((c) => c.type !== 'image' && !/^qa demo/.test(c.text || '')).slice(0, 2);
        const target = others[0];
        openDemoEditor(Core.itemId(target));
        await new Promise((r) => setTimeout(r, 300));
        const ta = document.querySelector('#demo-clipwin-body textarea');
        ta.value = (target.text || '') + ' edited';
        ta.dispatchEvent(new Event('input', { bubbles: true }));
        demoEditor.commit();
        await new Promise((r) => setTimeout(r, 100));
        return window.__w.length - n;
      })()`);
      check('11. demo: editing a clip the page did NOT copy writes nothing', demoOther === 0, `writes: ${demoOther}`);
    } finally {
      await site.close();
    }
  } finally {
    const result = await sb.finish();
    if (!result.ok) process.exitCode = 1;
  }
}

// --- 10. An edit made on another device ---------------------------------------
async function syncScenario() {
  const parent = os.tmpdir();
  const work = fs.mkdtempSync(path.join(parent, 'bc-follow-sync-'));
  const cloudDir = path.join(work, 'cloud');
  fs.mkdirSync(cloudDir, { recursive: true });
  const secret = crypto.randomBytes(32).toString('hex');
  const seed = [txt('qa synced note v1', 500), txt('qa synced filler', 600)];
  const base = (device) => ({ p2p_secret: secret, p2p_device_id: device, p2p_enabled: false, diagnostics_enabled: true, sync_custom_paths: [cloudDir], surface_style: 'solid' });
  let a = null;
  let b = null;
  try {
    [a, b] = await Promise.all([
      qa.launch({ name: 'followsyncA', settings: base(`qa-follow-a-${secret.slice(0, 6)}`), history: seed }),
      qa.launch({ name: 'followsyncB', settings: base(`qa-follow-b-${secret.slice(0, 6)}`), history: seed }),
    ]);
    const ha = helpers(a);
    const hb = helpers(b);
    await (await a.popup()).waitFor('!!window.api', 'A popup', 30000);
    const pb = await b.popup();
    await pb.waitFor('!!window.api', 'B popup', 30000);
    await ha.copyAs('qa synced note v1');
    await hb.copyAs('qa something on B');
    const beforeA = await ha.clip();
    const beforeB = await hb.clip();
    const ed = await b.newPage(/editor\.html/, () => pb.eval(`window.api.openEditor(${JSON.stringify(qa.txtId('qa synced note v1'))})`), { label: 'B editor' });
    await ed.waitFor(`!!(window.editorApi && document.querySelector('.bc-editor textarea'))`, 'B editor mounted', 20000);
    await ed.eval(`window.editorApi.commit({ text: 'qa synced note v2, edited on B', title: '' })`);
    const t0 = Date.now();
    const followed = await ha.clipboardBecomes('qa synced note v2, edited on B', 'A clipboard follows B\'s edit', 60000);
    const afterA = await ha.clip();
    const afterB = await hb.clip();
    check('10. an edit synced from another device: this device\'s clipboard follows', followed, `${Date.now() - t0} ms, A clipboard: ${JSON.stringify(afterA.text)}`);
    check('10. ...in one write, and the other device\'s own clipboard is untouched', afterA.writes === beforeA.writes + 1 && afterB.text === 'qa something on B' && afterB.writes === beforeB.writes, JSON.stringify({ beforeA, afterA, afterB }));
  } finally {
    for (const sb of [a, b]) if (sb) { const r = await sb.finish(); if (!r.ok) process.exitCode = 1; }
    try { fs.rmSync(work, { recursive: true, force: true }); } catch {}
  }
}

(async () => {
  try {
    await appScenarios();
    await syncScenario();
  } catch (error) {
    console.error(error);
    process.exitCode = 1;
  }
  const { failed } = summary();
  if (failed) process.exitCode = 1;
})();
