'use strict';

// Optimistic concurrency for clip mutations. Every update/delete of a clip -
// from the app UI, the MCP tools or any other caller - carries the rev of the
// version it read (clipboard-model.clipRevision). If the clip has changed since
// (another device's sync, another window, a concurrent AI edit) the mutation is
// refused with a RevisionConflict instead of silently clobbering the change.
//
// Error messages are "revision_conflict:<code>" so the code survives transports
// that only carry a message (Electron IPC); .code/.details carry it structured.
//   rev_required   - no rev supplied
//   not_found      - no clip with that id (deleted)
//   superseded     - the clip was edited and now lives at details.currentId
//   stale_revision - the clip changed; details.currentRev is its rev now

const model = require('./clipboard-model');

const CONFLICT_PREFIX = 'revision_conflict:';

class RevisionConflict extends Error {
  constructor(code, details = {}) {
    super(`${CONFLICT_PREFIX}${code}`);
    this.name = 'RevisionConflict';
    this.code = code;
    this.details = details;
  }
}

function findItem(history, id) {
  return (Array.isArray(history) ? history : []).find(item => item && model.itemKey(item) === id) || null;
}

function checkRevision(history, id, expectedRev, { supersedes } = {}) {
  const key = String(id == null ? '' : id);
  const rev = typeof expectedRev === 'string' ? expectedRev.trim() : '';
  if (!rev) return { ok: false, code: 'rev_required', id: key };
  const item = key ? findItem(history, key) : null;
  if (!item) {
    const currentId = model.supersedeMap(supersedes).get(key);
    if (currentId && currentId !== key && findItem(history, currentId)) {
      return { ok: false, code: 'superseded', id: key, currentId };
    }
    return { ok: false, code: 'not_found', id: key };
  }
  const currentRev = model.clipRevision(item);
  if (currentRev !== rev) return { ok: false, code: 'stale_revision', id: key, expectedRev: rev, currentRev };
  return { ok: true, id: key, item };
}

function conflictFrom(result, extra = {}) {
  const { ok, item, code, ...details } = result;
  return new RevisionConflict(code, { ...details, ...extra });
}

function assertRevision(history, id, expectedRev, options) {
  const result = checkRevision(history, id, expectedRev, options);
  if (!result.ok) throw conflictFrom(result);
  return result.item;
}

// Batch form: targets are [{ id, rev }]. All-or-nothing - every target is
// checked before the caller changes anything; one conflict refuses the batch.
function assertRevisions(history, targets, options) {
  const resolved = [];
  const failures = [];
  for (const target of Array.isArray(targets) ? targets : []) {
    const result = checkRevision(history, target && target.id, target && target.rev, options);
    if (result.ok) resolved.push({ id: result.id, item: result.item });
    else failures.push(result);
  }
  if (failures.length) {
    throw conflictFrom(failures[0], { conflicts: failures.map(({ ok, ...f }) => f) });
  }
  return resolved;
}

function isRevisionConflict(err) {
  return !!err && String(err.message || '').includes(CONFLICT_PREFIX);
}

module.exports = { RevisionConflict, CONFLICT_PREFIX, checkRevision, assertRevision, assertRevisions, isRevisionConflict };
