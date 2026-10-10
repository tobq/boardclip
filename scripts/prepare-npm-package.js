#!/usr/bin/env node
// Turns this checkout's package.json into the npm package's (npm i -g @tobq/boardclip,
// npx @tobq/boardclip), in place, for the release workflow's npm job:
//   node scripts/prepare-npm-package.js <version>
// - The name is scoped: npm refuses the bare "boardclip" as too close to the
//   existing "board-clip". The repo keeps "boardclip" (installer and .deb file
//   names come from it); the command is `boardclip` either way (bin).
// - Electron moves to "dependencies" (npm then downloads the right binary per
//   platform); in the repo it must stay a devDependency, which electron-builder
//   requires for the installers.
// - "files" = build.files (the one list of what the app needs at runtime, shared
//   with the installers and guarded by test/package-files.test.js) + bin/.
// - Scripts, devDependencies and the electron-builder config are dropped: none
//   of them mean anything to someone installing the package.
'use strict';

const fs = require('fs');
const path = require('path');

const version = process.argv[2];
if (!/^\d+\.\d+\.\d+$/.test(version || '')) {
  console.error('usage: node scripts/prepare-npm-package.js <major.minor.patch>');
  process.exit(1);
}

const file = path.join(__dirname, '..', 'package.json');
const pkg = JSON.parse(fs.readFileSync(file, 'utf8'));
const electron = pkg.devDependencies && pkg.devDependencies.electron;
if (!electron) throw new Error('package.json has no devDependencies.electron to move');

const NPM_NAME = '@tobq/boardclip';

const out = {};
for (const [key, value] of Object.entries(pkg)) {
  if (key === 'scripts' || key === 'devDependencies' || key === 'build') continue;
  out[key] = value;
}
out.name = NPM_NAME;
out.version = version;
out.dependencies = { ...pkg.dependencies, electron };
out.files = [...pkg.build.files.filter((f) => f !== 'package.json'), 'bin/**'];
out.engines = { node: '>=18' };

fs.writeFileSync(file, JSON.stringify(out, null, 2) + '\n');
console.log(`package.json ready for npm: ${NPM_NAME}@${version}, ${out.files.length} file patterns, electron ${electron}`);
