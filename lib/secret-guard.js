'use strict';

// Secret guard: heuristic detection of likely credentials in clipboard text.
//
// Clipboards routinely hold passwords, API keys, tokens and 2FA codes. Even when
// a clip sits in a group the user shared with AI, we default to NOT handing the
// raw value to an assistant if it looks like a secret. Detection is also surfaced
// in the BoardClip UI so the user can see which clips are risky.
//
// This is a heuristic, not a guarantee. It errs toward caught-but-benign over
// missed-secret for the obvious high-signal shapes, while trying to avoid
// flagging ordinary prose/URLs/code. A per-clip `shareAnyway` override (handled
// by the caller) clears the withhold for false positives.

// High-signal vendor/token prefixes and structured credential shapes. Each entry
// is [label, regex]. Matching any one marks the text as a likely secret.
const TOKEN_PATTERNS = [
  ['jwt', /\beyJ[a-zA-Z0-9_-]{8,}\.[a-zA-Z0-9_-]{8,}\.[a-zA-Z0-9_-]{8,}\b/],
  ['openai', /\bsk-(?:proj-|live-|test-)?[A-Za-z0-9_-]{16,}\b/],
  ['anthropic', /\bsk-ant-[A-Za-z0-9_-]{16,}\b/],
  ['github', /\b(?:ghp|gho|ghu|ghs|ghr|github_pat)_[A-Za-z0-9_]{20,}\b/],
  ['gitlab', /\bglpat-[A-Za-z0-9_-]{16,}\b/],
  ['slack', /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/],
  ['stripe', /\b(?:sk|pk|rk)_(?:live|test)_[A-Za-z0-9]{16,}\b/],
  ['google', /\bAIza[0-9A-Za-z_-]{30,}\b/],
  ['aws_akid', /\b(?:AKIA|ASIA|AGPA|AIDA|AROA|ANPA)[0-9A-Z]{12,}\b/],
  ['sendgrid', /\bSG\.[A-Za-z0-9_-]{16,}\.[A-Za-z0-9_-]{16,}\b/],
  ['npm', /\bnpm_[A-Za-z0-9]{30,}\b/],
  ['private_key', /-----BEGIN (?:RSA |EC |OPENSSH |PGP |DSA )?PRIVATE KEY-----/],
  ['hex_secret', /\b[a-f0-9]{40,}\b/i],
  ['uuid_secret', /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/i],
];

// "key: value" style assignments where the key name implies a secret.
const ASSIGNMENT_RE = /\b(pass(?:word|wd|phrase)?|secret|api[_-]?key|access[_-]?key|client[_-]?secret|auth[_-]?token|bearer|private[_-]?key|credential|session[_-]?token)\b\s*[:=]\s*\S{4,}/i;

const HEX_RE = /^[a-f0-9]+$/i;
const BASE64ISH_RE = /^[A-Za-z0-9+/_=-]+$/;

// Shannon entropy in bits/char. High-entropy tokens (random keys) score ~4-6;
// natural-language words score ~2-3.
function shannonEntropy(str) {
  if (!str) return 0;
  const counts = Object.create(null);
  for (const ch of str) counts[ch] = (counts[ch] || 0) + 1;
  let entropy = 0;
  const len = str.length;
  for (const ch in counts) {
    const p = counts[ch] / len;
    entropy -= p * Math.log2(p);
  }
  return entropy;
}

// A single "word" looks like a random high-entropy secret if it is long, has no
// whitespace, draws from a base64/hex-ish alphabet, and has high entropy.
function looksLikeHighEntropyToken(token) {
  if (token.length < 24 || token.length > 4096) return false;
  if (!BASE64ISH_RE.test(token)) return false;
  // Pure long hex / long base64-ish with mixed classes is suspicious.
  const hasLower = /[a-z]/.test(token);
  const hasUpper = /[A-Z]/.test(token);
  const hasDigit = /[0-9]/.test(token);
  const classes = (hasLower ? 1 : 0) + (hasUpper ? 1 : 0) + (hasDigit ? 1 : 0);
  const entropy = shannonEntropy(token);
  if (HEX_RE.test(token)) return token.length >= 40;
  // Require both decent entropy and alphabet diversity to avoid flagging long
  // single-case slugs / identifiers.
  return entropy >= 3.6 && classes >= 2;
}

// Returns { isSecret, reason } for a piece of text.
function inspect(text) {
  const value = String(text == null ? '' : text);
  if (!value) return { isSecret: false, reason: null };

  if (ASSIGNMENT_RE.test(value)) return { isSecret: true, reason: 'credential-assignment' };

  for (const [label, re] of TOKEN_PATTERNS) {
    if (re.test(value)) return { isSecret: true, reason: label };
  }

  // Whitespace-delimited token entropy check. Scan EVERY token (not just when the
  // value is "tokeny") so a key embedded in prose / multi-line text (e.g. a pasted
  // .env file) is still caught. looksLikeHighEntropyToken is strict enough
  // (length + base64 alphabet + entropy + class diversity) that ordinary words,
  // URLs, and paths don't trip it.
  for (const word of value.trim().split(/\s+/)) {
    if (looksLikeHighEntropyToken(word)) return { isSecret: true, reason: 'high-entropy' };
  }

  return { isSecret: false, reason: null };
}

function isLikelySecret(text) {
  return inspect(text).isSecret;
}

// Placeholder shown to the AI in place of a withheld value.
const REDACTION_MARKER = '[likely secret, hidden]';

module.exports = {
  inspect,
  isLikelySecret,
  shannonEntropy,
  looksLikeHighEntropyToken,
  REDACTION_MARKER,
};
