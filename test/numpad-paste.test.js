'use strict';
// Deterministic proof of the quick-paste restore race (M1) + regression tests
// for the robust orchestrator. No Electron: a fake clipboard models Windows
// semantics and a fake "target app" reads the clipboard at a configurable delay
// after Ctrl+V — exactly the mechanism behind "pastes old stuff under lag".

const assert = require('assert');
const { createQuickPaster } = require('../lib/quick-paste');

let passed = 0;
function ok(name) { passed++; console.log(`  ok - ${name}`); }

// A virtual clock so tests are deterministic and instant. setTimeout callbacks
// are queued by their absolute due time; advancing the clock drains them. A
// real setImmediate between virtual timers lets all pending promise jobs run
// (and register their next sleep) before we look for the next due timer —
// without it, fake timers + real promises deadlock.
function createClock() {
  let t = 0;
  const timers = [];
  const settle = () => new Promise(r => setImmediate(r));
  function sleep(ms) {
    return new Promise(resolve => { timers.push({ due: t + Math.max(0, ms), resolve }); });
  }
  async function advance(ms) {
    const target = t + ms;
    await settle();
    for (;;) {
      timers.sort((a, b) => a.due - b.due);
      const idx = timers.findIndex(x => x.due <= target);
      if (idx < 0) break;
      const next = timers.splice(idx, 1)[0];
      t = Math.max(t, next.due);
      next.resolve();
      await settle();
    }
    t = target;
    await settle();
  }
  return { sleep, advance, now: () => t };
}

// Fake clipboard: text-or-image slot, plus a fake target that reads at a delay.
function createFakeClipboard(clock) {
  let text = '';
  const api = {
    text: () => text,
    setText: (v) => { text = String(v || ''); },
    snapshot: () => ({ text }),
    restore: (s) => { text = s ? s.text : ''; },
    writeItem: (item) => { text = String(item.text || ''); },
    matches: (item) => text === String(item.text || ''),
    // Model a target app that processes Ctrl+V `delay` ms after it's sent and
    // reads whatever the clipboard holds at that instant.
    pasteWithTargetDelay(delay) {
      return () => {
        const readAt = clock.now() + delay;
        const p = (async () => {
          await clock.sleep(delay);
          api._lastPasted = text; // whatever is on the clipboard when target reads
          api._lastPastedAt = readAt;
        })();
        api._pendingTarget = p;
        return Promise.resolve({ ok: true });
      };
    },
  };
  return api;
}

function baseDeps(clip, clock, overrides = {}) {
  return {
    snapshot: clip.snapshot,
    restore: clip.restore,
    writeItem: clip.writeItem,
    clipboardMatchesItem: clip.matches,
    paste: clip.pasteWithTargetDelay(0),
    sleep: clock.sleep,
    now: clock.now,
    log: () => {},
    getConfig: () => ({}),
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// 1. Reproduce M1 with the OLD naive timeline (fixed 150ms restore).
//    A target that reads 300ms after Ctrl+V gets the RESTORED old clipboard.
// ---------------------------------------------------------------------------
async function reproOldRace() {
  const clock = createClock();
  const clip = createFakeClipboard(clock);
  clip.setText('OLD-CLIPBOARD');

  // Hand-rolled reproduction of the pre-fix numpadPaste() sequence.
  async function naivePaste(item, targetReadDelay) {
    const backup = clip.snapshot();
    clip.writeItem(item);                              // clipboard = macro
    await clock.sleep(15);
    const target = clip.pasteWithTargetDelay(targetReadDelay)();
    await clock.sleep(150);                            // fixed restore delay
    clip.restore(backup);                              // clipboard = OLD again
    await target;
  }

  const run = naivePaste({ text: 'MACRO-1' }, 300);
  await clock.advance(1000);
  await run;
  assert.strictEqual(clip._lastPasted, 'OLD-CLIPBOARD',
    'expected the OLD naive path to paste stale content when target reads late');
  ok('M1 reproduced: naive fixed-delay restore pastes stale clipboard under lag');
}

// ---------------------------------------------------------------------------
// 2. The robust orchestrator survives the SAME late-reading target because the
//    adaptive restore delay outlasts a realistic read, and restore only fires
//    after the target has read.
// ---------------------------------------------------------------------------
async function robustSurvivesLateRead() {
  const clock = createClock();
  const clip = createFakeClipboard(clock);
  clip.setText('OLD-CLIPBOARD');

  const qp = createQuickPaster(baseDeps(clip, clock, {
    paste: clip.pasteWithTargetDelay(120), // target reads 120ms after Ctrl+V
    getConfig: () => ({ minRestoreDelayMs: 220 }),
  }));

  const run = qp.request({ text: 'MACRO-1' }, {});
  await clock.advance(3000);
  await clip._pendingTarget;
  const outcome = await run;

  assert.strictEqual(clip._lastPasted, 'MACRO-1', 'target must read the macro, not stale content');
  assert.strictEqual(clip.text(), 'OLD-CLIPBOARD', 'previous clipboard must be restored afterwards');
  assert.ok(outcome.restored, 'restore should have happened');
  ok('robust orchestrator pastes the macro AND restores the previous clipboard');
}

// ---------------------------------------------------------------------------
// 3. Serialization: two rapid different-slot requests both run, in order,
//    and neither is dropped.
// ---------------------------------------------------------------------------
async function serializesRequests() {
  const clock = createClock();
  const clip = createFakeClipboard(clock);
  clip.setText('BASE');
  const order = [];

  const qp = createQuickPaster(baseDeps(clip, clock, {
    writeItem: (item) => { clip.setText(item.text); order.push(item.text); },
    paste: () => Promise.resolve({ ok: true }),
    getConfig: () => ({ minRestoreDelayMs: 100 }),
  }));

  const a = qp.request({ text: 'A' }, { coalesceKey: 'slot1' });
  const b = qp.request({ text: 'B' }, { coalesceKey: 'slot2' });
  await clock.advance(5000);
  await Promise.all([a, b]);

  assert.deepStrictEqual(order, ['A', 'B'], 'both requests run, in submission order');
  assert.strictEqual(clip.text(), 'BASE', 'clipboard restored to original after the last op');
  ok('rapid different-slot presses serialize instead of dropping');
}

// ---------------------------------------------------------------------------
// 4. Coalescing: a same-slot repeat inside the coalesce window is dropped,
//    modelling key auto-repeat that slipped past the hook.
// ---------------------------------------------------------------------------
async function coalescesRepeats() {
  const clock = createClock();
  const clip = createFakeClipboard(clock);
  clip.setText('BASE');
  let runs = 0;

  const qp = createQuickPaster(baseDeps(clip, clock, {
    writeItem: (item) => { clip.setText(item.text); runs++; },
    paste: () => Promise.resolve({ ok: true }),
    getConfig: () => ({ coalesceMs: 90, minRestoreDelayMs: 50 }),
  }));

  const first = qp.request({ text: 'A' }, { coalesceKey: 'slot1' });
  const dup = qp.request({ text: 'A' }, { coalesceKey: 'slot1' }); // immediate repeat
  await clock.advance(2000);
  const [r1, r2] = await Promise.all([first, dup]);

  assert.strictEqual(runs, 1, 'only one delivery for a coalesced repeat');
  assert.strictEqual(r2.coalesced, true, 'duplicate reported as coalesced');
  assert.ok(r1.ok, 'first request ran');
  ok('same-slot auto-repeat within window is coalesced to one paste');

  // A genuine second press AFTER the window is honored.
  await clock.advance(200);
  let runs2 = 0;
  const clip2 = createFakeClipboard(clock); clip2.setText('BASE');
  const qp2 = createQuickPaster(baseDeps(clip2, clock, {
    writeItem: (item) => { clip2.setText(item.text); runs2++; },
    paste: () => Promise.resolve({ ok: true }),
    getConfig: () => ({ coalesceMs: 90, minRestoreDelayMs: 50 }),
  }));
  const p1 = qp2.request({ text: 'A' }, { coalesceKey: 's' });
  await clock.advance(500);
  const p2 = qp2.request({ text: 'A' }, { coalesceKey: 's' });
  await clock.advance(2000);
  await Promise.all([p1, p2]);
  assert.strictEqual(runs2, 2, 'a deliberate later press is not coalesced');
  ok('deliberate second press after the window still runs');
}

// ---------------------------------------------------------------------------
// 5. verify-set retries until the macro is observable, then pastes.
// ---------------------------------------------------------------------------
async function verifiesSetBeforePaste() {
  const clock = createClock();
  const clip = createFakeClipboard(clock);
  clip.setText('OLD');
  let visibleAfter = 3; // macro only "observable" after 3 match checks
  let checks = 0;
  let pastedText = null;

  const qp = createQuickPaster(baseDeps(clip, clock, {
    writeItem: () => { /* write is "slow to propagate" */ },
    clipboardMatchesItem: () => { checks++; return checks >= visibleAfter; },
    paste: () => { pastedText = 'pasted-after-' + checks + '-checks'; return Promise.resolve({ ok: true }); },
    getConfig: () => ({ verifyTries: 12, verifyIntervalMs: 8, minRestoreDelayMs: 50, restore: false }),
  }));

  const run = qp.request({ text: 'MACRO' }, {});
  await clock.advance(2000);
  await run;
  assert.ok(checks >= visibleAfter, 'verify retried until the macro was observable');
  assert.ok(pastedText, 'paste happened after verify succeeded');
  ok('verify-set retries until the macro lands, then pastes');
}

// ---------------------------------------------------------------------------
// 6. safe restore: if the clipboard changed mid-sequence (user copied something
//    new), we do NOT clobber it.
// ---------------------------------------------------------------------------
async function safeRestoreSkipsWhenChanged() {
  const clock = createClock();
  const clip = createFakeClipboard(clock);
  clip.setText('OLD');

  const qp = createQuickPaster(baseDeps(clip, clock, {
    // Simulate the user copying something new right after paste: the clipboard
    // no longer matches our macro when it's time to restore.
    paste: () => { clip.setText('USER-COPIED-NEW'); return Promise.resolve({ ok: true }); },
    getConfig: () => ({ minRestoreDelayMs: 50 }),
  }));

  const run = qp.request({ text: 'MACRO' }, {});
  await clock.advance(2000);
  const outcome = await run;
  assert.strictEqual(clip.text(), 'USER-COPIED-NEW', 'must not clobber a new user copy');
  assert.strictEqual(outcome.restoreSkipped, 'clipboard_changed', 'restore skipped with reason');
  ok('safe restore never clobbers a clipboard the user changed mid-sequence');
}

// ---------------------------------------------------------------------------
// 7. REGRESSION (the numpad newline footgun): a multi-line snippet is delivered
//    as ONE clipboard write + ONE Ctrl/Cmd+V, with newlines preserved as
//    clipboard CONTENT — never as synthetic Enter key presses. There is a single
//    delivery mechanism (the keystroke-injection "type" strategy was removed
//    after it turned \n into Enter and spawned unintended sends), so numpad
//    behaves exactly like the panel-click paste.
// ---------------------------------------------------------------------------
async function multilineNeverTypesNewlines() {
  const clock = createClock();
  const clip = createFakeClipboard(clock);
  clip.setText('OLD');
  const MULTILINE = 'line one\n\nline two\nline three';
  let writes = 0, pastes = 0;

  const qp = createQuickPaster(baseDeps(clip, clock, {
    writeItem: (item) => { writes++; clip.writeItem(item); },
    // The ONLY delivery is a single Ctrl/Cmd+V; the fake target then reads
    // whatever sits on the clipboard. A per-character/keystroke path would show
    // up as >1 paste (or a mangled read) — impossible with one clipboard hand-off.
    paste: () => { pastes++; return clip.pasteWithTargetDelay(30)(); },
    getConfig: () => ({ minRestoreDelayMs: 120 }),
  }));

  const run = qp.request({ text: MULTILINE }, { coalesceKey: 'slot1' });
  await clock.advance(3000);
  await clip._pendingTarget;
  const outcome = await run;

  assert.strictEqual(writes, 1, 'exactly one clipboard write (no per-line typing)');
  assert.strictEqual(pastes, 1, 'exactly one paste for the whole snippet (no Enter-per-newline)');
  assert.strictEqual(clip._lastPasted, MULTILINE, 'target reads the full multi-line text verbatim, newlines intact');
  assert.strictEqual(clip.text(), 'OLD', 'previous clipboard restored afterwards');
  assert.ok(outcome.restored, 'restore happened');
  ok('multi-line snippet pastes once via clipboard — never types newlines as Enter');
}

(async () => {
  console.log('numpad-paste.test.js');
  await reproOldRace();
  await robustSurvivesLateRead();
  await serializesRequests();
  await coalescesRepeats();
  await verifiesSetBeforePaste();
  await safeRestoreSkipsWhenChanged();
  await multilineNeverTypesNewlines();
  console.log(`\n${passed} assertions passed`);
})().catch(e => { console.error('\nFAILED:', e && e.stack || e); process.exit(1); });
