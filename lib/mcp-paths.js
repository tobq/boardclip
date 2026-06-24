'use strict';

// Shared filesystem locations for the MCP feature, used by BOTH the Electron app
// and the standalone stdio helper (which is not Electron and cannot call
// app.getPath). The app writes a discovery file on launch; the helper reads it to
// locate the data dir + control pipe + auth secret. If the app never ran, the
// helper falls back to the per-platform default data dir for read-only context.

const os = require('os');
const path = require('path');
const fs = require('fs');

const HOME = os.homedir();
const CONFIG_DIR = path.join(HOME, '.boardclip');
// BOARDCLIP_MCP_DISCOVERY overrides the discovery file location (used by tests
// and unusual installs); otherwise it lives at ~/.boardclip/mcp.json.
const DISCOVERY_FILE = process.env.BOARDCLIP_MCP_DISCOVERY || path.join(CONFIG_DIR, 'mcp.json');

// Mirrors Electron's app.getPath('userData') for productName "BoardClip".
function defaultDataDir() {
  if (process.platform === 'win32') {
    const appData = process.env.APPDATA || path.join(HOME, 'AppData', 'Roaming');
    return path.join(appData, 'BoardClip');
  }
  if (process.platform === 'darwin') {
    return path.join(HOME, 'Library', 'Application Support', 'BoardClip');
  }
  const xdg = process.env.XDG_CONFIG_HOME || path.join(HOME, '.config');
  return path.join(xdg, 'BoardClip');
}

// A stable per-user tag so concurrent OS users don't collide on one address.
function userTag() {
  try {
    const info = os.userInfo();
    if (typeof info.uid === 'number' && info.uid >= 0) return String(info.uid);
    if (info.username) return String(info.username).replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 24) || 'u';
  } catch {}
  return 'u';
}

// Stable, PER-USER control-channel address. The app records the actual bound path
// in the discovery file, so the helper never recomputes this; it is only the
// app's default choice.
function defaultPipePath() {
  if (process.platform === 'win32') {
    // Per-user named pipe so concurrent Windows sessions (RDP / fast-user-switch)
    // don't fight over one global pipe.
    return `\\\\.\\pipe\\boardclip-mcp-${userTag()}`;
  }
  if (process.platform === 'darwin') {
    // macOS $TMPDIR is already per-user; keep the short path (UDS ~104-char cap).
    return path.join(os.tmpdir(), 'boardclip-mcp.sock');
  }
  // Linux/other unix: /tmp is shared + sticky, so scope the socket per user.
  // Prefer XDG_RUNTIME_DIR (per-user, mode 0700, the canonical place for sockets).
  const base = process.env.XDG_RUNTIME_DIR || os.tmpdir();
  return path.join(base, `boardclip-mcp-${userTag()}.sock`);
}

function ensureConfigDir() {
  try { fs.mkdirSync(CONFIG_DIR, { recursive: true }); } catch {}
}

function writeDiscovery(data) {
  ensureConfigDir();
  const tmp = `${DISCOVERY_FILE}.tmp`;
  const json = JSON.stringify(data, null, 2);
  fs.writeFileSync(tmp, json, { mode: 0o600 });
  fs.renameSync(tmp, DISCOVERY_FILE);
  try { fs.chmodSync(DISCOVERY_FILE, 0o600); } catch {}
}

function readDiscovery() {
  try {
    return JSON.parse(fs.readFileSync(DISCOVERY_FILE, 'utf8'));
  } catch {
    return null;
  }
}

function clearDiscovery() {
  try { fs.rmSync(DISCOVERY_FILE, { force: true }); } catch {}
}

module.exports = {
  CONFIG_DIR,
  DISCOVERY_FILE,
  defaultDataDir,
  defaultPipePath,
  ensureConfigDir,
  writeDiscovery,
  readDiscovery,
  clearDiscovery,
};
