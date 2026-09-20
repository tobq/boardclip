'use strict';
// The auto-updater must judge "up to date" against the commit the RUNNING
// process was started from, never against the on-disk HEAD: update.bat pulls
// before it relaunches, so a script that pulls and then fails leaves disk at
// the new commit while the process still runs the old one. From 2026-09-03 to
// 2026-09-20 exactly that happened on every update (a :: comment inside a ( )
// block aborted update.bat with a parse error, exit 255), the failure was
// swallowed because only manual checks logged, and every later poll compared
// disk HEAD == latest and reported "current" - the stale process ran until a
// human restarted it. These tests pin both halves of the fix, plus the guard
// that keeps :: out of ( ) blocks in every batch script.
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { createAutoUpdater } = require('../lib/auto-update');

const A = 'a'.repeat(40);
const B = 'b'.repeat(40);
const appDir = path.join(__dirname, '..'); // a real checkout: has .git + update scripts
const buildInfo = { fullCommit: A, dirty: false };

function harness({ latest, diskHead, applyCode = 0, applyStderr = '' }) {
  const events = [];
  const calls = { apply: 0, relaunch: 0, reload: 0 };
  const updater = createAutoUpdater({
    appDir,
    buildInfo,
    logger: { log() {}, error() {} },
    onEvent: (e) => events.push(e),
    onRelaunch: async () => { calls.relaunch += 1; },
    onReload: async () => { calls.reload += 1; },
    fetchLatest: async () => latest,
    readHead: async () => diskHead,
    readChangedFiles: async () => ['main.js'],
    applyUpdate: async () => { calls.apply += 1; return { code: applyCode, stdout: '', stderr: applyStderr }; },
  });
  return { updater, events, calls };
}

(async () => {
  // 1. Disk already pulled to B (an earlier apply half-succeeded) but the
  //    process runs A: the next poll must NOT say "current" - it must apply and
  //    relaunch.
  {
    const h = harness({ latest: B, diskHead: B });
    const result = await h.updater.check();
    assert.strictEqual(result.status, 'relaunching', 'stale process must be relaunched, not reported current');
    assert.strictEqual(h.calls.apply, 1);
    assert.strictEqual(h.calls.relaunch, 1);
    assert.deepStrictEqual(h.events.map(e => e.type), ['applied']);
    assert.strictEqual(h.events[0].from, A);
    assert.strictEqual(h.events[0].to, B);
  }

  // 2. Genuinely current: running commit == latest -> no apply, no events.
  {
    const h = harness({ latest: A, diskHead: A });
    const result = await h.updater.check();
    assert.strictEqual(result.status, 'current');
    assert.strictEqual(h.calls.apply, 0);
    assert.deepStrictEqual(h.events, []);
  }

  // 3. The script pulls then aborts (exit 255, the update.bat parse error):
  //    the failure is emitted with disk_head so the "disk ahead of process"
  //    state is readable from the diagnostics file, and the NEXT check retries
  //    instead of trusting the pulled disk HEAD.
  {
    const h = harness({ latest: B, diskHead: B, applyCode: 255, applyStderr: '. was unexpected at this time.' });
    const first = await h.updater.check();
    assert.strictEqual(first.status, 'error');
    assert.strictEqual(h.calls.relaunch, 0, 'a failed apply must never relaunch');
    assert.strictEqual(h.events.length, 1);
    assert.strictEqual(h.events[0].type, 'apply_failed');
    assert.strictEqual(h.events[0].code, 255);
    assert.strictEqual(h.events[0].disk_head, B);
    assert.strictEqual(h.events[0].message, '. was unexpected at this time.');

    const second = await h.updater.check();
    assert.strictEqual(second.status, 'error', 'still failing -> still reported, never "current"');
    assert.strictEqual(h.calls.apply, 2, 'the relaunch is retried on the next poll');
  }

  // 4. Guard: no :: label may sit inside a ( ) block in any batch script. cmd
  //    does not treat :: as a comment there; the line is parsed, a ) in it
  //    closes the block early, and the script dies with "was unexpected at
  //    this time" - silently, from the updater's point of view. Use rem.
  {
    const offenders = [];
    for (const dir of ['', 'scripts']) {
      const full = path.join(appDir, dir);
      if (!fs.existsSync(full)) continue;
      for (const name of fs.readdirSync(full)) {
        if (!/\.(bat|cmd)$/i.test(name)) continue;
        const lines = fs.readFileSync(path.join(full, name), 'utf8').split(/\r?\n/);
        let depth = 0;
        lines.forEach((line, i) => {
          if (depth > 0 && /^\s*::/.test(line)) offenders.push(`${path.join(dir, name)}:${i + 1}`);
          if (/\($/.test(line.trimEnd())) depth += 1;
          if (/^\s*\)/.test(line)) depth -= 1;
        });
      }
    }
    assert.deepStrictEqual(offenders, [], `:: comment inside a ( ) block (use rem): ${offenders.join(', ')}`);
  }

  console.log('auto-update tests passed');
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
