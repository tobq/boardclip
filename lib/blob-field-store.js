'use strict';

const fs = require('fs');
const path = require('path');
const blobStore = require('./blob-store');
const clipboardModel = require('./clipboard-model');

const DEFAULT_THRESHOLD_BYTES = 64 * 1024;

// ONE content-addressed blob store, instantiated once per clipboard payload
// FIELD (text, html, rtf). Hashing, atomic writes, hydrate, externalize-above-
// threshold, sync filtering and unreferenced cleanup live here exactly once, so
// a fourth clipboard format is a config object rather than a fourth copy of the
// mechanics. lib/blob-store.js still owns the raw file primitives.
//
// The one real behavioural axis is PREVIEW, and it is not cosmetic:
//   text  (previewChars > 0) keeps a truncated preview, so a missing blob still
//         renders something in the list and the user does not see an empty clip.
//   html/rtf (previewChars = 0) must NOT. A truncated markup payload is worse
//         than none — unbalanced tags and broken RTF groups paste as visible
//         garbage — so a missing rich blob degrades to ABSENT, which makes the
//         paste fall back to plain text. That is the correct failure direction.
//
// dropWhenEmpty removes the field entirely when there is nothing to store, so
// every plain-text clip in the history file does not grow two empty strings.
function makeBlobFieldStore(config) {
  const field = String(config.field || '');
  const dirname = String(config.dirname || '');
  const ext = String(config.ext || '');
  const previewChars = Number(config.previewChars) || 0;
  const dropWhenEmpty = !!config.dropWhenEmpty;
  const defaultThreshold = Number(config.thresholdBytes) || DEFAULT_THRESHOLD_BYTES;
  const names = clipboardModel.blobFieldNames(field);
  const REF_RE = new RegExp(`^[a-f0-9]{64}\\.${ext}$`, 'i');
  const MISSING_FLAG = `__${field}BlobMissing`;
  const LOADED_FLAG = `__${field}BlobLoaded`;

  function refForHash(hash) {
    const normalized = String(hash || '').trim().toLowerCase();
    return /^[a-f0-9]{64}$/.test(normalized) ? `${normalized}.${ext}` : '';
  }

  function safeRef(ref) {
    const value = path.basename(String(ref || '').trim());
    return REF_RE.test(value) ? value.toLowerCase() : '';
  }

  // Every path helper refuses a falsy baseDir. Without this a missing directory
  // would make path.join('', ref) resolve to a RELATIVE path and read or write
  // blobs next to the process cwd.
  function pathForRef(baseDir, ref) {
    if (!baseDir) return '';
    const safe = safeRef(ref);
    return safe ? path.join(baseDir, safe) : '';
  }

  function preview(value) {
    return previewChars ? String(value || '').slice(0, previewChars) : '';
  }

  function byteLength(value) {
    return Buffer.byteLength(String(value || ''), 'utf8');
  }

  function markRuntime(item, key, value) {
    Object.defineProperty(item, key, {
      value,
      writable: true,
      configurable: true,
      enumerable: false,
    });
  }

  function clearRuntimeFlags(item) {
    try { delete item[MISSING_FLAG]; } catch {}
    try { delete item[LOADED_FLAG]; } catch {}
  }

  function clearMetadata(copy) {
    delete copy[names.hash];
    delete copy[names.ref];
    delete copy[names.size];
    delete copy[names.preview];
  }

  function setValue(target, value) {
    if (dropWhenEmpty && !value) delete target[names.value];
    else target[names.value] = value;
  }

  function writeBlob(baseDir, value, hash) {
    if (!baseDir) return '';
    blobStore.ensureDir(baseDir);
    const ref = refForHash(hash || clipboardModel.valueHash(value));
    if (!ref) return '';
    const filePath = pathForRef(baseDir, ref);
    if (!filePath) return '';
    if (!fs.existsSync(filePath)) blobStore.atomicWriteFile(filePath, String(value || ''));
    return ref;
  }

  function readBlob(baseDir, item) {
    if (!item || item.type === 'image') return null;
    const ref = safeRef(item[names.ref]) || refForHash(item[names.hash]);
    const filePath = pathForRef(baseDir, ref);
    if (!filePath) return null;
    try {
      const value = fs.readFileSync(filePath, 'utf8');
      if (item[names.hash] && clipboardModel.valueHash(value) !== String(item[names.hash]).toLowerCase()) {
        return null;
      }
      return value;
    } catch {
      return null;
    }
  }

  function hydrateItem(item, baseDir) {
    if (!item || item.type === 'image') return item;
    clearRuntimeFlags(item);
    if (!item[names.ref] && !item[names.hash]) {
      setValue(item, String(item[names.value] || ''));
      return item;
    }

    const value = readBlob(baseDir, item);
    if (value != null) {
      item[names.value] = value;
      markRuntime(item, LOADED_FLAG, true);
      return item;
    }

    setValue(item, previewChars ? String(item[names.preview] || item[names.value] || '') : '');
    markRuntime(item, MISSING_FLAG, true);
    return item;
  }

  function hydrateHistory(items, baseDir) {
    if (!Array.isArray(items)) return [];
    for (const item of items) hydrateItem(item, baseDir);
    return items;
  }

  function prepareItemForStorage(item, baseDir, options = {}) {
    if (!item || item.type === 'image') return { ...(item || {}) };
    const threshold = Number(options.thresholdBytes) || defaultThreshold;

    // Metadata present but the in-memory value is not the full payload (a
    // missing blob, or a peer's preview-only copy). Keep the metadata so the
    // blob can still be fetched from a peer; never overwrite it with a partial.
    if ((item[names.hash] || item[names.ref]) && !clipboardModel.hasVerifiedFullValue(item, names)) {
      const copy = { ...item };
      const kept = previewChars ? String(item[names.preview] || item[names.value] || '') : '';
      setValue(copy, kept);
      if (previewChars && !copy[names.preview]) copy[names.preview] = kept;
      clearRuntimeFlags(copy);
      return copy;
    }

    const value = String(item[names.value] || '');
    const bytes = byteLength(value);
    const shouldExternalize = bytes > threshold || !!item[names.ref];
    if (!shouldExternalize) {
      const copy = { ...item };
      setValue(copy, value);
      clearMetadata(copy);
      clearRuntimeFlags(copy);
      return copy;
    }

    const hash = clipboardModel.valueHash(value);
    try {
      const ref = writeBlob(baseDir, value, hash);
      if (!ref) throw new Error('Invalid blob reference');
      const copy = { ...item };
      setValue(copy, preview(value));
      copy[names.hash] = hash;
      copy[names.ref] = ref;
      copy[names.size] = bytes;
      if (previewChars) copy[names.preview] = preview(value);
      clearRuntimeFlags(copy);
      return copy;
    } catch {
      // Corruption guard: if the blob cannot be written, keep the full value
      // inline rather than shipping a reference to a file that does not exist.
      const copy = { ...item };
      copy[names.value] = value;
      clearMetadata(copy);
      clearRuntimeFlags(copy);
      return copy;
    }
  }

  function prepareHistoryForStorage(items, baseDir, options = {}) {
    if (baseDir) { try { blobStore.ensureDir(baseDir); } catch {} }
    return (Array.isArray(items) ? items : []).map(item => prepareItemForStorage(item, baseDir, options));
  }

  function refsOf(items) {
    const refs = new Set();
    for (const item of Array.isArray(items) ? items : []) {
      const ref = safeRef(item && item[names.ref]);
      if (ref) refs.add(ref);
    }
    return [...refs];
  }

  function syncBlobs(localDir, remoteDir) {
    if (!localDir || !remoteDir) return;
    blobStore.syncMissingFiles(localDir, remoteDir, { filter: name => !!safeRef(name) });
  }

  function removeLocalBlobIfUnreferenced(item, items, baseDir) {
    if (!item || item.type === 'image' || !baseDir) return;
    const ref = safeRef(item[names.ref]) || refForHash(item[names.hash]);
    if (!ref) return;
    const stillUsed = (items || []).some(candidate => candidate !== item && (
      safeRef(candidate && candidate[names.ref]) === ref ||
      refForHash(candidate && candidate[names.hash]) === ref
    ));
    if (stillUsed) return;
    try { fs.rmSync(pathForRef(baseDir, ref), { force: true }); } catch {}
  }

  // True when the item advertises this payload but hydrate could not produce it
  // (the blob file is absent locally — typically synced metadata whose blob has
  // not arrived yet). The distinction matters: such a payload is ADVERTISED but
  // not USABLE, so a fresh capture carrying the real bytes should replace it.
  function isBlobMissing(item) {
    return !!(item && item[MISSING_FLAG]);
  }

  // Remove the whole field group. Used when replacing one payload with another:
  // a leftover ref/hash beside a new inline value describes different content,
  // and prepareItemForStorage would then reject the new value as unverified.
  function clearField(item) {
    if (!item) return item;
    delete item[names.value];
    clearMetadata(item);
    clearRuntimeFlags(item);
    return item;
  }

  function setInlineValue(item, value) {
    if (!item || item.type === 'image') return item;
    setValue(item, String(value || ''));
    clearMetadata(item);
    clearRuntimeFlags(item);
    return item;
  }

  return {
    field,
    dirname,
    ext,
    names,
    previewChars,
    thresholdBytes: defaultThreshold,
    refForHash,
    safeRef,
    preview,
    hydrateItem,
    hydrateHistory,
    prepareItemForStorage,
    prepareHistoryForStorage,
    refsOf,
    syncBlobs,
    removeLocalBlobIfUnreferenced,
    setInlineValue,
    isBlobMissing,
    clearField,
  };
}

module.exports = { makeBlobFieldStore, DEFAULT_THRESHOLD_BYTES };
