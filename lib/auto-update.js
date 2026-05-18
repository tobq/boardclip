'use strict';

const fs = require('fs');
const https = require('https');
const path = require('path');
const { spawn } = require('child_process');

const DEFAULT_REPO = {
  owner: 'tobq',
  repo: 'boardclip',
  branch: 'main',
};

const DEFAULT_POLL_MS = 4 * 60 * 60 * 1000;
const STARTUP_DELAY_MS = 90 * 1000;

function requestJson(url, timeoutMs = 10000) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, {
      headers: {
        'Accept': 'application/vnd.github+json',
        'User-Agent': 'BoardClip auto-update',
        'X-GitHub-Api-Version': '2022-11-28',
      },
      timeout: timeoutMs,
    }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', chunk => { body += chunk; });
      res.on('end', () => {
        if (res.statusCode < 200 || res.statusCode >= 300) {
          reject(new Error(`GitHub returned ${res.statusCode}`));
          return;
        }
        try {
          resolve(JSON.parse(body));
        } catch (error) {
          reject(error);
        }
      });
    });
    req.on('timeout', () => req.destroy(new Error('GitHub request timed out')));
    req.on('error', reject);
  });
}

async function latestCommitSha(repo = DEFAULT_REPO) {
  const url = `https://api.github.com/repos/${repo.owner}/${repo.repo}/commits/${encodeURIComponent(repo.branch)}`;
  const data = await requestJson(url);
  return data && data.sha ? String(data.sha) : null;
}

function updateScriptPath(appDir, platform = process.platform) {
  return platform === 'win32'
    ? path.win32.join(appDir, 'update.bat')
    : path.posix.join(appDir, 'update.sh');
}

function canAutoUpdate(appDir, buildInfo) {
  if (!buildInfo || !buildInfo.fullCommit) return false;
  if (buildInfo.dirty) return false;
  return fs.existsSync(path.join(appDir, '.git')) && fs.existsSync(updateScriptPath(appDir));
}

function spawnAndCapture(command, args, options = {}) {
  return new Promise((resolve) => {
    const child = spawn(command, args, options);
    let stdout = '';
    let stderr = '';
    if (child.stdout) child.stdout.on('data', chunk => { stdout += chunk; });
    if (child.stderr) child.stderr.on('data', chunk => { stderr += chunk; });
    child.on('error', error => resolve({ code: 1, stdout, stderr, error }));
    child.on('close', code => resolve({ code, stdout, stderr }));
  });
}

function runGit(appDir, args) {
  return spawnAndCapture('git', args, {
    cwd: appDir,
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });
}

async function changedFilesBetween(appDir, before, after) {
  if (!before || !after || before === after) return [];
  const result = await runGit(appDir, ['diff', '--name-only', before, after]);
  if (result.code !== 0) return [];
  return result.stdout.split(/\r?\n/).map(line => line.trim()).filter(Boolean);
}

function canHotReloadFile(file) {
  return file === 'index.html' || file.startsWith('site/shared/');
}

function updateModeForChangedFiles(files) {
  if (!files.length) return 'none';
  return files.every(canHotReloadFile) ? 'reload' : 'relaunch';
}

function runUpdate(appDir, platform = process.platform, { applyOnly = false } = {}) {
  const script = updateScriptPath(appDir, platform);
  const env = {
    ...process.env,
    ...(applyOnly ? { BOARDCLIP_UPDATE_NO_START: '1' } : {}),
  };
  const command = platform === 'win32' ? 'cmd.exe' : 'sh';
  const args = platform === 'win32' ? ['/c', script] : [script];
  const options = platform === 'win32'
    ? {
        cwd: appDir,
        detached: !applyOnly,
        stdio: applyOnly ? ['ignore', 'pipe', 'pipe'] : 'ignore',
        windowsHide: true,
        env,
      }
    : {
        cwd: appDir,
        detached: !applyOnly,
        stdio: applyOnly ? ['ignore', 'pipe', 'pipe'] : 'ignore',
        env,
      };

  const child = spawn(command, args, options);
  if (applyOnly) {
    return new Promise((resolve) => {
      let stdout = '';
      let stderr = '';
      if (child.stdout) child.stdout.on('data', chunk => { stdout += chunk; });
      if (child.stderr) child.stderr.on('data', chunk => { stderr += chunk; });
      child.on('error', error => resolve({ code: 1, stdout, stderr, error }));
      child.on('close', code => resolve({ code, stdout, stderr }));
    });
  }
  child.unref();
  return { detached: true };
}

function createAutoUpdater({
  appDir,
  buildInfo,
  repo = DEFAULT_REPO,
  pollMs = DEFAULT_POLL_MS,
  startupDelayMs = STARTUP_DELAY_MS,
  logger = console,
  onReload,
  onRelaunch,
  onBuildInfoChanged,
} = {}) {
  let checking = false;
  let updating = false;
  let timer = null;
  let currentCommit = buildInfo && buildInfo.fullCommit;

  async function check({ manual = false } = {}) {
    if (checking || updating) return { ok: false, status: 'busy' };
    if (!canAutoUpdate(appDir, buildInfo)) return { ok: false, status: 'unsupported' };

    checking = true;
    try {
      const latest = await latestCommitSha(repo);
      const current = currentCommit || buildInfo.fullCommit;
      if (!latest) return { ok: false, status: 'unknown' };
      if (latest === current) return { ok: true, status: 'current', latest };

      updating = true;
      logger.log(`BoardClip update available: ${current.slice(0, 7)} -> ${latest.slice(0, 7)}`);
      const updateResult = await runUpdate(appDir, process.platform, { applyOnly: true });
      if (updateResult.code !== 0) {
        const message = updateResult.error ? updateResult.error.message : (updateResult.stderr || updateResult.stdout || 'update failed');
        throw new Error(message.trim());
      }

      const changedFiles = await changedFilesBetween(appDir, current, latest);
      const mode = updateModeForChangedFiles(changedFiles);
      currentCommit = latest;
      if (onBuildInfoChanged) onBuildInfoChanged();

      if (mode === 'reload' && onReload) {
        await onReload({ latest, changedFiles });
        updating = false;
        return { ok: true, status: 'reloaded', latest, changedFiles, mode };
      }

      if (onRelaunch) {
        await onRelaunch({ latest, changedFiles, mode });
        return { ok: true, status: 'relaunching', latest, changedFiles, mode };
      }

      runUpdate(appDir);
      return { ok: true, status: 'updating', latest, changedFiles, mode };
    } catch (error) {
      if (manual) logger.error(`BoardClip update check failed: ${error.message}`);
      updating = false;
      return { ok: false, status: 'error', error };
    } finally {
      checking = false;
    }
  }

  function start() {
    if (!canAutoUpdate(appDir, buildInfo)) return;
    setTimeout(() => check(), startupDelayMs).unref();
    timer = setInterval(() => check(), pollMs);
    timer.unref();
  }

  function stop() {
    if (timer) clearInterval(timer);
    timer = null;
  }

  return { check, start, stop };
}

module.exports = {
  DEFAULT_REPO,
  DEFAULT_POLL_MS,
  STARTUP_DELAY_MS,
  canAutoUpdate,
  changedFilesBetween,
  createAutoUpdater,
  latestCommitSha,
  runUpdate,
  updateScriptPath,
  updateModeForChangedFiles,
};
