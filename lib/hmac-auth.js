'use strict';

// Shared HMAC request authentication.
//
// Used by BOTH the LAN P2P sync server (main.js) and the local MCP control
// channel (lib/control-server.js). Both are request/response channels that need
// to prove "this caller knows the shared secret" and reject replayed/stale
// requests, so the signing scheme lives here once instead of being duplicated.
//
// Signature is HMAC-SHA256 over `${method}\n${path}\n${timestamp}\n${bodyHash}`.
// The body hash binds the signature to the exact payload; the timestamp window
// bounds replay. Verification is constant-time.

const crypto = require('crypto');

const DEFAULT_WINDOW_MS = 60 * 1000;

function bodyHash(buffer) {
  return crypto.createHash('sha256').update(buffer || Buffer.alloc(0)).digest('hex');
}

function sign(secret, method, requestPath, timestamp, hashOfBody) {
  return crypto
    .createHmac('sha256', String(secret || ''))
    .update(`${method}\n${requestPath}\n${timestamp}\n${hashOfBody || ''}`)
    .digest('hex');
}

function timingSafeEqualHex(a, b) {
  try {
    const bufA = Buffer.from(String(a || ''), 'hex');
    const bufB = Buffer.from(String(b || ''), 'hex');
    if (bufA.length === 0 || bufA.length !== bufB.length) return false;
    return crypto.timingSafeEqual(bufA, bufB);
  } catch {
    return false;
  }
}

// Verify a signed request. `bodyHashHex` may be passed directly, or `body`
// (a Buffer) to hash here. `now`/`windowMs` are injectable for testing.
function verify(secret, {
  method,
  path: requestPath,
  timestamp,
  signature,
  body,
  bodyHashHex,
  now = Date.now(),
  windowMs = DEFAULT_WINDOW_MS,
} = {}) {
  const ts = Number(timestamp) || 0;
  if (!ts || Math.abs(now - ts) > windowMs) return false;
  const hashOfBody = bodyHashHex != null ? bodyHashHex : bodyHash(body || Buffer.alloc(0));
  const expected = sign(secret, method, requestPath, ts, hashOfBody);
  return timingSafeEqualHex(signature, expected);
}

// Build the headers a client sends. Mirrors the `x-boardclip-*` header names the
// P2P client already uses, so both channels speak the same wire format.
function signedHeaders(secret, deviceId, method, requestPath, body = Buffer.alloc(0), now = Date.now()) {
  const timestamp = now;
  const hashOfBody = bodyHash(body);
  return {
    'x-boardclip-device': deviceId || '',
    'x-boardclip-ts': String(timestamp),
    'x-boardclip-sig': sign(secret, method, requestPath, timestamp, hashOfBody),
  };
}

module.exports = {
  DEFAULT_WINDOW_MS,
  bodyHash,
  sign,
  verify,
  signedHeaders,
  timingSafeEqualHex,
};
