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
//   len:>N  len:<N  len:>=N  character-count bound (text length); also len:N-M (range)
//   lines:>N  words:>N       line / word count bounds (same comparators as len:)
//   is:url is:multiline is:rich   body is a link / spans lines / carries HTML or RTF
//   id:PREFIX                clip id contains PREFIX
//   sort:new|best            explicit ranking override
// The user-facing reference for all of this is SYNTAX_HELP (rendered by the search
// options panel) - keep it in step with the parser.
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
  // A clip that IS a link: one line, a URL scheme or a bare domain, no spaces.
  const URL_BODY_RE = /^(?:[a-z][a-z0-9+.-]*:\/\/|www\.)[^\s]+$|^[a-z0-9-]+(?:\.[a-z0-9-]+)+(?:\/[^\s]*)?$/i;

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
      // lines / words / url: computed on first use (docLines/docWords/docUrl).
      // Only the lines:/words:/is:multiline/is:url facets read them, and working
      // them out splits every body - a quarter-second per keystroke on a 70 MB
      // history when it was done here.
      rich: !isImage && !!(item.html || item.htmlRef || item.htmlHash || item.rtf || item.rtfRef || item.rtfHash),
    };
  }
  function docLines(doc) {
    if (doc.lines === undefined) {
      const s = doc.type === 'image' ? '' : doc.body;
      let n = s ? 1 : 0;
      for (let i = 0; i < s.length; i += 1) {
        const c = s.charCodeAt(i);
        if (c === 10) n += 1;
        else if (c === 13) { n += 1; if (s.charCodeAt(i + 1) === 10) i += 1; }
      }
      doc.lines = n;
    }
    return doc.lines;
  }
  function docWords(doc) {
    if (doc.words === undefined) {
      const s = doc.type === 'image' ? '' : doc.body.trim();
      doc.words = s ? s.split(/\s+/).length : 0;
    }
    return doc.words;
  }
  function docUrl(doc) {
    if (doc.url === undefined) doc.url = doc.type !== 'image' && URL_BODY_RE.test(doc.body.trim());
    return doc.url;
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
  const IS_VALUES = ['pinned', 'image', 'text', 'numpad', 'url', 'multiline', 'rich'];

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
    ln: 'lines', lines: 'lines',
    wd: 'words', words: 'words',
    id: 'id',
    o: 'sort', sort: 'sort',
  };
  const RECOGNIZED_PREFIXES = new Set(Object.keys(PREFIX_ALIASES));
  // What a filter key looks like: ONE rule for the parser, the autocomplete and
  // the validator, so they cannot disagree (Content-Type:x has a hyphen, so it
  // is plain text everywhere). An unrecognised key of this shape is stripped to
  // its value (UNKNOWN_KEY_RE, lowercased key); a longer one stays text.
  const KEY_TOKEN_RE = /^([a-zA-Z][a-zA-Z0-9_]*):([\s\S]*)$/;
  const UNKNOWN_KEY_RE = /^[a-z][a-z0-9_]{0,14}$/;
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
      len: null,              // { op:'>'|'<'|'>='|'<='|'='|'range', n, m? }
      lines: null,            // same shape as len
      words: null,            // same shape as len
      id: null,
      sort: null,             // 'new' | 'best'
      unknown: [],            // unrecognized prefixes (for the "not a filter" hint)
    };
  }

  const TIME_RE = /^(\d+)([mhdw])$/i;
  const LEN_RE = /^(>=|<=|>|<|=)?(\d+)$/;
  const RANGE_RE = /^(\d+)\s*(?:-|\.\.)\s*(\d+)$/;
  function parseBound(val) {
    const rm = RANGE_RE.exec(val);
    if (rm) { const a = parseInt(rm[1], 10); const b = parseInt(rm[2], 10); return { op: 'range', n: Math.min(a, b), m: Math.max(a, b) }; }
    const lm = LEN_RE.exec(val);
    return lm ? { op: lm[1] || '=', n: parseInt(lm[2], 10) } : null;
  }
  function serializeBound(b) {
    if (!b) return '';
    if (b.op === 'range') return `${b.n}-${b.m}`;
    return (b.op === '=' ? '' : b.op) + b.n;
  }

  // Content terms keep the token exactly as typed (`raw`), so a chip rewriting
  // the query (applyFacet -> serializeQuery) never reshapes the user's words: an
  // unknown `titel:foo` stays `titel:foo`, quotes stay where they were typed.
  function parseQuery(query) {
    const out = emptyParsed(query);
    for (const { text: typed } of rawTokensPreserving(query)) {
      const rawTok = typed.replace(/"/g, '');
      if (!rawTok) continue;
      const before = out.content.length;
      parseToken(out, rawTok);
      // Non-enumerable: serialization metadata, invisible to consumers that
      // compare or spread a term.
      if (out.content.length > before) Object.defineProperty(out.content[out.content.length - 1], 'raw', { value: typed, writable: true, configurable: true });
    }
    return out;
  }
  function parseToken(out, rawTok) {
    {
      let tok = rawTok;
      let neg = false;
      if (tok[0] === '-' && tok.length > 1) { neg = true; tok = tok.slice(1); }
      const m = KEY_TOKEN_RE.exec(tok);
      if (m && m[2]) {
        const rawKey = m[1].toLowerCase();
        const key = PREFIX_ALIASES[rawKey] || rawKey; // fold short aliases to canonical
        const val = m[2];
        // URL / windows-path guard: a value starting with / or \ (http://, C:\path)
        if ((val[0] === '/' || val[0] === '\\') && !RECOGNIZED_PREFIXES.has(rawKey)) { out.content.push({ scope: 'any', value: tok, neg }); return; }
        if (key === 'title') { out.content.push({ scope: 'title', value: val, neg }); return; }
        if (key === 'text') { out.content.push({ scope: 'body', value: val, neg }); return; }
        if (key === 'group') { (neg ? out.negGroups : out.groups).push(normalizeTagName(val)); return; }
        if (key === 'is') {
          const v = val.toLowerCase();
          if (IS_VALUES.includes(v)) { (neg ? out.negIs : out.is).push(v); return; }
        }
        if (key === 'num') {
          const n = parseInt(val, 10);
          if (n >= 1 && n <= 9) { (neg ? out.negNums : out.nums).push(n); return; }
        }
        if (key === 'since') { out.since = val; return; }
        if (key === 'before') { out.before = val; return; }
        if (key === 'len' || key === 'lines' || key === 'words') {
          const bound = parseBound(val);
          if (bound) { out[key] = bound; return; }
        }
        if (key === 'id') { out.id = val; return; }
        if (key === 'sort') { const v = val.toLowerCase(); if (v === 'new' || v === 'best' || v === 'recent' || v === 'relevance') { out.sort = (v === 'recent' ? 'new' : v === 'relevance' ? 'best' : v); return; } }
        // an unrecognized word: prefix (typo / unsupported) that isn't a URL scheme ->
        // strip to its value as free text + record the bad prefix for a hint.
        if (!NON_FILTER_SCHEMES.has(rawKey) && UNKNOWN_KEY_RE.test(rawKey)) {
          out.content.push({ scope: 'any', value: val, neg });
          if (!out.unknown.includes(rawKey)) out.unknown.push(rawKey);
          return;
        }
        // recognized-but-malformed (e.g. num:99) or URL scheme -> treat whole token as text
        out.content.push({ scope: 'any', value: tok, neg });
        return;
      }
      out.content.push({ scope: 'any', value: tok, neg });
    }
  }

  // Canonical serialization: the content terms first, as typed (their `raw`
  // token) and in the typed order, then the facets in ONE fixed order
  // (FACET_ORDER, then value: groups by name, is: by IS_VALUES, slots
  // ascending). facetKey uses it; a chip never re-serializes the query (see
  // applyFacet: it edits only the tokens it changes).
  const byName = (a, b) => a.localeCompare(b, undefined, { sensitivity: 'base', numeric: true }) || (a < b ? -1 : a > b ? 1 : 0);
  const byIs = (a, b) => IS_VALUES.indexOf(a) - IS_VALUES.indexOf(b);
  const byNum = (a, b) => a - b;
  const FACET_ORDER = ['group', '-group', 'is', '-is', 'num', '-num', 'since', 'before', 'len', 'lines', 'words', 'id', 'sort'];
  // One query token per facet value, canonical text, canonical order.
  function facetParts(p) {
    const parts = [];
    for (const g of [...p.groups].sort(byName)) parts.push('group:' + quoteToken(g));
    for (const g of [...p.negGroups].sort(byName)) parts.push('-group:' + quoteToken(g));
    for (const v of [...p.is].sort(byIs)) parts.push('is:' + v);
    for (const v of [...p.negIs].sort(byIs)) parts.push('-is:' + v);
    for (const n of [...p.nums].sort(byNum)) parts.push('num:' + n);
    for (const n of [...p.negNums].sort(byNum)) parts.push('-num:' + n);
    if (p.since) parts.push('since:' + quoteToken(p.since));
    if (p.before) parts.push('before:' + quoteToken(p.before));
    if (p.len) parts.push('len:' + serializeBound(p.len));
    if (p.lines) parts.push('lines:' + serializeBound(p.lines));
    if (p.words) parts.push('words:' + serializeBound(p.words));
    if (p.id) parts.push('id:' + quoteToken(p.id));
    if (p.sort) parts.push('sort:' + p.sort);
    return parts;
  }
  function serializeQuery(p) {
    const parts = [];
    for (const c of p.content) parts.push(c.raw || ((c.neg ? '-' : '') + (c.scope === 'title' ? 'title:' : c.scope === 'body' ? 'text:' : '') + quoteToken(c.value)));
    return parts.concat(facetParts(p)).join(' ');
  }
  // The query's filters alone (no free text, no sort), canonical: the cache key
  // for everything that depends only on them (the availability census, the
  // options panel's chips, incremental refinement).
  function facetKey(parsed) {
    return serializeQuery({ ...parsed, content: [], sort: null });
  }
  // A facet part's kind as FACET_ORDER names it ('-group', 'since', ...).
  function partKind(part) {
    const neg = part[0] === '-' ? '-' : '';
    return neg + part.slice(neg.length).split(':')[0];
  }
  function partValue(part) {
    return part.slice(part.indexOf(':') + 1).replace(/^"|"$/g, '');
  }
  // FACET_ORDER, then the value order of that kind.
  function compareParts(a, b) {
    const ka = partKind(a);
    const kb = partKind(b);
    if (ka !== kb) return FACET_ORDER.indexOf(ka) - FACET_ORDER.indexOf(kb);
    const k = ka.replace(/^-/, '');
    if (k === 'group') return byName(partValue(a), partValue(b));
    if (k === 'is') return byIs(partValue(a), partValue(b));
    if (k === 'num') return byNum(Number(partValue(a)), Number(partValue(b)));
    return 0;
  }
  // The facet part ONE typed token stands for (its canonical text), or null
  // for a content term.
  function tokenPart(typed) {
    const one = emptyParsed('');
    const tok = String(typed).replace(/"/g, '');
    if (tok) parseToken(one, tok);
    const parts = facetParts(one);
    return parts.length ? parts[0] : null;
  }

  // ── chip <-> query bridge: toggle a facet in the query string (bar = source of truth) ──
  // token: { kind:'group'|'builtin'|'is'|'num', value } ; intent: 'include'|'exclude'.
  // Single-valued facets ({ kind:'since'|'before'|'len'|'lines'|'words'|'id', value }) have no
  // exclude: the chip's value replaces the token, and the same value again clears it.
  // The text is EDITED, never re-serialized: only the tokens the change removes
  // go, a new token goes in at its canonical place among the facet tokens
  // already there (FACET_ORDER + value order, so chips clicked in any order
  // write the same text), and everything else - the words, their quotes, an
  // unknown prefix, the order the user typed - stays exactly as typed.
  const SINGLE_FACETS = ['since', 'before', 'len', 'lines', 'words', 'id'];
  const BOUND_FACETS = ['len', 'lines', 'words'];
  function toggleIn(arr, v) { const i = arr.indexOf(v); if (i >= 0) { arr.splice(i, 1); return false; } arr.push(v); return true; }
  function changeFacet(p, token, intent) {
    if (SINGLE_FACETS.includes(token.kind)) {
      const k = token.kind;
      if (BOUND_FACETS.includes(k)) {
        const bound = parseBound(String(token.value == null ? '' : token.value));
        p[k] = bound && !(p[k] && serializeBound(p[k]) === serializeBound(bound)) ? bound : null;
      } else {
        const v = String(token.value == null ? '' : token.value).trim();
        p[k] = v && String(p[k] || '').toLowerCase() !== v.toLowerCase() ? v : null;
      }
      return;
    }
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
  }
  function applyFacet(query, token, intent) {
    const text = String(query == null ? '' : query);
    const after = parseQuery(text);
    changeFacet(after, token, intent);
    const was = facetParts(parseQuery(text));
    const now = facetParts(after);
    const count = (arr) => arr.reduce((m, x) => m.set(x, (m.get(x) || 0) + 1), new Map());
    const left = count(now);
    const removed = new Map();
    for (const part of was) { if (left.get(part)) left.set(part, left.get(part) - 1); else removed.set(part, (removed.get(part) || 0) + 1); }
    const used = count(was);
    const added = [];
    for (const part of now) { if (used.get(part)) used.set(part, used.get(part) - 1); else added.push(part); }
    // A changed single-valued facet drops every token of its kind (a later one
    // overrides an earlier one, so the text may hold several).
    const dropKinds = new Set([...removed.keys()].map(partKind).filter((k) => SINGLE_FACETS.includes(k)));
    const kept = [];
    for (const t of rawTokensPreserving(text)) {
      const part = tokenPart(t.text);
      if (part && dropKinds.has(partKind(part))) continue;
      if (part && removed.get(part)) { removed.set(part, removed.get(part) - 1); continue; }
      kept.push({ text: t.text, part });
    }
    for (const part of added.sort(compareParts)) {
      let at = kept.length;
      for (let i = 0; i < kept.length; i += 1) if (kept[i].part && compareParts(kept[i].part, part) > 0) { at = i; break; }
      kept.splice(at, 0, { text: part, part });
    }
    const out = kept.map((t) => t.text).join(' ');
    return out && /\s$/.test(text) ? `${out} ` : out; // a trailing space (mid-typing) stays
  }

  // One facet token's state in a parsed query: 'include' | 'exclude' | null. A
  // single-valued token without a value ({ kind: 'before' }) asks "is that facet
  // set at all". The options panel paints its chips from this.
  function facetTokenState(parsed, token) {
    const k = token.kind;
    if (SINGLE_FACETS.includes(k)) {
      const cur = parsed[k];
      if (!cur) return null;
      if (token.value == null || token.value === '') return 'include';
      if (BOUND_FACETS.includes(k)) { const b = parseBound(String(token.value)); return b && serializeBound(cur) === serializeBound(b) ? 'include' : null; }
      return String(cur).toLowerCase() === String(token.value).toLowerCase() ? 'include' : null;
    }
    let inc, ex, value;
    if (k === 'group') { inc = parsed.groups; ex = parsed.negGroups; value = normalizeTagName(token.value); }
    else if (k === 'num') { inc = parsed.nums; ex = parsed.negNums; value = Number(token.value); }
    else { inc = parsed.is; ex = parsed.negIs; value = BUILTIN_TO_IS[token.value] || token.value; }
    return inc.includes(value) ? 'include' : ex.includes(value) ? 'exclude' : null;
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
      parsed.nums.length || parsed.negNums.length || parsed.since || parsed.before || parsed.len || parsed.lines || parsed.words || parsed.id);
  }
  function isEmptyQuery(parsed) {
    return !parsed.content.length && !anyFilterActive(parsed) && !parsed.sort;
  }

  // ── time-spec resolution (mirrors Forge resolveTimeMs) ──
  const UNIT_MS = { m: 60000, h: 3600000, d: 86400000, w: 604800000 };
  // A date is only ever an ISO-like date (2026-01-31, 2026-01, an optional time).
  // Never hand anything else to Date.parse: V8 reads '>5', '5-' or a bare '7' as a
  // date in 2001, so a typo would silently filter on it.
  const DATE_RE = /^\d{4}-\d{1,2}(?:-\d{1,2})?(?:[T ]\d{1,2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:?\d{2})?)?$/i;
  function resolveTimeMs(spec, now) {
    const s = String(spec || '').trim();
    if (!s) return null;
    const m = TIME_RE.exec(s);
    if (m) return (now || Date.now()) - parseInt(m[1], 10) * UNIT_MS[m[2].toLowerCase()];
    if (!DATE_RE.test(s)) return null;
    const t = Date.parse(s);
    return Number.isNaN(t) ? null : t;
  }

  // ── matching ──
  // test(text, isLower): isLower says the text is ALREADY lowercased (the
  // precomputed haystack), so a plain term never lowercases it again.
  function makeTermMatcher(value, regex) {
    if (regex) {
      let re = null;
      try { re = new RegExp(value, 'i'); } catch {}
      return { regex: true, lower: '', test: (t) => !!re && re.test(String(t || '')) };
    }
    const lower = String(value).toLowerCase();
    return { regex: false, lower, test: (t, isLower) => (isLower && typeof t === 'string' ? t : String(t || '').toLowerCase()).includes(lower) };
  }
  // One matcher per content term, built once per query (not once per clip).
  function compileContent(parsed, regex) {
    return parsed.content.map((c) => makeTermMatcher(c.value, regex));
  }
  // Where lowercase `v` first occurs in the clip's BODY, read from the lowercased
  // combined haystack ([title, body, type, groups...].join(' ')) instead of
  // lowercasing the body again: a 31 MB clip made every keystroke pay for that.
  // Falls back to the body itself when the haystack does not line up.
  function bodyIndexOf(doc, hayLower, v) {
    const body = doc.body;
    if (!body) return -1;
    const start = doc.title.length + 1;
    if (hayLower != null && hayLower.length >= start + body.length && hayLower.charCodeAt(start - 1) === 32) {
      const idx = hayLower.indexOf(v, start);
      return idx >= 0 && idx + v.length <= start + body.length ? idx - start : -1;
    }
    return body.toLowerCase().indexOf(v);
  }
  function lenSatisfies(len, cond) {
    switch (cond.op) {
      case '>': return len > cond.n;
      case '<': return len < cond.n;
      case '>=': return len >= cond.n;
      case '<=': return len <= cond.n;
      case 'range': return len >= cond.n && len <= cond.m;
      default: return len === cond.n;
    }
  }
  // Strict AND filter. `opts`: { regex, now, searchText? (precomputed combined
  // haystack, LOWERCASED), matchers? (compileContent of this query) }.
  function matchDoc(doc, parsed, opts) {
    if (!doc) return false;
    const o = opts || {};
    const matchers = o.matchers || compileContent(parsed, !!o.regex);
    let any = o.searchText;
    for (let k = 0; k < parsed.content.length; k += 1) {
      const c = parsed.content[k];
      const m = matchers[k];
      let hit;
      if (c.scope === 'title') hit = m.test(doc.title, false);
      else if (c.scope === 'body') hit = m.regex ? m.test(doc.body, false) : bodyIndexOf(doc, any, m.lower) >= 0;
      else {
        if (any == null) any = docSearchText(doc).toLowerCase();
        hit = m.test(any, true);
      }
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
    if (parsed.lines && !lenSatisfies(docLines(doc), parsed.lines)) return false;
    if (parsed.words && !lenSatisfies(docWords(doc), parsed.words)) return false;
    if (parsed.id && !doc.id.toLowerCase().includes(String(parsed.id).toLowerCase())) return false;
    return true;
  }
  function docHasIs(doc, v) {
    if (v === 'pinned') return doc.pinned;
    if (v === 'image') return doc.type === 'image';
    if (v === 'text') return doc.type === 'text';
    if (v === 'numpad') return doc.numpad != null;
    if (v === 'url') return docUrl(doc);
    if (v === 'multiline') return docLines(doc) > 1;
    if (v === 'rich') return !!doc.rich;
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
  // The positive content terms a relevance score reads, normalised once per
  // query (not once per clip): [{ scope, v (lowercase phrase), spaced }].
  function relevanceTerms(parsed) {
    const out = [];
    for (const c of parsed.content) {
      if (c.neg) continue; // negatives don't add signal
      const v = normalizedPhrase(c.value);
      if (v) out.push({ scope: c.scope, v, spaced: /\s/.test(v) });
    }
    return out;
  }
  function docTitleLower(doc) {
    if (doc.titleLower === undefined) doc.titleLower = doc.title.toLowerCase();
    return doc.titleLower;
  }
  function relevanceScore(doc, parsed, opts) {
    const o = opts || {};
    const regex = !!o.regex;
    let score = 0;
    // opts.hay: the clip's lowercased combined haystack; body positions come
    // from it (bodyIndexOf) instead of lowercasing the whole body per keystroke.
    // opts.terms: relevanceTerms(parsed), precomputed by a caller scoring many clips.
    const titleLower = docTitleLower(doc);
    for (const t of (o.terms || relevanceTerms(parsed))) {
      const v = t.v;
      const c = t;
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
        const idx = bodyIndexOf(doc, o.hay, v);
        if (idx >= 0) { score += 12; score += Math.max(0, 6 - idx / 200); } // earlier = a touch better
        // multi-word phrase already covered by includes; word tokens add a little
        if (t.spaced && idx >= 0) score += 6;
      }
      if (c.scope === 'any') {
        // group-name hit is weak signal
        if (doc.groups.length && doc.groups.some((g) => g.toLowerCase().includes(v))) score += 4;
      }
    }
    // small structural nudges
    if (doc.pinned) score += 3;
    return score;
  }

  // Filter + rank -> array of ORIGINAL indexes. `opts`: { regex, now, sortMode ('best'|'new'),
  // docs? (prebuilt), searchTextLower? (precomputed combined haystacks, lowercased) }.
  // Ranking mode for a parsed query: an explicit sortMode (the Best/Recent toggle) or
  // `sort:` token wins; else relevance ('best') when a content query is present; else
  // the caller's ORIGINAL order ('none' - the popup's history order, which is newest
  // first). 'new' and 'none' are both time-ordered lists; the popup's keep-your-place
  // rules (Core.resolveListAnchor) key off exactly this, so it has ONE definition.
  function rankMode(parsed, sortMode) {
    const p = parsed || {};
    return sortMode || (p.sort ? p.sort : ((p.content && p.content.length) ? 'best' : 'none'));
  }

  // Incremental refinement: typing more of a term can only narrow the result,
  // so the next keystroke tests the previous matches instead of every clip.
  // Valid when the docs + haystacks are the same arrays, no regex, the facets
  // are identical (no before:, whose relative bound widens as time passes), and
  // every earlier content term is kept (same scope and sign) with a positive
  // term only growing (new includes old) and a negative one unchanged; terms
  // may be appended. `cache` is a caller-owned object (one per list).
  function refineState(parsed, regex) {
    return {
      facets: facetKey(parsed),
      before: !!parsed.before,
      regex: !!regex,
      terms: parsed.content.map((c) => ({ scope: c.scope, neg: !!c.neg, lower: String(c.value).toLowerCase() })),
    };
  }
  function canRefine(prev, next) {
    if (!prev || prev.regex || next.regex || prev.before || next.before || prev.facets !== next.facets) return false;
    if (next.terms.length < prev.terms.length) return false;
    for (let k = 0; k < prev.terms.length; k += 1) {
      const a = prev.terms[k];
      const b = next.terms[k];
      if (a.scope !== b.scope || a.neg !== b.neg) return false;
      if (a.neg ? a.lower !== b.lower : !b.lower.includes(a.lower)) return false;
    }
    return true;
  }
  function filterRankIndexes(items, parsed, opts) {
    const o = opts || {};
    const now = o.now || Date.now();
    const docs = o.docs || (items || []).map(clipToDoc);
    const hay = o.searchTextLower || null;
    const hasContent = parsed.content.length > 0;
    const mode = rankMode(parsed, o.sortMode);
    const scored = [];
    // One options object and one compiled matcher set for the whole pass.
    const matchOpts = { regex: o.regex, now, searchText: undefined, matchers: compileContent(parsed, !!o.regex) };
    const relOpts = { ...o, hay: undefined, terms: relevanceTerms(parsed) };
    const cache = o.cache || null;
    const state = cache ? refineState(parsed, o.regex) : null;
    const prev = cache && cache.docs === docs && cache.hay === hay ? cache.state : null;
    const candidates = prev && canRefine(prev, state) ? cache.matched : null;
    const matched = cache ? [] : null;
    const total = candidates ? candidates.length : docs.length;
    for (let k = 0; k < total; k++) {
      const i = candidates ? candidates[k] : k;
      const doc = docs[i];
      if (!doc) continue;
      matchOpts.searchText = hay ? hay[i] : undefined;
      if (!matchDoc(doc, parsed, matchOpts)) continue;
      if (matched) matched.push(i);
      relOpts.hay = matchOpts.searchText;
      const rel = mode === 'best' && hasContent ? relevanceScore(doc, parsed, relOpts) : 0;
      scored.push({ i, total: rel + recencyScore(doc, now), ts: doc.ts });
    }
    if (cache) { cache.docs = docs; cache.hay = hay; cache.state = state; cache.matched = matched; cache.refined = !!candidates; }
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
  // What is INVALID comes from validateQuery (ONE rule): its problemRanges are
  // painted 'unknown', exactly the bad key or value and nothing around it.
  // opts.problems: the caller's validateQuery result (e.g. with pending ones
  // left out); else every non-pending problem of the text.
  function lexQuery(text, opts) {
    const o = opts || {};
    const segs = lexSegments(text, o);
    const problems = o.problems || validateQuery(text, { regex: !!o.regex, groups: o.groups }).filter((p) => !p.pending);
    return problems.length ? markRanges(segs, problemRanges(problems), 'unknown') : segs;
  }
  // Split segments at range edges and give the covered parts `kind`.
  function markRanges(segs, ranges, kind) {
    const out = [];
    let pos = 0;
    for (const seg of segs) {
      const a = pos;
      const b = pos + seg.text.length;
      pos = b;
      const cuts = new Set([a, b]);
      for (const r of ranges) { if (r.start > a && r.start < b) cuts.add(r.start); if (r.end > a && r.end < b) cuts.add(r.end); }
      const pts = [...cuts].sort((x, y) => x - y);
      for (let k = 0; k < pts.length - 1; k += 1) {
        const from = pts[k];
        const to = pts[k + 1];
        const bad = seg.kind !== 'ws' && ranges.some((r) => r.start <= from && r.end >= to);
        out.push({ kind: bad ? kind : seg.kind, text: seg.text.slice(from - a, to - a) });
      }
    }
    return out;
  }
  function lexSegments(text, opts) {
    const o = opts || {};
    const segs = [];
    let pos = 0;
    const s = String(text || '');
    for (const tok of rawTokensPreserving(s)) {
      if (tok.start > pos) segs.push({ kind: 'ws', text: s.slice(pos, tok.start) });
      pos = tok.start + tok.text.length;
      let body = tok.text;
      if (body[0] === '-' && body.length > 1) { segs.push({ kind: 'neg', text: '-' }); body = body.slice(1); }
      const m = KEY_TOKEN_RE.exec(body);
      if (m && m[2] && m[2][0] !== '/' && m[2][0] !== '\\') {
        const key = m[1].toLowerCase();
        if (RECOGNIZED_PREFIXES.has(key)) {
          segs.push({ kind: 'prefix', text: body.slice(0, m[1].length + 1) });
          const canon = PREFIX_ALIASES[key];
          const contentScope = canon === 'title' || canon === 'text';
          pushValueSegs(segs, m[2], contentScope && !!o.regex);
          continue;
        }
      }
      pushValueSegs(segs, body, !!o.regex);
    }
    if (pos < s.length) segs.push({ kind: 'ws', text: s.slice(pos) });
    return segs;
  }

  // ── what each filter and value means: ONE table, keyed by prefix AND value.
  // The autocomplete rows read it (each row its own hint, never one hint
  // repeated down the list), and the "Did you mean" / valid-values feedback
  // lists its values. `short` = the short alias (PREFIX_ALIASES has them all).
  const FIELD_INFO = {
    title: { desc: 'match the clip title', short: 't' },
    text: { desc: 'match the clip body', short: 'b' },
    group: { desc: 'in a group (and its sub-groups)', short: 'g' },
    is: { desc: 'kind of clip', values: { pinned: 'starred (pinned) clips', image: 'a picture', text: 'text, not a picture', numpad: 'on a numpad key', url: 'the clip is a link', multiline: 'spans several lines', rich: 'has HTML or RTF formatting' } },
    num: { desc: 'numpad slot 1-9', short: 'n' },
    since: { desc: 'newer than', short: 's', values: { '1h': 'the last hour', '24h': 'the last day', '7d': 'the last week', '30d': 'the last month' } },
    before: { desc: 'older than', short: 'bf', values: { '1h': 'an hour ago', '24h': 'a day ago', '7d': 'a week ago', '30d': 'a month ago' } },
    len: { desc: 'character count (len:>100, len:50-200)', short: 'l' },
    lines: { desc: 'line count (lines:>3)', short: 'ln' },
    words: { desc: 'word count (words:<20)', short: 'wd' },
    id: { desc: 'clip id prefix' },
    sort: { desc: 'result order', short: 'o', values: { new: 'newest first', best: 'best match first' } },
  };
  const IS_SUGGESTIONS = IS_VALUES.map((v) => 'is:' + v);
  const SINCE_PRESETS = Object.keys(FIELD_INFO.since.values);
  // Derived views of FIELD_INFO (kept as exports): 'title:' -> its description /
  // its short alias ('t:').
  const PREFIX_HINTS = Object.fromEntries(Object.entries(FIELD_INFO).map(([k, f]) => [`${k}:`, f.desc]));
  const PREFIX_SHORT = Object.fromEntries(Object.entries(FIELD_INFO).filter(([, f]) => f.short).map(([k, f]) => [`${k}:`, `${f.short}:`]));

  // The user-facing syntax reference (the search options panel renders exactly
  // this). ONE table, next to the parser, so help can never drift from grammar.
  const SYNTAX_HELP = [
    { token: 'word  "a phrase"', desc: 'match anywhere (title, body, groups); several words = all must match', example: 'invoice "q3 report"' },
    { token: '-word  -group:x', desc: 'exclude: put - in front of any word or filter', example: 'meeting -group:Work' },
    { token: 'title:  t:', desc: 'match the clip title only', example: 't:todo' },
    { token: 'text:  b:', desc: 'match the clip body only', example: 'b:"api key"' },
    { token: 'group:  g:', desc: 'in a group (and its sub-groups)', example: 'g:Work/Docs' },
    { token: 'is:pinned  is:image  is:text  is:numpad', desc: 'kind of clip', example: 'is:pinned -is:image' },
    { token: 'is:url  is:multiline  is:rich', desc: 'body is a link / spans several lines / has HTML or RTF formatting', example: 'is:url since:7d' },
    { token: 'num:1-9  n:', desc: 'in a numpad quick-paste slot', example: 'n:3' },
    { token: 'since:  s:   before:  bf:', desc: 'time window: 1h 24h 7d 30d or a date (2026-01-31)', example: 's:24h bf:1h' },
    { token: 'len:  l:', desc: 'character count: >N <N >=N <=N or a range N-M', example: 'len:>500  len:20-80' },
    { token: 'lines:  ln:', desc: 'line count, same comparators', example: 'lines:>10' },
    { token: 'words:  wd:', desc: 'word count, same comparators', example: 'wd:<5' },
    { token: 'id:', desc: 'clip id starts with', example: 'id:txt:9f' },
    { token: 'sort:new  sort:best  o:', desc: 'order results by recency or relevance', example: 'o:best' },
    { token: '.*  (button)', desc: 'treat free text and title:/text: values as regular expressions', example: '\\d{3}-\\d{4}' },
  ];
  // The search options panel's facet rows: the less-used filters, one click each.
  // Chips write tokens through applyFacet (the query text stays the single source
  // of truth) and paint their state from facetTokenState. `prompt` options insert
  // their prefix for typing instead of a fixed value. ONE table: the panel and the
  // availability census both read it. A filter the chip bar already owns (is:pinned,
  // is:image, is:numpad = BUILTIN_TO_IS) never appears here: one filter, one place,
  // and the panel's toggle lights only for the panel's own filters.
  const OPTION_FACETS = [
    { id: 'date', label: 'Date', options: [
      { label: 'Last 24h', token: { kind: 'since', value: '24h' } },
      { label: 'Last 7 days', token: { kind: 'since', value: '7d' } },
      { label: 'Last 30 days', token: { kind: 'since', value: '30d' } },
      { label: 'Before...', token: { kind: 'before' }, prompt: 'before:' },
    ] },
    { id: 'type', label: 'Type', options: [
      { label: 'Text', token: { kind: 'is', value: 'text' } },
      { label: 'Link', token: { kind: 'is', value: 'url' } },
      { label: 'Multi-line', token: { kind: 'is', value: 'multiline' } },
      { label: 'Rich', token: { kind: 'is', value: 'rich' } },
    ] },
    { id: 'size', label: 'Size', options: [
      { label: 'Under 80 chars', token: { kind: 'len', value: '<80' } },
      { label: 'Over 500 chars', token: { kind: 'len', value: '>500' } },
      { label: 'Over 10 lines', token: { kind: 'lines', value: '>10' } },
    ] },
  ];
  // The query text a facet token stands for (its chip tooltip).
  function facetTokenText(token) {
    if (SINGLE_FACETS.includes(token.kind)) return `${token.kind}:${token.value == null ? '' : token.value}`;
    if (token.kind === 'group') return `group:${quoteToken(token.value)}`;
    if (token.kind === 'num') return `num:${token.value}`;
    return `is:${BUILTIN_TO_IS[token.value] || token.value}`;
  }
  // True while the query holds a filter the options panel owns (its toggle lights).
  function optionFacetsActive(parsed) {
    return OPTION_FACETS.some((row) => row.options.some((opt) => {
      const t = SINGLE_FACETS.includes(opt.token.kind) ? { kind: opt.token.kind } : opt.token;
      return facetTokenState(parsed, t) !== null;
    }));
  }

  // ── autocomplete (Forge querySuggest rules) ──
  // suggestQuery(text, caret, { groups }) -> null, or { kind: 'key' | 'value',
  // replaceStart, replaceEnd, query (the typed key / value fragment), quoted,
  // suggestions: [{ text, label, hint, continuation }] }. Rules: nothing on an
  // empty box or an empty token; only with the caret at the END of a token
  // (editing inside a query stays native); a value that is already complete
  // (is:pinned, since:7d, num:3, an exact group) offers nothing more.
  // `continuation`: the row's text starts with what was typed, so the rest of
  // it can be painted as a ghost (ghostCompletion) or filled in
  // (uniqueCompletion).
  function isValidTimeSpec(v) {
    const s = String(v || '').trim();
    return resolveTimeMs(s, 0) != null; // exactly the rule resolveTimeMs filters by
  }
  // A time value that is still being typed: digits with no unit yet, or a date
  // part way through (2026-0).
  function isPendingTimeSpec(v) {
    const s = String(v || '').trim();
    return /^\d+$/.test(s) || /^\d{4}-\d{0,2}(-\d{0,2})?$/.test(s);
  }
  function completeValue(canon, val, groups) {
    const v = String(val || '').toLowerCase();
    if (!v) return false;
    if (canon === 'is') return IS_VALUES.includes(v);
    if (canon === 'num') return /^[1-9]$/.test(v);
    if (canon === 'sort') return ['new', 'best', 'recent', 'relevance'].includes(v);
    if (canon === 'since' || canon === 'before') return isValidTimeSpec(v) && !isPendingTimeSpec(v);
    // Group names match exactly (tagMatchesFilter): group:work is NOT complete
    // when the group is Work, so the list stays up offering the right case.
    if (canon === 'group') { const n = normalizeTagName(val); return (groups || []).some((g) => normalizeTagName(g) === n); }
    return false;
  }
  function tokenAtCaret(text, caret) {
    const s = String(text || '');
    const at = Math.max(0, Math.min(caret == null ? s.length : caret, s.length));
    if (at < s.length && !/\s/.test(s[at])) return null; // caret inside a token
    let start = at;
    while (start > 0 && !/\s/.test(s[start - 1])) start -= 1;
    return { start, end: at, text: s.slice(start, at) };
  }
  function suggestQuery(text, caret, opts) {
    const o = opts || {};
    const tok = tokenAtCaret(text, caret);
    if (!tok || !tok.text || tok.text === '-') return null;
    const neg = tok.text[0] === '-' ? '-' : '';
    const body = neg ? tok.text.slice(1) : tok.text;
    const lowerTok = tok.text.toLowerCase();
    const out = [];
    const push = (textVal, hint) => {
      const t = neg + textVal;
      out.push({ text: t, label: t, hint: hint || '', continuation: t.toLowerCase().startsWith(lowerTok) && t.length > tok.text.length });
    };
    const cm = KEY_TOKEN_RE.exec(body);
    let kind = 'key';
    let query = body;
    let quoted = false;
    if (cm) {
      const rawKey = cm[1].toLowerCase();
      const key = PREFIX_ALIASES[rawKey] || rawKey; // fold short aliases (t:/g:/n:...) to canonical
      kind = 'value';
      quoted = cm[2][0] === '"';
      query = cm[2].replace(/^"|"$/g, '');
      const val = query.toLowerCase();
      if (completeValue(key, query, o.groups)) return null;
      const info = FIELD_INFO[key] || {};
      const hintOf = (v) => (info.values && info.values[v]) || '';
      if (key === 'group') {
        // Prefix matches first, then names containing the fragment.
        const names = (o.groups || []).filter((g) => !val || g.toLowerCase().includes(val));
        names.sort((a, b) => (b.toLowerCase().startsWith(val) - a.toLowerCase().startsWith(val)) || byName(a, b));
        for (const g of names) push(`${cm[1]}:${quoteToken(g)}`, '');
      } else if (key === 'is') {
        for (const v of IS_VALUES) if (!val || v.startsWith(val)) push(`${cm[1]}:${v}`, hintOf(v));
      } else if (key === 'since' || key === 'before') {
        for (const p of SINCE_PRESETS) if (!val || p.startsWith(val)) push(`${cm[1]}:${p}`, hintOf(p));
      } else if (key === 'num') {
        for (let n = 1; n <= 9; n++) if (!val || String(n).startsWith(val)) push(`${cm[1]}:${n}`, '');
      } else if (key === 'sort') {
        for (const v of ['new', 'best']) if (!val || v.startsWith(val)) push(`${cm[1]}:${v}`, hintOf(v));
      }
    } else {
      // A bare word: offer prefixes it could start. Match on BOTH the long form
      // (ti -> title:) AND the short alias (t -> title:, g -> group:), and hint the
      // short form so both are discoverable. De-dupe so t only appears once.
      const lower = body.toLowerCase();
      const seen = new Set();
      const offer = (canon) => {
        if (seen.has(canon)) return;
        seen.add(canon);
        const f = FIELD_INFO[canon];
        push(`${canon}:`, f.short ? `${f.desc} · or ${f.short}:` : f.desc);
      };
      for (const canon of Object.keys(FIELD_INFO)) if (canon.startsWith(lower) && `${canon}:` !== lower) offer(canon);
      for (const [alias, canon] of Object.entries(PREFIX_ALIASES)) if (FIELD_INFO[canon] && alias.startsWith(lower)) offer(canon);
      for (const g of (o.groups || [])) if (g.toLowerCase().startsWith(lower)) push(`group:${quoteToken(g)}`, '');
    }
    if (!out.length) return null;
    // A row that is what was typed in another case (group:work -> group:Work)
    // leads, then the best continuation (so the ghost and Tab agree with the top row).
    const caseFix = (s) => s.text.toLowerCase() === lowerTok;
    out.sort((a, b) => (caseFix(b) - caseFix(a)) || (b.continuation - a.continuation));
    return { kind, replaceStart: tok.start, replaceEnd: tok.end, query, quoted, suggestions: out.slice(0, 8) };
  }
  // The new text and caret after taking suggestion s of result res: a key
  // keeps the caret after its ':' (a value comes next); a value is a finished
  // token and gets a trailing space.
  function applySuggestion(text, res, s) {
    const v = String(text || '');
    const tail = v.slice(res.replaceEnd);
    const space = res.kind === 'value' || !s.text.endsWith(':') ? (/^\s/.test(tail) ? '' : ' ') : '';
    const next = v.slice(0, res.replaceStart) + s.text + space + tail;
    return { text: next, caret: res.replaceStart + s.text.length + space.length };
  }
  // The rest of the top row as a ghost, painted after the typed text: only with
  // the caret at the very end of the field and the row continuing what was typed.
  function ghostCompletion(text, caret, res) {
    const v = String(text || '');
    if (!res || caret !== v.length || !res.suggestions.length) return '';
    const top = res.suggestions[0];
    return top.continuation ? top.text.slice(res.replaceEnd - res.replaceStart) : '';
  }
  // Exactly one VALUE fits what was typed: fill it in with the inserted part
  // selected, so the next keystroke simply replaces it (Forge uniqueCompletion).
  // Never for a key (the user picks the value), an empty or quoted fragment, or
  // bare digits of a time (3 could still become 3h, 3d or 3w).
  function uniqueCompletion(text, res) {
    if (!res || res.kind !== 'value' || res.suggestions.length !== 1 || !res.query || res.quoted) return null;
    const s = res.suggestions[0];
    if (!s.continuation) return null;
    if (/^\d+$/.test(res.query) && /^-?(since|s|after|before|bf):/i.test(s.text)) return null;
    const v = String(text || '');
    const next = v.slice(0, res.replaceStart) + s.text + v.slice(res.replaceEnd);
    return { text: next, selectionStart: res.replaceEnd, selectionEnd: res.replaceStart + s.text.length };
  }

  // ── invalid-token feedback (Forge validateQuery) ──
  // validateQuery(text, { regex, groups, caret }) -> [{ start, end, valueStart,
  // key, value, kind, message, options?, didYouMean?, pending? }]. A value that
  // is still a valid prefix (is:pin, since:7, len:>) is never flagged while it is
  // typed. An unknown key flags its KEY only (its value is still searched as
  // text); a bad value flags its VALUE only. A broken regex is `pending` while
  // the caret sits at the end of its token (the caller shows it once typing
  // pauses). `didYouMean` = the nearest valid value (Levenshtein <= 2), or for
  // an unknown key the filter it most likely meant (nearKey).
  function levenshtein(a, b) {
    const x = String(a).toLowerCase();
    const y = String(b).toLowerCase();
    const row = Array.from({ length: y.length + 1 }, (_, i) => i);
    for (let i = 1; i <= x.length; i++) {
      let prev = row[0];
      row[0] = i;
      for (let j = 1; j <= y.length; j++) {
        const old = row[j];
        row[j] = Math.min(row[j] + 1, row[j - 1] + 1, prev + (x[i - 1] === y[j - 1] ? 0 : 1));
        prev = old;
      }
    }
    return row[y.length];
  }
  function closestTo(raw, options, maxDistance) {
    let best = null;
    let bestD = Infinity;
    for (const opt of options) {
      const d = levenshtein(raw, opt);
      if (d < bestD || (d === bestD && opt < best)) { best = opt; bestD = d; }
    }
    return best != null && bestD <= (maxDistance == null ? 2 : maxDistance) && bestD < String(raw).length ? best : undefined;
  }
  // Keys people guess for an existing filter (type:image means is:image).
  const KEY_GUESSES = { type: 'is', kind: 'is', tag: 'group', tags: 'group', size: 'len', length: 'len', order: 'sort', slot: 'num' };
  const FIELD_NAMES = Object.keys(FIELD_INFO);
  // The filter an unknown key most likely meant: a known guess, or a near
  // spelling of a FULL filter name (titel: -> title:). Never a 1-2 letter alias
  // (foo: is not o:), a key of 3-4 letters may be off by one letter only, and
  // it is offered only when the value is valid for that filter, so the
  // one-click fix never writes a new error or a silently wrong filter.
  function nearKey(key, rawValue, o) {
    const guess = KEY_GUESSES[key] || (key.length >= 3 ? closestTo(key, FIELD_NAMES, key.length <= 4 ? 1 : 2) : undefined);
    if (!guess) return undefined;
    return validateQuery(`${guess}:${rawValue}`, { regex: o.regex, groups: o.groups }).length ? undefined : `${guess}:`;
  }
  function regexError(value) {
    try { new RegExp(value, 'i'); return null; } catch (e) { return String(e && e.message || 'invalid').replace(/^Invalid regular expression: \/.*\/[a-z]*: /, ''); }
  }
  function validateQuery(text, opts) {
    const o = opts || {};
    const s = String(text || '');
    const caret = o.caret == null ? null : o.caret;
    // Every group path a group: value can name (Work/Clients also offers Work).
    const groupPaths = [...new Set((o.groups || []).flatMap((g) => normalizeTagName(g).split('/').filter(Boolean).map((_, i, a) => a.slice(0, i + 1).join('/'))))];
    const problems = [];
    for (const tok of rawTokensPreserving(s)) {
      const neg = tok.text[0] === '-' && tok.text.length > 1 ? 1 : 0;
      const body = tok.text.slice(neg);
      const tokEnd = tok.start + tok.text.length;
      const atCaret = caret != null && caret === tokEnd;
      const m = KEY_TOKEN_RE.exec(body);
      const key = m ? m[1].toLowerCase() : '';
      const canon = PREFIX_ALIASES[key];
      const base = { start: tok.start, end: tokEnd, token: tok.text };
      const checkRegex = (value, valueStart, key) => {
        const err = o.regex && value ? regexError(value) : null;
        if (err) problems.push({ ...base, valueStart, key: key || '', value, kind: 'invalid-regex', message: `Not a valid regular expression: ${err}.`, pending: atCaret });
      };
      // Searched as plain text, decided exactly as parseToken does: no key, no
      // value, a path or URL, a URL scheme, or a key too long to be a filter.
      if (!m || !m[2] || ((m[2][0] === '/' || m[2][0] === '\\') && !canon) || NON_FILTER_SCHEMES.has(key) || (!canon && !UNKNOWN_KEY_RE.test(key))) {
        checkRegex(body.replace(/"/g, ''), tok.start + neg, '');
        continue;
      }
      const valueStart = tok.start + neg + m[1].length + 1;
      const value = m[2].replace(/^"|"$/g, '');
      if (!canon) {
        const near = nearKey(key, m[2], o);
        problems.push({ ...base, valueStart, key, value, kind: 'unknown-key', message: `${key}: is not a filter, so "${value}" is searched as text.`, didYouMean: near });
        continue;
      }
      const lower = value.toLowerCase();
      const bad = (message, options, didYouMean) => problems.push({ ...base, valueStart, key, value, kind: 'invalid-value', message, options, didYouMean });
      if (canon === 'title' || canon === 'text') checkRegex(value, valueStart, key);
      else if (canon === 'is') {
        if (!IS_VALUES.some((v) => v.startsWith(lower))) { const near = closestTo(lower, IS_VALUES); bad(`${key}:${value} is not a kind of clip.`, IS_VALUES, near ? `${key}:${near}` : undefined); }
      } else if (canon === 'num') {
        if (!/^[1-9]$/.test(lower)) bad(`${key}: takes a numpad slot from 1 to 9.`);
      } else if (canon === 'sort') {
        const vals = ['new', 'best', 'recent', 'relevance'];
        if (!vals.some((v) => v.startsWith(lower))) { const near = closestTo(lower, ['new', 'best']); bad(`${key}:${value} is not a sort order.`, ['new', 'best'], near ? `${key}:${near}` : undefined); }
      } else if (canon === 'since' || canon === 'before') {
        if (!isValidTimeSpec(lower) && !isPendingTimeSpec(lower)) bad(`${key}:${value} is not a time. Try 1h, 24h, 7d, 30d or a date (2026-01-31).`);
      } else if (canon === 'len' || canon === 'lines' || canon === 'words') {
        const pending = /^(>=|<=|>|<|=)?$/.test(value) || /^\d+\s*(-|\.\.?)$/.test(value);
        if (!parseBound(value) && !pending) bad(`${key}:${value} is not a count. Use >N, <N, >=N, <=N, N or a range N-M.`);
      } else if (canon === 'group' && groupPaths.length) {
        // Names match exactly (tagMatchesFilter: Work is not work). A prefix of
        // a name in any case is fine while it is typed (the list offers the
        // right case), but a whole name in the wrong case finds nothing, so it
        // is flagged with the right one.
        const n = normalizeTagName(value);
        const nl = n.toLowerCase();
        const sameName = groupPaths.find((g) => g.toLowerCase() === nl);
        const typing = !sameName && groupPaths.some((g) => g.toLowerCase().startsWith(nl));
        if (n && !groupPaths.some((g) => g === n || g.startsWith(n)) && !typing) {
          const shown = sameName || closestTo(n, groupPaths, 3);
          bad(`There is no group named "${value}".`, undefined, shown ? `${key}:${quoteToken(shown)}` : undefined);
        }
      }
    }
    return problems;
  }
  // The one-line hint for a problem: what is wrong, the valid values, the fix.
  function describeProblem(p) {
    if (!p) return '';
    const options = p.options && p.options.length && !p.didYouMean ? ` Valid: ${p.options.join(', ')}.` : '';
    const fix = p.didYouMean ? ` Did you mean ${p.didYouMean}?` : '';
    return `${p.message}${options}${fix}`;
  }
  // The exact spans to paint: an unknown key's KEY (with its ':'), a bad
  // value's VALUE (the recognised prefix keeps its colour), a broken regex's text.
  function problemRanges(problems) {
    return (problems || []).map((p) => (p.kind === 'unknown-key'
      ? { start: p.start + (p.token[0] === '-' && p.token.length > 1 ? 1 : 0), end: p.valueStart }
      : { start: p.valueStart, end: p.end }));
  }

  // ── facet availability (Forge facetCensus / facetOptionVerdict) ──
  // For every facet option a chip offers, how many clips it would show under
  // all the OTHER active filters, in ONE pass over the docs. Each structural
  // token of the query is a check with a dimension (dim); a single-valued
  // facet (since, before, len, lines, words, id) holds its whole dim open, a
  // multi-valued AND facet (group:, is:) only its own token. facetFailures:
  // the dims a doc fails, capped at two (FAILURE_CAP: two failures and no
  // single held-open dim can rescue it). A doc failing nothing counts for
  // every option; failing exactly dim d, only for the options of dim d.
  // Free text is NOT part of the census (callers key it on facetKey, so typing
  // words never recomputes it).
  const FAILURE_CAP = 2;
  // Lines, counted only as far as `cap` (64): enough for every "lines over N"
  // option without walking a 31 MB clip, and exact below the cap.
  const LINES_CAP = 64;
  function docLinesCapped(doc) {
    if (doc.lines !== undefined) return Math.min(doc.lines, LINES_CAP);
    if (doc.linesCapped === undefined) {
      const s = doc.type === 'image' ? '' : doc.body;
      if (s.indexOf('\r') >= 0) doc.linesCapped = Math.min(docLines(doc), LINES_CAP);
      else {
        let n = s ? 1 : 0;
        let at = s.indexOf('\n');
        while (at >= 0 && n < LINES_CAP) { n += 1; at = s.indexOf('\n', at + 1); }
        doc.linesCapped = n;
      }
    }
    return doc.linesCapped;
  }
  function docBoundOk(doc, kind, bound) {
    if (kind === 'len') return lenSatisfies(doc.len, bound);
    if (kind === 'words') return lenSatisfies(docWords(doc), bound);
    // lines: the capped count answers every bound below the cap.
    const top = bound.op === 'range' ? bound.m : bound.n;
    const n = docLinesCapped(doc);
    if (n < LINES_CAP) return lenSatisfies(n, bound);
    if (top < LINES_CAP - 1) return bound.op === '>' || bound.op === '>='; // 64+ lines: past any such bound
    return lenSatisfies(docLines(doc), bound);
  }
  function docIsFast(doc, v) {
    if (v === 'multiline') return docLinesCapped(doc) > 1;
    return docHasIs(doc, v);
  }
  function facetChecks(parsed, now) {
    const checks = [];
    for (const g of parsed.groups) checks.push({ dim: `group:${g}`, ok: (d) => docInGroup(d, g) });
    for (const g of parsed.negGroups) checks.push({ dim: `-group:${g}`, ok: (d) => !docInGroup(d, g) });
    for (const v of parsed.is) checks.push({ dim: `is:${v}`, ok: (d) => docIsFast(d, v) });
    for (const v of parsed.negIs) checks.push({ dim: `-is:${v}`, ok: (d) => !docIsFast(d, v) });
    if (parsed.nums.length) checks.push({ dim: 'num', ok: (d) => parsed.nums.includes(d.numpad) });
    for (const n of parsed.negNums) checks.push({ dim: `-num:${n}`, ok: (d) => d.numpad !== n });
    if (parsed.since != null) { const b = resolveTimeMs(parsed.since, now); if (b != null) checks.push({ dim: 'since', ok: (d) => d.ts * 1000 >= b }); }
    if (parsed.before != null) { const b = resolveTimeMs(parsed.before, now); if (b != null) checks.push({ dim: 'before', ok: (d) => d.ts * 1000 <= b }); }
    for (const k of BOUND_FACETS) if (parsed[k]) { const bound = parsed[k]; checks.push({ dim: k, ok: (d) => docBoundOk(d, k, bound) }); }
    if (parsed.id) { const id = String(parsed.id).toLowerCase(); checks.push({ dim: 'id', ok: (d) => d.id.toLowerCase().includes(id) }); }
    return checks;
  }
  function facetFailures(doc, checks, out) {
    out.length = 0;
    for (let k = 0; k < checks.length; k += 1) {
      if (checks[k].ok(doc)) continue;
      out.push(checks[k].dim);
      if (out.length >= FAILURE_CAP) break;
    }
    return out;
  }
  // A chip's token -> its census key: 'is:image', 'group:Work', 'since:7d',
  // 'before:' (the prompt option), 'len:<80'.
  function censusKey(token) {
    const k = token.kind;
    if (k === 'group') return `group:${normalizeTagName(token.value)}`;
    if (k === 'builtin' || k === 'is') return `is:${BUILTIN_TO_IS[token.value] || token.value}`;
    if (BOUND_FACETS.includes(k)) return `${k}:${serializeBound(parseBound(String(token.value == null ? '' : token.value)))}`;
    return `${k}:${token.value == null ? '' : String(token.value).toLowerCase()}`;
  }
  // The dim an option belongs to under this query (null = none held open).
  function optionDim(parsed, token) {
    const k = token.kind;
    if (SINGLE_FACETS.includes(k)) return k;
    if (k === 'num') return 'num';
    if (k === 'group') { const g = normalizeTagName(token.value); return parsed.groups.includes(g) ? `group:${g}` : parsed.negGroups.includes(g) ? `-group:${g}` : null; }
    const v = BUILTIN_TO_IS[token.value] || token.value;
    return parsed.is.includes(v) ? `is:${v}` : parsed.negIs.includes(v) ? `-is:${v}` : null;
  }
  // facetCensus(docs, parsed, { now, groups }) -> { permissive, total,
  // count(key), present(key) }. Options counted: every is: value, every
  // OPTION_FACETS token, and every group (with its parent paths) in `groups`.
  // `present` = the option exists somewhere in history, filters ignored (an
  // absent kind is hidden, never greyed). No docs (history still loading) =
  // permissive: nothing greys.
  function facetCensus(docs, parsed, opts) {
    const o = opts || {};
    const now = o.now || Date.now();
    const list = docs || [];
    const permissive = !list.length;
    const options = [];
    for (const v of IS_VALUES) options.push({ key: `is:${v}`, token: { kind: 'is', value: v }, test: (d) => docIsFast(d, v) });
    for (const row of OPTION_FACETS) {
      for (const opt of row.options) {
        const t = opt.token;
        if (t.kind === 'is') continue; // counted above
        const key = censusKey(t);
        let test;
        if (t.kind === 'since' || t.kind === 'before') {
          const b = t.value ? resolveTimeMs(t.value, now) : null;
          test = b == null ? () => true : t.kind === 'since' ? (d) => d.ts * 1000 >= b : (d) => d.ts * 1000 <= b;
        } else if (BOUND_FACETS.includes(t.kind)) {
          const bound = parseBound(String(t.value));
          test = bound ? (d) => docBoundOk(d, t.kind, bound) : () => false;
        } else continue;
        options.push({ key, token: t, test });
      }
    }
    for (const o2 of options) o2.dim = optionDim(parsed, o2.token);
    // Groups: bumped from each doc's own groups (and their parents), not tested
    // one by one against every group.
    const groupKeys = new Set();
    for (const g of (o.groups || [])) {
      const parts = normalizeTagName(g).split('/').filter(Boolean);
      for (let i = 1; i <= parts.length; i += 1) groupKeys.add(parts.slice(0, i).join('/'));
    }
    const groupDim = new Map();
    for (const g of groupKeys) groupDim.set(g, optionDim(parsed, { kind: 'group', value: g }));
    const counts = new Map();
    const present = new Map();
    const bump = (m, key) => m.set(key, (m.get(key) || 0) + 1);
    const checks = facetChecks(parsed, now);
    const failed = [];
    const seen = new Set();
    for (const doc of list) {
      if (!doc) continue;
      facetFailures(doc, checks, failed);
      const only = failed.length === 1 ? failed[0] : null;
      const inBase = failed.length === 0;
      for (const opt of options) {
        const hit = opt.test(doc);
        if (!hit) continue;
        bump(present, opt.key);
        if (inBase || (only !== null && opt.dim === only)) bump(counts, opt.key);
      }
      if (doc.groups.length) {
        seen.clear();
        for (const g of doc.groups) {
          const parts = normalizeTagName(g).split('/');
          for (let i = 1; i <= parts.length; i += 1) {
            const p = parts.slice(0, i).join('/');
            if (seen.has(p) || !groupKeys.has(p)) continue;
            seen.add(p);
            bump(present, `group:${p}`);
            if (inBase || (only !== null && groupDim.get(p) === only)) bump(counts, `group:${p}`);
          }
        }
      }
    }
    return {
      permissive,
      total: list.length,
      count: (key) => counts.get(key) || 0,
      present: (key) => (present.get(key) || 0) > 0,
    };
  }
  // Why an option can never match together with the active filters, whatever
  // the history holds (structural), or null. An image has no text: no length,
  // no lines, no link; a link is one line; a numpad clip is pinned.
  function structuralReason(parsed, token) {
    const k = token.kind;
    const v = k === 'builtin' || k === 'is' ? (BUILTIN_TO_IS[token.value] || token.value) : null;
    const blocker = (text) => `Never matches with ${text}`;
    const imageOnly = parsed.is.includes('image') ? 'is:image' : parsed.negIs.includes('text') ? '-is:text' : null;
    const textOnly = ['text', 'url', 'multiline', 'rich'].map((x) => (parsed.is.includes(x) ? `is:${x}` : null)).find(Boolean)
      || (parsed.negIs.includes('image') ? '-is:image' : null)
      || BOUND_FACETS.map((b) => (parsed[b] && !lenSatisfies(0, parsed[b]) ? `${b}:${serializeBound(parsed[b])}` : null)).find(Boolean);
    const linesAllow = (n) => !parsed.lines || lenSatisfies(n, parsed.lines);
    if (v === 'image' && textOnly) return blocker(textOnly);
    if (['text', 'url', 'multiline', 'rich'].includes(v) && imageOnly) return blocker(imageOnly);
    if (v === 'url') {
      if (parsed.is.includes('multiline')) return blocker('is:multiline');
      if (!linesAllow(1)) return blocker(`lines:${serializeBound(parsed.lines)}`);
    }
    if (v === 'multiline') {
      if (parsed.is.includes('url')) return blocker('is:url');
      const L = parsed.lines;
      const most = !L ? Infinity : L.op === '<' ? L.n - 1 : (L.op === '<=' || L.op === '=') ? L.n : L.op === 'range' ? L.m : Infinity;
      if (most < 2) return blocker(`lines:${serializeBound(L)}`);
    }
    if (v === 'numpad' && parsed.negIs.includes('pinned')) return blocker('-is:pinned');
    if (BOUND_FACETS.includes(k)) {
      const bound = parseBound(String(token.value == null ? '' : token.value));
      if (bound && imageOnly && !lenSatisfies(0, bound)) return blocker(imageOnly);
      if (bound && k === 'lines' && parsed.is.includes('url') && !lenSatisfies(1, bound)) return blocker('is:url');
    }
    return null;
  }
  // Should this option be offered, and if not why (Forge facetOptionVerdict):
  // { enabled, hidden?, kind?: 'transient' | 'structural', reason?, count }.
  // The current selection is never disabled (it stays visible to be cleared).
  // A categorical option (an is: kind) absent from the whole history is hidden;
  // anything else is greyed: 'structural' (can never match with the active
  // filters) before 'transient' (nothing matches right now).
  function facetOptionVerdict(census, parsed, token, opts) {
    const o = opts || {};
    const key = censusKey(token);
    const count = census ? census.count(key) : 0;
    const probe = token.kind === 'before' && !token.value ? { kind: 'before' } : token;
    const selected = o.selected != null ? !!o.selected : facetTokenState(parsed, probe) !== null;
    if (selected) return { enabled: true, count };
    if (!census || census.permissive) return { enabled: true, count };
    const categorical = token.kind === 'builtin' || token.kind === 'is';
    if (categorical && !census.present(key)) return { enabled: false, hidden: true, count: 0 };
    const structural = structuralReason(parsed, token);
    if (structural) return { enabled: false, kind: 'structural', reason: structural, count: 0 };
    // A group with no clips stays a live chip while nothing else filters (its
    // click lands on the "No clips in X yet" state, which says what to do); it
    // greys only when other active filters are what leave it empty.
    if (token.kind === 'group' && !census.present(key)) return anyFilterActive(parsed) ? { enabled: false, kind: 'transient', reason: 'No clips in this group yet', count: 0 } : { enabled: true, count: 0 };
    if (!count) return { enabled: false, kind: 'transient', reason: 'No matches with the current filters', count: 0 };
    return { enabled: true, count };
  }

  // ── the empty-result nudge (Forge queryRelaxations, one pass) ──
  // When the filters leave nothing, the ONE facet whose removal brings back the
  // most clips: { dim, label (the token text), count, time, query }. Content
  // terms must still match (they are never relaxed); a doc failing exactly one
  // facet counts for that facet. `query` is the text with that facet removed
  // through applyFacet (everything else, free text included, stays as typed).
  function relaxDims(parsed) {
    const out = [];
    for (const g of parsed.groups) out.push({ dim: `group:${g}`, label: `group:${quoteToken(g)}`, tokens: [[{ kind: 'group', value: g }, 'include']] });
    for (const g of parsed.negGroups) out.push({ dim: `-group:${g}`, label: `-group:${quoteToken(g)}`, tokens: [[{ kind: 'group', value: g }, 'exclude']] });
    for (const v of parsed.is) out.push({ dim: `is:${v}`, label: `is:${v}`, tokens: [[{ kind: 'is', value: v }, 'include']] });
    for (const v of parsed.negIs) out.push({ dim: `-is:${v}`, label: `-is:${v}`, tokens: [[{ kind: 'is', value: v }, 'exclude']] });
    if (parsed.nums.length) out.push({ dim: 'num', label: parsed.nums.map((n) => `num:${n}`).join(' '), tokens: parsed.nums.map((n) => [{ kind: 'num', value: n }, 'include']) });
    for (const n of parsed.negNums) out.push({ dim: `-num:${n}`, label: `-num:${n}`, tokens: [[{ kind: 'num', value: n }, 'exclude']] });
    for (const k of ['since', 'before']) if (parsed[k]) out.push({ dim: k, label: `${k}:${quoteToken(parsed[k])}`, time: true, tokens: [[{ kind: k, value: parsed[k] }, 'include']] });
    for (const k of BOUND_FACETS) if (parsed[k]) out.push({ dim: k, label: `${k}:${serializeBound(parsed[k])}`, tokens: [[{ kind: k, value: serializeBound(parsed[k]) }, 'include']] });
    if (parsed.id) out.push({ dim: 'id', label: `id:${quoteToken(parsed.id)}`, tokens: [[{ kind: 'id', value: parsed.id }, 'include']] });
    return out;
  }
  function bestRelaxation(docs, query, opts) {
    const o = opts || {};
    const parsed = typeof query === 'string' ? parseQuery(query) : query;
    const dims = relaxDims(parsed);
    if (!dims.length) return null;
    const now = o.now || Date.now();
    const matchers = compileContent(parsed, !!o.regex);
    const contentOnly = { ...emptyParsed(''), content: parsed.content };
    const matchOpts = { regex: o.regex, now, searchText: undefined, matchers };
    const checks = facetChecks(parsed, now);
    const failed = [];
    const counts = new Map();
    const list = docs || [];
    const hay = o.searchTextLower || null;
    // o.cache (caller-owned, one per list): typing more of the same words only
    // re-tests the clips that counted last time (filterRankIndexes' refine
    // rule), so a nudge shown while typing does not rescan the whole history.
    const cache = o.cache || null;
    const state = cache ? refineState(parsed, o.regex) : null;
    const prev = cache && cache.docs === list && cache.hay === hay ? cache.state : null;
    const candidates = prev && canRefine(prev, state) ? cache.matched : null;
    const matched = cache ? [] : null;
    const total = candidates ? candidates.length : list.length;
    for (let k = 0; k < total; k += 1) {
      const i = candidates ? candidates[k] : k;
      const doc = list[i];
      if (!doc) continue;
      facetFailures(doc, checks, failed);
      if (failed.length !== 1) continue;
      matchOpts.searchText = hay ? hay[i] : undefined;
      if (parsed.content.length && !matchDoc(doc, contentOnly, matchOpts)) continue;
      if (matched) matched.push(i);
      counts.set(failed[0], (counts.get(failed[0]) || 0) + 1);
    }
    if (cache) { cache.docs = list; cache.hay = hay; cache.state = state; cache.matched = matched; }
    let best = null;
    for (const d of dims) {
      const count = counts.get(d.dim) || 0;
      if (count > 0 && (!best || count > best.count)) best = { ...d, count };
    }
    if (!best) return null;
    let next = typeof query === 'string' ? query : serializeQuery(parsed);
    for (const [token, intent] of best.tokens) next = applyFacet(next, token, intent);
    return { dim: best.dim, label: best.label, count: best.count, time: !!best.time, query: next };
  }

  // ── paste: a multi-word plain-text snippet searches as ONE phrase (Forge
  // quotePastedText). null = paste it as it is: one word, or text that is
  // query syntax (a recognised filter or a field-scoped term), or text whose
  // words are not split by single spaces: a phrase is a plain substring test, so
  // a line break, a tab or a double space inside it would stop it matching the
  // very clip it was copied from (pasted raw, its words are AND-ed instead).
  function quotePastedText(text) {
    const collapsed = String(text || '').trim();
    if (!/\s/.test(collapsed) || /[^ \S]| {2}/.test(collapsed)) return null;
    const p = parseQuery(collapsed);
    if (anyFilterActive(p) || p.sort || p.content.some((c) => c.scope !== 'any')) return null;
    return `"${collapsed.replace(/"/g, '')}"`;
  }
  // Is position `at` inside an open quote (an odd number of quotes before it)?
  function insideQuote(text, at) {
    const s = String(text || '').slice(0, at);
    let n = 0;
    for (let i = 0; i < s.length; i += 1) if (s[i] === '"') n += 1;
    return n % 2 === 1;
  }

  return {
    clipToDoc, docSearchText, normalizeTagName, tagMatchesFilter, docInGroup,
    tokenizeQuery, quoteToken, parseQuery, serializeQuery, applyFacet, facetState, facetTokenState,
    anyFilterActive, isEmptyQuery, resolveTimeMs,
    matchDoc, relevanceScore, recencyScore, rankMode, filterRankIndexes, bodyIndexOf,
    fuzzyMatch, fuzzyFloor,
    lexQuery, suggestQuery,
    BUILTIN_TO_IS, IS_TO_BUILTIN, IS_VALUES, RECOGNIZED_PREFIXES, NON_FILTER_SCHEMES,
    SYNTAX_HELP, PREFIX_HINTS, OPTION_FACETS, facetTokenText, optionFacetsActive,
    FIELD_INFO, facetKey, applySuggestion, ghostCompletion, uniqueCompletion,
    validateQuery, describeProblem, problemRanges, levenshtein,
    facetCensus, facetOptionVerdict, structuralReason, censusKey, FAILURE_CAP,
    bestRelaxation, quotePastedText, insideQuote,
  };
});
