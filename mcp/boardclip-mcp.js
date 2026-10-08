#!/usr/bin/env node
'use strict';

// BoardClip MCP server (stdio).
//
// Spawned by an AI client (Claude Code, Codex, Claude Desktop, VS Code, …) over
// stdio - no HTTP, no port. It exposes the user's CURATED clipboard context and
// management actions:
//
//   - Reads of clips in groups the user shared with AI are served directly from
//     the data files (work even when the app is closed), filtered by the same
//     opt-in group allowlist the app uses (lib/mcp-core).
//   - Anything beyond the allowlist, any mutation, and any clipboard write is
//     forwarded to the running BoardClip app over the local control channel,
//     where it is gated behind the approval modal. If the app is not running,
//     those tools return a clear "open BoardClip" message.
//
// All model/filtering logic is reused from lib/*; this file is the thin SDK glue.

const fs = require('fs');
const path = require('path');
const { z } = require('zod');
const { McpServer } = require('@modelcontextprotocol/sdk/server/mcp.js');
const { StdioServerTransport } = require('@modelcontextprotocol/sdk/server/stdio.js');

const model = require('../lib/clipboard-model');
const textBlobStore = require('../lib/text-blob-store');
const mcpCore = require('../lib/mcp-core');
const mcpPaths = require('../lib/mcp-paths');
const controlClient = require('../lib/control-client');

// --- Data location -----------------------------------------------------------
const discovery = mcpPaths.readDiscovery();
const DATA_DIR = (discovery && discovery.dataDir) || mcpPaths.defaultDataDir();
const HISTORY_PATH = path.join(DATA_DIR, 'clipboard-history.json');
const SETTINGS_PATH = path.join(DATA_DIR, 'clipboard-settings.json');
const TEXT_DIR = path.join(DATA_DIR, textBlobStore.TEXT_BLOB_DIRNAME);

function readSettings() {
  try {
    return { ...model.DEFAULT_SETTINGS, ...JSON.parse(fs.readFileSync(SETTINGS_PATH, 'utf8')) };
  } catch {
    return { ...model.DEFAULT_SETTINGS };
  }
}

function readHistory() {
  try {
    const loaded = JSON.parse(fs.readFileSync(HISTORY_PATH, 'utf8'));
    const items = Array.isArray(loaded) ? loaded : [];
    for (const item of items) { model.migrateItemPin(item); model.ensureItemId(item); }
    return items;
  } catch {
    return [];
  }
}

// --- Result helpers ----------------------------------------------------------
function jsonResult(value) {
  return { content: [{ type: 'text', text: JSON.stringify(value, null, 2) }] };
}

function errorResult(message) {
  return { content: [{ type: 'text', text: message }], isError: true };
}

// Every clip mutation carries the rev it read; the app refuses a stale one.
const REV_NOTE = ' Requires expected_rev: the clip\'s `rev` from list_clips/search_clips/get_clip (or from your previous change\'s result). If the clip changed since you read it the change is refused - re-read it and retry. Returns the clip\'s new rev.';
const expectedRevSchema = () => z.string().min(1).describe('The clip\'s `rev` as you last read it; the change is refused if the clip changed since.');

function revisionConflictMessage(err) {
  if (!err || !/revision_conflict:/.test(String(err.message || ''))) return null;
  const d = err.details || {};
  const code = err.code || String(err.message).split('revision_conflict:')[1];
  if (code === 'stale_revision') return `Clip ${d.id} changed since you read it (your rev ${d.expectedRev}, now ${d.currentRev}), so nothing was changed. Re-read it with get_clip and retry with the new rev.`;
  if (code === 'superseded') return `Clip ${d.id} was edited and is now clip ${d.currentId}, so nothing was changed. Re-read ${d.currentId} with get_clip and retry with its rev.`;
  if (code === 'rev_required') return 'expected_rev is required: pass the clip\'s rev from list_clips/search_clips/get_clip.';
  if (code === 'not_found') return `No clip with id "${d.id}" (it may have been deleted), so nothing was changed.`;
  return `The clip changed (${code}), so nothing was changed. Re-read it and retry.`;
}

let clientLabel = 'an AI assistant';

// Forward a gated action/read to the running app and shape the response (or a
// friendly error) for the MCP client.
async function runForward(tool, args) {
  try {
    const result = await controlClient.request('action', '/action', { tool, args, client: clientLabel });
    return jsonResult(result);
  } catch (err) {
    const conflict = revisionConflictMessage(err);
    if (conflict) return errorResult(conflict);
    if (err && err.code === 'app_not_running') {
      return errorResult('BoardClip is not running. Open the BoardClip app so it can show the approval prompt and perform this action.');
    }
    if (err && /denied/i.test(err.message)) {
      return errorResult('The user denied this action in the BoardClip approval prompt.');
    }
    if (err && /timed_out/i.test(err.message)) {
      return errorResult('The approval prompt timed out (no response), so the action was not performed.');
    }
    return errorResult(err && err.message ? err.message : 'Action failed.');
  }
}

// --- Server ------------------------------------------------------------------
const server = new McpServer({ name: 'boardclip', version: '1.0.0' });

// ---- Read tools (served locally from the data files) ----
server.registerTool('list_context', {
  description: 'Summary of the user\'s clipboard organisation: groups (with which are shared with AI), pinned and numpad-slot clips, and totals. The starting point for understanding what is available.',
  inputSchema: {},
}, async () => jsonResult(mcpCore.buildContext(readHistory(), readSettings())));

server.registerTool('list_clips', {
  description: 'List clipboard clips the user shared with AI (most recent first, with text previews). Non-shared clips are excluded unless include_unshared_metadata is set, in which case they appear as metadata only (no text).',
  inputSchema: {
    limit: z.number().int().min(1).max(200).optional(),
    group: z.string().optional().describe('Only clips in this group.'),
    include_unshared_metadata: z.boolean().optional(),
  },
}, async ({ limit, group, include_unshared_metadata }) => {
  const res = mcpCore.listClips(readHistory(), readSettings(), {
    limit: limit || mcpCore.DEFAULT_LIST_LIMIT,
    group: group || null,
    includeNonShared: !!include_unshared_metadata,
  });
  return jsonResult(res);
});

server.registerTool('search_clips', {
  description: 'Search shared clips with the BoardClip search language (the same text the app\'s search field takes). Plain words are literal, case-insensitive substrings, and every term must match (AND); "a quoted phrase" matches exactly; /pattern/ is a regular expression term (case-insensitive, . never crosses a line break; title:/re/ and text:/re/ too); a OR b matches either (OR binds tighter than AND, so x a OR b = x AND (a OR b)); ( ) groups at any depth; -term or -( ... ) excludes. Field scopes title:/text:/group: (short: t:/b:/g:), facets is:pinned|is:image|is:text|is:numpad|is:url|is:multiline|is:rich, num:1-9 (n:), since:/before: e.g. since:7d (s:/bf:), len:>100 or len:50-200 (l:), lines:>3 (ln:), words:<20 (wd:), sort:new|best (o:), id:. Every prefix has a short + long alias. Example: group:Work OR group:Ideas /inv(oice)?/ -draft. Returns matching shared clips with previews plus a count of how many NON-shared clips also matched. Set include_unshared to run the full search over everything - that requires the app and pops an approval prompt.',
  inputSchema: {
    query: z.string().min(1),
    regex: z.boolean().optional().describe('Legacy: read the query\'s free text as ONE regular expression. Prefer /pattern/ terms in the query.'),
    include_unshared: z.boolean().optional(),
    limit: z.number().int().min(1).max(200).optional(),
  },
}, async ({ query, regex, include_unshared, limit }) => {
  if (include_unshared) {
    return runForward('search_all', { query, regex: !!regex, limit: limit || mcpCore.DEFAULT_LIST_LIMIT });
  }
  const res = mcpCore.searchClips(readHistory(), readSettings(), {
    query, regex: !!regex, limit: limit || mcpCore.DEFAULT_LIST_LIMIT,
  });
  return jsonResult(res);
});

server.registerTool('get_clip', {
  description: 'Get the full text of a clip by id. Shared clips return immediately. A non-shared clip requires the app and pops an approval prompt before the text is returned.',
  inputSchema: { id: z.string() },
}, async ({ id }) => {
  const settings = readSettings();
  const resolved = mcpCore.resolveForRead(readHistory(), settings, id);
  if (resolved.reason === 'not_found') return errorResult(`No clip with id "${id}".`);
  if (resolved.reason === 'ok') {
    const item = resolved.item;
    const sharedSet = mcpCore.sharedGroupSet(settings);
    if (item.type === 'image') return jsonResult(mcpCore.clipView(item, { sharedSet }));
    textBlobStore.hydrateTextItem(item, TEXT_DIR);
    return jsonResult(mcpCore.fullTextResult(item, sharedSet));
  }
  // not_shared -> approval-gated read through the app.
  return runForward('read_clip', { id, reason: resolved.reason });
});

server.registerTool('get_image', {
  description: 'Get metadata for an image clip (type, dimensions, group, timestamp). Set include_path to also get the local file path, which requires the app and pops an approval prompt.',
  inputSchema: { id: z.string(), include_path: z.boolean().optional() },
}, async ({ id, include_path }) => {
  if (include_path) return runForward('image_path', { id });
  const settings = readSettings();
  const resolved = mcpCore.resolveForRead(readHistory(), settings, id);
  if (resolved.reason === 'not_found') return errorResult(`No clip with id "${id}".`);
  if (resolved.item.type !== 'image') return errorResult(`Clip "${id}" is not an image.`);
  // clipView returns metadata-only for a non-shared image; full meta for a shared one.
  return jsonResult(mcpCore.clipView(resolved.item, { sharedSet: mcpCore.sharedGroupSet(settings) }));
});

// ---- Management tools (forwarded to the app; gated there) ----
server.registerTool('add_clip', {
  description: 'Add a new text clip to history, optionally into a group. Pops an approval prompt unless you have allowed this action.',
  inputSchema: { text: z.string().min(1), group: z.string().optional() },
}, async ({ text, group }) => runForward('add_clip', { text, group: group || null }));

server.registerTool('edit_clip', {
  description: 'Replace (or append to) the text of an existing TEXT clip in place, keeping its pin, groups, and numpad slot. Text clips are content-addressed, so editing changes the clip id - the new id is returned in the result. Images cannot be edited. Pops an approval prompt.' + REV_NOTE,
  inputSchema: {
    id: z.string(),
    expected_rev: expectedRevSchema(),
    text: z.string().min(1),
    title: z.string().optional().describe('Optional new title/name for the clip.'),
    append: z.boolean().optional().describe('Append text to the existing content (newline-joined) instead of replacing it.'),
  },
}, async ({ id, expected_rev, text, title, append }) => runForward('edit_clip', { id, expected_rev, text, title: title != null ? title : null, append: !!append }));

server.registerTool('pin_clip', {
  description: 'Toggle the pin (star) on a clip by id.' + REV_NOTE,
  inputSchema: { id: z.string(), expected_rev: expectedRevSchema() },
}, async ({ id, expected_rev }) => runForward('pin_clip', { id, expected_rev }));

server.registerTool('set_numpad', {
  description: 'Assign a clip to a numpad quick-paste slot (1-9).' + REV_NOTE,
  inputSchema: { id: z.string(), expected_rev: expectedRevSchema(), slot: z.number().int().min(1).max(9) },
}, async ({ id, expected_rev, slot }) => runForward('set_numpad', { id, expected_rev, slot }));

server.registerTool('assign_group', {
  description: 'Toggle a clip\'s membership in a group (adds if absent, removes if present).' + REV_NOTE,
  inputSchema: { id: z.string(), expected_rev: expectedRevSchema(), group: z.string().min(1) },
}, async ({ id, expected_rev, group }) => runForward('assign_group', { id, expected_rev, group }));

server.registerTool('create_group', {
  description: 'Create a new group.',
  inputSchema: { name: z.string().min(1) },
}, async ({ name }) => runForward('create_group', { name }));

server.registerTool('delete_group', {
  description: 'Delete a group (clips stay in history, just lose this group label).',
  inputSchema: { name: z.string().min(1) },
}, async ({ name }) => runForward('delete_group', { name }));

server.registerTool('delete_clip', {
  description: 'Delete a clip from history. Always pops an approval prompt.' + REV_NOTE,
  inputSchema: { id: z.string(), expected_rev: expectedRevSchema() },
}, async ({ id, expected_rev }) => runForward('delete_clip', { id, expected_rev }));

server.registerTool('copy_to_clipboard', {
  description: 'Put a clip (by id) or literal text onto the user\'s system clipboard. Always pops an approval prompt.',
  inputSchema: { id: z.string().optional(), text: z.string().optional() },
}, async ({ id, text }) => {
  if (!id && !text) return errorResult('Provide either id or text.');
  return runForward('copy_to_clipboard', { id: id || null, text: text != null ? text : null });
});

server.registerTool('paste_clip', {
  description: 'Put a clip on the clipboard and paste it into the foreground app. Always pops an approval prompt.',
  inputSchema: { id: z.string() },
}, async ({ id }) => runForward('paste_clip', { id }));

// --- Connect -----------------------------------------------------------------
async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  // Best-effort: label the client for the approval modal.
  try {
    const info = server.server.getClientVersion && server.server.getClientVersion();
    if (info && info.name) clientLabel = info.version ? `${info.name} ${info.version}` : info.name;
  } catch {}
}

main().catch(err => {
  // stderr only - stdout is the JSON-RPC channel.
  try { process.stderr.write(`boardclip-mcp fatal: ${err && err.stack || err}\n`); } catch {}
  process.exit(1);
});
