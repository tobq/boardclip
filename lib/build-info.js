const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

function runGit(baseDir, args) {
  try {
    return execFileSync('git', args, {
      cwd: baseDir,
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 1000,
    }).trim() || null;
  } catch {
    return null;
  }
}

function resolveGitDirs(baseDir) {
  const dotGit = path.join(baseDir, '.git');
  try {
    if (fs.statSync(dotGit).isDirectory()) return [dotGit];
  } catch {}

  try {
    const text = fs.readFileSync(dotGit, 'utf-8').trim();
    const match = text.match(/^gitdir:\s*(.+)$/);
    if (!match) return [];

    const gitDir = path.resolve(baseDir, match[1]);
    try {
      const commonDir = path.resolve(gitDir, fs.readFileSync(path.join(gitDir, 'commondir'), 'utf-8').trim());
      return [...new Set([gitDir, commonDir])];
    } catch {
      return [gitDir];
    }
  } catch {
    return [];
  }
}

function readCommitFromGitFiles(baseDir) {
  const gitDirs = resolveGitDirs(baseDir);
  if (!gitDirs.length) return null;

  try {
    const head = fs.readFileSync(path.join(gitDirs[0], 'HEAD'), 'utf-8').trim();
    if (!head.startsWith('ref: ')) return head;

    const ref = head.slice(5);
    for (const gitDir of gitDirs) {
      try {
        return fs.readFileSync(path.join(gitDir, ref), 'utf-8').trim();
      } catch {}
    }

    for (const gitDir of gitDirs) {
      try {
        for (const line of fs.readFileSync(path.join(gitDir, 'packed-refs'), 'utf-8').split(/\r?\n/)) {
          if (line.endsWith(` ${ref}`)) return line.slice(0, 40);
        }
      } catch {}
    }
  } catch {}
  return null;
}

function getBuildInfo(baseDir) {
  const envCommit = process.env.CLIPBOARD_TRAY_COMMIT || process.env.GIT_COMMIT || process.env.COMMIT_SHA;
  const envTag = process.env.CLIPBOARD_TRAY_TAG || process.env.GIT_TAG;
  const fullCommit = envCommit || runGit(baseDir, ['rev-parse', 'HEAD']) || readCommitFromGitFiles(baseDir);
  const commit = fullCommit ? fullCommit.trim().slice(0, 7) : null;
  const tag = envTag || runGit(baseDir, ['describe', '--tags', '--exact-match', 'HEAD']);
  const dirty = !!runGit(baseDir, ['status', '--porcelain']);
  const commitLabel = commit ? `${commit}${dirty ? '-dirty' : ''}` : null;
  const label = tag && commitLabel ? `${tag} (${commitLabel})` : (commitLabel || tag || 'unknown');

  return { tag, commit, dirty, label };
}

module.exports = getBuildInfo;
