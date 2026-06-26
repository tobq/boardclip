'use strict';

// Shared retention policy for on-disk buffers (history backups, the external-edit
// archive, ...). Pure and side-effect-free so the policy is unit-testable without
// the filesystem: callers enumerate the dir into { mtimeMs, size } entries, this
// decides WHICH to evict, the caller unlinks them.
//
// Any combination of caps may be supplied; each is skipped when its option is
// absent, and they compose in this order (a file removed by an earlier cap is not
// reconsidered):
//   - maxAgeMs:  drop entries older than the cutoff (needs `now`)
//   - maxFiles:  keep only the newest N survivors
//   - maxBytes:  evict oldest survivors until the total is within the cap
// Eviction is always oldest-first (LRU by mtime).

function planRetention(entries, { maxFiles, maxBytes, maxAgeMs, now } = {}) {
  const sorted = [...entries].sort((a, b) => a.mtimeMs - b.mtimeMs); // oldest first
  const remove = new Set();
  const survivors = () => sorted.filter((e) => !remove.has(e));

  if (maxAgeMs != null && now != null) {
    for (const e of sorted) if (now - e.mtimeMs > maxAgeMs) remove.add(e);
  }

  if (maxFiles != null) {
    const live = survivors();
    for (let i = 0; i < live.length - maxFiles; i++) remove.add(live[i]); // oldest excess
  }

  if (maxBytes != null) {
    let total = survivors().reduce((sum, e) => sum + (e.size || 0), 0);
    for (const e of sorted) {
      if (remove.has(e)) continue;
      if (total <= maxBytes) break;
      remove.add(e);
      total -= e.size || 0;
    }
  }

  return sorted.filter((e) => remove.has(e));
}

module.exports = { planRetention };
