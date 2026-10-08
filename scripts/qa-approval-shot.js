// node scripts/qa-approval-shot.js  (writes approval-<tool>.png into BOARDCLIP_QA_OUT or a fresh temp dir)
// Screenshot the AI-action approval modal for three actions in an isolated
// sandbox (scripts/lib/qa-sandbox.js, AI access on) and prove its safety keys
// with real CDP key presses, one decision path per action:
//   assign_group (add)     -> Enter (after the buttons armed) DENIES
//   delete_clip            -> Esc DENIES
//   edit_clip (replace)    -> Ctrl+Enter before the buttons arm does nothing,
//                             Ctrl+Enter once armed ALLOWS once (the edit runs)
// Each request carries the clip's rev as `expected_rev`, as a real MCP
// client's must (the app refuses a mutation without it before any prompt).
// The modal must never take focus: main shows it inactive, so the sandbox
// records no focus call while the prompts are up.
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const qa = require('./lib/qa-sandbox');

const OUT = process.env.BOARDCLIP_QA_OUT || fs.mkdtempSync(path.join(os.tmpdir(), 'bc-appr-shots-'));
const txt = (text, ts, pin) => ({ id: qa.txtId(text), type: 'text', text, ts, pin: pin || null });
const NOTE = 'impl new scoped accounts/api providers - API | Account scope keys\n\nclaude API fallback becomes api which you can setup a forwarded key for\n\nrotate keys per workspace';
const EDITED = `${NOTE}\n\nalso: audit key rotation`;
const VK = { Enter: 13, Escape: 27 };
async function press(page, key, { ctrl = false } = {}) {
  const ev = { key, code: key, windowsVirtualKeyCode: VK[key], nativeVirtualKeyCode: VK[key], modifiers: ctrl ? 2 : 0 };
  // A decision closes the modal on keydown, so the page can be gone before CDP
  // even answers the keydown (seen intermittently): that is delivery, not a
  // failure - the decision itself is checked through the control request.
  try {
    await page.send('Input.dispatchKeyEvent', { type: 'rawKeyDown', ...ev });
  } catch (error) {
    if (/socket closed/i.test(String(error && error.message))) return;
    throw error;
  }
  try {
    if (key === 'Enter') await page.send('Input.dispatchKeyEvent', { type: 'char', text: '\r', ...ev });
    await page.send('Input.dispatchKeyEvent', { type: 'keyUp', ...ev });
  } catch {}
}

(async () => {
  const out = { ok: false, out: OUT, shots: [] };
  let sb = null;
  try {
    sb = await qa.launch({
      name: 'approval-shot',
      ai: true,
      settings: { groups: ['AI', 'todo/claude-proxy'], diagnostics_enabled: true, ai_approval_timeout_sec: 60, surface_style: 'solid' },
      history: [txt(NOTE, 1788000000, null), txt('a short shared clip', 1788000100, { groups: ['AI'] })],
    });
    const note = (await sb.historyState()).find((i) => i.text === NOTE);
    if (!note || !note.rev) throw new Error('seeded note or its rev missing');
    const focusCalls = async () => (await sb.events()).filter((e) => /focus_blocked/.test(e.type)).length;
    const focusBefore = await focusCalls();
    const cases = [
      ['assign_group', { id: note.id, expected_rev: note.rev, group: 'todo/claude-proxy' }, 'enter'],
      ['delete_clip', { id: note.id, expected_rev: note.rev }, 'escape'],
      ['edit_clip', { id: note.id, expected_rev: note.rev, text: EDITED }, 'ctrl-enter'],
    ];
    for (const [tool, args, decision] of cases) {
      let req = null;
      const modal = await sb.newPage(/mcp-approval\.html/, () => {
        req = sb.mcp(tool, args, { client: 'Claude (dedupe of pure duplicate clips)', timeoutMs: 30000 }).then(() => 'allowed', (e) => e.message);
      }, { label: `approval modal for ${tool}`, timeoutMs: 10000, focus: true });
      await modal.waitFor(`document.getElementById('explain').textContent.length > 0`, 'modal rendered', 30000);
      const step = { tool, decision };
      if (decision === 'ctrl-enter') {
        // Before the allow buttons arm: Ctrl+Enter and a click are ignored.
        step.disabledAtOpen = await modal.eval(`document.getElementById('allowOnce').disabled`);
        await press(modal, 'Enter', { ctrl: true });
        await qa.sleep(150);
        step.earlyIgnored = (await Promise.race([req, qa.sleep(50).then(() => 'pending')])) === 'pending';
      }
      await modal.fontsReady();
      await qa.sleep(900); // past the arming delay
      step.state = await modal.eval(`({
        who: document.getElementById('who').textContent, title: document.getElementById('title').textContent,
        explain: document.getElementById('explain').textContent, why: document.getElementById('why').textContent,
        facts: [...document.querySelectorAll('#facts dt, #facts dd')].map((e) => e.textContent), label: document.getElementById('detailLabel').textContent,
        always: document.getElementById('allowAlways').textContent, allowOnce: document.getElementById('allowOnce').className,
        armed: !document.getElementById('allowOnce').disabled, buttons: [...document.querySelectorAll('.acts button')].map((b) => b.textContent),
      })`);
      step.file = path.join(OUT, `approval-${tool}.png`);
      await modal.screenshot(step.file);
      if (decision === 'enter') {
        // Enter denies even with the Allow button focused.
        await modal.eval(`(document.getElementById('allowOnce').focus(), true)`);
        await press(modal, 'Enter');
      } else if (decision === 'escape') await press(modal, 'Escape');
      else await press(modal, 'Enter', { ctrl: true });
      step.result = await req;
      modal.close();
      out.shots.push(step);
      await qa.sleep(600);
    }
    const final = (await sb.historyState()).find((i) => i.text === EDITED);
    out.editApplied = !!final;
    out.focusCallsWhilePrompting = (await focusCalls()) - focusBefore;
    out.decisions = sb.diagnostics().filter((d) => d.event === 'mcp.approval').map((d) => `${d.tool}:${d.decision}`);
    const [add, del, edit] = out.shots;
    out.ok = out.shots.length === 3 && out.shots.every((s) => s.state.explain.length > 40 && s.state.armed && /wants BoardClip to:/.test(s.state.who) && s.state.buttons.join('|') === 'Deny|Allow once')
      && /denied/i.test(String(add.result)) && /denied/i.test(String(del.result)) && edit.result === 'allowed'
      && edit.disabledAtOpen === true && edit.earlyIgnored === true && out.editApplied
      && /\bdanger\b/.test(del.state.allowOnce) && /\bprimary\b/.test(add.state.allowOnce)
      && out.decisions.join(',') === 'assign_group:deny,delete_clip:deny,edit_clip:once'
      && out.focusCallsWhilePrompting === 0;
  } catch (e) {
    out.error = e.message;
  } finally {
    if (sb) {
      const cleanup = await sb.finish();
      if (!cleanup.ok) { out.ok = false; out.cleanup = cleanup.problems; }
    }
    console.log(JSON.stringify(out, null, 2));
    process.exit(out.ok ? 0 : 1);
  }
})();
