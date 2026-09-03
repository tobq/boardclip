'use strict';

// Local control channel - HELPER side (used by mcp/boardclip-mcp.js).
//
// Connects to the running app's named pipe / Unix socket, signs one request with
// the shared secret from the discovery file, and awaits the single-line JSON
// response. If the app is not running (no pipe), callers get a clean
// `app_not_running` error so MCP tools can tell the user to open BoardClip.
//
// `timeoutMs` is the longest SILENCE tolerated, not a hard deadline: the app
// pulses `{pending: true}` while it is still working (an approval prompt is
// open and the user is reading it), and every pulse re-arms the timer. Pass
// `keepalive: false` to get the old hard deadline.

const net = require('net');
const hmacAuth = require('./hmac-auth');
const mcpPaths = require('./mcp-paths');

const DEFAULT_TIMEOUT_MS = 60_000;

class AppNotRunningError extends Error {
  constructor(message = 'app_not_running') {
    super(message);
    this.code = 'app_not_running';
  }
}

// Send a single request and resolve with the `result` field, or reject.
function request(method, reqPath, payload, { discovery, timeoutMs = DEFAULT_TIMEOUT_MS, keepalive = true } = {}) {
  const disco = discovery || mcpPaths.readDiscovery();
  if (!disco || !disco.pipePath || !disco.secret) {
    return Promise.reject(new AppNotRunningError());
  }
  const body = JSON.stringify(payload || {});
  const ts = Date.now();
  const sig = hmacAuth.sign(disco.secret, method, reqPath, ts, hmacAuth.bodyHash(Buffer.from(body)));
  const wire = `${JSON.stringify({ id: ts, method, path: reqPath, ts, sig, body, keepalive: keepalive ? 1 : undefined })}\n`;

  return new Promise((resolve, reject) => {
    let settled = false;
    let buffer = '';
    let timer = null;
    const conn = net.connect(disco.pipePath);
    const done = (fn, arg) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try { conn.destroy(); } catch {}
      fn(arg);
    };
    const arm = () => {
      clearTimeout(timer);
      timer = setTimeout(() => done(reject, new Error('control_timeout')), timeoutMs);
    };
    arm();

    conn.setEncoding('utf8');
    conn.on('connect', () => {
      try { conn.write(wire); } catch (err) { done(reject, err); }
    });
    conn.on('data', chunk => {
      buffer += chunk;
      let index;
      while ((index = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, index);
        buffer = buffer.slice(index + 1);
        let res;
        try { res = JSON.parse(line); } catch { return done(reject, new Error('bad_response')); }
        // Still working (e.g. the approval prompt is open): keep waiting.
        if (res && res.pending) { arm(); continue; }
        if (res && res.ok) return done(resolve, res.result);
        return done(reject, new Error((res && res.error) || 'control_error'));
      }
    });
    conn.on('error', err => {
      if (err && (err.code === 'ENOENT' || err.code === 'ECONNREFUSED')) {
        return done(reject, new AppNotRunningError());
      }
      done(reject, err);
    });
  });
}

module.exports = { request, AppNotRunningError, DEFAULT_TIMEOUT_MS };
