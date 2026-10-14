'use strict';

// Pure context-shaping for the MCP server.
//
// Given the raw clipboard history + settings (read from the JSON files by the
// helper, or held in memory by the app), this builds exactly what an AI
// assistant is allowed to see, applying one filter:
//
//   Allowlist by curation - only clips in a group the user shared with AI
//   ("groups_shared_with_ai", which always includes the auto "AI" group)
//   expose their content. Everything else is metadata only. Sharing is fully
//   opt-in per group, so a clip the user put in a shared group is shared as-is.
//
// No I/O here: text-blob hydration and image bytes are the caller's job. This
// keeps the module pure + unit-testable and lets both the helper (file-backed)
// and the app (memory-backed) reuse the identical boundary.

const crypto = require('crypto');
const model = require('./clipboard-model');
const search = require('../site/shared/clip-search');

// The AI group is spelled exactly the model's AI tag (always shared with AI).
const AI_GROUP_NAME = model.AI_TAG_NAME;
const DEFAULT_PREVIEW_CHARS = 280;
const DEFAULT_LIST_LIMIT = 50;

// Groups are case-insensitive (search.tagKey), so the set answers has() for a
// group name in any spelling.
function sharedGroupSet(settings) {
  const configured = settings && Array.isArray(settings.groups_shared_with_ai)
    ? settings.groups_shared_with_ai
    : [];
  const keys = new Set(configured.map(search.tagKey).filter(Boolean));
  // The auto "AI" group is the quick drop-bucket and is always shared.
  keys.add(search.tagKey(AI_GROUP_NAME));
  return { has: (name) => keys.has(search.tagKey(name)), keys, size: keys.size };
}

// ---- Ids and revs at the boundary ----
// A clip's real id is a content hash (txt:sha256 of its text) and its real rev
// hashes every group it is in, so handing either out raw lets an AI confirm a
// guessed text, or a guessed set of private group names, offline. What crosses
// the boundary is keyed with this install's own secret (settings.mcp_secret:
// local, never synced), so the helper (from the files) and the app (from
// memory) compute the same values and nobody without the secret can:
//   rev - publicRev: an HMAC of the real rev. It still moves with any change to
//         the text, title, pin, groups or numpad slot, so the app refuses a stale
//         write, but it says nothing about what it covers.
//   id  - publicId: a clip the AI can read keeps its real id; any other clip gets
//         an opaque handle (OPAQUE_ID_PREFIX + an HMAC of its id) that the app
//         resolves back. A real id names only a clip the AI can read, so a
//         guessed content hash finds nothing.
const OPAQUE_ID_PREFIX = 'private:';
// No secret yet (the app never enabled AI access): ids and revs are still keyed,
// stable for this process. Nothing can forward to the app then anyway.
const PROCESS_KEY = crypto.randomBytes(32).toString('hex');

function boundaryKey(settings) {
  const secret = settings && settings.mcp_secret;
  return typeof secret === 'string' && secret ? secret : PROCESS_KEY;
}

// The settings with the boundary key filled in, for a copy that crosses to
// another thread (a search worker would otherwise make up its own key).
function withBoundaryKey(settings) {
  const s = settings || {};
  return typeof s.mcp_secret === 'string' && s.mcp_secret ? s : { ...s, mcp_secret: boundaryKey(s) };
}

function keyedHash(settings, label, value) {
  return crypto.createHmac('sha256', boundaryKey(settings)).update(`${label}\0${value}`).digest('hex');
}

function publicRev(item, settings) {
  return item ? keyedHash(settings, 'rev', model.clipRevision(item)).slice(0, 16) : null;
}

// One HMAC per clip per key (a lookup by handle walks the whole history).
let opaqueCache = { key: null, map: new Map() };
function opaqueId(realId, settings) {
  const key = boundaryKey(settings);
  if (opaqueCache.key !== key || opaqueCache.map.size > 100000) opaqueCache = { key, map: new Map() };
  const id = String(realId);
  let value = opaqueCache.map.get(id);
  if (!value) {
    value = OPAQUE_ID_PREFIX + keyedHash(settings, 'id', id).slice(0, 32);
    opaqueCache.map.set(id, value);
  }
  return value;
}

function isOpaqueId(id) {
  return typeof id === 'string' && id.startsWith(OPAQUE_ID_PREFIX);
}

function publicId(item, settings, sharedSet = sharedGroupSet(settings)) {
  const id = model.itemKey(item);
  return isShared(item, sharedSet) ? id : opaqueId(id, settings);
}

// The clip an AI's id names: { item, realId, movedTo }.
//  - An opaque handle names the clip it was handed out for, also after that clip
//    became shared; one the clip was edited away from gives item null and, in
//    movedTo, the public id of the clip it became.
//  - A real id names only a clip the AI can read: a non-shared clip's content
//    hash answers exactly like an id that does not exist. One edited away gives
//    movedTo only when the clip it became is shared.
function resolvePublicId(history, settings, id) {
  const items = Array.isArray(history) ? history : [];
  const value = String(id == null ? '' : id).trim();
  const none = { item: null, realId: null, movedTo: null };
  if (!value) return none;
  const sharedSet = sharedGroupSet(settings);
  const moved = (realId, opaque) => {
    const currentId = model.supersedeMap(settings && settings.supersedes).get(realId);
    const current = currentId && currentId !== realId ? items.find(i => model.itemKey(i) === currentId) : null;
    if (!current || (!opaque && !isShared(current, sharedSet))) return none;
    return { item: null, realId, movedTo: publicId(current, settings, sharedSet) };
  };
  if (isOpaqueId(value)) {
    for (const item of items) {
      const realId = model.itemKey(item);
      if (opaqueId(realId, settings) === value) return { item, realId, movedTo: null };
    }
    for (const record of Array.isArray(settings && settings.supersedes) ? settings.supersedes : []) {
      if (record && record.from && opaqueId(String(record.from), settings) === value) return moved(String(record.from), true);
    }
    return none;
  }
  const item = items.find(i => model.itemKey(i) === value) || null;
  if (item) return isShared(item, sharedSet) ? { item, realId: value, movedTo: null } : none;
  return moved(value, false);
}

// A clip carries a format when the value is inline OR externalized to a blob.
// Checked without loading the blob: this is availability, not content.
function hasRichPayload(item, field) {
  if (!item || item.type === 'image') return false;
  const names = model.blobFieldNames(field);
  return !!(item[names.value] || item[names.ref] || item[names.hash]);
}

function isShared(item, sharedSet) {
  const groups = model.groupsOf(item);
  for (const g of groups) if (sharedSet.has(g)) return true;
  return false;
}

function previewText(item, chars) {
  const raw = item && item.type !== 'image'
    ? String(item.text != null && item.text !== '' ? item.text : (item.textPreview || ''))
    : '';
  if (raw.length <= chars) return raw;
  return `${raw.slice(0, chars)}…`;
}

// The group names a clip shows an AI: only the SHARED ones (never a private group
// a shared clip is also in), all of them after an approved all-scope search.
function visibleGroups(item, sharedSet, forceAll = false) {
  const groups = model.groupsOf(item);
  return forceAll ? groups : groups.filter(g => sharedSet.has(g));
}

// The groups an AI tool names in one go (a group param): the app's own reading.
function namedTags(input, settings) {
  return model.tagInputNames(String(input == null ? '' : input), settings || {});
}

// ---- The AI's group tools ----
// What the AI typed, one entry per name it typed, with the stored groups each
// one means (a retired nested name means its parts; an existing group, in any
// case, its stored spelling). An existing group whose name holds a comma is
// named in full, as model.tagInputNames reads it.
function namedGroupTokens(input, settings) {
  const text = String(input == null ? '' : input);
  const groups = Array.isArray(settings && settings.groups) ? settings.groups : [];
  const typed = groups.some(g => search.sameTag(g, text)) ? [search.cleanTagName(text)] : search.splitTagInput(text);
  return typed.map(token => ({ typed: token, names: namedTags(token, settings) }));
}

// What a group tool may say back about the groups it was given: the stored names
// of those shared with AI (it sees them on clips and in list_context anyway) and,
// in notShared, every other name only as it was typed. Nothing in it says whether
// such a group existed, or was on the clip. `lists` maps a result field to the
// stored names it holds (e.g. { added, removed }).
function groupToolView(tokens, settings, lists = {}) {
  const sharedSet = sharedGroupSet(settings);
  const view = {};
  for (const [field, names] of Object.entries(lists)) view[field] = (Array.isArray(names) ? names : []).filter(n => sharedSet.has(n));
  const notShared = (Array.isArray(tokens) ? tokens : [])
    .filter(t => !t.names.length || t.names.some(n => !sharedSet.has(n)))
    .map(t => t.typed);
  if (notShared.length) view.notShared = notShared;
  return view;
}

// Shape a single clip for AI consumption. `forcePreview` is set only on the
// post-approval ('all') path, where the user has explicitly approved reading
// beyond the allowlist - it surfaces the preview even for a non-shared clip.
function clipView(item, { settings = {}, sharedSet = sharedGroupSet(settings), previewChars = DEFAULT_PREVIEW_CHARS, forcePreview = false } = {}) {
  const shared = isShared(item, sharedSet);
  const base = {
    id: publicId(item, settings, sharedSet),
    type: item.type === 'image' ? 'image' : 'text',
    ts: item.ts || 0,
    pinned: model.isPinned(item),
    numpad: model.numpadSlotOf(item),
    rev: publicRev(item, settings),
    shared,
  };
  if (!shared && !forcePreview) {
    // Metadata only: no content, no group names, no preview.
    return base;
  }
  if (!shared && forcePreview) base.viaApproval = true;
  // Only expose the SHARED group names a clip belongs to - never the names of
  // any private/non-shared groups it is also a member of.
  base.groups = visibleGroups(item, sharedSet);
  if (item.type === 'image') {
    base.image = item.image || null;
    if (item.width) base.width = item.width;
    if (item.height) base.height = item.height;
    return base;
  }
  const title = model.titleOf(item);
  if (title) base.title = title;
  base.preview = previewText(item, previewChars);
  // Advertise that formatting exists WITHOUT shipping it. The raw HTML/RTF is
  // large and low-value to a model, but knowing a clip is rich is useful.
  if (hasRichPayload(item, 'html')) base.has_html = true;
  if (hasRichPayload(item, 'rtf')) base.has_rtf = true;
  return base;
}

// The full-text read result shape, shared by the helper's get_clip fast-path and
// the app's approval-gated read_clip so both stay identical. Group names are
// filtered to shared-only, matching clipView's policy.
function fullTextResult(item, { settings = {}, sharedSet = sharedGroupSet(settings) } = {}) {
  const result = {
    id: publicId(item, settings, sharedSet),
    rev: publicRev(item, settings),
    type: 'text',
    text: String(item.text || ''),
    groups: visibleGroups(item, sharedSet),
    ts: item.ts || 0,
  };
  const title = model.titleOf(item);
  if (title) result.title = title;
  return result;
}

// Summary of the user's organisation - the "clipboard / workflows" context.
function buildContext(history, settings) {
  const items = Array.isArray(history) ? history : [];
  const sharedSet = sharedGroupSet(settings);
  const groupNames = Array.isArray(settings && settings.groups) ? settings.groups : [];
  const counts = new Map();
  const numpad = {};
  let pinnedCount = 0;
  let sharedCount = 0;

  for (const item of items) {
    if (model.isPinned(item)) pinnedCount++;
    const slot = model.numpadSlotOf(item);
    if (slot != null) numpad[slot] = { id: publicId(item, settings, sharedSet), type: item.type === 'image' ? 'image' : 'text' };
    for (const g of model.groupsOf(item)) counts.set(search.tagKey(g), (counts.get(search.tagKey(g)) || 0) + 1);
    if (isShared(item, sharedSet)) sharedCount++;
  }

  // Only the SHARED groups, and no count of the others: the group tools are free for
  // any name, so a count that moved (or did not) after create_group would tell the AI
  // whether a private group of that name existed.
  const groups = groupNames
    .filter(name => sharedSet.has(name))
    .map(name => ({ name, shared: true, count: counts.get(search.tagKey(name)) || 0 }));

  return {
    totalClips: items.length,
    sharedClips: sharedCount,
    pinnedClips: pinnedCount,
    groups,
    numpadSlots: numpad,
    aiGroup: AI_GROUP_NAME,
  };
}

// List clips. By default returns shared clips with previews (most recent first);
// pass includeNonShared to also append metadata-only entries for the rest.
// `group` keeps the clips in EVERY group it names ("todo, forge"), matched only
// against the groups shared with AI, so naming a private group finds nothing.
function listClips(history, settings, {
  limit = DEFAULT_LIST_LIMIT,
  previewChars = DEFAULT_PREVIEW_CHARS,
  group = null,
  includeNonShared = false,
} = {}) {
  const items = Array.isArray(history) ? history : [];
  const sharedSet = sharedGroupSet(settings);
  const wanted = group ? namedTags(group, settings) : [];
  const out = [];
  let nonSharedTotal = 0;

  for (const item of items) {
    const shared = isShared(item, sharedSet);
    if (!shared) {
      nonSharedTotal++;
      if (!includeNonShared) continue;
    }
    if (wanted.length) {
      const tags = visibleGroups(item, sharedSet);
      if (!wanted.every(name => tags.some(g => search.sameTag(g, name)))) continue;
    }
    out.push(clipView(item, { settings, sharedSet, previewChars }));
    if (out.length >= limit) break;
  }
  return { clips: out, nonSharedTotal, returned: out.length };
}

// A boundary-aware search doc: the SAME normalized shape the shared engine ranks/filters,
// with the clip's public id and its SHARED group names (all of them after an approved
// all-scope search, the only time a non-shared clip is searched at all).
function clipToSearchDoc(item, { settings = {}, sharedSet = sharedGroupSet(settings), forceAll = false } = {}) {
  const isImage = item && item.type === 'image';
  const body = isImage ? String(item && item.image || '') : String(item && (item.text != null ? item.text : item.textPreview) || '');
  return {
    id: publicId(item, settings, sharedSet),
    type: isImage ? 'image' : 'text',
    title: model.titleOf(item),
    body,
    groups: visibleGroups(item, sharedSet, forceAll),
    numpad: model.numpadSlotOf(item),
    pinned: model.isPinned(item),
    ts: Number(item && item.ts) || 0,
    len: isImage ? 0 : body.length,
    lines: isImage || !body ? 0 : body.split(/\r\n|\r|\n/).length,
    words: isImage || !body.trim() ? 0 : body.trim().split(/\s+/).length,
    url: !isImage && /^(?:[a-z][a-z0-9+.-]*:\/\/|www\.)[^\s]+$|^[a-z0-9-]+(?:\.[a-z0-9-]+)+(?:\/[^\s]*)?$/i.test(body.trim()),
    rich: !isImage && !!(item.html || item.htmlRef || item.htmlHash || item.rtf || item.rtfRef || item.rtfHash),
  };
}

// The retired nested names an AI's query is rewritten through: only those whose
// parts are all shared with AI. Any other reads as an unknown name, exactly as a
// guess at a private one must (whether a name was a private group's is not the
// AI's to learn).
function visibleSplitMap(settings, sharedSet = sharedGroupSet(settings)) {
  const out = new Map();
  for (const [key, parts] of model.splitMapOf(settings || {})) {
    if (parts.length && parts.every(part => sharedSet.has(part))) out.set(key, parts);
  }
  return out;
}

function notSearchedHint(count) {
  return `${count} ${count === 1 ? 'clip is' : 'clips are'} not shared with AI and ${count === 1 ? 'was' : 'were'} not searched. To search them too, call search_clips again with include_unshared: true (the user is asked first).`;
}

// Search. Delegates parsing + matching to the SHARED engine (site/shared/clip-search)
// so the MCP tool understands the SAME language as the app's search field:
// `title:`, `group:`, `is:pinned`, `since:7d`, `-word`, `/regex/`, `a OR b`, `( )`.
// Plain words are literal. The old `regex: true` flag still works: the query's free
// text is read as ONE regex (search.legacyRegexQuery). A retired nested name of
// shared groups (group:todo/forge) is searched as its parts (group:todo group:forge)
// and the result carries that `rewrittenQuery`, so the caller learns the flat form.
//
// The default scope searches ONLY the clips shared with AI: a non-shared clip never
// influences a free answer (a match count over private text would read it out, one
// /regex/ at a time). The result says instead how many clips were not searched
// (nonSharedTotal, the same for every query) with a hint to pass include_unshared,
// which the app runs as scope 'all' after the user approves.
function searchClips(history, settings, {
  query,
  regex = false,
  limit = DEFAULT_LIST_LIMIT,
  previewChars = DEFAULT_PREVIEW_CHARS,
  scope = 'shared',
  now,
} = {}) {
  const items = Array.isArray(history) ? history : [];
  const sharedSet = sharedGroupSet(settings);
  const all = scope === 'all';
  const flat = search.flattenRetiredGroupTokens(query, visibleSplitMap(settings, sharedSet));
  const parsed = search.parseQuery(regex ? search.legacyRegexQuery(flat.query) : flat.query);
  const matches = [];
  let nonSharedTotal = 0;

  for (const item of items) {
    const shared = isShared(item, sharedSet);
    if (!shared && !all) { nonSharedTotal++; continue; }
    if (matches.length >= limit) continue;
    const doc = clipToSearchDoc(item, { settings, sharedSet, forceAll: all });
    if (!search.matchDoc(doc, parsed, { now })) continue;
    // A non-shared match exists only in the approved all scope: shaped as a real
    // preview so the assistant can read it.
    matches.push(clipView(item, { settings, sharedSet, previewChars, forcePreview: !shared }));
  }
  const result = { matches, returned: matches.length };
  if (!all) {
    result.nonSharedTotal = nonSharedTotal;
    if (nonSharedTotal) result.hint = notSearchedHint(nonSharedTotal);
  }
  if (flat.rewritten) result.rewrittenQuery = flat.query;
  return result;
}

// Resolve a single clip id (a public id, see resolvePublicId) for a full-text read.
// Returns the decision; the caller hydrates the text only when allowed. `reason` is
// one of: 'ok' | 'not_found' | 'not_shared'. A not_found id the clip was edited
// away from carries `movedTo`.
function resolveForRead(history, settings, id) {
  const found = resolvePublicId(history, settings, id);
  if (!found.item) return { reason: 'not_found', item: null, shared: false, movedTo: found.movedTo };
  const shared = isShared(found.item, sharedGroupSet(settings));
  return { reason: shared ? 'ok' : 'not_shared', item: found.item, shared, movedTo: null };
}

module.exports = {
  AI_GROUP_NAME,
  DEFAULT_PREVIEW_CHARS,
  DEFAULT_LIST_LIMIT,
  OPAQUE_ID_PREFIX,
  sharedGroupSet,
  isShared,
  visibleGroups,
  namedTags,
  namedGroupTokens,
  groupToolView,
  withBoundaryKey,
  publicRev,
  publicId,
  isOpaqueId,
  resolvePublicId,
  visibleSplitMap,
  previewText,
  clipView,
  fullTextResult,
  buildContext,
  listClips,
  searchClips,
  resolveForRead,
};
