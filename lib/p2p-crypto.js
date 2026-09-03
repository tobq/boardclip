'use strict';

// Body encryption for P2P sync v2. Every /delta request and response body is
// AES-256-GCM sealed with a key derived (HKDF-SHA256) from the shared
// `p2p_secret`, so clipboard contents are unreadable to anyone sharing the Wi-Fi.
// The HMAC request signature (lib/hmac-auth.js) is unchanged and is computed
// over the SEALED bytes: authentication of the request stays exactly as v1, the
// GCM tag additionally binds the plaintext.
//
// Wire shape: iv(12) | tag(16) | ciphertext. A fresh random IV per message.

const crypto = require('crypto');

const IV_BYTES = 12;
const TAG_BYTES = 16;
const KEY_BYTES = 32;
const HKDF_SALT = 'boardclip';
const HKDF_INFO = 'boardclip-p2p-v2-aes-256-gcm';

function deriveKey(secret) {
  const material = String(secret || '');
  if (!material) throw new Error('p2p-crypto: empty secret');
  return Buffer.from(crypto.hkdfSync('sha256', material, HKDF_SALT, HKDF_INFO, KEY_BYTES));
}

function seal(key, plain) {
  const iv = crypto.randomBytes(IV_BYTES);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const body = Buffer.isBuffer(plain) ? plain : Buffer.from(String(plain), 'utf8');
  const encrypted = Buffer.concat([cipher.update(body), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), encrypted]);
}

function open(key, sealed) {
  if (!Buffer.isBuffer(sealed) || sealed.length < IV_BYTES + TAG_BYTES) {
    throw new Error('p2p-crypto: sealed body too short');
  }
  const iv = sealed.subarray(0, IV_BYTES);
  const tag = sealed.subarray(IV_BYTES, IV_BYTES + TAG_BYTES);
  const encrypted = sealed.subarray(IV_BYTES + TAG_BYTES);
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(encrypted), decipher.final()]);
}

function sealJson(key, value) {
  return seal(key, Buffer.from(JSON.stringify(value), 'utf8'));
}

function openJson(key, sealed) {
  return JSON.parse(open(key, sealed).toString('utf8'));
}

module.exports = { deriveKey, seal, open, sealJson, openJson, IV_BYTES, TAG_BYTES };
