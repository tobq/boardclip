'use strict';

// Sandbox QA for the keep-your-place list + image preview zoom, against the
// REAL popup renderer: a throwaway instance from scripts/lib/qa-sandbox.js
// (temp data + profile, BOARDCLIP_ISOLATED=1, cloud providers pre-disabled,
// p2p/AI off, cloaked never-focused windows, in-memory clipboard) seeded with
// ~500 clips (texts + tiny/wide/tall/legacy images), driven over raw CDP. The
// popup is never opened (nothing appears on the desktop) and the system
// clipboard is never touched. A hidden page renders no frames, so scroll events
// and rAF never fire on their own: the script dispatches scroll events itself
// and calls rerenderList() directly.
//
// Usage: node scripts/qa-popup-sandbox.js        (QA_PERF=1: owner-scale keystroke timing only)

const fs = require('fs');
const path = require('path');
const qa = require('./lib/qa-sandbox');

const { check, summary } = qa.createChecks();
const sleep = qa.sleep;

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
  // Seed: clip i is i minutes old; every 25th is an image cycling the kinds.
  const images = {};
  for (const [name, spec] of Object.entries(IMAGES)) images[`qa-${name}.png`] = qa.png(spec.w, spec.h, () => spec.rgb);
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
      images[file] = images[`qa-${kind}.png`];
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
    seed.push({ type: 'text', text: `huge clip ${para.repeat(Math.ceil(31e6 / para.length))}`.slice(0, 31e6), ts: now - 90 }); // recent: ranks among the visible rows, like the owner's
    // Similar clips: a note, a longer version of it and a fragment of it; and a
    // clip whose text sits inside the 31 MB clip (found through its haystack).
    const note = `qa similar seed ${words(120)}`;
    seed.push({ type: 'text', text: note, ts: now - 95 }, { type: 'text', text: `${note}\nplus a paragraph added later`, ts: now - 96 }, { type: 'text', text: note.slice(0, 200), ts: now - 97 });
    seed.push({ type: 'text', title: 'qa similar part', text: para.slice(40, 400), ts: now - 98 });
    // A 30K-char target inside the 31 MB clip: the huge clip is searched
    // without a pattern built from the target (a 25K+ char RegExp does not
    // compile: "Stack overflow", 2026-10-08).
    seed.push({ type: 'text', title: 'qa similar long part', text: para.repeat(14).slice(123, 30123), ts: now - 99 });
  }
  const sb = await qa.launch({
    name: 'popup',
    settings: {
      diagnostics_enabled: PERF, // perf mode: the renderer logs every refresh/rebuild with ms
      max_age_days: 365,
      max_size_gb: 5,
    },
    history: seed,
    images,
  });
  console.log(`sandbox data: ${sb.dataDir} (${seed.length} clips, ${(seed.reduce((s, it) => s + (it.text || '').length, 0) / 1e6).toFixed(1)} MB text, providers pre-disabled: ${sb.settings.sync_disabled_paths.length})`);
  console.log(`sandbox app pid ${sb.pid}`);

  let cdp = null;
  let cleanup = null;
  try {
    cdp = await sb.popup();
    await qa.waitFor(() => cdp.eval(`typeof clipList !== 'undefined' && clipList.ids().length >= ${N - 5}`), 'popup rendered seeded clips');

    // In-page helpers (the popup's top-level bindings are global lexicals).
    await cdp.eval(`(() => {
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
      await qa.waitFor(() => cdp.eval(`clipList.ids().length >= 13900`), 'big history loaded', 60000);
      const perf = await cdp.eval(`(async () => {
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
        // A background change through main (a pin): the popup's refresh must be
        // a small delta, not the whole history again.
        // Measured as the popup thread's LONG TASKS (what blocks typing), not
        // wall time: main saving the file runs off this thread.
        const longTasks = [];
        const taskLog = [];
        const lto = new PerformanceObserver((list) => { for (const e of list.getEntries()) { longTasks.push(e.duration); taskLog.push([Math.round(e.startTime), Math.round(e.duration)]); } });
        lto.observe({ type: 'longtask', buffered: false });
        const target = items[5];
        await new Promise((r) => setTimeout(r, 300));
        const before = dataRevision;
        const d0 = performance.now();
        const t0Mark = Math.round(d0);
        await window.api.pin(target.id, target.rev);
        const pinReturned = Math.round(performance.now());
        while (dataRevision === before && performance.now() - d0 < 5000) await new Promise((r) => setTimeout(r, 10));
        const deltaMs = performance.now() - d0;
        await new Promise((r) => setTimeout(r, 200));
        const appliedAt = Math.round(d0 + deltaMs);
        const tasksRel = taskLog.splice(0).map(([st, du]) => [st - t0Mark, du]);
        longTasks.splice(0);
        // Only tasks that START once the change is under way count (the typing
        // loop above is itself one long synchronous task and ends just before).
        const deltaBlock = Math.max(0, ...tasksRel.filter(([st]) => st >= 0).map(([, du]) => du));
        const pinned = !!(items.find((x) => x.id === target.id) || {}).pin;
        await window.api.pin(target.id, (items.find((x) => x.id === target.id) || {}).rev);
        const r0 = performance.now();
        dataRevision = -1;
        await refresh({ force: true });
        const refreshMs = performance.now() - r0;
        await new Promise((r) => setTimeout(r, 200));
        const fullBlock = Math.max(0, ...longTasks.splice(0));
        lto.disconnect();
        const s = [...typed].sort((a, b) => a - b);
        return { parts, n: typed.length, p50: s[Math.floor(s.length / 2)], p90: s[Math.floor(s.length * 0.9)], max: s[s.length - 1], filterOnly, refreshMs, deltaMs, deltaBlock, fullBlock, tasksRel, pinReturnedRel: pinReturned - t0Mark, appliedRel: appliedAt - t0Mark, pinned, items: items.length };
      })()`);
      console.log(`      keystroke rerender over ${perf.items} clips: p50 ${perf.p50.toFixed(1)} ms, p90 ${perf.p90.toFixed(1)} ms, max ${perf.max.toFixed(1)} ms (${perf.n} keystrokes)`);
      console.log(`      search only: ${perf.filterOnly.map(([q, ms]) => `"${q}" ${ms} ms`).join(', ')}`);
      console.log(`      background change (pin): applied after ${perf.deltaMs.toFixed(0)} ms wall (main saves the file meanwhile), popup thread blocked at most ${perf.deltaBlock.toFixed(0)} ms (pinned: ${perf.pinned})`);
      console.log(`      long tasks [start rel. to pin, ms]: ${JSON.stringify(perf.tasksRel)}; pin IPC returned +${perf.pinReturnedRel} ms, delta applied +${perf.appliedRel} ms`);
      console.log(`      a FULL reload (fresh popup only): ${perf.refreshMs.toFixed(0)} ms wall, longest block ${perf.fullBlock.toFixed(0)} ms`);
      console.log(`      keystroke parts: ${Object.entries(perf.parts).map(([k, v]) => `${k} ${v.toFixed(1)} ms`).join(', ')}`);
      check('keystroke rerender p90 under 50 ms at owner scale', perf.p90 < 50, `p90 ${perf.p90.toFixed(1)} ms`);
      const diag = path.join(sb.dataDir, 'boardclip-diagnostics.jsonl');
      if (fs.existsSync(diag)) {
        for (const line of fs.readFileSync(diag, 'utf8').split('\n')) {
          if (/"renderer\.(history\.refresh|indexes\.rebuild|settings\.refresh_groups)"|"history\.save/.test(line)) console.log('      diag', line.slice(0, 230));
        }
      }
      check('a background change blocks the popup thread < 50 ms (was ~1 s)', perf.pinned && perf.deltaBlock < 50, `longest block ${perf.deltaBlock.toFixed(0)} ms`);
      // Similar clips (D2) at owner scale: the scan behind the hover tint and
      // the menu's "Select N similar" runs in slices; measured per slice (the
      // longest stretch the popup thread is blocked) and end to end, cold
      // (every clip normalised for the first time) and warm, plus the real
      // hover-to-paint and menu-count paths with a long-task observer on.
      const sim = await cdp.eval(`(async () => {
        const lowerOf = (it) => searchIndexFor(it).hay;
        const scan = (item) => new Promise((resolve) => {
          const slices = [];
          const t0 = performance.now();
          Core.runSliced(Core.similarSteps(item, items, { lowerOf }), (ids) => resolve({
            ms: +(performance.now() - t0).toFixed(1), found: ids.length, slices: slices.length,
            maxSlice: +Math.max(0, ...slices).toFixed(1), cpu: +slices.reduce((a, b) => a + b, 0).toFixed(1),
          }), { onSlice: (ms) => slices.push(ms) });
        });
        const find = (prefix) => items.find((it) => (it.text || '').startsWith(prefix));
        const cold = await scan(find('qa similar seed'));
        const warm = await scan(items.find((it) => it.title === 'qa similar part'));
        const long = await scan(items.find((it) => it.title === 'qa similar long part'));
        const tasks = [];
        const lto = new PerformanceObserver((list) => { for (const e of list.getEntries()) tasks.push(Math.round(e.duration)); });
        lto.observe({ type: 'longtask', buffered: false });
        // Hover a rendered text row (a target never scanned before): time to the painted tint.
        const rows = [...document.querySelectorAll('#list > .item')].filter((el) => { const it = itemById(el.dataset.id); return it && it.type !== 'image' && (it.text || '').length < 200000; });
        const hoverRow = rows[2];
        const h0 = performance.now();
        hoverRow.querySelector('.content').dispatchEvent(new MouseEvent('mouseover', { bubbles: true }));
        await new Promise((r) => controller.whenSimilar(hoverRow.dataset.id, r));
        await new Promise((r) => setTimeout(r, 0));
        const hoverMs = +(performance.now() - h0).toFixed(1);
        const hoverTarget = controller.similar().target === hoverRow.dataset.id;
        hoverRow.dispatchEvent(new MouseEvent('mouseout', { bubbles: true, relatedTarget: null }));
        // Open another row's menu: time until its "Select N similar" row settles.
        const menuRow = rows[4];
        const r = menuRow.getBoundingClientRect();
        const m0 = performance.now();
        controller.openRowMenu(menuRow, r.left + 40, r.top + 10);
        const placeholder = !!document.querySelector('.bc-menu [data-action="select-similar"][aria-busy]');
        await new Promise((res) => controller.whenSimilar(menuRow.dataset.id, res));
        const menuMs = +(performance.now() - m0).toFixed(1);
        const settled = !document.querySelector('.bc-menu [data-action="select-similar"][aria-busy]');
        controller.closeMenu();
        await new Promise((res) => setTimeout(res, 100));
        lto.disconnect();
        return { cold, warm, long, hoverMs, hoverTarget, menuMs, placeholder, settled, longTasks: tasks };
      })()`);
      console.log(`      similar scan cold (first normalisation of ${perf.items} clips): ${sim.cold.ms} ms wall, ${sim.cold.cpu} ms CPU in ${sim.cold.slices} slices, longest slice ${sim.cold.maxSlice} ms, ${sim.cold.found} found`);
      console.log(`      similar scan warm (target inside the 31 MB clip): ${sim.warm.ms} ms wall, ${sim.warm.cpu} ms CPU in ${sim.warm.slices} slices, longest slice ${sim.warm.maxSlice} ms, ${sim.warm.found} found`);
      console.log(`      hover-to-result ${sim.hoverMs} ms (the scan; the tint paints after the 120 ms dwell), menu count ${sim.menuMs} ms (placeholder shown: ${sim.placeholder}), long tasks: ${JSON.stringify(sim.longTasks)}`);
      console.log(`      similar scan long target (30K chars, inside the 31 MB clip): ${sim.long.ms} ms wall, ${sim.long.cpu} ms CPU in ${sim.long.slices} slices, longest slice ${sim.long.maxSlice} ms, ${sim.long.found} found`);
      check('similar scan never blocks a frame (longest slice < 16 ms, cold + warm + long target)', sim.cold.maxSlice < 16 && sim.warm.maxSlice < 16 && sim.long.maxSlice < 16, `${sim.cold.maxSlice} / ${sim.warm.maxSlice} / ${sim.long.maxSlice} ms`);
      check('similar: the clip inside the 31 MB clip is found through its haystack', sim.warm.found >= 1, `${sim.warm.found}`);
      check('similar: a 30K-char target is found inside the 31 MB clip (no pattern from the target)', sim.long.found >= 1, `${sim.long.found}`);
      check('similar: the seeded near-duplicates are found', sim.cold.found >= 2, `${sim.cold.found}`);
      check('similar: hover paints the target, menu count settles, no long task on the popup thread', sim.hoverTarget && sim.settled && sim.longTasks.length === 0, JSON.stringify({ hover: sim.hoverTarget, settled: sim.settled, longTasks: sim.longTasks }));
      return;
    }

    // 1. Initial render: windowed, newest first, no pill.
    // The sandbox's poller captures whatever is on the system clipboard at start
    // (read only), so "newest first" is checked by timestamp, not by mk0.
    const init = await cdp.eval(`(() => {
      const ts = clipList.ids().slice(0, 40).map((id) => items.find((x) => x.id === id).ts);
      return { rows: __qa.rows(), first: ts.every((t, i) => i === 0 || ts[i - 1] >= t) && clipList.ids().slice(0, 2).includes(__qa.idOf(0)), pill: __qa.pill(), h: document.getElementById('list').clientHeight };
    })()`);
    check('initial render is a window, newest first', init.first && init.rows <= 120 && init.h > 100, JSON.stringify(init));
    check('Newest pill hidden at the top', !init.pill.show, JSON.stringify(init.pill));

    // 2. Scroll deep, then a background rebuild keeps the exact place.
    const deep = await cdp.eval(`(async () => {
      __qa.scrollBy(9000);
      const a = __qa.top();
      await refresh({ force: true });
      const b = __qa.off(a.id);
      return { a, b, rows: __qa.rows(), pill: __qa.pill() };
    })()`);
    check('background rebuild keeps a scrolled place (+-1px)', deep.a.id && deep.b != null && Math.abs(deep.b - deep.a.off) <= 1, JSON.stringify(deep));
    check('Newest pill shows once scrolled away', deep.pill.show && /Newest/.test(deep.pill.label), JSON.stringify(deep.pill));

    // 3. A newer clip arriving above keeps the place and lights the pill dot.
    const arrive = await cdp.eval(`(() => {
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
    const jump = await cdp.eval(`(() => { document.getElementById('listNewest').click(); return { scroll: document.getElementById('list').scrollTop, win: __qa.win(), pill: __qa.pill(), top: __qa.top().id }; })()`);
    check('pill click -> top, window reset, dot cleared', jump.scroll === 0 && jump.win.start === 0 && !jump.pill.show && jump.top === 'txt:qa-fresh', JSON.stringify(jump));
    await cdp.eval(`(async () => { items = items.filter((x) => x.id !== 'txt:qa-fresh'); dataRevision = -1; await refresh({ force: true }); return true; })()`);

    // 5. Search for a deep clip, then clear: it stays at its spot, in full
    //    history, with a small DOM window.
    const clr = await cdp.eval(`(() => {
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
    const facet = await cdp.eval(`(() => {
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
    await cdp.eval(`(__qa.clear(), true)`);

    // 7. Best-match refine with a cursor: the cursor (on screen) survives a
    //    refine that keeps it, and goes when the refine drops it.
    const cur = await cdp.eval(`(() => {
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
    const curClr = await cdp.eval(`(() => {
      __qa.query('mk3');
      __qa.key('ArrowDown'); __qa.key('ArrowDown');
      const id = __qa.focused();
      const off = __qa.off(id);
      __qa.clear();
      return { id, off, after: __qa.off(id), focus: __qa.focused(), total: clipList.ids().length };
    })()`);
    check('clear keeps a cursor and its spot (+-1px)', curClr.focus === curClr.id && curClr.after != null && Math.abs(curClr.after - curClr.off) <= 1, JSON.stringify(curClr));

    // 9. Reopen: resetPopupState puts the list back at the newest.
    const reopen = await cdp.eval(`(() => { resetPopupState(); return { scroll: document.getElementById('list').scrollTop, win: __qa.win(), focus: __qa.focused(), first: clipList.ids()[0] === __qa.idOf(0) }; })()`);
    check('reopen starts at the newest', reopen.scroll === 0 && reopen.win.start === 0 && reopen.focus === null, JSON.stringify(reopen));

    // 10. Ctrl+wheel (TRUSTED input via CDP) over an image row: previews grow
    //     x1.15, the point under the pointer stays put, the PAGE does not zoom.
    await cdp.eval(`(() => { __qa.query('is:image'); return true; })()`);
    const pt = await cdp.eval(`(() => {
      const img = document.querySelector('#list > .item img[width]');
      const r = img.closest('.item').getBoundingClientRect();
      return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height * 0.6), id: img.closest('.item').dataset.id, dpr: window.devicePixelRatio, h: __qa.clipH() };
    })()`);
    const pointBefore = await cdp.eval(`(() => { const el = document.querySelector('#list > [data-id="' + CSS.escape(${JSON.stringify(pt.id)}) + '"]'); const r = el.getBoundingClientRect(); return (${pt.y} - r.top) / r.height; })()`);
    await cdp.send('Input.dispatchMouseEvent', { type: 'mouseWheel', x: pt.x, y: pt.y, deltaX: 0, deltaY: -100, modifiers: 2 });
    await sleep(250);
    const wheel = await cdp.eval(`(() => { const el = document.querySelector('#list > [data-id="' + CSS.escape(${JSON.stringify(pt.id)}) + '"]'); const r = el.getBoundingClientRect(); return { h: __qa.clipH(), frac: (${pt.y} - r.top) / r.height, dpr: window.devicePixelRatio, toast: document.getElementById('toast').textContent }; })()`);
    check('Ctrl+wheel resizes previews x1.15', wheel.h === '69px', `${pt.h} -> ${wheel.h}`);
    check('Ctrl+wheel keeps the row under the pointer', Math.abs(wheel.frac - pointBefore) < 0.02, `frac ${pointBefore.toFixed(3)} -> ${wheel.frac.toFixed(3)}`);
    check('Ctrl+wheel never zooms the page', wheel.dpr === pt.dpr, `dpr ${pt.dpr} -> ${wheel.dpr}`);
    check('size toast', /Image previews: 69px/.test(wheel.toast), wheel.toast);

    // 11. Keys (trusted via CDP): Ctrl+= grows, Ctrl+0 resets, page never zooms.
    const keyEv = (type, key, code, vk) => cdp.send('Input.dispatchKeyEvent', { type, key, code, windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk, modifiers: 2 });
    await keyEv('rawKeyDown', '=', 'Equal', 187); await keyEv('keyUp', '=', 'Equal', 187);
    await sleep(150);
    const kin = await cdp.eval(`({ h: __qa.clipH(), dpr: window.devicePixelRatio })`);
    await keyEv('rawKeyDown', '0', 'Digit0', 48); await keyEv('keyUp', '0', 'Digit0', 48);
    await sleep(150);
    const kreset = await cdp.eval(`({ h: __qa.clipH(), dpr: window.devicePixelRatio })`);
    check('Ctrl+= grows previews x1.25', kin.h === `${+(69 * 1.25).toFixed(2)}px`, kin.h);
    check('Ctrl+0 resets to 60px', kreset.h === '60px', kreset.h);
    check('zoom keys never zoom the page', kin.dpr === pt.dpr && kreset.dpr === pt.dpr, `${kin.dpr} / ${kreset.dpr}`);

    // 12. Sizing rules at 300px and 600px: ratio kept, never wider than the row,
    //     never taller than the list, never past real size; legacy clips sized.
    for (const px of [300, 600]) {
      const sz = await cdp.eval(`(async () => {
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
    const settingsRes = await cdp.eval(`(async () => {
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
    const ed = await cdp.eval(`(async () => {
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
    const drag = await cdp.eval(`(() => {
      __qa.clear();
      resetPopupState();
      const real = appAdapter.dragImages;
      const calls = [];
      appAdapter.dragImages = (ids, event) => { event.preventDefault(); calls.push(ids); return true; };
      // The list renders about two screenfuls: scroll until two image rows exist.
      for (let k = 0; k < 20 && document.querySelectorAll('#list > .item[data-id^="img:"]').length < 2; k += 1) __qa.scrollBy(document.getElementById('list').clientHeight);
      const fire = (el) => { const dt = new DataTransfer(); const ev = new DragEvent('dragstart', { bubbles: true, cancelable: true, dataTransfer: dt }); el.dispatchEvent(ev); return { prevented: ev.defaultPrevented, text: dt.getData('text/plain') }; };
      const rows = [...document.querySelectorAll('#list > .item')];
      const textRow = rows.find((r) => r.dataset.id.startsWith('txt:') && r.dataset.id !== rows[0].dataset.id);
      const imgRow = rows.find((r) => r.dataset.id.startsWith('img:'));
      const text = fire(textRow.querySelector('.content'));
      const image = fire(imgRow.querySelector('img'));
      const star = fire(textRow.querySelector('.star'));
      // Multi: ctrl-click two images, drag one -> both, list order.
      const imgs = rows.filter((r) => r.dataset.id.startsWith('img:')).slice(0, 2);
      imgs.forEach((r) => r.querySelector('.content').dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, ctrlKey: true })));
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
    const viewer = await cdp.eval(`(async () => {
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

    // 16b. Search behaviour from Forge (phase 4), in the real popup: greyed +
    //      inert chips, invalid token + hint (+ its one-click fix), a regex
    //      error, ghost + unique auto-fill, Esc parking, the empty-result
    //      nudge, paste quoting, and the ONE focus state (underline + placeholder).
    const pinTarget = await cdp.eval(`(() => { const it = items.find((x) => x.type === 'text'); return { id: it.id, rev: it.rev }; })()`);
    await cdp.eval(`window.api.pin(${JSON.stringify(pinTarget.id)}, ${JSON.stringify(pinTarget.rev)})`);
    await qa.waitFor(() => cdp.eval(`!!(items.find((x) => x.id === ${JSON.stringify(pinTarget.id)}) || {}).pin`), 'pin applied', 10000);
    const sbx = await cdp.eval(`(async () => {
      const tick = () => new Promise((r) => setTimeout(r, 30));
      const type = async (v, caret) => { searchEl.focus(); searchEl.value = v; const c = caret == null ? v.length : caret; searchEl.setSelectionRange(c, c); searchEl.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText' })); rerenderList(); await tick(); };
      const key = (k, extra) => { const ev = new KeyboardEvent('keydown', { bubbles: true, cancelable: true, key: k, ...(extra || {}) }); searchEl.dispatchEvent(ev); return ev.defaultPrevented; };
      const hl = () => [...document.querySelectorAll('.search-hl span')].map((s) => s.className + ':' + s.textContent);
      const hint = () => { const h = document.querySelector('.search-hint'); return { show: h.classList.contains('show'), text: h.textContent, h: h.getBoundingClientRect().height }; };
      const r = {};
      __qa.clear(); resetPopupState(); await tick();
      // Greyed chips: with is:image, the pinned chip (a text clip) has nothing behind it.
      await type('is:image'); await new Promise((res) => setTimeout(res, 80)); rerenderList();
      const pinChip = document.querySelector('#groupFilters [data-filter="__pinned__"]');
      r.pinChip = pinChip ? { dis: pinChip.getAttribute('aria-disabled'), cls: pinChip.className, title: pinChip.title } : null;
      if (pinChip) { pinChip.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true })); pinChip.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, button: 2 })); }
      await tick();
      r.afterInertClicks = searchEl.value;
      searchBox.openOptions(); await tick();
      const opt = (label) => [...document.querySelectorAll('.facet-opt')].find((b) => b.textContent.trim() === label);
      const over500 = opt('Over 500 chars');
      r.over500 = over500 ? { disabled: over500.disabled, cls: over500.className, title: over500.title } : null;
      const last24 = opt('Last 24h');
      r.last24 = last24 ? { disabled: last24.disabled } : null;
      r.richHidden = !opt('Rich');
      searchBox.closeOptions({ instant: true });
      // Invalid token: only the key is painted, ONE hint line, the fix rewrites it.
      await type('titel:foo');
      r.invalidHl = hl();
      r.invalidHint = hint();
      const fix = document.querySelector('.search-hint-fix');
      if (fix) fix.click();
      await tick();
      r.afterFix = searchEl.value;
      await type('is:pin');
      r.validPrefixHint = hint().show;
      // Regex error (a finished /regex/ term).
      await type('/(ab/ x');
      r.regexHint = hint();
      await type('');
      r.noHint = hint();
      // Ghost: a key being typed shows its rest; Tab takes it.
      await type('ti');
      r.ghost = (document.querySelector('.search-hl .qh-ghost') || {}).textContent || '';
      r.ghostTab = key('Tab');
      r.afterGhost = searchEl.value;
      // Unique value: filled in with the inserted part selected; Space keeps it.
      await type('is:mu');
      r.autoFill = { value: searchEl.value, sel: [searchEl.selectionStart, searchEl.selectionEnd] };
      key(' ');
      r.afterSpace = searchEl.value;
      // Esc parks the list until the text changes.
      await type('is:');
      r.openBeforeEsc = searchBox.isSuggestOpen();
      r.escConsumed = key('Escape');
      r.openAfterEsc = searchBox.isSuggestOpen();
      searchEl.dispatchEvent(new KeyboardEvent('keyup', { bubbles: true, key: 'ArrowLeft' }));
      r.stillParked = !searchBox.isSuggestOpen();
      await type('is:t');
      r.unparked = searchBox.isSuggestOpen() || searchEl.value === 'is:text';
      // Empty-result nudge.
      await type('qa clip mk1 is:image');
      const nudge = document.querySelector('.list-empty .empty-nudge-btn');
      r.nudge = nudge ? nudge.textContent : null;
      if (nudge) nudge.click();
      await tick(); rerenderList();
      r.afterNudge = { value: searchEl.value, rows: clipList.ids().length };
      // Paste: a multi-word plain text becomes one phrase; Ctrl+Shift+V pastes raw.
      await type('');
      const paste = (text) => { const dt = new DataTransfer(); dt.setData('text/plain', text || 'hello big world'); const ev = new ClipboardEvent('paste', { bubbles: true, cancelable: true, clipboardData: dt }); searchEl.dispatchEvent(ev); return ev.defaultPrevented; };
      r.pasteQuoted = paste(); r.pasteValue = searchEl.value;
      await type('');
      // A multi-line paste stays raw (a phrase could not match across the line break).
      r.multiLinePrevented = paste('hello big\\nworld'); r.multiLineValue = searchEl.value;
      await type('');
      key('V', { ctrlKey: true, shiftKey: true });
      r.rawPastePrevented = paste(); r.rawPasteValue = searchEl.value;
      await type('');
      __qa.clear(); resetPopupState();
      return r;
    })()`);
    check('greyed chip: nothing behind it under the other filters (aria-disabled + reason)', sbx.pinChip && sbx.pinChip.dis === 'true' && /is-disabled/.test(sbx.pinChip.cls) && /No matches with the current filters/.test(sbx.pinChip.title), JSON.stringify(sbx.pinChip));
    check('greyed chip is inert (click and right-click change nothing)', sbx.afterInertClicks === 'is:image', sbx.afterInertClicks);
    check('panel: a structurally impossible option is greyed fainter with a reason', sbx.over500 && sbx.over500.disabled && /dis-structural/.test(sbx.over500.cls) && /is:image/.test(sbx.over500.title), JSON.stringify(sbx.over500));
    check('panel: an option that still matches stays enabled; an absent kind is hidden', sbx.last24 && !sbx.last24.disabled && sbx.richHidden, JSON.stringify({ last24: sbx.last24, richHidden: sbx.richHidden }));
    check('invalid token: only the bad key is painted', JSON.stringify(sbx.invalidHl).includes('qh-unknown:titel:') && !sbx.invalidHl.some((s) => s.startsWith('qh-unknown:foo')), JSON.stringify(sbx.invalidHl));
    check('invalid token: one hint line with "Did you mean"', sbx.invalidHint.show && /Did you mean title:\?/.test(sbx.invalidHint.text), JSON.stringify(sbx.invalidHint));
    check('the hint\'s fix rewrites the key', sbx.afterFix === 'title:foo', sbx.afterFix);
    check('a valid prefix is never flagged while typed', !sbx.validPrefixHint);
    check('a broken /regex/ term shows its error', sbx.regexHint.show && /regular expression/.test(sbx.regexHint.text), JSON.stringify(sbx.regexHint));
    check('no hint = the line takes 0 px', !sbx.noHint.show, JSON.stringify(sbx.noHint));
    check('ghost completion painted in the mirror; Tab takes it', sbx.ghost === 'tle:' && sbx.ghostTab && sbx.afterGhost === 'title:', JSON.stringify({ g: sbx.ghost, v: sbx.afterGhost }));
    check('a unique value auto-fills with the inserted part selected; Space keeps it', sbx.autoFill.value === 'is:multiline' && sbx.autoFill.sel[0] === 5 && sbx.autoFill.sel[1] === 12 && sbx.afterSpace === 'is:multiline ', JSON.stringify(sbx.autoFill) + ' ' + JSON.stringify(sbx.afterSpace));
    check('Esc closes the list and parks it until the text changes', sbx.openBeforeEsc && sbx.escConsumed && !sbx.openAfterEsc && sbx.stillParked && sbx.unparked, JSON.stringify({ b: sbx.openBeforeEsc, c: sbx.escConsumed, a: sbx.openAfterEsc, p: sbx.stillParked, u: sbx.unparked }));
    check('empty result: the nudge names the blocker (no second "No matches") and one click drops it', /^is:image: \d+ outside this filter/.test(sbx.nudge || '') && sbx.afterNudge.value === 'qa clip mk1' && sbx.afterNudge.rows > 0, JSON.stringify({ n: sbx.nudge, a: sbx.afterNudge }));
    check('a multi-word paste is quoted as one phrase', sbx.pasteQuoted && sbx.pasteValue === '"hello big world"', sbx.pasteValue);
    check('a multi-line paste is not quoted', !sbx.multiLinePrevented && sbx.multiLineValue === '', JSON.stringify(sbx.multiLineValue));
    check('Ctrl+Shift+V pastes raw (no quoting)', !sbx.rawPastePrevented && sbx.rawPasteValue === '', JSON.stringify(sbx.rawPasteValue));
    // The ONE focus state: an unfocused window shows neither the accent line nor
    // "Search..."; a focused one shows both.
    // The sandbox window's OS focus is not ours to take, so the window's focus
    // is stood in for (document.hasFocus) and announced with window blur/focus.
    const focusPair = async (win, target) => cdp.eval(`(async () => {
      document.hasFocus = () => ${win ? 'true' : 'false'};
      const el = ${target || 'searchEl'};
      if (el !== searchEl) regexBtn.closest('.bc-reveal').classList.add('open'); // the tools show while the row is focused
      el.focus();
      window.dispatchEvent(new Event('${win ? 'focus' : 'blur'}'));
      const row = document.querySelector('.search-row');
      const out = { hasFocus: document.hasFocus(), active: document.activeElement === el, lit: row.classList.contains('is-focused'), ph: searchEl.placeholder };
      await new Promise((r) => setTimeout(r, 250)); // past the underline's colour transition
      out.line = getComputedStyle(row).boxShadow;
      delete document.hasFocus;
      return out;
    })()`);
    const unfocused = await focusPair(false);
    const focusedWin = await focusPair(true);
    check('focus state: window unfocused = no accent line AND the idle placeholder', !unfocused.hasFocus && !unfocused.lit && unfocused.ph === 'Click here to search...' && unfocused.line !== focusedWin.line, JSON.stringify(unfocused));
    check('focus state: field + window focused = accent line AND "Search..."', focusedWin.hasFocus && focusedWin.lit && focusedWin.ph === 'Search...', JSON.stringify(focusedWin));
    const onTool = await focusPair(true, 'regexBtn');
    check('focus state: Tab onto a field button keeps the accent line AND "Search..." together', onTool.active && onTool.lit && onTool.ph === 'Search...', JSON.stringify(onTool));

    // 17. Navigation guard (LAST: a failure would replace the popup page): a
    //     renderer navigation, as a file dropped on the window triggers, is refused.
    await cdp.eval(`(location.href = 'file:///C:/Windows/win.ini', true)`).catch(() => {});
    await sleep(1500);
    const still = await cdp.eval(`({ href: location.href, list: !!document.getElementById('list') })`).catch((e) => ({ error: e.message }));
    check('a BoardClip window never navigates away (dropped files)', still && /index\.html/.test(still.href || '') && still.list, JSON.stringify(still));

    // Renderer exceptions land in the diagnostics file (Core.installRendererErrorReporting).
    await sleep(500);
    const diagFile = path.join(sb.dataDir, 'boardclip-diagnostics.jsonl');
    const diagLines = fs.existsSync(diagFile) ? fs.readFileSync(diagFile, 'utf8').split('\n') : [];
    const errs = diagLines.filter((l) => l.includes('renderer.error'));
    check('no renderer errors recorded', errs.length === 0, errs[0]);
    if (process.platform === 'win32') {
      // Closed = parked (cloaked), never a real hide: a park failure logs popup.park_failed.
      const pf = diagLines.find((l) => l.includes('"popup.park_failed"') || l.includes('"popup.unpark_failed"'));
      check('popup parks (cloaked) instead of hiding, so it opens without the Windows show animation', !pf, pf && pf.slice(0, 160));
    }
  } finally {
    // Stops ONLY this sandbox's processes (matched by its own dir), removes its
    // dir and this checkout's boardclip.pid if the sandbox wrote it, and fails
    // the run on a safety problem (dir left, window not cloaked).
    cleanup = await sb.finish();
  }
  if (summary().failed || !cleanup.ok) process.exit(1);
}

main().catch((err) => { console.error('qa error:', err.message); process.exit(1); });
