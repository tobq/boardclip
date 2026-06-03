'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { ensureDirectory, findDirectoryBlocker } = require('../lib/ensure-directory');

function tempRoot() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'boardclip-ensure-dir-'));
}

{
  const root = tempRoot();
  const target = path.join(root, 'clipboard-images');
  fs.writeFileSync(target, 'not a directory');
  const result = ensureDirectory(target);
  assert.strictEqual(fs.statSync(target).isDirectory(), true);
  assert.strictEqual(fs.existsSync(result.moved), true);
  assert.strictEqual(fs.readFileSync(result.moved, 'utf-8'), 'not a directory');
}

{
  const root = tempRoot();
  const blocker = path.join(root, 'BoardClip');
  const target = path.join(blocker, 'clipboard-images');
  fs.writeFileSync(blocker, 'not a directory');
  assert.strictEqual(findDirectoryBlocker(target), blocker);
  const result = ensureDirectory(target);
  assert.strictEqual(fs.statSync(target).isDirectory(), true);
  assert.strictEqual(fs.existsSync(result.moved), true);
  assert.strictEqual(fs.readFileSync(result.moved, 'utf-8'), 'not a directory');
}

console.log('ensure directory tests passed');
