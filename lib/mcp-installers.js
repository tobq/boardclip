'use strict';

// MCP client installers.
//
// Registers (and removes) the BoardClip MCP server into each local AI client's
// config. Almost every client uses the same shape - a JSON file with a map of
// server-name -> { command, args } - so that case is handled by ONE shared
// adapter factory; only Codex (TOML), VS Code (`servers` + type), and Zed
// (nested `command` object) need variants. No Electron dependency: pure fs/os so
// it is unit-testable and usable from the main process.
//
// All writes are idempotent and non-clobbering: other servers in the file are
// preserved; only the `boardclip` entry is added/updated/removed.

const fs = require('fs');
const os = require('os');
const path = require('path');

const SERVER_NAME = 'boardclip';

function resolveRoots(overrides = {}) {
  const home = overrides.home || os.homedir();
  return {
    home,
    appData: overrides.appData || process.env.APPDATA || path.join(home, 'AppData', 'Roaming'),
    xdgConfig: overrides.xdgConfig || process.env.XDG_CONFIG_HOME || path.join(home, '.config'),
    library: overrides.library || path.join(home, 'Library', 'Application Support'),
  };
}

// Per-OS location of an app's "config home" directory (where VS Code/Claude
// Desktop/etc. keep user config), given a base folder name.
function appConfigDir(roots, name) {
  if (process.platform === 'win32') return path.join(roots.appData, name);
  if (process.platform === 'darwin') return path.join(roots.library, name);
  return path.join(roots.xdgConfig, name);
}

function readJson(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; }
}

function writeJsonAtomic(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2));
  fs.renameSync(tmp, file);
}

function entryExists(file) {
  try { return fs.existsSync(file); } catch { return false; }
}

// --- Shared JSON-map adapter -------------------------------------------------
// Covers clients that store servers as { [serversKey]: { name: entryValue } }.
function jsonMapAdapter({ id, label, dirFor, fileName, serversKey = 'mcpServers', detectDirFor, buildEntry }) {
  const configPath = roots => path.join(dirFor(roots), fileName);
  const detectDir = detectDirFor || dirFor;
  return {
    id,
    label,
    configPath,
    detect(roots) { return entryExists(detectDir(roots)); },
    status(roots) {
      const file = configPath(roots);
      const data = readJson(file);
      const enabled = !!(data && data[serversKey] && data[serversKey][SERVER_NAME]);
      return { id, label, detected: this.detect(roots), enabled, configPath: file };
    },
    enable(command, roots) {
      const file = configPath(roots);
      const data = readJson(file) || {};
      if (!data[serversKey] || typeof data[serversKey] !== 'object') data[serversKey] = {};
      data[serversKey][SERVER_NAME] = buildEntry(command);
      writeJsonAtomic(file, data);
    },
    disable(roots) {
      const file = configPath(roots);
      const data = readJson(file);
      if (data && data[serversKey] && data[serversKey][SERVER_NAME]) {
        delete data[serversKey][SERVER_NAME];
        writeJsonAtomic(file, data);
      }
    },
  };
}

// Standard { command, args, env } entry used by most clients.
function stdEntry(command) {
  const entry = { command: command.command, args: command.args.slice() };
  if (command.env && Object.keys(command.env).length) entry.env = { ...command.env };
  return entry;
}

// --- Codex (TOML) ------------------------------------------------------------
// Minimal targeted edit: strip any existing [mcp_servers.boardclip] table and
// append a fresh one, preserving the rest of the file (comments, other servers).
function tomlString(value) {
  return JSON.stringify(String(value)); // TOML basic-string escaping == JSON for these cases
}

function codexBlock(command) {
  const lines = [`[mcp_servers.${SERVER_NAME}]`, `command = ${tomlString(command.command)}`];
  lines.push(`args = [${command.args.map(tomlString).join(', ')}]`);
  if (command.env && Object.keys(command.env).length) {
    const pairs = Object.entries(command.env).map(([k, v]) => `${k} = ${tomlString(v)}`);
    lines.push(`env = { ${pairs.join(', ')} }`);
  }
  return lines.join('\n');
}

function stripCodexBlock(text) {
  const lines = String(text || '').split(/\r?\n/);
  const out = [];
  let skipping = false;
  for (const line of lines) {
    if (/^\s*\[mcp_servers\.boardclip\]\s*$/.test(line)) { skipping = true; continue; }
    if (skipping) {
      if (/^\s*\[/.test(line)) skipping = false; // next table header ends the block
      else continue;
    }
    out.push(line);
  }
  return out.join('\n').replace(/\n{3,}/g, '\n\n').replace(/\s+$/, '');
}

function codexAdapter() {
  const dir = roots => path.join(roots.home, '.codex');
  const configPath = roots => path.join(dir(roots), 'config.toml');
  return {
    id: 'codex',
    label: 'Codex',
    configPath,
    detect(roots) { return entryExists(dir(roots)); },
    status(roots) {
      const text = (() => { try { return fs.readFileSync(configPath(roots), 'utf8'); } catch { return ''; } })();
      return { id: 'codex', label: 'Codex', detected: this.detect(roots), enabled: /\[mcp_servers\.boardclip\]/.test(text), configPath: configPath(roots) };
    },
    enable(command, roots) {
      const file = configPath(roots);
      fs.mkdirSync(path.dirname(file), { recursive: true });
      let text = '';
      try { text = fs.readFileSync(file, 'utf8'); } catch {}
      const stripped = stripCodexBlock(text);
      const next = `${stripped ? `${stripped}\n\n` : ''}${codexBlock(command)}\n`;
      const tmp = `${file}.tmp`;
      fs.writeFileSync(tmp, next);
      fs.renameSync(tmp, file);
    },
    disable(roots) {
      const file = configPath(roots);
      let text;
      try { text = fs.readFileSync(file, 'utf8'); } catch { return; }
      const stripped = stripCodexBlock(text);
      const tmp = `${file}.tmp`;
      fs.writeFileSync(tmp, stripped ? `${stripped}\n` : '');
      fs.renameSync(tmp, file);
    },
  };
}

// --- Zed (nested command object) ---------------------------------------------
function zedAdapter() {
  return jsonMapAdapter({
    id: 'zed',
    label: 'Zed',
    dirFor: roots => path.join(roots.xdgConfig, 'zed'),
    fileName: 'settings.json',
    serversKey: 'context_servers',
    buildEntry: command => ({ command: { path: command.command, args: command.args.slice(), env: command.env || {} } }),
  });
}

// --- Adapter registry --------------------------------------------------------
function buildAdapters() {
  return [
    jsonMapAdapter({
      id: 'claude-code', label: 'Claude Code',
      dirFor: roots => roots.home, fileName: '.claude.json',
      detectDirFor: roots => path.join(roots.home, '.claude'),
      buildEntry: stdEntry,
    }),
    codexAdapter(),
    jsonMapAdapter({
      id: 'claude-desktop', label: 'Claude Desktop',
      dirFor: roots => appConfigDir(roots, 'Claude'), fileName: 'claude_desktop_config.json',
      buildEntry: stdEntry,
    }),
    jsonMapAdapter({
      id: 'vscode', label: 'VS Code',
      dirFor: roots => path.join(appConfigDir(roots, 'Code'), 'User'), fileName: 'mcp.json',
      serversKey: 'servers',
      buildEntry: command => ({ type: 'stdio', ...stdEntry(command) }),
    }),
    jsonMapAdapter({
      id: 'vscode-insiders', label: 'VS Code Insiders',
      dirFor: roots => path.join(appConfigDir(roots, 'Code - Insiders'), 'User'), fileName: 'mcp.json',
      serversKey: 'servers',
      buildEntry: command => ({ type: 'stdio', ...stdEntry(command) }),
    }),
    jsonMapAdapter({
      id: 'cursor', label: 'Cursor',
      dirFor: roots => path.join(roots.home, '.cursor'), fileName: 'mcp.json',
      buildEntry: stdEntry,
    }),
    jsonMapAdapter({
      id: 'windsurf', label: 'Windsurf',
      dirFor: roots => path.join(roots.home, '.codeium', 'windsurf'), fileName: 'mcp_config.json',
      buildEntry: stdEntry,
    }),
    jsonMapAdapter({
      id: 'cline', label: 'Cline',
      dirFor: roots => path.join(appConfigDir(roots, 'Code'), 'User', 'globalStorage', 'saoudrizwan.claude-dev', 'settings'),
      fileName: 'cline_mcp_settings.json',
      buildEntry: stdEntry,
    }),
    jsonMapAdapter({
      id: 'roo', label: 'Roo Code',
      dirFor: roots => path.join(appConfigDir(roots, 'Code'), 'User', 'globalStorage', 'rooveterinaryinc.roo-cline', 'settings'),
      fileName: 'mcp_settings.json',
      buildEntry: stdEntry,
    }),
    zedAdapter(),
    // NOTE: Continue is intentionally omitted. It configures MCP via a YAML list
    // (~/.continue/config.yaml `mcpServers:` or .continue/mcpServers/*.yaml), not a
    // JSON `mcpServers` map, so the shared adapter would write a file Continue
    // ignores. Add a dedicated YAML adapter when supporting it for real.
  ];
}

const ADAPTERS = buildAdapters();

function byId(id) { return ADAPTERS.find(a => a.id === id) || null; }

// --- Public API --------------------------------------------------------------
function statuses(rootsOverride) {
  const roots = resolveRoots(rootsOverride);
  return ADAPTERS.map(a => a.status(roots));
}

function enable(id, command, rootsOverride) {
  const adapter = byId(id);
  if (!adapter) throw new Error(`unknown client: ${id}`);
  adapter.enable(command, resolveRoots(rootsOverride));
}

function disable(id, rootsOverride) {
  const adapter = byId(id);
  if (!adapter) throw new Error(`unknown client: ${id}`);
  adapter.disable(resolveRoots(rootsOverride));
}

// Install into every DETECTED client. Returns the ids touched.
function enableDetected(command, rootsOverride) {
  const roots = resolveRoots(rootsOverride);
  const touched = [];
  for (const adapter of ADAPTERS) {
    if (!adapter.detect(roots)) continue;
    try { adapter.enable(command, roots); touched.push(adapter.id); } catch {}
  }
  return touched;
}

// Remove from every client (used on uninstall / disable-all).
function disableAll(rootsOverride) {
  const roots = resolveRoots(rootsOverride);
  for (const adapter of ADAPTERS) {
    try { adapter.disable(roots); } catch {}
  }
}

module.exports = {
  SERVER_NAME,
  ADAPTERS,
  resolveRoots,
  statuses,
  enable,
  disable,
  enableDetected,
  disableAll,
  // exported for tests
  stripCodexBlock,
  codexBlock,
};
