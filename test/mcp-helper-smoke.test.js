'use strict';
const model = require('../lib/clipboard-model');
const mcpCore = require('../lib/mcp-core');

// End-to-end smoke test of the real stdio MCP helper (mcp/boardclip-mcp.js):
// spawn it, speak MCP JSON-RPC over stdin/stdout, and assert it boots, lists
// tools, serves shared-clip reads locally (including a large hydrated clip),
// keeps private things private at the boundary (keyed revs, opaque ids for
// private clips, no private match counts, no rewrite of a private retired
// name), and reports app_not_running for a gated action (no app/pipe here).

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const crypto = require('crypto');

function sha256(text) { return crypto.createHash('sha256').update(String(text), 'utf8').digest('hex'); }

const SECRET = 'd'.repeat(64);

function setup({ secret }) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'boardclip-mcp-smoke-'));
  const dataDir = path.join(root, 'data');
  fs.mkdirSync(dataDir, { recursive: true });
  const sharedItem = { id: `txt:${sha256('shared hello world')}`, type: 'text', text: 'shared hello world', ts: 3, pin: { groups: ['AI'] } };
  const secondItem = { id: `txt:${sha256('second shared clip')}`, type: 'text', text: 'second shared clip', ts: 2, pin: { groups: ['AI'] } };
  const privateItem = { id: `txt:${sha256('private nothing')}`, type: 'text', text: 'private nothing', ts: 1, pin: { groups: ['health'] } };
  const workItem = { id: `txt:${sha256('shared work notes')}`, type: 'text', text: 'shared work notes', ts: 5, pin: { groups: ['work', 'notes'] } };
  const history = [sharedItem, secondItem, privateItem, workItem];
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

  // Flat groups (the 14 Oct 2026 cutover already ran) with three retired nested
  // names: one of shared groups, one of private groups, one under the AI group.
  const settings = {
    groups: ['AI', 'work', 'notes', 'health', 'therapy'],
    groups_shared_with_ai: ['AI', 'work', 'notes'],
    groups_flattened_at: 1,
    group_splits: [
      { name: 'work/notes', parts: ['work', 'notes'], at: 1 },
      { name: 'health/therapy', parts: ['health', 'therapy'], at: 1 },
      { name: 'AI/old', parts: ['AI'], at: 1 },
    ],
    ...(secret ? { mcp_secret: secret } : {}),
  };
  fs.writeFileSync(path.join(dataDir, 'clipboard-history.json'), JSON.stringify(history));
  fs.writeFileSync(path.join(dataDir, 'clipboard-settings.json'), JSON.stringify(settings));
  const discovery = path.join(root, 'discovery.json');
  // No pipePath/secret -> control channel reports app_not_running.
  fs.writeFileSync(discovery, JSON.stringify({ dataDir }));
  return { root, dataDir, discovery, settings, sharedItem, privateItem, bigId };
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

async function startHelper(ctx) {
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
  const tool = async (name, args) => rpc.call('tools/call', { name, arguments: args || {} });
  const json = async (name, args) => JSON.parse(toolText(await tool(name, args)));
  return { child, rpc, tool, json, stderr: () => stderr };
}

async function main() {
  const ctx = setup({ secret: SECRET });
  const h = await startHelper(ctx);

  const tools = await h.rpc.call('tools/list', {});
  const names = (tools.result.tools || []).map(t => t.name);
  for (const expected of ['list_context', 'list_clips', 'get_clip', 'edit_clip', 'delete_clip', 'copy_to_clipboard']) {
    assert.ok(names.includes(expected), `tool ${expected} registered`);
  }
  // One word for the app's term: every tool description says "group", never "tag".
  for (const t of tools.result.tools) assert.ok(!/\btags?\b/i.test(`${t.description} ${JSON.stringify(t.inputSchema)}`), `${t.name} says group, not tag`);

  // list_context (local read)
  const ctxData = await h.json('list_context');
  assert.strictEqual(ctxData.totalClips, 5);
  assert.strictEqual(ctxData.sharedClips, 4); // shared + second + big (AI) + work

  // get_clip on a shared clip -> returns text locally (opt-in group = shared),
  // with the keyed public rev, never the real one.
  const sharedData = await h.json('get_clip', { id: ctx.sharedItem.id });
  assert.strictEqual(sharedData.text, 'shared hello world');
  assert.strictEqual(sharedData.id, ctx.sharedItem.id, 'a shared clip keeps its real id');
  assert.strictEqual(sharedData.rev, mcpCore.publicRev(ctx.sharedItem, ctx.settings), 'the public rev');
  assert.notStrictEqual(sharedData.rev, model.clipRevision(ctx.sharedItem), 'not the real (brute-forceable) rev');

  // A private clip is listed under an opaque handle, never its content hash.
  const listed = await h.json('list_clips', { include_unshared_metadata: true });
  const meta = listed.clips.find(c => !c.shared);
  assert.strictEqual(meta.id, mcpCore.publicId(ctx.privateItem, ctx.settings));
  assert.ok(meta.id.startsWith('private:') && meta.id !== ctx.privateItem.id);
  assert.strictEqual(meta.groups, undefined, 'no group names for a private clip');

  // get_clip on a NON-shared clip by its handle -> escalates to the app, which is
  // not running here -> friendly app_not_running error.
  const priv = await h.tool('get_clip', { id: meta.id });
  assert.strictEqual(priv.result.isError, true, 'non-shared read is gated');
  assert.ok(/not running/i.test(toolText(priv)), 'app_not_running surfaced');
  // Its content hash (an id an AI could compute from a guessed text) names nothing:
  // answered locally exactly like a missing id, never forwarded.
  const guessed = await h.tool('get_clip', { id: ctx.privateItem.id });
  assert.strictEqual(toolText(guessed), `No clip with id "${ctx.privateItem.id}".`);
  assert.strictEqual(toolText(await h.tool('get_clip', { id: 'txt:nope' })), 'No clip with id "txt:nope".');

  // Every clip-mutating tool requires expected_rev in its schema.
  for (const name of ['edit_clip', 'delete_clip', 'pin_clip', 'set_numpad', 'assign_group']) {
    const t = tools.result.tools.find(x => x.name === name);
    assert.ok(t.inputSchema.required.includes('expected_rev'), `${name} requires expected_rev`);
  }
  // A mutation without expected_rev is rejected before anything is forwarded.
  const noRev = await h.tool('delete_clip', { id: ctx.sharedItem.id });
  assert.ok(noRev.error || (noRev.result && noRev.result.isError), 'delete_clip without expected_rev is refused');

  // delete_clip / edit_clip (gated) with no app -> app_not_running error, nothing changed.
  const del = await h.tool('delete_clip', { id: ctx.sharedItem.id, expected_rev: sharedData.rev });
  assert.strictEqual(del.result.isError, true);
  assert.ok(/not running/i.test(toolText(del)));
  const edit = await h.tool('edit_clip', { id: ctx.sharedItem.id, expected_rev: sharedData.rev, text: 'edited body' });
  assert.strictEqual(edit.result.isError, true, 'edit is gated (forwarded to app)');
  assert.ok(/not running/i.test(toolText(edit)));

  // search_clips never searches private clips: no match count, the same answer for a
  // true and a false guess at the private text, and a hint to ask for more.
  const s1 = await h.json('search_clips', { query: 'private' });
  assert.strictEqual('nonSharedMatches' in s1, false);
  assert.strictEqual(s1.nonSharedTotal, 1);
  assert.ok(/include_unshared: true/.test(s1.hint));
  assert.deepStrictEqual(await h.json('search_clips', { query: `id:${meta.id} /^pri/` }), await h.json('search_clips', { query: `id:${meta.id} /^zzz/` }), 'a /regex/ probe of private text learns nothing');

  // A retired nested name of SHARED groups is searched as its parts, and says so.
  const retired = await h.json('search_clips', { query: 'group:work/notes shared' });
  assert.strictEqual(retired.rewrittenQuery, 'group:work group:notes shared');
  assert.strictEqual(retired.returned, 1);
  // One of private groups reads as an unknown name (no rewrittenQuery to confirm it).
  assert.deepStrictEqual(await h.json('search_clips', { query: 'group:health/therapy' }), await h.json('search_clips', { query: 'group:health/dentist' }));
  // A retired AI sub-group means no group: it never makes a clip AI-visible.
  const aiOld = await h.json('search_clips', { query: 'group:ai/old' });
  assert.strictEqual(aiOld.returned, 0);
  assert.strictEqual('rewrittenQuery' in aiOld, false);

  // A /regex/ search runs on a worker thread: it keys revs exactly as this thread does.
  const viaWorker = await h.json('search_clips', { query: '/shared hel+o/' });
  assert.strictEqual(viaWorker.matches[0].rev, sharedData.rev, 'the worker uses the same key');

  // Large externalized shared clip: get_clip hydrates from clipboard-text/ and
  // returns the FULL body, including the marker that sits past the 1024 preview.
  const bigData = await h.json('get_clip', { id: ctx.bigId });
  assert.ok(bigData.text && bigData.text.includes('TAIL-MARKER-9f3a'), 'full hydrated body returned past the preview');

  h.child.kill();
  if (h.stderr().trim()) { console.error('helper stderr:', h.stderr().trim()); }

  // No secret yet (AI access never enabled): ids and revs are still keyed, and the
  // search worker gets the helper's key (it would otherwise make up its own).
  const bare = setup({ secret: null });
  const h2 = await startHelper(bare);
  const bareRead = await h2.json('get_clip', { id: bare.sharedItem.id });
  assert.notStrictEqual(bareRead.rev, model.clipRevision(bare.sharedItem));
  assert.notStrictEqual(bareRead.rev, sharedData.rev, 'not the other install\'s key');
  assert.strictEqual((await h2.json('search_clips', { query: '/shared hel+o/' })).matches[0].rev, bareRead.rev, 'the worker gets the same key');
  const bareMeta = (await h2.json('list_clips', { include_unshared_metadata: true })).clips.find(c => !c.shared);
  assert.ok(bareMeta.id.startsWith('private:') && bareMeta.id !== bare.privateItem.id);
  h2.child.kill();
  if (h2.stderr().trim()) { console.error('helper stderr:', h2.stderr().trim()); }

  for (const root of [ctx.root, bare.root]) { try { fs.rmSync(root, { recursive: true, force: true }); } catch {} }
  console.log('mcp helper smoke tests passed');
}

main().catch(err => { console.error(err); process.exit(1); });
