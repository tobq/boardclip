'use strict';

const assert = require('assert');
const crypto = require('crypto');
const model = require('../lib/clipboard-model');
const rc = require('../lib/clip-revision');

function text(t, extra = {}) {
  const item = { type: 'text', text: t, ts: 1, ...extra };
  model.ensureItemId(item);
  return item;
}
const clone = (x) => JSON.parse(JSON.stringify(x));
const sha = (t) => crypto.createHash('sha256').update(t, 'utf8').digest('hex');

// --- clipRevision: what bumps it, what does not ---
{
  const base = text('hello', { pin: { groups: ['b', 'a'], number: 2 }, title: 'T' });
  const rev = model.clipRevision(base);
  assert.match(rev, /^[a-f0-9]{16}$/);
  assert.strictEqual(model.clipRevision({ ...clone(base), ts: 99, updatedAt: 5, pinUpdatedAt: 7 }), rev, 'clocks do not bump rev');
  const ext = { ...clone(base), text: 'hel', textPreview: 'hel', textHash: sha('hello'), textRef: 'x.txt' };
  assert.strictEqual(model.clipRevision(ext), rev, 'inline vs externalized text: same rev');
  const reordered = clone(base); reordered.pin.groups = ['a', 'b'];
  assert.strictEqual(model.clipRevision(reordered), rev, 'group order does not matter');
  const changes = [
    (x) => { x.text = 'hello!'; },
    (x) => { x.title = 'U'; },
    (x) => { x.pin = null; },
    (x) => { x.pin.groups.push('c'); },
    (x) => { x.pin.groups = ['a']; },
    (x) => { x.pin.number = 3; },
    (x) => { delete x.pin.number; },
  ];
  for (const change of changes) {
    const c = clone(base); change(c);
    assert.notStrictEqual(model.clipRevision(c), rev, 'mutation bumps rev: ' + change);
  }
  const img = { type: 'image', image: 'a.png', ts: 1 };
  assert.notStrictEqual(model.clipRevision(img), model.clipRevision({ ...img, image: 'b.png' }), 'image rev keyed on file');
  assert.notStrictEqual(model.clipRevision(img), model.clipRevision({ ...img, pin: {} }), 'image pin bumps rev');
}

// --- checkRevision outcomes ---
{
  const a = text('alpha');
  const history = [a];
  const rev = model.clipRevision(a);
  assert.strictEqual(rc.checkRevision(history, a.id, rev).ok, true);
  assert.strictEqual(rc.checkRevision(history, a.id, '').code, 'rev_required');
  assert.strictEqual(rc.checkRevision(history, a.id, undefined).code, 'rev_required');
  assert.strictEqual(rc.checkRevision(history, 'txt:nope', rev).code, 'not_found');
  const stale = rc.checkRevision(history, a.id, 'deadbeefdeadbeef');
  assert.strictEqual(stale.code, 'stale_revision');
  assert.strictEqual(stale.currentRev, rev);

  const oldId = a.id;
  const edited = model.applyTextEdit(history, { id: oldId, originalText: 'alpha', newText: 'alpha two', now: Date.now() });
  assert.ok(edited.changed && edited.supersedes.length, 'edit supersedes the old id');
  const sup = rc.checkRevision(history, oldId, rev, { supersedes: edited.supersedes });
  assert.strictEqual(sup.code, 'superseded');
  assert.strictEqual(sup.currentId, model.itemKey(history.find((x) => x.text === 'alpha two')));

  assert.throws(() => rc.assertRevision(history, 'txt:nope', rev), (err) =>
    err instanceof rc.RevisionConflict && err.code === 'not_found' && err.message === 'revision_conflict:not_found' && rc.isRevisionConflict(err));
}

// --- batch: all-or-nothing ---
{
  const a = text('one'); const b = text('two');
  const history = [a, b];
  const ok = rc.assertRevisions(history, [{ id: a.id, rev: model.clipRevision(a) }, { id: b.id, rev: model.clipRevision(b) }]);
  assert.strictEqual(ok.length, 2);
  assert.throws(() => rc.assertRevisions(history, [{ id: a.id, rev: model.clipRevision(a) }, { id: b.id, rev: 'stale' }]), (err) =>
    err.code === 'stale_revision' && err.details.conflicts.length === 1 && err.details.conflicts[0].id === b.id);
}

// --- sync: rev-carrying tombstones ---
{
  const now = Date.now();
  const deletedCopy = text('gone', { ts: (now - 5000) / 1000, updatedAt: now - 5000 });
  const rev = model.clipRevision(deletedCopy);
  const revClock = model.itemMutationClock(deletedCopy);
  const tomb = { id: deletedCopy.id, deletedAt: now - 60000, rev, revClock }; // delete clock skewed BEHIND the copy

  const norm = model.normalizeTombstones([tomb, { id: 'x', deletedAt: now, rev: 'r' }]);
  assert.deepStrictEqual(norm.find((t) => t.id === deletedCopy.id), tomb);
  assert.deepStrictEqual(norm.find((t) => t.id === 'x'), { id: 'x', deletedAt: now });

  assert.strictEqual(model.mergeHistories([], [clone(deletedCopy)], { tombstones: [tomb] }).length, 0, 'same-version copy stays deleted despite skew');
  const pinned = { ...clone(deletedCopy), pin: {}, pinUpdatedAt: now - 1000, updatedAt: now - 1000 };
  assert.strictEqual(model.mergeHistories([], [pinned], { tombstones: [tomb] }).length, 1, 'edited copy survives');
  const readded = { ...clone(deletedCopy), ts: (now - 100) / 1000, updatedAt: now - 100 };
  assert.strictEqual(model.mergeHistories([], [readded], { tombstones: [tomb] }).length, 1, 're-add survives');
  const legacy = { id: deletedCopy.id, deletedAt: now - 60000 };
  assert.strictEqual(model.mergeHistories([], [clone(deletedCopy)], { tombstones: [legacy] }).length, 1, 'legacy: newer clock survives');
  assert.strictEqual(model.mergeHistories([], [clone(deletedCopy)], { tombstones: [{ id: deletedCopy.id, deletedAt: now }] }).length, 0, 'legacy: older clock deleted');
}

// --- UI helper parses Electron-wrapped conflicts ---
{
  const ui = require('../site/shared/clipboard-ui-core');
  assert.strictEqual(ui.revisionConflictCode(new Error("Error invoking remote method 'pin': Error: revision_conflict:stale_revision")), 'stale_revision');
  assert.strictEqual(ui.revisionConflictCode(new Error('boom')), null);
  assert.deepStrictEqual(ui.revisionTargets(['a'], () => 'r'), [{ id: 'a', rev: 'r' }]);
  (async () => {
    let toasted = null; let refreshed = false;
    const out = await ui.guardRevision(() => Promise.reject(new Error('x: revision_conflict:not_found')), { toast: (m) => { toasted = m; }, refresh: () => { refreshed = true; }, fallback: 'fb' });
    assert.strictEqual(out, 'fb'); assert.ok(toasted && /changed elsewhere/.test(toasted)); assert.ok(refreshed);
    await assert.rejects(ui.guardRevision(() => Promise.reject(new Error('other'))), /other/);
    console.log('clip revision tests passed');
  })().catch((err) => { console.error(err); process.exit(1); });
}
