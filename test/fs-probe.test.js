'use strict';
// A wedged cloud mount must never be able to block the app: every probe has a
// deadline, a path that failed is hidden until its backoff expires, and a probe
// that never returns is never duplicated (each one holds a libuv threadpool
// thread for ever - that is how one bad drive letter kills all async I/O).
const assert = require('assert');
const path = require('path');
const { probePath, createPathHealth } = require('../lib/fs-probe');

const never = () => new Promise(() => {});
// probePath unrefs its deadline timer so a probe can never delay app quit -
// which means an unref'd timer is ALL that is pending here, and node would exit
// (code 0, zero assertions run) before the first await resolved. Hold the loop.
const keepAlive = setInterval(() => {}, 1000);

(async () => {
  // 1. A stat that never settles resolves false AT THE DEADLINE, not never.
  const startedAt = Date.now();
  assert.strictEqual(await probePath('X:/wedged', { timeoutMs: 40, fsp: { stat: never } }), false);
  assert.ok(Date.now() - startedAt < 2000, 'probe must not outlive its deadline');

  // 2. Real filesystem: a directory that exists, and one that does not.
  assert.strictEqual(await probePath(__dirname, { timeoutMs: 2000 }), true);
  assert.strictEqual(await probePath(path.join(__dirname, 'no-such-dir-xyz'), { timeoutMs: 2000 }), false);
  assert.strictEqual(await probePath('', { timeoutMs: 2000 }), false);

  // 3. An unknown path is optimistically usable, so a healthy machine is
  //    unchanged by any of this.
  let clock = 1000;
  const transitions = [];
  const probed = [];
  let probeResult = false;
  const health = createPathHealth({
    backoffMs: 100,
    maxBackoffMs: 400,
    now: () => clock,
    probe: target => { probed.push(target); return Promise.resolve(probeResult); },
    onTransition: t => transitions.push(t),
  });
  assert.strictEqual(health.usable('G:/drive'), true);

  // 4. A failure hides the path, and inside the backoff window nothing is probed.
  health.markFailure('G:/drive', 'read timeout');
  assert.strictEqual(health.usable('G:/drive'), false);
  assert.strictEqual(await health.check('G:/drive'), false);
  assert.strictEqual(probed.length, 0, 'no probe inside the backoff window');

  // 5. Once the backoff expires one probe runs; success brings the path back.
  clock += 150;
  probeResult = true;
  assert.strictEqual(await health.check('G:/drive'), true);
  assert.deepStrictEqual(probed, ['G:/drive']);
  assert.strictEqual(health.usable('G:/drive'), true);
  assert.deepStrictEqual(transitions.map(t => t.healthy), [false, true], 'down then up, once each');

  // 6. Backoff doubles per failure and is capped.
  clock = 10000;
  health.markFailure('G:/drive', 'timeout');
  assert.strictEqual(health.snapshot()['G:/drive'].retryAt - clock, 100);
  health.markFailure('G:/drive', 'timeout');
  assert.strictEqual(health.snapshot()['G:/drive'].retryAt - clock, 200);
  health.markFailure('G:/drive', 'timeout');
  health.markFailure('G:/drive', 'timeout');
  assert.strictEqual(health.snapshot()['G:/drive'].retryAt - clock, 400, 'backoff is capped');

  // 7. THE important one: a probe that never returns is never duplicated, and
  //    the path stays hidden while it is outstanding.
  let started = 0;
  const wedged = createPathHealth({
    backoffMs: 0,
    now: () => clock,
    probe: () => { started += 1; return never(); },
  });
  wedged.markFailure('H:/wedged', 'timeout');
  wedged.check('H:/wedged');
  wedged.check('H:/wedged');
  await Promise.resolve();
  await Promise.resolve();
  assert.strictEqual(started, 1, 'a hung probe is never duplicated');
  assert.strictEqual(wedged.usable('H:/wedged'), false, 'hidden while its probe is outstanding');
  assert.strictEqual(wedged.snapshot()['H:/wedged'].probing, true);

  // 8. markSuccess clears the failure count, forget drops the path entirely.
  wedged.markSuccess('H:/wedged');
  assert.strictEqual(wedged.usable('H:/wedged'), true);
  assert.strictEqual(wedged.snapshot()['H:/wedged'].failures, 0);
  wedged.forget('H:/wedged');
  assert.deepStrictEqual(wedged.snapshot(), {});

  // 9. Source guards: the two call sites that actually froze the app must never
  //    go back to a synchronous fs call on a mount.
  const fs = require('fs');
  const discovery = fs.readFileSync(path.join(__dirname, '..', 'lib', 'cloud-accounts.js'), 'utf8');
  assert.ok(!/fs\.existsSync\(/.test(discovery), 'cloud-accounts.js must probe mounts, never fs.existsSync');
  const main = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8');
  assert.ok(!/fs\.mkdirSync\(dir, \{ recursive: true \}\);/.test(main), 'the sync watcher must not mkdirSync a provider path');
  assert.ok(!/if \(!fs\.existsSync\(normalized\)\) fs\.mkdirSync\(normalized/.test(main), 'setSyncPathEnabled must not stat a provider path synchronously');

  clearInterval(keepAlive);
  console.log('fs-probe tests passed');
})().catch(error => { clearInterval(keepAlive); console.error(error); process.exit(1); });
