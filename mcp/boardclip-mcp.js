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
//     allowlist + secret guard the app uses (lib/mcp-core).
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
const secretGuard = require('../lib/secret-guard');
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

let clientLabel = 'an AI assistant';

// Forward a gated action/read to the running app and shape the response (or a
// friendly error) for the MCP client.
async function runForward(tool, args) {
  try {
    const result = await controlClient.request('action', '/action', { tool, args, client: clientLabel });
    return jsonResult(result);
  } catch (err) {
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
  description: 'Search shared clips by substring (or regex). Returns matching shared clips with previews plus a count of how many NON-shared clips also matched. Set include_unshared to run the full search over everything - that requires the app and pops an approval prompt.',
  inputSchema: {
    query: z.string().min(1),
    regex: z.boolean().optional(),
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
  description: 'Get the full text of a clip by id. Shared, non-secret clips return immediately. A non-shared clip or one that looks like a secret requires the app and pops an approval prompt before the text is returned.',
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
    // On disk a >64KB clip's `text` was only the 1024-char preview, so the secret
    // scan in resolveForRead never saw content past it. Re-scan the FULL body now;
    // if it now looks like a secret, route through the approval-gated read.
    if (!item.shareAnyway && secretGuard.inspect(item.text || '').isSecret) {
      return runForward('read_clip', { id, reason: 'secret_hidden' });
    }
    return jsonResult(mcpCore.fullTextResult(item, sharedSet));
  }
  // not_shared or secret_hidden -> approval-gated read through the app.
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

server.registerTool('pin_clip', {
  description: 'Toggle the pin (star) on a clip by id.',
  inputSchema: { id: z.string() },
}, async ({ id }) => runForward('pin_clip', { id }));

server.registerTool('set_numpad', {
  description: 'Assign a clip to a numpad quick-paste slot (1-9).',
  inputSchema: { id: z.string(), slot: z.number().int().min(1).max(9) },
}, async ({ id, slot }) => runForward('set_numpad', { id, slot }));

server.registerTool('assign_group', {
  description: 'Toggle a clip\'s membership in a group (adds if absent, removes if present).',
  inputSchema: { id: z.string(), group: z.string().min(1) },
}, async ({ id, group }) => runForward('assign_group', { id, group }));

server.registerTool('create_group', {
  description: 'Create a new group.',
  inputSchema: { name: z.string().min(1) },
}, async ({ name }) => runForward('create_group', { name }));

server.registerTool('delete_group', {
  description: 'Delete a group (clips stay in history, just lose this group label).',
  inputSchema: { name: z.string().min(1) },
}, async ({ name }) => runForward('delete_group', { name }));

server.registerTool('delete_clip', {
  description: 'Delete a clip from history. Always pops an approval prompt.',
  inputSchema: { id: z.string() },
}, async ({ id }) => runForward('delete_clip', { id }));

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
