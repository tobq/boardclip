'use strict';

// End-to-end smoke test of the real stdio MCP helper (mcp/boardclip-mcp.js):
// spawn it, speak MCP JSON-RPC over stdin/stdout, and assert it boots, lists
// tools, serves a shared-clip read locally, withholds a secret, and reports
// app_not_running for a gated action (no app/pipe in this test).

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const crypto = require('crypto');

function sha256(text) { return crypto.createHash('sha256').update(String(text), 'utf8').digest('hex'); }

// Assembled so no full provider-token literal sits in source (push protection).
const GHP = 'ghp' + '_AbCdEf0123456789AbCdEf0123456789abcd';

function setup() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'boardclip-mcp-smoke-'));
  const dataDir = path.join(root, 'data');
  fs.mkdirSync(dataDir, { recursive: true });
  const sharedId = `txt:${sha256('shared hello world')}`;
  const secretId = `txt:${sha256(GHP)}`;
  const privateId = `txt:${sha256('private nothing')}`;
  const history = [
    { id: sharedId, type: 'text', text: 'shared hello world', ts: 3, pin: { groups: ['AI'] } },
    { id: secretId, type: 'text', text: GHP, ts: 2, pin: { groups: ['AI'] } },
    { id: privateId, type: 'text', text: 'private nothing', ts: 1 },
  ];
  // Large externalized clip: preview (first 1024 chars) is benign PROSE (no long
  // hex/high-entropy token), but the FULL body hides a secret past the preview. On
  // disk item.text is only the preview, so the secret guard must re-scan the body.
  const benign1024 = 'the quick brown fox jumps over the lazy dog. '.repeat(30).slice(0, 1024);
  const bigFull = benign1024 + ' ' + GHP;
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
  return { root, dataDir, discovery, sharedId, secretId, bigId };
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
  for (const expected of ['list_context', 'list_clips', 'get_clip', 'delete_clip', 'copy_to_clipboard']) {
    assert.ok(names.includes(expected), `tool ${expected} registered`);
  }

  // list_context (local read)
  const ctxRes = await rpc.call('tools/call', { name: 'list_context', arguments: {} });
  const ctxData = JSON.parse(toolText(ctxRes));
  assert.strictEqual(ctxData.totalClips, 4);
  assert.strictEqual(ctxData.sharedClips, 3); // sharedId + secretId + bigId (all in AI)
  assert.strictEqual(ctxData.withheldSecrets, 1); // only secretId's preview looks secret

  // get_clip on shared, non-secret -> returns text locally
  const shared = await rpc.call('tools/call', { name: 'get_clip', arguments: { id: ctx.sharedId } });
  const sharedData = JSON.parse(toolText(shared));
  assert.strictEqual(sharedData.text, 'shared hello world');

  // get_clip on a secret in a shared group -> tries to escalate to the app,
  // which is not running -> friendly app_not_running error.
  const secret = await rpc.call('tools/call', { name: 'get_clip', arguments: { id: ctx.secretId } });
  assert.strictEqual(secret.result.isError, true, 'secret read is gated');
  assert.ok(/not running/i.test(toolText(secret)), 'app_not_running surfaced');

  // delete_clip (gated) with no app -> app_not_running error, nothing deleted.
  const del = await rpc.call('tools/call', { name: 'delete_clip', arguments: { id: ctx.sharedId } });
  assert.strictEqual(del.result.isError, true);
  assert.ok(/not running/i.test(toolText(del)));

  // SECURITY (large-clip secret): get_clip on a shared clip whose secret is past
  // the 1024-char preview must re-scan the hydrated body and GATE it, not leak it.
  const big = await rpc.call('tools/call', { name: 'get_clip', arguments: { id: ctx.bigId } });
  assert.strictEqual(big.result.isError, true, 'large-clip secret must be gated, not returned');
  assert.ok(/not running/i.test(toolText(big)), 'routed to gated read (app not running here)');
  assert.ok(!/ghp_/.test(toolText(big)), 'secret value never appears in the response');

  child.kill();
  if (stderr.trim()) { console.error('helper stderr:', stderr.trim()); }
  console.log('mcp helper smoke tests passed');
}

main().catch(err => { console.error(err); process.exit(1); });
