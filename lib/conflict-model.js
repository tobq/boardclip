'use strict';

const crypto = require('crypto');

const CONFLICT_TOMBSTONE_MAX_AGE_MS = 30 * 86400 * 1000;

function timestamp(value) {
  const n = Number(value) || 0;
  return Number.isFinite(n) ? n : 0;
}

function cleanTitle(value) {
  return String(value == null ? '' : value).replace(/\s+/g, ' ').trim().slice(0, 240);
}

function cleanText(value) {
  return String(value == null ? '' : value);
}

function uniqueId(parts) {
  return crypto.createHash('sha256').update(parts.map(part => String(part == null ? '' : part)).join('\0'), 'utf8').digest('hex').slice(0, 24);
}

function normalizeSnapshot(snapshot) {
  const raw = snapshot && typeof snapshot === 'object' ? snapshot : {};
  const groups = Array.isArray(raw.groups)
    ? [...new Set(raw.groups.map(group => String(group || '').trim()).filter(Boolean))]
    : [];
  return {
    id: String(raw.id || ''),
    type: raw.type === 'image' ? 'image' : 'text',
    title: cleanTitle(raw.title),
    text: cleanText(raw.text),
    groups,
    ts: timestamp(raw.ts),
    updatedAt: timestamp(raw.updatedAt),
    titleUpdatedAt: timestamp(raw.titleUpdatedAt),
  };
}

function defaultResult(record) {
  const right = normalizeSnapshot(record && record.right);
  const left = normalizeSnapshot(record && record.left);
  return {
    title: right.title || left.title,
    text: right.text || left.text,
  };
}

function normalizeConflictRecord(record, now = Date.now()) {
  if (!record || typeof record !== 'object') return null;
  const kind = ['editor', 'title', 'merge'].includes(record.kind) ? record.kind : 'merge';
  const createdAt = timestamp(record.createdAt) || timestamp(record.updatedAt) || now;
  const updatedAt = timestamp(record.updatedAt) || createdAt;
  const left = normalizeSnapshot(record.left);
  const right = normalizeSnapshot(record.right);
  const base = record.base ? normalizeSnapshot(record.base) : null;
  const targetId = String(record.targetId || right.id || left.id || '');
  const resultSource = record.result && typeof record.result === 'object' ? record.result : defaultResult({ left, right });
  const id = String(record.id || `conf:${kind}:${uniqueId([targetId, left.id, left.title, left.text, right.id, right.title, right.text])}`);
  return {
    id,
    kind,
    status: record.status === 'resolved' ? 'resolved' : 'unresolved',
    source: String(record.source || ''),
    targetId,
    createdAt,
    updatedAt,
    base,
    left,
    right,
    result: {
      title: cleanTitle(resultSource.title),
      text: cleanText(resultSource.text),
    },
  };
}

function normalizeTombstones(list, now = Date.now()) {
  const cutoff = now - CONFLICT_TOMBSTONE_MAX_AGE_MS;
  const byId = new Map();
  for (const tombstone of Array.isArray(list) ? list : []) {
    if (!tombstone || !tombstone.id) continue;
    const deletedAt = timestamp(tombstone.deletedAt);
    if (deletedAt < cutoff) continue;
    const existing = byId.get(tombstone.id);
    if (!existing || deletedAt > existing.deletedAt) byId.set(tombstone.id, { id: String(tombstone.id), deletedAt });
  }
  return [...byId.values()];
}

function normalizeConflictState(state, now = Date.now()) {
  const raw = state && typeof state === 'object' ? state : {};
  const tombstones = normalizeTombstones(raw.tombstones, now);
  const tombstoneById = new Map(tombstones.map(t => [t.id, t.deletedAt]));
  const recordsById = new Map();
  const records = Array.isArray(raw.records)
    ? raw.records
    : Array.isArray(raw.conflicts)
      ? raw.conflicts
      : [];
  for (const rawRecord of records) {
    const record = normalizeConflictRecord(rawRecord, now);
    if (!record) continue;
    const deletedAt = tombstoneById.get(record.id) || 0;
    if (deletedAt) continue;
    const existing = recordsById.get(record.id);
    if (!existing || record.updatedAt >= existing.updatedAt) recordsById.set(record.id, record);
  }
  return {
    version: 1,
    records: [...recordsById.values()].sort((a, b) => b.updatedAt - a.updatedAt),
    tombstones,
  };
}

function mergeConflictStates(local, remote, now = Date.now()) {
  const left = normalizeConflictState(local, now);
  const right = normalizeConflictState(remote, now);
  return normalizeConflictState({
    version: 1,
    records: [...left.records, ...right.records],
    tombstones: [...left.tombstones, ...right.tombstones],
  }, now);
}

function createConflictRecord(input, options = {}) {
  const now = timestamp(options.now) || Date.now();
  return normalizeConflictRecord({
    ...(input || {}),
    source: options.source || (input && input.source) || '',
    createdAt: timestamp(input && input.createdAt) || now,
    updatedAt: timestamp(input && input.updatedAt) || now,
    status: 'unresolved',
  }, now);
}

function upsertConflictRecord(state, record, now = Date.now()) {
  if (!record) return normalizeConflictState(state, now);
  const normalized = normalizeConflictState(state, now);
  return normalizeConflictState({
    ...normalized,
    records: [...normalized.records, record],
  }, now);
}

function removeConflictRecord(state, id, now = Date.now()) {
  const normalized = normalizeConflictState(state, now);
  const key = String(id || '');
  if (!key) return normalized;
  return normalizeConflictState({
    version: 1,
    records: normalized.records.filter(record => record.id !== key),
    tombstones: [...normalized.tombstones, { id: key, deletedAt: now }],
  }, now);
}

module.exports = {
  CONFLICT_TOMBSTONE_MAX_AGE_MS,
  normalizeSnapshot,
  normalizeConflictRecord,
  normalizeTombstones,
  normalizeConflictState,
  mergeConflictStates,
  createConflictRecord,
  upsertConflictRecord,
  removeConflictRecord,
};
