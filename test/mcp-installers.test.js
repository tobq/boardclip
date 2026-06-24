'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const installers = require('../lib/mcp-installers');

function tempHome() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'boardclip-mcp-install-'));
}

const COMMAND = { command: 'node', args: ['C:/Users/Tobi/code/clipboard-tray/mcp/boardclip-mcp.js'] };

function rootsFor(home) {
  return { home, appData: path.join(home, 'AppData', 'Roaming'), xdgConfig: path.join(home, '.config'), library: path.join(home, 'Library', 'Application Support') };
}

// --- Claude Code: JSON map under ~/.claude.json, preserves siblings ----------
{
  const home = tempHome();
  const roots = rootsFor(home);
  // Pre-existing config with another server must be preserved.
  fs.writeFileSync(path.join(home, '.claude.json'), JSON.stringify({ mcpServers: { other: { command: 'x', args: [] } }, somethingElse: 1 }));
  installers.enable('claude-code', COMMAND, roots);
  const data = JSON.parse(fs.readFileSync(path.join(home, '.claude.json'), 'utf8'));
  assert.deepStrictEqual(data.mcpServers.boardclip, { command: 'node', args: COMMAND.args });
  assert.ok(data.mcpServers.other, 'sibling server preserved');
  assert.strictEqual(data.somethingElse, 1, 'unrelated keys preserved');

  // Idempotent: enabling again does not duplicate / corrupt.
  installers.enable('claude-code', COMMAND, roots);
  const again = JSON.parse(fs.readFileSync(path.join(home, '.claude.json'), 'utf8'));
  assert.strictEqual(Object.keys(again.mcpServers).length, 2);

  // Disable removes only boardclip.
  installers.disable('claude-code', roots);
  const after = JSON.parse(fs.readFileSync(path.join(home, '.claude.json'), 'utf8'));
  assert.strictEqual(after.mcpServers.boardclip, undefined);
  assert.ok(after.mcpServers.other);
}

// --- VS Code: `servers` key + type stdio -------------------------------------
{
  const home = tempHome();
  const roots = rootsFor(home);
  installers.enable('vscode', COMMAND, roots);
  const file = path.join(roots.xdgConfig, 'Code', 'User', 'mcp.json');
  // platform-specific dir: recompute via the adapter status to find the real file
  const status = installers.statuses(roots).find(s => s.id === 'vscode');
  const data = JSON.parse(fs.readFileSync(status.configPath, 'utf8'));
  assert.strictEqual(data.servers.boardclip.type, 'stdio');
  assert.strictEqual(data.servers.boardclip.command, 'node');
}

// --- Codex: TOML block add/strip, preserves the rest -------------------------
{
  const home = tempHome();
  const roots = rootsFor(home);
  const codexDir = path.join(home, '.codex');
  fs.mkdirSync(codexDir, { recursive: true });
  fs.writeFileSync(path.join(codexDir, 'config.toml'), '# my config\nmodel = "gpt-5.5"\n\n[mcp_servers.other]\ncommand = "x"\nargs = []\n');
  installers.enable('codex', COMMAND, roots);
  let text = fs.readFileSync(path.join(codexDir, 'config.toml'), 'utf8');
  assert.ok(/\[mcp_servers\.boardclip\]/.test(text));
  assert.ok(/model = "gpt-5.5"/.test(text), 'existing config preserved');
  assert.ok(/\[mcp_servers\.other\]/.test(text), 'other server preserved');

  // Re-enabling replaces the block, does not duplicate it.
  installers.enable('codex', COMMAND, roots);
  text = fs.readFileSync(path.join(codexDir, 'config.toml'), 'utf8');
  assert.strictEqual((text.match(/\[mcp_servers\.boardclip\]/g) || []).length, 1);

  installers.disable('codex', roots);
  text = fs.readFileSync(path.join(codexDir, 'config.toml'), 'utf8');
  assert.ok(!/\[mcp_servers\.boardclip\]/.test(text));
  assert.ok(/\[mcp_servers\.other\]/.test(text), 'other server still there after disable');
}

// --- Zed: nested command object ----------------------------------------------
{
  const home = tempHome();
  const roots = rootsFor(home);
  installers.enable('zed', COMMAND, roots);
  const file = path.join(roots.xdgConfig, 'zed', 'settings.json');
  const data = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.deepStrictEqual(data.context_servers.boardclip.command.path, 'node');
  assert.deepStrictEqual(data.context_servers.boardclip.command.args, COMMAND.args);
}

// --- detect / enableDetected -------------------------------------------------
{
  const home = tempHome();
  const roots = rootsFor(home);
  // Only "detect" Cursor by creating its dir.
  fs.mkdirSync(path.join(home, '.cursor'), { recursive: true });
  const touched = installers.enableDetected(COMMAND, roots);
  assert.deepStrictEqual(touched, ['cursor']);
  const data = JSON.parse(fs.readFileSync(path.join(home, '.cursor', 'mcp.json'), 'utf8'));
  assert.ok(data.mcpServers.boardclip);

  // statuses reflects detected/enabled.
  const cursorStatus = installers.statuses(roots).find(s => s.id === 'cursor');
  assert.strictEqual(cursorStatus.detected, true);
  assert.strictEqual(cursorStatus.enabled, true);
  const claudeStatus = installers.statuses(roots).find(s => s.id === 'claude-code');
  assert.strictEqual(claudeStatus.detected, false);
}

// --- disableAll removes everywhere -------------------------------------------
{
  const home = tempHome();
  const roots = rootsFor(home);
  installers.enable('cursor', COMMAND, roots);
  installers.enable('windsurf', COMMAND, roots);
  installers.disableAll(roots);
  for (const id of ['cursor', 'windsurf']) {
    const s = installers.statuses(roots).find(x => x.id === id);
    assert.strictEqual(s.enabled, false, `${id} disabled`);
  }
}

console.log('mcp installers tests passed');
