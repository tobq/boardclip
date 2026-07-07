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

- **macOS**: native `CGEvent` Cmd+V (`lib/macos-paste.js` `sendCommandV`), falling back to `osascript` (activate frontmost app + `keystroke "v"`) when a target app must be re-activated after hide.
- **Windows**: native `SendInput` Ctrl+V (`lib/windows-paste.js` `sendCtrlV`). The old `cscript`/VBScript `SendKeys` path is gone (200-500ms cold start + NumLock quirks).

## Quick-Paste (numpad macros) — robust, race-free by default

The numpad quick-paste used to paste STALE previously-copied content (worse under
lag; users had to retry). Root cause = the **clipboard backup/restore race**:
set macro on clipboard → Ctrl+V (async: the target reads the clipboard whenever it
drains its input queue) → restore old clipboard on a FIXED 150ms timer. Under lag
the target reads AFTER the restore → pastes the old clip. Proven + measured in
`scripts/qa-numpad-race.js` (real Electron clipboard; naive path goes stale at a
~160ms target read).

- **`lib/quick-paste.js` (`createQuickPaster`)** is the pure, dependency-injected
  orchestrator (unit-tested in `test/numpad-paste.test.js` with a fake clipboard +
  fake late-reading target). It: **serializes** requests through a promise chain
  (rapid presses queue, never dropped — kills "press it 3 times"); **coalesces**
  same-`coalesceKey` repeats within 90ms; **verifies** the clipboard write landed
  before pasting; **safe-restores** (only if the clipboard still holds our macro —
  never clobber a copy the user made mid-sequence); and applies a **lag-adaptive**
  restore delay (floor `quick_paste_restore_delay_ms` default 400ms, + `3× measured
  scheduler-lag`, capped 1200ms) for the clipboard path.
- **ONE delivery mechanism: the REAL clipboard paste.** Quick-paste puts the item
  on the clipboard, synthesizes Ctrl/Cmd+V, and safe-restores — the SAME primitive
  (`setClipboardToItem` + `simulatePaste`) the panel-click paste (`pasteAndHide`)
  uses. Exact content pasted atomically, immune to the target app's autocomplete/IME.
- **Keystroke-injection "type" mode was REMOVED (2026-07-07) — do NOT reintroduce it.**
  It typed the macro as raw key events, so `\n` became a real Enter; a numpad slot
  holding multi-paragraph boilerplate fired ~22 unintended sends into a chat composer.
  The owner had already rejected typing as the default ("super slow + buggy, newlines
  fire Enter, I didn't want manual-type shit"), and it was the ONLY reason numpad
  diverged from the working panel-click path — so it, `lib/keystroke-inject.js`, the
  orchestrator `strategy`/`skipClipboard`/`fallback` seam, the `quick_paste_mode`
  setting, and the "Paste as" UI control were all deleted. `test/numpad-paste.test.js`
  #7 guards it: a multi-line snippet must paste in ONE clipboard write + ONE Ctrl/Cmd+V
  with newlines intact, never as Enter presses.
- **Why NOT delayed-render clipboard ownership** (an earlier plan): its only extra
  signal (`WM_RENDERFORMAT`) is spoofable by passive clipboard readers (Windows
  Clipboard History et al. render right after we take ownership) → false "consumed"
  → early restore → the real late read still stale. It doesn't beat a longer/adaptive
  delay and adds ~500 lines of risky FFI. Rejected on evidence.
- **Settings** (per-machine, not synced; excluded in `remoteSettingsPayload`):
  `quick_paste_restore` (restore the previous clipboard afterwards) and
  `quick_paste_restore_delay_ms` (floor restore delay, adapts up under lag). There is
  no paste-mode setting anymore.
- **Dispatch is unified**: hardware numpad (Windows LL hook `handleNumpad`), panel
  number keys (`numpadPasteAndHide`), and the global quick-paste shortcut
  (`handleQuickPaste`) ALL route through `runNumpadSlotAction` → `numpadPaste` →
  `getQuickPaster().request()`. `handleNumpad` no longer has a bespoke path.
- **Hook auto-repeat suppression** (`lib/windows-hook-worker.js`): a held/lag-
  stretched Numpad key emits repeated `WM_KEYDOWN` with no `WM_KEYUP`; the worker
  tracks `numpadHeld`/`numpadIntercepted` so the paste fires exactly ONCE and the
  paired keyup is swallowed too. Kills double/triple pastes.

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

### KNOWN DATA-LOSS BUG (2026-07-06 incident) — sync merge vs content-hash edits — UNFIXED

Sync is currently PAUSED on the user's machine (`sync_disabled_paths` = all 3 providers,
`p2p_enabled: false`) until this is fixed. Do NOT re-enable sync before fixing.

- **Mechanism**: text ids are content hashes, so every editor save = new id + a
  TOMBSTONE for the old id (`applyTextEdit`). Cloud providers lag; a merge pass can
  read a stale provider that still holds the note under a now-tombstoned id and either
  (a) resurrect an OLD version (the new id lost a race), or (b) drop the live note
  entirely and — because `syncMerge()` writes canonical state back to EVERY provider —
  propagate the deletion everywhere, making it permanent.
- **Born 2026-05-17** (`7e7fa7c` content-hash ids + `686805f` tombstones + `e391b52`
  default multi-provider sync); **practically triggerable since 2026-06-26** (`4e45c7d`
  built-in editor made rapid in-app re-hash-per-save common). Verified against a real
  incident: a heavily-edited pinned note regressed at 13:08 and was dropped at 17:05
  (diagnostics: `sync.merge local_changed=true full_sync=true wrote_remotes=true`),
  deletion propagated to all 3 providers.
- **Fix direction**: an edit must atomically LINK old id -> new id in the merge (e.g.
  a supersedes/rename record with a recency clock), so a stale provider's copy of the
  old id merges INTO the new item instead of racing the tombstone. Requires a
  reproduction harness (multi-provider lag simulation) before touching live data.
- **Forensics kit**: `clipboard-backups/` (content-addressed history snapshots, see
  Backup subsystem below; 48h/512MB/2000-manifest retention),
  `clipboard-edit-archive/` (raw editor buffers, 1yr/100MB — this is what recovered the
  lost paragraph), `boardclip-diagnostics.jsonl` (64MB cap), plus cloud providers'
  own version history. During any incident, copy relevant backups OUT of the retention
  dirs immediately — pruning runs on every save and destroyed evidence mid-investigation.
  To read a content-addressed snapshot: `backupStore.readSnapshot(dir, manifestPath)`
  (`lib/backup.js`) resolves item hashes back into a full history array.

## Backup subsystem (`lib/backup.js`) — content-addressed local time-machine

- **Roles (the failure-mode matrix)**: LOCAL backups (same drive) guard against
  logic/software bugs (a copy the buggy code didn't touch — this recovered the note);
  they are NOT hardware redundancy (drive dies → all local copies die). HARDWARE
  redundancy = the CLOUD providers (different machines), but cloud PROPAGATES logic-bug
  deletions — so it's only trustworthy once the sync-merge bug (above) is fixed. Decision
  (owner-approved 2026-07-07): keep local lean as the logic-bug time-machine; cloud is the
  hardware-redundancy layer AFTER the sync fix. No separate off-drive target.
- **Content-addressed store**: `clipboard-backups/objects/{sha256}.json` is a shared pool
  of stored items (+ the settings object); a snapshot is a small manifest
  `clipboard-backups/snapshots/{stamp}-{reason}.json` listing the ordered item hashes.
  Unchanged items across snapshots share ONE blob, so an edit to one note costs ~one
  object + a manifest, not a full ~4.5MB history copy (verified on the real 5670-item
  history: 1 edit = 1 new object). Everything stays plain-text JSON (greppable in an
  incident). Reuses `lib/blob-store` (atomic write/dirs) + `lib/retention` (planRetention).
- **Retention** = `backupStore.pruneBackups(dir, {maxAgeMs:48h, maxBytes:512MB,
  maxManifests:2000, now})`: evict manifests by age+count, then mark-sweep GC any pool
  object no surviving manifest references, then drop oldest manifests until under the byte
  cap. Legacy full `{stamp}-{reason}-{hash12}.json` snapshots are still read (`readSnapshot`
  handles both shapes) and age out — no risky bulk migration.
- **`main.js` wiring**: `maybeBackupHistoryBeforeWrite` keeps the change-detection +
  60s throttle (app state), then calls `backupStore.writeSnapshot`; on ANY error it FALLS
  BACK to a full-JSON write (`history.backup.fallback` diagnostic) so a backup is never
  silently skipped. Tests: `test/backup.test.js` (dedup, exact round-trip, one-edit=one-
  object, age-GC, size cap, legacy compat).
- **Phase 2 (not done)**: fold the edit-archive's `done-` finished buffers into the same
  object pool (they overlap it) and move its prune under `lib/backup.js` for one retention
  home. Kept separate for now because its live per-keystroke drafts are a distinct
  crash-recovery role. Working spec: `BACKUP-UNIFY-PLAN.md` (untracked).

## Scripts & Process Management

- **`start.sh`/`start.bat`** — call kill script, verify no leftover processes, abort if kill failed, then launch Electron in background
- **`update.sh`/`update.bat`** — one-step production-safe update: refuse tracked local code edits by default, fast-forward from Git, install dependencies if Electron is missing or package files changed, then call the platform start script to relaunch. Set `BOARDCLIP_UPDATE_ALLOW_DIRTY=1` in a developer checkout to use `git pull --rebase --autostash`.
- **`kill.sh`/`kill.bat`** — match processes by this checkout's Electron binary to avoid killing other Electron apps (VS Code, Discord, etc.). **They EXCLUDE the AI MCP helper** (same `electron.exe`, identified by a `boardclip-mcp.js` arg on the command line — Windows uses `Get-CimInstance Win32_Process` since `Get-Process` can't see the command line; macOS/Linux use `ps -Ao pid=,command=` + `grep -v boardclip-mcp.js`). The MCP helper is spawned + owned by an AI client (Forge/Claude/Codex), so restarting the app (start/update → kill) must NOT take it out — an AI client has no liveness re-spawn for a stdio child that dies AFTER connecting (it just returns "Not connected" forever until the client reconnects). Fixed 2026-07-07 (`1c1eda2`); the Forge-side auto-reconnect that also covers this lives in forge `services/mcp.ts` (`McpConnection.ensureLive`).
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
- **Allowlist by curation (fully opt-in):** a clip is AI-visible iff it's in a group listed in `settings.groups_shared_with_ai` (the auto-created **"AI"** group is always shared). Non-shared = metadata only. `lib/mcp-core.js` is the PURE boundary (whitelist + shaping), reused by both helper and app. There is deliberately NO "looks like a secret" auto-withholding — group sharing is the single opt-in gate, so a clip the user put in a shared group is shared as-is. (A `secret-guard` heuristic layer existed and was removed as redundant/annoying; don't reintroduce it.)
- **Gating:** `mcpNeedsApproval` -> delete/edit/clipboard-write/paste + beyond-allowlist reads ALWAYS prompt; pin/group/numpad/add are free on *shared* clips. Approval modal = a native frameless BrowserWindow (`mcp-approval.html`, NOT a browser) with once/session/always-per-tool + deny-by-default countdown; `ai_always_allow` persists grants. Modal auto-sizes via the `approval-resize` IPC.
- **Discovery:** app writes `~/.boardclip/mcp.json` `{dataDir,pipePath,secret,command,args,env,pid}` on launch when enabled; helper reads it (falls back to default userData for read-only). Registered command is **electron-as-node** (`process.execPath` + `ELECTRON_RUN_AS_NODE=1` + entry path) - works for source + packaged.
- **`edit_clip` tool (replace/append clip text):** because text ids are content-addressed (`txt:{sha256}`), there is NO in-place text mutation - editing changes the id, which is why an "edit" was previously an add+delete dance. The tool REUSES `applyExternalTextEdit` (the same metadata-preserving core the built-in editor + conflict/unify flows use): when `originalText` matches the current item, `clipboardModel.applyTextEdit` mutates the item in place, re-derives its content-key id, keeps pin/groups/numpad, and tombstones the old id - so all metadata survives automatically. Returns the NEW id. `append:true` newline-joins onto existing text (done app-side, so it works on non-shared clips too); else it replaces. In `MCP_ALWAYS_GATED` (lossy overwrite -> prompts like delete, NOT free-on-shared; users can "always allow" per-tool). Images can't be edited. Don't hand-roll add+delete for an edit.
- **Reuse, don't duplicate:** the `apply*` functions in main.js (applyPinToggle/applyGroupAssign/applyDeleteItem/...) are the SINGLE mutation path for BOTH the IPC handlers and the MCP dispatch. HMAC auth is `lib/hmac-auth.js`, shared by P2P + the control channel. DEFAULT_SETTINGS adds `ai_access_enabled/groups_shared_with_ai/ai_always_allow/ai_approval_timeout_sec/mcp_secret` (mcp_secret + the 3 ai_* prefs are excluded from sync in `remoteSettingsPayload`; groups_shared_with_ai DOES sync).
- **Installers:** `lib/mcp-installers.js` - one shared JSON-map adapter factory covers most clients; Codex (TOML), VS Code (`servers`+type), Zed (nested command) are variants. Idempotent + non-clobbering. Settings shows detected-only + a "More" expander.
- **Testability seams:** `BOARDCLIP_DATA_DIR` overrides the data dir; `BOARDCLIP_MCP_DISCOVERY` overrides the discovery-file path. Use a fake HOME (+ USERPROFILE/APPDATA/XDG_CONFIG_HOME) to test the registrar without touching real client configs. `ensureAiGroupShared()` must run on BOTH enable and launch (idempotent) so a pre-enabled restart still has the AI group.
- **Boundary invariants (don't regress):** (1) only SHARED group names are ever exposed (clipView/buildContext filter to `groups_shared_with_ai`); private group names never leave the boundary. (2) `mcpHandleRequest` re-checks `ai_access_enabled` AFTER the approval await, not just before.
- **Per-user control channel:** the pipe (`\\.\pipe\boardclip-mcp-<user>`) / socket is per-user. Production is safe because the single-instance lock allows one BoardClip per user. BUT test instances launched with distinct `--user-data-dir` bypass that lock and will collide on EADDRINUSE + pile up as zombies (npx/electron children don't die from `timeout`/killing the wrapper PID) - always kill leftover `electron.exe` whose commandline contains your temp data-dir, and never kill the ones under `%APPDATA%/BoardClip` (the user's real app).
- **Continue is intentionally NOT installed** - it uses a YAML `mcpServers:` list, not the shared JSON-map adapter. Add a dedicated YAML adapter to support it for real.

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
- **Editor find highlight** (`createEditor` in `clipboard-ui-core.js`): matches are painted
  by a backdrop `<div class="bc-editor-hl">` that mirrors the textarea's text (transparent
  text + `<mark>` spans) behind a transparent textarea — the standard "highlight in a
  textarea" technique (a textarea can't hold markup; the CSS Custom Highlight API doesn't
  work on textareas). The textarea forces `overflow-y: scroll` (always-on 10px gutter) so
  both layers wrap at an identical width. Escape all mirrored text with `escapeHtml` (XSS).
  **Scroll-to-match MUST measure the current `mark.offsetTop`, NOT a char-index→line-count
  estimate** (`editorScrollTopForIndex` counts only `\n`, so it lands short on soft-wrapped
  lines — the "highlights but doesn't scroll" bug). QA the editor with a doc of LONG WRAPPING
  lines, not `\n`-separated short lines, or the wrap bug hides.
- Theme: `settings.theme_mode` ('system'|'light'|'dark') persists the popup theme;
  whitelisted in the `save-settings` IPC handler + `DEFAULT_SETTINGS`; applied via
  `Core.applyTheme`. The Theme control lives in the shared settings body, so it
  shows in BOTH the app and the demo.

## Multi-select + bulk actions (Ctrl/Shift-click, bulk Paste/Group/Unify/Delete)

- **Selection is LIFTED into `createClipController`** (`selectedIds` set + `anchorId`
  + `focusId`, replacing the old per-consumer `selectedIdx`). Consumers supply only
  `visibleIds()`, `renderSelection(state)`, `allItems()`, `groupNames()`, and bulk
  backends (`deleteClips`/`restoreClips`/`groupAssignMany`/`pasteMany`/`startUnify`)
  + `offerUndo`. `Core.applySelectionUI` paints `.selected` (focus cursor) +
  `.multi-selected` (checked set) and drives `#selectionBar` (added to
  `renderPopupShell`). Do NOT reintroduce a per-side selection index —
  `test/ui-parity.test.js` #9 + `test/multiselect.test.js` guard it.
- **Row demotion + shared menu**: `renderClipActions` is now the SLIM row (primary
  action + a `clip-menu` "..." button). `rename` (Set title) + `del` are DEMOTED
  into `renderClipMenu` (the complete per-clip surface); `renderBulkMenu` is the
  2+-selection variant. Menu items reuse the SAME `data-action` attrs the controller
  already dispatches — no new dispatch. The menu root carries `data-id`, so the
  `gp-btn`/`np-btn` handlers resolve their target via `closest('[data-id]')` (works
  in the in-row picker AND the detached popover — that's why the resolution changed
  from `closest('.item')`). `createMenu(host)` = the shared click popover; app host =
  `document.body` (tokens on `:root`), demo host = `demoWindowEl` (tokens on
  `.bc-popup`). Bulk Group is tri-state (`renderBulkGroupTree` via `groupMembership`:
  all→remove, some/none→add).
- **Delete = instant + Undo toast**, no confirm dialog. `Core.showActionToast`
  reuses the `.toast` element; Ctrl/Cmd+Z re-invokes the undo. `applyDeleteItems`
  RETAINS the text/image blobs (no `removeItemImage`/blob prune) so restore always
  has content; `applyRestoreItems` clears the item tombstone so sync can't resurrect
  the deletion. Single delete (from the menu) routes through the SAME `deleteIds`
  path as bulk, so it too gets Undo.
- **Unify** (fold N text clips → 1) REUSES the conflict `BrowserWindow` +
  `createReconciliationView` verbatim. `startUnify`→`openUnifyWindow`→`unify-step`
  IPC folds an accumulator oldest→newest; `editor.html`'s `mountReconcile` branches
  on `record.unify` (advance vs `resolveConflict`+close). ATOMIC: sources aren't
  touched until the final step confirms, so closing any step aborts with zero
  changes (`editor-close` handles the `unify:` sessionId prefix like `conflict:`).
  The view takes `record.title`/`saveLabel`/`unify` (hides "Remove conflict").
  Merged clip carries the UNION of sources' groups + pin + numpad slot. Text-only:
  Unify is hidden when any image is selected.
- **Reconciliation view = vendored CodeMirror 5 MergeView** (user asked for
  IntelliJ-style EXPLICITLY in Codex session 019f0e67 2026-06-28; two hand-rolled
  attempts fell short — don't hand-roll a third): Current (read-only) | **Result
  (fully editable)** | Incoming (read-only), gutter arrows pull chunks into the
  middle, `connect:'align'` aligns + syncs panes, `collapseIdentical` folds
  unchanged stretches, `ignoreWhitespace` on by default (bar toggle rebuilds the
  view, preserving Result text). Vendored in `site/shared/vendor/cm5/`
  (codemirror@5.65 lib + merge addon + diff-match-patch browser shim; see its
  README) and loaded by BOTH `editor.html` and the demo — guarded by ui-parity #8.
  Skinned entirely with tokens in clipboard-popup.css (`.bc-merge-host` block).
- **The wrapper (`createReconciliationView`) adds**: change count + prev/next nav,
  red-tinted **conflict** regions (Current & Incoming disagreeing with EACH OTHER,
  computed seed-independently: touching left/right chunk pairs, or a two-sided
  replace when one view is clean — plain chunk-overlap NEVER fires when Result is
  seeded from one side), a clickable conflict chip, merge-all-non-conflicting
  (applies chunks bottom-up outside conflict regions), Alt+Up/Down/Left/Right/B
  keys, title pick-chips when the two titles differ, a save-warning while
  sync-conflict regions remain (SKIPPED for unify — the union seed already holds
  both sides; warning there blocked saves invisibly, caught only by the real-app
  pen-test), and a plain-textarea fallback if the vendor scripts fail to load.
- **Merge seeds**: `base.text` when the record has one (true 3-way) → unify:
  `Core.unionMergeText` (shared regions once + both sides of every change; built
  on `diffLineHunks`/`lcsSegments`, which remain the in-house pure diff for
  seeding + tests) → else Current. **CRLF is normalized to LF at the view
  boundary** (`toLF`) — stray `\r` defeats BOTH the addon's chunking and
  `collapseIdentical` (its ignoreWhitespace covers spaces/tabs only) and caused
  the original "all-green wall, zero matched lines" bug.
- **Collapse of identical sections (ignore-whitespace)**: the wrapper's `wsNormText`
  normalizes blank-line RUNS + trailing whitespace for the merge view when the WS
  toggle is on, so regions that differ only in blank spacing become truly identical
  and FOLD (the addon's ignoreWhitespace won't collapse blank-line diffs; extending
  its splice to newlines corrupts line bookkeeping). This DOES mean an ignore-ws
  merge saves normalized blank runs — toggle WS off to preserve every byte. Vendored
  merge.js BOARDCLIP patches make it fold like a real diff viewer: `unclearNearChunks`
  collapses THROUGH quiet chunks, `collapseIdenticalStretches` always keeps `margin`
  edge context (else a fully-identical doc folds line 0 and the Result cursor's
  clearOnEnter instantly unfolds it — the "no differences but not collapsed" bug),
  and `MergeView.bcRecollapse()` re-folds after a merge/decline (wired into the
  wrapper's forceRecompute). Verify collapse with a doc that's identical except
  blank-line spacing — it must fold to a widget, not scroll.
- **Real-app pen-test harness**: `node scripts/qa-app-pentest.js` boots a sandbox
  instance (temp `BOARDCLIP_DATA_DIR` + own `--user-data-dir` + CDP port, driven
  over raw WebSocket CDP — Node ≥21). SAFETY: it pre-disables every detected
  cloud provider in the sandbox settings (else the sandbox would default-enable
  sync and merge QA data into the user's REAL synced folders), p2p + AI off, and
  never triggers `pasteMany` (would Ctrl+V into the focused window). Kills only
  electron processes whose cmdline contains its temp dir.
- **Chord routing when search is always-focused**: Ctrl/Cmd+A and Ctrl/Cmd+Z route
  by whether the focused field HAS TEXT (text → native field behavior; empty →
  clip select-all / delete-undo). Don't gate purely on `isTypingTarget` — the app's
  search box is focused nearly always, which would make the chords unreachable.
- **`installSubmenuAutoflip`** (installed once by the controller on
  `menuHost||document`) flips/clamps hover submenus: bounds = viewport for the app
  window but the `.bc-popup` box for the embedded demo; uses setTimeout not rAF
  (rAF halts in background tabs); `.flip-x` class opens side-submenus leftward.
  `.list .item` is `user-select:none` (shift-click was smearing text selection).
- **Selection bar**: Group is its OWN button (`bulk-group-open` → group-only
  tri-state popover via `bulkGroupTreeHtml`, shared with the bulk menu submenu).
  Never fuse it with a "more" menu; the full bulk menu lives on right-click.
- **ONE floating-surface rule** (`.numpad-picker, .tag-submenu, .bc-menu { ... }`
  in clipboard-popup.css, same shadow as `.dialog`) defines every popup panel's
  bg/radius/shadow/padding — do not re-fork per-surface variants (ui-parity #10
  counts the `--menu-edge` shadows). **Numpad renders in keypad formation**
  (`NUMPAD_LAYOUT` = 7 8 9 / 4 5 6 / 1 2 3 + `.np-row` 3-col grid) via the ONE
  `renderNumpadButtons` shared by the in-row picker AND the "..." menu submenu
  (renderItemPicker's old inline loop was a duplication — don't reintroduce it).
- **Gotcha — verifying `.item` background**: `.item` has a `background` CSS
  transition, so `getComputedStyle` read immediately after toggling
  `.selected`/`.multi-selected` returns the PRE-transition (transparent) value;
  `.selection-bar` has no transition so it reads instantly. Verify row backgrounds
  after >150ms or inject `transition:none` — else you chase a phantom "tint not
  applying" bug (I did; it applies fine).

## Design tokens, appearance variants, native glass

- **ONE token layer** in `site/shared/clipboard-tokens.css`, `@import`ed as the
  FIRST rule of `clipboard-popup.css` (relative path works for both app and site)
  and by `site/styles.css`; also linked directly by `mcp-approval.html`. Three
  tiers: (a) PRIMITIVES on `:root` (graphite `--g-050..--g-950`, `--blue-*`,
  `--teal-*`, functional `--green-500/--amber-500/--red-500`, `--sp-*`, `--r-*`,
  `--fs-*`, `--icon-sm/md/lg`, `--dur`+`--ease`); (b) SEMANTIC on `[data-theme]`
  keeping the EXACT old names (`--bg/--surface/--text/--accent/--line/...`) so
  component CSS needed only value swaps, no renames; `--accent-bg`/`--mark-bg`
  derive via `color-mix` over `--accent`. Palette is **graphite + cool blue** —
  the old purple (`#a78bfa/#7c3aed/#8b5cf6`) is gone (a `ui-tokens.test.js` guard
  fails if it returns). Dark `--active-fg` is DARK ink (`--g-950`) because black
  on `--blue-500` (5.7:1) beats white (3.7:1); light uses white on `--blue-600`.
- **Appearance variants** are `data-*` attributes on the same root that carries
  `data-theme`, swapping a small disjoint token set (see the tier-(c) blocks):
  `data-surface` (glass/solid), `data-accent` (blue/teal/mono), `data-density`
  (normal/compact), `data-corners` (soft/sharp), `data-borders`
  (bordered/borderless). Applied by shared `Core.applyVariants(root, opts)`;
  audited live via `Core.createVariantSwitcher` (reuses `.seg`/`.seg-btn`). The
  app renders **Surface as a real user setting** + the other axes ONLY when
  `runtime_info.debug_variants` (`!app.isPackaged || BOARDCLIP_DEBUG_VARIANTS`);
  the demo renders all axes always-on, persisted to `localStorage`. Ship default
  is graphite+blue+glass-where-supported+normal+soft. New settings keys
  (`surface_style` + `accent_variant/ui_density/ui_corners/ui_borders`) are
  per-machine — whitelisted in `save-settings`, deleted in `remoteSettingsPayload`.
- **Native glass = popup pane ONLY** (editor/conflict/approval stay solid — better
  for a text editor + a security prompt). Centralized in main.js
  `glassSupport()` (macOS→vibrancy; Win build ≥22000→acrylic; else none),
  `resolvedSurfaceStyle()`, `popupSurfaceOptions()` (spread into `createPopup`),
  and `applySurfaceToPopup()` (live toggle, no window recreate: mac keeps
  `transparent:true` always + `setVibrancy`, Win uses `setBackgroundMaterial`).
  `notifyColorSchemeChanged` must NOT stamp an opaque bg while glass is on. The
  renderer scrim (`:root[data-surface="glass"] body::before` with `--glass-tint`
  + `backdrop-filter`) is in `index.html`; the OS provides the real blur behind a
  transparent window (CSS `backdrop-filter` can't blur the desktop). Resolved
  surface reaches the renderer via `runtime_info.surface_style` + the
  `surface-changed` broadcast (`preload.onSurfaceChanged`); editor/conflict get
  the non-surface axes via `appearanceVariantPayload()` on `editor-init`; the
  approval modal via `approval-settings` (`mcp-approval-preload.onSettings`).
- `.mi.sm/.mi.lg/.mi.mid` utilities replaced the ~10 inline icon `style=`s; the
  `ui-tokens.test.js` guard fails if an inline `style="font-size` reappears.

## Deploy (boardclip.app)

**Pushes to `main` auto-deploy `site/` to boardclip.app** via Netlify's native
GitHub integration (connected 2026-06-25). The Netlify project `boardclip-app`
(siteId `4ff28f37-765a-4482-a5ea-162fd7513013`, team TwoShot) is linked to
`tobq/boardclip`, branch `main`, **publish directory `site`** (no build command —
static). CRITICAL: the publish dir MUST stay `site`; the repo ROOT `index.html`
is the desktop-app popup, so publishing the root would put the app popup on the
homepage.

History: for its first ~5 weeks the site was a CLI-only Netlify project (provider
`netlify-git`, not Git-linked), so pushes never deployed — that was the chronic
"live site is stale" bug. The `.github/workflows/netlify.yml` Actions workflow was
a never-finished band-aid (it skips without a `NETLIFY_AUTH_TOKEN` secret) and is
now redundant — the native integration handles deploys.

Manual deploy (fallback, e.g. to publish without a push) — the Netlify CLI is
authenticated as `tobi@twoshot.app`:

```
npx --yes netlify-cli@latest deploy --prod --dir site
```

Verify the edge served new bytes (bypasses browser cache):
`curl -s "https://boardclip.app/shared/clipboard-ui-core.js?cb=$(date +%s)" | grep -c createClipController`.

Desktop app distribution has TWO consistent paths, both driven by `main`:
- **Git/CLI installs** auto-update via `lib/auto-update.js` — polls the latest
  `main` commit (GitHub API) every ~4h + 90s after launch, runs `update.bat`
  (git pull → hot-reload if only `index.html`/`site/shared/*` changed, else
  relaunch). Disabled on dirty checkouts (protects local edits) and on packaged
  builds (no `.git`).
- **Installer downloads** (`.exe`/`.dmg`): `release-binaries.yml` now runs on
  every push to `main` that touches app code (`paths-ignore: site/**`, docs) and
  republishes a single rolling **`latest`** GitHub release (`make_latest: true`)
  that the site's `/releases/latest/download/...` button points at. So the
  download stays in lockstep with `main` — no version tag needed. (Packaged
  installs still don't self-update; that'd need electron-updater — not wired.)
Tagging is optional/archival now, not required to ship.

## Debugging

- **The user's live app runs from `C:\Users\Tobi\AppData\Local\BoardClip`** (a separate
  clone of this repo), NOT this dev checkout. Editing files here does nothing to the
  running app until the change is mirrored there (copy the changed files, or commit+push
  and run its `update.bat`). Renderer files (editor.html, site/shared/*) are loaded fresh
  per window — a newly opened popup/editor window picks up mirrored changes without an app
  restart, but ALREADY-OPEN windows keep the old code until closed and reopened. main.js
  changes always need a full restart.
- Run `npx electron .` directly (not via start.sh) to see stdout/stderr
- Main process errors go to terminal, renderer errors to DevTools (Cmd+Option+I)
- To test the app's renderer (`index.html`) without Electron, serve the repo root
  and load it with a stubbed `window.api` (CDP `Page.addScriptToEvaluateOnNewDocument`)
  — it renders the popup + settings and exercises the shared controller/dialogs.
