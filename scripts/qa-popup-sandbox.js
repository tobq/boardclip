'use strict';

// Sandbox QA for the keep-your-place list + image preview zoom, against the
// REAL popup renderer: a throwaway instance (temp BOARDCLIP_DATA_DIR +
// BOARDCLIP_ISOLATED=1 + its own --user-data-dir, cloud providers pre-disabled,
// p2p/AI off) seeded with ~500 clips (texts + tiny/wide/tall/legacy images),
// driven over raw CDP. The popup stays HIDDEN (nothing appears on the desktop)
// and the system clipboard is never touched. A hidden page renders no frames,
// so scroll events and rAF never fire on their own: the script dispatches
// scroll events itself and calls rerenderList() directly.
//
// Usage: node scripts/qa-popup-sandbox.js        (QA_SHOTS=<dir> is not used: hidden)

const fs = require('fs');
const os = require('os');
const path = require('path');
const zlib = require('zlib');
const { spawn, execSync } = require('child_process');
const getCloudAccounts = require('../lib/cloud-accounts');

const ROOT = path.join(__dirname, '..');
const PORT = 18433;
const results = [];
const check = (name, ok, detail) => {
  results.push({ name, ok: !!ok });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail != null ? `  (${String(detail).slice(0, 160)})` : ''}`);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function connectCdp(wsUrl) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl);
    let seq = 0;
    const pending = new Map();
    ws.onopen = () => resolve({
      send(method, params) {
        return new Promise((res, rej) => {
          const id = ++seq;
          pending.set(id, { res, rej });
          ws.send(JSON.stringify({ id, method, params: params || {} }));
        });
      },
      close: () => { try { ws.close(); } catch {} },
    });
    ws.onerror = () => reject(new Error(`ws error ${wsUrl}`));
    ws.onmessage = (m) => {
      let msg;
      try { msg = JSON.parse(m.data); } catch { return; }
      if (msg.id && pending.has(msg.id)) {
        const p = pending.get(msg.id);
        pending.delete(msg.id);
        if (msg.error) p.rej(new Error(msg.error.message)); else p.res(msg.result);
      }
    };
  });
}
async function evalIn(cdp, expression) {
  const r = await cdp.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
  if (r.exceptionDetails) throw new Error(`eval failed: ${r.exceptionDetails.text} ${(r.exceptionDetails.exception || {}).description || ''}`.slice(0, 600));
  return r.result ? r.result.value : undefined;
}
async function waitFor(fn, label, timeoutMs = 30000, stepMs = 300) {
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    try { const v = await fn(); if (v) return v; } catch {}
    await sleep(stepMs);
  }
  throw new Error(`timeout waiting for ${label}`);
}

// Minimal solid-colour PNG (RGB, 8-bit) for the seeded image clips.
function pngBuffer(w, h, rgb) {
  const chunk = (type, data) => {
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
    const td = Buffer.concat([Buffer.from(type, 'ascii'), data]);
    const crc = Buffer.alloc(4); crc.writeUInt32BE(zlib.crc32(td) >>> 0);
    return Buffer.concat([len, td, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; ihdr[9] = 2; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  const stride = w * 3 + 1;
  const raw = Buffer.alloc(stride * h);
  for (let y = 0; y < h; y += 1) {
    for (let x = 0; x < w; x += 1) { const o = y * stride + 1 + x * 3; raw[o] = rgb[0]; raw[o + 1] = rgb[1]; raw[o + 2] = rgb[2]; }
  }
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}

const IMAGES = {
  wide: { w: 1600, h: 400, rgb: [40, 120, 200] },
  tall: { w: 300, h: 2400, rgb: [200, 80, 60] },
  tiny: { w: 24, h: 16, rgb: [60, 180, 90] },
  norm: { w: 800, h: 600, rgb: [150, 150, 40] },
  legacy: { w: 640, h: 480, rgb: [120, 60, 160], noDims: true },
};
const N = 500;
const PERF = process.env.QA_PERF === "1";

async function main() {
  const stamp = Date.now();
  const dataDir = path.join(os.tmpdir(), `bc-qa-list-${stamp}`);
  const userDataDir = path.join(os.tmpdir(), `bc-qa-list-ud-${stamp}`);
  fs.mkdirSync(path.join(dataDir, 'clipboard-images'), { recursive: true });
  fs.mkdirSync(userDataDir, { recursive: true });
  const accounts = await getCloudAccounts().catch(() => []);
  fs.writeFileSync(path.join(dataDir, 'clipboard-settings.json'), JSON.stringify({
    sync_disabled_paths: accounts.map((a) => a.path),
    p2p_enabled: false,
    ai_access_enabled: false,
    theme_mode: 'dark',
    max_age_days: 365,
    max_size_gb: 5,
  }, null, 2));

  // Seed: clip i is i minutes old; every 25th is an image cycling the kinds.
  for (const [name, spec] of Object.entries(IMAGES)) fs.writeFileSync(path.join(dataDir, 'clipboard-images', `qa-${name}.png`), pngBuffer(spec.w, spec.h, spec.rgb));
  const kinds = Object.keys(IMAGES);
  const now = Math.floor(Date.now() / 1000);
  const seed = [];
  for (let i = 0; i < N; i += 1) {
    const ts = now - i * 60;
    if (i % 25 === 12) {
      const kind = kinds[Math.floor(i / 25) % kinds.length];
      const spec = IMAGES[kind];
      // Images are content-addressed by file: give each row its own copy.
      const file = `qa-${kind}-${i}.png`;
      fs.copyFileSync(path.join(dataDir, 'clipboard-images', `qa-${kind}.png`), path.join(dataDir, 'clipboard-images', file));
      seed.push(spec.noDims ? { type: 'image', image: file, ts } : { type: 'image', image: file, ts, width: spec.w, height: spec.h });
    } else {
      const extra = i % 7 === 0 ? `\nsecond line for ${i}\nthird line` : '';
      seed.push({ type: 'text', text: `qa clip mk${i} ${i % 2 ? 'odd' : 'even'} lorem ipsum ${i}${extra}`, ts });
    }
  }
  // QA_PERF=1: a history the size of the owner's (~14k clips, ~70 MB of text,
  // one 31 MB clip), synthetic so no real data is copied, then ONLY the
  // per-keystroke timing section runs.
  if (PERF) {
    const vocab = 'forge launch plan notes sync release editor popup search clip image draft review meeting audio deploy budget design api token query result window agent model'.split(' ');
    let rnd = 7;
    const next = () => { rnd = (rnd * 1103515245 + 12345) & 0x7fffffff; return rnd; };
    const words = (n) => { let out = ''; for (let k = 0; k < n; k += 1) out += vocab[next() % vocab.length] + (k % 13 === 12 ? '\n' : ' '); return out; };
    for (let i = 0; i < 13400; i += 1) seed.push({ type: 'text', text: `filler ${i} ${words(20 + (next() % 500))}`, ts: now - (N + i) * 60 });
    const para = words(400);
    seed.push({ type: 'text', text: `huge clip ${para.repeat(Math.ceil(31e6 / para.length))}`.slice(0, 31e6), ts: now - (N + 13400) * 60 });
  }
  fs.writeFileSync(path.join(dataDir, 'clipboard-history.json'), JSON.stringify(seed));
  console.log(`sandbox data: ${dataDir} (${seed.length} clips, ${(seed.reduce((s, it) => s + (it.text || '').length, 0) / 1e6).toFixed(1)} MB text, providers pre-disabled: ${accounts.length})`);

  const electronBin = path.join(ROOT, 'node_modules', 'electron', 'dist', process.platform === 'win32' ? 'electron.exe' : 'electron');
  const log = fs.openSync(path.join(dataDir, 'app.log'), 'a');
  const child = spawn(electronBin, ['.', `--user-data-dir=${userDataDir}`, `--remote-debugging-port=${PORT}`], {
    cwd: ROOT,
    env: { ...process.env, BOARDCLIP_DATA_DIR: dataDir, BOARDCLIP_ISOLATED: '1' },
    detached: true,
    windowsHide: true,
    stdio: ['ignore', log, log],
  });
  child.unref();
  console.log(`sandbox app pid ${child.pid}`);

  let cdp = null;
  try {
    const target = await waitFor(async () => (await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json()).find((t) => t.type === 'page' && /index\.html/.test(t.url)), 'popup target');
    cdp = await connectCdp(target.webSocketDebuggerUrl);
    await waitFor(() => evalIn(cdp, `typeof clipList !== 'undefined' && clipList.ids().length >= ${N - 5}`), 'popup rendered seeded clips');

    // In-page helpers (the popup's top-level bindings are global lexicals).
    await evalIn(cdp, `(() => {
      const L = () => document.getElementById('list');
      window.__qa = {
        idOf: (i) => { const it = items.find((x) => (x.text || '').startsWith('qa clip mk' + i + ' ')); return it ? it.id : null; },
        off: (id) => { const el = L().querySelector(':scope > [data-id="' + CSS.escape(id) + '"]'); return el ? el.getBoundingClientRect().top - L().getBoundingClientRect().top : null; },
        top: () => { const id = clipList.firstVisibleId(); return { id, off: id ? __qa.off(id) : null }; },
        rows: () => L().children.length,
        win: () => clipList.window(),
        pill: () => { const p = document.getElementById('listNewest'); return { show: p.classList.contains('show'), dot: p.classList.contains('has-new'), label: p.textContent.trim() }; },
        scrollBy: (px) => { const l = L(); for (let k = 0; k < 400 && px > 0; k += 1) { const step = Math.min(px, l.clientHeight); const before = l.scrollTop; l.scrollTop += step; px -= (l.scrollTop - before) || step; l.dispatchEvent(new Event('scroll')); } },
        query: (q) => { searchEl.value = q; onQueryChanged(q); const t = performance.now(); rerenderList(); return performance.now() - t; },
        clear: () => { const t = performance.now(); clearSearchAndFilters(); return performance.now() - t; },
        key: (key, extra) => document.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, cancelable: true, key, ...(extra || {}) })),
        focused: () => controller.focusedId(),
        clipH: () => getComputedStyle(document.documentElement).getPropertyValue('--clip-img-h').trim(),
      };
      return true;
    })()`);

    if (PERF) {
      // Per-keystroke cost in the real popup: type a query one character at a
      // time (each = the rerender a keystroke triggers), then clear, then a
      // forced history refresh (what every capture / popup focus costs).
      await waitFor(() => evalIn(cdp, `clipList.ids().length >= 13900`), 'big history loaded', 60000);
      const perf = await evalIn(cdp, `(async () => {
        const typed = [];
        for (const word of ['forge launch', 'editor']) {
          for (let k = 1; k <= word.length; k += 1) typed.push(__qa.query(word.slice(0, k)));
          typed.push(__qa.clear());
        }
        const filterOnly = [];
        for (const q of ['f', 'forge', 'forge launch', 'group:x', 'lines:>3']) {
          const t = performance.now();
          Core.filterItemIndexes(items, { query: q, docs: searchDocs, searchTextLower });
          filterOnly.push([q, +(performance.now() - t).toFixed(1)]);
        }
        // Where a keystroke's time goes (query 'forge').
        searchEl.value = 'forge'; query = 'forge'; controller.onQueryChange();
        const parts = {};
        let t = performance.now(); renderGroupFilters(); parts.filterBar = performance.now() - t;
        t = performance.now(); filtered = Core.filterItemIndexes(items, { query, docs: searchDocs, searchTextLower, sortMode }); parts.search = performance.now() - t;
        t = performance.now(); applyFilter(); parts.applyFilter = performance.now() - t;
        t = performance.now(); updateCount(); updateSortButton(); parts.countSort = performance.now() - t;
        t = performance.now(); document.body.getBoundingClientRect(); parts.layout = performance.now() - t;
        __qa.clear();
        console.log(JSON.stringify(parts));
        const r0 = performance.now();
        dataRevision = -1;
        await refresh({ force: true });
        const refreshMs = performance.now() - r0;
        const s = [...typed].sort((a, b) => a - b);
        return { parts, n: typed.length, p50: s[Math.floor(s.length / 2)], p90: s[Math.floor(s.length * 0.9)], max: s[s.length - 1], filterOnly, refreshMs, items: items.length };
      })()`);
      console.log(`      keystroke rerender over ${perf.items} clips: p50 ${perf.p50.toFixed(1)} ms, p90 ${perf.p90.toFixed(1)} ms, max ${perf.max.toFixed(1)} ms (${perf.n} keystrokes)`);
      console.log(`      search only: ${perf.filterOnly.map(([q, ms]) => `"${q}" ${ms} ms`).join(', ')}`);
      console.log(`      forced history refresh (IPC + indexes + rerender): ${perf.refreshMs.toFixed(0)} ms`);
      console.log(`      keystroke parts: ${Object.entries(perf.parts).map(([k, v]) => `${k} ${v.toFixed(1)} ms`).join(', ')}`);
      check('keystroke rerender p90 under 50 ms at owner scale', perf.p90 < 50, `p90 ${perf.p90.toFixed(1)} ms`);
      return;
    }

    // 1. Initial render: windowed, newest first, no pill.
    // The sandbox's poller captures whatever is on the system clipboard at start
    // (read only), so "newest first" is checked by timestamp, not by mk0.
    const init = await evalIn(cdp, `(() => {
      const ts = clipList.ids().slice(0, 40).map((id) => items.find((x) => x.id === id).ts);
      return { rows: __qa.rows(), first: ts.every((t, i) => i === 0 || ts[i - 1] >= t) && clipList.ids().slice(0, 2).includes(__qa.idOf(0)), pill: __qa.pill(), h: document.getElementById('list').clientHeight };
    })()`);
    check('initial render is a window, newest first', init.first && init.rows <= 120 && init.h > 100, JSON.stringify(init));
    check('Newest pill hidden at the top', !init.pill.show, JSON.stringify(init.pill));

    // 2. Scroll deep, then a background rebuild keeps the exact place.
    const deep = await evalIn(cdp, `(async () => {
      __qa.scrollBy(9000);
      const a = __qa.top();
      await refresh({ force: true });
      const b = __qa.off(a.id);
      return { a, b, rows: __qa.rows(), pill: __qa.pill() };
    })()`);
    check('background rebuild keeps a scrolled place (+-1px)', deep.a.id && deep.b != null && Math.abs(deep.b - deep.a.off) <= 1, JSON.stringify(deep));
    check('Newest pill shows once scrolled away', deep.pill.show && /Newest/.test(deep.pill.label), JSON.stringify(deep.pill));

    // 3. A newer clip arriving above keeps the place and lights the pill dot.
    const arrive = await evalIn(cdp, `(() => {
      const a = __qa.top();
      const fresh = { id: 'txt:qa-fresh', type: 'text', text: 'qa fresh arrival', ts: Math.floor(Date.now() / 1000) + 5 };
      items = [fresh, ...items];
      rebuildItemIndexes();
      rerenderList();
      return { a, b: __qa.off(a.id), pill: __qa.pill(), first: clipList.ids()[0] };
    })()`);
    check('new clip above: place kept (+-1px)', arrive.b != null && Math.abs(arrive.b - arrive.a.off) <= 1, JSON.stringify({ a: arrive.a, b: arrive.b }));
    check('new clip above: pill dot', arrive.pill.show && arrive.pill.dot && arrive.first === 'txt:qa-fresh', JSON.stringify(arrive.pill));

    // 4. The pill jumps to the newest and clears the dot.
    const jump = await evalIn(cdp, `(() => { document.getElementById('listNewest').click(); return { scroll: document.getElementById('list').scrollTop, win: __qa.win(), pill: __qa.pill(), top: __qa.top().id }; })()`);
    check('pill click -> top, window reset, dot cleared', jump.scroll === 0 && jump.win.start === 0 && !jump.pill.show && jump.top === 'txt:qa-fresh', JSON.stringify(jump));
    await evalIn(cdp, `(async () => { items = items.filter((x) => x.id !== 'txt:qa-fresh'); dataRevision = -1; await refresh({ force: true }); return true; })()`);

    // 5. Search for a deep clip, then clear: it stays at its spot, in full
    //    history, with a small DOM window.
    const clr = await evalIn(cdp, `(() => {
      const id = __qa.idOf(400);
      const qms = __qa.query('mk400');
      const inSearch = { first: clipList.ids()[0] === id, off: __qa.off(id), count: clipList.ids().length };
      const ms = __qa.clear();
      const ids = clipList.ids();
      const at = ids.indexOf(id);
      const el = document.querySelector('#list > [data-id="' + CSS.escape(id) + '"]');
      return { inSearch, qms, ms, after: __qa.off(id), rows: __qa.rows(), win: __qa.win(), above: el && el.previousElementSibling ? el.previousElementSibling.dataset.id === ids[at - 1] : false, total: ids.length, pill: __qa.pill() };
    })()`);
    check('search starts at the best match', clr.inSearch.first && Math.abs(clr.inSearch.off) <= 1, JSON.stringify(clr.inSearch));
    check('clear keeps the clip at its spot in full history (+-1px)', clr.after != null && Math.abs(clr.after - clr.inSearch.off) <= 1 && clr.total >= N - 5,`off ${clr.after} total ${clr.total}`);
    check('clear lands in context (newer clips rendered above)', clr.above && clr.win.start > 0, JSON.stringify(clr.win));
    check('deep anchor renders a small window, not hundreds of rows', clr.rows <= 160, `${clr.rows} rows, window ${JSON.stringify(clr.win)}`);
    console.log(`      timing: search ${clr.qms.toFixed(1)} ms, clear-to-deep rebuild ${clr.ms.toFixed(1)} ms`);
    check('clear-to-deep rebuild under 150 ms', clr.ms < 150, `${clr.ms.toFixed(1)} ms`);

    // 6. Facet refine (time-ordered): kept if still matching; else the nearest
    //    clip in time takes the same spot.
    const facet = await evalIn(cdp, `(() => {
      const id = __qa.idOf(400);
      __qa.scrollBy(37);
      const before = __qa.top();
      __qa.query('is:text');
      const kept = { id: __qa.top().id, off: __qa.off(before.id) };
      const anchorTs = items.find((x) => x.id === before.id).ts;
      __qa.query('is:image');
      const t = __qa.top();
      const ids = clipList.ids();
      const tsOf = (x) => items.find((y) => y.id === x).ts;
      let best = null, bd = Infinity;
      for (const x of ids) { const d = Math.abs(tsOf(x) - anchorTs); if (d < bd) { bd = d; best = x; } }
      const l = document.getElementById('list');
      // Near the END of a short result list the row cannot reach its old offset
      // (nothing below to scroll into): then it must sit at the scrolled-to-end spot.
      const atEnd = Math.abs(l.scrollTop - (l.scrollHeight - l.clientHeight)) <= 1;
      return { before, kept, nearest: { expected: best, got: t.id, off: __qa.off(best), atEnd } };
    })()`);
    check('facet refine keeps a still-matching clip (+-1px)', facet.kept.off != null && Math.abs(facet.kept.off - facet.before.off) <= 1, JSON.stringify(facet.kept));
    check('dropped clip -> nearest in time at the same spot (or the end of a short list)', facet.nearest.expected && facet.nearest.off != null
      && (Math.abs(facet.nearest.off - facet.before.off) <= 1 || (facet.nearest.atEnd && facet.nearest.off > facet.before.off)), JSON.stringify(facet.nearest));
    await evalIn(cdp, `(__qa.clear(), true)`);

    // 7. Best-match refine with a cursor: the cursor (on screen) survives a
    //    refine that keeps it, and goes when the refine drops it.
    const cur = await evalIn(cdp, `(() => {
      __qa.query('odd lorem');
      __qa.key('ArrowDown'); __qa.key('ArrowDown'); __qa.key('ArrowDown');
      const id = __qa.focused();
      const off = __qa.off(id);
      __qa.query('odd lorem ipsum'); // still matches every row (long list: the offset is reachable)
      const kept = { focus: __qa.focused(), off: __qa.off(id), painted: !!document.querySelector('#list > .item.selected[data-id="' + CSS.escape(id) + '"]') };
      __qa.query('even lorem');
      const dropped = { focus: __qa.focused(), top: document.getElementById('list').scrollTop };
      return { id, off, kept, dropped };
    })()`);
    check('cursor survives a refine that still matches, same spot', cur.kept.focus === cur.id && cur.kept.painted && Math.abs(cur.kept.off - cur.off) <= 1, JSON.stringify(cur.kept));
    check('cursor dropped when the refine excludes it (Best -> top)', cur.dropped.focus === null && cur.dropped.top === 0, JSON.stringify(cur.dropped));

    // 8. Clear with a cursor: cursor and spot both kept in full history.
    const curClr = await evalIn(cdp, `(() => {
      __qa.query('mk3');
      __qa.key('ArrowDown'); __qa.key('ArrowDown');
      const id = __qa.focused();
      const off = __qa.off(id);
      __qa.clear();
      return { id, off, after: __qa.off(id), focus: __qa.focused(), total: clipList.ids().length };
    })()`);
    check('clear keeps a cursor and its spot (+-1px)', curClr.focus === curClr.id && curClr.after != null && Math.abs(curClr.after - curClr.off) <= 1, JSON.stringify(curClr));

    // 9. Reopen: resetPopupState puts the list back at the newest.
    const reopen = await evalIn(cdp, `(() => { resetPopupState(); return { scroll: document.getElementById('list').scrollTop, win: __qa.win(), focus: __qa.focused(), first: clipList.ids()[0] === __qa.idOf(0) }; })()`);
    check('reopen starts at the newest', reopen.scroll === 0 && reopen.win.start === 0 && reopen.focus === null, JSON.stringify(reopen));

    // 10. Ctrl+wheel (TRUSTED input via CDP) over an image row: previews grow
    //     x1.15, the point under the pointer stays put, the PAGE does not zoom.
    await evalIn(cdp, `(() => { __qa.query('is:image'); return true; })()`);
    const pt = await evalIn(cdp, `(() => {
      const img = document.querySelector('#list > .item img[width]');
      const r = img.closest('.item').getBoundingClientRect();
      return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height * 0.6), id: img.closest('.item').dataset.id, dpr: window.devicePixelRatio, h: __qa.clipH() };
    })()`);
    const pointBefore = await evalIn(cdp, `(() => { const el = document.querySelector('#list > [data-id="' + CSS.escape(${JSON.stringify(pt.id)}) + '"]'); const r = el.getBoundingClientRect(); return (${pt.y} - r.top) / r.height; })()`);
    await cdp.send('Input.dispatchMouseEvent', { type: 'mouseWheel', x: pt.x, y: pt.y, deltaX: 0, deltaY: -100, modifiers: 2 });
    await sleep(250);
    const wheel = await evalIn(cdp, `(() => { const el = document.querySelector('#list > [data-id="' + CSS.escape(${JSON.stringify(pt.id)}) + '"]'); const r = el.getBoundingClientRect(); return { h: __qa.clipH(), frac: (${pt.y} - r.top) / r.height, dpr: window.devicePixelRatio, toast: document.getElementById('toast').textContent }; })()`);
    check('Ctrl+wheel resizes previews x1.15', wheel.h === '69px', `${pt.h} -> ${wheel.h}`);
    check('Ctrl+wheel keeps the row under the pointer', Math.abs(wheel.frac - pointBefore) < 0.02, `frac ${pointBefore.toFixed(3)} -> ${wheel.frac.toFixed(3)}`);
    check('Ctrl+wheel never zooms the page', wheel.dpr === pt.dpr, `dpr ${pt.dpr} -> ${wheel.dpr}`);
    check('size toast', /Image previews: 69px/.test(wheel.toast), wheel.toast);

    // 11. Keys (trusted via CDP): Ctrl+= grows, Ctrl+0 resets, page never zooms.
    const keyEv = (type, key, code, vk) => cdp.send('Input.dispatchKeyEvent', { type, key, code, windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk, modifiers: 2 });
    await keyEv('rawKeyDown', '=', 'Equal', 187); await keyEv('keyUp', '=', 'Equal', 187);
    await sleep(150);
    const kin = await evalIn(cdp, `({ h: __qa.clipH(), dpr: window.devicePixelRatio })`);
    await keyEv('rawKeyDown', '0', 'Digit0', 48); await keyEv('keyUp', '0', 'Digit0', 48);
    await sleep(150);
    const kreset = await evalIn(cdp, `({ h: __qa.clipH(), dpr: window.devicePixelRatio })`);
    check('Ctrl+= grows previews x1.25', kin.h === `${+(69 * 1.25).toFixed(2)}px`, kin.h);
    check('Ctrl+0 resets to 60px', kreset.h === '60px', kreset.h);
    check('zoom keys never zoom the page', kin.dpr === pt.dpr && kreset.dpr === pt.dpr, `${kin.dpr} / ${kreset.dpr}`);

    // 12. Sizing rules at 300px and 600px: ratio kept, never wider than the row,
    //     never taller than the list, never past real size; legacy clips sized.
    for (const px of [300, 600]) {
      const sz = await evalIn(cdp, `(async () => {
        imageZoom.set(${px}, { silent: true, save: false });
        await Promise.all([...document.querySelectorAll('#list > .item img')].map((im) => im.decode().catch(() => {})));
        const listH = document.getElementById('list').clientHeight;
        return [...document.querySelectorAll('#list > .item img')].map((im) => {
          const r = im.getBoundingClientRect();
          const content = im.closest('.content').getBoundingClientRect();
          const nw = Number(im.getAttribute('width')) || im.naturalWidth;
          const nh = Number(im.getAttribute('height')) || im.naturalHeight;
          return { dims: im.hasAttribute('width'), w: r.width, h: r.height, nw, nh, contentW: content.width, listH };
        });
      })()`);
      const bad = sz.filter((s) => {
        const ratioOk = s.h > 0 && Math.abs((s.w / s.h) / (s.nw / s.nh) - 1) < 0.02;
        return !ratioOk || s.w > s.contentW + 0.5 || s.h > s.listH - 39.5 || s.w > s.nw + 0.5 || s.h > px + 0.5;
      });
      check(`at ${px}px: ratio kept, no overflow, no upscale, fits the list (${sz.length} images)`, sz.length >= 5 && bad.length === 0, bad.length ? JSON.stringify(bad[0]) : `listH ${sz[0] && sz[0].listH}`);
      const tiny = sz.find((s) => s.nw === 24);
      if (tiny) check(`at ${px}px: tiny 24x16 image stays at real size`, tiny.w <= 24.5, `${tiny.w}x${tiny.h}`);
      check(`at ${px}px: legacy image (no dims) still sized`, sz.some((s) => !s.dims && s.h > 0 && s.h <= Math.min(px, s.listH - 40) + 0.5), JSON.stringify(sz.find((s) => !s.dims)));
    }

    // 13. Settings row: live input, debounced save, reset, main clamps.
    const settingsRes = await evalIn(cdp, `(async () => {
      await openSettings();
      const input = document.getElementById('imagePreviewHeight');
      input.value = '150'; input.dispatchEvent(new Event('input'));
      const live = __qa.clipH();
      await new Promise((r) => setTimeout(r, 700));
      const saved = (await window.api.getSettings()).image_preview_height;
      document.getElementById('imagePreviewHeightReset').click();
      await new Promise((r) => setTimeout(r, 700));
      const reset = { h: __qa.clipH(), input: input.value, saved: (await window.api.getSettings()).image_preview_height };
      await window.api.saveSettings({ image_preview_height: 9999 });
      const clamped = (await window.api.getSettings()).image_preview_height;
      await window.api.saveSettings({ image_preview_height: 60 });
      closeSettings();
      return { live, saved, reset, clamped };
    })()`);
    check('settings input applies live + saves', settingsRes.live === '150px' && settingsRes.saved === 150, JSON.stringify(settingsRes));
    check('settings reset -> 60px saved', settingsRes.reset.h === '60px' && settingsRes.reset.input === '60' && settingsRes.reset.saved === 60, JSON.stringify(settingsRes.reset));
    check('main clamps the saved height to 600', settingsRes.clamped === 600, settingsRes.clamped);

    // 14. Editor footer (shared createEditor, mounted in-page): Copy -> "On
    //     clipboard"; a stop shows the notice, then the Copy button returns.
    const ed = await evalIn(cdp, `(async () => {
      const host = document.createElement('div');
      host.style.cssText = 'position:fixed;left:-9999px;top:0;width:520px;height:300px';
      document.body.appendChild(host);
      let copied = null;
      const ed = Core.createEditor({ initialText: 'note body', clipboard: { following: false, onCopy: async (p) => { copied = p.text; return { following: true, event: 'adopted' }; } } });
      host.appendChild(ed.el);
      const clip = () => ed.el.querySelector('[data-x="clip"]');
      const start = { copyBtn: !!clip().querySelector('[data-x="copy"]') };
      clip().querySelector('[data-x="copy"]').click();
      await new Promise((r) => setTimeout(r, 50));
      const after = { text: clip().textContent.trim(), on: clip().classList.contains('on'), copied };
      ed.setClipboardState({ following: false, event: 'stopped' });
      const notice = clip().textContent.trim();
      await new Promise((r) => setTimeout(r, 2700));
      const back = !!clip().querySelector('[data-x="copy"]');
      host.remove();
      return { start, after, notice, back };
    })()`);
    check('editor footer: Copy button when not on the clipboard', ed.start.copyBtn, JSON.stringify(ed.start));
    check('editor footer: Copy -> "On clipboard - edits update it"', ed.after.on && /On clipboard - edits update it/.test(ed.after.text) && ed.after.copied === 'note body', JSON.stringify(ed.after));
    check('editor footer: stop notice, then Copy again', /Clipboard changed elsewhere/.test(ed.notice) && ed.back, JSON.stringify({ notice: ed.notice, back: ed.back }));

    // 15. Drag out of a row (real DOM, synthetic dragstart). Image rows go to
    //     the host's native file drag; a REAL startDrag is deliberately not
    //     fired here: with no mouse button held, Windows would "drop" the file
    //     onto whatever window is under the user's cursor. The spy stands in.
    const drag = await evalIn(cdp, `(() => {
      __qa.clear();
      resetPopupState();
      const real = appAdapter.dragImages;
      const calls = [];
      appAdapter.dragImages = (ids, event) => { event.preventDefault(); calls.push(ids); return true; };
      const fire = (el) => { const dt = new DataTransfer(); const ev = new DragEvent('dragstart', { bubbles: true, cancelable: true, dataTransfer: dt }); el.dispatchEvent(ev); return { prevented: ev.defaultPrevented, text: dt.getData('text/plain') }; };
      const rows = [...document.querySelectorAll('#list > .item')];
      const textRow = rows.find((r) => r.dataset.id.startsWith('txt:') && r.dataset.id !== rows[0].dataset.id);
      const imgRow = rows.find((r) => r.dataset.id.startsWith('img:'));
      const text = fire(textRow.querySelector('.preview'));
      const image = fire(imgRow.querySelector('img'));
      const star = fire(textRow.querySelector('.star'));
      // Multi: ctrl-click two images, drag one -> both, list order.
      const imgs = rows.filter((r) => r.dataset.id.startsWith('img:')).slice(0, 2);
      imgs.forEach((r) => r.querySelector('.preview').dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, ctrlKey: true })));
      fire(imgs[1].querySelector('img'));
      controller.clearSelection();
      appAdapter.dragImages = real;
      const textItem = items.find((x) => x.id === textRow.dataset.id);
      return { text, textOk: text.text === textItem.text, image, imageIds: calls[0], multi: calls[1], expectMulti: imgs.map((r) => r.dataset.id), imgId: imgRow.dataset.id, star, draggable: textRow.getAttribute('draggable') };
    })()`);
    check('rows are draggable', drag.draggable === 'true');
    check('text row drags its full text (native page drag)', drag.textOk && !drag.text.prevented, JSON.stringify(drag.text).slice(0, 120));
    check('image row -> host file drag (page drag cancelled)', drag.image.prevented && JSON.stringify(drag.imageIds) === JSON.stringify([drag.imgId]), JSON.stringify(drag.imageIds));
    check('selected images drag together, list order', JSON.stringify(drag.multi) === JSON.stringify(drag.expectMulti), JSON.stringify(drag.multi));
    check('pressing on a row control never drags', drag.star.prevented && !drag.star.text, JSON.stringify(drag.star));

    // 16. Viewer drag-out (shared createImageViewer mounted in-page): fit size
    //     drags out, zoomed in pans, Alt+drag drags out, the handle always does.
    const viewer = await evalIn(cdp, `(async () => {
      const host = document.createElement('div');
      host.style.cssText = 'position:fixed;left:-9999px;top:0;width:500px;height:400px;display:flex;flex-direction:column';
      document.body.appendChild(host);
      let outs = 0;
      const v = Core.createImageViewer({ src: 'clip-img:///' + items.find((x) => x.type === 'image' && x.width === 1600).image, onDragOut: () => { outs += 1; } });
      host.appendChild(v.el);
      v.el.style.height = '400px';
      const img = v.el.querySelector('[data-x="img"]');
      const stage = v.el.querySelector('[data-x="stage"]');
      await new Promise((r) => { if (img.complete && img.naturalWidth) r(); else img.onload = r; setTimeout(r, 3000); });
      await new Promise((r) => setTimeout(r, 100));
      const press = (opts) => stage.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, button: 0, pointerId: 1, clientX: 50, clientY: 80, ...(opts || {}) }));
      const dragFrom = (el) => { const ev = new DragEvent('dragstart', { bubbles: true, cancelable: true, dataTransfer: new DataTransfer() }); el.dispatchEvent(ev); return ev.defaultPrevented; };
      const cancel = () => stage.dispatchEvent(new PointerEvent('pointercancel', { bubbles: true, pointerId: 1 }));
      const r = {};
      press(); r.fitDraggable = img.draggable; r.fitPrevented = dragFrom(img); r.fitOuts = outs; cancel();
      stage.dispatchEvent(new WheelEvent('wheel', { bubbles: true, cancelable: true, deltaY: -100, clientX: 120, clientY: 120 }));
      stage.dispatchEvent(new WheelEvent('wheel', { bubbles: true, cancelable: true, deltaY: -100, clientX: 120, clientY: 120 }));
      stage.dispatchEvent(new WheelEvent('wheel', { bubbles: true, cancelable: true, deltaY: -100, clientX: 120, clientY: 120 }));
      press(); r.zoomDraggable = img.draggable; dragFrom(img); r.zoomOuts = outs;
      stage.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, button: 0, pointerId: 1, clientX: 50, clientY: 80 }));
      press({ altKey: true }); r.altDraggable = img.draggable; dragFrom(img); r.altOuts = outs; cancel();
      dragFrom(v.el.querySelector('[data-x="drag"]')); r.handleOuts = outs;
      r.handle = !!v.el.querySelector('.bc-drag-handle[draggable="true"]');
      host.remove();
      return r;
    })()`);
    check('viewer at fit size: drag pulls the image out', viewer.fitDraggable && viewer.fitPrevented && viewer.fitOuts === 1, JSON.stringify(viewer));
    check('viewer zoomed in: drag pans, nothing leaves', !viewer.zoomDraggable && viewer.zoomOuts === 1, JSON.stringify({ d: viewer.zoomDraggable, outs: viewer.zoomOuts }));
    check('viewer zoomed in + Alt: drag pulls the image out', viewer.altDraggable && viewer.altOuts === 2, JSON.stringify({ d: viewer.altDraggable, outs: viewer.altOuts }));
    check('viewer title-bar handle always drags out', viewer.handle && viewer.handleOuts === 3, JSON.stringify({ h: viewer.handle, outs: viewer.handleOuts }));

    // 17. Navigation guard (LAST: a failure would replace the popup page): a
    //     renderer navigation, as a file dropped on the window triggers, is refused.
    await evalIn(cdp, `(location.href = 'file:///C:/Windows/win.ini', true)`).catch(() => {});
    await sleep(1500);
    const still = await evalIn(cdp, `({ href: location.href, list: !!document.getElementById('list') })`).catch((e) => ({ error: e.message }));
    check('a BoardClip window never navigates away (dropped files)', still && /index\.html/.test(still.href || '') && still.list, JSON.stringify(still));

    // Renderer exceptions land in the diagnostics file (Core.installRendererErrorReporting).
    await sleep(500);
    const diagFile = path.join(dataDir, 'boardclip-diagnostics.jsonl');
    const errs = fs.existsSync(diagFile) ? fs.readFileSync(diagFile, 'utf8').split('\n').filter((l) => l.includes('renderer.error')) : [];
    check('no renderer errors recorded', errs.length === 0, errs[0]);
  } finally {
    if (cdp) cdp.close();
    try { process.kill(child.pid); } catch {}
    try {
      execSync(`wmic process where "name='electron.exe' and commandline like '%%${userDataDir.replace(/\\/g, '\\\\')}%%'" call terminate`, { stdio: 'ignore', timeout: 15000 });
    } catch {}
    await sleep(1500);
    try { fs.rmSync(dataDir, { recursive: true, force: true }); } catch {}
    try { fs.rmSync(userDataDir, { recursive: true, force: true }); } catch {}
    // The sandbox wrote this checkout's boardclip.pid; drop it only if it is ours.
    try {
      const pidFile = path.join(ROOT, 'boardclip.pid');
      if (JSON.parse(fs.readFileSync(pidFile, 'utf8')).pid === child.pid) fs.unlinkSync(pidFile);
    } catch {}
  }
  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
  if (failed.length) { console.log('FAILED:', failed.map((f) => f.name).join(' | ')); process.exit(1); }
}

main().catch((err) => { console.error('qa error:', err.message); process.exit(1); });
