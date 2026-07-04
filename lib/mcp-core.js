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

const model = require('./clipboard-model');

const AI_GROUP_NAME = 'AI';
const DEFAULT_PREVIEW_CHARS = 280;
const DEFAULT_LIST_LIMIT = 50;

function sharedGroupSet(settings) {
  const configured = settings && Array.isArray(settings.groups_shared_with_ai)
    ? settings.groups_shared_with_ai
    : [];
  const set = new Set(configured);
  // The auto "AI" group is the quick drop-bucket and is always shared.
  set.add(AI_GROUP_NAME);
  return set;
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

function searchableText(item, { sharedSet = null, forceAll = false } = {}) {
  const shared = sharedSet ? isShared(item, sharedSet) : false;
  const includeTitle = forceAll || shared;
  return [
    includeTitle ? model.titleOf(item) : '',
    item && item.type === 'image' ? (item.image || '') : (item && item.text != null ? item.text : item && item.textPreview || ''),
    item && item.type || '',
    ...(includeTitle ? model.groupsOf(item) : []),
  ].filter(Boolean).join(' ');
}

// Shape a single clip for AI consumption. `forcePreview` is set only on the
// post-approval ('all') path, where the user has explicitly approved reading
// beyond the allowlist - it surfaces the preview even for a non-shared clip.
function clipView(item, { sharedSet, previewChars = DEFAULT_PREVIEW_CHARS, forcePreview = false } = {}) {
  const id = model.itemKey(item);
  const shared = isShared(item, sharedSet);
  const base = {
    id,
    type: item.type === 'image' ? 'image' : 'text',
    ts: item.ts || 0,
    pinned: model.isPinned(item),
    numpad: model.numpadSlotOf(item),
    shared,
  };
  if (!shared && !forcePreview) {
    // Metadata only: no content, no group names, no preview.
    return base;
  }
  if (!shared && forcePreview) base.viaApproval = true;
  // Only expose the SHARED group names a clip belongs to - never the names of
  // any private/non-shared groups it is also a member of.
  base.groups = model.groupsOf(item).filter(g => sharedSet.has(g));
  if (item.type === 'image') {
    base.image = item.image || null;
    if (item.width) base.width = item.width;
    if (item.height) base.height = item.height;
    return base;
  }
  const title = model.titleOf(item);
  if (title) base.title = title;
  base.preview = previewText(item, previewChars);
  return base;
}

// The full-text read result shape, shared by the helper's get_clip fast-path and
// the app's approval-gated read_clip so both stay identical. Group names are
// filtered to shared-only, matching clipView's policy.
function fullTextResult(item, sharedSet) {
  const groups = sharedSet ? model.groupsOf(item).filter(g => sharedSet.has(g)) : model.groupsOf(item);
  const result = { id: model.itemKey(item), type: 'text', text: String(item.text || ''), groups, ts: item.ts || 0 };
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
    if (slot != null) numpad[slot] = { id: model.itemKey(item), type: item.type === 'image' ? 'image' : 'text' };
    for (const g of model.groupsOf(item)) counts.set(g, (counts.get(g) || 0) + 1);
    if (isShared(item, sharedSet)) sharedCount++;
  }

  // Only name the SHARED groups. Private/non-shared groups are surfaced as a bare
  // count so the assistant knows the scale without learning private group names.
  const groups = groupNames
    .filter(name => sharedSet.has(name))
    .map(name => ({ name, shared: true, count: counts.get(name) || 0 }));
  const privateGroupCount = groupNames.filter(name => !sharedSet.has(name)).length;

  return {
    totalClips: items.length,
    sharedClips: sharedCount,
    pinnedClips: pinnedCount,
    groups,
    privateGroupCount,
    numpadSlots: numpad,
    aiGroup: AI_GROUP_NAME,
  };
}

// List clips. By default returns shared clips with previews (most recent first);
// pass includeNonShared to also append metadata-only entries for the rest.
function listClips(history, settings, {
  limit = DEFAULT_LIST_LIMIT,
  previewChars = DEFAULT_PREVIEW_CHARS,
  group = null,
  includeNonShared = false,
} = {}) {
  const items = Array.isArray(history) ? history : [];
  const sharedSet = sharedGroupSet(settings);
  const out = [];
  let nonSharedTotal = 0;

  for (const item of items) {
    const shared = isShared(item, sharedSet);
    if (!shared) {
      nonSharedTotal++;
      if (!includeNonShared) continue;
    }
    if (group && !model.groupsOf(item).includes(group)) continue;
    out.push(clipView(item, { sharedSet, previewChars }));
    if (out.length >= limit) break;
  }
  return { clips: out, nonSharedTotal, returned: out.length };
}

function buildMatcher(query, { regex = false } = {}) {
  const q = String(query || '');
  if (!q) return () => false;
  if (regex) {
    let re;
    try { re = new RegExp(q, 'i'); } catch { return () => false; }
    return (text) => re.test(text);
  }
  const lower = q.toLowerCase();
  return (text) => String(text || '').toLowerCase().includes(lower);
}

// Search. Shared matches return previews; non-shared matches are counted only
// (the caller decides whether to escalate to an approval-gated full search).
function searchClips(history, settings, {
  query,
  regex = false,
  limit = DEFAULT_LIST_LIMIT,
  previewChars = DEFAULT_PREVIEW_CHARS,
  scope = 'shared',
} = {}) {
  const items = Array.isArray(history) ? history : [];
  const sharedSet = sharedGroupSet(settings);
  const match = buildMatcher(query, { regex });
  const matches = [];
  let nonSharedMatches = 0;

  for (const item of items) {
    const shared = isShared(item, sharedSet);
    const haystack = searchableText(item, { sharedSet, forceAll: scope === 'all' });
    if (!match(haystack)) continue;
    if (shared) {
      if (matches.length < limit) matches.push(clipView(item, { sharedSet, previewChars }));
    } else {
      nonSharedMatches++;
      // scope === 'all' is only used by the app AFTER approval; it shapes the
      // non-shared match as a real preview so the assistant can read it.
      if (scope === 'all' && matches.length < limit) {
        matches.push(clipView(item, { sharedSet, previewChars, forcePreview: true }));
      }
    }
  }
  return { matches, nonSharedMatches, returned: matches.length };
}

// Resolve a single clip id for a full-text read. Returns the decision; the
// caller hydrates the text only when allowed. `reason` is one of:
// 'ok' | 'not_found' | 'not_shared'.
function resolveForRead(history, settings, id) {
  const items = Array.isArray(history) ? history : [];
  const sharedSet = sharedGroupSet(settings);
  const item = items.find(i => model.itemKey(i) === id);
  if (!item) return { reason: 'not_found', item: null, shared: false };
  const shared = isShared(item, sharedSet);
  if (!shared) return { reason: 'not_shared', item, shared: false };
  return { reason: 'ok', item, shared: true };
}

module.exports = {
  AI_GROUP_NAME,
  DEFAULT_PREVIEW_CHARS,
  DEFAULT_LIST_LIMIT,
  sharedGroupSet,
  isShared,
  previewText,
  clipView,
  fullTextResult,
  buildContext,
  listClips,
  searchClips,
  resolveForRead,
};
