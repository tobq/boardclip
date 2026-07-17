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

function updateSupport(appDir, buildInfo, platform = process.platform, { updateMode = 'production' } = {}) {
  if (!buildInfo || !buildInfo.fullCommit) return { supported: false, reason: 'unknown-build' };
  if (!fs.existsSync(path.join(appDir, '.git'))) return { supported: false, reason: 'not-git-checkout' };
  if (!fs.existsSync(updateScriptPath(appDir, platform))) return { supported: false, reason: 'missing-update-script' };
  if (buildInfo.dirty && updateMode !== 'development') return { supported: false, reason: 'dirty-checkout' };
  return { supported: true, reason: 'supported' };
}

function canAutoUpdate(appDir, buildInfo, platform = process.platform) {
  return updateSupport(appDir, buildInfo, platform).supported;
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

async function gitHead(appDir) {
  const result = await runGit(appDir, ['rev-parse', 'HEAD']);
  return result.code === 0 ? result.stdout.trim() : null;
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

function updateEnvironment(baseEnv = process.env, { applyOnly = false, updateMode = 'production' } = {}) {
  return {
    ...baseEnv,
    ...(applyOnly ? { BOARDCLIP_UPDATE_NO_START: '1' } : {}),
    ...(updateMode === 'development' ? { BOARDCLIP_UPDATE_ALLOW_DIRTY: '1' } : {}),
  };
}

function runUpdate(appDir, platform = process.platform, { applyOnly = false, updateMode = 'production' } = {}) {
  const script = updateScriptPath(appDir, platform);
  const env = updateEnvironment(process.env, { applyOnly, updateMode });
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

  if (applyOnly) {
    return spawnAndCapture(command, args, options);
  }
  const child = spawn(command, args, options);
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
  getUpdateMode = () => 'production',
} = {}) {
  let checking = false;
  let updating = false;
  let startupTimer = null;
  let timer = null;
  let currentCommit = buildInfo && buildInfo.fullCommit;

  async function check({ manual = false } = {}) {
    if (checking || updating) return { ok: false, status: 'busy' };
    const updateMode = getUpdateMode();
    const support = updateSupport(appDir, buildInfo, process.platform, { updateMode });
    if (!support.supported) return { ok: false, status: 'unsupported', reason: support.reason };

    checking = true;
    try {
      const latest = await latestCommitSha(repo);
      const current = currentCommit || buildInfo.fullCommit;
      if (!latest) return { ok: false, status: 'unknown' };
      if (latest === current) return { ok: true, status: 'current', latest };

      updating = true;
      logger.log(`BoardClip update available: ${current.slice(0, 7)} -> ${latest.slice(0, 7)}`);
      const updateResult = await runUpdate(appDir, process.platform, { applyOnly: true, updateMode });
      if (updateResult.code !== 0) {
        const message = updateResult.error ? updateResult.error.message : (updateResult.stderr || updateResult.stdout || 'update failed');
        throw new Error(message.trim());
      }

      const updatedHead = await gitHead(appDir) || latest;
      const changedFiles = await changedFilesBetween(appDir, current, updatedHead);
      const mode = updateModeForChangedFiles(changedFiles);
      currentCommit = updatedHead;
      if (onBuildInfoChanged) onBuildInfoChanged();

      if (mode === 'reload' && onReload) {
        await onReload({ latest: updatedHead, changedFiles });
        updating = false;
        return { ok: true, status: 'reloaded', latest: updatedHead, changedFiles, mode };
      }

      if (onRelaunch) {
        await onRelaunch({ latest: updatedHead, changedFiles, mode });
        return { ok: true, status: 'relaunching', latest: updatedHead, changedFiles, mode };
      }

      runUpdate(appDir, process.platform, { updateMode });
      return { ok: true, status: 'updating', latest: updatedHead, changedFiles, mode };
    } catch (error) {
      if (manual) logger.error(`BoardClip update check failed: ${error.message}`);
      updating = false;
      return { ok: false, status: 'error', error };
    } finally {
      checking = false;
    }
  }

  function start() {
    if (startupTimer || timer) return;
    // Always keep the schedule alive in a source checkout. Production mode may
    // currently be blocked by tracked edits, but a developer can switch to
    // Development later without restarting the app.
    const baseSupport = updateSupport(appDir, buildInfo, process.platform, { updateMode: 'development' });
    if (!baseSupport.supported) return;
    startupTimer = setTimeout(() => {
      startupTimer = null;
      check();
    }, startupDelayMs);
    startupTimer.unref();
    timer = setInterval(() => check(), pollMs);
    timer.unref();
  }

  function stop() {
    if (startupTimer) clearTimeout(startupTimer);
    if (timer) clearInterval(timer);
    startupTimer = null;
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
  gitHead,
  latestCommitSha,
  runUpdate,
  updateSupport,
  updateEnvironment,
  updateScriptPath,
  updateModeForChangedFiles,
};
