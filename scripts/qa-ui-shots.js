'use strict';

// Screenshots of every BoardClip surface (popup states, menus, dialogs,
// settings, editor, viewer, unify, conflict, approval prompt, website) from an
// isolated sandbox per theme (scripts/lib/qa-sandbox.js: cloaked windows, no
// focus, no page or window can reach the OS clipboard), for before/after
// comparisons of UI work.
//
// Usage: node scripts/qa-ui-shots.js [--theme dark|light|both] [--out <dir>]
//                                    [--only <substr>[,<substr>...]] [--serial]
// Writes <out>/<theme>/<shot>.png and prints a JSON summary on stdout
// (progress goes to stderr). Each STEP below is independent: it starts from a
// reset popup, and a step that throws is reported as skipped while the rest
// still run. Later work appends steps to STEPS.

const fs = require('fs');
const os = require('os');
const path = require('path');
const qa = require('./lib/qa-sandbox');

const argv = process.argv.slice(2);
const arg = (name, fallback) => { const i = argv.indexOf(`--${name}`); return i >= 0 && argv[i + 1] ? argv[i + 1] : fallback; };
const THEMES = ({ both: ['dark', 'light'], dark: ['dark'], light: ['light'] })[arg('theme', 'both')];
if (!THEMES) { console.error('--theme must be dark, light or both'); process.exit(2); }
const OUT_ARG = arg('out', '');
let OUT = ''; // created once the arguments are known to be valid
const ONLY = (arg('only', '') || '').split(',').map((s) => s.trim()).filter(Boolean);
const SERIAL = argv.includes('--serial');
const log = (...a) => console.error(...a);
const J = JSON.stringify;

// --- Seed: realistic clips, three images, a sync conflict, AI access ---------
function seed() {
  const now = Math.floor(Date.now() / 1000);
  const images = {};
  const img = (w, h, pixel, extra) => {
    const buf = qa.png(w, h, pixel);
    const file = qa.imageName(buf);
    images[file] = buf;
    return { type: 'image', image: file, width: w, height: h, ...extra };
  };
  const PLAN = 'Launch plan\n\n1. Freeze the release branch on Thursday\n2. Run the full QA pass on macOS and Windows\n3. Write the changelog and the blog post\n4. Ship to the beta channel first, then everyone on Monday\n\nOwner: release team. Risks: signing certs expire next month.';
  const texts = [
    { text: PLAN, title: 'Launch plan', pin: { groups: ['Work'], number: 1 }, ago: 120 },
    { text: 'https://example.com/docs/getting-started?ref=boardclip&utm_source=newsletter', ago: 300 },
    { text: '{\n  "name": "boardclip",\n  "version": "2.4.0",\n  "scripts": { "start": "electron .", "test": "node test/run.js" }\n}', title: 'package.json snippet', pin: { groups: ['Snippets'] }, ago: 900 },
    { text: 'The quick brown fox jumps over the lazy dog while the committee reviews the quarterly roadmap, the hiring plan and the long list of customer requests that arrived over the weekend.', ago: 1800 },
    { text: 'Thanks, see you tomorrow at 10!', pin: { groups: ['Personal'], number: 2 }, ago: 3600 },
    { text: 'hello@example.com', ago: 5400 },
    { text: 'SELECT id, email, last_seen\nFROM users\nWHERE last_seen > now() - interval \'7 days\'\nORDER BY last_seen DESC;', title: 'SQL: active users', pin: { groups: ['Snippets', 'Work/Clients'] }, ago: 7200 },
    { text: 'Meeting notes - design review\nAttendees: Sam, Alex, Priya\nDecisions: ship the new search panel, keep the slide-in buttons', title: 'Design review', html: '<b>Meeting notes</b> - design review<br>Attendees: Sam, Alex, Priya', pin: { groups: ['Work'] }, ago: 10800 },
    { text: 'npm run build && npm test', pin: { groups: ['Snippets'] }, ago: 14400 },
    { text: '42 Wallaby Way, Sydney', ago: 20000 },
  ];
  for (let i = 0; i < 18; i += 1) texts.push({ text: `Filler clip number ${i + 1} with a little text so the list scrolls`, ago: 30000 + i * 3000 });
  const history = texts.map((s) => ({
    id: qa.txtId(s.text), type: 'text', text: s.text, ts: now - s.ago,
    ...(s.title ? { title: s.title } : {}), ...(s.html ? { html: s.html } : {}), ...(s.pin ? { pin: { ...s.pin, updatedAt: Date.now() } } : {}),
  }));
  history.push(
    img(1600, 400, (x, y) => [40 + ((x * 180 / 1600) | 0), 90 + ((y * 100 / 400) | 0), 200], { ts: now - 600, title: 'Dashboard screenshot', pin: { groups: ['Work'] } }),
    img(300, 900, (x, y) => [220, 120 + ((y * 100 / 900) | 0), 60 + ((x * 120 / 300) | 0)], { ts: now - 2400 }),
    img(64, 64, (x, y) => (((x >> 3) + (y >> 3)) & 1 ? [230, 230, 230] : [60, 60, 60]), { ts: now - 4000 }),
  );
  history.sort((a, b) => b.ts - a.ts);
  const left = PLAN.replace('Thursday', 'Wednesday').replace('Monday', 'Tuesday');
  const right = `${PLAN.replace('blog post', 'release notes')}\n5. Tell support before the launch email goes out`;
  const conflicts = { version: 1, tombstones: [], records: [{
    id: 'conf:editor:qa1', kind: 'editor', targetId: qa.txtId(PLAN), createdAt: Date.now(), updatedAt: Date.now(),
    base: { id: qa.txtId(PLAN), title: 'Launch plan', text: PLAN },
    left: { id: qa.txtId(left), title: 'Launch plan', text: left },
    right: { id: qa.txtId(right), title: 'Launch plan (Mac)', text: right },
  }] };
  // Solid surface: a glass page is translucent, and a CDP screenshot has no OS
  // blur behind it.
  const settings = { groups: ['Work', 'Work/Clients', 'Personal', 'Snippets', 'AI'], groups_shared_with_ai: ['AI'], ai_approval_timeout_sec: 120, surface_style: 'solid' };
  return { history, images, conflicts, settings };
}

// --- Popup helpers (state shared by the popup steps) ---------------------------
const row = (id) => `.item[data-id=${J(id)}]`;
const menuItemCenter = (popup, re) => popup.eval(`(() => {
  const el = [...document.querySelectorAll('.bc-menu .bc-menu-item')].find((x) => ${re}.test(x.textContent));
  if (!el) return null;
  const r = el.getBoundingClientRect();
  return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
})()`);
async function resetPopup(c) {
  await c.popup.mouse('mouseMoved', -10, -10).catch(() => {});
  await c.popup.eval(`(() => {
    if (regexBtn.classList.contains('active')) regexBtn.click();
    window.resetPopupState();
    clearSearchAndFilters();
    controller.clearSelection();
    rerenderList();
    return true;
  })()`);
  await qa.sleep(150);
}
async function setQuery(c, q) {
  await c.popup.eval(`(() => {
    const s = document.getElementById('search');
    s.focus();
    s.value = ${J(q)};
    s.setSelectionRange(s.value.length, s.value.length);
    s.dispatchEvent(new Event('input', { bubbles: true }));
    rerenderList();
    return true;
  })()`);
  await qa.sleep(300);
}
const clickCancel = (page) => page.eval(`(() => {
  const b = [...document.querySelectorAll('.dialog button')].find((x) => /cancel/i.test(x.textContent));
  if (b) b.click(); else document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  return !!b;
})()`);
const openRowMenu = (c, id) => c.popup.eval(`(() => {
  const b = document.querySelector(${J(`${row(id)} [data-action="clip-menu"]`)});
  if (!b) throw new Error('no menu button on the row');
  b.click();
  return !!document.querySelector('.bc-menu');
})()`);
const editorMenu = (page) => page.eval(`(() => {
  const b = document.querySelector('.bc-editor-bar [data-action="clip-menu"], .bc-editor-bar button[title*="More"]');
  if (!b) throw new Error('no menu button in the bar');
  b.click();
  return true;
})()`);
const escape = (page) => page.eval(`document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))`).catch(() => {});

// Each step: { name, popup (reset the popup first), run(c) }.
const STEPS = [
  { name: 'popup-list', popup: true, run: (c) => c.shot(c.popup, 'popup-list') },
  { name: 'popup-row-hover', popup: true, run: async (c) => { await c.popup.hover(`${row(c.ids.json)} .content`); await c.shot(c.popup, 'popup-row-hover'); } },
  { name: 'popup-image-row-hover', popup: true, run: async (c) => { await c.popup.hover(`${row(c.ids.wide)} img`); await c.shot(c.popup, 'popup-image-row-hover'); } },
  { name: 'popup-numpad-picker', popup: true, run: async (c) => { await c.popup.hover(`${row(c.ids.plan)} .pin-area .star`); await c.shot(c.popup, 'popup-numpad-picker'); } },
  { name: 'popup-row-menu', popup: true, run: async (c) => {
    await openRowMenu(c, c.ids.plan);
    await c.shot(c.popup, 'popup-row-menu');
    for (const [re, name] of [['/group/i', 'popup-row-menu-group-sub'], ['/numpad/i', 'popup-row-menu-numpad-sub']]) {
      const at = await menuItemCenter(c.popup, re);
      if (!at) throw new Error(`no ${name} item in the row menu`);
      await c.popup.mouse('mouseMoved', at.x, at.y);
      await c.shot(c.popup, name);
    }
  } },
  { name: 'popup-filter-chip-sub', popup: true, run: async (c) => { await c.popup.hover('.group-filters .filter-tag[data-group="Work"]'); await c.shot(c.popup, 'popup-filter-chip-sub'); } },
  { name: 'popup-search-facet', popup: true, run: async (c) => { await setQuery(c, 'group:Work plan'); await c.shot(c.popup, 'popup-search-facet'); } },
  { name: 'popup-search-suggest', popup: true, run: async (c) => { await setQuery(c, 'is:'); await c.shot(c.popup, 'popup-search-suggest'); } },
  { name: 'popup-search-regex-invalid', popup: true, run: async (c) => {
    await c.popup.eval(`(regexBtn.click(), true)`);
    await setQuery(c, '[unclosed');
    await c.shot(c.popup, 'popup-search-regex-invalid');
  } },
  { name: 'popup-search-empty', popup: true, run: async (c) => { await setQuery(c, 'zzqx nothing matches this'); await c.shot(c.popup, 'popup-search-empty'); } },
  { name: 'popup-search-help', popup: true, run: async (c) => {
    await c.popup.eval(`(() => { const b = document.getElementById('searchHelpBtn'); if (!b) throw new Error('no #searchHelpBtn'); b.click(); return true; })()`);
    await c.shot(c.popup, 'popup-search-help');
    await escape(c.popup);
  } },
  { name: 'popup-multiselect', popup: true, run: async (c) => {
    await c.popup.eval(`(() => {
      const click = (id) => document.querySelector('.item[data-id="' + id + '"] .preview').dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, ctrlKey: true }));
      click(${J(c.ids.url)}); click(${J(c.ids.fox)});
      return document.querySelectorAll('.item.multi-selected').length;
    })()`);
    await c.shot(c.popup, 'popup-multiselect');
    const at = await c.popup.centerOf('.item.multi-selected .content');
    if (!at) throw new Error('no multi-selected row');
    await c.popup.eval(`document.querySelector('.item.multi-selected .content').dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: ${at.x}, clientY: ${at.y} }))`);
    await c.shot(c.popup, 'popup-bulk-menu');
  } },
  { name: 'popup-dialog-prompt', popup: true, run: async (c) => {
    await openRowMenu(c, c.ids.url);
    await c.popup.eval(`(() => { const it = document.querySelector('.bc-menu [data-action="rename"]'); if (!it) throw new Error('no rename item'); it.click(); return true; })()`);
    await c.shot(c.popup, 'popup-dialog-prompt');
    await clickCancel(c.popup);
  } },
  { name: 'popup-toast-undo', popup: true, run: async (c) => {
    await openRowMenu(c, c.ids.filler);
    await c.popup.eval(`(() => { const it = document.querySelector('.bc-menu [data-action="del"]'); if (!it) throw new Error('no delete item'); it.click(); return true; })()`);
    await c.shot(c.popup, 'popup-toast-undo');
    // Undo, so later steps (and --only runs) see the same history.
    await c.popup.eval(`(() => { const b = document.querySelector('.toast .toast-action'); if (b) b.click(); return !!b; })()`);
    await qa.sleep(300);
  } },
  { name: 'popup-settings', popup: true, run: async (c) => {
    await c.popup.eval(`(document.getElementById('settingsBtn').click(), true)`);
    await qa.sleep(300);
    const h = await c.popup.eval(`(() => { const b = document.querySelector('.settings-body'); return { sh: b.scrollHeight, ch: b.clientHeight }; })()`);
    for (let i = 0, y = 0; i < 8 && y < h.sh; i += 1, y += Math.max(200, h.ch - 40)) {
      await c.popup.eval(`document.querySelector('.settings-body').scrollTop = ${y}`);
      await c.shot(c.popup, `popup-settings-${i}`);
    }
    await c.popup.eval(`(() => { const b = document.getElementById('clearAll'); b.scrollIntoView(); b.click(); return true; })()`);
    await c.shot(c.popup, 'popup-dialog-confirm');
    await clickCancel(c.popup);
    await c.popup.eval(`(document.getElementById('settingsBack').click(), true)`);
  } },
  { name: 'editor', run: async (c) => {
    const ed = await c.sb.newPage(/editor\.html/, () => c.popup.eval(`window.api.openEditor(${J(c.ids.plan)}, {})`), { label: 'editor', focus: true });
    await ed.waitFor(`!!document.querySelector('textarea, .bc-editor')`, 'editor ready');
    await ed.fontsReady();
    await c.shot(ed, 'editor');
    // The bar's own find button, as a user opens it; a step that never shows
    // the bar must be reported as skipped, not shot as the plain editor.
    await ed.click('.bc-editor-bar [data-x="find"]');
    await ed.waitFor(`!document.querySelector('.bc-find').hidden`, 'find bar open', 5000);
    await ed.eval(`(() => { const f = document.querySelector('.bc-find-input'); f.value = 'the'; f.dispatchEvent(new Event('input', { bubbles: true })); return true; })()`);
    await ed.waitFor(`document.querySelectorAll('.bc-editor-hl mark').length > 0`, 'find matches highlighted', 5000);
    await c.shot(ed, 'editor-find');
    await escape(ed);
    await editorMenu(ed);
    await c.shot(ed, 'editor-menu');
    await escape(ed);
    await ed.eval(`(() => { const b = document.querySelector('.bc-tag-strip [data-action="tag-add"]'); if (!b) throw new Error('no tag-add button'); b.click(); return true; })()`);
    await c.shot(ed, 'editor-tag-picker');
  } },
  { name: 'viewer', run: async (c) => {
    const vw = await c.sb.newPage(/viewer\.html/, () => c.popup.eval(`window.api.openImage(${J(c.ids.wide)}, {})`), { label: 'viewer', focus: true });
    await vw.fontsReady();
    await qa.sleep(600);
    await c.shot(vw, 'viewer');
    await editorMenu(vw);
    await c.shot(vw, 'viewer-menu');
  } },
  { name: 'unify', run: async (c) => {
    const un = await c.sb.newPage(/editor\.html/, () => c.popup.eval(`window.api.startUnify([${J(c.ids.plan)}, ${J(c.ids.notes)}])`), { label: 'unify', focus: true });
    await un.waitFor(`!!document.querySelector('.CodeMirror-merge')`, 'merge mounted');
    await un.fontsReady();
    await qa.sleep(900);
    await c.shot(un, 'unify');
  } },
  { name: 'conflict', run: async (c) => {
    const cf = await c.sb.newPage(/editor\.html/, () => c.popup.eval(`window.api.openConflict('conf:editor:qa1')`), { label: 'conflict', focus: true });
    await cf.waitFor(`!!document.querySelector('.CodeMirror-merge, .bc-merge-host')`, 'conflict mounted');
    await cf.fontsReady();
    await qa.sleep(900);
    await c.shot(cf, 'conflict');
  } },
  { name: 'approval-modal', run: async (c) => {
    const sql = c.items.find((i) => i.title === 'SQL: active users');
    let req = null;
    const ap = await c.sb.newPage(/mcp-approval\.html/, () => {
      req = c.sb.mcp('delete_clip', { id: sql.id, expected_rev: sql.rev }, { client: 'Claude (UI audit)' }).then(() => 'unexpected success', (e) => e.message);
    }, { label: 'approval' });
    await ap.waitFor(`document.getElementById('explain').textContent.length > 0`, 'approval rendered');
    await ap.fontsReady();
    await qa.sleep(400);
    await c.shot(ap, 'approval-modal');
    await ap.eval(`(document.getElementById('deny').click(), true)`);
    const result = await req;
    if (!/denied/.test(result)) throw new Error(`approval request ended with ${result}`);
  } },
  { name: 'site', run: async (c) => {
    const page = await c.sb.openWindow(c.site.url, { theme: c.theme });
    await page.send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 900, deviceScaleFactor: 1, mobile: false });
    await page.send('Page.reload', { ignoreCache: true }); // theme media + metrics in place before the page's own scripts run
    await page.waitFor(`document.readyState === 'complete' && !!document.querySelector('.bc-popup')`, 'site loaded');
    await page.fontsReady();
    await qa.sleep(1500);
    await c.fullPage(page, 'site', 1280);
    await page.send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 1, mobile: true });
    await qa.sleep(800);
    await c.fullPage(page, 'site-mobile', 390);
  } },
];

// --- One theme: launch, run every selected step, kill ---------------------------
async function runTheme(theme, site) {
  const outDir = path.join(OUT, theme);
  fs.mkdirSync(outDir, { recursive: true });
  const result = { theme, shots: [], skipped: [], ms: {} };
  const t0 = Date.now();
  const c = { theme, site, outDir };
  c.shot = async (page, name, opts) => {
    await qa.sleep(250);
    await page.screenshot(path.join(outDir, `${name}.png`), opts);
    result.shots.push(name);
  };
  c.fullPage = async (page, name, width) => {
    const height = await page.eval('Math.min(document.documentElement.scrollHeight, 16000)');
    await c.shot(page, name, { captureBeyondViewport: true, clip: { x: 0, y: 0, width, height, scale: 1 } });
  };
  let sb = null;
  try {
    sb = await qa.launch({ name: `shots-${theme}`, theme, ai: true, ...seed() });
    c.sb = sb;
    result.ms.launch = Date.now() - t0;
    c.popup = await sb.openPopup({ focus: true });
    await c.popup.waitFor(`!!(window.api && document.querySelectorAll('.item').length >= 8)`, 'popup rows');
    await c.popup.fontsReady();
    c.items = await sb.historyState();
    const by = (pred) => { const it = c.items.find(pred); if (!it) throw new Error('seeded clip missing'); return it.id; };
    c.ids = {
      plan: by((i) => i.title === 'Launch plan'), json: by((i) => i.title === 'package.json snippet'), notes: by((i) => i.title === 'Design review'),
      wide: by((i) => i.title === 'Dashboard screenshot'), url: by((i) => /^https:\/\/example\.com/.test(i.text || '')),
      fox: by((i) => /^The quick brown fox/.test(i.text || '')), filler: by((i) => i.text === 'Filler clip number 1 with a little text so the list scrolls'),
    };
    result.ms.setup = Date.now() - t0 - result.ms.launch;
    for (const step of SELECTED) {
      const started = Date.now();
      try {
        if (step.popup) await resetPopup(c);
        await step.run(c);
      } catch (error) {
        result.skipped.push({ step: step.name, reason: String(error.message).slice(0, 240) });
        log(`[${theme}] SKIP ${step.name}: ${String(error.message).slice(0, 160)}`);
      }
      result.ms[step.name] = Date.now() - started;
    }
    const blocked = (await sb.events()).filter((e) => /paste|drag|foreground|dialog|open_|notification|clipboard_(key|api|permission)/.test(e.type));
    if (blocked.length) result.blocked = blocked.map((e) => e.type);
  } catch (error) {
    result.error = String(error.stack || error.message).slice(0, 600);
  } finally {
    if (sb) {
      const cleanup = await sb.finish();
      if (!cleanup.ok) result.cleanup = cleanup.problems;
    }
  }
  log(`[${theme}] ${result.shots.length} shots, ${result.skipped.length} skipped${result.error ? `, FAILED: ${result.error.split('\n')[0]}` : ''}`);
  return result;
}

const SELECTED = STEPS.filter((step) => !ONLY.length || ONLY.some((o) => step.name.includes(o)));
if (!SELECTED.length) { console.error(`--only matched no step; steps: ${STEPS.map((step) => step.name).join(', ')}`); process.exit(2); }

(async () => {
  const t0 = Date.now();
  OUT = path.resolve(OUT_ARG || fs.mkdtempSync(path.join(os.tmpdir(), 'bc-ui-shots-')));
  const site = await qa.startStaticServer(path.join(qa.ROOT, 'site'));
  let results;
  try {
    results = SERIAL
      ? await THEMES.reduce(async (acc, theme) => [...(await acc), await runTheme(theme, site)], Promise.resolve([]))
      : await Promise.all(THEMES.map((theme) => runTheme(theme, site)));
  } finally {
    await site.close();
  }
  const ok = results.every((r) => !r.error && r.skipped.length === 0 && !r.cleanup);
  const summary = { ok, out: OUT, ms: Date.now() - t0, themes: Object.fromEntries(results.map((r) => [r.theme, r])) };
  console.log(JSON.stringify(summary, null, 2));
  process.exit(ok ? 0 : 1);
})().catch((error) => { console.error('qa-ui-shots error:', error.stack || error.message); process.exit(1); });
