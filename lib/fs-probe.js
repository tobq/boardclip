'use strict';

// Bounded liveness for paths that may sit on a NETWORK or CLOUD mount.
//
// A wedged mount does not fail, it BLOCKS. On 2026-09-13 Google DriveFS hung and
// `fs.existsSync('G:\\My Drive')` never returned: the calling thread sat in an
// uninterruptible kernel wait (even `timeout 8 ls` could not kill it, and
// PowerShell itself hung enumerating drives). On Electron's main thread that is
// the whole app - BoardClip would not launch, the popup rendered blank, and one
// sync pass held `insideSync` for 29 minutes while `sync.skip_inside_sync`
// repeated every 30 s.
//
// Three rules, kept here so no call site has to remember them:
//   1. never touch such a path synchronously;
//   2. never wait on one without a deadline;
//   3. never run two probes of the same path at once - a hung probe keeps a
//      libuv threadpool thread for ever (there are 4 by default), so retrying a
//      wedged mount is how one bad drive letter takes every async read down
//      with it.

const DEFAULT_TIMEOUT_MS = 2000;
const DEFAULT_BACKOFF_MS = 30 * 1000;
const DEFAULT_MAX_BACKOFF_MS = 5 * 60 * 1000;

// Resolves true/false, never rejects, and never outlives `timeoutMs`. The
// underlying stat may stay pending for ever on a wedged mount; that is the one
// leaked threadpool thread `createPathHealth` then refuses to duplicate.
function probePath(target, { timeoutMs = DEFAULT_TIMEOUT_MS, fsp = require('fs').promises } = {}) {
  if (!target) return Promise.resolve(false);
  return new Promise(resolve => {
    let settled = false;
    let timer = null;
    const finish = value => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      resolve(value);
    };
    timer = setTimeout(() => finish(false), timeoutMs);
    if (timer.unref) timer.unref();
    try {
      fsp.stat(target).then(() => finish(true), () => finish(false));
    } catch {
      finish(false);
    }
  });
}

// Tracks which paths are answering. Unknown paths are optimistically usable, so
// a healthy machine behaves exactly as it always did; only a path that has
// actually failed is hidden, and only until a single-flight probe says it is
// back.
function createPathHealth({
  timeoutMs = DEFAULT_TIMEOUT_MS,
  backoffMs = DEFAULT_BACKOFF_MS,
  maxBackoffMs = DEFAULT_MAX_BACKOFF_MS,
  now = Date.now,
  probe = null,
  onTransition = null,
} = {}) {
  const runProbe = probe || (target => probePath(target, { timeoutMs }));
  const state = new Map();

  function entry(target) {
    let found = state.get(target);
    if (!found) {
      found = { healthy: true, failures: 0, retryAt: 0, pending: null };
      state.set(target, found);
    }
    return found;
  }

  function transition(target, healthy, reason) {
    const found = entry(target);
    const was = found.healthy;
    found.healthy = !!healthy;
    if (found.healthy) {
      found.failures = 0;
      found.retryAt = 0;
    } else {
      found.failures += 1;
      found.retryAt = now() + Math.min(maxBackoffMs, backoffMs * Math.pow(2, found.failures - 1));
    }
    if (was !== found.healthy && typeof onTransition === 'function') {
      try {
        onTransition({
          path: target,
          healthy: found.healthy,
          failures: found.failures,
          retryAt: found.retryAt,
          reason: reason || '',
        });
      } catch {}
    }
    return found.healthy;
  }

  return {
    // Synchronous, no I/O: safe to call on any hot path.
    usable(target) {
      const found = state.get(target);
      return !found || found.healthy;
    },
    // Re-probes a failed path once its backoff has expired. Returns the current
    // verdict immediately (never blocks) when a probe is already outstanding.
    check(target) {
      const found = entry(target);
      if (found.pending) return Promise.resolve(found.healthy);
      if (found.healthy) return Promise.resolve(true);
      if (now() < found.retryAt) return Promise.resolve(false);
      found.pending = Promise.resolve()
        .then(() => runProbe(target))
        .then(
          ok => { found.pending = null; return transition(target, !!ok, 'probe'); },
          error => { found.pending = null; return transition(target, false, (error && error.message) || 'probe failed'); }
        );
      return found.pending;
    },
    markFailure(target, reason) { return transition(target, false, reason); },
    markSuccess(target) { return transition(target, true, 'ok'); },
    forget(target) { state.delete(target); },
    snapshot() {
      const out = {};
      for (const [target, found] of state) {
        out[target] = { healthy: found.healthy, failures: found.failures, retryAt: found.retryAt, probing: !!found.pending };
      }
      return out;
    },
  };
}

module.exports = { probePath, createPathHealth, DEFAULT_TIMEOUT_MS };
