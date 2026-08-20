'use strict';

const { makeBlobFieldStore, DEFAULT_THRESHOLD_BYTES } = require('./blob-field-store');

// Every payload blob a text clip can carry, in one place. main.js drives storage,
// sync and p2p off this list, so adding a format touches this file and nothing
// else. `text` stays first: it is the identity payload (a clip's id is the hash
// of its text) and the only one with a preview.
const TEXT_BLOB_DIRNAME = 'clipboard-text';
const HTML_BLOB_DIRNAME = 'clipboard-html';
const RTF_BLOB_DIRNAME = 'clipboard-rtf';
const TEXT_PREVIEW_CHARS = 1024;

const text = makeBlobFieldStore({
  field: 'text',
  dirname: TEXT_BLOB_DIRNAME,
  ext: 'txt',
  previewChars: TEXT_PREVIEW_CHARS,
  thresholdBytes: DEFAULT_THRESHOLD_BYTES,
});

const html = makeBlobFieldStore({
  field: 'html',
  dirname: HTML_BLOB_DIRNAME,
  ext: 'html',
  previewChars: 0,
  dropWhenEmpty: true,
  thresholdBytes: DEFAULT_THRESHOLD_BYTES,
});

const rtf = makeBlobFieldStore({
  field: 'rtf',
  dirname: RTF_BLOB_DIRNAME,
  ext: 'rtf',
  previewChars: 0,
  dropWhenEmpty: true,
  thresholdBytes: DEFAULT_THRESHOLD_BYTES,
});

const FIELD_STORES = [text, html, rtf];
const RICH_FIELD_STORES = [html, rtf];
const BY_FIELD = new Map(FIELD_STORES.map(store => [store.field, store]));

// Callers may pass either the full { text, html, rtf } directory map or, for the
// legacy text-only call shape, a bare text directory string. A store handed no
// directory no-ops rather than resolving a relative path.
function dirFor(dirs, field) {
  if (!dirs) return '';
  if (typeof dirs === 'string') return field === 'text' ? dirs : '';
  return dirs[field] || '';
}

function hydrateItem(item, dirs) {
  for (const store of FIELD_STORES) store.hydrateItem(item, dirFor(dirs, store.field));
  return item;
}

function hydrateHistory(items, dirs) {
  if (!Array.isArray(items)) return [];
  for (const item of items) hydrateItem(item, dirs);
  return items;
}

function prepareItemForStorage(item, dirs, options = {}) {
  let current = item;
  for (const store of FIELD_STORES) {
    current = store.prepareItemForStorage(current, dirFor(dirs, store.field), options);
  }
  return current;
}

function prepareHistoryForStorage(items, dirs, options = {}) {
  return (Array.isArray(items) ? items : []).map(item => prepareItemForStorage(item, dirs, options));
}

function removeUnreferencedBlobs(item, items, dirs) {
  for (const store of FIELD_STORES) {
    store.removeLocalBlobIfUnreferenced(item, items, dirFor(dirs, store.field));
  }
}

// The rich payloads a newly captured clip can donate to an existing entry. A
// re-copy of identical text is deduped by id, so without this the second copy's
// formatting would be silently dropped.
function richPayloadOf(item) {
  const payload = {};
  if (!item || item.type === 'image') return payload;
  for (const store of RICH_FIELD_STORES) {
    const { value, hash, ref, size } = store.names;
    if (item[value]) payload[value] = item[value];
    if (item[hash]) payload[hash] = item[hash];
    if (item[ref]) payload[ref] = item[ref];
    if (item[size]) payload[size] = item[size];
  }
  return payload;
}

function hasRichPayload(item, field) {
  const store = BY_FIELD.get(field);
  if (!store || !item || item.type === 'image') return false;
  return !!(item[store.names.value] || item[store.names.ref] || item[store.names.hash]);
}

// A payload is USABLE only when the bytes are actually reachable. An item can
// advertise a format (htmlRef/htmlHash present) while hydrate failed to resolve
// the blob — synced metadata whose blob has not arrived yet. That is metadata,
// not content, so a fresh capture carrying the real bytes must be allowed to
// replace it. An UNHYDRATED item carries no flag and is treated as usable,
// which is the safe default: never discard a payload not proven missing.
function richPayloadUsable(item, field) {
  const store = BY_FIELD.get(field);
  if (!store || !hasRichPayload(item, field)) return false;
  return !store.isBlobMissing(item);
}

// Copy rich payloads from `source` onto `target` for formats the target lacks.
// Never downgrades a usable payload to absent: the older clip may hold the only
// copy of a blob, and a plain-text re-copy of the same words is not evidence the
// formatting is gone. Returns true when anything changed.
function adoptRichPayload(target, source) {
  if (!target || !source || target.type === 'image' || source.type === 'image') return false;
  let changed = false;
  for (const store of RICH_FIELD_STORES) {
    if (!richPayloadUsable(source, store.field)) continue;
    if (richPayloadUsable(target, store.field)) continue;
    // Clear the whole group first. Replacing a missing-blob payload leaves a
    // stale ref/hash beside the new inline value otherwise, which describes
    // different content — prepareItemForStorage would then judge the new value
    // unverified and refuse to store it.
    store.clearField(target);
    for (const key of [store.names.value, store.names.hash, store.names.ref, store.names.size]) {
      if (source[key] === undefined) continue;
      target[key] = source[key];
      changed = true;
    }
  }
  return changed;
}

module.exports = {
  TEXT_BLOB_DIRNAME,
  HTML_BLOB_DIRNAME,
  RTF_BLOB_DIRNAME,
  TEXT_PREVIEW_CHARS,
  FIELD_STORES,
  RICH_FIELD_STORES,
  text,
  html,
  rtf,
  storeFor: field => BY_FIELD.get(field),
  dirFor,
  hydrateItem,
  hydrateHistory,
  prepareItemForStorage,
  prepareHistoryForStorage,
  removeUnreferencedBlobs,
  richPayloadOf,
  hasRichPayload,
  richPayloadUsable,
  adoptRichPayload,
};
