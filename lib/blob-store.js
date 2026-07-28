'use strict';

const fs = require('fs');
const path = require('path');

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

function atomicWriteFile(filePath, data) {
  const tmpPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmpPath, data);
  fs.renameSync(tmpPath, filePath);
}

// ONE JSON text parser for every store read (local files AND remote provider
// files). Windows PowerShell's default UTF-8 writer prepends a BOM, which
// JSON.parse rejects — and a rejected parse is destructive here: the caller
// treats the store as empty and the next canonical write replaces it. Accept
// that valid document instead of silently discarding the user's data.
function parseJsonText(raw) {
  return JSON.parse(String(raw == null ? '' : raw).replace(/^\uFEFF/, ''));
}

function directoryBytes(dir) {
  let total = 0;
  try {
    for (const name of fs.readdirSync(dir)) {
      try {
        const stats = fs.statSync(path.join(dir, name));
        if (stats.isFile()) total += stats.size;
      } catch {}
    }
  } catch {}
  return total;
}

function copyMissingFiles(fromDir, toDir, options = {}) {
  const filter = typeof options.filter === 'function' ? options.filter : () => true;
  try { ensureDir(toDir); } catch { return; }

  let names = [];
  try { names = fs.readdirSync(fromDir); } catch { return; }

  for (const name of names) {
    if (!filter(name)) continue;
    const source = path.join(fromDir, name);
    const dest = path.join(toDir, name);
    try {
      if (!fs.statSync(source).isFile()) continue;
      if (!fs.existsSync(dest)) fs.copyFileSync(source, dest);
    } catch {}
  }
}

function syncMissingFiles(localDir, remoteDir, options = {}) {
  copyMissingFiles(remoteDir, localDir, options);
  copyMissingFiles(localDir, remoteDir, options);
}

module.exports = {
  ensureDir,
  atomicWriteFile,
  parseJsonText,
  directoryBytes,
  copyMissingFiles,
  syncMissingFiles,
};
