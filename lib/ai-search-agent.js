'use strict';
// In-app AI search agent — a small Anthropic tool-use loop that finds the clips answering a
// natural-language question. Pure + dependency-injected (fetch + the search/read tools are
// passed in) so it unit-tests with a fake model + fake tools and has NO Electron/IO coupling.
//
// The model gets three read-only tools over the user's OWN clipboard (in-app search is
// user-initiated with the user's own key, so scope defaults to the whole history; the caller
// enforces the 'shared'-only restriction by wiring restricted tool fns). It must finish by
// calling `pick_clips` with the ordered ids that answer the question — those become the result
// rows. No prose is surfaced; the clips ARE the answer.

const SYSTEM_PROMPT = [
  'You are BoardClip\'s clipboard search assistant. The user asks in natural language; you find',
  'the clip(s) that answer them from their clipboard history using the tools, then call',
  'pick_clips with the ordered ids (best first). Prefer few, precise results over many.',
  'Use search_clips with the query grammar when helpful: field scopes title:/text:/group:,',
  'facets is:pinned|is:image|is:text|is:numpad, num:1-9, since:/before: (e.g. since:7d),',
  'len:>100, and -negation. Use get_clip to read a clip\'s full text when a preview is not',
  'enough to judge. Do not fabricate ids — only pick ids returned by the tools. When nothing',
  'matches, call pick_clips with an empty list.',
].join(' ');

function toolDefs() {
  return [
    {
      name: 'search_clips',
      description: 'Search the clipboard history. Supports the BoardClip query grammar (title:/text:/group:/is:/num:/since:/before:/len:/-negation) and plain words. Returns matching clips with id + preview.',
      input_schema: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'Query text (grammar supported).' },
          limit: { type: 'integer', description: 'Max results (default 20).' },
        },
        required: ['query'],
      },
    },
    {
      name: 'get_clip',
      description: 'Read the full text of a clip by id (when the preview is not enough to judge relevance).',
      input_schema: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] },
    },
    {
      name: 'pick_clips',
      description: 'Finish: return the ordered clip ids (best first) that answer the user. Empty list = no match.',
      input_schema: {
        type: 'object',
        properties: { ids: { type: 'array', items: { type: 'string' } } },
        required: ['ids'],
      },
    },
  ];
}

function contentText(block) {
  return block && block.type === 'text' ? String(block.text || '') : '';
}

// Run the agent. Returns { ids: string[], steps, aborted?: boolean }.
//   opts:
//     endpoint, apiKey, model    — Anthropic-compatible config (required)
//     fetchImpl                  — fetch(url, init) (injected; defaults to global fetch)
//     tools: { searchClips(query, limit) -> {matches:[{id,preview,...}], ...},
//              getClip(id) -> { id, text|preview, ... } | null }
//     question                   — the user's natural-language query
//     maxSteps                   — safety cap on model turns (default 6)
//     signal                     — optional AbortSignal
async function runAgent(opts) {
  const o = opts || {};
  const fetchImpl = o.fetchImpl || (typeof fetch === 'function' ? fetch : null);
  if (!fetchImpl) throw new Error('no_fetch');
  if (!o.endpoint || !o.apiKey || !o.model) throw new Error('ai_search_not_configured');
  const tools = o.tools || {};
  const maxSteps = o.maxSteps || 6;
  const base = String(o.endpoint).replace(/\/+$/, '');
  const url = /\/v1\/messages$/.test(base) ? base : `${base}/v1/messages`;

  const messages = [{ role: 'user', content: String(o.question || '') }];
  let steps = 0;

  while (steps < maxSteps) {
    steps++;
    if (o.signal && o.signal.aborted) return { ids: [], steps, aborted: true };
    const res = await fetchImpl(url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': o.apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: o.model,
        max_tokens: 1024,
        system: SYSTEM_PROMPT,
        tools: toolDefs(),
        messages,
      }),
      signal: o.signal,
    });
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new Error(`ai_search_http_${res.status}: ${body.slice(0, 300)}`);
    }
    const data = await res.json();
    const blocks = Array.isArray(data.content) ? data.content : [];
    messages.push({ role: 'assistant', content: blocks });

    const toolUses = blocks.filter((b) => b && b.type === 'tool_use');
    if (!toolUses.length) {
      // Model answered without a tool call — treat any text as "no structured pick".
      return { ids: [], steps, note: blocks.map(contentText).join('').trim() };
    }

    const results = [];
    let picked = null;
    for (const use of toolUses) {
      if (use.name === 'pick_clips') {
        const ids = Array.isArray(use.input && use.input.ids) ? use.input.ids.map(String) : [];
        picked = ids;
        results.push({ type: 'tool_result', tool_use_id: use.id, content: 'ok' });
      } else if (use.name === 'search_clips') {
        const q = use.input && use.input.query || '';
        const limit = use.input && use.input.limit || 20;
        let out;
        try { out = await tools.searchClips(q, limit); } catch (e) { out = { error: String(e && e.message || e) }; }
        results.push({ type: 'tool_result', tool_use_id: use.id, content: JSON.stringify(shapeSearch(out)) });
      } else if (use.name === 'get_clip') {
        const id = use.input && use.input.id;
        let out;
        try { out = await tools.getClip(id); } catch (e) { out = { error: String(e && e.message || e) }; }
        results.push({ type: 'tool_result', tool_use_id: use.id, content: JSON.stringify(out || { error: 'not_found' }) });
      } else {
        results.push({ type: 'tool_result', tool_use_id: use.id, content: JSON.stringify({ error: 'unknown_tool' }), is_error: true });
      }
    }
    if (picked != null) return { ids: picked, steps };
    messages.push({ role: 'user', content: results });
  }
  return { ids: [], steps, note: 'max_steps' };
}

// Trim a searchClips result to what the model needs (id + preview + light metadata).
function shapeSearch(out) {
  if (!out || out.error) return out || { matches: [] };
  const matches = (out.matches || []).map((m) => ({
    id: m.id, type: m.type, preview: m.preview, title: m.title, groups: m.groups, numpad: m.numpad, pinned: m.pinned,
  }));
  return { matches, nonSharedMatches: out.nonSharedMatches || 0 };
}

module.exports = { runAgent, toolDefs, SYSTEM_PROMPT };
