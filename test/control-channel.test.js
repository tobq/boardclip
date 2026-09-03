'use strict';

const assert = require('assert');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { ControlServer } = require('../lib/control-server');
const controlClient = require('../lib/control-client');

const SECRET = crypto.randomBytes(16).toString('hex');
const PIPE = process.platform === 'win32'
  ? `\\\\.\\pipe\\boardclip-test-${process.pid}`
  : path.join(os.tmpdir(), `boardclip-test-${process.pid}.sock`);

const discovery = { pipePath: PIPE, secret: SECRET, dataDir: os.tmpdir() };

// A pre-keepalive helper: same signed envelope, no `keepalive` flag, and it
// takes the FIRST line it receives as the response.
function rawRequest(payload) {
  const net = require('net');
  const hmacAuth = require('../lib/hmac-auth');
  const body = JSON.stringify(payload);
  const ts = Date.now();
  const sig = hmacAuth.sign(SECRET, 'action', '/action', ts, hmacAuth.bodyHash(Buffer.from(body)));
  return new Promise((resolve, reject) => {
    const conn = net.connect(PIPE);
    let buf = '';
    conn.setEncoding('utf8');
    conn.on('connect', () => conn.write(`${JSON.stringify({ id: ts, method: 'action', path: '/action', ts, sig, body })}\n`));
    conn.on('data', chunk => {
      buf += chunk;
      const i = buf.indexOf('\n');
      if (i >= 0) { conn.destroy(); resolve(JSON.parse(buf.slice(0, i))); }
    });
    conn.on('error', reject);
  });
}

async function main() {
  // Before the server starts, the client reports app_not_running.
  await assert.rejects(
    controlClient.request('action', '/action', { tool: 'noop' }, { discovery, timeoutMs: 1000 }),
    err => err.code === 'app_not_running'
  );

  const seen = [];
  const server = new ControlServer({
    pipePath: PIPE,
    secret: SECRET,
    handleRequest: async (reqPath, payload) => {
      seen.push({ reqPath, payload });
      if (payload.tool === 'boom') throw new Error('explode');
      return { echoed: payload.tool, path: reqPath };
    },
  });
  await server.start();

  // Happy path round-trip.
  const res = await controlClient.request('action', '/action', { tool: 'pin_clip', id: 'x' }, { discovery });
  assert.deepStrictEqual(res, { echoed: 'pin_clip', path: '/action' });
  assert.strictEqual(seen.length, 1);
  assert.strictEqual(seen[0].payload.id, 'x');

  // Handler error surfaces as a rejection with the message.
  await assert.rejects(
    controlClient.request('action', '/action', { tool: 'boom' }, { discovery }),
    err => /explode/.test(err.message)
  );

  // Wrong secret is rejected as unauthorized (handler never runs).
  const before = seen.length;
  await assert.rejects(
    controlClient.request('action', '/action', { tool: 'sneaky' }, { discovery: { pipePath: PIPE, secret: 'wrong' } }),
    err => /unauthorized/.test(err.message)
  );
  assert.strictEqual(seen.length, before, 'handler must not run for bad auth');

  await server.stop();

  // Keepalive: while the app is still working on a request (an approval prompt
  // is open) it pulses {pending:true}; an opted-in client treats timeoutMs as
  // MAX SILENCE, so a 300 ms budget survives a 900 ms handler.
  let sawSignal = null;
  const slow = new ControlServer({
    pipePath: PIPE,
    secret: SECRET,
    keepaliveMs: 100,
    handleRequest: async (reqPath, payload, ctx) => {
      if (payload.tool === 'slow') { await new Promise(r => setTimeout(r, 900)); return { done: true }; }
      if (payload.tool === 'wait_for_abort') {
        sawSignal = ctx && ctx.signal;
        await new Promise(r => { if (sawSignal.aborted) r(); else sawSignal.addEventListener('abort', r, { once: true }); });
        return { aborted: true };
      }
      return { echoed: payload.tool };
    },
  });
  await slow.start();
  const slowRes = await controlClient.request('action', '/action', { tool: 'slow' }, { discovery, timeoutMs: 300 });
  assert.deepStrictEqual(slowRes, { done: true }, 'keepalive frames must keep an opted-in client waiting');

  // A legacy client (no keepalive flag) must never see a pending frame: the
  // first line it receives is the final response.
  const legacy = await rawRequest({ tool: 'slow' });
  assert.strictEqual(legacy.ok, true, `legacy client got ${JSON.stringify(legacy)}`);
  assert.deepStrictEqual(legacy.result, { done: true });

  // The caller giving up (its timeout closes the socket) aborts the handler's
  // signal, so the app can drop the approval prompt instead of running the
  // action later for nobody.
  await assert.rejects(
    controlClient.request('action', '/action', { tool: 'wait_for_abort' }, { discovery, timeoutMs: 200, keepalive: false }),
    err => /control_timeout/.test(err.message)
  );
  for (let i = 0; i < 40 && !(sawSignal && sawSignal.aborted); i++) await new Promise(r => setTimeout(r, 50));
  assert.ok(sawSignal && sawSignal.aborted, 'handler signal must abort when the client disconnects');
  await slow.stop();
  console.log('control channel tests passed');
}

main().catch(err => { console.error(err); process.exit(1); });
