'use strict';

const assert = require('assert');
const crypto = require('crypto');
const auth = require('../lib/hmac-auth');

const SECRET = 'test-secret-0123456789';
const body = Buffer.from(JSON.stringify({ tool: 'delete_clip', id: 'txt:abc' }));

// A correctly signed request verifies.
{
  const now = 1_000_000;
  const headers = auth.signedHeaders(SECRET, 'device-1', 'POST', '/action', body, now);
  const ok = auth.verify(SECRET, {
    method: 'POST',
    path: '/action',
    timestamp: Number(headers['x-boardclip-ts']),
    signature: headers['x-boardclip-sig'],
    body,
    now,
  });
  assert.strictEqual(ok, true);
}

// Wrong secret is rejected.
{
  const now = 1_000_000;
  const headers = auth.signedHeaders(SECRET, 'd', 'POST', '/action', body, now);
  const ok = auth.verify('other-secret', {
    method: 'POST', path: '/action', timestamp: now, signature: headers['x-boardclip-sig'], body, now,
  });
  assert.strictEqual(ok, false);
}

// Tampered body is rejected (signature bound to body hash).
{
  const now = 1_000_000;
  const sig = auth.sign(SECRET, 'POST', '/action', now, auth.bodyHash(body));
  const tampered = Buffer.from(JSON.stringify({ tool: 'delete_clip', id: 'txt:OTHER' }));
  const ok = auth.verify(SECRET, { method: 'POST', path: '/action', timestamp: now, signature: sig, body: tampered, now });
  assert.strictEqual(ok, false);
}

// Tampered path/method is rejected.
{
  const now = 1_000_000;
  const sig = auth.sign(SECRET, 'POST', '/action', now, auth.bodyHash(body));
  assert.strictEqual(auth.verify(SECRET, { method: 'POST', path: '/other', timestamp: now, signature: sig, body, now }), false);
  assert.strictEqual(auth.verify(SECRET, { method: 'GET', path: '/action', timestamp: now, signature: sig, body, now }), false);
}

// Stale timestamp (outside window) is rejected; fresh is accepted.
{
  const signedAt = 1_000_000;
  const sig = auth.sign(SECRET, 'GET', '/read', signedAt, auth.bodyHash(Buffer.alloc(0)));
  const base = { method: 'GET', path: '/read', timestamp: signedAt, signature: sig, body: Buffer.alloc(0), windowMs: 60_000 };
  assert.strictEqual(auth.verify(SECRET, { ...base, now: signedAt + 30_000 }), true);
  assert.strictEqual(auth.verify(SECRET, { ...base, now: signedAt + 90_000 }), false);
  assert.strictEqual(auth.verify(SECRET, { ...base, now: signedAt - 90_000 }), false);
}

// Missing timestamp / signature is rejected.
{
  const now = 1_000_000;
  assert.strictEqual(auth.verify(SECRET, { method: 'GET', path: '/read', timestamp: 0, signature: 'ab', body: Buffer.alloc(0), now }), false);
  assert.strictEqual(auth.verify(SECRET, { method: 'GET', path: '/read', timestamp: now, signature: '', body: Buffer.alloc(0), now }), false);
}

// Signature comparison is length-safe (no throw on malformed hex).
{
  assert.strictEqual(auth.timingSafeEqualHex('zz', 'zz'), false);
  assert.strictEqual(auth.timingSafeEqualHex('', ''), false);
  const h = crypto.createHash('sha256').update('x').digest('hex');
  assert.strictEqual(auth.timingSafeEqualHex(h, h), true);
}

console.log('control auth tests passed');
