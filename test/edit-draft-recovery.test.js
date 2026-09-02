'use strict';
// Guard: the startup orphan-draft recovery regex in main.js must accept the
// draft filenames main.js actually writes. On 2026-09-01 the editor session
// generator had gained a `-<seq>` suffix but EDIT_DRAFT_RE still expected the
// legacy `boardclip-edit-<12hex>-<ts>.txt` shape, so recoverOrphanedEdits silently
// skipped every in-flight draft after a crash (found after the OOM crash that day).
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const src = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8');

function extractRegex() {
  const m = src.match(/const EDIT_DRAFT_RE = (\/[^\n]+?\/[a-z]*);/);
  assert.ok(m, 'EDIT_DRAFT_RE must be defined in main.js');
  return new Function(`return ${m[1]};`)();
}

test('EDIT_DRAFT_RE matches the current draft filename shape (with -<seq>)', () => {
  const re = extractRegex();
  const baseHash = 'a'.repeat(64);
  const seq = 15;
  // Mirror of main.js: `boardclip-edit-${baseHash.slice(0, 12)}-${Date.now()}-${editSessionSeq}.txt`
  const name = `boardclip-edit-${baseHash.slice(0, 12)}-${Date.now()}-${seq}.txt`;
  assert.ok(re.test(name), `${name} must be recoverable`);
  assert.ok(src.includes('`boardclip-edit-${baseHash.slice(0, 12)}-${Date.now()}-${editSessionSeq}.txt`'),
    'draft filename generator changed - update this test and EDIT_DRAFT_RE together');
});

test('EDIT_DRAFT_RE still matches legacy names and never matches retired done- drafts', () => {
  const re = extractRegex();
  assert.ok(re.test('boardclip-edit-844a35e20756-1788136494216.txt'));
  assert.ok(!re.test('done-boardclip-edit-844a35e20756-1788136494216-15.txt'));
  assert.ok(!re.test('boardclip-edit-844a35e20756-1788136494216-15.txt.tmp'));
});
