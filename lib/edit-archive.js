'use strict';

// Pure planning for the external-edit retention buffer (see EDIT_ARCHIVE_DIR in
// main.js). Kept side-effect-free so the LRU + max-age policy is unit-testable
// without touching the filesystem: main.js does the readdir/stat/unlink, this
// decides WHICH files to evict.
//
// Policy: drop anything older than maxAgeMs, then evict oldest-first (LRU by
// mtime) until the surviving total is within maxBytes.

function planEditArchivePrune(entries, { maxBytes, maxAgeMs, now }) {
  const sorted = [...entries].sort((a, b) => a.mtimeMs - b.mtimeMs); // oldest first
  const remove = new Set();

  let total = 0;
  for (const e of sorted) {
    if (now - e.mtimeMs > maxAgeMs) remove.add(e);
    else total += e.size;
  }

  for (const e of sorted) {
    if (remove.has(e)) continue;
    if (total <= maxBytes) break;
    remove.add(e);
    total -= e.size;
  }

  return sorted.filter((e) => remove.has(e));
}

module.exports = { planEditArchivePrune };
