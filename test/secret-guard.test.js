'use strict';

const assert = require('assert');
const guard = require('../lib/secret-guard');

// Vendor-shaped fixtures are assembled from split parts so no full provider-token
// literal sits in the committed source (GitHub secret-scanning push protection
// would otherwise block the commit). The runtime value is identical.
const j = (...p) => p.join('');
const GHP = j('ghp', '_AbCdEf0123456789AbCdEf0123456789abcd');

// --- Should be flagged as secrets ---
const SECRETS = [
  j('sk-proj-', 'abcdEFGH1234ijklMNOP5678qrstUVWX'),
  j('sk-ant-', 'api03-AbCdEfGhIjKlMnOpQrStUvWxYz0123'),
  GHP,
  j('github', '_pat_11ABCDEFG0123456789_abcdefghijklmnopqrstuvwxyz'),
  j('xoxb', '-1234567890-abcdefghijklmnop'),
  j('AKIA', 'IOSFODNN7EXAMPLE'),
  j('AIza', 'SyA1234567890abcdefghijklmnopqrstuvw'),
  j('eyJhbGciOiJIUzI1NiJ9', '.eyJzdWIiOiIxMjM0NTY3ODkwIn0.abc123def456ghi789'),
  'password: hunter2longenough',
  j('API_KEY=sk', '_live_51HabcdEFGijklMNOP'),
  'client_secret = aB3xYz9KmNpQrStUvWx',
  'AbCd1234EfGh5678IjKl9012MnOpQrStUvWx', // high-entropy mixed token
  'deadbeefdeadbeefdeadbeefdeadbeefdeadbeef', // 40-char hex
  '-----BEGIN RSA PRIVATE KEY-----',
  'a1b2c3d4-e5f6-7890-abcd-ef1234567890', // uuid-shaped
  // Secret embedded in multi-line / many-word text (the .env-paste case): the
  // high-entropy token must be caught even though the clip is not "tokeny".
  'staging environment notes for the team\nkey is AbCd1234EfGh5678IjKl9012MnOpQrStUvWx5678\nrotate it monthly please',
];

for (const s of SECRETS) {
  assert.strictEqual(guard.isLikelySecret(s), true, `expected secret: ${s}`);
}

// --- Should NOT be flagged (benign) ---
const BENIGN = [
  'Hello, can you summarise this for me?',
  'https://example.com/path/to/page?query=1',
  'The quick brown fox jumps over the lazy dog',
  'meeting at 3pm tomorrow with the design team',
  'function addToHistory(entry, matchFn) {',
  'npm install @modelcontextprotocol/sdk',
  'C:/Users/Tobi/code/clipboard-tray/main.js',
  'short', // too short to be high-entropy
  'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', // long but zero entropy (repeated)
  'this-is-a-normal-kebab-case-slug-for-a-title',
  '12345',
  '', // empty
  // Multi-line prose with no high-entropy token must NOT be flagged.
  'meeting notes from today\nwe discussed the roadmap and the launch timeline\nfollow up with the team next week',
];

for (const b of BENIGN) {
  assert.strictEqual(guard.isLikelySecret(b), false, `expected benign: ${b}`);
}

// inspect() returns a reason
{
  const r = guard.inspect(GHP);
  assert.strictEqual(r.isSecret, true);
  assert.strictEqual(r.reason, 'github');
}
{
  const r = guard.inspect('just some words here');
  assert.strictEqual(r.isSecret, false);
  assert.strictEqual(r.reason, null);
}

// entropy sanity: random > prose
assert.ok(guard.shannonEntropy('AbCd1234EfGh5678IjKl9012') > guard.shannonEntropy('aaaaaaaaaaaaaaaa'));

assert.strictEqual(guard.REDACTION_MARKER, '[likely secret, hidden]');

console.log('secret guard tests passed');
