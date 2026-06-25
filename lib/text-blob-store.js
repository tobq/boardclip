'use strict';

const fs = require('fs');
const path = require('path');
const blobStore = require('./blob-store');
const clipboardModel = require('./clipboard-model');

const TEXT_BLOB_THRESHOLD_BYTES = 64 * 1024;
const TEXT_PREVIEW_CHARS = 1024;
const TEXT_BLOB_DIRNAME = 'clipboard-text';
const TEXT_REF_RE = /^[a-f0-9]{64}\.txt$/i;

function textRefForHash(hash) {
  const normalized = String(hash || '').trim().toLowerCase();
  return /^[a-f0-9]{64}$/.test(normalized) ? `${normalized}.txt` : '';
}

function safeTextRef(ref) {
  const value = path.basename(String(ref || '').trim());
  return TEXT_REF_RE.test(value) ? value.toLowerCase() : '';
}

function textPathForRef(baseDir, ref) {
  const safe = safeTextRef(ref);
  return safe ? path.join(baseDir, safe) : '';
}

function textPreview(text) {
  return String(text || '').slice(0, TEXT_PREVIEW_CHARS);
}

function textByteLength(text) {
  return Buffer.byteLength(String(text || ''), 'utf8');
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
  try { delete item.__textBlobMissing; } catch {}
  try { delete item.__textBlobLoaded; } catch {}
}

function writeTextBlob(baseDir, text, hash) {
  blobStore.ensureDir(baseDir);
  const ref = textRefForHash(hash || clipboardModel.textHashForText(text));
  if (!ref) return '';
  const filePath = textPathForRef(baseDir, ref);
  if (!filePath) return '';
  if (!fs.existsSync(filePath)) blobStore.atomicWriteFile(filePath, String(text || ''));
  return ref;
}

function readTextBlob(baseDir, item) {
  if (!item || item.type === 'image') return null;
  const ref = safeTextRef(item.textRef) || textRefForHash(item.textHash);
  const filePath = textPathForRef(baseDir, ref);
  if (!filePath) return null;
  try {
    const text = fs.readFileSync(filePath, 'utf8');
    if (item.textHash && clipboardModel.textHashForText(text) !== String(item.textHash).toLowerCase()) {
      return null;
    }
    return text;
  } catch {
    return null;
  }
}

function hydrateTextItem(item, baseDir) {
  if (!item || item.type === 'image') return item;
  clearRuntimeFlags(item);
  if (!item.textRef && !item.textHash) {
    item.text = String(item.text || '');
    return item;
  }

  const text = readTextBlob(baseDir, item);
  if (text != null) {
    item.text = text;
    markRuntime(item, '__textBlobLoaded', true);
    return item;
  }

  item.text = String(item.textPreview || item.text || '');
  markRuntime(item, '__textBlobMissing', true);
  return item;
}

function hydrateHistory(items, baseDir) {
  if (!Array.isArray(items)) return [];
  for (const item of items) hydrateTextItem(item, baseDir);
  return items;
}

function prepareTextItemForStorage(item, baseDir, options = {}) {
  if (!item || item.type === 'image') return { ...(item || {}) };
  const threshold = Number(options.thresholdBytes) || TEXT_BLOB_THRESHOLD_BYTES;

  if ((item.textHash || item.textRef) && !clipboardModel.itemHasVerifiedFullText(item)) {
    const copy = { ...item };
    copy.text = String(item.textPreview || item.text || '');
    if (!copy.textPreview) copy.textPreview = copy.text;
    clearRuntimeFlags(copy);
    return copy;
  }

  const text = String(item.text || '');
  const bytes = textByteLength(text);
  const shouldExternalize = bytes > threshold || !!item.textRef;
  if (!shouldExternalize) {
    const copy = { ...item, text };
    delete copy.textHash;
    delete copy.textRef;
    delete copy.textSize;
    delete copy.textPreview;
    clearRuntimeFlags(copy);
    return copy;
  }

  const hash = clipboardModel.textHashForText(text);
  try {
    const ref = writeTextBlob(baseDir, text, hash);
    if (!ref) throw new Error('Invalid text blob reference');
    const copy = {
      ...item,
      text: textPreview(text),
      textHash: hash,
      textRef: ref,
      textSize: bytes,
      textPreview: textPreview(text),
    };
    clearRuntimeFlags(copy);
    return copy;
  } catch {
    // Corruption guard: if the blob cannot be written, keep the full text inline.
    const copy = { ...item, text };
    delete copy.textHash;
    delete copy.textRef;
    delete copy.textSize;
    delete copy.textPreview;
    clearRuntimeFlags(copy);
    return copy;
  }
}

function prepareHistoryForStorage(items, baseDir, options = {}) {
  try { blobStore.ensureDir(baseDir); } catch {}
  return (Array.isArray(items) ? items : []).map(item => prepareTextItemForStorage(item, baseDir, options));
}

function syncTextBlobs(localDir, remoteDir) {
  blobStore.syncMissingFiles(localDir, remoteDir, { filter: name => !!safeTextRef(name) });
}

function removeLocalBlobIfUnreferenced(item, items, baseDir) {
  if (!item || item.type === 'image') return;
  const ref = safeTextRef(item.textRef) || textRefForHash(item.textHash);
  if (!ref) return;
  const stillUsed = (items || []).some(candidate => candidate !== item && (
    safeTextRef(candidate && candidate.textRef) === ref ||
    textRefForHash(candidate && candidate.textHash) === ref
  ));
  if (stillUsed) return;
  try { fs.rmSync(textPathForRef(baseDir, ref), { force: true }); } catch {}
}

function setInlineText(item, text) {
  if (!item || item.type === 'image') return item;
  clipboardModel.setInlineText(item, text);
  clearRuntimeFlags(item);
  return item;
}

module.exports = {
  TEXT_BLOB_DIRNAME,
  TEXT_BLOB_THRESHOLD_BYTES,
  TEXT_PREVIEW_CHARS,
  textRefForHash,
  safeTextRef,
  textPreview,
  hydrateTextItem,
  hydrateHistory,
  prepareTextItemForStorage,
  prepareHistoryForStorage,
  syncTextBlobs,
  removeLocalBlobIfUnreferenced,
  setInlineText,
};
