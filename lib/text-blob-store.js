'use strict';

const clipboardModel = require('./clipboard-model');
const clipBlobStore = require('./clip-blob-store');

// The text payload's blob store. The mechanics (hashing, atomic write, hydrate,
// externalize-above-threshold, sync filter, unreferenced cleanup) live once in
// lib/blob-field-store.js and are instantiated per clipboard format in
// lib/clip-blob-store.js — this module is the text instance's public face, kept
// under its original name and signatures so every existing caller and test is
// unaffected by the generalisation.
const store = clipBlobStore.text;

function setInlineText(item, text) {
  if (!item || item.type === 'image') return item;
  // Deliberately the MODEL's setInlineText, not the field store's: an edit must
  // also drop the html/rtf payloads, which describe the pre-edit text. The
  // field store only knows about its own field.
  clipboardModel.setInlineText(item, text);
  store.setInlineValue(item, item.text);
  return item;
}

module.exports = {
  TEXT_BLOB_DIRNAME: clipBlobStore.TEXT_BLOB_DIRNAME,
  TEXT_BLOB_THRESHOLD_BYTES: store.thresholdBytes,
  TEXT_PREVIEW_CHARS: clipBlobStore.TEXT_PREVIEW_CHARS,
  textRefForHash: store.refForHash,
  safeTextRef: store.safeRef,
  textPreview: store.preview,
  hydrateTextItem: (item, baseDir) => store.hydrateItem(item, baseDir),
  hydrateHistory: (items, baseDir) => store.hydrateHistory(items, baseDir),
  prepareTextItemForStorage: (item, baseDir, options) => store.prepareItemForStorage(item, baseDir, options),
  prepareHistoryForStorage: (items, baseDir, options) => store.prepareHistoryForStorage(items, baseDir, options),
  syncTextBlobs: (localDir, remoteDir) => store.syncBlobs(localDir, remoteDir),
  removeLocalBlobIfUnreferenced: (item, items, baseDir) => store.removeLocalBlobIfUnreferenced(item, items, baseDir),
  setInlineText,
};
