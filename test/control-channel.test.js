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
  console.log('control channel tests passed');
}

main().catch(err => { console.error(err); process.exit(1); });
