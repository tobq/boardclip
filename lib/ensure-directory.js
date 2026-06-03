'use strict';

const fs = require('fs');
const path = require('path');

function pathPartsFromRoot(targetPath) {
  const resolved = path.resolve(targetPath);
  const parsed = path.parse(resolved);
  const rel = path.relative(parsed.root, resolved);
  if (!rel) return [];
  return rel.split(path.sep).filter(Boolean).reduce((parts, part) => {
    parts.push(path.join(parts.length ? parts[parts.length - 1] : parsed.root, part));
    return parts;
  }, []);
}

function findDirectoryBlocker(targetDir) {
  for (const part of pathPartsFromRoot(targetDir)) {
    try {
      if (fs.existsSync(part) && !fs.statSync(part).isDirectory()) return part;
    } catch {}
  }
  return '';
}

function moveFileAside(filePath) {
  const target = `${filePath}.file-conflict-${Date.now()}`;
  fs.renameSync(filePath, target);
  return target;
}

function ensureDirectory(dir) {
  try {
    if (fs.existsSync(dir)) {
      if (fs.statSync(dir).isDirectory()) return { ok: true };
      const moved = moveFileAside(dir);
      fs.mkdirSync(dir, { recursive: true });
      return { ok: true, moved, repaired: true };
    }
    fs.mkdirSync(dir, { recursive: true });
    return { ok: true };
  } catch (error) {
    if (!error || error.code !== 'ENOTDIR') throw error;
    const blocker = findDirectoryBlocker(dir);
    if (!blocker) throw error;
    const moved = moveFileAside(blocker);
    fs.mkdirSync(dir, { recursive: true });
    return { ok: true, moved, repaired: true };
  }
}

module.exports = {
  ensureDirectory,
  findDirectoryBlocker,
  pathPartsFromRoot,
};
