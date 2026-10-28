// node scripts/qa-approval-review.js  (writes review-*.png into BOARDCLIP_QA_OUT or a fresh temp dir)
// An AI's edit_clip prompt shows the edit as a diff to review (the shared merge
// view, embedded) instead of the bare new text. Proven in an isolated sandbox
// (scripts/lib/qa-sandbox.js, AI access on) with real CDP clicks and keys:
//   shared clip, 3 changes   -> opens unified ("3 changes", one block per change);
//                               the layout flips to side by side and back; the
//                               expand grows the window and gives it back; taking
//                               one change back says "3 changes, 1 rejected",
//                               relabels Allow to "Allow edited" and pauses the
//                               countdown; allowing writes the person's version and
//                               the AI is told (editedByUser + the final text)
//   private clip              -> the same, but the answer carries no text (the
//                               kept parts of the old text are not the AI's to read)
//   unedited allow (CRLF)     -> the proposal is written byte for byte, no
//                               editedByUser; Esc inside the editor only leaves it
//   Enter inside the editor   -> a new line (an edit), never an answer; Deny denies
//   append                    -> the review's result is the clip plus the appended
//                               text (mcpExecute's own join)
// Screenshots: compact unified + side by side + expanded (dark) and compact
// unified (light).
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const qa = require('./lib/qa-sandbox');

const OUT = process.env.BOARDCLIP_QA_OUT || fs.mkdtempSync(path.join(os.tmpdir(), 'bc-review-shots-'));
const txt = (text, ts, pin) => ({ id: qa.txtId(text), type: 'text', text, ts, pin: pin || null });
const SHARED = 'Launch checklist\r\n\r\n- write the post\r\n- record the demo\r\n- book the call\r\n\r\nShip on Friday';
const PROPOSAL = 'Launch checklist\n\n- write the launch post\n- record the demo\n- email the list\n\nShip on Thursday';
const SHARED_FINAL = 'Launch checklist\n\n- write the post\n- record the demo\n- email the list\n\nShip on Thursday';
const PRIVATE = 'draft terms\nfee 10%\nsigned by both\nterm 12 months';
const PRIVATE_PROPOSAL = 'draft terms\nfee 8%\nsigned by both\nterm 24 months';
const PRIVATE_FINAL = 'draft terms\nfee 8%\nsigned by both\nterm 12 months';
const CRLF = 'standup notes\r\nship the fix\r\ncall at 3';
const CRLF_PROPOSAL = 'standup notes\r\nship the fix today\r\ncall at 3';
const APPEND_BASE = 'reading list\n- the mythical man-month';
const APPEND_TEXT = '- a philosophy of software design';
const ENTER = 'enter test\nline two';
const VK = { Enter: 13, Escape: 27 };

async function press(page, key, { ctrl = false } = {}) {
  const ev = { key, code: key, windowsVirtualKeyCode: VK[key], nativeVirtualKeyCode: VK[key], modifiers: ctrl ? 2 : 0 };
  try { await page.send('Input.dispatchKeyEvent', { type: 'rawKeyDown', ...ev }); } catch (error) {
    if (/socket closed/i.test(String(error && error.message))) return;
    throw error;
  }
  try {
    if (key === 'Enter') await page.send('Input.dispatchKeyEvent', { type: 'char', text: '\r', ...ev });
    await page.send('Input.dispatchKeyEvent', { type: 'keyUp', ...ev });
  } catch {}
}
// A decision closes the window on click, so CDP can lose the page mid-click.
async function clickClosing(page, selector) {
  try { await page.click(selector); } catch (error) {
    if (!/socket closed|Target closed/i.test(String(error && error.message))) throw error;
  }
}
const pending = (req) => Promise.race([req.then(() => 'settled', () => 'settled'), qa.sleep(60).then(() => 'pending')]);

(async () => {
  const out = { ok: false, out: OUT, shots: [], steps: {} };
  let sb = null;
  try {
    sb = await qa.launch({
      name: 'approval-review',
      ai: true,
      settings: {
        groups: ['AI', 'lawyer notes'],
        groups_shared_with_ai: [],
        diagnostics_enabled: true,
        ai_approval_timeout_sec: 60,
        surface_style: 'solid',
        theme_mode: 'dark',
      },
      history: [
        txt(SHARED, 1788000000, { groups: ['AI'] }),
        txt(PRIVATE, 1788000100, { groups: ['lawyer notes'] }),
        txt(CRLF, 1788000200, { groups: ['AI'] }),
        txt(APPEND_BASE, 1788000300, { groups: ['AI'] }),
        txt(ENTER, 1788000400, { groups: ['AI'] }),
      ],
    });
    const items = () => sb.historyState();
    const byText = async (text) => (await items()).find((i) => i.text === text);
    const approvalBounds = () => sb.mainEval(`(() => { const w = __qa.electron.BrowserWindow.getAllWindows().find((x) => /mcp-approval/.test(x.webContents.getURL())); return w ? w.getBounds() : null; })()`);
    // Opens the edit's prompt; resolves the page once its review is drawn.
    async function openEdit(text, args, label) {
      let req = null;
      const ref = await sb.aiRef(await byText(text));
      const modal = await sb.newPage(/mcp-approval\.html/, () => {
        req = sb.mcp('edit_clip', { ...ref, ...args }, { client: 'Claude (review QA)', timeoutMs: 60000 });
        req.catch(() => {});
      }, { label: `edit prompt: ${label}`, timeoutMs: 10000, focus: true, theme: 'dark' });
      await modal.waitFor(`!!document.querySelector('#review:not([hidden]) .CodeMirror')`, 'review drawn', 30000);
      await modal.fontsReady();
      await qa.sleep(900); // past the arming delay; the diff has settled
      return { modal, req: () => req };
    }
    const state = (modal) => modal.eval(`({
      layout: document.querySelector('.bc-reconcile') && document.querySelector('.bc-reconcile').dataset.layout,
      blocks: document.querySelectorAll('.bc-u-block').length,
      rows: [...document.querySelectorAll('.bc-u-block')].map((b) => b.querySelectorAll('.bc-u-row').length),
      keeps: document.querySelectorAll('.bc-u-block [data-u="keep"]').length,
      headsShown: !!document.querySelector('.bc-merge-heads') && getComputedStyle(document.querySelector('.bc-merge-heads')).display !== 'none',
      count: (document.querySelector('[data-x="chgcount"]') || {}).textContent || '',
      allow: document.getElementById('allowOnce').textContent,
      armed: !document.getElementById('allowOnce').disabled,
      countLabel: document.getElementById('countLabel').textContent,
      detailShown: document.getElementById('detailCard').style.display !== 'none',
      title: document.getElementById('title').textContent,
      value: reviewView ? reviewView.getValue().text : null,
      expanded: document.body.classList.contains('expanded'),
      explainShown: getComputedStyle(document.getElementById('explain')).display !== 'none',
    })`);
    const shot = async (modal, name) => {
      const file = path.join(OUT, `review-${out.shots.length + 1}-${name}.png`);
      await modal.screenshot(file);
      out.shots.push(file);
    };

    // 1) Shared clip, three changes: views, expand, take one back, allow.
    {
      const { modal, req } = await openEdit(SHARED, { text: PROPOSAL }, 'shared');
      const s = { open: await state(modal) };
      await shot(modal, 'unified-dark');
      await modal.click('[data-layout="split"]');
      await qa.sleep(300);
      s.split = await state(modal);
      await shot(modal, 'split-dark');
      await modal.click('[data-layout="unified"]');
      await qa.sleep(300);
      s.unifiedAgain = await state(modal);
      s.compactBounds = await approvalBounds();
      await modal.click('[data-x="expand"]');
      await qa.sleep(500);
      s.expandedBounds = await approvalBounds();
      s.expanded = await state(modal);
      await shot(modal, 'expanded-dark');
      await modal.click('[data-x="expand"]');
      await qa.sleep(500);
      s.restoredBounds = await approvalBounds();
      s.collapsed = await state(modal);
      // The theme is the app's setting (the prompt follows it live).
      const popup = await sb.popup();
      await popup.eval("window.api.saveSettings({ theme_mode: 'light' })");
      await modal.waitFor("document.documentElement.dataset.theme === 'light'", 'prompt turned light', 10000);
      await qa.sleep(250);
      await shot(modal, 'unified-light');
      await popup.eval("window.api.saveSettings({ theme_mode: 'dark' })");
      await modal.waitFor("document.documentElement.dataset.theme === 'dark'", 'prompt dark again', 10000);
      await modal.click('.bc-u-block [data-u="take"]');
      await qa.sleep(400);
      s.rejected = await state(modal);
      await shot(modal, 'rejected-dark');
      await clickClosing(modal, '#allowOnce');
      s.result = await req().catch((e) => ({ error: e.message }));
      s.clipText = ((await byText(SHARED_FINAL)) || {}).text || null;
      s.oldGone = !(await byText(SHARED));
      modal.close();
      out.steps.shared = s;
    }
    // 2) Private clip: the person's version is written, its text never returned.
    {
      const { modal, req } = await openEdit(PRIVATE, { text: PRIVATE_PROPOSAL }, 'private');
      const s = { open: await state(modal) };
      // The second change (term) back to the clip's text.
      await modal.eval(`(document.querySelectorAll('.bc-u-block [data-u="take"]')[1].click(), true)`);
      await qa.sleep(400);
      s.rejected = await state(modal);
      await clickClosing(modal, '#allowOnce');
      s.result = await req().catch((e) => ({ error: e.message }));
      s.clipText = ((await byText(PRIVATE_FINAL)) || {}).text || null;
      modal.close();
      out.steps.private = s;
    }
    // 3) Unedited allow: the proposal byte for byte; Esc inside the editor only leaves it.
    {
      const { modal, req } = await openEdit(CRLF, { text: CRLF_PROPOSAL }, 'crlf');
      const s = { open: await state(modal) };
      await modal.click('.CodeMirror-code');
      await qa.sleep(100);
      s.focusedEditor = await modal.eval(`!!document.activeElement.closest('.CodeMirror')`);
      await press(modal, 'Escape');
      await qa.sleep(150);
      s.afterEsc = await pending(req());
      s.leftEditor = await modal.eval(`!document.activeElement.closest('.CodeMirror')`);
      await press(modal, 'Enter', { ctrl: true });
      s.result = await req().catch((e) => ({ error: e.message }));
      s.exact = !!(await byText(CRLF_PROPOSAL));
      modal.close();
      out.steps.crlf = s;
    }
    // 4) Enter inside the editor is a new line, never an answer; Deny denies.
    {
      const { modal, req } = await openEdit(ENTER, { text: 'enter test\nline 2' }, 'enter');
      const s = { open: await state(modal) };
      await modal.click('.CodeMirror-code');
      await modal.eval(`(reviewView && document.querySelector('.CodeMirror').CodeMirror && document.querySelector('.CodeMirror').CodeMirror.setCursor({ line: 0, ch: 10 }), true)`);
      await press(modal, 'Enter');
      await qa.sleep(250);
      s.afterEnter = await pending(req());
      s.edited = await state(modal);
      await clickClosing(modal, '#deny');
      s.result = await req().then((v) => v, (e) => e.message);
      s.unchanged = !!(await byText(ENTER));
      modal.close();
      out.steps.enter = s;
    }
    // 5) Append: the result is the clip plus the appended text.
    {
      const { modal, req } = await openEdit(APPEND_BASE, { text: APPEND_TEXT, append: true }, 'append');
      const s = { open: await state(modal) };
      await press(modal, 'Enter', { ctrl: true });
      s.result = await req().catch((e) => ({ error: e.message }));
      s.applied = !!(await byText(`${APPEND_BASE}\n${APPEND_TEXT}`));
      modal.close();
      out.steps.append = s;
    }

    out.decisions = sb.diagnostics().filter((d) => d.event === 'mcp.approval').map((d) => `${d.decision}${d.reviewed ? '+reviewed' : ''}`);
    const { shared: a, private: b, crlf: c, enter: d, append: e } = out.steps;
    const grew = (x, y) => x && y && y.width > x.width && y.height > x.height;
    const same = (x, y) => x && y && x.width === y.width && x.height === y.height && x.x === y.x && x.y === y.y;
    out.checks = {
      opensUnified: a.open.layout === 'unified' && a.open.blocks === 3 && a.open.rows.join() === '1,1,1' && a.open.keeps === 3 && !a.open.headsShown && a.split.headsShown && a.open.count.trim() === '3 changes' && !a.open.detailShown && a.open.armed,
      proposalInResult: a.open.value === PROPOSAL,
      flipsSplit: a.split.layout === 'split' && a.split.blocks === 0 && a.unifiedAgain.layout === 'unified' && a.unifiedAgain.blocks === 3,
      expands: grew(a.compactBounds, a.expandedBounds) && a.expanded.expanded && !a.expanded.explainShown,
      collapses: same(a.compactBounds, a.restoredBounds) && !a.collapsed.expanded && a.collapsed.explainShown,
      takeBack: a.rejected.count.trim() === '3 changes, 1 rejected' && a.rejected.allow === 'Allow edited' && a.rejected.blocks === 2
        && a.rejected.countLabel === 'Paused while you review your changes' && a.rejected.value === SHARED_FINAL,
      sharedWritten: a.clipText === SHARED_FINAL && a.oldGone,
      sharedAnswer: !!a.result && a.result.editedByUser === true && a.result.text === SHARED_FINAL,
      privateWritten: b.open.blocks === 2 && b.rejected.allow === 'Allow edited' && b.clipText === PRIVATE_FINAL,
      privateAnswerHasNoText: !!b.result && b.result.editedByUser === true && !('text' in b.result) && /not returned/.test(b.result.note || ''),
      escLeavesEditor: c.focusedEditor && c.afterEsc === 'pending' && c.leftEditor,
      uneditedExact: c.open.allow === 'Allow once' && c.exact && !!c.result && !c.result.error && !('editedByUser' in c.result),
      enterIsNewline: d.afterEnter === 'pending' && d.edited.allow === 'Allow edited' && /denied/i.test(String(d.result)) && d.unchanged,
      appendReview: e.open.value === `${APPEND_BASE}\n${APPEND_TEXT}` && e.open.blocks === 1 && e.applied && !('editedByUser' in (e.result || {})),
      decisions: out.decisions.join(',') === 'once+reviewed,once+reviewed,once,deny,once',
    };
    out.ok = Object.values(out.checks).every(Boolean);
  } catch (err) {
    out.error = err.stack || err.message;
  } finally {
    if (sb) {
      const cleanup = await sb.finish();
      if (!cleanup.ok) { out.ok = false; out.cleanup = cleanup.problems; }
    }
    console.log(JSON.stringify(out, null, 2));
    process.exit(out.ok ? 0 : 1);
  }
})();
