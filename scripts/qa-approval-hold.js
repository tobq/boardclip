// node scripts/qa-approval-hold.js
// Sandbox proof for the approval prompt's hover pause + control-channel
// liveness, against the DEV checkout's code in an isolated instance
// (scripts/lib/qa-sandbox.js):
//  1. hover -> countdown shows "paused" and stays put past the 5 s timeout
//     (main's safety timer is held too, the modal stays open)
//  2. leave -> the countdown resumes and the request times out normally
//  3. the waiting client survives all of that on keepalive frames
//  4. a client that gives up (keepalive off, short timeout) makes the modal
//     close by itself: decision client_gone, nothing executed
'use strict';
const qa = require('./lib/qa-sandbox');

const item = { id: qa.txtId('hover pause proof clip\nsecond line'), type: 'text', text: 'hover pause proof clip\nsecond line', ts: 1788000000, pin: null };
const state = (page) => page.eval(`({ label: document.getElementById('countLabel').textContent, num: document.getElementById('countNum').textContent })`);

(async () => {
  const out = { ok: false, steps: {} };
  let sb = null;
  try {
    sb = await qa.launch({
      name: 'approval-hold',
      ai: true,
      settings: { groups: ['AI'], diagnostics_enabled: true, ai_approval_timeout_sec: 5, surface_style: 'solid' },
      history: [item],
    });
    const clip = (await sb.historyState()).find((i) => i.id === item.id);
    if (!clip || !clip.rev) throw new Error('seeded clip or its rev missing');
    const args = { id: clip.id, expected_rev: clip.rev };
    const focusCalls = async () => (await sb.events()).filter((e) => /focus_blocked/.test(e.type)).length;
    const focus0 = await focusCalls();
    const modalGone = (id) => qa.waitFor(async () => !(await sb.targets()).some((x) => x.id === id), 'modal closed', 10000).catch(() => false);
    // ---- 1-3: hover pause with a keepalive client ----
    const t0 = Date.now();
    let req = null;
    const modal = await sb.newPage(/mcp-approval\.html/, () => {
      req = sb.mcp('delete_clip', args, { client: 'hold proof', timeoutMs: 15000 }).then(() => 'unexpected success', (e) => e.message);
    }, { label: 'approval modal', timeoutMs: 10000 });
    await modal.waitFor(`document.getElementById('explain').textContent.length > 0`, 'modal rendered', 30000);
    await qa.sleep(300);
    out.steps.before = await state(modal);
    // Real pointer entering the page (fires mouseenter on <html>).
    await modal.mouse('mouseMoved', 200, 120);
    await qa.sleep(400);
    out.steps.hovered = await state(modal);
    await qa.sleep(8500); // well past the 5 s timeout (+3 s safety net)
    out.steps.stillOpenAfter8s = (await sb.targets()).some((x) => x.id === modal.id);
    out.steps.whileHeld = await state(modal);
    out.steps.clientStillWaiting = (await Promise.race([req, qa.sleep(10).then(() => 'waiting')])) === 'waiting';
    // Pointer leaves: real leave = mouseleave on <html>.
    await modal.eval(`(document.documentElement.dispatchEvent(new Event('mouseleave')), true)`);
    await qa.sleep(1600);
    out.steps.resumed = await state(modal);
    out.steps.resumedAtSec = Number(String(out.steps.resumed.num).replace('s', ''));
    modal.close();
    out.steps.result = await req;
    out.steps.totalMs = Date.now() - t0;
    await qa.sleep(500);
    // ---- 4: client gives up -> prompt closes itself ----
    let req2 = null;
    const modal2 = await sb.newPage(/mcp-approval\.html/, () => {
      req2 = sb.mcp('delete_clip', args, { client: 'hold proof', timeoutMs: 2000, keepalive: false }).then(() => 'unexpected success', (e) => e.message);
    }, { label: 'second approval modal', timeoutMs: 10000 });
    modal2.close();
    out.steps.clientGaveUp = await req2;
    const closedAt = Date.now();
    out.steps.modalClosedAfterClientGone = await modalGone(modal2.id);
    out.steps.closeLagMs = Date.now() - closedAt;
    await qa.sleep(800);
    out.steps.decisions = sb.diagnostics().filter((d) => d.event === 'mcp.approval').map((d) => d.decision);
    out.steps.clipStillThere = (await sb.historyState()).some((i) => i.id === item.id);
    // Shown inactive: main never called focus() for the prompts (the sandbox
    // records every focus call it blocks).
    out.steps.focusCalls = (await focusCalls()) - focus0;
    const s = out.steps;
    out.ok = /paused/i.test(s.hovered.label) && s.hovered.num === 'paused' && s.stillOpenAfter8s && s.whileHeld.num === 'paused' && s.clientStillWaiting
      && !/paused/i.test(s.resumed.label) && s.resumedAtSec >= 1 && s.resumedAtSec <= 5 && s.result === 'timed_out' && s.totalMs > 13000
      && s.clientGaveUp === 'control_timeout' && s.modalClosedAfterClientGone && s.decisions.includes('client_gone') && s.clipStillThere && s.focusCalls === 0;
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
