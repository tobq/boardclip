'use strict';

// Local control channel - APP side.
//
// A named pipe (Windows) / Unix domain socket (macOS/Linux) server, NOT an HTTP
// server: no TCP port, no firewall prompt. The standalone MCP helper connects
// here for the few actions that need the live app (approval modal, clipboard
// write, race-free mutation). Every request is HMAC-authed with the shared
// secret from the discovery file (defence-in-depth on top of the OS user-scoping
// of the pipe).
//
// Pure transport + auth + framing. The actual action dispatch is injected as
// `handleRequest(method, payload)` by main.js, so all mutation logic stays in the
// app and is never duplicated here.

const net = require('net');
const fs = require('fs');
const hmacAuth = require('./hmac-auth');

const MAX_LINE_BYTES = 4 * 1024 * 1024;

class ControlServer {
  constructor({ pipePath, secret, handleRequest, onError, windowMs }) {
    this.pipePath = pipePath;
    this.secret = secret;
    this.handleRequest = handleRequest;
    this.onError = onError || (() => {});
    this.windowMs = windowMs || hmacAuth.DEFAULT_WINDOW_MS;
    this.server = null;
  }

  start() {
    return new Promise((resolve, reject) => {
      // Clean up a stale unix socket from a previous run (Windows pipes don't
      // leave a filesystem artifact, so this is a no-op there).
      if (process.platform !== 'win32') {
        try { fs.rmSync(this.pipePath, { force: true }); } catch {}
      }
      this.server = net.createServer(conn => this._onConnection(conn));
      this.server.on('error', err => {
        this.onError(err);
        reject(err);
      });
      this.server.listen(this.pipePath, () => resolve(this.pipePath));
    });
  }

  stop() {
    return new Promise(resolve => {
      if (!this.server) return resolve();
      const server = this.server;
      this.server = null;
      try {
        server.close(() => {
          if (process.platform !== 'win32') {
            try { fs.rmSync(this.pipePath, { force: true }); } catch {}
          }
          resolve();
        });
      } catch {
        resolve();
      }
    });
  }

  _onConnection(conn) {
    conn.setEncoding('utf8');
    let buffer = '';
    conn.on('error', () => {});
    conn.on('data', chunk => {
      buffer += chunk;
      if (buffer.length > MAX_LINE_BYTES) {
        this._respond(conn, null, { ok: false, error: 'request_too_large' });
        conn.destroy();
        return;
      }
      let index;
      while ((index = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, index);
        buffer = buffer.slice(index + 1);
        if (line.trim()) this._handleLine(conn, line);
      }
    });
  }

  async _handleLine(conn, line) {
    let req;
    try {
      req = JSON.parse(line);
    } catch {
      return this._respond(conn, null, { ok: false, error: 'bad_json' });
    }
    const { id, method, path: reqPath, ts, sig, body } = req || {};
    const bodyStr = typeof body === 'string' ? body : '';
    const authed = hmacAuth.verify(this.secret, {
      method,
      path: reqPath,
      timestamp: ts,
      signature: sig,
      bodyHashHex: hmacAuth.bodyHash(Buffer.from(bodyStr)),
      windowMs: this.windowMs,
    });
    if (!authed) {
      return this._respond(conn, id, { ok: false, error: 'unauthorized' });
    }
    let payload = {};
    try { payload = bodyStr ? JSON.parse(bodyStr) : {}; } catch { payload = {}; }
    try {
      const result = await this.handleRequest(reqPath || method, payload);
      this._respond(conn, id, { ok: true, result });
    } catch (err) {
      this._respond(conn, id, { ok: false, error: (err && err.message) || 'error' });
    }
  }

  _respond(conn, id, payload) {
    try {
      conn.write(`${JSON.stringify({ id, ...payload })}\n`);
    } catch {}
  }
}

module.exports = { ControlServer };
