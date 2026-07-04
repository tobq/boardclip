'use strict';

const Diff = require('diff');
const conflictModel = require('./conflict-model');

function textHunks(leftText, rightText) {
  const parts = Diff.diffLines(String(leftText || ''), String(rightText || ''));
  return parts.map((part, index) => ({
    id: `h${index}`,
    type: part.added ? 'add' : part.removed ? 'remove' : 'same',
    text: part.value,
    count: part.count || part.value.split(/\n/).length,
  }));
}

function recordToReconciliation(record) {
  const normalized = conflictModel.normalizeConflictRecord(record);
  if (!normalized) return null;
  return {
    ...normalized,
    hunks: textHunks(normalized.left.text, normalized.right.text),
  };
}

module.exports = {
  textHunks,
  recordToReconciliation,
};
