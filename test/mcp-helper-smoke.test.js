'use strict';

// End-to-end smoke test of the real stdio MCP helper (mcp/boardclip-mcp.js):
// spawn it, speak MCP JSON-RPC over stdin/stdout, and assert it boots, lists
// tools, serves shared-clip reads locally (including a large hydrated clip),
// and reports app_not_running for a gated action (no app/pipe in this test).

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const crypto = require('crypto');

function sha256(text) { return crypto.createHash('sha256').update(String(text), 'utf8').digest('hex'); }

function setup() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'boardclip-mcp-smoke-'));
  const dataDir = path.join(root, 'data');
  fs.mkdirSync(dataDir, { recursive: true });
  const sharedId = `txt:${sha256('shared hello world')}`;
  const secondId = `txt:${sha256('second shared clip')}`;
  const privateId = `txt:${sha256('private nothing')}`;
  const history = [
    { id: sharedId, type: 'text', text: 'shared hello world', ts: 3, pin: { groups: ['AI'] } },
    { id: secondId, type: 'text', text: 'second shared clip', ts: 2, pin: { groups: ['AI'] } },
    { id: privateId, type: 'text', text: 'private nothing', ts: 1 },
  ];
  // Large externalized clip: on disk item.text is only the first 1024-char
  // preview; the full body lives in clipboard-text/. get_clip must hydrate and
  // return the WHOLE body (a marker past the preview proves it read past 1024).
  const benign1024 = 'the quick brown fox jumps over the lazy dog. '.repeat(30).slice(0, 1024);
  const bigFull = benign1024 + ' TAIL-MARKER-9f3a';
  const bigHash = sha256(bigFull);
  const bigRef = `${bigHash}.txt`;
  const bigId = `txt:${bigHash}`;
  const preview = bigFull.slice(0, 1024);
  fs.mkdirSync(path.join(dataDir, 'clipboard-text'), { recursive: true });
  fs.writeFileSync(path.join(dataDir, 'clipboard-text', bigRef), bigFull);
  history.push({ id: bigId, type: 'text', text: preview, textPreview: preview, textHash: bigHash, textRef: bigRef, textSize: Buffer.byteLength(bigFull), ts: 4, pin: { groups: ['AI'] } });

  const settings = { groups: ['AI'], groups_shared_with_ai: ['AI'] };
  fs.writeFileSync(path.join(dataDir, 'clipboard-history.json'), JSON.stringify(history));
  fs.writeFileSync(path.join(dataDir, 'clipboard-settings.json'), JSON.stringify(settings));
  const discovery = path.join(root, 'discovery.json');
  // No pipePath/secret -> control channel reports app_not_running.
  fs.writeFileSync(discovery, JSON.stringify({ dataDir }));
  return { root, dataDir, discovery, sharedId, secondId, privateId, bigId };
}

function rpcClient(child) {
  let buffer = '';
  const pending = new Map();
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', chunk => {
    buffer += chunk;
    let idx;
    while ((idx = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, idx).trim();
      buffer = buffer.slice(idx + 1);
      if (!line) continue;
      let msg;
      try { msg = JSON.parse(line); } catch { continue; }
      if (msg.id != null && pending.has(msg.id)) { pending.get(msg.id)(msg); pending.delete(msg.id); }
    }
  });
  let nextId = 1;
  function call(method, params) {
    const id = nextId++;
    return new Promise((resolve, reject) => {
      pending.set(id, resolve);
      child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
      setTimeout(() => { if (pending.has(id)) { pending.delete(id); reject(new Error(`timeout: ${method}`)); } }, 10000);
    });
  }
  function notify(method, params) {
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method, params })}\n`);
  }
  return { call, notify };
}

function toolText(res) {
  const result = res.result || {};
  const content = (result.content || [])[0] || {};
  return content.text || '';
}

async function main() {
  const ctx = setup();
  const child = spawn(process.execPath, [path.join(__dirname, '..', 'mcp', 'boardclip-mcp.js')], {
    env: { ...process.env, BOARDCLIP_MCP_DISCOVERY: ctx.discovery },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  let stderr = '';
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', d => { stderr += d; });

  const rpc = rpcClient(child);

  const init = await rpc.call('initialize', {
    protocolVersion: '2025-06-18',
    capabilities: {},
    clientInfo: { name: 'smoke-test', version: '1.0.0' },
  });
  assert.ok(init.result && init.result.serverInfo, 'initialize returns serverInfo');
  assert.strictEqual(init.result.serverInfo.name, 'boardclip');
  rpc.notify('notifications/initialized', {});

  const tools = await rpc.call('tools/list', {});
  const names = (tools.result.tools || []).map(t => t.name);
  for (const expected of ['list_context', 'list_clips', 'get_clip', 'edit_clip', 'delete_clip', 'copy_to_clipboard']) {
    assert.ok(names.includes(expected), `tool ${expected} registered`);
  }

  // list_context (local read)
  const ctxRes = await rpc.call('tools/call', { name: 'list_context', arguments: {} });
  const ctxData = JSON.parse(toolText(ctxRes));
  assert.strictEqual(ctxData.totalClips, 4);
  assert.strictEqual(ctxData.sharedClips, 3); // sharedId + secondId + bigId (all in AI)

  // get_clip on a shared clip -> returns text locally (opt-in group = shared)
  const shared = await rpc.call('tools/call', { name: 'get_clip', arguments: { id: ctx.sharedId } });
  const sharedData = JSON.parse(toolText(shared));
  assert.strictEqual(sharedData.text, 'shared hello world');

  // get_clip on a NON-shared clip -> escalates to the app, which is not running
  // here -> friendly app_not_running error (group membership is the only gate).
  const priv = await rpc.call('tools/call', { name: 'get_clip', arguments: { id: ctx.privateId } });
  assert.strictEqual(priv.result.isError, true, 'non-shared read is gated');
  assert.ok(/not running/i.test(toolText(priv)), 'app_not_running surfaced');

  // delete_clip (gated) with no app -> app_not_running error, nothing deleted.
  const del = await rpc.call('tools/call', { name: 'delete_clip', arguments: { id: ctx.sharedId } });
  assert.strictEqual(del.result.isError, true);
  assert.ok(/not running/i.test(toolText(del)));

  // edit_clip (gated) with no app -> app_not_running error, nothing changed.
  const edit = await rpc.call('tools/call', { name: 'edit_clip', arguments: { id: ctx.sharedId, text: 'edited body' } });
  assert.strictEqual(edit.result.isError, true, 'edit is gated (forwarded to app)');
  assert.ok(/not running/i.test(toolText(edit)));

  // Large externalized shared clip: get_clip hydrates from clipboard-text/ and
  // returns the FULL body, including the marker that sits past the 1024 preview.
  const big = await rpc.call('tools/call', { name: 'get_clip', arguments: { id: ctx.bigId } });
  const bigData = JSON.parse(toolText(big));
  assert.ok(bigData.text && bigData.text.includes('TAIL-MARKER-9f3a'), 'full hydrated body returned past the preview');

  child.kill();
  if (stderr.trim()) { console.error('helper stderr:', stderr.trim()); }
  console.log('mcp helper smoke tests passed');
}

main().catch(err => { console.error(err); process.exit(1); });
