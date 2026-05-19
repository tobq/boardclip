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
  directoryBytes,
  copyMissingFiles,
  syncMissingFiles,
};
