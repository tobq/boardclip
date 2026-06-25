# BoardClip - CLAUDE.md

## Architecture

- **Electron app** — main process (`main.js`) handles clipboard polling, tray, global shortcuts, IPC, sync
- **Preload bridge** (`preload.js`) — contextBridge exposing API to renderer
- **Single-file UI** (`index.html`) — loaded via `loadFile`, images served via `clip-img://` custom protocol
- **Cross-platform**: macOS + Windows. Platform differences handled inline with `process.platform` checks
- Data: `clipboard-history.json`, `clipboard-images/`, `clipboard-settings.json`

## Key Data Model

- **History item ids**: text items use a sha256 content key (`txt:{hash}`); image items use their content-addressed image filename (`img:{file}`).
- **`pin` field** on history items: `null`/absent means unpinned; an object means pinned. Shape is `{ number?: 1-9, groups?: string[], updatedAt?: number }`.
- **Legacy migration**: `lib/clipboard-model.js` migrates old `pinned`/`group` fields into the unified `pin` object before merging or rendering.
- **Groups**: group names live in `settings.groups`; item membership lives in `item.pin.groups`.
- **Tombstones**: deleted items and groups are retained for 30 days in settings so sync cannot resurrect removals from stale providers.
- **Content-addressed images**: filenames are md5 hash of PNG content (`{hash}.png`), naturally deduplicates.

## Clipboard Operations

- **Polling** every 400ms via `clipboard.readImage()` / `clipboard.readText()`
- **`addToHistory(entry, matchFn)`** — shared helper that deduplicates, preserves pinned/group metadata, and prunes
- **`setClipboardToItem(item)`** — shared helper to write text or image to clipboard
- **Backup/restore**: `backupClipboard()` saves text/html/rtf/image, `restoreClipboard()` writes them back. Used by numpad quick-paste.
- **`pollGate`** flag pauses polling during paste sequences to prevent interference

## Paste Simulation

- **macOS**: `osascript` — activates frontmost app then sends `keystroke "v" using command down`. Required because `app.dock.hide()` means our app doesn't return focus on hide.
- **Windows**: VBScript `SendKeys "^v"` via temp file + `cscript`. Faster than PowerShell.

## Windows Specifics — Low-Level Keyboard Hook

**Why not `globalShortcut.register('Super+V')`?** On Windows, Windows Clipboard History (Settings → System → Clipboard) claims Win+V at the RegisterHotKey layer. Electron's globalShortcut uses RegisterHotKey internally, so registration silently fails — the return value is `false`. Same applies to Win+Numpad1-9. You cannot win this fight with the high-level API.

**What we do instead.** `lib/windows-hook-worker.js` installs a `WH_KEYBOARD_LL` hook via koffi FFI on a dedicated worker thread. LL hooks sit *below* system shortcut handling, so we see (and can swallow) Win+V before Windows Clipboard History does. This matches the approach the pre-Electron Python version used with ctypes.

**Worker thread, not main thread.** The hook must be installed on a thread that runs a GetMessage loop — Windows delivers LL hook calls via messages posted to the installing thread's queue. Running it on Electron's main thread works for Win+V but risks hitting `LowLevelHooksTimeout` (default 300ms) whenever JS blocks the main thread, at which point Windows silently unregisters the hook. A dedicated worker with a tight GetMessage loop avoids that entirely.

**SharedArrayBuffer for state.** The worker is synchronously blocked inside `GetMessageW`, so it can't process messages from the main thread via `parentPort.on('message')`. For decisions that need real-time state (is the popup open? is slot N assigned?), main thread writes to a `SharedArrayBuffer` and the worker reads it from inside the hook callback. Layout: `[popupVisible, slot1..slot9, reserved]` as `Uint8Array`.

**Numpad UX.** Plain Num1-9 (no Win) is intercepted only if:
- The popup is open (→ assign current item to slot), OR
- The slot is already assigned (→ paste slot contents).

Otherwise the key passes through so normal numpad typing works. Main thread calls `windowsHook.setPopupVisible()` on show/hide and `windowsHook.setSlotAssignments(Set)` whenever history is saved (`syncHookState()` in main.js).

**koffi over native addon.** koffi is pure JS FFI with prebuilt binaries for every Electron ABI — no `electron-rebuild`, no C++ toolchain, no breakage across Electron upgrades. The Node modules that *do* block system shortcuts all require native compilation or don't actually block Windows-reserved keys (`node-global-key-listener` explicitly can't override them).

**Shutdown.** `worker.terminate()` kills the thread; Windows reclaims the hook on thread exit. A cleaner `PostThreadMessageW(WM_QUIT)` path would need the worker thread ID exposed via postMessage at startup — not worth the extra FFI surface for a quit-only code path.

## macOS Specifics

- **No click-away-to-close**: `app.dock.hide()` makes blur events unreliable on macOS. Close button (×) shown in header instead. Windows uses blur-to-hide normally.
- **`app.dock.hide()`** hides dock icon — tray-only app
- **Template tray icon**: `trayIcon.setTemplateImage(true)` for menu bar dark/light mode

## Native Cloud Sync

- **Default-on providers**: detected Google Drive, OneDrive, iCloud, and any legacy custom `sync_path` folder are enabled automatically. Settings stores only local opt-outs in `sync_disabled_paths`; provider choices are not synced between machines.
- **Multi-target convergence**: `syncMerge()` reads every enabled provider, folds all remote states into one canonical local state, then writes that canonical state back to every enabled provider. This makes multiple providers useful redundancy instead of separate silos.
- **Merge algorithm**: shared pure helpers in `lib/clipboard-model.js` merge histories by stable item id/content key, merge pin/group metadata, preserve tombstones, and dedupe numpad slots.
- **`syncMerge()`** runs on startup + every 30s + debounced 500ms after local changes.
- **`insideSync` flag** prevents overlapping sync passes and prevents `saveHistory()`/`saveSettingsFile()` from re-triggering sync while a merge is already running.
- **Only writes if changed** — compares JSON strings of remote files before atomic writes to skip no-op churn.
- **Images synced bidirectionally** — content-addressed filenames mean no conflicts.
- **Remote settings exclusions**: `sync_path`, `sync_disabled_paths`, and legacy `numpad_slots` are excluded from remote settings writes.
- **Cloud account discovery** lives in `lib/cloud-accounts.js`.
- **macOS**: detects Google Drive and OneDrive from `~/Library/CloudStorage/`, plus iCloud Drive from `~/Library/Mobile Documents/com~apple~CloudDocs`.
- **Windows**: scans Google DriveFS mount letters and labels from PSDrive descriptions, DriveFS preference cache/WAL strings, and recent DriveFS logs; also detects OneDrive environment folders and common iCloud Drive folders.

## Scripts & Process Management

- **`start.sh`/`start.bat`** — call kill script, verify no leftover processes, abort if kill failed, then launch Electron in background
- **`update.sh`/`update.bat`** — one-step production-safe update: refuse tracked local code edits by default, fast-forward from Git, install dependencies if Electron is missing or package files changed, then call the platform start script to relaunch. Set `BOARDCLIP_UPDATE_ALLOW_DIRTY=1` in a developer checkout to use `git pull --rebase --autostash`.
- **`kill.sh`/`kill.bat`** — match processes by this checkout's Electron binary to avoid killing other Electron apps (VS Code, Discord, etc.).
- **Single-instance lock** via `app.requestSingleInstanceLock()` — second launch shows popup instead of starting duplicate
- **Auto-launch**: `app.setLoginItemSettings({ openAtLogin: true })` — toggled in Settings UI
- **Windows dev auto-launch**: un-packaged Electron writes `BoardClip.vbs` into the Startup folder and the VBS runs `start.bat` hidden. Avoid pointing login startup directly at `electron.exe`; without a stable working directory it can launch bare Electron or fail to start the app module.

## UI Patterns

- **`icon-btn` base class** — all small clickable icons share 24x24 rounded style. Variants: `.accent` (purple hover), `.danger` (red hover), `.close-btn` (bold ×)
- **Null-guard `it.text`** — always use `(it.text||'')` in templates
- **Filter tags**: shared app/site UI. Left click includes a filter, right click excludes it, and the global clear X resets search plus include/exclude filters.
- **Confirm dialog** shared between numpad reassign, group delete, and clear all
- **Settings auto-save** — max age/size save on input change, no Save button
- **Dev auto-reload** — `fs.watch` on `index.html` triggers `reloadIgnoringCache()` (debounced 300ms)

## AI Access (local MCP server)

- **Shape:** `mcp/boardclip-mcp.js` is a stdio MCP server (`@modelcontextprotocol/sdk` v1.x) spawned by AI clients. It reads shared clips straight from the JSON files (works app-closed); anything beyond the allowlist / any mutation / clipboard-write forwards to the running app over a **named pipe / Unix socket** control channel (`lib/control-server.js` in main.js, `lib/control-client.js` in the helper). NOT HTTP, no port. The helper never writes data files -> no races.
- **Allowlist by curation:** a clip is AI-visible iff it's in a group listed in `settings.groups_shared_with_ai` (the auto-created **"AI"** group is always shared). Non-shared = metadata only. `lib/mcp-core.js` is the PURE boundary (whitelist + secret filtering + shaping), reused by both helper and app. `lib/secret-guard.js` withholds likely-secrets even inside shared groups (`shareAnyway` per-item override).
- **Gating:** `mcpNeedsApproval` -> delete/clipboard-write/paste + beyond-allowlist reads ALWAYS prompt; pin/group/numpad/add are free on *shared* clips. Approval modal = a native frameless BrowserWindow (`mcp-approval.html`, NOT a browser) with once/session/always-per-tool + deny-by-default countdown; `ai_always_allow` persists grants. Modal auto-sizes via the `approval-resize` IPC.
- **Discovery:** app writes `~/.boardclip/mcp.json` `{dataDir,pipePath,secret,command,args,env,pid}` on launch when enabled; helper reads it (falls back to default userData for read-only). Registered command is **electron-as-node** (`process.execPath` + `ELECTRON_RUN_AS_NODE=1` + entry path) - works for source + packaged.
- **Reuse, don't duplicate:** the `apply*` functions in main.js (applyPinToggle/applyGroupAssign/applyDeleteItem/...) are the SINGLE mutation path for BOTH the IPC handlers and the MCP dispatch. HMAC auth is `lib/hmac-auth.js`, shared by P2P + the control channel. DEFAULT_SETTINGS adds `ai_access_enabled/groups_shared_with_ai/ai_always_allow/ai_approval_timeout_sec/mcp_secret` (mcp_secret + the 3 ai_* prefs are excluded from sync in `remoteSettingsPayload`; groups_shared_with_ai DOES sync).
- **Installers:** `lib/mcp-installers.js` - one shared JSON-map adapter factory covers most clients; Codex (TOML), VS Code (`servers`+type), Zed (nested command) are variants. Idempotent + non-clobbering. Settings shows detected-only + a "More" expander.
- **Testability seams:** `BOARDCLIP_DATA_DIR` overrides the data dir; `BOARDCLIP_MCP_DISCOVERY` overrides the discovery-file path. Use a fake HOME (+ USERPROFILE/APPDATA/XDG_CONFIG_HOME) to test the registrar without touching real client configs. `ensureAiGroupShared()` must run on BOTH enable and launch (idempotent) so a pre-enabled restart still has the AI group.
- **Secret-boundary invariants (don't regress):** (1) the helper reads UNHYDRATED history, so for large (>64KB) externalized clips `item.text` on disk is only the 1024-char preview - `get_clip` MUST hydrate then re-scan the full body with secret-guard before returning, else a secret past char 1024 leaks. (2) `searchClips` must withhold secret-flagged shared clips from results entirely (their mere presence is a match-oracle that reconstructs the value via regex probes). (3) only SHARED group names are ever exposed (clipView/buildContext filter to `groups_shared_with_ai`); private group names never leave the boundary. (4) `mcpHandleRequest` re-checks `ai_access_enabled` AFTER the approval await, not just before.
- **Per-user control channel:** the pipe (`\\.\pipe\boardclip-mcp-<user>`) / socket is per-user. Production is safe because the single-instance lock allows one BoardClip per user. BUT test instances launched with distinct `--user-data-dir` bypass that lock and will collide on EADDRINUSE + pile up as zombies (npx/electron children don't die from `timeout`/killing the wrapper PID) - always kill leftover `electron.exe` whose commandline contains your temp data-dir, and never kill the ones under `%APPDATA%/BoardClip` (the user's real app).
- **Continue is intentionally NOT installed** - it uses a YAML `mcpServers:` list, not the shared JSON-map adapter. Add a dedicated YAML adapter to support it for real.
- **secret-guard test fixtures trip GitHub push protection.** The detector tests necessarily contain secret-shaped strings (Slack `xoxb-`, `ghp_`, `sk-`, `AIza`, JWT, etc.); a full provider-token literal in the source blocks `git push` (GH013). Assemble them from split parts at runtime (`const j=(...p)=>p.join(''); j('ghp','_AbCd...')`) so no contiguous token literal sits in the committed file - the runtime value (and the test) is unchanged.

## Website Demo + Single-Source UI

The marketing site (`site/`) embeds an interactive demo of the popup. The
desktop app popup (`index.html`) and the demo (`site/index.html`) are a SINGLE
SOURCE — both drive the shared layer in `site/shared/clipboard-ui-core.js`
(`BoardClipCore`): `renderPopupShell` / `renderSettingsBody` / `renderClipItem`
/ `renderClipActions` / `renderFilterBar` (markup), `createDialogs(host)`
(confirm/prompt), and `createClipController(adapter)` (click dispatch + keyboard
nav + the confirm-gated flows: group-delete, numpad-replace, add-group,
clear-all). All popup CSS + theme variables live in `site/shared/clipboard-popup.css`
(`:root[data-theme]` for the app, `.bc-popup[data-theme]` for the demo window).

- **Do NOT add a per-side click handler, dialog, or popup CSS rule.** Extend the
  controller/adapter or the shared renderers. Each side only supplies a backend
  ADAPTER (app → `window.api`; demo → in-memory Core mutators + browser APIs) and
  its own data. This is what stopped the two popups from drifting (a confirm
  dialog used to exist in one but not the other).
- `test/ui-parity.test.js` enforces it: both consumers must call the shared
  renderers + `createClipController`, route through `controller.onClick/onKeydown`,
  never re-inline a bespoke dialog (`pendingAssign`/`confirmOverlay`/`demo-confirm`),
  and keep popup CSS/theme vars only in the shared sheet. Run `npm test`.
- `applyGroupAssign` (main.js) TOGGLES group membership; the per-clip group chip
  is therefore add-or-remove on both sides (no separate unassign endpoint).
- Theme: `settings.theme_mode` ('system'|'light'|'dark') persists the popup theme;
  whitelisted in the `save-settings` IPC handler + `DEFAULT_SETTINGS`; applied via
  `Core.applyTheme`. The Theme control lives in the shared settings body, so it
  shows in BOTH the app and the demo.

## Deploy (boardclip.app)

**The site does NOT auto-deploy on push.** `.github/workflows/netlify.yml` has a
"Check Netlify token" gate and `NETLIFY_AUTH_TOKEN` is unset as a repo secret, so
every Actions run reports success but the deploy step is SKIPPED. This is the
cause of the chronic "live site is stale" problem — pushing to `main` updates the
repo but NOT boardclip.app.

To actually publish, deploy manually from the repo (the Netlify CLI is
authenticated as `tobi@twoshot.app`, linked to project `boardclip-app`, siteId
`4ff28f37-765a-4482-a5ea-162fd7513013` via `.netlify/state.json` + `netlify.toml`):

```
npx --yes netlify-cli@latest deploy --prod --dir site
```

Verify the edge served the new bytes (bypasses browser cache):
`curl -s "https://boardclip.app/shared/clipboard-ui-core.js?cb=$(date +%s)" | grep -c createClipController`.

To make pushes auto-deploy, add `NETLIFY_AUTH_TOKEN` as a GitHub repo secret (or
connect Netlify's own Git integration). The desktop app does NOT deploy from
`main` — it ships via the release-binaries workflow on a release/tag.

## Debugging

- Run `npx electron .` directly (not via start.sh) to see stdout/stderr
- Main process errors go to terminal, renderer errors to DevTools (Cmd+Option+I)
- To test the app's renderer (`index.html`) without Electron, serve the repo root
  and load it with a stubbed `window.api` (CDP `Page.addScriptToEvaluateOnNewDocument`)
  — it renders the popup + settings and exercises the shared controller/dialogs.
