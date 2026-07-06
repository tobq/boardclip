'use strict';
// Robust quick-paste orchestrator (numpad slots + panel number keys).
//
// The failure this module fixes: BoardClip quick-paste must (1) put a saved
// item onto the clipboard, (2) synthesize Ctrl/Cmd+V into the foreground app,
// then (3) restore the user's previous clipboard. Steps 2 and 3 race — Ctrl+V
// is asynchronous (it only injects a keystroke; the target app reads the
// clipboard whenever it next drains its input queue), so a fixed delay before
// restoring the previous clipboard is unreliable. Under load the target reads
// AFTER we've already restored → it pastes the previous clip. That is the
// "pastes random old stuff, worse under lag" bug.
//
// The orchestrator makes the sequence robust regardless of platform strategy:
//   * SERIALIZES requests through a promise chain (rapid presses queue instead
//     of being dropped — no more "press it 3 times").
//   * COALESCES duplicate requests for the same slot inside a short window
//     (belt-and-suspenders against key auto-repeat that slips past the hook).
//   * VERIFIES the macro actually landed on the clipboard before pasting
//     (a synchronous write can still be observed late under contention).
//   * MEASURES real scheduler lag and ADAPTS the pre-restore delay to it, with
//     a generous floor/ceiling, so a laggy machine waits longer before restore.
//   * RESTORES SAFELY: only overwrites the clipboard if it still holds our
//     macro, so we never clobber something the user copied mid-sequence.
//
// Everything here is dependency-injected and pure so it runs under a plain-node
// test with a fake clipboard + a fake "late-reading target" (see
// test/numpad-paste.test.js). main.js wires the real Electron clipboard, the
// platform paste primitive, and a keystroke-injection strategy for text — a
// `skipClipboard` strategy bypasses the backup/restore entirely, so the race
// simply cannot happen (the clipboard is never written).

const DEFAULT_CONFIG = {
  restore: true,            // restore the user's previous clipboard afterwards
  verifyTries: 12,          // how many times to re-check the macro landed
  verifyIntervalMs: 8,      // spacing between verify checks (~100ms budget)
  minRestoreDelayMs: 400,   // floor before restoring (target needs time to read)
  maxRestoreDelayMs: 1200,  // ceiling so restore never hangs forever
  lagMultiplier: 3,         // restore delay grows this * measured scheduler lag
  coalesceMs: 90,           // drop same-key repeats that arrive within this window
};

function createQuickPaster(deps) {
  const {
    snapshot,               // () => opaque backup of current clipboard
    restore,                // (backup) => void — write backup back
    writeItem,              // (item) => void — put the macro on the clipboard
    clipboardMatchesItem,   // (item) => bool — does the clipboard hold the macro?
    paste,                  // async () => pasteResult — synthesize Ctrl/Cmd+V
    sleep,                  // (ms) => Promise
    now = () => Date.now(),
    log = () => {},
    getConfig = () => ({}),
    strategy = null,        // optional { deliver({item, backup, paste, sleep, log, config}) }
  } = deps;

  let chain = Promise.resolve();
  let running = false;
  const lastStartByKey = new Map();

  function config() {
    return { ...DEFAULT_CONFIG, ...(getConfig() || {}) };
  }

  // Wait until the clipboard actually reflects the macro. A synchronous
  // clipboard write can still be observed late while the system is busy, and
  // pasting before it lands is exactly how stale content sneaks through.
  async function verifySet(item, cfg, trace) {
    for (let attempt = 1; attempt <= cfg.verifyTries; attempt++) {
      let matched = false;
      try { matched = !!clipboardMatchesItem(item); } catch { matched = false; }
      if (matched) {
        if (attempt > 1) log('quick_paste.set_verified_late', { ...trace, attempts: attempt });
        return { ok: true, attempts: attempt };
      }
      if (attempt < cfg.verifyTries) await sleep(cfg.verifyIntervalMs);
    }
    log('quick_paste.set_unverified', { ...trace, attempts: cfg.verifyTries });
    return { ok: false, attempts: cfg.verifyTries };
  }

  // Measure how much longer than requested a short sleep actually took — a
  // direct read of current scheduler/system lag, which we fold into the
  // pre-restore delay so a laggy machine gives the target more time.
  async function measureLag(sampleMs) {
    const t0 = now();
    await sleep(sampleMs);
    return Math.max(0, (now() - t0) - sampleMs);
  }

  async function timedDeliver({ item, paste: doPaste, cfg, trace }) {
    writeItem(item);
    const verify = await verifySet(item, cfg, trace);
    // Scheduler-lag proxy: how much our own short sleeps overrun is a real
    // signal of local system load (a bogged machine both delays us AND makes
    // the target slower to read). Sample either side of the paste and take the
    // worse. It's a mild safety bump — the configured floor is the main lever;
    // we cannot measure the target process's read latency from here.
    const lagBefore = await measureLag(20);
    const pasteResult = await doPaste();
    const lagAfter = await measureLag(20);
    const lag = Math.max(lagBefore, lagAfter);
    const restoreDelay = Math.min(
      cfg.maxRestoreDelayMs,
      Math.max(cfg.minRestoreDelayMs, cfg.minRestoreDelayMs + lag * cfg.lagMultiplier),
    );
    log('quick_paste.timed_wait', { ...trace, lag_ms: Math.round(lag), restore_delay_ms: Math.round(restoreDelay) });
    await sleep(restoreDelay);
    return { consumed: false, verified: verify.ok, verifyAttempts: verify.attempts, pasteResult, restoreDelay };
  }

  async function runOne(item, opts) {
    const cfg = config();
    const trace = opts.trace || {};
    const startedAt = now();
    running = true;

    const useStrategy = !!(strategy && typeof strategy.deliver === 'function' && strategy.accepts(item, cfg));
    // A skipClipboard strategy (keystroke injection) never touches the clipboard,
    // so there is nothing to back up or restore — and no restore race at all.
    let touchesClipboard = !(useStrategy && strategy.skipClipboard);

    let backup = null;
    let outcome = { ok: false };
    try {
      // A request may supply its own paste primitive (e.g. macOS needs the
      // target app name captured at request time); otherwise use the dep.
      const doPaste = typeof opts.paste === 'function' ? opts.paste : paste;
      const deliverCtx = { item, backup: null, cfg, trace, paste: doPaste, sleep, log, now };

      if (touchesClipboard) { backup = snapshot(); deliverCtx.backup = backup; }
      let delivered = useStrategy ? await strategy.deliver(deliverCtx) : await timedDeliver(deliverCtx);

      // A skipClipboard strategy can decline at runtime (e.g. injection failed) —
      // fall back to the clipboard path. The clipboard is still untouched, so we
      // snapshot now and run the normal set + paste + restore sequence.
      if (delivered && delivered.fallback) {
        touchesClipboard = true;
        backup = snapshot();
        deliverCtx.backup = backup;
        log('quick_paste.fallback_to_clipboard', { ...trace });
        delivered = await timedDeliver(deliverCtx);
      }
      outcome = { ok: true, injected: !touchesClipboard, ...delivered };

      if (touchesClipboard && cfg.restore) {
        // Only restore if the clipboard still holds our macro. If it changed,
        // the user (or another app) put something new there — never clobber it.
        let stillMacro = true;
        try { stillMacro = !!clipboardMatchesItem(item); } catch { stillMacro = true; }
        // A strategy that confirmed real consumption is authoritative even if
        // the on-clipboard bytes were already handed off/relinquished.
        if (stillMacro || delivered.consumed) {
          try { restore(backup); outcome.restored = true; }
          catch (e) { outcome.restored = false; outcome.restoreError = e && e.message; }
        } else {
          outcome.restored = false;
          outcome.restoreSkipped = 'clipboard_changed';
          log('quick_paste.restore_skipped', { ...trace, reason: 'clipboard_changed' });
        }
      }
    } catch (e) {
      outcome = { ok: false, error: e && e.message };
      log('quick_paste.error', { ...trace, error: e && e.message });
    } finally {
      running = false;
      log('quick_paste.done', { ...trace, total_ms: now() - startedAt, ...summarize(outcome) });
    }
    return outcome;
  }

  function summarize(o) {
    return {
      injected: !!o.injected,
      consumed: !!o.consumed,
      verified: o.verified,
      restored: o.restored,
      restore_skipped: o.restoreSkipped,
    };
  }

  // Enqueue a quick-paste. Returns a promise for the outcome. Rapid presses
  // serialize; same-key repeats inside coalesceMs are dropped as duplicates.
  function request(item, opts = {}) {
    const cfg = config();
    const key = opts.coalesceKey != null ? String(opts.coalesceKey) : null;
    if (key != null) {
      const prev = lastStartByKey.get(key);
      if (prev != null && now() - prev < cfg.coalesceMs) {
        log('quick_paste.coalesced', { ...(opts.trace || {}), key });
        return Promise.resolve({ ok: false, coalesced: true });
      }
      lastStartByKey.set(key, now());
    }
    const next = chain.then(() => runOne(item, opts));
    // Keep the chain alive even if one op throws.
    chain = next.catch(() => {});
    return next;
  }

  return {
    request,
    busy: () => running,
    _config: config,
  };
}

module.exports = { createQuickPaster, DEFAULT_CONFIG };
