// node scripts/qa-approval-shot.js  (writes approval-<n>-<tool>.png into BOARDCLIP_QA_OUT or a fresh temp dir)
// Screenshot the AI-action approval modal in an isolated sandbox
// (scripts/lib/qa-sandbox.js, AI access on, flat groups with one retired nested
// name) and prove its wording and safety keys with real CDP key presses:
//   assign_group 'todo, forge'        -> says the clip becomes AI-readable; Enter
//                                         (after the buttons armed) DENIES
//   assign_group 'todo/claude-proxy'  -> explains the retired name; Ctrl+Enter
//                                         ALLOWS once, both groups land, and the
//                                         answer names neither (both private)
//   add_clip of the note's own text   -> asks (it would share a private clip); Esc DENIES
//   delete_clip                       -> Esc DENIES
//   edit_clip (replace)               -> Ctrl+Enter before the buttons arm does nothing,
//                                         Ctrl+Enter once armed ALLOWS once (the edit runs)
//   delete_group of a private group   -> asks, says how many clips; Esc DENIES
// Then the free paths, which must answer without any prompt: add_clip of new
// text, delete_group of a group that does not exist (a clear reason) and of the
// AI group (refused), assign_group / create_group of brand-new names AND of an
// existing private group (answered alike, echoing only what was typed: neither the
// answer nor a prompt tells the AI that the private group exists), and the
// boundary's refusals: the real
// (renderer) rev and a private clip's real id are not what an AI holds.
// Each request carries the id and rev an AI client holds (the lib/mcp-core
// boundary: aiRef), as a real MCP client's must (the app refuses a mutation
// without them before any prompt).
// The modal must never take focus: main shows it inactive, so the sandbox
// records no focus call while the prompts are up.
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const qa = require('./lib/qa-sandbox');
const mcpCore = require('../lib/mcp-core');

const OUT = process.env.BOARDCLIP_QA_OUT || fs.mkdtempSync(path.join(os.tmpdir(), 'bc-appr-shots-'));
const txt = (text, ts, pin) => ({ id: qa.txtId(text), type: 'text', text, ts, pin: pin || null });
const NOTE = 'impl new scoped accounts/api providers - API | Account scope keys\n\nclaude API fallback becomes api which you can setup a forwarded key for\n\nrotate keys per workspace';
const EDITED = `${NOTE}\n\nalso: audit key rotation`;
const SHARED = 'a short shared clip';
const FLATTENED_AT = 1788000000000;
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
const tagsOf = (item) => (item && item.pin && Array.isArray(item.pin.groups) ? item.pin.groups : []);

(async () => {
  const out = { ok: false, out: OUT, shots: [] };
  let sb = null;
  try {
    sb = await qa.launch({
      name: 'approval-shot',
      ai: true,
      settings: {
        groups: ['AI', 'todo', 'claude-proxy', 'forge'],
        groups_shared_with_ai: ['forge'],
        group_splits: [{ name: 'todo/claude-proxy', parts: ['todo', 'claude-proxy'], at: FLATTENED_AT }],
        groups_flattened_at: FLATTENED_AT,
        diagnostics_enabled: true,
        ai_approval_timeout_sec: 60,
        surface_style: 'solid',
      },
      history: [txt(NOTE, 1788000000, null), txt(SHARED, 1788000100, { groups: ['AI'] })],
    });
    // The id and rev an AI client holds for a clip (lib/mcp-core): keyed with the
    // sandbox app's own secret, a real id only while the clip is shared with AI.
    const boundary = { mcp_secret: (await sb.discovery()).secret, groups_shared_with_ai: sb.settings.groups_shared_with_ai };
    const aiRef = (item) => ({ id: mcpCore.publicId(item, boundary), expected_rev: mcpCore.publicRev(item, boundary) });
    // The note as it is now (its id and rev move with each allowed change).
    const note = async () => {
      const items = await sb.historyState();
      return items.find((i) => i.text === EDITED) || items.find((i) => i.text === NOTE);
    };
    const shared = async () => (await sb.historyState()).find((i) => i.text === SHARED);
    const first = await note();
    if (!first || !first.rev) throw new Error('seeded note or its rev missing');
    const focusCalls = async () => (await sb.events()).filter((e) => /focus_blocked/.test(e.type)).length;
    const focusBefore = await focusCalls();
    const onNote = (extra) => async () => ({ ...aiRef(await note()), ...extra });
    const onShared = (extra) => async () => ({ ...aiRef(await shared()), ...extra });
    const cases = [
      ['assign_group', onNote({ group: 'todo, forge' }), 'enter'],
      ['assign_group', onNote({ group: 'todo/claude-proxy' }), 'allow'],
      ['add_clip', async () => ({ text: NOTE, group: 'forge' }), 'escape'],
      ['delete_clip', onNote({}), 'escape'],
      ['edit_clip', onNote({ text: EDITED }), 'ctrl-enter'],
      ['delete_group', async () => ({ name: 'Claude-Proxy' }), 'escape'],
    ];
    for (const [tool, argsFor, decision] of cases) {
      const args = await argsFor();
      const step = { tool, args: { ...args, text: args.text ? `${args.text.length} chars` : undefined }, decision };
      let req = null;
      const modal = await sb.newPage(/mcp-approval\.html/, () => {
        req = sb.mcp(tool, args, { client: 'Claude (flat groups QA)', timeoutMs: 30000 }).then((value) => { step.value = value; return 'allowed'; }, (e) => e.message);
      }, { label: `approval modal for ${tool}`, timeoutMs: 10000, focus: true });
      await modal.waitFor(`document.getElementById('explain').textContent.length > 0`, 'modal rendered', 30000);
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
      step.file = path.join(OUT, `approval-${out.shots.length + 1}-${tool}.png`);
      await modal.screenshot(step.file);
      if (decision === 'enter') {
        // Enter denies even with the Allow button focused.
        await modal.eval(`(document.getElementById('allowOnce').focus(), true)`);
        await press(modal, 'Enter');
      } else if (decision === 'escape') await press(modal, 'Escape');
      else await press(modal, 'Enter', { ctrl: true });
      step.result = await req;
      const noteAfter = await note();
      step.tagsAfter = tagsOf(noteAfter);
      step.refAfter = aiRef(noteAfter);
      step.sharedTagsAfter = tagsOf(await shared());
      modal.close();
      out.shots.push(step);
      await qa.sleep(600);
    }
    // Free paths: answered at once, no prompt (a prompt would leave them pending).
    const free = async (tool, args) => Promise.race([
      sb.mcp(tool, args, { client: 'Claude (flat groups QA)', timeoutMs: 30000 }).catch((e) => ({ error: e.message, code: e.code, details: e.details })),
      qa.sleep(5000).then(() => 'pending'),
    ]);
    out.freeAdd = await free('add_clip', { text: 'a brand new clip for the AI', group: 'forge' });
    out.freeAddTags = tagsOf((await sb.historyState()).find((i) => i.text === 'a brand new clip for the AI'));
    out.freeDeleteMissing = await free('delete_group', { name: 'no such tag' });
    out.freeDeleteAi = await free('delete_group', { name: 'ai' });
    out.aiStillOnShared = tagsOf(await shared()).includes('AI');
    const sharedBefore = await shared();
    out.freeAssignNew = await free('assign_group', { ...aiRef(sharedBefore), group: 'Brand-New' });
    out.freeAssignNewTags = tagsOf(await shared());
    out.freeAssignNewRef = aiRef(await shared());
    out.freeCreateNew = await free('create_group', { name: 'another new' });
    out.freeCreateShared = await free('create_group', { name: 'FORGE' });
    // An existing private group ("todo") named by the AI: free, and answered exactly as a
    // brand-new name is.
    const sharedForPrivate = await shared();
    out.freeAssignPrivate = await free('assign_group', { ...aiRef(sharedForPrivate), group: 'TODO' });
    out.freeAssignPrivateTags = tagsOf(await shared());
    out.freeCreatePrivate = await free('create_group', { name: 'Todo' });
    out.freeAddPrivate = await free('add_clip', { text: 'filed into a private group', group: 'todo' });
    out.freeAddPrivateTags = tagsOf((await sb.historyState()).find((i) => i.text === 'filed into a private group'));
    // The boundary: the renderer's real rev and a private clip's real id are not what
    // an AI holds, so both are refused before any prompt (and say nothing private).
    const sharedNow = await shared();
    out.rawRev = await free('pin_clip', { id: sharedNow.id, expected_rev: sharedNow.rev });
    const noteNow = await note();
    out.realPrivateId = await free('pin_clip', { id: noteNow.id, expected_rev: aiRef(noteNow).expected_rev });
    out.editApplied = !!(await sb.historyState()).find((i) => i.text === EDITED);
    out.focusCallsWhilePrompting = (await focusCalls()) - focusBefore;
    out.decisions = sb.diagnostics().filter((d) => d.event === 'mcp.approval').map((d) => `${d.tool}:${d.decision}`);
    const [addFlat, addRetired, addExisting, del, edit, delTag] = out.shots;
    const has = (step, field, text) => String(step.state[field]).includes(text);
    const sameJson = (a, b) => JSON.stringify(a) === JSON.stringify(b);
    out.checks = {
      allShotsArmed: out.shots.length === cases.length && out.shots.every((s) => s.state.explain.length > 40 && s.state.armed && /wants BoardClip to:/.test(s.state.who) && s.state.buttons.join('|') === 'Deny|Allow once'),
      flatTitle: addFlat.state.title === 'Add clip to groups “todo” and “forge”',
      flatSaysVisible: has(addFlat, 'explain', 'will then be able to read this clip, because “forge” is shared with AI'),
      flatFact: addFlat.state.facts.includes('none → todo, forge'),
      flatDenied: /denied/i.test(String(addFlat.result)) && addFlat.tagsAfter.length === 0,
      retiredTitle: addRetired.state.title === 'Add clip to groups “todo” and “claude-proxy”',
      retiredExplained: has(addRetired, 'explain', '“todo/claude-proxy” is an old nested name for the groups “todo” and “claude-proxy”'),
      // Both groups are private: the answer echoes the typed name only, under the
      // clip's opaque handle and new keyed rev.
      retiredApplied: addRetired.result === 'allowed' && sameJson(addRetired.tagsAfter, ['todo', 'claude-proxy'])
        && sameJson(addRetired.value && addRetired.value.added, []) && sameJson(addRetired.value.removed, []) && sameJson(addRetired.value.groups, [])
        && sameJson(addRetired.value.notShared, ['todo/claude-proxy']) && addRetired.value.id === addRetired.refAfter.id
        && addRetired.value.id.startsWith('private:') && addRetired.value.rev === addRetired.refAfter.expected_rev,
      addExistingAsks: addExisting.state.title === 'Add an existing clip to group “forge”' && has(addExisting, 'why', 'cannot read now')
        && has(addExisting, 'explain', 'no new clip is made') && /denied/i.test(String(addExisting.result)) && !addExisting.tagsAfter.includes('forge'),
      freePrivateLikeNew: out.freeAssignPrivate && out.freeAssignPrivate.ok === true && sameJson(out.freeAssignPrivate.added, []) && sameJson(out.freeAssignPrivate.removed, [])
        && sameJson(out.freeAssignPrivate.groups, ['AI']) && sameJson(out.freeAssignPrivate.notShared, ['TODO']) && out.freeAssignPrivateTags.includes('todo')
        && sameJson(Object.keys(out.freeAssignPrivate).sort(), Object.keys(out.freeAssignNew).sort())
        && out.freeCreatePrivate && out.freeCreatePrivate.ok === true && sameJson(out.freeCreatePrivate.groups, []) && sameJson(out.freeCreatePrivate.notShared, ['Todo'])
        && out.freeAddPrivate && out.freeAddPrivate.ok === true && sameJson(out.freeAddPrivateTags, ['todo']),
      deleteClip: /denied/i.test(String(del.result)) && /\bdanger\b/.test(del.state.allowOnce) && /\bprimary\b/.test(addFlat.state.allowOnce),
      edit: edit.result === 'allowed' && edit.disabledAtOpen === true && edit.earlyIgnored === true && out.editApplied
        && edit.value.id === edit.refAfter.id && edit.value.id.startsWith('private:') && edit.value.rev === edit.refAfter.expected_rev,
      deleteTagAsks: delTag.state.title === 'Delete group “claude-proxy”' && has(delTag, 'explain', 'removed from 1 clip and from your filters. The clip stays in your history.')
        && has(delTag, 'why', 'not shared with AI') && /denied/i.test(String(delTag.result)) && delTag.tagsAfter.includes('claude-proxy'),
      // One word for the app's term in every prompt: group, never tag.
      groupWords: out.shots.every((s) => !/\btags?\b/i.test(`${s.state.title} ${s.state.explain} ${s.state.why} ${s.state.always}`)),
      // Grants are per tool, so each Always button names its own action.
      grantLabels: addFlat.state.always === "Always allow changing clips' groups" && delTag.state.always === 'Always allow deleting groups',
      freeAdd: out.freeAdd && out.freeAdd.ok === true && sameJson(out.freeAddTags, ['forge']),
      freeDeleteMissing: out.freeDeleteMissing && out.freeDeleteMissing.ok === false && /No group is named "no such tag"/.test(out.freeDeleteMissing.reason || ''),
      freeDeleteAiRefused: out.freeDeleteAi && out.freeDeleteAi.ok === false && /cannot be deleted/.test(out.freeDeleteAi.reason || '') && out.aiStillOnShared,
      freeAssignNew: out.freeAssignNew && out.freeAssignNew.ok === true && sameJson(out.freeAssignNew.added, []) && sameJson(out.freeAssignNew.removed, [])
        && sameJson(out.freeAssignNew.groups, ['AI']) && sameJson(out.freeAssignNew.notShared, ['Brand-New']) && sameJson(out.freeAssignNewTags, ['AI', 'Brand-New'])
        && out.freeAssignNew.id === sharedBefore.id && out.freeAssignNew.rev === out.freeAssignNewRef.expected_rev,
      freeCreate: out.freeCreateNew && out.freeCreateNew.ok === true && sameJson(out.freeCreateNew.groups, []) && sameJson(out.freeCreateNew.notShared, ['another new'])
        && out.freeCreateShared && out.freeCreateShared.ok === true && sameJson(out.freeCreateShared.groups, ['forge']) && !('notShared' in out.freeCreateShared),
      rawRevRefused: out.rawRev && out.rawRev.code === 'stale_revision' && out.rawRev.details && out.rawRev.details.currentRev === aiRef(sharedNow).expected_rev
        && out.rawRev.details.currentRev !== sharedNow.rev,
      realPrivateIdRefused: out.realPrivateId && out.realPrivateId.code === 'not_found' && sameJson(out.realPrivateId.details, { id: noteNow.id }),
      decisions: out.decisions.join(',') === 'assign_group:deny,assign_group:once,add_clip:deny,delete_clip:deny,edit_clip:once,delete_group:deny',
      noFocus: out.focusCallsWhilePrompting === 0,
    };
    out.ok = Object.values(out.checks).every(Boolean);
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
