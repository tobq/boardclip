'use strict';

// Source pins: every clip-mutating entry point threads a rev into a
// rev-checking primitive, and every primitive checks it before mutating.
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const root = path.join(__dirname, '..');
const read = (f) => fs.readFileSync(path.join(root, f), 'utf8').replace(/\r\n/g, '\n');
const main = read('main.js');

const HANDLERS = {
  'delete-item': /\(_, id, rev\) => applyDeleteItem\(id, rev\)/,
  'set-clip-title': /\(_, id, title, rev\) => applyClipTitle\(id, title, rev\)/,
  'pin': /\(_, id, rev\) => applyPinToggle\(id, rev\)/,
  'numpad-assign': /\(_, id, slot, rev\) => applyNumpadAssign\(id, slot, rev\)/,
  'group-assign': /\(_, id, group, rev\) => applyGroupAssign\(id, group, rev\)/,
  'delete-items': /\(_, targets\) => applyDeleteItems\(targets\)/,
  'group-assign-many': /\(_, targets, group, shouldHave\) => applyGroupAssignMany\(targets, group, shouldHave\)/,
};
for (const [channel, re] of Object.entries(HANDLERS)) {
  const line = main.split('\n').find((l) => l.includes(`ipcMain.handle('${channel}'`));
  assert.ok(line && re.test(line), `IPC ${channel} must pass a rev: ${line}`);
}
assert.match(main, /applyDeleteItems\(\[\{ id: session\.currentId, rev \}\]\)/, 'editor delete is rev-checked');

// Each primitive checks the rev before it looks the clip up or mutates.
for (const [fn, check] of [
  ['applyPinToggle', 'assertClipRevision('], ['applyNumpadAssign', 'assertClipRevision('], ['applyGroupAssign', 'assertClipRevision('],
  ['applyDeleteItem', 'assertClipRevision('], ['applyClipTitle', 'assertClipRevision('],
  ['applyDeleteItems', 'assertClipRevisions('], ['applyGroupAssignMany', 'assertClipRevisions('],
]) {
  const start = main.indexOf(`function ${fn}(`);
  assert.ok(start >= 0, fn);
  const body = main.slice(start, main.indexOf('\n}\n', start));
  assert.ok(body.includes(check), `${fn} must call ${check}`);
  const before = body.slice(0, body.indexOf(check));
  assert.ok(!/findHistoryItem\(|findHistoryIndex\(|history\.splice|ensurePin\(|applyGroupCreate\(/.test(before), `${fn} checks the rev first`);
}

// Internal callers pass a rev too (none left on the old signature).
assert.match(main, /applyNumpadAssign\(itemKey\(item\), session\.numberSlot, clipboardModel\.clipRevision\(item\)\)/);

// Every tombstone records the deleted copy (or explicit null for a superseded edit id).
for (const m of main.matchAll(/addTombstone\(([^\n]*)\);/g)) {
  assert.ok(/,\s*(item|null)\)?$/.test(m[1]) , `addTombstone(${m[1]}) must pass the deleted item`);
}

// MCP: guarded tools checked before the approval prompt, and again at execution.
const handler = main.slice(main.indexOf('async function mcpHandleRequest('), main.indexOf('function mcpExecute('));
assert.ok(handler.includes('assertClipRevision(args.id, args.expected_rev)'), 'MCP pre-approval rev check');
assert.ok(handler.indexOf('assertClipRevision(args.id, args.expected_rev)') < handler.indexOf('requestApproval('), 'rev checked before approval');
const exec = main.slice(main.indexOf('function mcpExecute('), main.indexOf('// --- IPC handlers ---'));
for (const call of ['applyPinToggle(args.id, args.expected_rev)', 'applyNumpadAssign(args.id, args.slot, args.expected_rev)', 'applyGroupAssign(args.id, args.group, args.expected_rev)', 'applyDeleteItem(args.id, args.expected_rev)', 'assertClipRevision(args.id, args.expected_rev)']) {
  assert.ok(exec.includes(call), `mcpExecute: ${call}`);
}

// Renderers pass the rev of the item they rendered.
for (const f of ['index.html', 'viewer.html', 'editor.html']) {
  const src = read(f);
  assert.ok(/Core\.guardRevision/.test(src) && /clipRevOf/.test(src), `${f} routes mutations through the rev guard`);
}
for (const f of ['preload.js', 'viewer-preload.js', 'editor-preload.js']) {
  const src = read(f);
  assert.ok(/invoke\('pin', id, rev\)/.test(src) && /invoke\('group-assign', id, group, rev\)/.test(src), `${f} forwards rev`);
}

console.log('revision wiring tests passed');
