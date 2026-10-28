'use strict';

const crypto = require('crypto');
// The ONE tag rule (flat, case-insensitive, comma input, retired nested names) lives in
// the isomorphic search engine so the popup, the demo, MCP and this model share it.
const Tags = require('../site/shared/clip-search');

const DEFAULT_SETTINGS = {
  max_age_days: 7,
  max_size_gb: 10,
  // The search field's Regex toggle (on: what you type becomes /pattern/) and
  // the editor find bar's Regex + match case. Per device, never synced
  // (main's remoteSettingsPayload).
  regex_search: false,
  // How a second value of a kind joins the first in the search ({ group, type }:
  // 'and' when the user last flipped to and; missing = or). Per device.
  facet_joins: {},
  find_regex: false,
  find_case: false,
  // The merge window's layout, 'split' (side by side) or 'unified', as last
  // flipped. Per device.
  merge_layout: 'split',
  // Rich clipboard capture (HTML + RTF alongside the plain text). Per-machine,
  // like the other "how THIS machine drives the OS" knobs, and never synced.
  // Turning it off stops NEW captures carrying formatting; clips that already
  // have it keep it, because the payload is what was on the clipboard at the
  // moment of capture and cannot be re-derived afterwards.
  capture_rich: true,
  theme_mode: 'system', // 'system' | 'light' | 'dark' — popup appearance
  // Appearance (lib/appearance.js validates every key). Per machine: the
  // surface (glass support is hardware-dependent), which windows get the glass,
  // and the audit-only borders axis. Synced, newest change wins per group via
  // appearance_stamps: the accent choice (System resolves per device), density
  // and corners.
  surface_style: 'auto', // 'auto' | 'glass' | 'solid' - auto = glass where supported
  glass_scope: 'popup',  // 'popup' | 'all' - glass on the popup only, or every window
  accent_mode: 'system', // 'system' | 'blue' | 'teal' | 'mono' | 'custom'
  accent_custom: '',     // '#rrggbb' for accent_mode 'custom'
  ui_density: 'normal',  // 'normal' | 'compact'
  ui_corners: 'soft',    // 'soft' | 'sharp'
  ui_borders: 'bordered', // 'bordered' | 'borderless' (BOARDCLIP_DEBUG_VARIANTS only)
  appearance_stamps: {}, // { accent, density, corners }: ms of the last local change
  // Height (px) image previews render at in the popup list (Ctrl+wheel /
  // Ctrl+=/-/0 / Settings). Per-machine like the other display knobs, not synced.
  image_preview_height: 60,
  // Max height (px) of the popup's search options panel, dragged on its bottom
  // edge. 0 = the default (~40 % of the popup). Per machine, not synced.
  options_panel_height: 0,
  show_shortcut: '',
  quick_paste_shortcut: '',
  new_note_shortcut: '',
  // Quick-paste (numpad slots + panel number keys) behaviour. Per-machine, not
  // synced — these are about how THIS machine drives the OS paste, not content.
  // 'clipboard' = the real paste API (set clipboard + Ctrl/Cmd+V + restore),
  // made robust by lib/quick-paste.js (serialize, verify-the-write-landed,
  // safe + lag-adaptive restore). 'type' injects keystrokes (no clipboard, no
  // restore race) but is slower and turns newlines into real Enter presses, so
  // it is opt-in only. Default is real paste.
  quick_paste_restore: true,          // restore the previous clipboard after a quick-paste
  quick_paste_restore_delay_ms: 400,  // floor delay before restore; adapts up under lag
  groups: [],
  // Tags nested with '/' before the flat-tags cutover (14 Oct 2026), split once into their
  // parts: [{ name, parts, at }]. Synced and permanent, so an old device, a stale cloud copy,
  // an old backup or an agent still writing 'todo/forge' lands as todo + forge.
  group_splits: [],
  // Tags with a '/' in their name made on a flat-tags device, where the '/' is a plain
  // character: [{ name, at }]. Synced and permanent. A device on its first flat start
  // cannot tell such a name from an old nested one and retires it; this record overrules
  // that split everywhere (groupSplitMap); a merge joins the parts back into the name
  // (rejoinLiterals) and that device puts it back on its own clips (unsplitLiterals).
  group_literals: [],
  // When THIS device cut over to flat tags (ms). Per device, never synced: before it, every
  // '/' in a tag name meant nesting; after it, a new name's '/' is a plain character.
  groups_flattened_at: 0,
  sync_path: '',
  sync_custom_paths: [],
  sync_disabled_paths: [],
  p2p_enabled: true,
  p2p_device_id: '',
  p2p_secret: '',
  p2p_endpoints: {},       // synced: where each device can be reached (lan/tailnet ips + port)
  p2p_pinned_peers: [],    // synced: manual host[:port] entries to announce to / probe
  diagnostics_enabled: false,
  popup_size: null,
  editor_bounds: null, // built-in editor window bounds (per-machine, not synced)
  merge_bounds: null, // unify / conflict window bounds (per-machine, not synced)
  viewer_bounds: null, // built-in image viewer bounds (per-machine, not synced)
  tombstones: [],
  group_tombstones: [],
  // Edit lineage for content-hash ids. Every text edit changes id, so sync needs
  // to know old-id -> new-id is a rename/edit, not a hard delete tombstone.
  supersedes: [],
  // AI Access (local MCP server). See lib/mcp-core.js and the MCP section in main.js.
  ai_access_enabled: false,
  groups_shared_with_ai: [],   // group names whose clips are exposed to AI (curation allowlist)
  // Explicit share-switch flips, synced per tag: { [tagKey]: { shared, at } }; the newest flip
  // wins on every device. A device's list keeps its own state for tags never flipped.
  ai_share_stamps: {},
  ai_always_allow: [],         // MCP tool names the user chose to always allow (skip approval modal)
  ai_approval_timeout_sec: 60, // approval modal deny-by-default countdown
  mcp_secret: '',              // per-machine control-channel HMAC secret (not synced)
  // Source-checkout update mode is developer-only and never synced. Production
  // installs do not expose or persist this escape hatch.
  update_mode: 'production',   // 'production' | 'development'
};

const TOMBSTONE_MAX_AGE_MS = 30 * 86400 * 1000;
const TEXT_HASH_RE = /^[a-f0-9]{64}$/i;
const DEFAULT_DESTRUCTIVE_PRUNE_FRACTION = 0.25;

function valueHash(value) {
  return crypto.createHash('sha256').update(String(value || ''), 'utf8').digest('hex');
}

function textHashForText(text) {
  return valueHash(text);
}

// Field-name vocabulary for ONE content-addressed clipboard payload, so the
// blob store's mechanics can be written once and instantiated per format.
// `text` is the IDENTITY payload - a clip's id is the hash of its text - while
// `html`/`rtf` are auxiliary formats describing that same content.
function blobFieldNames(field) {
  const name = String(field || '');
  return {
    value: name,
    hash: `${name}Hash`,
    ref: `${name}Ref`,
    size: `${name}Size`,
    preview: `${name}Preview`,
  };
}

const TEXT_BLOB_FIELD_NAMES = blobFieldNames('text');
const RICH_BLOB_FIELDS = ['html', 'rtf'];

function normalizedTextHash(hash) {
  const value = String(hash || '').trim().toLowerCase();
  return TEXT_HASH_RE.test(value) ? value : '';
}

function itemTextHash(item) {
  if (!item || item.type === 'image') return '';
  return normalizedTextHash(item.textHash) || textHashForText(item.text || '');
}

function textByteLength(text) {
  return Buffer.byteLength(String(text || ''), 'utf8');
}

function hasVerifiedFullValue(item, names) {
  if (!item || item.type === 'image') return false;
  const value = String(item[names.value] || '');
  const hash = normalizedTextHash(item[names.hash]);
  if (!item[names.ref] && !hash) return true;
  if (hash) return valueHash(value) === hash;
  const size = Number(item[names.size]) || 0;
  return !size || textByteLength(value) >= size;
}

function itemHasVerifiedFullText(item) {
  return hasVerifiedFullValue(item, TEXT_BLOB_FIELD_NAMES);
}

function textPayloadScore(item) {
  if (!item || item.type === 'image') return -1;
  if (itemHasVerifiedFullText(item)) return 3;
  if (item.text && !item.textRef) return 2;
  if (item.textHash || item.textRef) return 1;
  return 0;
}

function migrateItemPin(item) {
  if ('pin' in item) return item;
  const pin = {};
  let pinned = false;
  if (typeof item.pinned === 'number') {
    pin.number = item.pinned;
    pinned = true;
  } else if (item.pinned === true) {
    pinned = true;
  }
  if (item.group) {
    pin.groups = [item.group];
    pinned = true;
  }
  item.pin = pinned ? pin : null;
  delete item.pinned;
  delete item.group;
  return item;
}

function isPinned(item) { return item.pin != null; }
function numpadSlotOf(item) {
  return item.pin && typeof item.pin.number === 'number' ? item.pin.number : null;
}
function groupsOf(item) {
  return item.pin && Array.isArray(item.pin.groups) ? item.pin.groups : [];
}
function hasNumpadSlot(item, n) { return numpadSlotOf(item) === n; }
function ensurePin(item) {
  if (!item.pin) item.pin = {};
  return item.pin;
}

function setInlineText(item, text) {
  if (!item || item.type === 'image') return item;
  item.text = String(text || '');
  delete item.textHash;
  delete item.textRef;
  delete item.textSize;
  delete item.textPreview;
  // The rich payloads describe the text that was just replaced. Keeping them
  // would paste the PRE-EDIT content into any app that prefers HTML/RTF - the
  // edit would look silently ignored. Drop them; plain text is then the only
  // format offered, which is correct for text the user just typed.
  for (const field of RICH_BLOB_FIELDS) {
    const names = blobFieldNames(field);
    delete item[names.value];
    delete item[names.hash];
    delete item[names.ref];
    delete item[names.size];
  }
  return item;
}

function cleanTitle(value) {
  return String(value == null ? '' : value).replace(/\s+/g, ' ').trim().slice(0, 240);
}

function titleOf(item) {
  return cleanTitle(item && item.title);
}

function titleUpdatedAt(item) {
  if (!item || item.type === 'image') return 0;
  return timestamp(item.titleUpdatedAt) || (titleOf(item) ? itemUpdatedAt(item) : 0);
}

function setTitleMetadata(item, title, updatedAt = Date.now()) {
  if (!item || item.type === 'image') return item;
  const nextTitle = cleanTitle(title);
  const nextUpdatedAt = timestamp(updatedAt) || Date.now();
  if (nextTitle) item.title = nextTitle;
  else delete item.title;
  item.titleUpdatedAt = nextUpdatedAt;
  if (timestamp(item.updatedAt) < nextUpdatedAt) item.updatedAt = nextUpdatedAt;
  return item;
}

function titleState(item) {
  const title = titleOf(item);
  const updatedAt = titleUpdatedAt(item);
  return { title, updatedAt, known: !!title || updatedAt > 0 };
}

function mergeTitleMetadata(base, localItem, remoteItem) {
  if (!base || base.type === 'image') return base;
  const local = titleState(localItem);
  const remote = titleState(remoteItem);
  let winner = null;
  if (local.known && remote.known) {
    if (remote.updatedAt > local.updatedAt) winner = remote;
    else if (local.updatedAt > remote.updatedAt) winner = local;
    else winner = remote.title.length >= local.title.length ? remote : local;
  } else if (local.known) winner = local;
  else if (remote.known) winner = remote;

  if (!winner) {
    delete base.title;
    delete base.titleUpdatedAt;
    return base;
  }
  if (winner.title) base.title = winner.title;
  else delete base.title;
  if (winner.updatedAt) base.titleUpdatedAt = winner.updatedAt;
  else delete base.titleUpdatedAt;
  return base;
}

function itemTextForConflict(item) {
  if (!item || item.type === 'image') return '';
  return String(item.text != null ? item.text : (item.textPreview || ''));
}

function conflictSnapshot(item, fallback = {}) {
  const source = item || {};
  return {
    id: (item ? itemKey(source) : '') || fallback.id || '',
    type: source.type === 'image' ? 'image' : 'text',
    title: titleOf(source) || cleanTitle(fallback.title),
    text: itemTextForConflict(source) || String(fallback.text || ''),
    groups: groupsOf(source),
    ts: timestamp(source.ts) || timestamp(fallback.ts),
    updatedAt: timestamp(source.updatedAt) || timestamp(fallback.updatedAt),
    titleUpdatedAt: titleUpdatedAt(source) || timestamp(fallback.titleUpdatedAt),
  };
}

// Two sides with the same text and title leave nothing to merge.
function withoutIdenticalSides(conflict) {
  const { left, right } = conflict || {};
  if (left && right && left.text === right.text && left.title === right.title) return null;
  return conflict;
}

function titleConflict(localItem, remoteItem) {
  if (!localItem || !remoteItem || localItem.type === 'image' || remoteItem.type === 'image') return false;
  if (itemKey(localItem) !== itemKey(remoteItem)) return false;
  const local = titleState(localItem);
  const remote = titleState(remoteItem);
  return local.known && remote.known && local.title !== remote.title;
}

function legacyContentKey(item) {
  if (item.type === 'image') return `img:${item.image}`;
  return `txt:${itemTextHash(item)}`;
}

function ensureItemId(item) {
  if (!item.id) item.id = legacyContentKey(item);
  return item.id;
}

function itemKey(item) {
  return item && (item.id || legacyContentKey(item));
}

// A clip's REVISION: a short hash over everything a mutation can change -
// content (text hash / image file), title, pin, groups, numpad slot. Derived,
// never stored, so it cannot go stale; ordering/clock/blob-ref fields are
// excluded so capture-time corrections and blob hydration never bump it.
// Mutations carry the rev they read and are refused if it moved (clip-revision).
function clipRevision(item) {
  if (!item) return '';
  const content = item.type === 'image' ? `img:${item.image || ''}` : `txt:${itemTextHash(item)}`;
  const groups = [...groupsOf(item)].map(String).sort();
  return valueHash(JSON.stringify([content, titleOf(item), isPinned(item), groups, numpadSlotOf(item)])).slice(0, 16);
}

// A tombstone may carry the rev + mutation clock of the exact copy it deleted.
// The pair travels together or not at all (legacy tombstones have neither).
function tombstoneRecord(source, deletedAt) {
  const record = { id: String(source.id), deletedAt };
  const revClock = Number(source.revClock);
  if (typeof source.rev === 'string' && source.rev && Number.isFinite(revClock)) {
    record.rev = source.rev;
    record.revClock = revClock;
  }
  return record;
}

// Does this tombstone suppress this copy of the clip during a merge?
//  - clock rule (all tombstones): a copy not mutated after the delete stays deleted;
//  - version rule (rev-carrying tombstones): the EXACT version that was deleted
//    stays deleted even when clock skew makes it look newer than the delete.
// A genuinely newer copy - edited elsewhere (different rev) or re-added later
// (newer clock) - survives.
// rawRev: the copy's revision before its tags were normalised (a delete made by a build
// that still held the nested names records the nested rev).
function tombstoneSuppresses(tombstone, item, rawRev = '') {
  if (!tombstone || !item) return false;
  const clock = itemMutationClock(item);
  if (clock <= (Number(tombstone.deletedAt) || 0)) return true;
  if (!tombstone.rev || clock > tombstone.revClock) return false;
  return clipRevision(item) === tombstone.rev || (!!rawRev && rawRev === tombstone.rev);
}

function normalizeTombstones(list, now = Date.now()) {
  const cutoff = now - TOMBSTONE_MAX_AGE_MS;
  const byId = new Map();
  for (const tombstone of Array.isArray(list) ? list : []) {
    if (!tombstone || !tombstone.id) continue;
    const deletedAt = Number(tombstone.deletedAt) || 0;
    if (deletedAt < cutoff) continue;
    const existing = byId.get(tombstone.id);
    if (!existing || deletedAt > existing.deletedAt) byId.set(tombstone.id, tombstoneRecord(tombstone, deletedAt));
  }
  return [...byId.values()];
}

// Tag deletes, { name, deletedAt, restoredAt?, anyCase? }: the newest delete and the newest
// re-create of one tag. A flat-tags build writes anyCase (the tag in any spelling). A record
// without it was written by a build from before 14 Oct 2026, when 'Work' and 'work' were two
// tags: it deletes that exact spelling only, so a live twin survives. A record stays while
// its delete or its re-create is under 30 days old.
function normalizeGroupTombstones(list, now = Date.now()) {
  const cutoff = now - TOMBSTONE_MAX_AGE_MS;
  const bySlot = new Map();
  for (const tombstone of Array.isArray(list) ? list : []) {
    if (!tombstone || !tombstone.name) continue;
    const name = Tags.cleanTagName(tombstone.name);
    if (!name) continue;
    const anyCase = tombstone.anyCase === true;
    const slot = anyCase ? `k:${Tags.tagKey(name)}` : `x:${name}`;
    const deletedAt = Number(tombstone.deletedAt) || 0;
    const restoredAt = Number(tombstone.restoredAt) || 0;
    const record = bySlot.get(slot) || (anyCase ? { name, deletedAt: 0, anyCase: true } : { name, deletedAt: 0 });
    if (anyCase) record.name = Tags.preferredSpelling(record.name, name);
    record.deletedAt = Math.max(record.deletedAt, deletedAt);
    if (restoredAt > (record.restoredAt || 0)) record.restoredAt = restoredAt;
    bySlot.set(slot, record);
  }
  return [...bySlot.values()].filter(t => Math.max(t.deletedAt, t.restoredAt || 0) >= cutoff);
}

// What the tag deletes do: a delete not re-created since takes the tag off every copy (a
// re-create is how a deleted tag comes back, registerTags). After a re-create only a copy
// whose tags were last changed at or before the delete loses it, so a stale pre-delete copy
// cannot bring the old memberships back. key: tagKey -> state (flat-build records); exact:
// spelling -> state (older builds' records, applied to a raw name before it is respelled).
function groupTombstoneIndex(list) {
  const key = new Map();
  const exact = new Map();
  for (const t of normalizeGroupTombstones(list)) {
    const state = { deletedAt: t.deletedAt, recreated: (t.restoredAt || 0) > t.deletedAt };
    if (t.anyCase) key.set(Tags.tagKey(t.name), state);
    else exact.set(t.name, state);
  }
  return { key, exact, size: key.size + exact.size };
}

// Does this delete take a tag off a copy whose tags were last changed at `clock`? A name
// list has no clock (Infinity): only deletes not re-created apply to it.
function deleteStrips(state, clock = Infinity) {
  return !!state && (!state.recreated || clock <= state.deletedAt);
}

// The AI tag (always shared with AI) is spelled exactly AI_TAG_NAME. Before 14 Oct 2026 a
// tag spelled any other way ('ai', 'Ai') was a different, private tag: it keeps its clips
// as "<its name> (old)" and never turns into the shared AI tag, from any copy on any
// device. A flat build never writes such a spelling (tagInputNames gives AI_TAG_NAME).
const AI_TAG_NAME = 'AI';
const AI_TAG_KEY = AI_TAG_NAME.toLowerCase();
function renameAiTwins(names) {
  let out = null;
  for (let i = 0; i < names.length; i++) {
    const name = Tags.cleanTagName(names[i]);
    if (name === AI_TAG_NAME || Tags.tagKey(name) !== AI_TAG_KEY) continue;
    if (!out) out = names.slice();
    out[i] = `${name} (old)`;
  }
  return out || names;
}

// A raw tag list (as a clip, a settings file or an older build holds it) before it is put
// in stored form: exact-spelling deletes applied, AI twins renamed. The same array when
// nothing changes.
function rawTagNames(names, ctx, clock = Infinity) {
  let list = Array.isArray(names) ? names : [];
  const exact = ctx && ctx.tombstones && ctx.tombstones.exact;
  if (exact && exact.size && list.length) {
    const kept = list.filter(g => !deleteStrips(exact.get(Tags.cleanTagName(g)), clock));
    if (kept.length !== list.length) list = kept;
  }
  return renameAiTwins(list);
}

// The retired nested names: tagKey(name) -> parts. Permanent; the earliest record of a
// name wins so every device agrees. A part is never the AI tag: sharing a clip with AI is
// the AI tag itself, never a sub-group of it ('AI/drafts' is drafts, private as it was).
function normalizeGroupSplits(list) {
  const byKey = new Map();
  for (const record of Array.isArray(list) ? list : []) {
    if (!record || !record.name) continue;
    const name = String(record.name);
    const key = Tags.tagKey(name);
    if (!key) continue;
    const parts = (Array.isArray(record.parts) ? record.parts : Tags.nestedNameParts(name)).map(Tags.cleanTagName)
      .filter(part => part && Tags.tagKey(part) !== AI_TAG_KEY);
    const at = Number(record.at) || 0;
    const existing = byKey.get(key);
    if (!existing || at < existing.at || (at === existing.at && name < existing.name)) byKey.set(key, { name, parts, at });
  }
  return [...byKey.values()].sort((a, b) => a.at - b.at || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
}

// '/' names made on a flat-tags device (plain '/'), one per tag, the earliest record.
function normalizeGroupLiterals(list) {
  const byKey = new Map();
  for (const record of Array.isArray(list) ? list : []) {
    const name = Tags.cleanTagName(record && typeof record === 'object' ? record.name : record);
    const key = Tags.tagKey(name);
    if (!key || !name.includes('/')) continue;
    const at = Number(record && record.at) || 0;
    const existing = byKey.get(key);
    if (!existing || at < existing.at || (at === existing.at && name < existing.name)) byKey.set(key, { name, at });
  }
  return [...byKey.values()].sort((a, b) => a.at - b.at || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
}

// tagKey(plain '/' name) -> { name, parts }: the parts a late cutover split it into (its
// own record, else the name's segments).
function literalPartsMap(settings = {}) {
  const map = new Map();
  const literals = normalizeGroupLiterals(settings.group_literals);
  if (!literals.length) return map;
  const recorded = new Map(normalizeGroupSplits(settings.group_splits).map(r => [Tags.tagKey(r.name), r.parts]));
  for (const { name } of literals) {
    const key = Tags.tagKey(name);
    const parts = recorded.get(key) || Tags.nestedNameParts(name).filter(p => Tags.tagKey(p) !== AI_TAG_KEY);
    if (parts.length) map.set(key, { name, parts });
  }
  return map;
}

// tagKey(retired name) -> parts, without the names a flat device made as plain '/' tags.
function groupSplitMap(list, literals = []) {
  const literal = new Set(normalizeGroupLiterals(literals).map(record => Tags.tagKey(record.name)));
  const map = new Map();
  for (const record of normalizeGroupSplits(list)) {
    const key = Tags.tagKey(record.name);
    if (!literal.has(key)) map.set(key, record.parts);
  }
  return map;
}
// The split map one device's settings give (what tagContext and the MCP rewrite use).
function splitMapOf(settings = {}) {
  return groupSplitMap(settings.group_splits, settings.group_literals);
}

function normalizeSupersedes(list, now = Date.now()) {
  const cutoff = now - TOMBSTONE_MAX_AGE_MS;
  const byFrom = new Map();
  for (const record of Array.isArray(list) ? list : []) {
    if (!record || !record.from || !record.to || record.from === record.to) continue;
    const updatedAt = Number(record.updatedAt) || 0;
    if (updatedAt < cutoff) continue;
    const from = String(record.from);
    const to = String(record.to);
    const existing = byFrom.get(from);
    if (!existing || updatedAt > existing.updatedAt) byFrom.set(from, { from, to, updatedAt });
  }
  return [...byFrom.values()];
}

// from -> link record, minus links whose `from` was re-created by a NEWER link
// into it. Text ids are content hashes, so typing a change and taking it back
// inside one editor session (A->B->A) records A->B and later B->A: A is the
// live text again and A->B no longer describes it. Left in, the pair is a cycle
// that resolves the live head to itself, and the head's own older edit
// tombstone then dropped it on every merge (2026-09-29: a pinned note vanished
// within one sync pass and two stale copies took its place).
function liveSupersedeLinks(list) {
  const records = normalizeSupersedes(list);
  const recreatedAt = new Map();
  for (const record of records) recreatedAt.set(record.to, Math.max(recreatedAt.get(record.to) || 0, record.updatedAt));
  return new Map(records
    .filter(record => !((recreatedAt.get(record.from) || 0) > record.updatedAt))
    .map(record => [record.from, record]));
}

function resolveSupersedeLinks(links) {
  const resolved = new Map();
  const resolve = (id, seen = new Set()) => {
    const value = String(id || '');
    if (!links.has(value) || seen.has(value)) return value;
    seen.add(value);
    return resolve(links.get(value).to, seen);
  };
  for (const from of links.keys()) {
    const to = resolve(from);
    // A cycle that survives the filter (links in the same ms) has no newest
    // version to point at, so it carries no lineage at all.
    if (to !== from) resolved.set(from, to);
  }
  return resolved;
}

function supersedeMap(list) {
  return resolveSupersedeLinks(liveSupersedeLinks(list));
}

// An edit writes its old-id tombstone in the same instant as the supersede
// link. A tombstone well AFTER the link (or one carrying the deleted copy's
// rev, which only explicit deletes record) is the user deleting a stale copy
// that came back; a broken lineage chain must not overrule that delete.
const EDIT_TOMBSTONE_SLACK_MS = 5000;
function deletedAfterEdit(tombstone, link) {
  if (!tombstone || !link) return false;
  return !!tombstone.rev || tombstone.deletedAt > link.updatedAt + EDIT_TOMBSTONE_SLACK_MS;
}

function tombstoneIds(list) {
  return new Set(normalizeTombstones(list).map(t => t.id));
}

// id -> tombstone record ({ deletedAt, rev?, revClock? }). Lets a merge compare a delete's timestamp against an
// item's own mutation clock so a legitimately NEWER re-add/edit beats a stale
// tombstone, while a stale-provider original stays deleted (no resurrection).
function tombstoneMap(list) {
  return new Map(normalizeTombstones(list).map(t => [t.id, t]));
}

// What every tag list is normalised against: the retired names, the stored spelling of
// each tag, and the deleted tags. Built from settings plus any name lists in play (both
// sides of a merge), so the spelling chosen is the same on every device.
function tagContext(settings = {}, nameLists = []) {
  const splits = splitMapOf(settings);
  const tombstones = groupTombstoneIndex(settings.group_tombstones);
  const ctx = { splits, tombstones, spellings: null, literals: literalPartsMap(settings) };
  const lists = [settings.groups, ...nameLists].map(list => Tags.expandTagNames(rawTagNames(list, ctx), splits, null));
  ctx.spellings = Tags.tagSpellings(lists);
  return ctx;
}

// Every tag list held by a set of clips (for tagContext).
function itemTagLists(...histories) {
  const lists = [];
  for (const history of histories) {
    for (const item of Array.isArray(history) ? history : []) {
      if (item && item.pin && Array.isArray(item.pin.groups) && item.pin.groups.length) lists.push(item.pin.groups);
      else if (item && !('pin' in item) && item.group) lists.push([item.group]);
    }
  }
  return lists;
}

// A list of tag names (no clock: settings.groups, typed input, new-note tags) in stored
// form: retired names split, stored spellings, deleted tags dropped, one per tag.
function normalizeTagList(names, ctx) {
  return keepUndeletedGroups(Tags.expandTagNames(rawTagNames(names, ctx), ctx.splits, ctx.spellings), Infinity, ctx.tombstones);
}

// The tags typed or sent in one go (New group, a picker, an AI tool's group param):
// an existing tag named in full is that tag (even with a comma in its name); else the
// comma-separated names, a retired nested name as its parts, each in its stored
// spelling. Never filtered by tombstones: typing a deleted tag's name re-creates it.
function tagInputNames(input, settings = {}) {
  const ctx = tagContext(settings);
  return Tags.inputTagNames(input, settings.groups, ctx.splits, ctx.spellings)
    .map(name => (Tags.sameTag(name, AI_TAG_NAME) ? AI_TAG_NAME : name));
}

// One clip's tags in stored form. PURE: returns the item itself when nothing changes and
// otherwise a COPY with a new pin object (a merge receives the live history objects, and
// an in-place change would hide from every change detector). Never moves a clock and never
// removes the pin itself (an unpinned clip can be age-pruned).
function normalizeItemTags(item, ctx) {
  if (!item || !item.pin || !Array.isArray(item.pin.groups)) return item;
  const pin = item.pin;
  const clock = groupState(pin).updatedAt;
  const groups = keepUndeletedGroups(Tags.expandTagNames(rawTagNames(pin.groups, ctx, clock), ctx.splits, ctx.spellings), clock, ctx.tombstones);
  if (groups === pin.groups) return item;
  const nextPin = { ...pin };
  if (groups.length) nextPin.groups = groups;
  else delete nextPin.groups;
  return { ...item, pin: nextPin };
}

function timestamp(value) {
  const n = Number(value) || 0;
  return Number.isFinite(n) ? n : 0;
}

function timestampMs(value) {
  const n = timestamp(value);
  if (!n) return 0;
  return n < 100000000000 ? n * 1000 : n;
}

function pinUpdatedAt(item) {
  if (!item) return 0;
  const pin = item.pin || null;
  return Math.max(
    timestamp(item.pinUpdatedAt),
    pin ? timestamp(pin.updatedAt) : 0,
    pin ? timestamp(pin.numberUpdatedAt) : 0,
    pin ? timestamp(pin.groupsUpdatedAt) : 0
  );
}

function pinMetadataUpdatedAt(pin, fallback = 0) {
  return pin ? timestamp(pin.updatedAt) || timestamp(fallback) : timestamp(fallback);
}

function groupState(pin, fallback = 0) {
  if (!pin) return { known: false, groups: [], updatedAt: 0 };
  const groups = Array.isArray(pin.groups) ? pin.groups : [];
  const explicitUpdatedAt = timestamp(pin.groupsUpdatedAt);
  const updatedAt = explicitUpdatedAt || (groups.length ? pinMetadataUpdatedAt(pin, fallback) : 0);
  return {
    known: groups.length > 0 || explicitUpdatedAt > 0,
    explicit: explicitUpdatedAt > 0,
    groups,
    updatedAt,
  };
}

function numberState(pin, fallback = 0) {
  if (!pin) return { known: false, number: null, updatedAt: 0 };
  const hasNumber = typeof pin.number === 'number';
  const explicitUpdatedAt = timestamp(pin.numberUpdatedAt);
  const updatedAt = explicitUpdatedAt || (hasNumber ? pinMetadataUpdatedAt(pin, fallback) : 0);
  return {
    known: hasNumber || explicitUpdatedAt > 0,
    number: hasNumber ? pin.number : null,
    updatedAt,
  };
}

// Stored-form names (already respelled): the any-case deletes. deletedGroups:
// groupTombstoneIndex. The same array when nothing goes.
function keepUndeletedGroups(groups, updatedAt, deletedGroups) {
  if (!deletedGroups || !deletedGroups.key.size || !groups.length) return groups;
  const kept = groups.filter(g => !deleteStrips(deletedGroups.key.get(Tags.tagKey(g)), updatedAt));
  return kept.length === groups.length ? groups : kept;
}

function cleanPin(pin, deletedGroups = groupTombstoneIndex([])) {
  if (!pin) return null;
  const cleaned = { ...pin };
  if (typeof cleaned.number !== 'number') delete cleaned.number;
  if (Array.isArray(cleaned.groups)) {
    cleaned.groups = keepUndeletedGroups(cleaned.groups, groupState(pin).updatedAt, deletedGroups);
    if (!cleaned.groups.length) delete cleaned.groups;
  }
  return cleaned;
}

// One entry per tag (case-insensitive), first spelling kept.
function uniqueTags(groups) {
  const seen = new Set();
  const out = [];
  for (const g of groups) {
    const key = Tags.tagKey(g);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push(g);
  }
  return out;
}

function mergeGroupState(localPin, remotePin, localUpdatedAt, remoteUpdatedAt, deletedGroups) {
  const local = groupState(localPin, localUpdatedAt);
  const remote = groupState(remotePin, remoteUpdatedAt);
  let groups = [];
  let updatedAt = 0;

  if (local.known && remote.known) {
    updatedAt = Math.max(local.updatedAt, remote.updatedAt);
    if (!local.explicit && !remote.explicit) groups = [...new Set([...local.groups, ...remote.groups])];
    else if (local.updatedAt > remote.updatedAt) groups = local.groups;
    else if (remote.updatedAt > local.updatedAt) groups = remote.groups;
    else groups = [...new Set([...local.groups, ...remote.groups])];
  } else if (local.known) {
    groups = local.groups;
    updatedAt = local.updatedAt;
  } else if (remote.known) {
    groups = remote.groups;
    updatedAt = remote.updatedAt;
  }

  groups = keepUndeletedGroups(uniqueTags(groups), updatedAt, deletedGroups);
  return { known: local.known || remote.known, groups, updatedAt };
}

function mergeNumberState(localPin, remotePin, localUpdatedAt, remoteUpdatedAt) {
  const local = numberState(localPin, localUpdatedAt);
  const remote = numberState(remotePin, remoteUpdatedAt);
  if (local.known && remote.known) {
    const updatedAt = Math.max(local.updatedAt, remote.updatedAt);
    if (remote.updatedAt > local.updatedAt) return { ...remote, updatedAt };
    if (local.updatedAt > remote.updatedAt) return { ...local, updatedAt };
    if (local.number == null && remote.number != null) return { ...remote, updatedAt };
    if (remote.number == null && local.number != null) return { ...local, updatedAt };
    return (remote.number || 0) > (local.number || 0) ? { ...remote, updatedAt } : { ...local, updatedAt };
  }
  if (local.known) return local;
  if (remote.known) return remote;
  return { known: false, number: null, updatedAt: 0 };
}

function mergePins(localPin, remotePin, localUpdatedAt = 0, remoteUpdatedAt = 0, groupTombstones = []) {
  if (!localPin && !remotePin) return null;
  const deletedGroups = groupTombstoneIndex(groupTombstones);
  const localPinUpdated = pinMetadataUpdatedAt(localPin, localUpdatedAt);
  const remotePinUpdated = pinMetadataUpdatedAt(remotePin, remoteUpdatedAt);

  if (!localPin && remotePin) return timestamp(localUpdatedAt) > remotePinUpdated ? null : cleanPin(remotePin, deletedGroups);
  if (localPin && !remotePin) return timestamp(remoteUpdatedAt) > localPinUpdated ? null : cleanPin(localPin, deletedGroups);

  const merged = {};
  const groups = mergeGroupState(localPin, remotePin, localPinUpdated, remotePinUpdated, deletedGroups);
  if (groups.groups.length) merged.groups = groups.groups;
  if (groups.known && groups.updatedAt) merged.groupsUpdatedAt = groups.updatedAt;

  const number = mergeNumberState(localPin, remotePin, localPinUpdated, remotePinUpdated);
  if (number.number != null) merged.number = number.number;
  if (number.known && number.updatedAt) merged.numberUpdatedAt = number.updatedAt;

  const updatedAt = Math.max(localPinUpdated, remotePinUpdated, groups.updatedAt, number.updatedAt);
  if (updatedAt) merged.updatedAt = updatedAt;
  return merged;
}

function mergeItemTimestamp(localItem, remoteItem, base) {
  const localTs = timestamp(localItem.ts);
  const remoteTs = timestamp(remoteItem.ts);
  const localTsUpdated = timestamp(localItem.tsUpdatedAt);
  const remoteTsUpdated = timestamp(remoteItem.tsUpdatedAt);
  if (localTsUpdated || remoteTsUpdated) {
    if (remoteTsUpdated > localTsUpdated) base.ts = remoteTs;
    else if (localTsUpdated > remoteTsUpdated) base.ts = localTs;
    else base.ts = Math.max(localTs, remoteTs); // deterministic clock-collision tie-break
    base.tsUpdatedAt = Math.max(localTsUpdated, remoteTsUpdated) || undefined;
  } else {
    base.ts = Math.max(localTs, remoteTs);
    delete base.tsUpdatedAt;
  }
  return base;
}

function mergeItems(localItem, remoteItem, groupTombstones = []) {
  migrateItemPin(localItem);
  migrateItemPin(remoteItem);
  ensureItemId(localItem);
  ensureItemId(remoteItem);
  const localTs = localItem.ts || 0;
  const remoteTs = remoteItem.ts || 0;
  const localUpdated = localItem.updatedAt || localTs;
  const remoteUpdated = remoteItem.updatedAt || remoteTs;
  const localPinUpdated = pinUpdatedAt(localItem);
  const remotePinUpdated = pinUpdatedAt(remoteItem);
  const base = remoteUpdated > localUpdated ? { ...remoteItem } : { ...localItem };
  base.id = itemKey(base);
  // tsUpdatedAt is the LWW clock for an intentional capture-time correction or
  // recapture. Legacy replicas have no clock, so a repaired timestamp cannot be
  // re-clobbered by an old provider that still carries the inflated value.
  mergeItemTimestamp(localItem, remoteItem, base);
  base.updatedAt = Math.max(localItem.updatedAt || 0, remoteItem.updatedAt || 0) || undefined;
  base.pinUpdatedAt = Math.max(localPinUpdated, remotePinUpdated) || undefined;
  base.pin = mergePins(
    localItem.pin,
    remoteItem.pin,
    localPinUpdated,
    remotePinUpdated,
    groupTombstones
  );
  mergeTextPayload(base, localItem, remoteItem);
  mergeTitleMetadata(base, localItem, remoteItem);
  return base;
}

function mergeSupersededStaleIntoTarget(targetItem, staleItem, groupTombstones = []) {
  // The stale item is an older content-hash id in the same edit lineage. It may
  // still carry useful pin/title metadata, but its TEXT must never overwrite the
  // newer target text: that is the exact stale-provider regression this fixes.
  migrateItemPin(targetItem);
  migrateItemPin(staleItem);
  ensureItemId(targetItem);
  ensureItemId(staleItem);
  const base = { ...targetItem };
  const targetPinUpdated = pinUpdatedAt(targetItem);
  const stalePinUpdated = pinUpdatedAt(staleItem);
  base.id = itemKey(targetItem);
  mergeItemTimestamp(targetItem, staleItem, base);
  base.updatedAt = Math.max(targetItem.updatedAt || 0, staleItem.updatedAt || 0) || undefined;
  base.pinUpdatedAt = Math.max(targetPinUpdated, stalePinUpdated) || undefined;
  base.pin = mergePins(targetItem.pin, staleItem.pin, targetPinUpdated, stalePinUpdated, groupTombstones);
  mergeTitleMetadata(base, targetItem, staleItem);
  return base;
}

function mergeTextPayload(base, localItem, remoteItem) {
  if (!base || base.type === 'image') return base;
  const candidates = [base, localItem, remoteItem].filter(item => item && item.type !== 'image');
  const bestText = candidates
    .slice()
    .sort((a, b) => {
      const score = textPayloadScore(b) - textPayloadScore(a);
      if (score) return score;
      return String(b.text || '').length - String(a.text || '').length;
    })[0];
  const bestMeta = candidates.find(item => item.textHash || item.textRef || item.textSize || item.textPreview);

  if (bestText && textPayloadScore(bestText) >= 2) {
    base.text = bestText.text || '';
  } else if (!base.text && bestMeta) {
    base.text = bestMeta.textPreview || bestMeta.text || '';
  }

  for (const field of ['textHash', 'textRef', 'textSize', 'textPreview']) {
    const source = candidates.find(item => item[field] !== undefined);
    if (source) base[field] = source[field];
    else delete base[field];
  }
  for (const field of RICH_BLOB_FIELDS) mergeBlobFieldGroup(base, candidates, blobFieldNames(field));
  return base;
}

function blobFieldGroupPresent(item, names) {
  return !!(item && (item[names.value] || item[names.ref] || item[names.hash]));
}

// A rich payload is taken as ONE GROUP from a SINGLE source item, never
// resolved field-by-field like the text metadata above. Two clips share an id
// exactly when they share their text, which forces all their TEXT metadata to
// agree - that is what makes the per-field loop safe there. It buys nothing
// here: the same words can be copied twice with different formatting, so an
// inline value from one item beside a ref/hash from another would describe
// content that exists nowhere. Candidate order is [base, local, remote], so the
// LWW winner is preferred and a one-sided payload still survives.
function mergeBlobFieldGroup(base, candidates, names) {
  const source = candidates.find(item => blobFieldGroupPresent(item, names));
  for (const key of [names.value, names.hash, names.ref, names.size]) {
    if (source && source[key] !== undefined) base[key] = source[key];
    else delete base[key];
  }
  return base;
}

function itemUpdatedAt(item) {
  if (!item) return 0;
  return timestamp(item.updatedAt) || timestampMs(item.ts);
}

// Newest ms-clock across every mutation an item can carry (capture/edit, pin,
// title, capture-time correction). Compared against a tombstone's deletedAt to
// tell a genuinely newer re-add/edit apart from a stale pre-delete copy.
function itemMutationClock(item) {
  if (!item) return 0;
  return Math.max(
    itemUpdatedAt(item),
    pinUpdatedAt(item),
    titleUpdatedAt(item),
    timestampMs(item.tsUpdatedAt)
  );
}

function numpadSlotUpdatedAt(item) {
  if (!item || !item.pin) return 0;
  return timestamp(item.pin.numberUpdatedAt) || pinUpdatedAt(item) || itemUpdatedAt(item);
}

function isBetterNumpadClaim(item, current) {
  if (!current) return true;
  const itemSlotUpdatedAt = numpadSlotUpdatedAt(item);
  const currentSlotUpdatedAt = numpadSlotUpdatedAt(current);
  if (itemSlotUpdatedAt !== currentSlotUpdatedAt) return itemSlotUpdatedAt > currentSlotUpdatedAt;

  const itemUpdated = itemUpdatedAt(item);
  const currentUpdated = itemUpdatedAt(current);
  if (itemUpdated !== currentUpdated) return itemUpdated > currentUpdated;

  return String(itemKey(item)) > String(itemKey(current));
}

function removeNumpadSlot(item, updatedAt) {
  if (!item || !item.pin) return false;
  let changed = false;
  if (typeof item.pin.number === 'number') {
    delete item.pin.number;
    changed = true;
  }

  const nextUpdatedAt = timestamp(updatedAt);
  if (nextUpdatedAt) {
    if (timestamp(item.pin.numberUpdatedAt) < nextUpdatedAt) {
      item.pin.numberUpdatedAt = nextUpdatedAt;
      changed = true;
    }
    if (timestamp(item.pin.updatedAt) < nextUpdatedAt) {
      item.pin.updatedAt = nextUpdatedAt;
      changed = true;
    }
    if (timestamp(item.pinUpdatedAt) < nextUpdatedAt) {
      item.pinUpdatedAt = nextUpdatedAt;
      changed = true;
    }
    if (timestamp(item.updatedAt) < nextUpdatedAt) {
      item.updatedAt = nextUpdatedAt;
      changed = true;
    }
  }
  return changed;
}

function dedupeNumpadSlots(items) {
  let changed = false;
  const bestBySlot = new Map();
  for (const item of items) {
    const slot = numpadSlotOf(item);
    if (slot == null) continue;
    const current = bestBySlot.get(slot);
    if (isBetterNumpadClaim(item, current)) bestBySlot.set(slot, item);
  }
  for (const item of items) {
    const slot = numpadSlotOf(item);
    if (slot != null && bestBySlot.get(slot) !== item) {
      const winner = bestBySlot.get(slot);
      const resolvedAt = Math.max(numpadSlotUpdatedAt(item), numpadSlotUpdatedAt(winner)) + 1;
      if (removeNumpadSlot(item, resolvedAt)) changed = true;
    }
  }
  return changed;
}

function legacySlotMatchesItem(slot, item) {
  if (!slot || !item) return false;
  if (slot.type === 'image') return item.type === 'image' && item.image === slot.image;
  return item.type !== 'image' && String(item.text || '') === String(slot.text || '');
}

function setNumpadSlot(item, slot, updatedAt) {
  const pin = ensurePin(item);
  const nextUpdatedAt = timestamp(updatedAt);
  pin.number = slot;
  if (nextUpdatedAt) {
    pin.numberUpdatedAt = nextUpdatedAt;
    pin.updatedAt = nextUpdatedAt;
    item.pinUpdatedAt = nextUpdatedAt;
    item.updatedAt = nextUpdatedAt;
  }
}

function createHistoryItemForLegacySlot(slot, number, updatedAt) {
  const item = slot.type === 'image'
    ? { type: 'image', image: slot.image || '', ts: updatedAt / 1000 }
    : { type: 'text', text: String(slot.text || ''), ts: updatedAt / 1000 };
  setNumpadSlot(item, number, updatedAt);
  ensureItemId(item);
  return item;
}

function migrateLegacyNumpadSlots(history, oldSlots, options = {}) {
  const items = Array.isArray(history) ? history : [];
  if (!oldSlots || typeof oldSlots !== 'object') return { changed: false, migrated: 0, created: 0, skipped: 0 };

  for (const item of items) {
    migrateItemPin(item);
    ensureItemId(item);
  }

  const now = timestamp(options.now) || Date.now();
  let changed = false;
  let migrated = 0;
  let created = 0;
  let skipped = 0;

  for (const [numStr, rawSlot] of Object.entries(oldSlots)) {
    const slotNumber = Number.parseInt(numStr, 10);
    if (!Number.isInteger(slotNumber) || slotNumber < 1 || slotNumber > 9 || !rawSlot) {
      skipped++;
      continue;
    }

    const slot = typeof rawSlot === 'string' ? { type: 'text', text: rawSlot } : rawSlot;
    const existingClaim = items.find(item => hasNumpadSlot(item, slotNumber));
    const match = items.find(item => legacySlotMatchesItem(slot, item));

    if (existingClaim && (!match || itemKey(existingClaim) !== itemKey(match))) {
      skipped++;
      continue;
    }
    if (existingClaim && match && itemKey(existingClaim) === itemKey(match)) {
      continue;
    }

    if (match) {
      setNumpadSlot(match, slotNumber, now);
      changed = true;
      migrated++;
      continue;
    }

    const createdItem = createHistoryItemForLegacySlot(slot, slotNumber, now);
    items.unshift(createdItem);
    changed = true;
    migrated++;
    created++;
  }

  if (dedupeNumpadSlots(items)) changed = true;
  return { changed, migrated, created, skipped };
}

// A new clip's tags (a new note, a fork, Keep both): callers pass them in stored form
// (main's normalizeTagNames); deleted tags are dropped here as well.
function groupsOnlyPin(groups, updatedAt, groupTombstones = []) {
  const deleted = groupTombstoneIndex(groupTombstones);
  const cleanGroups = keepUndeletedGroups(uniqueTags((Array.isArray(groups) ? groups : [])
    .map(group => Tags.cleanTagName(group))
    .filter(Boolean)), Infinity, deleted);
  if (!cleanGroups.length) return null;
  const ts = timestamp(updatedAt) || Date.now();
  return { groups: cleanGroups, updatedAt: ts, groupsUpdatedAt: ts };
}

function touchNumpadMetadata(item, updatedAt) {
  if (!item || !item.pin || typeof item.pin.number !== 'number') return;
  const ts = timestamp(updatedAt) || Date.now();
  item.pin.numberUpdatedAt = ts;
  item.pin.updatedAt = ts;
  item.pinUpdatedAt = ts;
  item.updatedAt = ts;
}

function moveIndexToFront(items, index) {
  if (index <= 0) return;
  const item = items.splice(index, 1)[0];
  items.unshift(item);
}

function applyTextEdit(items, options = {}) {
  const history = Array.isArray(items) ? items : [];
  const originalText = String(options.originalText || '');
  const newText = String(options.newText || '');
  const textChanged = newText !== originalText;
  const tombstoneIds = [];
  const supersedes = [];
  const titleEditRequested = options.originalTitle !== undefined || options.newTitle !== undefined;

  if (!textChanged && !titleEditRequested) return { changed: false, reason: 'unchanged', tombstoneIds };
  if (options.ignoreBlank !== false && !newText.trim()) return { changed: false, reason: 'blank', tombstoneIds };

  const now = timestamp(options.now) || Date.now();
  const nowSeconds = now / 1000;
  const id = String(options.id || '');
  const groupTombstones = options.groupTombstones || [];

  for (const item of history) {
    migrateItemPin(item);
    ensureItemId(item);
  }

  let currentIndex = id ? history.findIndex(item => itemKey(item) === id) : -1;
  // A base edited since this edit began (in another window or on another
  // device) is gone under its old id. Its newest version is found through the
  // edit lineage, so the fork below carries a conflict record against it and
  // the two can be merged, instead of a second copy with nothing to merge.
  if (currentIndex < 0 && id && options.supersedes) {
    const headId = supersedeMap(options.supersedes).get(id);
    if (headId) currentIndex = history.findIndex(item => item.type !== 'image' && itemKey(item) === headId);
  }
  const current = currentIndex >= 0 ? history[currentIndex] : null;
  const originalTitle = titleEditRequested
    ? (options.originalTitle !== undefined ? cleanTitle(options.originalTitle) : titleOf(current))
    : titleOf(current);
  const newTitle = titleEditRequested
    ? (options.newTitle !== undefined ? cleanTitle(options.newTitle) : originalTitle)
    : originalTitle;
  const titleChanged = titleEditRequested && newTitle !== originalTitle;
  if (!textChanged && !titleChanged) return { changed: false, reason: 'unchanged', tombstoneIds };
  const canUpdateCurrent = current && current.type !== 'image' && String(current.text || '') === originalText;
  const currentBefore = current ? conflictSnapshot(current, { id, text: originalText, title: originalTitle }) : null;
  const currentTitle = current ? titleOf(current) : '';
  const titleDiverged = !!(canUpdateCurrent && titleChanged && currentTitle !== originalTitle);
  const oldId = canUpdateCurrent ? itemKey(current) : '';
  const edited = canUpdateCurrent
    ? current
    : {
      type: 'text',
      text: originalText,
      ts: nowSeconds,
      updatedAt: now,
      pin: groupsOnlyPin(options.sourceGroups, now, groupTombstones),
    };

  if (edited.pin && !edited.pinUpdatedAt) edited.pinUpdatedAt = now;
  if (textChanged || !canUpdateCurrent) setInlineText(edited, newText);
  if (titleEditRequested) setTitleMetadata(edited, newTitle, now);
  edited.ts = nowSeconds;
  edited.updatedAt = now;
  edited.id = legacyContentKey(edited);
  touchNumpadMetadata(edited, now);

  const editedId = itemKey(edited);
  const existingIndex = history.findIndex(item => item !== edited && item.type !== 'image' && itemKey(item) === editedId);
  if (existingIndex >= 0) {
    const existing = history[existingIndex];
    const existingBefore = conflictSnapshot(existing);
    const existingPinUpdated = pinUpdatedAt(existing);
    const editedPinUpdated = pinUpdatedAt(edited);
    setInlineText(existing, newText);
    if (titleChanged || newTitle || titleOf(existing)) mergeTitleMetadata(existing, existing, edited);
    existing.id = editedId;
    existing.ts = nowSeconds;
    existing.updatedAt = now;
    existing.pin = mergePins(existing.pin, edited.pin, existingPinUpdated, editedPinUpdated, groupTombstones);
    existing.pinUpdatedAt = Math.max(pinUpdatedAt(existing), editedPinUpdated, existingPinUpdated) || undefined;
    if (canUpdateCurrent) {
      const removeIndex = history.indexOf(current);
      if (removeIndex >= 0) history.splice(removeIndex, 1);
      if (oldId && oldId !== editedId) {
        tombstoneIds.push(oldId);
        supersedes.push({ from: oldId, to: editedId, updatedAt: now });
      }
    }
    moveIndexToFront(history, history.indexOf(existing));
    dedupeNumpadSlots(history);
    const titleMergeConflict = titleConflict(existingBefore, edited);
    const conflict = current && (!canUpdateCurrent || titleDiverged || titleMergeConflict)
      ? withoutIdenticalSides({
        kind: titleDiverged || titleMergeConflict ? 'title' : 'editor',
        base: { id, type: 'text', text: originalText, title: originalTitle },
        left: titleMergeConflict ? existingBefore : (currentBefore || existingBefore),
        right: conflictSnapshot(edited, { text: newText, title: newTitle }),
        targetId: itemKey(existing),
      })
      : null;
    return {
      changed: true,
      reason: canUpdateCurrent || !current ? 'merged' : 'conflict_merged',
      item: existing,
      tombstoneIds,
      supersedes,
      conflict,
    };
  }

  if (canUpdateCurrent) {
    moveIndexToFront(history, history.indexOf(current));
    if (oldId && oldId !== editedId) {
      tombstoneIds.push(oldId);
      supersedes.push({ from: oldId, to: editedId, updatedAt: now });
    }
    dedupeNumpadSlots(history);
    return {
      changed: true,
      reason: 'updated',
      item: current,
      tombstoneIds,
      supersedes,
      conflict: titleDiverged
        ? {
          kind: 'title',
          base: { id, type: 'text', text: originalText, title: originalTitle },
          left: currentBefore,
          right: conflictSnapshot(current, { text: newText, title: newTitle }),
          targetId: itemKey(current),
        }
        : null,
    };
  }

  ensureItemId(edited);
  history.unshift(edited);
  dedupeNumpadSlots(history);
  return {
    changed: true,
    reason: id || originalText ? 'conflict_created' : 'created',
    item: edited,
    tombstoneIds,
    supersedes,
    conflict: current
      ? {
        kind: 'editor',
        base: { id, type: 'text', text: originalText, title: originalTitle },
        left: currentBefore,
        right: conflictSnapshot(edited, { text: newText, title: newTitle }),
        targetId: itemKey(edited),
      }
      : null,
  };
}

// The ids one note has worn across its edits (every supersede link, obsolete
// ones included, walked both ways) - built once, only when a merge drops a
// local item.
function lineageFamilies(list) {
  const neighbours = new Map();
  const link = (a, b) => { if (!neighbours.has(a)) neighbours.set(a, new Set()); neighbours.get(a).add(b); };
  for (const record of Array.isArray(list) ? list : []) {
    if (!record || !record.from || !record.to) continue;
    link(String(record.from), String(record.to));
    link(String(record.to), String(record.from));
  }
  return (id) => {
    const family = new Set([id]);
    const queue = [id];
    while (queue.length) for (const next of neighbours.get(queue.shift()) || []) if (!family.has(next)) { family.add(next); queue.push(next); }
    return family;
  };
}

// `report` (optional array) receives what the merge did to LOCAL history:
// { event: 'dropped', reason: 'deleted' | 'superseded' } for a local clip that
// is gone afterwards, { event: 'revived' } for a clip that came back over its
// own tombstone, and { event: 'drop_blocked' } when the lineage tripwire kept a
// clip. Remote copies that stay suppressed are routine and not reported.
function mergeHistories(local, remote, settings = {}, report = null) {
  local = Array.isArray(local) ? local : [];
  remote = Array.isArray(remote) ? remote : [];
  const deleted = tombstoneMap(settings.tombstones);
  const groupTombstones = settings.group_tombstones || [];
  const links = liveSupersedeLinks(settings.supersedes);
  const lineage = resolveSupersedeLinks(links);
  const allKeys = new Set();
  for (const item of [...local, ...remote]) {
    if (!item) continue;
    migrateItemPin(item);
    ensureItemId(item);
    allKeys.add(itemKey(item));
  }
  // Tags in stored form on both sides: a copy from an old build or a stale provider, a
  // restored backup, a tag deleted on another device. By copy (these are the live history
  // objects), and the raw rev kept so a delete recorded against the old form still matches.
  const ctx = tagContext(settings, itemTagLists(local, remote));
  const rawRevs = new Map();
  const normaliseSide = (list, isLocal) => list.map(item => {
    if (!item) return item;
    const next = normalizeItemTags(item, ctx);
    if (next !== item) {
      rawRevs.set(next, clipRevision(item));
      if (isLocal && report) report.push({ event: 'normalised', id: itemKey(item), split: groupsOf(item).some(g => ctx.splits.has(Tags.tagKey(g))) });
    }
    return next;
  });
  local = normaliseSide(local, true);
  remote = normaliseSide(remote, false);
  if (ctx.literals.size) {
    const localAt = new Map();
    local.forEach((item, i) => { if (item) localAt.set(itemKey(item), i); });
    remote = remote.map(item => {
      const i = item ? localAt.get(itemKey(item)) : undefined;
      if (i === undefined) return item;
      const [l, r] = rejoinLiterals(local[i], item, ctx.literals);
      if (l !== local[i]) {
        rawRevs.set(l, rawRevs.get(local[i]) || clipRevision(local[i]));
        if (report) report.push({ event: 'normalised', id: itemKey(l), split: false });
        local[i] = l;
      }
      if (r !== item) rawRevs.set(r, rawRevs.get(item) || clipRevision(item));
      return r;
    });
  }
  const merged = new Map();
  const pendingStaleByTarget = new Map();

  const foldPending = (targetKey) => {
    const pending = pendingStaleByTarget.get(targetKey);
    if (!pending || !merged.has(targetKey)) return;
    let target = merged.get(targetKey);
    for (const stale of pending) target = mergeSupersededStaleIntoTarget(target, stale, groupTombstones);
    merged.set(targetKey, target);
    pendingStaleByTarget.delete(targetKey);
  };

  const addItem = (item) => {
    if (!item) return;
    const key = itemKey(item);
    // A copy changed AFTER the edit that superseded its id (that text copied
    // again, or pinned/titled since) is not a stale version, so the lineage
    // must not fold it away; its own tombstone's version guard decides.
    const link = links.get(key);
    const reborn = link && itemMutationClock(item) > link.updatedAt + EDIT_TOMBSTONE_SLACK_MS;
    const targetKey = reborn ? undefined : lineage.get(key);
    if (targetKey && deleted.has(targetKey)) return;
    if (!targetKey || deletedAfterEdit(deleted.get(key), links.get(key))) {
      // Version-guarded tombstone: a delete only suppresses a copy whose own
      // mutation clock is at/older than the delete. A legitimately NEWER re-add
      // or edit of the same content-hash id beats the tombstone (no surprise
      // cross-device clobber); a stale pre-delete copy stays deleted.
      if (tombstoneSuppresses(deleted.get(key), item, rawRevs.get(item))) return;
    }

    if (targetKey && allKeys.has(targetKey)) {
      if (merged.has(targetKey)) {
        merged.set(targetKey, mergeSupersededStaleIntoTarget(merged.get(targetKey), item, groupTombstones));
      } else {
        const pending = pendingStaleByTarget.get(targetKey) || [];
        pending.push(item);
        pendingStaleByTarget.set(targetKey, pending);
      }
      return;
    }

    const existing = merged.get(key);
    merged.set(key, existing ? mergeItems(existing, item, groupTombstones) : item);
    foldPending(key);
  };

  for (const item of local) addItem(item);
  for (const item of remote) addItem(item);

  // If every provider lost the target of an edit lineage, keep the newest stale
  // old-id copy rather than converting an edit into data loss. The old-id
  // tombstone is an edit marker while supersedes exists, not a hard delete.
  for (const pending of pendingStaleByTarget.values()) {
    for (const item of pending) {
      const key = itemKey(item);
      if (deleted.has(lineage.get(key))) continue;
      const existing = merged.get(key);
      merged.set(key, existing ? mergeItems(existing, item, groupTombstones) : item);
    }
  }

  // Lineage tripwire: a merge may drop a local clip only for a delete the user
  // made (its own tombstone, or the head of its lineage, is an explicit delete)
  // or because a newer version of the same note survives. Anything else is a
  // merge rule losing a note - the 2026-09-29 class of bug - so keep the clip.
  const explicitDelete = (id) => {
    const tombstone = deleted.get(id);
    if (!tombstone) return false;
    const link = links.get(id);
    return !link || deletedAfterEdit(tombstone, link);
  };
  let familyOf = null;
  const localKeys = new Set();
  for (const item of local) {
    if (!item) continue;
    const key = itemKey(item);
    localKeys.add(key);
    if (merged.has(key)) continue;
    const head = lineage.get(key);
    if (explicitDelete(key) || (head && explicitDelete(head))) {
      if (report) report.push({ event: 'dropped', reason: 'deleted', id: key, item });
      continue;
    }
    if (!familyOf) familyOf = lineageFamilies(settings.supersedes);
    const survivor = [...familyOf(key)].find(id => id !== key && merged.has(id));
    if (survivor) {
      if (report) report.push({ event: 'dropped', reason: 'superseded', id: key, item, survivor });
      continue;
    }
    merged.set(key, item);
    if (report) report.push({ event: 'drop_blocked', id: key, item, head: head || null });
  }
  if (report) {
    for (const [key, item] of merged) {
      if (!localKeys.has(key) && deleted.has(key)) report.push({ event: 'revived', id: key, item, deletedAt: deleted.get(key).deletedAt });
    }
  }

  const result = [...merged.values()].sort((a, b) => (b.ts || 0) - (a.ts || 0));
  dedupeNumpadSlots(result);
  return result;
}

function sameNames(a, b) {
  const x = Array.isArray(a) ? a : [];
  const y = Array.isArray(b) ? b : [];
  return x.length === y.length && x.every((v, i) => v === y[i]);
}

// The flat-tags state of one device's files, PURE: the app runs it at load, the MCP helper
// at every read (so it agrees with the app even mid-update), and tests and the live-data
// replay call it directly. Items must already be through migrateItemPin.
// Before this device's cutover (settings.groups_flattened_at unset) a '/' in a tag name
// meant nesting, so each such name is retired into its parts (group_splits); after it, only
// the retired names are split (a name another device made with a plain '/' never is:
// group_literals). Then every tag list is put in stored form (normalizeTagList,
// normalizeItemTags). At the cutover the AI share list follows the unanimous rule: a tag is
// shared only if every name it came from was shared. The AI tag never comes from a split
// or another spelling (normalizeGroupSplits, renameAiTwins), so no clip can become
// AI-visible through it; a clip made visible through another shared tag unshares that tag.
// Returns { history, settings (patch), changed, report, undo }. history holds the very
// same objects for clips that did not change; undo lists each changed clip's old tags.
function planTagState(history, settings = {}, options = {}) {
  const now = Number(options.now) || Date.now();
  const aiName = AI_TAG_NAME;
  const aiKey = AI_TAG_KEY;
  const items = Array.isArray(history) ? history : [];
  const cutover = !(Number(settings.groups_flattened_at) > 0);
  const oldShared = Array.isArray(settings.groups_shared_with_ai) ? settings.groups_shared_with_ai.map(String) : [];
  const oldGroups = Array.isArray(settings.groups) ? settings.groups.map(String) : [];
  const itemLists = itemTagLists(items);
  let splits = normalizeGroupSplits(settings.group_splits);
  const retired = [];
  if (cutover) {
    const known = new Set([...splits, ...normalizeGroupLiterals(settings.group_literals)].map(r => Tags.tagKey(r.name)));
    for (const list of [oldGroups, ...itemLists, oldShared]) {
      for (const raw of list) {
        const name = String(raw == null ? '' : raw);
        const key = Tags.tagKey(name);
        if (!name.includes('/') || !key || known.has(key)) continue;
        known.add(key);
        retired.push({ name: Tags.cleanTagName(name), parts: Tags.nestedNameParts(name), at: now });
      }
    }
    if (retired.length) splits = normalizeGroupSplits([...splits, ...retired]);
  }
  const ctx = tagContext({ ...settings, group_splits: splits }, [...itemLists, oldShared]);

  const nextHistory = items.slice();
  const undo = [];
  for (let i = 0; i < items.length; i++) {
    const item = items[i];
    const next = normalizeItemTags(item, ctx);
    if (next === item) continue;
    nextHistory[i] = next;
    undo.push({ id: itemKey(item), groups: groupsOf(item).slice() });
  }
  const groups = normalizeTagList(oldGroups, ctx);

  let shared;
  const report = { cutover, retired: retired.map(r => r.name), clipsChanged: undo.length, unsharedToProtect: [] };
  if (cutover) {
    const oldSet = new Set(oldShared);
    const sources = new Map();
    for (const list of [oldGroups, ...itemLists, oldShared]) {
      for (const raw of list) {
        const name = String(raw == null ? '' : raw);
        for (const part of Tags.expandTagNames(renameAiTwins([name]), ctx.splits, null)) {
          const key = Tags.tagKey(part);
          if (!key) continue;
          if (!sources.has(key)) sources.set(key, new Set());
          sources.get(key).add(name);
        }
      }
    }
    const unanimous = key => key === aiKey || [...(sources.get(key) || [])].every(name => oldSet.has(name));
    shared = [];
    const seen = new Set();
    for (const raw of oldShared) {
      for (const name of Tags.expandTagNames(renameAiTwins([raw]), ctx.splits, ctx.spellings)) {
        const key = Tags.tagKey(name);
        if (!key || seen.has(key)) continue;
        seen.add(key);
        if (unanimous(key)) shared.push(name);
      }
    }
    // Nothing private may become visible: before = the old exact-name rule.
    const wasVisible = item => groupsOf(item).some(g => g === aiName || oldSet.has(g));
    let sharedKeys = new Set([aiKey, ...shared.map(Tags.tagKey)]);
    const isVisible = item => groupsOf(item).some(g => sharedKeys.has(Tags.tagKey(g)));
    for (let i = 0; i < nextHistory.length; i++) {
      if (wasVisible(items[i]) || !isVisible(nextHistory[i])) continue;
      for (const g of groupsOf(nextHistory[i])) {
        const key = Tags.tagKey(g);
        if (key !== aiKey && sharedKeys.has(key)) report.unsharedToProtect.push(g);
      }
      const drop = new Set(report.unsharedToProtect.map(Tags.tagKey));
      shared = shared.filter(name => !drop.has(Tags.tagKey(name)));
      sharedKeys = new Set([aiKey, ...shared.map(Tags.tagKey)]);
    }
    report.visibleBefore = items.filter(wasVisible).length;
    report.visibleAfter = nextHistory.filter(isVisible).length;
  } else {
    // After the cutover a retired name has no meaning of its own: never share by it.
    shared = Tags.expandTagNames(renameAiTwins(oldShared.filter(name => !ctx.splits.has(Tags.tagKey(name)))), null, ctx.spellings);
  }

  const patch = { groups, group_splits: splits, groups_shared_with_ai: shared };
  if (cutover) {
    patch.groups_flattened_at = now;
    // Several tag chips now join with AND by default: forget a remembered group join once.
    const joins = settings.facet_joins && typeof settings.facet_joins === 'object' ? settings.facet_joins : null;
    if (joins && 'group' in joins) {
      const next = { ...joins };
      delete next.group;
      patch.facet_joins = next;
    }
  }
  report.groupsBefore = oldGroups.length;
  report.groupsAfter = groups.length;
  report.sharedBefore = oldShared.length;
  report.sharedAfter = shared.length;
  report.spellingsMerged = [...ctx.spellings.keys()].length;
  const changed = cutover || undo.length > 0 || !sameNames(groups, oldGroups)
    || !sameNames(shared, oldShared) || JSON.stringify(splits) !== JSON.stringify(settings.group_splits || []);
  return { history: nextHistory, settings: patch, changed, report, undo };
}

// A device on its first flat start cannot tell a name made with a plain '/' on another
// device ('AC/DC', recorded in group_literals) from an old nested one, so its cutover split
// it, without moving a clock. So two copies of one clip with the SAME tags clock, one with
// the name and the other with its parts instead, are one tag list seen two ways (a real
// edit moves the clock): the parts go back into the name before the copies merge, on
// whichever device meets them first. PURE: returns [a, b], each the same object when
// unchanged, else a copy.
function rejoinLiterals(a, b, literals) {
  if (!a || !b || !a.pin || !b.pin || !literals || !literals.size) return [a, b];
  if (groupState(a.pin).updatedAt !== groupState(b.pin).updatedAt) return [a, b];
  const oa = groupsOf(a);
  const ob = groupsOf(b);
  let ga = oa;
  let gb = ob;
  const has = (list, name) => list.some(g => Tags.sameTag(g, name));
  for (const { name, parts } of literals.values()) {
    const inA = has(ga, name);
    if (inA === has(gb, name)) continue;
    const withName = inA ? ga : gb;
    const withParts = inA ? gb : ga;
    if (!parts.every(p => has(withParts, p))) continue;
    const at = withParts.findIndex(g => parts.some(p => Tags.sameTag(g, p)));
    const kept = withParts.filter(g => !parts.some(p => Tags.sameTag(g, p)) || has(withName, g));
    const joined = [...kept.slice(0, at), name, ...kept.slice(at)];
    if (inA) gb = joined; else ga = joined;
  }
  const withGroups = (item, groups) => ({ ...item, pin: { ...item.pin, groups } });
  return [ga === oa ? a : withGroups(a, ga), gb === ob ? b : withGroups(b, gb)];
}

// The tag list after a late cutover split a plain '/' name: the parts it listed for it
// ('AC', 'DC') leave the list once no clip holds them (the list is a union across devices,
// so without this they would stay as empty tags everywhere). Only parts of a name some
// device actually split (its split record exists). heldNames: every tag on the clips in
// play. The same array when nothing goes.
function pruneLiteralParts(groups, settings = {}, heldNames = []) {
  const list = Array.isArray(groups) ? groups : [];
  const literals = normalizeGroupLiterals(settings.group_literals);
  if (!literals.length) return list;
  const splitBy = new Map(normalizeGroupSplits(settings.group_splits).map(r => [Tags.tagKey(r.name), r.parts]));
  const held = new Set((heldNames || []).map(Tags.tagKey));
  const listed = new Set(list.map(Tags.tagKey));
  const drop = new Set();
  for (const { name } of literals) {
    const parts = splitBy.get(Tags.tagKey(name));
    if (!parts || !listed.has(Tags.tagKey(name))) continue;
    for (const part of parts) if (!held.has(Tags.tagKey(part))) drop.add(Tags.tagKey(part));
  }
  if (!drop.size) return list;
  const kept = list.filter(name => !drop.has(Tags.tagKey(name)));
  return kept.length === list.length ? list : kept;
}

// The late device's own clips: once the record arrives, the name goes back on the clips its
// cutover split, from that cutover's undo ledger ([{ id, groups }]: each changed clip's old
// tags), only where a clip still holds exactly what the cutover gave it (rejoinLiterals
// needs both copies to meet, and an unchanged copy is never sent again). PURE, never moves
// a clock. Returns { history (the same array when nothing changes), ids }.
function unsplitLiterals(history, ledger, settings = {}) {
  const items = Array.isArray(history) ? history : [];
  const literals = new Set(normalizeGroupLiterals(settings.group_literals).map(r => Tags.tagKey(r.name)));
  const byId = new Map();
  for (const entry of Array.isArray(ledger) ? ledger : []) {
    if (!entry || !entry.id || !Array.isArray(entry.groups) || byId.has(String(entry.id))) continue;
    if (entry.groups.some(g => literals.has(Tags.tagKey(g)))) byId.set(String(entry.id), entry.groups.map(String));
  }
  if (!byId.size) return { history: items, ids: [] };
  const current = tagContext(settings, itemTagLists(items));
  const atCutover = { ...current, splits: groupSplitMap(settings.group_splits) };
  const flattenedAt = Number(settings.groups_flattened_at) || Infinity;
  const keys = list => list.map(Tags.tagKey).sort().join('\n');
  let next = null;
  const ids = [];
  items.forEach((item, i) => {
    const old = item && item.pin ? byId.get(itemKey(item)) : null;
    if (!old || groupState(item.pin).updatedAt > flattenedAt) return;
    const held = keys(groupsOf(item));
    if (held !== keys(normalizeTagList(old, atCutover))) return;
    const groups = normalizeTagList(old, current);
    if (keys(groups) === held) return;
    const pin = { ...item.pin };
    if (groups.length) pin.groups = groups;
    else delete pin.groups;
    if (!next) next = items.slice();
    next[i] = { ...item, pin };
    ids.push(itemKey(item));
  });
  return { history: next || items, ids };
}

// A split record that reaches a device after its own cutover (another device's late
// cutover) turns a name held here as one tag into its parts. The cutover's share rule
// covers it too: a part stays shared with AI only if the retired name was shared here.
// Only unshares, never shares. Returns { shared (the same array when nothing changes),
// unshared }.
function shareListAfterNewSplits(shared, newSplits, heldNames) {
  const list = Array.isArray(shared) ? shared : [];
  const held = new Set((heldNames || []).map(Tags.tagKey));
  const sharedKeys = new Set(list.map(Tags.tagKey));
  const drop = new Set();
  for (const record of newSplits || []) {
    const key = Tags.tagKey(record && record.name);
    if (!key || !held.has(key) || sharedKeys.has(key)) continue;
    for (const part of record.parts || []) if (sharedKeys.has(Tags.tagKey(part))) drop.add(Tags.tagKey(part));
  }
  if (!drop.size) return { shared: list, unshared: [] };
  return {
    shared: list.filter(name => !drop.has(Tags.tagKey(name))),
    unshared: list.filter(name => drop.has(Tags.tagKey(name))),
  };
}

// AI share switches, synced per tag: { [tagKey]: { name, shared, at } }. The newest flip
// wins; at the same instant unshared wins (never share by accident).
function normalizeShareStamps(value) {
  const out = {};
  if (!value || typeof value !== 'object') return out;
  for (const [rawKey, stamp] of Object.entries(value)) {
    if (!stamp || typeof stamp !== 'object') continue;
    const name = Tags.cleanTagName(stamp.name || rawKey);
    const key = Tags.tagKey(name);
    const at = Number(stamp.at) || 0;
    if (!key || !at) continue;
    const next = { name, shared: !!stamp.shared, at };
    const existing = out[key];
    if (!existing || at > existing.at || (at === existing.at && existing.shared && !next.shared)) out[key] = next;
  }
  return out;
}

function mergeShareStamps(local, remote) {
  const a = normalizeShareStamps(local);
  const b = normalizeShareStamps(remote);
  const out = { ...a };
  for (const [key, stamp] of Object.entries(b)) {
    const existing = out[key];
    if (!existing || stamp.at > existing.at || (stamp.at === existing.at && existing.shared && !stamp.shared)) out[key] = stamp;
  }
  return out;
}

// A share list with every stamped flip applied (spellings: tagKey -> stored name).
function applyShareStamps(list, stamps, spellings = null) {
  const current = Array.isArray(list) ? list : [];
  const normalized = normalizeShareStamps(stamps);
  const keys = Object.keys(normalized);
  if (!keys.length) return current;
  let next = current.filter(name => {
    const stamp = normalized[Tags.tagKey(name)];
    return !stamp || stamp.shared;
  });
  const present = new Set(next.map(Tags.tagKey));
  for (const key of keys) {
    const stamp = normalized[key];
    if (stamp.shared && !present.has(key)) {
      next.push((spellings && spellings.get(key)) || stamp.name);
      present.add(key);
    }
  }
  return sameNames(next, current) ? current : next;
}

function planHistoryPrune(history, settings = {}, options = {}) {
  const now = options.now != null ? Number(options.now) : Date.now() / 1000;
  const maxAgeDays = Number(settings.max_age_days);
  const maxAge = Number.isFinite(maxAgeDays) && maxAgeDays > 0 ? maxAgeDays * 86400 : Infinity;
  const planned = [];
  const survivors = Array.isArray(history) ? history.map((item, index) => ({ item, index })) : [];

  for (let i = survivors.length - 1; i >= 0; i--) {
    const { item, index } = survivors[i];
    if (!isPinned(item) && (now - (Number(item && item.ts) || 0)) > maxAge) {
      planned.push({ index, reason: 'age' });
      survivors.splice(i, 1);
    }
  }

  return planned.sort((a, b) => b.index - a.index);
}

function isDestructivePrune(history, plan, options = {}) {
  const total = Array.isArray(history) ? history.length : 0;
  const count = Array.isArray(plan) ? plan.length : 0;
  if (!total || !count) return false;
  const minItems = Number(options.minItems) || 50;
  const fraction = Number(options.fraction) || DEFAULT_DESTRUCTIVE_PRUNE_FRACTION;
  return count >= minItems && count / total >= fraction;
}

// settings.groups across a merge: one entry per tag in stored form (ctx: tagContext of
// the merged settings), local order first. Without ctx: deleted tags dropped, one per tag.
function mergeGroups(local, remote, groupTombstones = [], ctx = null) {
  const all = [...(local || []), ...(remote || [])];
  return normalizeTagList(all, ctx || tagContext({ group_tombstones: groupTombstones }, [all]));
}

module.exports = {
  DEFAULT_SETTINGS,
  TOMBSTONE_MAX_AGE_MS,
  textHashForText,
  itemTextHash,
  itemHasVerifiedFullText,
  hasVerifiedFullValue,
  valueHash,
  blobFieldNames,
  RICH_BLOB_FIELDS,
  migrateItemPin,
  isPinned,
  numpadSlotOf,
  groupsOf,
  titleOf,
  titleUpdatedAt,
  setTitleMetadata,
  mergeTitleMetadata,
  conflictSnapshot,
  titleConflict,
  hasNumpadSlot,
  ensurePin,
  setInlineText,
  legacyContentKey,
  ensureItemId,
  itemKey,
  clipRevision,
  tombstoneSuppresses,
  normalizeTombstones,
  normalizeGroupTombstones,
  normalizeSupersedes,
  supersedeMap,
  tombstoneIds,
  tombstoneMap,
  planHistoryPrune,
  isDestructivePrune,
  mergePins,
  pinUpdatedAt,
  mergeItems,
  itemMutationClock,
  mergeHistories,
  mergeGroups,
  uniqueTags,
  groupTombstoneIndex,
  deleteStrips,
  normalizeGroupSplits,
  normalizeGroupLiterals,
  splitMapOf,
  rejoinLiterals,
  unsplitLiterals,
  pruneLiteralParts,
  shareListAfterNewSplits,
  AI_TAG_NAME,
  groupSplitMap,
  tagContext,
  itemTagLists,
  normalizeTagList,
  normalizeItemTags,
  tagInputNames,
  planTagState,
  normalizeShareStamps,
  mergeShareStamps,
  applyShareStamps,
  dedupeNumpadSlots,
  migrateLegacyNumpadSlots,
  applyTextEdit,
};
