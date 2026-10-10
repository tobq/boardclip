#!/usr/bin/env node
// `boardclip` command of the npm package (npm i -g @tobq/boardclip, npx @tobq/boardclip):
// starts the tray app with the Electron that npm installed beside it, detached
// so the terminal is free again and closing it does not take the app along.
// A second start only brings the running app's popup up (single-instance lock).
'use strict';

const { spawn } = require('child_process');
const path = require('path');

const appDir = path.join(__dirname, '..');
const args = process.argv.slice(2);

if (args.includes('--version') || args.includes('-v')) {
  console.log(require('../package.json').version);
  process.exit(0);
}

let electron;
try {
  electron = require('electron');
} catch (error) {
  console.error('BoardClip needs its Electron download. Reinstall with: npm i -g @tobq/boardclip');
  process.exit(1);
}

const env = { ...process.env };
// Set by some shells and tools; it would start Electron as plain Node.
delete env.ELECTRON_RUN_AS_NODE;

const child = spawn(electron, [appDir, ...args], {
  cwd: appDir,
  detached: true,
  stdio: 'ignore',
  windowsHide: true,
  env,
});
child.on('error', (error) => {
  console.error(`Could not start BoardClip: ${error.message}`);
  process.exit(1);
});
child.unref();
console.log('BoardClip is running in your menu bar / system tray.');
