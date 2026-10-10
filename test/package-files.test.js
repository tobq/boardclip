'use strict';
// Every file the main process loads from the app folder must be in
// package.json build.files, which decides what goes into the installers, the
// DMG and the npm package. Until 10 Oct 2026 the list lacked editor.html,
// viewer.html, their preloads and the menu-bar icons, so every packaged build
// opened blank editor / image viewer windows; and icon.png, also copied by an
// extraResources entry, was left out of the app archive, so the tray icon was
// empty. Found by listing the shipped app.asar: nothing local packages the app.
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
const files = pkg.build.files;
const main = fs.readFileSync(path.join(root, 'main.js'), 'utf8');

// Glob subset build.files uses: exact paths and "dir/**".
function packaged(rel) {
  return files.some((pattern) => (pattern.endsWith('/**')
    ? rel.startsWith(pattern.slice(0, -2))
    : rel === pattern));
}

// path.join(SCRIPT_DIR, 'a', 'b.js') -> "a/b.js"
const loaded = new Set();
for (const m of main.matchAll(/path\.join\(SCRIPT_DIR,\s*((?:'[^']+'\s*,?\s*)+)\)/g)) {
  const parts = [...m[1].matchAll(/'([^']+)'/g)].map((x) => x[1]);
  loaded.add(parts.join('/'));
}
// Scripts that exist only in a git checkout (start-up and update helpers).
const checkoutOnly = new Set(['start.bat', '.git']);

assert.ok(loaded.size >= 10, `found the files main.js loads (${[...loaded].join(', ')})`);
for (const rel of loaded) {
  if (checkoutOnly.has(rel)) continue;
  assert.ok(fs.existsSync(path.join(root, rel)), `${rel} exists`);
  assert.ok(packaged(rel), `${rel} is loaded by main.js but missing from package.json build.files`);
}

// The @2x companions macOS picks up by itself.
for (const rel of ['icon@2x.png', 'iconTemplate@2x.png']) assert.ok(packaged(rel), `${rel} is packaged`);

// A file both in build.files and in extraResources is left out of the app
// archive (that is how icon.png went missing): keep extraResources clear of them.
for (const entry of pkg.build.extraResources || []) {
  const from = typeof entry === 'string' ? entry : entry.from;
  assert.ok(!packaged(from), `${from} is in both build.files and extraResources`);
}

// The npm package's command.
assert.strictEqual(pkg.bin && pkg.bin.boardclip, 'bin/boardclip.js');
assert.ok(fs.existsSync(path.join(root, 'bin', 'boardclip.js')), 'bin/boardclip.js exists');

console.log('package-files.test.js: every file main.js loads is packaged');
