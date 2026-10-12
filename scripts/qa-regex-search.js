'use strict';

// Sandbox QA: a /regex/ never freezes the popup or the editor (12 Oct 2026:
// y.*t.*b.*\?.*t= backtracked for minutes on a 20,000-char line and the popup
// stayed dead until its renderer was killed). Against the REAL popup and
// editor renderers of a throwaway instance (scripts/lib/qa-sandbox.js: temp
// data, cloaked windows, no system clipboard): the owner's two patterns are
// typed one character at a time over clips with long lines, and the page must
// answer between keystrokes, show "Searching...", find a real match, keep
// working after the search is cleared, and leave no worker spinning.
//
// Usage: node scripts/qa-regex-search.js

const qa = require('./lib/qa-sandbox');

const checks = qa.createChecks();
const check = (ok, name) => checks.check(name, ok);
const sleep = qa.sleep;

const LONG = ('ytb ' + 'x'.repeat(30) + ' ').repeat(560); // ~20,000 chars, one line
const URL_CLIP = 'theo stream https://www.youtube.com/live/kt_qa?si=abc&t=5137';

async function main() {
  const now = Math.floor(Date.now() / 1000);
  const history = [];
  for (let i = 0; i < 300; i += 1) history.push({ type: 'text', text: `qa clip ${i} lorem ipsum`, ts: now - 600 - i * 60 });
  for (let i = 0; i < 6; i += 1) history.push({ type: 'text', text: `long line ${i}\n${LONG}`, ts: now - 300 - i * 10 });
  history.push({ type: 'text', text: URL_CLIP, ts: now - 100 });
  history.sort((a, b) => b.ts - a.ts);
  const sb = await qa.launch({ name: 'regex', history, settings: { max_age_days: 365 } });
  console.log(`sandbox data: ${sb.dataDir}`);
  try {
    const popup = await sb.openPopup();
    await popup.waitFor(`typeof clipList !== 'undefined' && clipList.ids().length === ${history.length}`, 'popup rendered seeded clips');
    const setQuery = (q) => popup.eval(`(searchBox.setQuery(${JSON.stringify(q)}), query = ${JSON.stringify(q)}, rerenderList(), true)`);
    // How long the page takes to answer a trivial eval: a blocked thread shows here.
    const ping = async () => { const t = Date.now(); await popup.eval('1'); return Date.now() - t; };

    // 1. The owner's first pattern, typed key by key. No step may block.
    const typed = '/y.*t.*b.*\\?.*t\\=/';
    let worst = 0;
    for (let n = 2; n <= typed.length; n += 1) {
      const q = typed.slice(0, n - 1) + (n < typed.length ? '/' : '');
      const t = Date.now();
      await setQuery(n < typed.length ? q : typed);
      worst = Math.max(worst, Date.now() - t, await ping());
      await sleep(40);
    }
    check(worst < 400, `typing ${typed} key by key never blocks the popup (worst ${worst} ms)`);
    await sleep(600);
    const pings = [];
    for (let k = 0; k < 10; k += 1) { pings.push(await ping()); await sleep(100); }
    check(Math.max(...pings) < 200, `the popup answers while the pattern runs (pings ${pings.join(',')} ms)`);
    const state = await popup.eval(`({ busy: searchWorker.busy(), count: document.getElementById('count').textContent, dim: document.getElementById('list').classList.contains('searching') })`);
    check(state.busy && state.count === 'Searching...' && state.dim, `a slow search says so: ${JSON.stringify(state)}`);

    // 2. Clearing the search brings every clip back at once, and the stuck
    // worker is ended (its renderer stops burning CPU).
    await setQuery('');
    const back = await popup.eval(`({ n: clipList.ids().length, busy: searchWorker.busy(), count: document.getElementById('count').textContent })`);
    check(back.n === history.length && !back.busy, `clearing shows every clip again: ${JSON.stringify(back)}`);
    await sleep(1500);
    const pid = await popup.eval('0').then(() => sb.mainEval(`__qa.electron.BrowserWindow.getAllWindows().find((w) => /index\\.html/.test(w.webContents.getURL())).webContents.getOSProcessId()`));
    await sb.mainEval('(__qa.electron.app.getAppMetrics(), true)');
    await sleep(1000);
    const cpu = await sb.mainEval(`(__qa.electron.app.getAppMetrics().find((m) => m.pid === ${pid}) || { cpu: {} }).cpu.percentCPUUsage`);
    check(cpu < 25, `no worker left spinning after the search is cleared (renderer CPU ${Math.round(cpu)}%)`);

    // 3. The second pattern from the owner's report (caret moved to the front, y typed).
    await setQuery('/?.*t\\=/');
    await setQuery('/y?.*t\\=/');
    const ping2 = await ping();
    check(ping2 < 200, `/y?.*t\\=/ does not block the popup (${ping2} ms)`);
    await popup.waitFor(`!searchWorker.busy() && shownQuery === ${JSON.stringify('/y?.*t\\=/')}`, 'second pattern answered', 60000);
    const second = await popup.eval(`clipList.ids().length`);
    check(second === 1, `/y?.*t\\=/ finds the one clip with t= (${second})`);

    // 4. A pattern that matches: the right row, its preview window at the match, highlighted.
    await setQuery('/youtube.*t=\\d+/');
    await popup.waitFor(`!searchWorker.busy() && shownQuery === ${JSON.stringify('/youtube.*t=\\d+/')}`, 'match answered', 20000);
    const hit = await popup.eval(`(() => { const row = document.querySelector('#list > [data-id]'); return { n: clipList.ids().length, mark: row && row.querySelector('mark') ? row.querySelector('mark').textContent : null }; })()`);
    check(hit.n === 1 && /youtube/.test(hit.mark || ''), `the match is found and highlighted: ${JSON.stringify(hit)}`);

    // 5. An invalid regex, then plain words: the ordinary path, at once.
    await setQuery('/y(/');
    await setQuery('qa clip 12');
    const words = await popup.eval(`({ n: clipList.ids().length, busy: searchWorker.busy() })`);
    check(words.n > 0 && !words.busy, `plain words still search in place: ${JSON.stringify(words)}`);
    await setQuery('');

    // 6. The editor's find bar: the same pattern over a long-line note.
    const longId = await popup.eval(`items.find((it) => (it.text || '').startsWith('long line 0')).id`);
    const ed = await sb.newPage(/editor\.html/, () => popup.eval(`window.api.openEditor(${JSON.stringify(longId)})`), { label: 'editor' });
    await ed.waitFor(`!!document.querySelector('.bc-find-input')`, 'editor ready', 15000);
    await ed.eval(`(document.querySelector('textarea').focus(), true)`);
    await ed.click('.bc-bar [data-x="find"]');
    await ed.waitFor(`!document.querySelector('.bc-find').hidden`, 'find bar open', 5000);
    await ed.click('.bc-find [data-x="findregex"]');
    const edPing = async () => { const t = Date.now(); await ed.eval('1'); return Date.now() - t; };
    await ed.eval(`(() => { const f = document.querySelector('.bc-find-input'); f.value = 'y.*t.*b.*\\\\?.*t\\\\='; f.dispatchEvent(new Event('input', { bubbles: true })); return true; })()`);
    await sleep(500);
    const ep = [];
    for (let k = 0; k < 5; k += 1) { ep.push(await edPing()); await sleep(100); }
    check(Math.max(...ep) < 200, `the editor answers while its find runs (pings ${ep.join(',')} ms)`);
    await ed.eval(`(() => { const f = document.querySelector('.bc-find-input'); f.value = 'yt.'; f.dispatchEvent(new Event('input', { bubbles: true })); return true; })()`);
    await ed.waitFor(`document.querySelector('.bc-find-count').textContent.endsWith('/560')`, 'find answered', 20000);
    check(true, 'the find bar answers a normal regex from the worker (1/560)');

    // 7. Backstop: a popup page that hangs anyway (a script that never returns)
    // is ended and reloaded by main, instead of staying dead. Chromium's hang
    // monitor never runs for the sandbox's never-shown windows, so its
    // 'unresponsive' event (which the live app logged three times while frozen,
    // 12 Oct 2026) is emitted here once the page really is stuck.
    await sb.mainEval(`(() => {
      const w = __qa.electron.BrowserWindow.getAllWindows().find((x) => /index\.html/.test(x.webContents.getURL()));
      w.webContents.executeJavaScript('for (;;) {}').catch(() => {});
      setTimeout(() => w.webContents.emit('unresponsive'), 1000);
      return true;
    })()`);
    const hungAt = Date.now();
    const reloaded = await qa.waitFor(() => sb.diagnostics().some((e) => e.event === 'popup.renderer_hung_reload') && sb.diagnostics().some((e) => e.event === 'popup.renderer_process_gone'), 'hung popup reloaded', 45000, 500).then(() => true, () => false);
    check(reloaded, `a hung popup is ended and reloaded by main (${Math.round((Date.now() - hungAt) / 1000)} s)`);
    if (!reloaded) console.log(JSON.stringify(sb.diagnostics().filter((e) => /popup\.renderer|render_process/.test(e.event))));
    if (reloaded) {
      const fresh = await sb.page(/index\.html/, { label: 'popup after reload', fresh: false });
      await fresh.waitFor(`typeof clipList !== 'undefined' && clipList.ids().length === ${history.length}`, 'popup back after reload', 30000);
      check(true, 'the reloaded popup lists every clip again');
    }
  } finally {
    const r = await sb.kill();
    console.log(`sandbox removed: ${r.removed}`);
  }
  if (checks.summary().failed) process.exitCode = 1;
}

main().catch((error) => { console.error(error); process.exit(1); });
