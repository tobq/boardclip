// node scripts/qa-approval-shot.js  (writes approval-<tool>.png into BOARDCLIP_QA_OUT or a fresh temp dir)
// Screenshot the redesigned AI-action approval modal for three actions in an
// isolated sandbox (scripts/lib/qa-sandbox.js, AI access on): assign_group
// (add), delete_clip, edit_clip (replace). Each request carries the clip's rev
// as `expected_rev`, as a real MCP client's must (the app refuses a mutation
// without it before any prompt), and each prompt is denied.
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const qa = require('./lib/qa-sandbox');

const OUT = process.env.BOARDCLIP_QA_OUT || fs.mkdtempSync(path.join(os.tmpdir(), 'bc-appr-shots-'));
const txt = (text, ts, pin) => ({ id: qa.txtId(text), type: 'text', text, ts, pin: pin || null });
const NOTE = 'impl new scoped accounts/api providers - API | Account scope keys\n\nclaude API fallback becomes api which you can setup a forwarded key for\n\nrotate keys per workspace';

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
    const cases = [
      ['assign_group', { id: note.id, expected_rev: note.rev, group: 'todo/claude-proxy' }],
      ['delete_clip', { id: note.id, expected_rev: note.rev }],
      ['edit_clip', { id: note.id, expected_rev: note.rev, text: `${NOTE}\n\nalso: audit key rotation` }],
    ];
    for (const [tool, args] of cases) {
      let req = null;
      const modal = await sb.newPage(/mcp-approval\.html/, () => {
        req = sb.mcp(tool, args, { client: 'Claude (dedupe of pure duplicate clips)', timeoutMs: 30000 }).then(() => 'unexpected success', (e) => e.message);
      }, { label: `approval modal for ${tool}`, timeoutMs: 10000 });
      // Filled on load, which the Google Fonts stylesheet can hold for seconds.
      await modal.waitFor(`document.getElementById('explain').textContent.length > 0`, 'modal rendered', 30000);
      await modal.fontsReady();
      await qa.sleep(500);
      const state = await modal.eval(`({ title: document.getElementById('title').textContent, explain: document.getElementById('explain').textContent, why: document.getElementById('why').textContent, facts: [...document.querySelectorAll('#facts dt, #facts dd')].map(e => e.textContent), label: document.getElementById('detailLabel').textContent, hint: document.getElementById('hint').textContent })`);
      const file = path.join(OUT, `approval-${tool}.png`);
      await modal.screenshot(file);
      await modal.eval(`(document.getElementById('deny').click(), true)`);
      modal.close();
      out.shots.push({ tool, file, state, result: await req });
      await qa.sleep(600);
    }
    out.ok = out.shots.length === 3 && out.shots.every((s) => /denied/i.test(String(s.result)) && s.state.explain.length > 40);
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
