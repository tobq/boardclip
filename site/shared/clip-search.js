// BoardClip search engine — the ONE authority for query syntax, filtering, and ranking.
// Isomorphic UMD (same header idiom as clipboard-ui-core.js): browser global
// `window.BoardClipSearch`, or CommonJS require. Consumers: the app popup + website demo
// (via clipboard-ui-core.js), the MCP `search_clips` tool (lib/mcp-core.js), and tests.
//
// Design: PURE, no DOM. Operates on normalized "docs" (clipToDoc below) so the pin-shape
// read lives in ONE place here (mirrors lib/clipboard-model.js's documented pin model:
// item.pin == null => unpinned; {number?, groups?} when pinned). Everything a clip can be
// filtered/ranked by — title, body, groups, numpad slot, pinned, type, ts (seconds), length,
// id — is a field on the doc.
//
// Grammar (colon-uniform, quote-aware, `-` negates any token, unknown `word:val` is stripped
// to `val` as free text + recorded so a typo can't silently flood):
//   free text                bare words / "quoted phrase" -> substring over title+body+groups
//   title:VALUE  text:VALUE  field-scoped content (text:/body: = the clip body only)
//   group:NAME   g:NAME      group membership (hierarchical: matches NAME and NAME/child)
//   is:pinned is:image is:text is:numpad     boolean facets
//   num:N                    numpad slot 1-9 (alias for is:numpad + that slot)
//   since:SPEC  before:SPEC  time bounds ("24h" | "7d" | "2026-01-01" | ISO)
//   len:>N  len:<N  len:>=N  character-count bound (text length)
//   id:PREFIX                clip id contains PREFIX
//   sort:new|best            explicit ranking override
// Free text + title:/text: honour the caller's regex flag (the app's `.*` toggle); every
// other facet is an enum/number/time spec, never a regex.

(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.BoardClipSearch = factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  // ── pin-shape accessors (mirror lib/clipboard-model.js; kept inline so the engine is
  //    self-contained in the browser where it can't require the CJS model) ──
  function pinNumber(item) { return item && item.pin && typeof item.pin.number === 'number' ? item.pin.number : null; }
  function pinGroups(item) { return item && item.pin && Array.isArray(item.pin.groups) ? [...new Set(item.pin.groups)] : []; }
  function isPinnedItem(item) { return !!(item && item.pin != null); }
  function cleanTitle(v) { return String(v == null ? '' : v).replace(/\s+/g, ' ').trim(); }

  // Normalized search document for a clip. mcp-core + ui-core both build these.
  function clipToDoc(item) {
    if (!item) return null;
    const isImage = item.type === 'image';
    const body = isImage ? '' : String(item.text || '');
    return {
      id: String(item.id || ''),
      type: isImage ? 'image' : 'text',
      title: cleanTitle(item.title),
      body,
      groups: pinGroups(item),
      numpad: pinNumber(item),
      pinned: isPinnedItem(item),
      ts: Number(item.ts) || 0, // Unix SECONDS
      len: isImage ? 0 : body.length,
    };
  }

  // Combined free-text haystack (title + body + groups + a type keyword) — matches the old
  // itemSearchText so bare words behave as before.
  function docSearchText(doc) {
    if (!doc) return '';
    return [doc.title, doc.type === 'image' ? 'image' : doc.body, doc.type, doc.groups.join(' ')].join(' ');
  }

  // ── group-name helpers (hierarchical `parent/child`, shared semantics with the tag tree) ──
  function normalizeTagName(group) {
    return String(group || '').split('/').map((p) => p.trim()).filter(Boolean).join('/');
  }
  function tagMatchesFilter(group, filter) {
    const tag = normalizeTagName(group);
    const parent = normalizeTagName(filter);
    return !!parent && (tag === parent || tag.startsWith(`${parent}/`));
  }
  function docInGroup(doc, filter) {
    return doc.groups.some((g) => tagMatchesFilter(g, filter));
  }

  // ── quote-aware tokenizer (ported from Forge querySyntax.ts) ──
  function tokenizeQuery(text) {
    const tokens = [];
    let cur = '';
    let has = false;
    let inQuote = false;
    const s = String(text || '');
    for (let i = 0; i < s.length; i++) {
      const ch = s[i];
      if (ch === '"') { inQuote = !inQuote; has = true; continue; }
      if (!inQuote && /\s/.test(ch)) { if (has) { tokens.push(cur); cur = ''; has = false; } continue; }
      cur += ch; has = true;
    }
    if (has) tokens.push(cur);
    return tokens.filter((t) => t.length > 0);
  }
  function quoteToken(v) { return /\s/.test(v) ? `"${String(v).replace(/"/g, '')}"` : String(v); }

  // Builtin chip ids (used by the filter bar) <-> is: facets.
  const BUILTIN_TO_IS = { __pinned__: 'pinned', __images__: 'image', __numbered__: 'numpad' };
  const IS_TO_BUILTIN = { pinned: '__pinned__', image: '__images__', numpad: '__numbered__' };
  const IS_VALUES = ['pinned', 'image', 'text', 'numpad'];

  // Canonical prefix + every accepted alias (short + long). ONE map feeds the
  // parser, the highlight lexer, and autocomplete, so a new alias is added in
  // exactly one place. Short forms: t=title, b=text/body, g=group, n=num, l=len.
  const PREFIX_ALIASES = {
    t: 'title', title: 'title',
    b: 'text', text: 'text', body: 'text',
    g: 'group', group: 'group',
    is: 'is',
    n: 'num', num: 'num',
    s: 'since', since: 'since', after: 'since',
    bf: 'before', before: 'before',
    l: 'len', len: 'len',
    id: 'id',
    o: 'sort', sort: 'sort',
  };
  const RECOGNIZED_PREFIXES = new Set(Object.keys(PREFIX_ALIASES));
  // colon-bearing tokens that are NOT filters (urls / windows paths) — leave verbatim.
  const NON_FILTER_SCHEMES = new Set(['http', 'https', 'ftp', 'ws', 'wss', 'file', 'mailto', 'data', 'blob', 'codex', 'forge', 'claude', 'vscode', 'ssh', 'git', 'tel', 'sms']);

  function emptyParsed(raw) {
    return {
      raw: String(raw == null ? '' : raw),
      content: [],            // { scope:'any'|'title'|'body', value, neg }
      groups: [], negGroups: [],
      is: [], negIs: [],      // arrays of 'pinned'|'image'|'text'|'numpad'
      nums: [], negNums: [],  // numbers 1-9
      since: null, before: null,
      len: null,              // { op:'>'|'<'|'>='|'<='|'=', n }
      id: null,
      sort: null,             // 'new' | 'best'
      unknown: [],            // unrecognized prefixes (for the "not a filter" hint)
    };
  }

  const TIME_RE = /^(\d+)([mhdw])$/i;
  const LEN_RE = /^(>=|<=|>|<|=)?(\d+)$/;

  function parseQuery(query) {
    const out = emptyParsed(query);
    for (const rawTok of tokenizeQuery(query)) {
      let tok = rawTok;
      let neg = false;
      if (tok[0] === '-' && tok.length > 1) { neg = true; tok = tok.slice(1); }
      const m = /^([a-zA-Z][a-zA-Z0-9_]*):([\s\S]+)$/.exec(tok);
      if (m) {
        const rawKey = m[1].toLowerCase();
        const key = PREFIX_ALIASES[rawKey] || rawKey; // fold short aliases to canonical
        const val = m[2];
        // URL / windows-path guard: a value starting with / or \ (http://, C:\path)
        if ((val[0] === '/' || val[0] === '\\') && !RECOGNIZED_PREFIXES.has(rawKey)) { out.content.push({ scope: 'any', value: tok, neg }); continue; }
        if (key === 'title') { out.content.push({ scope: 'title', value: val, neg }); continue; }
        if (key === 'text') { out.content.push({ scope: 'body', value: val, neg }); continue; }
        if (key === 'group') { (neg ? out.negGroups : out.groups).push(normalizeTagName(val)); continue; }
        if (key === 'is') {
          const v = val.toLowerCase();
          if (IS_VALUES.includes(v)) { (neg ? out.negIs : out.is).push(v); continue; }
        }
        if (key === 'num') {
          const n = parseInt(val, 10);
          if (n >= 1 && n <= 9) { (neg ? out.negNums : out.nums).push(n); continue; }
        }
        if (key === 'since') { out.since = val; continue; }
        if (key === 'before') { out.before = val; continue; }
        if (key === 'len') {
          const lm = LEN_RE.exec(val);
          if (lm) { out.len = { op: lm[1] || '=', n: parseInt(lm[2], 10) }; continue; }
        }
        if (key === 'id') { out.id = val; continue; }
        if (key === 'sort') { const v = val.toLowerCase(); if (v === 'new' || v === 'best' || v === 'recent' || v === 'relevance') { out.sort = (v === 'recent' ? 'new' : v === 'relevance' ? 'best' : v); continue; } }
        // an unrecognized word: prefix (typo / unsupported) that isn't a URL scheme ->
        // strip to its value as free text + record the bad prefix for a hint.
        if (!NON_FILTER_SCHEMES.has(rawKey) && /^[a-z][a-z0-9_-]{0,14}$/.test(rawKey)) {
          out.content.push({ scope: 'any', value: val, neg });
          if (!out.unknown.includes(rawKey)) out.unknown.push(rawKey);
          continue;
        }
        // recognized-but-malformed (e.g. num:99) or URL scheme -> treat whole token as text
        out.content.push({ scope: 'any', value: tok, neg });
        continue;
      }
      out.content.push({ scope: 'any', value: tok, neg });
    }
    return out;
  }

  // Deterministic serialization: content first, then structural facets (stable order).
  function serializeQuery(p) {
    const parts = [];
    for (const c of p.content) parts.push((c.neg ? '-' : '') + (c.scope === 'title' ? 'title:' : c.scope === 'body' ? 'text:' : '') + quoteToken(c.value));
    for (const g of p.groups) parts.push('group:' + quoteToken(g));
    for (const g of p.negGroups) parts.push('-group:' + quoteToken(g));
    for (const v of p.is) parts.push('is:' + v);
    for (const v of p.negIs) parts.push('-is:' + v);
    for (const n of p.nums) parts.push('num:' + n);
    for (const n of p.negNums) parts.push('-num:' + n);
    if (p.since) parts.push('since:' + quoteToken(p.since));
    if (p.before) parts.push('before:' + quoteToken(p.before));
    if (p.len) parts.push('len:' + (p.len.op === '=' ? '' : p.len.op) + p.len.n);
    if (p.id) parts.push('id:' + quoteToken(p.id));
    if (p.sort) parts.push('sort:' + p.sort);
    return parts.join(' ');
  }

  // ── chip <-> query bridge: toggle a facet in the query string (bar = source of truth) ──
  // token: { kind:'group'|'builtin'|'num', value } ; intent: 'include'|'exclude'.
  function toggleIn(arr, v) { const i = arr.indexOf(v); if (i >= 0) { arr.splice(i, 1); return false; } arr.push(v); return true; }
  function applyFacet(query, token, intent) {
    const p = parseQuery(query);
    const exclude = intent === 'exclude';
    let inc, ex, value;
    if (token.kind === 'group') { inc = p.groups; ex = p.negGroups; value = normalizeTagName(token.value); }
    else if (token.kind === 'num') { inc = p.nums; ex = p.negNums; value = Number(token.value); }
    else { // builtin id (__pinned__/__images__/__numbered__) -> is: facet
      const isv = BUILTIN_TO_IS[token.value] || token.value;
      inc = p.is; ex = p.negIs; value = isv;
    }
    const rm = (arr, v) => { const i = arr.indexOf(v); if (i >= 0) arr.splice(i, 1); };
    if (exclude) {
      if (ex.indexOf(value) >= 0) rm(ex, value);          // already excluded -> clear
      else { rm(inc, value); ex.push(value); }             // include->exclude / add exclude
    } else {
      if (inc.indexOf(value) >= 0) rm(inc, value);         // already included -> clear
      else if (ex.indexOf(value) >= 0) rm(ex, value);      // excluded -> clear
      else inc.push(value);                                // add include
    }
    return serializeQuery(p);
  }

  // Chip active/excluded state for the filter bar, derived straight from the query.
  function facetState(parsed) {
    const active = new Set();
    const excluded = new Set();
    for (const g of parsed.groups) active.add(g);
    for (const g of parsed.negGroups) excluded.add(g);
    for (const v of parsed.is) if (IS_TO_BUILTIN[v]) active.add(IS_TO_BUILTIN[v]);
    for (const v of parsed.negIs) if (IS_TO_BUILTIN[v]) excluded.add(IS_TO_BUILTIN[v]);
    if (parsed.nums.length || parsed.is.includes('numpad')) active.add('__numbered__');
    return { active, excluded };
  }

  function anyFilterActive(parsed) {
    return !!(parsed.groups.length || parsed.negGroups.length || parsed.is.length || parsed.negIs.length ||
      parsed.nums.length || parsed.negNums.length || parsed.since || parsed.before || parsed.len || parsed.id);
  }
  function isEmptyQuery(parsed) {
    return !parsed.content.length && !anyFilterActive(parsed) && !parsed.sort;
  }

  // ── time-spec resolution (mirrors Forge resolveTimeMs) ──
  const UNIT_MS = { m: 60000, h: 3600000, d: 86400000, w: 604800000 };
  function resolveTimeMs(spec, now) {
    const s = String(spec || '').trim();
    if (!s) return null;
    const m = TIME_RE.exec(s);
    if (m) return (now || Date.now()) - parseInt(m[1], 10) * UNIT_MS[m[2].toLowerCase()];
    const t = Date.parse(s);
    return Number.isNaN(t) ? null : t;
  }

  // ── matching ──
  function makeTermMatcher(value, regex) {
    if (regex) { try { const re = new RegExp(value, 'i'); return (t) => re.test(String(t || '')); } catch { return () => false; } }
    const lower = String(value).toLowerCase();
    return (t) => String(t || '').toLowerCase().includes(lower);
  }
  function lenSatisfies(len, cond) {
    switch (cond.op) {
      case '>': return len > cond.n;
      case '<': return len < cond.n;
      case '>=': return len >= cond.n;
      case '<=': return len <= cond.n;
      default: return len === cond.n;
    }
  }
  // Strict AND filter. `opts`: { regex, now, searchText? (precomputed combined haystack) }.
  function matchDoc(doc, parsed, opts) {
    if (!doc) return false;
    const o = opts || {};
    const regex = !!o.regex;
    const any = o.searchText != null ? o.searchText : docSearchText(doc);
    for (const c of parsed.content) {
      const hay = c.scope === 'title' ? doc.title : c.scope === 'body' ? doc.body : any;
      const hit = makeTermMatcher(c.value, regex)(hay);
      if (c.neg ? hit : !hit) return false;
    }
    for (const g of parsed.groups) if (!docInGroup(doc, g)) return false;
    for (const g of parsed.negGroups) if (docInGroup(doc, g)) return false;
    for (const v of parsed.is) if (!docHasIs(doc, v)) return false;
    for (const v of parsed.negIs) if (docHasIs(doc, v)) return false;
    if (parsed.nums.length && !parsed.nums.includes(doc.numpad)) return false;
    for (const n of parsed.negNums) if (doc.numpad === n) return false;
    if (parsed.since != null) { const b = resolveTimeMs(parsed.since, o.now); if (b != null && doc.ts * 1000 < b) return false; }
    if (parsed.before != null) { const b = resolveTimeMs(parsed.before, o.now); if (b != null && doc.ts * 1000 > b) return false; }
    if (parsed.len && !lenSatisfies(doc.len, parsed.len)) return false;
    if (parsed.id && !doc.id.toLowerCase().includes(String(parsed.id).toLowerCase())) return false;
    return true;
  }
  function docHasIs(doc, v) {
    if (v === 'pinned') return doc.pinned;
    if (v === 'image') return doc.type === 'image';
    if (v === 'text') return doc.type === 'text';
    if (v === 'numpad') return doc.numpad != null;
    return false;
  }

  // ── relevance scoring (for the strict-filter list; rank survivors) ──
  const RECENCY_HALFLIFE_MS = 3 * 86400 * 1000; // 3 days
  const RECENCY_WEIGHT = 30;                     // max recency contribution vs relevance
  function recencyScore(doc, now) {
    const age = Math.max(0, (now || Date.now()) - doc.ts * 1000);
    return RECENCY_WEIGHT * Math.exp(-age / RECENCY_HALFLIFE_MS);
  }
  function normalizedPhrase(v) { return String(v == null ? '' : v).trim().toLowerCase(); }
  function relevanceScore(doc, parsed, opts) {
    const o = opts || {};
    const regex = !!o.regex;
    let score = 0;
    const titleLower = doc.title.toLowerCase();
    const bodyLower = doc.body.toLowerCase();
    for (const c of parsed.content) {
      if (c.neg) continue; // negatives don't add signal
      const v = normalizedPhrase(c.value);
      if (!v) continue;
      const wantTitle = c.scope !== 'body';
      const wantBody = c.scope !== 'title';
      // exact / prefix / substring in title
      if (wantTitle && doc.title) {
        if (titleLower === v) score += 60;
        else if (titleLower.startsWith(v)) score += 34;
        else if (titleLower.includes(v)) score += 22;
        else if (!regex) { const fm = fuzzyMatch(v, doc.title); if (fm && fm.score >= fuzzyFloor(v.length)) score += 10 + Math.min(14, fm.score / 6); }
      }
      if (wantBody && doc.body) {
        const idx = bodyLower.indexOf(v);
        if (idx >= 0) { score += 12; score += Math.max(0, 6 - idx / 200); } // earlier = a touch better
        // multi-word phrase already covered by includes; word tokens add a little
        if (/\s/.test(v) && idx >= 0) score += 6;
      }
      if (c.scope === 'any') {
        // group-name hit is weak signal
        if (doc.groups.some((g) => g.toLowerCase().includes(v))) score += 4;
      }
    }
    // small structural nudges
    if (doc.pinned) score += 3;
    return score;
  }

  // Filter + rank -> array of ORIGINAL indexes. `opts`: { regex, now, sortMode ('best'|'new'),
  // docs? (prebuilt), searchTextLower? (precomputed combined haystacks, lowercased) }.
  function filterRankIndexes(items, parsed, opts) {
    const o = opts || {};
    const now = o.now || Date.now();
    const docs = o.docs || (items || []).map(clipToDoc);
    const hay = o.searchTextLower || null;
    const hasContent = parsed.content.length > 0;
    // Ranking mode: an explicit sortMode (the Best/Recent toggle) or `sort:` token wins;
    // else relevance when a content query is present; else the caller's ORIGINAL order
    // (the popup's history/recency order is the "idle" default — we don't reshuffle it).
    const mode = o.sortMode || (parsed.sort ? parsed.sort : (hasContent ? 'best' : 'none'));
    const scored = [];
    for (let i = 0; i < docs.length; i++) {
      const doc = docs[i];
      if (!doc) continue;
      if (!matchDoc(doc, parsed, { regex: o.regex, now, searchText: hay ? hay[i] : undefined })) continue;
      const rel = mode === 'best' && hasContent ? relevanceScore(doc, parsed, o) : 0;
      scored.push({ i, total: rel + recencyScore(doc, now), ts: doc.ts });
    }
    if (mode === 'best') scored.sort((a, b) => b.total - a.total || b.ts - a.ts);
    else if (mode === 'new') scored.sort((a, b) => b.ts - a.ts || b.i - a.i);
    // mode 'none' -> leave in original (caller/history) order
    return scored.map((s) => s.i);
  }

  // ── IntelliJ camel-hump fuzzy matcher (ported from Forge src/renderer/lib/fuzzy.ts,
  //    React stripped). `sdi` -> "Sync Data-loss Incident". Returns {score, positions}|null. ──
  const F_BONUS_WORD_START = 24, F_BONUS_STRING_START = 12, F_BONUS_CONSECUTIVE = 16, F_BONUS_CASE = 2, F_PENALTY_GAP = -2, F_PENALTY_LEAD = -1, F_LEAD_CAP = -6;
  const fIsSep = (c) => c === ' ' || c === '-' || c === '_' || c === '/' || c === '\\' || c === '.' || c === ':';
  const fLower = (c) => c >= 'a' && c <= 'z';
  const fUpper = (c) => c >= 'A' && c <= 'Z';
  const fDigit = (c) => c >= '0' && c <= '9';
  function wordStarts(t) {
    const out = new Uint8Array(t.length);
    for (let i = 0; i < t.length; i++) {
      const c = t[i];
      if (fIsSep(c)) continue;
      const p = i === 0 ? '' : t[i - 1];
      if (i === 0 || fIsSep(p)) out[i] = 1;
      else if (fUpper(c) && fLower(p)) out[i] = 1;
      else if (fDigit(c) !== fDigit(p) && !fIsSep(p)) out[i] = 1;
    }
    return out;
  }
  function fuzzyMatch(query, target) {
    const q = String(query || '');
    const n = q.length;
    const m = String(target || '').length;
    if (!n || n > m) return null;
    const ql = q.toLowerCase();
    const tl = String(target).toLowerCase();
    for (let i = 0, j = 0; i < n; i++) { j = tl.indexOf(ql[i], j); if (j < 0) return null; j++; }
    const starts = wordStarts(String(target));
    const NEG = -Infinity;
    let prev = new Float64Array(m).fill(NEG);
    let cur = new Float64Array(m).fill(NEG);
    const parent = new Int32Array(n * m).fill(-1);
    for (let i = 0; i < n; i++) {
      cur.fill(NEG);
      let bestCarry = NEG, bestCarryIdx = -1;
      for (let j = 0; j < m; j++) {
        if (i > 0 && j > 0) { const cand = prev[j - 1] - F_PENALTY_GAP * (j - 1); if (cand > bestCarry) { bestCarry = cand; bestCarryIdx = j - 1; } }
        if (tl[j] !== ql[i]) continue;
        const boundary = starts[j] === 1;
        let base, par = -1;
        if (i === 0) { if (!boundary) continue; base = Math.max(F_PENALTY_LEAD * j, F_LEAD_CAP); }
        else {
          const adj = j > 0 ? prev[j - 1] : NEG;
          if (boundary) {
            const gen = bestCarry === NEG ? NEG : bestCarry + F_PENALTY_GAP * (j - 1);
            if (adj !== NEG && adj + F_BONUS_CONSECUTIVE >= gen) { base = adj + F_BONUS_CONSECUTIVE; par = j - 1; }
            else if (gen !== NEG) { base = gen; par = bestCarryIdx; }
            else continue;
          } else { if (adj === NEG) continue; base = adj + F_BONUS_CONSECUTIVE; par = j - 1; }
        }
        let s = base + 8;
        if (starts[j]) s += F_BONUS_WORD_START + (j === 0 ? F_BONUS_STRING_START : 0);
        if (String(target)[j] === q[i]) s += F_BONUS_CASE;
        if (s > cur[j]) { cur[j] = s; parent[i * m + j] = par; }
      }
      const t = prev; prev = cur; cur = t;
    }
    let best = NEG, bestJ = -1;
    for (let j = 0; j < m; j++) if (prev[j] > best) { best = prev[j]; bestJ = j; }
    if (bestJ < 0) return null;
    const positions = new Array(n);
    for (let i = n - 1, j = bestJ; i >= 0; i--) { positions[i] = j; j = parent[i * m + j]; }
    return { score: best, positions };
  }
  function fuzzyFloor(queryLen) { return 8 * queryLen + 4; }

  // ── token-IDF fuzzy ranking (ported from claude-utils session-core.js sessionQueryScore) —
  //    the AI-mode-no-key "smart ranking": weighted token overlap + phrase boost + a relevance
  //    floor so a vague query returns a FEW strong matches, never a flood. ──
  function tokenize(text) {
    return String(text || '').toLowerCase().match(/[a-z0-9]+/gi) ? String(text || '').toLowerCase().match(/[a-z0-9]+/g) || [] : [];
  }
  function buildIdf(docs) {
    const df = new Map();
    const N = docs.length || 1;
    for (const doc of docs) {
      if (!doc) continue;
      const seen = new Set(tokenize(doc.title + ' ' + doc.body + ' ' + doc.groups.join(' ')));
      for (const t of seen) df.set(t, (df.get(t) || 0) + 1);
    }
    const idf = new Map();
    for (const [t, c] of df) idf.set(t, Math.log(1 + N / c));
    return idf;
  }
  function phraseBoost(text, phrase, amount) {
    const p = normalizedPhrase(phrase);
    if (p.length < 6 || !/\s/.test(p)) return 0;
    return String(text || '').toLowerCase().includes(p) ? amount : 0;
  }
  function fuzzyDocScore(doc, queryTokens, query, idf) {
    const titleTokens = new Set(tokenize(doc.title));
    const bodyTokens = new Set(tokenize(doc.body + ' ' + doc.groups.join(' ')));
    let score = 0;
    let matchedWeight = 0;
    let totalWeight = 0;
    for (const t of queryTokens) {
      const w = (idf && idf.get(t)) || 1;
      totalWeight += w;
      let hit = 0;
      if (titleTokens.has(t)) hit = w * 3;      // title tokens weigh more
      else if (bodyTokens.has(t)) hit = w;
      if (hit) { score += hit; matchedWeight += w; }
    }
    score += phraseBoost(doc.title, query, 8);
    score += phraseBoost(doc.body, query, 4);
    // title abbreviation (sdi -> Sync Data Incident)
    if (query && !/\s/.test(query.trim())) { const fm = fuzzyMatch(query.trim(), doc.title); if (fm && fm.score >= fuzzyFloor(query.trim().length)) score += 6 + Math.min(10, fm.score / 8); }
    return { score, matchedWeight, totalWeight };
  }
  // Rank ALL docs fuzzily, keep those clearing the relevance floor. `opts`: { idf, now,
  // floor (fraction 0..1 of query weight that must be matched, default 0.34), limit }.
  function rankFuzzyIndexes(items, query, opts) {
    const o = opts || {};
    const docs = o.docs || (items || []).map(clipToDoc);
    const q = String(query || '').trim();
    if (!q) return [];
    const queryTokens = [...new Set(tokenize(q))];
    if (!queryTokens.length) return [];
    const idf = o.idf || buildIdf(docs);
    const floor = o.floor != null ? o.floor : 0.34;
    const now = o.now || Date.now();
    const scored = [];
    for (let i = 0; i < docs.length; i++) {
      const doc = docs[i];
      if (!doc) continue;
      const r = fuzzyDocScore(doc, queryTokens, q, idf);
      if (r.score <= 0) continue;
      if (r.totalWeight > 0 && r.matchedWeight / r.totalWeight < floor) continue;
      scored.push({ i, total: r.score + recencyScore(doc, now) * 0.15, ts: doc.ts });
    }
    scored.sort((a, b) => b.total - a.total || b.ts - a.ts);
    const out = scored.map((s) => s.i);
    return o.limit ? out.slice(0, o.limit) : out;
  }

  // ── query syntax lexer (presentational, for the highlight overlay) ──
  // Walks the EXACT raw text (whitespace + quotes preserved, concat(text) === input) into
  // typed segments: prefix | value | neg | quote | regex | unknown | ws. parseQuery stays
  // the semantic authority; this only decides colors, derived from the same prefix sets.
  function rawTokensPreserving(text) {
    const out = [];
    let cur = '';
    let start = 0;
    let inQuote = false;
    const s = String(text || '');
    for (let i = 0; i < s.length; i++) {
      const ch = s[i];
      if (ch === '"') inQuote = !inQuote;
      if (!inQuote && /\s/.test(ch)) { if (cur) out.push({ text: cur, start }); cur = ''; continue; }
      if (!cur) start = i;
      cur += ch;
    }
    if (cur) out.push({ text: cur, start });
    return out;
  }
  const REGEX_META = /[[\]().*+?|^$\\{}]/;
  function pushValueSegs(segs, value, regexAware) {
    let buf = '';
    let kind = null;
    const flush = () => { if (buf && kind) segs.push({ kind, text: buf }); buf = ''; kind = null; };
    for (const ch of String(value)) {
      const k = ch === '"' ? 'quote' : (regexAware && REGEX_META.test(ch)) ? 'regex' : 'value';
      if (k !== kind) flush();
      buf += ch; kind = k;
    }
    flush();
  }
  // `opts.regex` = the app's .* toggle: content values get regex-metachar coloring only then.
  function lexQuery(text, opts) {
    const o = opts || {};
    const segs = [];
    let pos = 0;
    const s = String(text || '');
    for (const tok of rawTokensPreserving(s)) {
      if (tok.start > pos) segs.push({ kind: 'ws', text: s.slice(pos, tok.start) });
      pos = tok.start + tok.text.length;
      let body = tok.text;
      if (body[0] === '-' && body.length > 1) { segs.push({ kind: 'neg', text: '-' }); body = body.slice(1); }
      const m = /^([a-zA-Z][a-zA-Z0-9_]{0,14}):(.*)$/.exec(body);
      if (m && m[2] && m[2][0] !== '/' && m[2][0] !== '\\') {
        const key = m[1].toLowerCase();
        if (RECOGNIZED_PREFIXES.has(key)) {
          segs.push({ kind: 'prefix', text: body.slice(0, m[1].length + 1) });
          const canon = PREFIX_ALIASES[key];
          const contentScope = canon === 'title' || canon === 'text';
          pushValueSegs(segs, m[2], contentScope && !!o.regex);
          continue;
        }
        if (!NON_FILTER_SCHEMES.has(key)) {
          segs.push({ kind: 'unknown', text: body.slice(0, m[1].length + 1) });
          pushValueSegs(segs, m[2], !!o.regex);
          continue;
        }
      }
      pushValueSegs(segs, body, !!o.regex);
    }
    if (pos < s.length) segs.push({ kind: 'ws', text: s.slice(pos) });
    return segs;
  }

  // ── autocomplete suggestions for the token being typed at `caret` ──
  // Returns { replaceStart, replaceEnd, suggestions: [{ text, label, hint }] } or null.
  const IS_SUGGESTIONS = ['is:pinned', 'is:image', 'is:text', 'is:numpad'];
  const SINCE_PRESETS = ['1h', '24h', '7d', '30d'];
  const PREFIX_HINTS = {
    'title:': 'match the clip title', 'text:': 'match the clip body', 'group:': 'in group',
    'is:': 'pinned / image / text / numpad', 'num:': 'numpad slot 1-9', 'since:': 'newer than',
    'before:': 'older than', 'len:': 'character count (len:>100)', 'id:': 'clip id prefix', 'sort:': 'new / best',
  };
  // Canonical prefix → its short alias (for the "or t:" hint on suggestions). Kept
  // in sync with PREFIX_ALIASES; only prefixes with a distinct short form appear.
  const PREFIX_SHORT = { 'title:': 't:', 'text:': 'b:', 'group:': 'g:', 'num:': 'n:', 'since:': 's:', 'before:': 'bf:', 'len:': 'l:', 'sort:': 'o:' };
  function suggestQuery(text, caret, opts) {
    const o = opts || {};
    const s = String(text || '');
    const at = Math.max(0, Math.min(caret == null ? s.length : caret, s.length));
    // find the token containing/ending at the caret
    let start = at;
    while (start > 0 && !/\s/.test(s[start - 1])) start--;
    const tok = s.slice(start, at);
    if (!tok) return null;
    const neg = tok[0] === '-' ? '-' : '';
    const body = neg ? tok.slice(1) : tok;
    const out = [];
    const push = (textVal, hint) => { out.push({ text: neg + textVal, label: neg + textVal, hint: hint || '' }); };
    const cm = /^([a-zA-Z][a-zA-Z0-9_]*):([\s\S]*)$/.exec(body);
    if (cm) {
      const rawKey = cm[1].toLowerCase();
      const key = PREFIX_ALIASES[rawKey] || rawKey; // fold short aliases (t:/g:/n:…) to canonical
      const val = cm[2].toLowerCase();
      if (key === 'group') {
        for (const g of (o.groups || [])) if (!val || g.toLowerCase().includes(val)) push(`group:${quoteToken(g)}`, 'group');
      } else if (key === 'is') {
        for (const sug of IS_SUGGESTIONS) if (!val || sug.slice(3).startsWith(val)) push(sug, PREFIX_HINTS['is:']);
      } else if (key === 'since' || key === 'before') {
        for (const p of SINCE_PRESETS) if (!val || p.startsWith(val)) push(`${key}:${p}`, key === 'before' ? 'older than' : 'newer than');
      } else if (key === 'num') {
        for (let n = 1; n <= 9; n++) if (!val || String(n).startsWith(val)) push(`num:${n}`, 'numpad slot');
      } else if (key === 'sort') {
        for (const v of ['new', 'best']) if (!val || v.startsWith(val)) push(`sort:${v}`, 'result order');
      }
    } else if (body.length >= 1) {
      // A bare word: offer prefixes it could start. Match on BOTH the long form
      // (ti -> title:) AND the short alias (t -> title:, g -> group:), and hint the
      // short form so both are discoverable. De-dupe so t only appears once.
      const lower = body.toLowerCase();
      const seen = new Set();
      const offer = (canonPrefix) => {
        if (seen.has(canonPrefix)) return;
        seen.add(canonPrefix);
        const short = PREFIX_SHORT[canonPrefix];
        push(canonPrefix, short ? `${PREFIX_HINTS[canonPrefix]} · or ${short}` : PREFIX_HINTS[canonPrefix]);
      };
      // long-form prefix matches
      for (const p of Object.keys(PREFIX_HINTS)) if (p.startsWith(lower) && p !== lower) offer(p);
      // short-alias matches: the typed word IS a short alias (or its start)
      for (const [alias, canon] of Object.entries(PREFIX_ALIASES)) {
        const canonPrefix = canon + ':';
        if (PREFIX_HINTS[canonPrefix] && alias.startsWith(lower)) offer(canonPrefix);
      }
      for (const g of (o.groups || [])) if (g.toLowerCase().startsWith(lower)) push(`group:${quoteToken(g)}`, 'group');
    }
    if (!out.length) return null;
    return { replaceStart: start, replaceEnd: at, suggestions: out.slice(0, 8) };
  }

  return {
    clipToDoc, docSearchText, normalizeTagName, tagMatchesFilter, docInGroup,
    tokenizeQuery, quoteToken, parseQuery, serializeQuery, applyFacet, facetState,
    anyFilterActive, isEmptyQuery, resolveTimeMs,
    matchDoc, relevanceScore, recencyScore, filterRankIndexes,
    fuzzyMatch, fuzzyFloor, tokenize, buildIdf, fuzzyDocScore, rankFuzzyIndexes,
    lexQuery, suggestQuery,
    BUILTIN_TO_IS, IS_TO_BUILTIN, IS_VALUES, RECOGNIZED_PREFIXES, NON_FILTER_SCHEMES,
  };
});
