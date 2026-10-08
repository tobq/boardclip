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
// to `val` as free text + recorded so a typo can't silently flood). This is the Advanced
// mode's text; the canonical query is ALWAYS this text, whatever mode the field shows
// (splitQuery / composeQuery turn it into a Basic or Regex view and back):
//   free text                bare words / "quoted phrase" -> literal substring over
//                            title+body+groups (always literal: no implicit regex)
//   /pattern/                one regular expression term (case-insensitive, `.` never
//                            crosses a line break); also title:/re/ and text:/re/
//   a b                      side by side = AND (every term must match)
//   a OR b                   either (OR binds tighter than AND, Gmail's rule:
//                            `x a OR b` = x AND (a OR b)); `or` is a plain word
//   ( ... )   -( ... )       grouping at any depth; `-` negates a term or a group
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
// The user-facing reference is the search options panel (OPTION_FACETS, OPTION_FIELDS,
// SYNTAX_NOTES) plus the autocomplete's hints (FIELD_INFO) - keep them in step with the parser.
// Only free text and title:/text: take a /regex/; every other facet is an enum/number/time
// spec. ONE compile primitive (compileTerm) matches literal and regex terms for search, the
// row highlight and the editor's find bar.

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

  // ── ONE recency decay (usage x recency, "frecency"): a weight that falls off
  // exponentially with age (ageMs / scaleMs = 1 -> 1/e). The result ranking's
  // recency term and the group usage score both use it. ──
  function decayWeight(ageMs, scaleMs) {
    return Math.exp(-Math.max(0, ageMs) / scaleMs);
  }
  // How much each group is used: its clips, each weighted by how recently it
  // was copied or used (ts moves on every paste), on a two-week scale. Every
  // parent path counts its sub-groups' clips too. ONE score orders the chip
  // row, the group pickers and the group autocomplete, and nudges the ranking
  // (clips of the groups you use rank a little higher). list: clips or search
  // docs (both carry ts in seconds); kept per list and per hour. The map's
  // `max` = the top score (0: no group has clips).
  const GROUP_USAGE_SCALE_MS = 14 * 86400 * 1000;
  const groupWeightCache = typeof WeakMap === 'function' ? new WeakMap() : null;
  function groupWeights(list, now) {
    const arr = Array.isArray(list) ? list : [];
    const nowMs = now || Date.now();
    const hour = Math.floor(nowMs / 3600000);
    const hit = groupWeightCache && groupWeightCache.get(arr);
    if (hit && hit.hour === hour) return hit.weights;
    const weights = new Map();
    for (const x of arr) {
      if (!x) continue;
      const gs = Array.isArray(x.groups) ? x.groups : pinGroups(x);
      if (!gs.length) continue;
      const w = decayWeight(nowMs - (Number(x.ts) || 0) * 1000, GROUP_USAGE_SCALE_MS);
      const seen = new Set();
      for (const g of gs) {
        const parts = normalizeTagName(g).split('/').filter(Boolean);
        for (let i = 1; i <= parts.length; i += 1) {
          const path = parts.slice(0, i).join('/');
          if (seen.has(path)) continue;
          seen.add(path);
          weights.set(path, (weights.get(path) || 0) + w);
        }
      }
    }
    let max = 0;
    for (const w of weights.values()) if (w > max) max = w;
    weights.max = max;
    if (groupWeightCache) groupWeightCache.set(arr, { hour, weights });
    return weights;
  }
  // Order group paths by use (groupWeights), then by name.
  function compareGroupUse(weights) {
    return (a, b) => ((weights && (weights.get(normalizeTagName(b)) || 0)) - (weights && (weights.get(normalizeTagName(a)) || 0)))
      || a.localeCompare(b, undefined, { sensitivity: 'base', numeric: true });
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
      content: [],            // { scope:'any'|'title'|'body', value, neg, regex? }
      groups: [], negGroups: [],
      is: [], negIs: [],      // arrays of 'pinned'|'image'|'text'|'numpad'
      nums: [], negNums: [],  // numbers 1-9 (each one must hold: a clip has one key)
      since: null, before: null,
      len: null,              // { op:'>'|'<'|'>='|'<='|'='|'range', n, m? }
      lines: null,            // same shape as len
      words: null,            // same shape as len
      id: null,
      sort: null,             // 'new' | 'best'
      unknown: [],            // unrecognized prefixes (for the "not a filter" hint)
      // The tree parts no flat field can hold. anyOf: a top-level OR of one
      // filter's values (group:A OR group:B), the pill with an or/and
      // connective. compound: any other top-level OR or group (a OR b,
      // -(a b), group:A OR is:image), evaluated as a tree; a chip whose value
      // sits inside one is greyed ("part of a custom filter").
      anyOf: [],              // { dim, field, values, members: [{ value, text, start, end }], start, end }
      compound: [],           // expression nodes (see parseExpression)
      terms: [],              // every content term that can match (top level and inside compound): highlight + relevance
      syntax: [],             // structural problems: { kind: 'dangling-or' | 'unclosed', start, end }
      items: [],              // the top-level items in text order: { kind: 'leaf'|'any'|'compound', start, end, leaf|any|node }
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

  // ── the ONE query scanner: parse, highlight, validation and edits all walk it ──
  // scanQuery(text) -> tokens in text order, each with its exact source range:
  //   { t: 'lp', neg }  '(' or '-(' at a token start
  //   { t: 'rp' }       ')' closing an open group (an unmatched ')' is plain text)
  //   { t: 'or' }       the word OR, unquoted and upper case
  //   { t: 'term', text, neg, body, regex }  anything else, quotes kept
  // A term's regex is { scope, pattern, open, close } when its value is
  // /pattern/ (bare, or after title: / text:): closed by the first unescaped
  // '/' outside a [class], on one line, followed by whitespace, the end or a
  // group's ')'. Anything else that starts with '/' (/usr/bin, an unclosed
  // /abc, //) is plain text. A token whose first character is quoted is
  // literal: "-foo", "title:x" and "OR" are text; -"a b" negates a phrase.
  const CONTENT_KEYS = new Set(['title', 'text']);
  const isSpace = (c) => c === ' ' || c === '\t' || c === '\n' || c === '\r' || (c !== undefined && /\s/.test(c));
  function regexClose(s, at, depth, classes) {
    let inClass = false;
    for (let k = at + 1; k < s.length; k += 1) {
      const ch = s[k];
      if (ch === '\n' || ch === '\r') return -1;
      if (ch === '\\') { k += 1; continue; }
      if (classes && inClass) { if (ch === ']') inClass = false; continue; }
      if (classes && ch === '[') { inClass = true; continue; }
      if (ch !== '/') continue;
      if (k === at + 1) return -1; // `//` is text, never an empty regex
      const next = s[k + 1];
      if (next === undefined || isSpace(next) || (next === ')' && depth > 0)) return k;
      if (classes) return -1; // the first closer must end the token
    }
    return -1;
  }
  // The closing '/' of a regex opening at `at`, or -1. An unclosed [class]
  // (a broken regex) still ends at its last '/', so it is reported as a broken
  // regex instead of searched as text.
  function regexEnd(s, at, depth) {
    if (s[at] !== '/') return -1;
    const k = regexClose(s, at, depth, true);
    return k >= 0 ? k : regexClose(s, at, depth, false);
  }
  function scanQuery(text) {
    const s = String(text == null ? '' : text);
    const out = [];
    let depth = 0;
    let i = 0;
    while (i < s.length) {
      const c = s[i];
      if (isSpace(c)) { i += 1; continue; }
      if (c === '(') { out.push({ t: 'lp', start: i, end: i + 1, neg: false }); depth += 1; i += 1; continue; }
      if (c === '-' && s[i + 1] === '(') { out.push({ t: 'lp', start: i, end: i + 2, neg: true }); depth += 1; i += 2; continue; }
      if (c === ')' && depth > 0) { out.push({ t: 'rp', start: i, end: i + 1 }); depth -= 1; i += 1; continue; }
      const start = i;
      const neg = c === '-' && i + 1 < s.length && !isSpace(s[i + 1]);
      const bodyAt = neg ? i + 1 : i;
      // A /regex/ value: bare, or after a content key (title:/re/, text:/re/).
      const km = /^([a-zA-Z][a-zA-Z0-9_]*):/.exec(s.slice(bodyAt, bodyAt + 32));
      const canon = km ? PREFIX_ALIASES[km[1].toLowerCase()] : null;
      const valueAt = km ? (CONTENT_KEYS.has(canon) ? bodyAt + km[0].length : -1) : bodyAt;
      const close = valueAt >= 0 ? regexEnd(s, valueAt, depth) : -1;
      if (close > 0) {
        const regex = { scope: km ? (canon === 'title' ? 'title' : 'body') : 'any', pattern: s.slice(valueAt + 1, close), open: valueAt, close };
        out.push({ t: 'term', start, end: close + 1, neg, text: s.slice(start, close + 1), body: s.slice(bodyAt, close + 1), regex });
        i = close + 1;
        continue;
      }
      // A plain term: up to unquoted whitespace.
      let j = i;
      let inQuote = false;
      for (; j < s.length; j += 1) {
        const ch = s[j];
        if (ch === '"') inQuote = !inQuote;
        else if (!inQuote && isSpace(ch)) break;
      }
      // Closers at its end close open groups, but only those its own brackets
      // leave over: f(x) stays a word, f(x)) closes one group.
      let end = j;
      if (depth > 0) {
        let tail = j;
        while (tail > bodyAt && s[tail - 1] === ')') tail -= 1;
        let quotes = 0;
        let opens = 0;
        let closes = 0;
        let q = false;
        for (let k = bodyAt; k < j; k += 1) {
          const ch = s[k];
          if (ch === '"') { q = !q; if (k < tail) quotes += 1; } else if (!q) { if (ch === '(') opens += 1; else if (ch === ')') closes += 1; }
        }
        if (quotes % 2 === 0) end = j - Math.max(0, Math.min(j - tail, closes - opens, depth));
      }
      const textOf = s.slice(start, end);
      if (textOf === 'OR') out.push({ t: 'or', start, end });
      else if (end > start) out.push({ t: 'term', start, end, neg: neg && end > bodyAt, text: textOf, body: s.slice(neg && end > bodyAt ? bodyAt : start, end), regex: null });
      for (let k = end; k < j; k += 1) { out.push({ t: 'rp', start: k, end: k + 1 }); depth -= 1; }
      i = j;
    }
    return out;
  }

  // One term token -> a leaf: { field, neg, value, scope?, regex?, bound?,
  // unknownKey? }. field: 'content' | 'group' | 'is' | 'num' | 'since' |
  // 'before' | 'len' | 'lines' | 'words' | 'id' | 'sort', or null (nothing to
  // match: an empty phrase).
  function leafOf(tok) {
    const neg = !!tok.neg;
    if (tok.regex) return { field: 'content', scope: tok.regex.scope, value: tok.regex.pattern, regex: true, neg };
    const body = tok.body;
    const plain = body.replace(/"/g, '');
    if (!plain) return { field: null, neg };
    const content = (value, scope, unknownKey) => ({ field: 'content', scope: scope || 'any', value, neg, ...(unknownKey ? { unknownKey } : {}) });
    const m = body[0] !== '"' ? KEY_TOKEN_RE.exec(body) : null;
    if (!m || !m[2]) return content(plain);
    const rawKey = m[1].toLowerCase();
    const key = PREFIX_ALIASES[rawKey] || rawKey; // fold short aliases to canonical
    const val = m[2].replace(/"/g, '');
    if (!val) return content(plain);
    // URL / windows-path guard: a value starting with / or \ (http://, C:\path)
    if ((m[2][0] === '/' || m[2][0] === '\\') && !RECOGNIZED_PREFIXES.has(rawKey)) return content(plain);
    if (key === 'title') return content(val, 'title');
    if (key === 'text') return content(val, 'body');
    if (key === 'group') return { field: 'group', value: normalizeTagName(val), neg };
    if (key === 'is') { const v = val.toLowerCase(); if (IS_VALUES.includes(v)) return { field: 'is', value: v, neg }; }
    if (key === 'num') { const n = parseInt(val, 10); if (n >= 1 && n <= 9 && /^\d$/.test(val)) return { field: 'num', value: n, neg }; }
    if (key === 'since' || key === 'before' || key === 'id') return { field: key, value: val, neg };
    if (key === 'len' || key === 'lines' || key === 'words') { const bound = parseBound(val); if (bound) return { field: key, value: val, bound, neg }; }
    if (key === 'sort') { const v = val.toLowerCase(); if (v === 'new' || v === 'best' || v === 'recent' || v === 'relevance') return { field: 'sort', value: v === 'recent' ? 'new' : v === 'relevance' ? 'best' : v, neg }; }
    // an unrecognized word: prefix (typo / unsupported) that isn't a URL scheme ->
    // strip to its value as free text + record the bad prefix for a hint.
    if (!NON_FILTER_SCHEMES.has(rawKey) && UNKNOWN_KEY_RE.test(rawKey)) return content(val, 'any', rawKey);
    // recognized-but-malformed (e.g. num:99) or URL scheme -> treat whole token as text
    return content(plain);
  }
  // A negated single-valued filter (-since:7d) cannot be excluded: it is
  // ignored (validateQuery offers the inverse) instead of acting as positive.
  const SINGLE_FIELDS = new Set(['since', 'before', 'len', 'lines', 'words', 'id', 'sort']);
  function addLeaf(out, leaf, raw) {
    const neg = leaf.neg;
    switch (leaf.field) {
      case 'content': {
        const c = { scope: leaf.scope, value: leaf.value, neg };
        if (leaf.regex) c.regex = true;
        out.content.push(c);
        // Non-enumerable: serialization metadata, invisible to consumers that
        // compare or spread a term.
        Object.defineProperty(c, 'raw', { value: raw, writable: true, configurable: true });
        if (leaf.unknownKey && !out.unknown.includes(leaf.unknownKey)) out.unknown.push(leaf.unknownKey);
        if (!neg) out.terms.push(c);
        return;
      }
      case 'group': (neg ? out.negGroups : out.groups).push(leaf.value); return;
      case 'is': (neg ? out.negIs : out.is).push(leaf.value); return;
      case 'num': (neg ? out.negNums : out.nums).push(leaf.value); return;
      default:
        if (!SINGLE_FIELDS.has(leaf.field) || neg) return;
        out[leaf.field] = leaf.bound || leaf.value;
    }
  }
  // Which OR dimension a filter value belongs to: every group is one, the
  // kinds of clip (image, text, link, multi-line, rich) are one, numpad keys
  // are one; pinned and "on a key" are each their own (pinned OR image is not
  // one question). A second chip of an OR dimension adds an OR.
  const TYPE_IS = new Set(['image', 'text', 'url', 'multiline', 'rich']);
  const OR_DIMS = new Set(['group', 'type', 'num']);
  function facetDim(field, value) {
    if (field === 'group' || field === 'num') return field;
    if (field === 'is') return TYPE_IS.has(value) ? 'type' : value;
    return null;
  }
  // A top-level OR whose sides are all positive values of ONE OR dimension
  // (group:A OR group:B): the anyOf pill. null for any other OR.
  function anyOfGroup(node) {
    let dim = null;
    let field = null;
    const members = [];
    for (const k of node.children) {
      if (k.type !== 'leaf' || k.leaf.neg) return null;
      const d = facetDim(k.leaf.field, k.leaf.value);
      if (!d || !OR_DIMS.has(d) || (dim && d !== dim)) return null;
      dim = d;
      field = k.leaf.field;
      if (!members.some((x) => x.value === k.leaf.value)) members.push({ value: k.leaf.value, text: k.text, start: k.start, end: k.end });
    }
    return { dim, field, values: members.map((x) => x.value), members, start: node.start, end: node.end };
  }

  // Tokens -> expression: juxtaposition is AND; OR binds tighter (Gmail's
  // rule, so `x a OR b` = x AND (a OR b) and an OR pill sits beside other terms
  // without brackets); `-` negates a term or a group. Nodes: { type: 'leaf',
  // leaf, text } | { type: 'or', children } | { type: 'and', neg, children },
  // each with its source range. A dangling OR or an unclosed '(' is recorded in
  // `syntax` (validateQuery reports it) and parsed as if it were not there /
  // closed at the end, so a query mid-typing still searches.
  function parseExpression(s, syntax) {
    const toks = scanQuery(s);
    let pos = 0;
    function unary() {
      while (pos < toks.length && toks[pos].t === 'or') { syntax.push({ kind: 'dangling-or', start: toks[pos].start, end: toks[pos].end }); pos += 1; }
      const tok = toks[pos];
      if (!tok || tok.t === 'rp') return null;
      pos += 1;
      if (tok.t === 'lp') {
        const children = sequence(true);
        const close = toks[pos] && toks[pos].t === 'rp' ? toks[pos] : null;
        if (close) pos += 1; else syntax.push({ kind: 'unclosed', start: tok.start, end: tok.end });
        return { type: 'and', neg: tok.neg, children, start: tok.start, end: close ? close.end : (children.length ? children[children.length - 1].end : tok.end) };
      }
      return { type: 'leaf', leaf: leafOf(tok), text: tok.text, start: tok.start, end: tok.end };
    }
    function either() {
      const first = unary();
      if (!first) return null;
      const kids = [first];
      while (pos < toks.length && toks[pos].t === 'or') {
        const orTok = toks[pos];
        pos += 1;
        const next = toks[pos] && toks[pos].t !== 'rp' && toks[pos].t !== 'or' ? unary() : null;
        if (!next) { syntax.push({ kind: 'dangling-or', start: orTok.start, end: orTok.end }); break; }
        kids.push(next);
      }
      return kids.length === 1 ? first : { type: 'or', children: kids, start: first.start, end: kids[kids.length - 1].end };
    }
    function sequence(inGroup) {
      const items = [];
      while (pos < toks.length) {
        if (toks[pos].t === 'rp') { if (inGroup) break; pos += 1; continue; }
        const before = pos;
        const node = either();
        if (node) items.push(node);
        else if (pos === before) pos += 1;
      }
      return items;
    }
    return sequence(false).map(simplifyNode).filter(Boolean);
  }
  // Flatten what changes nothing: a group of one, a group inside an AND, an
  // OR inside an OR; drop empty groups.
  function simplifyNode(node) {
    if (node.type === 'leaf') return node.leaf.field ? node : null;
    const kids = node.children.map(simplifyNode).filter(Boolean);
    if (!kids.length) return null;
    if (node.type === 'or') {
      const flat = [];
      for (const k of kids) { if (k.type === 'or') flat.push(...k.children); else flat.push(k); }
      return flat.length === 1 ? flat[0] : { ...node, children: flat };
    }
    // A group of one keeps its brackets in its range: removing or naming it
    // takes the brackets too.
    if (kids.length === 1 && !node.neg) return { ...kids[0], start: node.start, end: node.end };
    const flat = [];
    for (const k of kids) { if (k.type === 'and' && !k.neg) flat.push(...k.children); else flat.push(k); }
    return { ...node, children: flat };
  }
  // The content terms of a node that can match (an even number of NOTs above).
  function collectTerms(node, negated, out) {
    if (node.type === 'leaf') {
      const l = node.leaf;
      if (l.field === 'content' && l.neg === negated) {
        const c = { scope: l.scope, value: l.value, neg: false };
        if (l.regex) c.regex = true;
        out.push(c);
      }
      return;
    }
    const n = node.type === 'and' && node.neg ? !negated : negated;
    for (const k of node.children) collectTerms(k, n, out);
  }

  // Content terms keep the token exactly as typed (`raw`), so a chip rewriting
  // the query never reshapes the user's words: an unknown `titel:foo` stays
  // `titel:foo`, quotes stay where they were typed.
  function parseQuery(query) {
    const out = emptyParsed(query);
    const top = [];
    for (const node of parseExpression(out.raw, out.syntax)) {
      if (node.type === 'and' && !node.neg) top.push(...node.children); else top.push(node);
    }
    for (const node of top) {
      if (node.type === 'leaf') {
        addLeaf(out, node.leaf, node.text);
        out.items.push({ kind: 'leaf', start: node.start, end: node.end, leaf: node.leaf, text: node.text });
        continue;
      }
      const any = node.type === 'or' ? anyOfGroup(node) : null;
      if (any) {
        out.anyOf.push(any);
        out.items.push({ kind: 'any', start: node.start, end: node.end, any });
        continue;
      }
      out.compound.push(node);
      out.items.push({ kind: 'compound', start: node.start, end: node.end, node });
      collectTerms(node, false, out.terms);
    }
    return out;
  }
  // Canonical serialization: the content terms first, as typed (their `raw`
  // token) and in the typed order, then the facets in ONE fixed order
  // (FACET_ORDER, then value: groups by name, is: by IS_VALUES, slots
  // ascending), then the OR pills and the custom expressions as typed.
  // facetKey uses it; a chip never re-serializes the query (see applyFacet: it
  // edits only the tokens it changes).
  const byName = (a, b) => a.localeCompare(b, undefined, { sensitivity: 'base', numeric: true }) || (a < b ? -1 : a > b ? 1 : 0);
  const byIs = (a, b) => IS_VALUES.indexOf(a) - IS_VALUES.indexOf(b);
  const byNum = (a, b) => a - b;
  const FACET_ORDER = ['group', '-group', 'is', '-is', 'num', '-num', 'since', 'before', 'len', 'lines', 'words', 'id', 'sort'];
  // One filter value's canonical token ('group:"My notes"', 'is:image', 'num:3').
  function facetPart(field, value) {
    if (field === 'group') return 'group:' + quoteToken(value);
    if (field === 'num') return 'num:' + value;
    return 'is:' + value;
  }
  function anyOfText(g) {
    const sort = g.field === 'group' ? byName : g.field === 'num' ? byNum : byIs;
    return [...g.values].sort(sort).map((v) => facetPart(g.field, v)).join(' OR ');
  }
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
    for (const g of p.anyOf || []) parts.push(anyOfText(g));
    for (const n of p.compound || []) parts.push(p.raw.slice(n.start, n.end));
    return parts;
  }
  function serializeQuery(p) {
    const parts = [];
    for (const c of p.content) parts.push(c.raw || ((c.neg ? '-' : '') + (c.scope === 'title' ? 'title:' : c.scope === 'body' ? 'text:' : '') + (c.regex ? `/${c.value}/` : quoteToken(c.value))));
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
  // The canonical facet part a top-level leaf stands for, or null (content).
  function leafPart(leaf) {
    if (!leaf || !leaf.field || leaf.field === 'content') return null;
    const neg = leaf.neg ? '-' : '';
    if (leaf.field === 'group' || leaf.field === 'is' || leaf.field === 'num') return neg + facetPart(leaf.field, leaf.value);
    if (leaf.bound) return `${neg}${leaf.field}:${serializeBound(leaf.bound)}`;
    return `${neg}${leaf.field}:${quoteToken(leaf.value)}`;
  }

  // ── chip <-> query bridge: toggle a facet in the query string (bar = source of truth) ──
  // token: { kind:'group'|'builtin'|'is'|'num', value } ; intent: 'include'|'exclude'.
  // Single-valued facets ({ kind:'since'|'before'|'len'|'lines'|'words'|'id', value }) have no
  // exclude: the chip's value replaces the token, and the same value again clears it.
  // The text is EDITED, never re-serialized: only the tokens the change removes
  // go, a new token goes in at its canonical place among the facet tokens
  // already there (FACET_ORDER + value order, so chips clicked in any order
  // write the same text), and everything else - the words, their quotes, an
  // unknown prefix, the order the user typed, a custom (a OR b) - stays exactly
  // as typed. A value joins an OR dimension (groups, kinds of clip, numpad keys)
  // with OR when it holds one value or an OR already (group:A -> group:A OR
  // group:B); two values side by side (the pill's "and") take a third the same
  // way. Only the top level is edited: a value inside a custom expression is
  // left alone (its chip is greyed).
  const SINGLE_FACETS = ['since', 'before', 'len', 'lines', 'words', 'id'];
  const BOUND_FACETS = ['len', 'lines', 'words'];
  // A chip token -> { field, value } (builtin chip ids are is: kinds).
  function tokenFieldValue(token) {
    if (token.kind === 'group') return { field: 'group', value: normalizeTagName(token.value) };
    if (token.kind === 'num') return { field: 'num', value: Number(token.value) };
    return { field: 'is', value: BUILTIN_TO_IS[token.value] || token.value };
  }
  function singleFacetNext(p, token) {
    const k = token.kind;
    if (BOUND_FACETS.includes(k)) {
      const bound = parseBound(String(token.value == null ? '' : token.value));
      return bound && !(p[k] && serializeBound(p[k]) === serializeBound(bound)) ? `${k}:${serializeBound(bound)}` : null;
    }
    const v = String(token.value == null ? '' : token.value).trim();
    return v && String(p[k] || '').toLowerCase() !== v.toLowerCase() ? `${k}:${quoteToken(v)}` : null;
  }
  // Apply range edits ({ start, end, text }) to text. A removal also takes the
  // whitespace after it (or, at the end, before it), so no double spaces are
  // left; groups the edit emptied go too.
  function applyEdits(text, edits) {
    let out = text;
    for (const e of [...edits].sort((a, b) => b.start - a.start || b.end - a.end)) {
      let { start, end } = e;
      if (!e.text) {
        let after = end;
        while (after < out.length && isSpace(out[after])) after += 1;
        if (after < out.length) end = after;
        else { while (start > 0 && isSpace(out[start - 1])) start -= 1; end = after; }
      }
      out = out.slice(0, start) + e.text + out.slice(end);
    }
    return out.replace(/(^|\s)-?\(\s*\)(?=\s|$)/g, '$1').replace(/^\s+/, '');
  }
  function editFacets(text, p, plan) {
    const edits = [];
    const removed = new Set();
    const remove = (item) => { removed.add(item); edits.push({ start: item.start, end: item.end, text: '' }); };
    const rewriteAny = (item, members) => {
      if (!members.length) { remove(item); return; }
      removed.add(item);
      edits.push({ start: item.start, end: item.end, text: members.map((m) => m.text).join(' OR ') });
    };
    // A new token goes before the first top-level filter that sorts after it,
    // else at the end.
    const insertPart = (part) => {
      for (const item of p.items) {
        if (removed.has(item) || item.kind !== 'leaf') continue;
        const at = leafPart(item.leaf);
        if (at && compareParts(at, part) > 0) { edits.push({ start: item.start, end: item.start, text: `${part} ` }); return; }
      }
      const end = text.replace(/\s+$/, '').length;
      edits.push({ start: end, end, text: end ? ` ${part}` : part });
    };
    plan({ remove, rewriteAny, insertPart, edits });
    const out = applyEdits(text, edits);
    return out && /\s$/.test(text) && !/\s$/.test(out) ? `${out} ` : out; // a trailing space (mid-typing) stays
  }
  function applyFacet(query, token, intent) {
    const text = String(query == null ? '' : query);
    const p = parseQuery(text);
    if (SINGLE_FACETS.includes(token.kind)) {
      const k = token.kind;
      const next = singleFacetNext(p, token);
      return editFacets(text, p, ({ remove, insertPart }) => {
        // A later token overrides an earlier one, so the text may hold several.
        for (const item of p.items) if (item.kind === 'leaf' && item.leaf.field === k) remove(item);
        if (next) insertPart(next);
      });
    }
    const { field, value } = tokenFieldValue(token);
    const part = facetPart(field, value);
    const dim = facetDim(field, value);
    const isLeaf = (item, neg) => item.kind === 'leaf' && item.leaf.field === field && !!item.leaf.neg === neg && item.leaf.value === value;
    const pos = p.items.filter((item) => isLeaf(item, false));
    const negs = p.items.filter((item) => isLeaf(item, true));
    const holding = p.items.filter((item) => item.kind === 'any' && item.any.field === field && item.any.values.includes(value));
    return editFacets(text, p, ({ remove, rewriteAny, insertPart, edits }) => {
      const dropValue = () => {
        pos.forEach(remove);
        for (const item of holding) rewriteAny(item, item.any.members.filter((m) => m.value !== value));
      };
      if (intent === 'exclude') {
        if (negs.length) negs.forEach(remove);                // already excluded -> clear
        else { dropValue(); insertPart(`-${part}`); }           // include->exclude / add exclude
        return;
      }
      if (pos.length || holding.length) { dropValue(); return; } // already included -> clear
      if (negs.length) { negs.forEach(remove); return; }         // excluded -> clear
      // Add: OR into the dimension's OR, or onto its one value, at its value
      // order (chips clicked in any order write the same text); else a token.
      if (OR_DIMS.has(dim)) {
        const order = field === 'group' ? byName : field === 'num' ? byNum : byIs;
        const anyItem = p.items.find((item) => item.kind === 'any' && item.any.dim === dim);
        const ones = p.items.filter((item) => item.kind === 'leaf' && !item.leaf.neg && facetDim(item.leaf.field, item.leaf.value) === dim);
        const members = anyItem ? anyItem.any.members : ones.length === 1 ? [{ value: ones[0].leaf.value, start: ones[0].start, end: ones[0].end }] : null;
        if (members) {
          const next = members.find((m) => order(m.value, value) > 0);
          if (next) edits.push({ start: next.start, end: next.start, text: `${part} OR ` });
          else edits.push({ start: members[members.length - 1].end, end: members[members.length - 1].end, text: ` OR ${part}` });
          return;
        }
      }
      insertPart(part);
    });
  }
  // Remove every top-level token of one filter value (both signs, from an OR
  // too): a deleted group leaves no group: behind.
  function stripFacet(query, token) {
    const text = String(query == null ? '' : query);
    const p = parseQuery(text);
    const { field, value } = tokenFieldValue(token);
    return editFacets(text, p, ({ remove, rewriteAny }) => {
      for (const item of p.items) {
        if (item.kind === 'leaf' && item.leaf.field === field && item.leaf.value === value) remove(item);
        else if (item.kind === 'any' && item.any.field === field && item.any.values.includes(value)) rewriteAny(item, item.any.members.filter((m) => m.value !== value));
      }
    });
  }
  // Remove every top-level token of a single-valued filter (since:, len:, ...).
  function clearFacet(query, kind) {
    const text = String(query == null ? '' : query);
    const p = parseQuery(text);
    return editFacets(text, p, ({ remove }) => { for (const item of p.items) if (item.kind === 'leaf' && item.leaf.field === kind) remove(item); });
  }
  // Add one token (a pill's text, title:"a b") to the query: a filter at its
  // canonical place, anything else after the words.
  function addToken(query, tokenText) {
    const text = String(query == null ? '' : query);
    const t = String(tokenText || '').trim();
    if (!t) return text;
    const p = parseQuery(text);
    const one = parseQuery(t);
    const part = one.items.length === 1 && one.items[0].kind === 'leaf' ? leafPart(one.items[0].leaf) : null;
    return editFacets(text, p, ({ insertPart, edits }) => {
      if (part) { insertPart(t); return; }
      const lastContent = [...p.items].reverse().find((item) => item.kind === 'leaf' && item.leaf.field === 'content');
      if (lastContent) edits.push({ start: lastContent.end, end: lastContent.end, text: ` ${t}` });
      else insertPart(t);
    });
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
    const { field, value } = tokenFieldValue(token);
    const inc = field === 'group' ? parsed.groups : field === 'num' ? parsed.nums : parsed.is;
    const ex = field === 'group' ? parsed.negGroups : field === 'num' ? parsed.negNums : parsed.negIs;
    if (inc.includes(value) || (parsed.anyOf || []).some((g) => g.field === field && g.values.includes(value))) return 'include';
    return ex.includes(value) ? 'exclude' : null;
  }

  // Every filter value named inside a custom expression (a OR b, -(a b)): its
  // chip is greyed, since a click could not change it there. Census keys.
  function nodeFacetKeys(node, out) {
    if (node.type === 'leaf') {
      const l = node.leaf;
      if (l.field === 'group') out.add(`group:${l.value}`);
      else if (l.field === 'is') out.add(`is:${l.value}`);
      else if (l.field === 'num') out.add(`num:${l.value}`);
      else if (l.field && l.field !== 'content') out.add(`${l.field}:`);
      return out;
    }
    for (const k of node.children) nodeFacetKeys(k, out);
    return out;
  }
  function customFacetKeys(parsed) {
    if (!parsed.compound || !parsed.compound.length) return null;
    if (!parsed.customKeys) Object.defineProperty(parsed, 'customKeys', { value: parsed.compound.reduce((set, n) => nodeFacetKeys(n, set), new Set()), configurable: true });
    return parsed.customKeys;
  }

  // Chip active/excluded state for the filter bar, derived straight from the query.
  function facetState(parsed) {
    const active = new Set();
    const excluded = new Set();
    for (const g of parsed.groups) active.add(g);
    for (const g of parsed.negGroups) excluded.add(g);
    for (const v of parsed.is) if (IS_TO_BUILTIN[v]) active.add(IS_TO_BUILTIN[v]);
    for (const v of parsed.negIs) if (IS_TO_BUILTIN[v]) excluded.add(IS_TO_BUILTIN[v]);
    for (const g of parsed.anyOf || []) for (const v of g.values) {
      if (g.field === 'group') active.add(v);
      else if (g.field === 'is' && IS_TO_BUILTIN[v]) active.add(IS_TO_BUILTIN[v]);
    }
    if (parsed.nums.length || parsed.is.includes('numpad') || (parsed.anyOf || []).some((g) => g.field === 'num')) active.add('__numbered__');
    return { active, excluded };
  }

  function nodeHasFilter(node) {
    if (node.type === 'leaf') return !!node.leaf.field && node.leaf.field !== 'content';
    return node.children.some(nodeHasFilter);
  }
  function anyFilterActive(parsed) {
    return !!(parsed.groups.length || parsed.negGroups.length || parsed.is.length || parsed.negIs.length ||
      parsed.nums.length || parsed.negNums.length || parsed.since || parsed.before || parsed.len || parsed.lines || parsed.words || parsed.id
      || (parsed.anyOf && parsed.anyOf.length) || (parsed.compound && parsed.compound.some(nodeHasFilter)));
  }
  // Is there anything to search FOR (a word, a phrase, a /regex/), as opposed
  // to filters only?
  function hasSearchTerms(parsed) {
    return !!((parsed.content && parsed.content.length) || (parsed.terms && parsed.terms.length) || (parsed.compound && parsed.compound.some((n) => !nodeHasFilter(n))));
  }
  function isEmptyQuery(parsed) {
    return !parsed.content.length && !anyFilterActive(parsed) && !parsed.sort && !(parsed.compound && parsed.compound.length);
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
  // ONE compile primitive for a literal or a regex term, shared by search, the
  // row highlight and the editor's find bar. compileTerm(value, { regex,
  // caseSensitive }) -> { regex, valid, error, lower, test(text, isLower),
  // find(text, from) -> { start, end } | null, all(text, limit) -> spans }.
  // Case-insensitive unless caseSensitive; `.` never crosses a line break (no
  // s flag); an invalid regex is valid:false and matches nothing. test's
  // isLower says the text is ALREADY lowercased (the precomputed haystack), so
  // a literal term never lowercases it again.
  const RE_META_G = /[.*+?^${}()|[\]\\]/g;
  function escapeRegExp(s) { return String(s).replace(RE_META_G, '\\$&'); }
  function regexError(value) {
    try { new RegExp(value, 'i'); return null; } catch (e) { return String(e && e.message || 'invalid').replace(/^Invalid regular expression: \/.*\/[a-z]*: /, ''); }
  }
  function compileTerm(value, opts) {
    const o = opts || {};
    const src = String(value == null ? '' : value);
    const cs = !!o.caseSensitive;
    let re = null;
    let error = null;
    if (o.regex) { try { re = new RegExp(src, cs ? 'g' : 'gi'); } catch { error = regexError(src); } }
    else if (src) re = new RegExp(escapeRegExp(src), cs ? 'g' : 'gi');
    const lower = o.regex ? '' : cs ? src : src.toLowerCase();
    const str = (t) => (t == null ? '' : String(t));
    const test = o.regex
      ? (t) => { if (!re) return false; re.lastIndex = 0; return re.test(str(t)); }
      : (t, isLower) => (cs ? str(t) : isLower && typeof t === 'string' ? t : str(t).toLowerCase()).includes(lower);
    const find = (t, from) => {
      if (!re) return null;
      const text = str(t);
      re.lastIndex = from || 0;
      let m;
      while ((m = re.exec(text))) {
        if (m[0] !== '') return { start: m.index, end: m.index + m[0].length };
        re.lastIndex += 1; // an empty match (a*) shows nothing; look on
        if (re.lastIndex > text.length) break;
      }
      return null;
    };
    const all = (t, limit) => {
      const spans = [];
      const cap = limit || 100000;
      let at = 0;
      let hit;
      while (spans.length < cap && (hit = find(t, at))) { spans.push(hit); at = hit.end; }
      return spans;
    };
    return { regex: !!o.regex, valid: !error, error, source: src, lower, test, find, all };
  }
  // Compiled once per term object (a query compiles each term once, not once
  // per clip).
  const compiled = typeof WeakMap === 'function' ? new WeakMap() : null;
  function termMatcher(term) {
    let m = compiled && compiled.get(term);
    if (!m) { m = compileTerm(term.value, { regex: !!term.regex }); if (compiled) compiled.set(term, m); }
    return m;
  }
  // One matcher per content term, built once per query (not once per clip).
  function compileContent(parsed) {
    return parsed.content.map(termMatcher);
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
  function contentHit(c, m, doc, hayLower) {
    if (c.scope === 'title') return m.test(doc.title, false);
    if (c.scope === 'body') return m.regex ? m.test(doc.body, false) : bodyIndexOf(doc, hayLower, m.lower) >= 0;
    return m.test(hayLower, true);
  }
  function facetValueOk(doc, field, v) {
    if (field === 'group') return docInGroup(doc, v);
    if (field === 'num') return doc.numpad === v;
    return docHasIs(doc, v);
  }
  // One leaf of a custom expression (its sign included). A negated
  // single-valued filter is ignored (always true), as at the top level.
  function leafOk(leaf, doc, hayLower, now) {
    let hit;
    switch (leaf.field) {
      case 'content': hit = contentHit(leaf, termMatcher(leaf), doc, hayLower); break;
      case 'group': case 'is': case 'num': hit = facetValueOk(doc, leaf.field, leaf.value); break;
      case 'since': case 'before': {
        if (leaf.neg) return true;
        const b = resolveTimeMs(leaf.value, now);
        return b == null || (leaf.field === 'since' ? doc.ts * 1000 >= b : doc.ts * 1000 <= b);
      }
      case 'len': case 'lines': case 'words': {
        if (leaf.neg) return true;
        return lenSatisfies(leaf.field === 'len' ? doc.len : leaf.field === 'lines' ? docLines(doc) : docWords(doc), leaf.bound);
      }
      case 'id': return leaf.neg || doc.id.toLowerCase().includes(String(leaf.value).toLowerCase());
      default: return true;
    }
    return leaf.neg ? !hit : hit;
  }
  function evalNode(node, doc, hayLower, now) {
    if (node.type === 'leaf') return leafOk(node.leaf, doc, hayLower, now);
    if (node.type === 'or') return node.children.some((k) => evalNode(k, doc, hayLower, now));
    const all = node.children.every((k) => evalNode(k, doc, hayLower, now));
    return node.neg ? !all : all;
  }
  // Strict filter: every top-level term, filter, OR pill and custom expression
  // must hold. `opts`: { now, searchText? (precomputed combined haystack,
  // LOWERCASED), matchers? (compileContent of this query) }.
  function matchDoc(doc, parsed, opts) {
    if (!doc) return false;
    const o = opts || {};
    const matchers = o.matchers || compileContent(parsed);
    let any = o.searchText;
    for (let k = 0; k < parsed.content.length; k += 1) {
      const c = parsed.content[k];
      const m = matchers[k];
      if (c.scope === 'any' && any == null) any = docSearchText(doc).toLowerCase();
      const hit = c.scope === 'title' ? m.test(doc.title, false) : contentHit(c, m, doc, any);
      if (c.neg ? hit : !hit) return false;
    }
    for (const g of parsed.groups) if (!docInGroup(doc, g)) return false;
    for (const g of parsed.negGroups) if (docInGroup(doc, g)) return false;
    for (const v of parsed.is) if (!docHasIs(doc, v)) return false;
    for (const v of parsed.negIs) if (docHasIs(doc, v)) return false;
    for (const n of parsed.nums) if (doc.numpad !== n) return false;
    for (const n of parsed.negNums) if (doc.numpad === n) return false;
    if (parsed.since != null) { const b = resolveTimeMs(parsed.since, o.now); if (b != null && doc.ts * 1000 < b) return false; }
    if (parsed.before != null) { const b = resolveTimeMs(parsed.before, o.now); if (b != null && doc.ts * 1000 > b) return false; }
    if (parsed.len && !lenSatisfies(doc.len, parsed.len)) return false;
    if (parsed.lines && !lenSatisfies(docLines(doc), parsed.lines)) return false;
    if (parsed.words && !lenSatisfies(docWords(doc), parsed.words)) return false;
    if (parsed.id && !doc.id.toLowerCase().includes(String(parsed.id).toLowerCase())) return false;
    for (const g of parsed.anyOf || []) if (!g.values.some((v) => facetValueOk(doc, g.field, v))) return false;
    if (parsed.compound && parsed.compound.length) {
      if (any == null) any = docSearchText(doc).toLowerCase();
      for (const n of parsed.compound) if (!evalNode(n, doc, any, o.now || Date.now())) return false;
    }
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
  // Every span the query's terms match in `text` (positive terms only, the
  // ones inside an OR included), merged where they touch: the row highlight
  // and the preview window. scope: 'title' | 'body' (which terms apply).
  function termSpans(parsed, text, scope, limit) {
    const raw = String(text == null ? '' : text);
    const spans = [];
    for (const t of (parsed && parsed.terms) || []) {
      if (scope === 'title' ? t.scope === 'body' : t.scope === 'title') continue;
      const m = termMatcher(t);
      if (!m.valid || (!m.regex && !m.lower)) continue;
      spans.push(...m.all(raw, limit || 100));
    }
    if (spans.length < 2) return spans;
    spans.sort((a, b) => a.start - b.start || b.end - a.end);
    const merged = [spans[0]];
    for (const s of spans.slice(1)) {
      const last = merged[merged.length - 1];
      if (s.start <= last.end) last.end = Math.max(last.end, s.end); else merged.push({ ...s });
    }
    return merged;
  }
  // Where the query first matches in `text` (-1: nowhere), for a preview
  // window around it.
  function firstMatchIndex(parsed, text) {
    let best = -1;
    for (const t of (parsed && parsed.terms) || []) {
      if (t.scope === 'title') continue;
      const m = termMatcher(t);
      const hit = m.valid && (m.regex || m.lower) ? m.find(text, 0) : null;
      if (hit && (best < 0 || hit.start < best)) best = hit.start;
    }
    return best;
  }

  // ── relevance scoring (for the strict-filter list; rank survivors) ──
  const RECENCY_SCALE_MS = 3 * 86400 * 1000; // 3 days
  const RECENCY_WEIGHT = 30;                  // max recency contribution vs relevance
  const GROUP_USE_WEIGHT = 8;                 // max nudge for a clip of your most-used group
  function recencyScore(doc, now) {
    return RECENCY_WEIGHT * decayWeight((now || Date.now()) - doc.ts * 1000, RECENCY_SCALE_MS);
  }
  function normalizedPhrase(v) { return String(v == null ? '' : v).trim().toLowerCase(); }
  // The terms a relevance score reads (every term that can match, the ones
  // inside an OR included), normalised once per query (not once per clip):
  // [{ scope, v (lowercase phrase), spaced } | { scope, re (compiled regex) }].
  function relevanceTerms(parsed) {
    const out = [];
    for (const c of parsed.terms || []) {
      if (c.regex) { const m = termMatcher(c); if (m.valid) out.push({ scope: c.scope, re: m }); continue; }
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
    let score = 0;
    // opts.hay: the clip's lowercased combined haystack; body positions come
    // from it (bodyIndexOf) instead of lowercasing the whole body per keystroke.
    // opts.terms: relevanceTerms(parsed), precomputed by a caller scoring many clips.
    const titleLower = docTitleLower(doc);
    for (const t of (o.terms || relevanceTerms(parsed))) {
      const wantTitle = t.scope !== 'body';
      const wantBody = t.scope !== 'title';
      if (t.re) {
        if (wantTitle && doc.title && t.re.test(doc.title)) score += 22;
        if (wantBody && doc.body && t.re.test(doc.body)) score += 12;
        continue;
      }
      const v = t.v;
      // exact / prefix / substring in title
      if (wantTitle && doc.title) {
        if (titleLower === v) score += 60;
        else if (titleLower.startsWith(v)) score += 34;
        else if (titleLower.includes(v)) score += 22;
        else { const fm = fuzzyMatch(v, doc.title); if (fm && fm.score >= fuzzyFloor(v.length)) score += 10 + Math.min(14, fm.score / 6); }
      }
      if (wantBody && doc.body) {
        const idx = bodyIndexOf(doc, o.hay, v);
        if (idx >= 0) { score += 12; score += Math.max(0, 6 - idx / 200); } // earlier = a touch better
        // multi-word phrase already covered by includes; word tokens add a little
        if (t.spaced && idx >= 0) score += 6;
      }
      if (t.scope === 'any') {
        // group-name hit is weak signal
        if (doc.groups.length && doc.groups.some((g) => g.toLowerCase().includes(v))) score += 4;
      }
    }
    // small structural nudges: pinned, and a group you use (o.groupUse:
    // groupWeights of the whole history)
    if (doc.pinned) score += 3;
    const use = o.groupUse;
    if (use && use.max > 0 && doc.groups.length) {
      let best = 0;
      for (const g of doc.groups) { const w = use.get(g) || 0; if (w > best) best = w; } // stored names are normalised
      score += GROUP_USE_WEIGHT * (best / use.max);
    }
    return score;
  }

  // Filter + rank -> array of ORIGINAL indexes. `opts`: { now, sortMode ('best'|'new'),
  // docs? (prebuilt), searchTextLower? (precomputed combined haystacks, lowercased) }.
  // Ranking mode for a parsed query: an explicit sortMode (the Best/Recent toggle) or
  // `sort:` token wins; else relevance ('best') when there is something to search for;
  // else the caller's ORIGINAL order ('none' - the popup's history order, which is newest
  // first). 'new' and 'none' are both time-ordered lists; the popup's keep-your-place
  // rules (Core.resolveListAnchor) key off exactly this, so it has ONE definition.
  function rankMode(parsed, sortMode) {
    const p = parsed || {};
    return sortMode || (p.sort ? p.sort : (hasSearchTerms(p) ? 'best' : 'none'));
  }

  // Incremental refinement: typing more of a term can only narrow the result,
  // so the next keystroke tests the previous matches instead of every clip.
  // Valid when the docs + haystacks are the same arrays, the query is a plain
  // AND of literal terms (no /regex/, no custom expression: neither narrows by
  // growing), the facets are identical (no before:, whose relative bound widens
  // as time passes), and every earlier content term is kept (same scope and
  // sign) with a positive term only growing (new includes old) and a negative
  // one unchanged; terms may be appended. `cache` is a caller-owned object
  // (one per list).
  function refineState(parsed) {
    return {
      facets: facetKey(parsed),
      before: !!parsed.before,
      strict: !(parsed.compound && parsed.compound.length) && !parsed.content.some((c) => c.regex),
      terms: parsed.content.map((c) => ({ scope: c.scope, neg: !!c.neg, lower: String(c.value).toLowerCase() })),
    };
  }
  function canRefine(prev, next) {
    if (!prev || !prev.strict || !next.strict || prev.before || next.before || prev.facets !== next.facets) return false;
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
    const hasContent = hasSearchTerms(parsed);
    const mode = rankMode(parsed, o.sortMode);
    const scored = [];
    // One options object and one compiled matcher set for the whole pass.
    const matchOpts = { now, searchText: undefined, matchers: compileContent(parsed) };
    const relOpts = { ...o, hay: undefined, terms: relevanceTerms(parsed), groupUse: mode === 'best' && hasContent ? groupWeights(docs, now) : null };
    const cache = o.cache || null;
    const state = cache ? refineState(parsed) : null;
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
  // typed segments: prefix | value | neg | quote | regex | op | unknown | ws. parseQuery
  // stays the semantic authority; this only decides colors, from the same scanner.
  // The search modes: 'advanced' = the whole language; 'basic' = the field is
  // literal words (quotes still make a phrase); 'regex' = the field is one regex.
  const SEARCH_MODES = ['basic', 'regex', 'advanced'];
  function normalizeMode(mode) { return SEARCH_MODES.includes(mode) ? mode : 'basic'; }
  const REGEX_META = /[[\]().*+?|^$\\{}]/;
  function pushValueSegs(segs, value, regexAware, plainQuotes) {
    let buf = '';
    let kind = null;
    const flush = () => { if (buf && kind) segs.push({ kind, text: buf }); buf = ''; kind = null; };
    for (const ch of String(value)) {
      const k = ch === '"' && !plainQuotes ? 'quote' : (regexAware && REGEX_META.test(ch)) ? 'regex' : 'value';
      if (k !== kind) flush();
      buf += ch; kind = k;
    }
    flush();
  }
  // What is INVALID comes from validateQuery (ONE rule): its problemRanges are
  // painted 'unknown', exactly the bad key or value and nothing around it.
  // opts: { mode, groups, problems (the caller's validateQuery result, e.g.
  // with pending ones left out; else every non-pending problem of the text) }.
  function lexQuery(text, opts) {
    const o = opts || {};
    const segs = lexSegments(text, o);
    const problems = o.problems || validateQuery(text, { mode: o.mode, groups: o.groups }).filter((p) => !p.pending);
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
  // Words and the spaces between them, for the Basic and Regex views.
  function lexPlain(s, regexAware) {
    const segs = [];
    for (const part of s.split(/(\s+)/)) {
      if (!part) continue;
      if (/^\s+$/.test(part)) segs.push({ kind: 'ws', text: part }); else pushValueSegs(segs, part, regexAware, regexAware);
    }
    return segs;
  }
  function lexSegments(text, opts) {
    const o = opts || {};
    const s = String(text || '');
    const mode = o.mode ? normalizeMode(o.mode) : 'advanced';
    if (mode !== 'advanced') return lexPlain(s, mode === 'regex');
    const segs = [];
    let pos = 0;
    for (const tok of scanQuery(s)) {
      if (tok.start > pos) segs.push({ kind: 'ws', text: s.slice(pos, tok.start) });
      pos = tok.end;
      if (tok.t === 'lp') { if (tok.neg) segs.push({ kind: 'neg', text: '-' }); segs.push({ kind: 'op', text: '(' }); continue; }
      if (tok.t !== 'term') { segs.push({ kind: 'op', text: s.slice(tok.start, tok.end) }); continue; }
      let body = tok.text;
      let at = tok.start;
      if (tok.neg) { segs.push({ kind: 'neg', text: '-' }); body = body.slice(1); at += 1; }
      if (tok.regex) {
        if (tok.regex.open > at) segs.push({ kind: 'prefix', text: s.slice(at, tok.regex.open) });
        segs.push({ kind: 'regex', text: '/' });
        pushValueSegs(segs, tok.regex.pattern, true, true);
        segs.push({ kind: 'regex', text: '/' });
        continue;
      }
      // A bare known key (`title:`, its value still to type) is already a key.
      const m = body[0] !== '"' ? KEY_TOKEN_RE.exec(body) : null;
      if (m && m[2][0] !== '/' && m[2][0] !== '\\' && RECOGNIZED_PREFIXES.has(m[1].toLowerCase())) {
        segs.push({ kind: 'prefix', text: body.slice(0, m[1].length + 1) });
        if (m[2]) pushValueSegs(segs, m[2], false);
        continue;
      }
      pushValueSegs(segs, body, false);
    }
    if (pos < s.length) segs.push({ kind: 'ws', text: s.slice(pos) });
    return segs;
  }

  // ── what each filter and value means: ONE table, keyed by prefix AND value.
  // The autocomplete rows read it (each row its own hint, never one hint
  // repeated down the list), the "Did you mean" / valid-values feedback lists
  // its values, and the options panel's field keys (OPTION_FIELDS) take their
  // tooltips from it, so a hint reads the same everywhere. `short` = the
  // short alias (PREFIX_ALIASES has them all).
  const FIELD_INFO = {
    title: { desc: 'match the clip title only', short: 't' },
    text: { desc: 'match the clip body only', short: 'b' },
    group: { desc: 'in a group (and its sub-groups)', short: 'g' },
    is: { desc: 'kind of clip', values: { pinned: 'starred (pinned) clips', image: 'a picture', text: 'text, not a picture', numpad: 'on a numpad key', url: 'the clip is a link', multiline: 'spans several lines', rich: 'has HTML or RTF formatting' } },
    num: { desc: 'on numpad key 1-9', short: 'n' },
    since: { desc: 'newer than (1h, 7d or a date)', short: 's', values: { '1h': 'the last hour', '24h': 'the last day', '7d': 'the last week', '30d': 'the last month' } },
    before: { desc: 'older than (1h, 7d or a date)', short: 'bf', values: { '1h': 'an hour ago', '24h': 'a day ago', '7d': 'a week ago', '30d': 'a month ago' } },
    len: { desc: 'character count (>100, 50-200)', short: 'l', values: { '>100': 'more than 100 characters', '>500': 'more than 500 characters', '<80': 'under 80 characters', '50-200': '50 to 200 characters' } },
    lines: { desc: 'line count (>3)', short: 'ln', values: { '>1': 'more than one line', '>10': 'more than 10 lines', '<3': 'under 3 lines', '2-5': '2 to 5 lines' } },
    words: { desc: 'word count (<20)', short: 'wd', values: { '<20': 'under 20 words', '>100': 'more than 100 words', '10-50': '10 to 50 words' } },
    id: { desc: 'clip id contains' },
    sort: { desc: 'order results: newest or best match first', short: 'o', values: { new: 'newest first', best: 'best match first' } },
  };
  // What a value prompt asks (an options-panel "Since..." chip, or a key chip
  // in Basic / Regex mode, where the field is not syntax): the question and an
  // example answer.
  const FIELD_ASK = {
    title: { ask: 'Title contains', example: 'a word or a phrase' },
    text: { ask: 'Text contains', example: 'a word or a phrase' },
    group: { ask: 'In group', example: 'a group name' },
    num: { ask: 'On numpad key', example: '1 to 9' },
    since: { ask: 'Since when?', example: '3d, 12h or 2026-01-31' },
    before: { ask: 'Before when?', example: '3d, 12h or 2026-01-31' },
    len: { ask: 'How many characters?', example: '>200, <80 or 50-200' },
    lines: { ask: 'How many lines?', example: '>10, <3 or 2-5' },
    words: { ask: 'How many words?', example: '>100, <20 or 10-50' },
  };
  const SINCE_PRESETS = Object.keys(FIELD_INFO.since.values);
  // Derived views of FIELD_INFO (kept as exports): 'title:' -> its description /
  // its short alias ('t:').
  const PREFIX_HINTS = Object.fromEntries(Object.entries(FIELD_INFO).map(([k, f]) => [`${k}:`, f.desc]));
  const PREFIX_SHORT = Object.fromEntries(Object.entries(FIELD_INFO).filter(([, f]) => f.short).map(([k, f]) => [`${k}:`, `${f.short}:`]));

  // The search options panel's facet rows: the less-used filters, one click each.
  // Chips write tokens through applyFacet (the query text stays the single source
  // of truth) and paint their state from facetTokenState. `prompt` options take
  // a value of the user's (promptOptionState / promptQuery): in Advanced their
  // prefix goes into the field for typing, elsewhere a small prompt asks for
  // it; `prompt.op` = a size direction (> longer, < shorter) a bare number
  // takes; `prompt.active` = the lit chip's label. ONE table: the panel and the
  // availability census both read it. A filter the chip bar already owns (is:pinned,
  // is:image, is:numpad = BUILTIN_TO_IS) never appears here: one filter, one place,
  // and the panel's toggle lights only for the panel's own filters.
  const OPTION_FACETS = [
    { id: 'date', label: 'Date', options: [
      { label: 'Last 24h', token: { kind: 'since', value: '24h' } },
      { label: 'Last 7 days', token: { kind: 'since', value: '7d' } },
      { label: 'Last 30 days', token: { kind: 'since', value: '30d' } },
      { label: 'Since...', token: { kind: 'since' }, prompt: { active: 'Since {v}' } },
      { label: 'Before...', token: { kind: 'before' }, prompt: { active: 'Before {v}' } },
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
      { label: 'Longer than...', token: { kind: 'len' }, prompt: { op: '>', active: 'Longer than {v}' } },
      { label: 'Shorter than...', token: { kind: 'len' }, prompt: { op: '<', active: 'Shorter than {v}' } },
      { label: 'Lines...', token: { kind: 'lines' }, prompt: { active: 'Lines {v}' } },
      { label: 'Words...', token: { kind: 'words' }, prompt: { active: 'Words {v}' } },
    ] },
  ];
  // A prompt chip lights for a value of its kind that no preset of its row
  // holds (and, for a size direction, one going that way): 'include' | null.
  // Its label then shows the value (active, {v}).
  function promptOptionState(parsed, row, opt) {
    const k = opt.token.kind;
    const cur = parsed[k];
    if (!cur || !opt.prompt) return null;
    if (row.options.some((o) => !o.prompt && o.token.kind === k && facetTokenState(parsed, o.token) === 'include')) return null;
    const op = opt.prompt.op;
    if (op && !(BOUND_FACETS.includes(k) && cur.op && cur.op[0] === op)) return null;
    if (!op && row.options.some((o) => o !== opt && o.prompt && o.prompt.op && o.token.kind === k && promptOptionState(parsed, row, o))) return null;
    return 'include';
  }
  function promptOptionLabel(parsed, opt) {
    const k = opt.token.kind;
    const cur = parsed[k];
    if (!cur || !opt.prompt || !opt.prompt.active) return opt.label;
    const v = BOUND_FACETS.includes(k) ? (opt.prompt.op && cur.op === opt.prompt.op ? String(cur.n) : serializeBound(cur)) : String(cur);
    return opt.prompt.active.replace('{v}', v);
  }
  // The query after a prompt's answer: { query } or { error } (the answer is
  // not a valid value). key: a FIELD_ASK key; op: a size direction a bare
  // number takes (len, Longer than: 200 -> len:>200). A value already there
  // leaves the query as it is (a prompt never toggles a filter off).
  function promptQuery(query, key, answer, opts) {
    const o = opts || {};
    const raw = String(answer == null ? '' : answer).trim();
    if (!raw) return { query: String(query || '') };
    const value = BOUND_FACETS.includes(key) && o.op && /^d+$/.test(raw) ? `${o.op}${raw}` : raw;
    const tokenText = `${key}:${quoteToken(value)}`;
    const problems = validateQuery(tokenText, { mode: 'advanced', groups: o.groups });
    if (problems.length) return { error: describeProblem(problems[0]) };
    const q = String(query || '');
    if (key === 'title' || key === 'text') return { query: addToken(q, tokenText) };
    const token = key === 'group' || key === 'num' ? { kind: key, value: key === 'num' ? Number(value) : value } : { kind: key, value };
    if (facetTokenState(parseQuery(q), token) === 'include') return { query: q };
    return { query: applyFacet(q, token, 'include') };
  }
  // The panel teaches the grammar the way Forge's does: a toggle WRITES its
  // token into the field (Last 7 days -> since:7d), so the format is learned by
  // using it. What no toggle writes gets one key chip each (OPTION_FIELDS: a
  // click puts `title:` in the field to type the value), and the few rules no
  // key shows are one line (SYNTAX_NOTES). Derived: a field a facet row writes
  // is taught by that row; is: has the chips, sort: the field's own button,
  // id: is for tools.
  const PANEL_TAUGHT_ELSEWHERE = new Set(['is', 'sort', 'id']);
  const OPTION_FIELDS = Object.keys(FIELD_INFO).filter((k) => !PANEL_TAUGHT_ELSEWHERE.has(k)
    && !OPTION_FACETS.some((row) => row.options.some((opt) => opt.token.kind === k)));
  // One line per mode: what the field means there (Basic's words are literal,
  // Regex's text is one pattern, Advanced is the whole language).
  const SYNTAX_NOTES = {
    basic: [
      { text: 'every word must match' },
      { code: '"a phrase"', text: 'matches exactly' },
      { text: 'right-click a filter to exclude it' },
    ],
    regex: [
      { text: 'the field is one regular expression' },
      { code: '.', text: 'stays on one line' },
      { text: 'right-click a filter to exclude it' },
    ],
    advanced: [
      { code: '-word', text: 'excludes' },
      { code: '"a phrase"', text: 'exact' },
      { code: 'a OR b', text: 'either' },
      { code: '(a b)', text: 'groups' },
      { code: '/regex/', text: 'a pattern' },
    ],
  };
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
  // suggestQuery(text, caret, { groups, mode }) -> null, or { kind: 'key' | 'value',
  // replaceStart, replaceEnd, query (the typed key / value fragment), quoted,
  // suggestions: [{ text, label, hint, continuation }] }. Rules: nothing on an
  // empty box or an empty token; only with the caret at the END of a token
  // (editing inside a query stays native); a value that is already complete
  // (is:pinned, since:7d, num:3, an exact group) offers nothing more.
  // `continuation`: the row's text starts with what was typed, so the rest of
  // it can be painted as a ghost (ghostCompletion) or filled in
  // (uniqueCompletion). Only Advanced has keys to offer: Basic and Regex
  // fields are plain text, so they get nothing. A term may sit inside a
  // group ('(gro' offers group:), and after a term an 'o' offers OR.
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
    if (o.mode && normalizeMode(o.mode) !== 'advanced') return null;
    const whole = tokenAtCaret(text, caret);
    if (!whole) return null;
    // Group openers before the term are not part of it.
    const lead = /^(?:-?\()+/.exec(whole.text);
    const tok = lead ? { start: whole.start + lead[0].length, end: whole.end, text: whole.text.slice(lead[0].length) } : whole;
    if (!tok.text || tok.text === '-') return null;
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
        const byUse = compareGroupUse(o.groupWeights);
        names.sort((a, b) => (b.toLowerCase().startsWith(val) - a.toLowerCase().startsWith(val)) || byUse(a, b));
        for (const g of names) push(`${cm[1]}:${quoteToken(g)}`, '');
      } else if (key === 'is') {
        for (const v of IS_VALUES) if (!val || v.startsWith(val)) push(`${cm[1]}:${v}`, hintOf(v));
      } else if (key === 'since' || key === 'before') {
        for (const p of SINCE_PRESETS) if (!val || p.startsWith(val)) push(`${cm[1]}:${p}`, hintOf(p));
      } else if (key === 'num') {
        for (let n = 1; n <= 9; n++) if (!val || String(n).startsWith(val)) push(`${cm[1]}:${n}`, '');
      } else if (key === 'sort') {
        for (const v of ['new', 'best']) if (!val || v.startsWith(val)) push(`${cm[1]}:${v}`, hintOf(v));
      } else if (BOUND_FACETS.includes(key) && info.values) {
        // Comparators and a range, as examples to finish (a number may follow).
        for (const v of Object.keys(info.values)) if (!val || (v.startsWith(val) && v !== val)) push(`${cm[1]}:${v}`, hintOf(v));
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
      // OR between two terms: offered once a term stands before this one.
      if (!neg && (lower === 'o' || lower === 'or') && body !== 'OR' && /\S/.test(String(text || '').slice(0, tok.start))) push('OR', 'either side may match');
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
    if (/^-?(len|l|lines|ln|words|wd):/i.test(s.text)) return null; // a size is the user's own number
    const v = String(text || '');
    const next = v.slice(0, res.replaceStart) + s.text + v.slice(res.replaceEnd);
    return { text: next, selectionStart: res.replaceEnd, selectionEnd: res.replaceStart + s.text.length };
  }

  // ── invalid-token feedback (Forge validateQuery) ──
  // validateQuery(text, { mode, groups, caret }) -> [{ start, end, valueStart,
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
    return validateQuery(`${guess}:${rawValue}`, { groups: o.groups }).length ? undefined : `${guess}:`;
  }
  // The inverse a negated single-valued filter means (-since:7d = before:7d,
  // -len:>5 = len:<=5), or undefined where there is none to offer.
  const INVERSE_OP = { '>': '<=', '>=': '<', '<': '>=', '<=': '>' };
  function negatedFilterFix(field, value) {
    if (field === 'since') return `before:${quoteToken(value)}`;
    if (field === 'before') return `since:${quoteToken(value)}`;
    if (BOUND_FACETS.includes(field)) {
      const b = parseBound(value);
      return b && INVERSE_OP[b.op] ? `${field}:${INVERSE_OP[b.op]}${b.n}` : undefined;
    }
    return undefined;
  }
  // validateQuery(text, { mode, groups, caret }). The field's text in its
  // mode: Basic is plain words (nothing to flag), Regex one pattern (flagged
  // when broken), Advanced the whole language. A problem may carry `fix`
  // ({ start, end, text }: the one-click repair the hint offers) beside its
  // `didYouMean` label.
  function validateQuery(text, opts) {
    const o = opts || {};
    const s = String(text || '');
    const caret = o.caret == null ? null : o.caret;
    const mode = o.mode ? normalizeMode(o.mode) : 'advanced';
    if (mode === 'basic') return [];
    if (mode === 'regex') {
      const err = s.trim() ? regexError(s) : null;
      return err ? [{ start: 0, end: s.length, valueStart: 0, token: s, key: '', value: s, kind: 'invalid-regex', message: `Not a valid regular expression: ${err}.`, pending: caret === s.length }] : [];
    }
    // Every group path a group: value can name (Work/Clients also offers Work).
    const groupPaths = [...new Set((o.groups || []).flatMap((g) => normalizeTagName(g).split('/').filter(Boolean).map((_, i, a) => a.slice(0, i + 1).join('/'))))];
    const problems = [];
    const numsSeen = [];
    for (const tok of scanQuery(s)) {
      if (tok.t !== 'term') continue;
      const neg = tok.neg ? 1 : 0;
      const body = tok.text.slice(neg);
      const atCaret = caret != null && caret === tok.end;
      const base = { start: tok.start, end: tok.end, token: tok.text };
      if (tok.regex) {
        const err = regexError(tok.regex.pattern);
        if (err) problems.push({ ...base, valueStart: tok.regex.open, key: '', value: tok.regex.pattern, kind: 'invalid-regex', message: `Not a valid regular expression: ${err}.`, pending: atCaret });
        continue;
      }
      const m = body[0] !== '"' ? KEY_TOKEN_RE.exec(body) : null;
      const key = m ? m[1].toLowerCase() : '';
      const canon = PREFIX_ALIASES[key];
      // Searched as plain text, decided exactly as leafOf does: no key, no
      // value, a path or URL, a URL scheme, or a key too long to be a filter.
      if (!m || !m[2] || ((m[2][0] === '/' || m[2][0] === '\\') && !canon) || NON_FILTER_SCHEMES.has(key) || (!canon && !UNKNOWN_KEY_RE.test(key))) continue;
      const valueStart = tok.start + neg + m[1].length + 1;
      const value = m[2].replace(/^"|"$/g, '');
      if (!canon) {
        const near = nearKey(key, m[2], o);
        problems.push({ ...base, valueStart, key, value, kind: 'unknown-key', message: `${key}: is not a filter, so "${value}" is searched as text.`, didYouMean: near });
        continue;
      }
      const lower = value.toLowerCase();
      const bad = (message, options, didYouMean) => problems.push({ ...base, valueStart, key, value, kind: 'invalid-value', message, options, didYouMean });
      // A single-valued filter cannot be excluded: the hint offers the inverse.
      if (neg && (SINGLE_FIELDS.has(canon))) {
        const fix = negatedFilterFix(canon, value);
        problems.push({ ...base, valueStart: tok.start, key, value, kind: 'negated-filter', message: `${key}: cannot be excluded, so this filter is ignored.`, didYouMean: fix, fix: fix ? { start: tok.start, end: tok.end, text: fix } : undefined });
        continue;
      }
      if (canon === 'title' || canon === 'text') continue;
      if (canon === 'is') {
        if (!IS_VALUES.some((v) => v.startsWith(lower))) { const near = closestTo(lower, IS_VALUES); bad(`${key}:${value} is not a kind of clip.`, IS_VALUES, near ? `${key}:${near}` : undefined); }
      } else if (canon === 'num') {
        if (!/^[1-9]$/.test(lower)) bad(`${key}: takes a numpad slot from 1 to 9.`);
        else if (!neg) numsSeen.push(tok);
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
    // Two numpad keys side by side ask for a clip on both: it has one key.
    // Flagged only where both stand at the top level (an OR is fine); the fix
    // puts OR between them.
    if (numsSeen.length > 1) {
      const top = parseQuery(s);
      if (top.nums.length > 1) {
        const second = numsSeen[1];
        problems.push({ start: second.start, end: second.end, token: second.text, valueStart: second.start, key: 'num', value: second.text, kind: 'num-and',
          message: 'A clip sits on one numpad key, so these keys together find nothing.', didYouMean: `OR ${second.text}`, fix: { start: second.start, end: second.start, text: 'OR ' } });
      }
    }
    // Structure: an OR with nothing on one side, a group never closed. Both
    // are pending while the caret is still at their end.
    const syntax = parseQuery(s).syntax;
    for (const p of syntax) {
      const pending = caret != null && (p.kind === 'unclosed' ? caret === s.length : caret === p.end);
      const message = p.kind === 'unclosed' ? 'This group is never closed with ")".' : 'OR needs a term on each side.';
      problems.push({ start: p.start, end: p.end, token: s.slice(p.start, p.end), valueStart: p.start, key: '', value: '', kind: p.kind, message, pending });
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
  // The OR dimensions whose next value goes in with an OR (applyFacet's rule:
  // one value there, or an OR pill already): dim -> the check dim the census
  // holds open for that dimension's options ('any:group').
  function openDims(parsed) {
    const open = new Map();
    for (const dim of OR_DIMS) {
      if ((parsed.anyOf || []).some((g) => g.dim === dim)) { open.set(dim, `any:${dim}`); continue; }
      const n = dim === 'group' ? parsed.groups.length : dim === 'num' ? parsed.nums.length : parsed.is.filter((v) => TYPE_IS.has(v)).length;
      if (n === 1) open.set(dim, `any:${dim}`);
    }
    return open;
  }
  // Every top-level filter as a census / relaxation check: { dim, ok(doc, i),
  // label, tokens (applyFacet steps that remove it), time }. A lone value of
  // an open OR dimension is that dimension's check (its options would OR in).
  // A custom expression is one check, never relaxed (no tokens), and last, so
  // the failure cap usually stops before it is evaluated. hay: the lowercased
  // haystacks, by doc index (a custom expression may hold words).
  function facetChecks(parsed, now, hay) {
    const checks = [];
    const open = openDims(parsed);
    const anyDims = new Set((parsed.anyOf || []).map((g) => g.dim));
    const lone = (dim, own) => (open.has(dim) && !anyDims.has(dim) ? open.get(dim) : own);
    for (const g of parsed.groups) checks.push({ dim: lone('group', `group:${g}`), ok: (d) => docInGroup(d, g), label: `group:${quoteToken(g)}`, tokens: [[{ kind: 'group', value: g }, 'include']] });
    for (const g of parsed.negGroups) checks.push({ dim: `-group:${g}`, ok: (d) => !docInGroup(d, g), label: `-group:${quoteToken(g)}`, tokens: [[{ kind: 'group', value: g }, 'exclude']] });
    for (const v of parsed.is) checks.push({ dim: TYPE_IS.has(v) ? lone('type', `is:${v}`) : `is:${v}`, ok: (d) => docIsFast(d, v), label: `is:${v}`, tokens: [[{ kind: 'is', value: v }, 'include']] });
    for (const v of parsed.negIs) checks.push({ dim: `-is:${v}`, ok: (d) => !docIsFast(d, v), label: `-is:${v}`, tokens: [[{ kind: 'is', value: v }, 'exclude']] });
    for (const n of parsed.nums) checks.push({ dim: lone('num', `num:${n}`), ok: (d) => d.numpad === n, label: `num:${n}`, tokens: [[{ kind: 'num', value: n }, 'include']] });
    for (const n of parsed.negNums) checks.push({ dim: `-num:${n}`, ok: (d) => d.numpad !== n, label: `-num:${n}`, tokens: [[{ kind: 'num', value: n }, 'exclude']] });
    for (const g of parsed.anyOf || []) {
      checks.push({ dim: `any:${g.dim}`, ok: (d) => g.values.some((v) => (g.field === 'is' ? docIsFast(d, v) : facetValueOk(d, g.field, v))), label: anyOfText(g), tokens: g.values.map((v) => [{ kind: g.field, value: v }, 'include']) });
    }
    for (const k of ['since', 'before']) {
      if (parsed[k] == null) continue;
      const b = resolveTimeMs(parsed[k], now);
      if (b != null) checks.push({ dim: k, ok: k === 'since' ? (d) => d.ts * 1000 >= b : (d) => d.ts * 1000 <= b, label: `${k}:${quoteToken(parsed[k])}`, time: true, tokens: [[{ kind: k, value: parsed[k] }, 'include']] });
    }
    for (const k of BOUND_FACETS) if (parsed[k]) { const bound = parsed[k]; checks.push({ dim: k, ok: (d) => docBoundOk(d, k, bound), label: `${k}:${serializeBound(bound)}`, tokens: [[{ kind: k, value: serializeBound(bound) }, 'include']] }); }
    if (parsed.id) { const id = String(parsed.id).toLowerCase(); checks.push({ dim: 'id', ok: (d) => d.id.toLowerCase().includes(id), label: `id:${quoteToken(parsed.id)}`, tokens: [[{ kind: 'id', value: parsed.id }, 'include']] }); }
    (parsed.compound || []).forEach((node, n) => checks.push({ dim: `compound:${n}`, ok: (d, i) => evalNode(node, d, hay && hay[i] != null ? hay[i] : docSearchText(d).toLowerCase(), now) }));
    return checks;
  }
  function facetFailures(doc, checks, out, i) {
    out.length = 0;
    for (let k = 0; k < checks.length; k += 1) {
      if (checks[k].ok(doc, i)) continue;
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
  // The dim an option belongs to under this query (null = none held open):
  // an excluded value its own, a value of an open OR dimension that
  // dimension's (selecting it would OR it in), a selected value its own.
  function optionDim(parsed, token) {
    const k = token.kind;
    if (SINGLE_FACETS.includes(k)) return k;
    const { field, value } = tokenFieldValue(token);
    const neg = field === 'group' ? parsed.negGroups : field === 'num' ? parsed.negNums : parsed.negIs;
    if (neg.includes(value)) return `-${field}:${value}`;
    const open = openDims(parsed);
    const dim = facetDim(field, value);
    if (open.has(dim)) return open.get(dim);
    const pos = field === 'group' ? parsed.groups : field === 'num' ? parsed.nums : parsed.is;
    return pos.includes(value) ? `${field}:${value}` : null;
  }
  // facetCensus(docs, parsed, { now, groups, searchTextLower }) -> { permissive, total,
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
    const checks = facetChecks(parsed, now, o.searchTextLower);
    const failed = [];
    const seen = new Set();
    for (let i = 0; i < list.length; i += 1) {
      const doc = list[i];
      if (!doc) continue;
      facetFailures(doc, checks, failed, i);
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
      groupWeights: groupWeights(list, now),
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
    // A value a custom expression names (a OR b): a click could not change it there.
    const custom = customFacetKeys(parsed);
    if (custom && (custom.has(key) || (SINGLE_FACETS.includes(token.kind) && custom.has(`${token.kind}:`)))) return { enabled: false, kind: 'structural', reason: 'Part of a custom filter in the search: change it there', count: 0 };
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
  function bestRelaxation(docs, query, opts) {
    const o = opts || {};
    const parsed = typeof query === 'string' ? parseQuery(query) : query;
    const now = o.now || Date.now();
    const list = docs || [];
    const hay = o.searchTextLower || null;
    const checks = facetChecks(parsed, now, hay);
    const dims = checks.filter((c) => c.tokens);
    if (!dims.length) return null;
    const matchers = compileContent(parsed);
    const contentOnly = { ...emptyParsed(''), content: parsed.content };
    const matchOpts = { now, searchText: undefined, matchers };
    const failed = [];
    const counts = new Map();
    // o.cache (caller-owned, one per list): typing more of the same words only
    // re-tests the clips that counted last time (filterRankIndexes' refine
    // rule), so a nudge shown while typing does not rescan the whole history.
    const cache = o.cache || null;
    const state = cache ? refineState(parsed) : null;
    const prev = cache && cache.docs === list && cache.hay === hay ? cache.state : null;
    const candidates = prev && canRefine(prev, state) ? cache.matched : null;
    const matched = cache ? [] : null;
    const total = candidates ? candidates.length : list.length;
    for (let k = 0; k < total; k += 1) {
      const i = candidates ? candidates[k] : k;
      const doc = list[i];
      if (!doc) continue;
      facetFailures(doc, checks, failed, i);
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

  // ── search modes: the field's view of the ONE canonical query ──
  // The query text is always Advanced syntax (what search, chips, the census
  // and AI tools read). Basic and Regex show it as the field's text plus
  // pills: splitQuery(query, mode) -> { text, words, pills, dropped };
  // composeQuery(mode, text, pills) -> the query again. Basic text = the
  // literal words (a phrase keeps its quotes); Regex text = the first /regex/
  // term, else the words read as one pattern. Pills hold everything else: a
  // filter, an excluded word, a scoped term, another /regex/. The values of
  // one OR dimension are ONE pill with a connective: { conn: 'or' } for
  // group:A OR group:B, 'and' for group:A group:B, none for a single value.
  // dropped: the custom expressions a pill cannot show (a OR b, -(a b)): a
  // switch out of Advanced removes them (switchModeQuery says which).
  // pill: { key, kind: 'facet' | 'token', field?, dim?, conn?, neg?,
  //         values?: [{ value, text }], text (its query tokens) }.
  function basicWordsOf(text) {
    const out = [];
    let cur = '';
    let phrase = false;
    let inQuote = false;
    const s = String(text || '');
    const flush = () => { if (cur) out.push({ value: cur, phrase }); cur = ''; phrase = false; };
    for (const ch of s) {
      if (ch === '"') { inQuote = !inQuote; phrase = true; continue; }
      if (!inQuote && isSpace(ch)) { flush(); continue; }
      cur += ch;
    }
    flush();
    return out;
  }
  // Would Advanced read this bare word as exactly itself (a literal term)?
  function literalInAdvanced(word) {
    const p = parseQuery(word);
    const c = p.content[0];
    return p.items.length === 1 && p.content.length === 1 && !c.neg && !c.regex && c.scope === 'any' && c.value === word && !p.unknown.length && !p.syntax.length;
  }
  // Basic text -> query text: every word literal, quoted where Advanced would
  // read it as syntax (-x, key:val, OR, (x), /x/).
  function basicToQuery(text) {
    return basicWordsOf(text).map((w) => (w.phrase || !literalInAdvanced(w.value) ? `"${w.value}"` : w.value)).join(' ');
  }
  // Regex text -> query text: /pattern/, its unescaped slashes escaped.
  function regexToQuery(text) {
    const s = String(text || '');
    if (!s.trim()) return '';
    let out = '';
    for (let i = 0; i < s.length; i += 1) {
      if (s[i] === '\\') { out += s.slice(i, i + 2); i += 1; continue; }
      out += s[i] === '/' ? '\\/' : s[i];
    }
    return `/${out}/`;
  }
  function regexText(pattern) { return String(pattern || '').replace(/\\\//g, '/'); }
  function splitQuery(query, mode) {
    const m = normalizeMode(mode);
    const q = String(query == null ? '' : query);
    if (m === 'advanced') return { text: q, words: [], pills: [], dropped: [] };
    const p = parseQuery(q);
    const words = [];
    const pills = [];
    const dropped = [];
    const dims = new Map();
    let regexTerm = null;
    if (m === 'regex') {
      const first = p.items.find((it) => it.kind === 'leaf' && it.leaf.field === 'content' && it.leaf.regex && !it.leaf.neg && it.leaf.scope === 'any');
      if (first) regexTerm = first;
    }
    const tokenPill = (it) => pills.push({ key: `t${pills.length}:${it.text}`, kind: 'token', neg: !!it.leaf.neg, field: it.leaf.field, text: it.text });
    for (const it of p.items) {
      if (it.kind === 'compound') { dropped.push({ text: q.slice(it.start, it.end) }); continue; }
      if (it.kind === 'any') {
        pills.push({ key: `any:${it.any.dim}`, kind: 'facet', field: it.any.field, dim: it.any.dim, conn: 'or', values: it.any.members.map((x) => ({ value: x.value, text: x.text })), text: it.any.members.map((x) => x.text).join(' OR ') });
        continue;
      }
      const l = it.leaf;
      if (it === regexTerm) continue;
      if (l.field === 'content' && !l.neg && l.scope === 'any' && !l.regex && !regexTerm) { words.push({ value: l.value, phrase: /\s/.test(l.value) }); continue; }
      const dim = !l.neg ? facetDim(l.field, l.value) : null;
      if (dim && OR_DIMS.has(dim)) {
        let pill = dims.get(dim);
        if (!pill) { pill = { key: `dim:${dim}`, kind: 'facet', field: l.field, dim, conn: null, values: [], text: '' }; dims.set(dim, pill); pills.push(pill); }
        pill.values.push({ value: l.value, text: it.text });
        pill.conn = pill.values.length > 1 ? 'and' : null;
        pill.text = pill.values.map((x) => x.text).join(' ');
        continue;
      }
      tokenPill(it);
    }
    const text = regexTerm ? regexText(regexTerm.leaf.value)
      : m === 'regex' ? words.map((w) => w.value).join(' ')
        : words.map((w) => (w.phrase ? `"${w.value}"` : w.value)).join(' ');
    return { text, words, pills, dropped };
  }
  function composeQuery(mode, text, pills) {
    const m = normalizeMode(mode);
    const head = m === 'regex' ? regexToQuery(text) : m === 'basic' ? basicToQuery(text) : String(text || '').trim();
    return [head, ...(pills || []).map((p) => p.text)].filter((x) => x && x.trim()).join(' ');
  }
  // Switching the field from one mode to another: { query, text, pills,
  // dropped }. Into Advanced the query is shown as it is (Basic words already
  // quoted where they look like syntax, a Regex already /.../), so the switch
  // teaches the format. Out of Advanced every filter and extra term becomes a
  // pill; a custom expression cannot, so it is dropped (and listed: the caller
  // warns first and offers Undo). Between Basic and Regex the text stays as
  // typed, read the other way. viewText: what the field shows now.
  function switchModeQuery(query, from, to, viewText) {
    const a = normalizeMode(from);
    const b = normalizeMode(to);
    const q = String(query == null ? '' : query);
    if (a === b || b === 'advanced') return { query: q, text: q, pills: [], dropped: [] };
    if (a === 'advanced') {
      const v = splitQuery(q, b);
      return { query: composeQuery(b, v.text, v.pills), text: v.text, pills: v.pills, dropped: v.dropped };
    }
    const text = viewText == null ? splitQuery(q, a).text : String(viewText);
    const pills = splitQuery(q, a).pills;
    return { query: composeQuery(b, text, pills), text, pills, dropped: [] };
  }
  // What a switch to `mode` would remove (the mode menu names it first).
  function modeSwitchLoss(query, from, to) {
    return normalizeMode(from) === 'advanced' && normalizeMode(to) !== 'advanced' ? splitQuery(query, to).dropped : [];
  }
  // The old regex flag (an AI tool's regex: true, a saved regex toggle): the
  // query's free text, read as ONE regex.
  function legacyRegexQuery(query) {
    const v = splitQuery(query, 'basic');
    return composeQuery('regex', v.words.map((w) => w.value).join(' '), v.pills);
  }
  // A pill's or/and connective, flipped: the query with that pill's tokens
  // rewritten (group:A OR group:B <-> group:A group:B).
  function setPillConnective(query, mode, pill, conn) {
    const v = splitQuery(query, mode);
    const at = v.pills.findIndex((x) => x.key === pill.key);
    if (at < 0 || !pill.values || pill.values.length < 2) return String(query || '');
    const sep = conn === 'and' ? ' ' : ' OR ';
    const pills = v.pills.map((x, i) => (i === at ? { ...x, conn, text: x.values.map((y) => y.text).join(sep) } : x));
    return composeQuery(mode, v.text, pills);
  }
  // The query without one pill.
  function removePill(query, mode, pill) {
    const v = splitQuery(query, mode);
    return composeQuery(mode, v.text, v.pills.filter((x) => x.key !== pill.key));
  }

  // ── paste: a multi-word plain-text snippet searches as ONE phrase (Forge
  // quotePastedText). null = paste it as it is: one word, or text that is
  // query syntax (a recognised filter or a field-scoped term), or text whose
  // words are not split by single spaces: a phrase is a plain substring test, so
  // a line break, a tab or a double space inside it would stop it matching the
  // very clip it was copied from (pasted raw, its words are AND-ed instead).
  // In Basic nothing is syntax, so only the spacing rule applies.
  function quotePastedText(text, mode) {
    const collapsed = String(text || '').trim();
    if (!/\s/.test(collapsed) || /[^ \S]| {2}/.test(collapsed)) return null;
    if (normalizeMode(mode || 'advanced') === 'basic') return `"${collapsed.replace(/"/g, '')}"`;
    const p = parseQuery(collapsed);
    if (anyFilterActive(p) || p.sort || p.compound.length || p.content.some((c) => c.scope !== 'any' || c.regex || c.neg)) return null;
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
    tokenizeQuery, quoteToken, parseQuery, scanQuery, serializeQuery, applyFacet, stripFacet, clearFacet, addToken, facetState, facetTokenState,
    anyFilterActive, hasSearchTerms, isEmptyQuery, resolveTimeMs,
    matchDoc, relevanceScore, recencyScore, decayWeight, groupWeights, compareGroupUse, rankMode, filterRankIndexes, bodyIndexOf,
    compileTerm, escapeRegExp, termSpans, firstMatchIndex,
    SEARCH_MODES, normalizeMode, splitQuery, composeQuery, switchModeQuery, modeSwitchLoss, legacyRegexQuery,
    setPillConnective, removePill, promptOptionState, promptOptionLabel, promptQuery, FIELD_ASK,
    fuzzyMatch, fuzzyFloor,
    lexQuery, suggestQuery,
    BUILTIN_TO_IS, IS_TO_BUILTIN, IS_VALUES, RECOGNIZED_PREFIXES, NON_FILTER_SCHEMES,
    PREFIX_HINTS, OPTION_FACETS, OPTION_FIELDS, SYNTAX_NOTES, facetTokenText, optionFacetsActive,
    FIELD_INFO, facetKey, applySuggestion, ghostCompletion, uniqueCompletion,
    validateQuery, describeProblem, problemRanges, levenshtein,
    facetCensus, facetOptionVerdict, structuralReason, censusKey, FAILURE_CAP,
    bestRelaxation, quotePastedText, insideQuote,
  };
});
