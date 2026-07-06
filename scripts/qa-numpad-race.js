'use strict';

// Real-Electron reproduction of the numpad quick-paste restore race, using the
// ACTUAL system clipboard (Electron `clipboard`) and the REAL orchestrator
// (lib/quick-paste.js). It is SAFE — it never synthesizes a real Ctrl+V into
// another window. Instead it models the target app as a probe that reads the
// clipboard `D` ms after the (would-be) paste, which is exactly the mechanism
// behind "pastes old stuff, worse under lag".
//
//   * Experiment A: sweep the target read-delay D and compare the OLD naive
//     fixed-150ms-restore timeline against the new orchestrator. Shows the
//     naive path pasting STALE content once D outruns its fixed delay, and the
//     orchestrator staying correct across a much wider window.
//   * Experiment B: inject real main-thread lag and show the orchestrator's
//     measured-lag-adaptive restore delay growing to compensate.
//
// Run: node_modules/electron/dist/electron.exe scripts/qa-numpad-race.js
// (or: npx electron scripts/qa-numpad-race.js)

const { app, clipboard } = require('electron');
const { createQuickPaster } = require('../lib/quick-paste');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const busy = (ms) => { const end = Date.now() + ms; while (Date.now() < end) { /* burn CPU */ } };

// The pre-fix numpadPaste() timeline, verbatim in spirit: fixed 15ms settle,
// paste, fixed 150ms, restore.
async function naivePaste(macro, scheduleTargetRead) {
  const backup = clipboard.readText();
  clipboard.writeText(macro);
  await sleep(15);
  scheduleTargetRead();            // "Ctrl+V" — target will read after D
  await sleep(150);
  clipboard.writeText(backup);     // restore previous clipboard
}

// One trial: set OLD clipboard, run `paster` (naive or orchestrator), model a
// target that reads D ms after the paste, return what the target observed.
async function trial(label, D, runPaste, macro) {
  clipboard.writeText('OLD-CLIPBOARD');
  let observed = null;
  let firedAt = 0;
  const scheduleTargetRead = () => {
    const t0 = Date.now();
    setTimeout(() => { observed = clipboard.readText(); firedAt = Date.now() - t0; }, D);
  };
  await runPaste(macro, scheduleTargetRead);
  // Wait until the probe has definitely fired, then a margin for any restore.
  await sleep(D + 250);
  return { label, D, observed, macro, correct: observed === macro, firedAt };
}

async function experimentA() {
  console.log('\n=== Experiment A: target read-delay sweep (real clipboard) ===');
  console.log('For each delay D (ms the target waits before reading the clipboard),');
  console.log('did it read the MACRO (correct) or STALE restored content (the bug)?\n');

  const delays = [50, 140, 200, 300, 400, 500, 700];

  // Orchestrator wired to the real clipboard. paste = schedule the target read.
  let pending = null;
  const qp = createQuickPaster({
    snapshot: () => ({ text: clipboard.readText() }),
    restore: (b) => clipboard.writeText(b.text),
    writeItem: (item) => clipboard.writeText(item.text),
    clipboardMatchesItem: (item) => clipboard.readText() === String(item.text || ''),
    paste: () => { if (pending) pending(); return Promise.resolve({ ok: true }); },
    sleep,
    getConfig: () => ({ restore: true, minRestoreDelayMs: 400 }),
  });

  const rows = [];
  for (const D of delays) {
    const naive = await trial('naive', D, naivePaste, `MACRO-naive-${D}`);
    const robust = await trial('robust', D, (macro, sched) => {
      pending = sched;
      return qp.request({ text: macro }, { coalesceKey: `t${D}` }).then(() => { pending = null; });
    }, `MACRO-robust-${D}`);
    rows.push({ D, naive: naive.correct, robust: robust.correct, naiveGot: naive.observed, robustGot: robust.observed });
  }

  console.log('  D(ms) | naive fixed-150 | robust orchestrator');
  console.log('  ------+-----------------+--------------------');
  for (const r of rows) {
    const n = r.naive ? 'macro  ✓' : 'STALE  ✗';
    const b = r.robust ? 'macro  ✓' : 'STALE  ✗';
    console.log(`  ${String(r.D).padStart(5)} |   ${n}      |   ${b}`);
  }
  const naiveFails = rows.filter(r => !r.naive).length;
  const robustFails = rows.filter(r => !r.robust).length;
  console.log(`\n  naive pasted stale content in ${naiveFails}/${rows.length} delays; robust in ${robustFails}/${rows.length}.`);
  return { naiveFails, robustFails, total: rows.length };
}

async function experimentB() {
  console.log('\n=== Experiment B: lag-adaptive restore delay ===');
  console.log('Injecting real main-thread lag; the orchestrator measures it and');
  console.log('extends its pre-restore delay so a laggy machine waits longer.\n');

  const results = [];
  for (const lagMs of [0, 60, 150, 300]) {
    let captured = null;
    const qp = createQuickPaster({
      snapshot: () => ({ text: clipboard.readText() }),
      restore: (b) => clipboard.writeText(b.text),
      writeItem: (item) => clipboard.writeText(item.text),
      clipboardMatchesItem: (item) => clipboard.readText() === String(item.text || ''),
      paste: () => Promise.resolve({ ok: true }),
      sleep,
      now: () => Date.now(),
      log: (event, data) => { if (event === 'quick_paste.timed_wait') captured = data; },
      getConfig: () => ({ restore: true, minRestoreDelayMs: 400 }),
    });
    clipboard.writeText('OLD');
    // Background system-wide lag: busy-loop bursts make every setTimeout overrun,
    // which is what the orchestrator's scheduler-lag probe samples.
    let stop = false;
    const spin = () => { if (stop) return; busy(lagMs); setTimeout(spin, 5); };
    if (lagMs) spin();
    await qp.request({ text: `MACRO-lag-${lagMs}` }, {});
    stop = true;
    results.push({ lagMs, measured: captured ? Math.round(captured.lag_ms) : null, restoreDelay: captured ? Math.round(captured.restore_delay_ms) : null });
  }

  console.log('  injected lag | measured lag | restore delay');
  console.log('  -------------+--------------+--------------');
  for (const r of results) {
    console.log(`  ${String(r.lagMs).padStart(11)} | ${String(r.measured).padStart(12)} | ${String(r.restoreDelay).padStart(13)}`);
  }
  const grew = results[results.length - 1].restoreDelay > results[0].restoreDelay;
  console.log(`\n  restore delay ${grew ? 'GREW with lag ✓' : 'did NOT grow ✗'}`);
  return { grew, results };
}

app.whenReady().then(async () => {
  try {
    const a = await experimentA();
    const b = await experimentB();
    console.log('\n=== Verdict ===');
    console.log(`Experiment A: naive stale in ${a.naiveFails}/${a.total}, robust stale in ${a.robustFails}/${a.total}.`);
    console.log(`Experiment B: adaptive restore delay ${b.grew ? 'responds to lag' : 'FAILED to respond'}.`);
    app.exit(a.robustFails < a.naiveFails && b.grew ? 0 : 1);
  } catch (e) {
    console.error('harness error:', e && e.stack || e);
    app.exit(2);
  }
});
