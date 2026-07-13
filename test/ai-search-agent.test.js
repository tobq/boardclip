'use strict';
// Tests for lib/ai-search-agent.js — the Anthropic tool-use loop, driven by a fake model
// (fetchImpl) + fake tools. No network, no Electron.
const assert = require('assert');
const { runAgent } = require('../lib/ai-search-agent');

// A fake Anthropic endpoint: returns a scripted sequence of `content` arrays, one per call.
function fakeModel(scripts) {
  let call = 0;
  return async (_url, init) => {
    const body = JSON.parse(init.body);
    assert.ok(Array.isArray(body.tools) && body.tools.some((t) => t.name === 'pick_clips'));
    assert.ok(typeof body.system === 'string' && body.system.length > 0);
    const content = scripts[Math.min(call, scripts.length - 1)];
    call++;
    return { ok: true, json: async () => ({ content }) };
  };
}

const baseOpts = { endpoint: 'https://x.test', apiKey: 'k', model: 'm' };

(async () => {
  // 1) search -> pick (ordered ids returned)
  {
    const searched = [];
    const fetchImpl = fakeModel([
      [{ type: 'tool_use', id: 't1', name: 'search_clips', input: { query: 'invoice' } }],
      [{ type: 'tool_use', id: 't2', name: 'pick_clips', input: { ids: ['txt:a', 'txt:b'] } }],
    ]);
    const tools = {
      searchClips: async (q, limit) => { searched.push([q, limit]); return { matches: [{ id: 'txt:a', preview: 'the invoice' }, { id: 'txt:b', preview: 'invoice 2' }] }; },
      getClip: async () => null,
    };
    const r = await runAgent({ ...baseOpts, fetchImpl, tools, question: 'where is the invoice' });
    assert.deepStrictEqual(r.ids, ['txt:a', 'txt:b']);
    assert.deepStrictEqual(searched[0], ['invoice', 20]);
    assert.strictEqual(r.steps, 2);
  }

  // 2) search -> get_clip -> pick (get_clip result fed back)
  {
    let gotClip = null;
    const fetchImpl = fakeModel([
      [{ type: 'tool_use', id: 's', name: 'search_clips', input: { query: 'key' } }],
      [{ type: 'tool_use', id: 'g', name: 'get_clip', input: { id: 'txt:a' } }],
      [{ type: 'tool_use', id: 'p', name: 'pick_clips', input: { ids: ['txt:a'] } }],
    ]);
    const tools = {
      searchClips: async () => ({ matches: [{ id: 'txt:a', preview: 'has a k…' }] }),
      getClip: async (id) => { gotClip = id; return { id, text: 'the full api key' }; },
    };
    const r = await runAgent({ ...baseOpts, fetchImpl, tools, question: 'the api key' });
    assert.strictEqual(gotClip, 'txt:a');
    assert.deepStrictEqual(r.ids, ['txt:a']);
    assert.strictEqual(r.steps, 3);
  }

  // 3) empty pick -> no match
  {
    const fetchImpl = fakeModel([[{ type: 'tool_use', id: 'p', name: 'pick_clips', input: { ids: [] } }]]);
    const r = await runAgent({ ...baseOpts, fetchImpl, tools: { searchClips: async () => ({ matches: [] }), getClip: async () => null }, question: 'nothing' });
    assert.deepStrictEqual(r.ids, []);
  }

  // 4) plain text answer (no tool call) -> empty ids + note
  {
    const fetchImpl = fakeModel([[{ type: 'text', text: 'I could not find it.' }]]);
    const r = await runAgent({ ...baseOpts, fetchImpl, tools: { searchClips: async () => ({ matches: [] }), getClip: async () => null }, question: 'x' });
    assert.deepStrictEqual(r.ids, []);
    assert.ok(/could not find/.test(r.note));
  }

  // 5) abort signal short-circuits
  {
    const fetchImpl = fakeModel([[{ type: 'tool_use', id: 'p', name: 'pick_clips', input: { ids: ['x'] } }]]);
    const r = await runAgent({ ...baseOpts, fetchImpl, tools: {}, question: 'x', signal: { aborted: true } });
    assert.strictEqual(r.aborted, true);
    assert.deepStrictEqual(r.ids, []);
  }

  // 6) missing config throws
  {
    let threw = false;
    try { await runAgent({ fetchImpl: async () => ({}), tools: {}, question: 'x' }); } catch { threw = true; }
    assert.ok(threw, 'missing endpoint/key/model must throw');
  }

  // 7) HTTP error surfaces
  {
    let threw = false;
    const fetchImpl = async () => ({ ok: false, status: 401, text: async () => 'unauthorized' });
    try { await runAgent({ ...baseOpts, fetchImpl, tools: {}, question: 'x' }); } catch (e) { threw = /ai_search_http_401/.test(e.message); }
    assert.ok(threw, 'HTTP error must throw with status');
  }

  // 8) endpoint normalization: /v1/messages appended when absent, kept when present
  {
    const urls = [];
    const mk = (ep) => async (url) => { urls.push(url); return { ok: true, json: async () => ({ content: [{ type: 'tool_use', id: 'p', name: 'pick_clips', input: { ids: [] } }] }) }; };
    await runAgent({ endpoint: 'https://a.test', apiKey: 'k', model: 'm', fetchImpl: mk(), tools: {}, question: 'x' });
    await runAgent({ endpoint: 'https://a.test/v1/messages', apiKey: 'k', model: 'm', fetchImpl: mk(), tools: {}, question: 'x' });
    assert.strictEqual(urls[0], 'https://a.test/v1/messages');
    assert.strictEqual(urls[1], 'https://a.test/v1/messages');
  }

  console.log('ai-search-agent.test.js: all assertions passed');
})().catch((e) => { console.error(e); process.exit(1); });
