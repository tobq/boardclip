'use strict';

// Worker-thread entry for the history backup snapshot.
//
// The content-addressed snapshot hashes every stored item (~10k on a mature
// history) and then runs retention over the pool. Done inline on the main
// process that was 0.6s median / 2.4s p90 / 5.8s worst of blocking per
// clipboard capture (measured 2026-09-02 on a 9.7k-item, 7.7MB history), and
// every popup open queued behind it. The main process now hands over the
// PREVIOUS on-disk history + settings JSON strings (the pre-write state the
// time-machine records) and carries on; the result comes back as one message.
//
// Pure Node (fs + crypto via lib/backup.js); no Electron APIs, so it also runs
// under plain `node` in tests.

const { parentPort, workerData } = require('worker_threads');
const backupStore = require('./backup');

function parseJson(text) {
  return JSON.parse(String(text || '').replace(/^\uFEFF/, ''));
}

function run(data) {
  const { baseDir, historyJson, settingsJson, reason, createdAt, source, prune } = data;
  const parsed = parseJson(historyJson);
  const history = Array.isArray(parsed) ? parsed : [];
  let settings = null;
  if (settingsJson) {
    try { settings = parseJson(settingsJson); } catch { settings = null; }
  }
  const result = backupStore.writeSnapshot(baseDir, {
    history,
    settings,
    reason,
    createdAt: new Date(createdAt),
    source,
  });
  const pruned = prune ? backupStore.pruneBackups(baseDir, { ...prune, now: Date.now() }) : null;
  return { manifestPath: result.manifestPath, count: result.manifest.count, pruned };
}

try {
  parentPort.postMessage({ ok: true, ...run(workerData) });
} catch (err) {
  parentPort.postMessage({ ok: false, error: err && err.message ? err.message : String(err) });
}
