# BoardClip - CLAUDE.md

## Architecture

- **Electron app** — main process (`main.js`) handles clipboard polling, tray, global shortcuts, IPC, sync
- **Preload bridge** (`preload.js`) — contextBridge exposing API to renderer
- **Single-file UI** (`index.html`) — loaded via `loadFile`, images served via `clip-img://` custom protocol
- **Cross-platform**: macOS + Windows. Platform differences handled inline with `process.platform` checks
- **RULE (owner, non-negotiable, 2026-10-07): every change must work on macOS AND Windows.** Design for
  both up front and audit the mac paths before shipping: Cmd vs Ctrl (`metaKey`/`input.meta`), app-menu key
  equivalents (macOS can fire default menu roles like View zoom BEFORE the page sees the key - claim such
  chords in main's `before-input-event`, never rely on a renderer `preventDefault` alone), Option = Alt, no
  blur-to-hide on the mac popup, dock hidden, `startDrag` needs a non-empty icon, Finder-illegal file-name
  characters. When reporting, say what was verified on which platform (QA here runs on Windows only).
- Data: `clipboard-history.json`, `clipboard-images/`, `clipboard-settings.json`

## Key Data Model

- **History item ids**: text items use a sha256 content key (`txt:{hash}`); image items use their content-addressed image filename (`img:{file}`).
- **`pin` field** on history items: `null`/absent means unpinned; an object means pinned. Shape is `{ number?: 1-9, groups?: string[], updatedAt?: number }`.
- **Legacy migration**: `lib/clipboard-model.js` migrates old `pinned`/`group` fields into the unified `pin` object before merging or rendering.
- **Groups**: group names live in `settings.groups`; item membership lives in `item.pin.groups`.
- **Tombstones**: deleted items and groups are retained for 30 days in settings so sync cannot resurrect removals from stale providers.
- **Version-guarded delete tombstones (2026-07-14)**: because ids are content hashes, a bare tombstone would clobber a *legitimate re-copy/edit of the same content after a delete* (the cross-device "surprise" — you delete, re-copy the same text, next sync drops your fresh copy because the tombstone still syncs from the other device). `mergeHistories` now uses `tombstoneMap` (id → `deletedAt`) not a plain id-Set, and drops an item **only if `itemMutationClock(item) <= deletedAt`**. A copy touched AFTER the delete (newer capture `ts`/`updatedAt`, pin, title, or `tsUpdatedAt`) beats the tombstone and survives; a stale pre-delete copy on a lagging provider still stays deleted (resurrection guard intact). Convergent + idempotent — the tombstone stays in settings and ages out at 30 days without re-dropping the live item. Guard is on the **plain-delete branch only** (`!targetKey`); the supersede/edit-lineage branch is untouched. Tests in `test/clipboard-model.test.js` (re-add-after-delete survives, stale copy stays deleted, pin-touch-after-delete survives).
- **Edit-lineage cycles + broken chains (found 2026-10-03, fixed in `liveSupersedeLinks`/`deletedAfterEdit`)**:
  typing a change and taking it back inside one editor session (A->B->A, each step an idle commit)
  records both A->B and B->A. The old `supersedeMap` resolved the live head to ITSELF and its own older
  edit tombstone then dropped it in `mergeHistories` (`targetKey && deleted.has(targetKey)`, version
  guard skipped) on the next sync pass, the only local copy included. Second hole: a stale copy whose
  chain ends at an id that exists nowhere and was never tombstoned bypassed its OWN tombstone, so copies
  the user explicitly deleted came back. Incident: "forge launch plan" head of 29 Sep vanished, the 3 and
  7 Sep versions (deleted that same evening) resurrected, the next edit started from 7 Sep. Fix: a link
  whose `from` has a NEWER link into it is dropped (A is live again); a tombstone with `rev` or >5 s after
  the link is a real delete and runs `tombstoneSuppresses` even inside a lineage. A copy whose own
  mutation clock is >5 s NEWER than its outgoing link (that old text copied again, or pinned/titled after
  the edit) is "reborn": no lineage, so it is not folded into the edited note (it used to vanish from
  history on the next sync pass); its tombstone's version guard decides instead. Defence in depth: the
  LINEAGE TRIPWIRE at the end of `mergeHistories` keeps any local clip a merge would drop unless its own
  (or its lineage head's) tombstone is an explicit delete or a newer version of the same note survives
  (`lineageFamilies`); it reports `drop_blocked` (diagnostics `sync.lineage_drop_blocked`). The optional
  `report` array (main.js passes it in its single `mergeHistories` wrapper) feeds `sync-forensics.jsonl`.
  Audit tools: replay
  `mergeHistories` on the edit-archive text with snapshot settings; list A<->B pairs across
  `settings.supersedes` + the oldest `clipboard-backups` snapshot's settings.
- **Content-addressed images**: filenames are md5 hash of PNG content (`{hash}.png`), naturally deduplicates.

## Clipboard Operations

- **Polling** every 400ms via `clipboard.readImage()` / `clipboard.readText()`
- **`addToHistory(entry, matchFn)`** — shared helper that deduplicates, preserves pinned/group metadata, and prunes
- **`setClipboardToItem(item)`** — shared helper to write text or image to clipboard
- **Backup/restore**: `backupClipboard()` saves text/html/rtf/image, `restoreClipboard()` writes them back. Used by numpad quick-paste.
- **`pollGate`** flag pauses polling during paste sequences to prevent interference
- **Editor clipboard follow (`lib/clipboard-follow.js`, 2026-10-07)**: while the clipboard holds an open
  editor's note (exact text, line endings ignored, either the live draft or the last save), every save of
  that note also goes onto the clipboard, so nobody re-copies from the editor. It is re-checked on editor
  open, editor focus (`editor-focus` IPC), every poller capture (`observeEditorsClipboard`, '' for an image)
  and every save (`followEditorSave` in `commitEditSession`). Before writing it checks the clipboard still
  holds what it last saw; anything else copied meanwhile stops it ("Clipboard changed elsewhere"). The
  footer of the shared `createEditor` (opt-in `clipboard` option) shows "On clipboard - edits update it" or
  a Copy button (`editor-copy` IPC = save + adopt). Saves also fire when the editor window loses focus.
  `applyExternalTextEdit` NEVER writes the clipboard any more (the old copy-on-close `writeClipboard: final`
  is gone); writes go through `writeEditedTextToClipboard` (pollGate + lastText = no re-capture). Live
  clipboard QA is deliberately NOT automated: the live app polls the same system clipboard and would
  capture QA text into real, synced history.

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
- **Template tray icon**: `trayIcon.setTemplateImage(true)` for menu bar dark/light mode.
  It MUST be `iconTemplate.png` (+`@2x`): the monochrome clipboard glyph, black on transparent,
  rendered from `assets/boardclip-tray.svg` (see "Logo" below). macOS
  keeps only a template's alpha channel, so the full-colour `icon.png` (an opaque rounded
  square) rendered as a solid white box in the menu bar (fixed 2026-09-03). Never `resize()` the
  template; `createFromPath` picks the `@2x` itself.
- **Logo = ONE vector source (2026-10-09)**: `assets/boardclip-logo.svg` (the clipboard in the
  accent blue on the app's graphite, a copy behind it) + `assets/boardclip-tray.svg` (the macOS
  template glyph). `npm run sync:icons` (`scripts/render-icons.js`, Electron, canvas in a hidden
  window) draws EVERY size from the vector: icon.png 256 / @2x 512, assets/boardclip-icon.png,
  a multi-size .ico (16-256, one PNG per size), site/favicon.png + favicon.svg, iconTemplate
  16 / @2x 32. Compare designs with `npx electron scripts/render-icons.js --preview a.svg b.svg
  --out <dir>`. The PowerShell drawer (`sync-icons.ps1`, purple + mint) is gone.
- **`~/Applications/BoardClip.app` launcher** (`scripts/create-macos-launcher.sh`, rebuilt by
  `update.sh`): Finder shows a bundle icon ONLY from an `.icns` named by `CFBundleIconFile`;
  the script builds `Resources/icon.icns` from `icon@2x.png` with `sips` + `iconutil` and
  `lsregister -f`s the bundle so the cached blank icon is dropped (fixed 2026-09-03).

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
- **P2P discovery = `lib/p2p-discovery.js` (2026-09-03)**: ONE UDP socket joined to
  `239.255.43.21:45454` on EVERY real IPv4 interface (`addMembership(group, ifaceIp)` per
  adapter; re-enumerated every 30 s) and announcing once per interface via
  `setMulticastInterface`. A bare `addMembership(group)` lets Windows pick ONE adapter and on
  this PC it picked the Hyper-V Default Switch, so the Mac's Wi-Fi announcements were never
  heard and every copy took the 30-90 s cloud path. Announcements are ALSO unicast to every peer
  heard in the last 5 min (multicast is often one-directional). P2P HTTP prefers the fixed port
  45455 (ephemeral fallback on EADDRINUSE). Peers carry `transport` (`lan`|`tailnet`, CGNAT
  100.64/10 = Tailscale); `p2p.peer.seen`/`p2p.peer.lost` diagnostics answer "did the Mac ever
  show up". Unit: `test/p2p-discovery.test.js`; real two-instance loopback check:
  `node scripts/qa-sync-two-instances.js` (seeds A/B, asserts mutual discovery + convergence).
  Full overhaul plan (delta P2P + delta cloud journals + Tailscale + AES-GCM): `SYNC-P2P-PLAN.md`.
- **Sync v2 = ONE delta changes feed for P2P AND cloud (2026-09-03, `SYNC-P2P-PLAN.md`)**:
  `lib/sync-delta.js` `createChangeTracker` stamps every entry (item / tombstone / group
  tombstone / supersede / conflict record / small synced settings) with the LOCAL revision at
  which it last changed on this device, whatever its source; `deltaSince(cursor)` = CouchDB
  `_changes?since=seq`. Revisions are per-device monotonic (start = max(persisted+1, Date.now())),
  so cursors are "the sender's revision" and never compare clocks across devices. Persisted
  lazily to `sync-state.json` (local only: tracker entries + `p2pCursors` + `journalCursors`);
  an entry whose arrival was lost in the lazy window is re-sent once (over-send is idempotent,
  under-send would be a silent hole). `observeLocalChange()` runs in EVERY save path
  (history/settings/conflicts), including saves that apply remote state - what arrived from one
  peer must reach the others. Applying a delta = the existing `foldRemoteState` union merge
  (partial history can only add/update; deletes need tombstones), change detection is
  O(delta) via `historyChangedBy(before, after, touchedIds)` - NOT a full 8 MB stringify.
- **P2P v2**: `/delta?since=` (GET) + `/delta` (POST) carry envelopes sealed with AES-256-GCM
  (`lib/p2p-crypto.js`, key = HKDF(`p2p_secret`)); HMAC still signs the sealed bytes. v1
  `/state` stays for un-updated peers (announcement/manifest carry `protocolMax`). Push = delta
  since the peer's acked cursor (`p2pCursors[id].sent`), pull = `/delta?since=pulled`; after
  applying a peer's delta, `sent` is set to the new revision so it is never echoed back.
  Peers keep an ADDRESS BOOK (`peer.addrs`: LAN + tailnet); `p2pChooseAddress` prefers a
  fresh LAN address, then tailnet. Discovery beyond multicast: synced `p2p_endpoints`
  registry (each device publishes name/port/lan/tailnet ips, newest wins), `tailscale status
  --json` every 60 s (`lib/tailscale.js`), manual `p2p_pinned_peers`; all are unicast
  announcement targets AND `/manifest` probe targets every 30 s (+ on Refresh).
- **Cloud journals** (`lib/sync-journal.js`): each change appends ONE small NEW file
  `sync/<deviceId>/<revision16>.json` (tmp + rename to a fresh name, never rename-over: DriveFS
  forks) per provider; readers apply other devices' files newer than their per-device cursor
  (`journalCursors[folderId].read`), a `since` past the cursor = gap -> snapshot re-read. The
  monolith is now a SNAPSHOT rewritten every 5 min / 50 journal writes (content-compared) and
  own journal files it covers are pruned after 1 h. `fs.watch` on each provider's `sync/` tree
  (recursive, own device dir ignored) applies a peer's file within ~300 ms; the 30 s poll stays
  as the floor. Providers dedupe by a `.boardclip-folder-id` marker (G:/H: = one folder).
  Watchdogs are adaptive (base + 2 s/MB) and a late completion logs `sync.timeout.late`, not an
  error. Telemetry: `sync.latency {source, transport, peer, ms}` (originClock -> applied),
  `sync.delta_apply`, `sync.journal.write/read`, `p2p.peer.seen/lost`; tray tooltip shows
  peers + transport + last sync + last latency; Settings lists peers and the tailnet line.
  QA: `node scripts/qa-sync-two-instances.js all` (p2p + cloud-only scenarios, measured).
  **RULE: never touch a provider path with a synchronous fs call** (`existsSync`/`mkdirSync`/
  `readdirSync`) and never await one without a deadline - a wedged mount blocks the main thread
  for ever rather than erroring. Use `lib/fs-probe.js`; `syncPathHealth` in main.js decides which
  providers a pass may touch.
- **Editor forks were a state-apply RACE, not divergence (found 2026-09-03 right after P2P first
  paired)**: the v1 `p2pApplyState` folded remote state, then `await`ed the orphan-image scan,
  then replaced `history` with the PRE-await fold. An editor idle-save landing inside that await
  was discarded (its new id gone, the tombstoned old id back), so the next save found no base
  and took the `conflict_created` branch: "saved as a separate clip" toasts + a new copy every
  few seconds while typing (nine copies of one note). Fixed with the same `dataRevision` rebase
  guard `syncMerge` already had (`p2p.state_apply_rebased`); `applyRemoteEnvelope` (v2) has no
  await between fold and commit by construction. `editor.text_applied` now logs `base_found` /
  `base_text_matches` so a fork's cause is readable from the log. RULE: never `await` between a
  `foldRemoteState` and the `history` replacement without re-folding the live history.
- **Search facets (2026-09-03)**: `len:` accepts ranges (`len:50-200`), plus `lines:`/`ln:` and
  `words:`/`wd:` with the same comparators, and `is:url` / `is:multiline` / `is:rich`. ONE
  table describes every field: `FIELD_INFO` in clip-search.js (`desc`, `short` alias, per-value
  hints). The autocomplete hints, `PREFIX_HINTS` and the options panel's key
  chips' tooltips are all DERIVED from it, so a hint reads the same everywhere. Add a facet =
  parser + a `FIELD_INFO` entry (+ an `OPTION_FACETS` row if it deserves a one-click chip).
- **Options panel = Forge's model, NO syntax table (2026-10-08, owner: "u learn the format from
  the toggles... way less space")**: the toggles teach the grammar by WRITING their token into the
  field (Last 7 days -> `since:7d`); `OPTION_FIELDS` (derived: FIELD_INFO keys no facet row
  writes, minus is:/sort:/id:) are one key chip each, painted as the field paints a key
  (`queryTokenHtml` = lexQuery's `.qh-*` spans), a click appends `key:` and opens the
  autocomplete on its values;
  `SYNTAX_NOTES` is ONE line (-word, "a phrase", a OR b, (a b), /regex/). All in one label | chips grid (Date / Type / Size / More). `SYNTAX_HELP`, `SYNTAX_FOOT`, FIELD_INFO
  `group`/`example` are gone; ui-parity guards it. A bare known key (`title:`) lexes as a
  prefix (it used to paint as plain text until a value followed).
- **Popup header + search field + options panel (2026-10-07, UI overhaul B)**: the popup header
  and the settings header are NOT `-webkit-app-region: drag` (it ate clicks, double-click
  maximised): `Core.attachWindowDrag(el, {onClick, move})` captures a press on a non-control
  pixel; release within 4 px = click (focus the search), further = `window.api.windowDrag`
  (`window-drag` IPC, main `setBounds` of the SENDER from its bounds at the press, size kept,
  clamped to the desktop by `windowDragBounds`, three phases only; a drag mid-open-slide settles
  the slide first; a closed popup drops its drag start; the demo's move is its web window's, see
  "Demo windows"). A press whose
  release is lost ends at the next buttonless move / lostpointercapture. An EMPTY search field is
  header too (drag moves, click focuses it: nothing to select); with text, a drag selects text.
  The chip row (`.group-filters`, `Core.attachChipStrip`) is ONE line that scrolls sideways
  under the sideways fade (`attachSideScroll` = `attachScrollFade(el, preset, {axis:'x'})` + a
  plain wheel scrolls it) and shows every chip, wrapped, while the options panel is open (the
  chips glide through the ONE `Core.flipChildren`, the strip's height is its own WAAPI glide;
  instant under reduced motion or a hidden page). Its top-level group submenus
  are `popover="manual"` shown in the TOP LAYER by `installSubmenuAutoflip`
  (`placeTopLayerSubmenu`): a scrolling, masked strip would clip a nested absolute submenu, and a
  mask clips every descendant, fixed ones included. They follow their chip when the strip scrolls
  (closed once it leaves view) and close on window blur and `controller.closeMenu()` (popup reset;
  `Core.closeTopLayerSubmenus`): `popover="manual"` has no light dismiss. The strip fade is
  'panel' (36 px) so it always overlaps the last visible chip; a wheel is taken only when the strip
  actually moves (at an end the page scrolls). A toggle mid-glide reverses from the drawn rects.
  QA: `qa-ui-shots --only popup-chips-many`. macOS needs
  `acceptFirstMouse` on the popup (it never blur-hides, so it is often inactive; unverified on a Mac). The field is flat (no fill, `--line` hairline underline, accent on focus);
  `attachSearchBox` owns its chrome for app + demo: placeholder "Click here to search..." until
  focused, clear / sort / Regex + tune on the ONE `.bc-reveal` (grid 0fr -> 1fr width track, both
  Forge belts) and the options panel (grid-rows fold + `inert`, facet chips from
  `Search.OPTION_FACETS` writing tokens via `applyFacet`; a chip-bar filter (is:pinned/image/
  numpad) is never a panel option, key chips + one notes line,
  `Core.attachScrollFade` mask edges, `Core.attachResizeHandle` bottom edge). Panel height =
  `options_panel_height` (local-only, 0 = 40 % of the popup, max 70 %); Esc closes it first
  (`closeSearchOptions` adapter hook), `resetPopupState` shuts it. Reduced motion = `--dur: 0ms`
  (one switch in clipboard-popup.css). A focused button / chip answers a plain Enter / Space
  natively: the controller's list keys skip `isActivatableControl` targets (they used to paste
  the top clip). Panel rules: any programmatic query change closes the autocomplete (its replace
  ranges belong to the old text), opening the panel closes it, nothing in the panel takes the
  field's focus, a chip rebuild refocuses the focused chip's twin, and a close with the focus in
  the panel gives it back to the field. Spacing before a revealed control = `--reveal-gap`
  (margin inside the track), never the row's flex gap. QA: `node scripts/qa-popup-header.js`
  (56 checks: click vs drag, lost release, clamp, slide vs drag, panel resize/persist/Esc,
  keyboard activation, autocomplete vs panel, the reveal ramp, the demo, the icon font with
  Google Fonts blocked; CDP key presses need a `char` event for a button to activate).
- **Icon font is vendored (D3)**: `site/shared/vendor/fonts/material-symbols-rounded.woff2`
  (opsz 20 / wght 400 / GRAD 0 fixed, FILL 0..1), ONE `@font-face` (`font-display: block`) at the
  top of clipboard-popup.css, which every window and the site load. No page links Google Fonts.
- **macOS**: detects Google Drive and OneDrive from `~/Library/CloudStorage/`, plus iCloud Drive from `~/Library/Mobile Documents/com~apple~CloudDocs`.
- **Windows**: scans Google DriveFS mount letters and labels from PSDrive descriptions, DriveFS preference cache/WAL strings, and recent DriveFS logs; also detects OneDrive environment folders and common iCloud Drive folders.

### DATA-LOSS BUG (2026-07-06 incident) — sync merge vs content-hash edits — FIXED 2026-07-09 (`61f5cff`)

**Sync RE-ENABLED 2026-09-03** (both devices on eb530dc; first merge folded the Mac's 350 clips into
Windows' 9.8k with zero loss; 4 stale pre-edit Mac copies were pre-tombstoned so they could not
resurrect; the Mac had in fact kept syncing to Google Drive alone the whole time). History: sync
was PAUSED on Windows (`sync_disabled_paths` = all 3 providers, `p2p_enabled: false`) from the
incident until the fix. RE-ENABLE ONLY once BOTH devices run `61f5cff`+ (Windows + Mac) —
old code doesn't understand the supersedes ledger, so a stale device still on the old
build could re-trigger the race.

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
- **THE FIX (`61f5cff`)** — an **edit-lineage ledger** in synced settings. `applyTextEdit`
  now returns `supersedes: [{from: oldId, to: newId, updatedAt}]` alongside the old-id
  tombstone; `main.js addSupersede` persists it into `settings.supersedes` (normalized,
  30-day retention like tombstones; in `remoteSettingsPayload` so it rides cloud writes +
  P2P state + fork-heal; merged in `mergeSyncedSettings`). `mergeHistories` builds a
  `supersedeMap` (transitive old→…→new) and routes a stale old-id copy THROUGH the lineage:
  `mergeSupersededStaleIntoTarget` folds its pin/title metadata into the newer target but
  the stale TEXT can NEVER overwrite the target text (the exact regression). Ordering-safe
  (stale seen before its target is stashed in `pendingStaleByTarget`, folded when the
  target lands). If EVERY provider lost the target, the newest stale old-id copy is kept
  rather than converting an edit into data loss. Additive + fully backwards-compatible
  (absent/empty `supersedes` = pre-fix behaviour). Tests: `test/clipboard-model.test.js`
  (stale-provider race repro + `applyTextEdit` supersedes emission); `foldRemoteState`
  merges settings BEFORE history so the lineage is available to `mergeHistories`.
- **Forensics kit**: `clipboard-backups/` (content-addressed history snapshots, see
  Backup subsystem below; 7d/1GB/2000-manifest retention),
  `clipboard-edit-archive/` (raw editor buffers, 1yr/100MB — this is what recovered the
  lost paragraph), `boardclip-diagnostics.jsonl` (64MB cap = only ~1.7 days at current volume), `sync-forensics.jsonl` (16MB, months: every clip a merge removed from local history / revived / was blocked from dropping), plus cloud providers'
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
- **Retention** = `backupStore.pruneBackups(dir, {maxAgeMs:7d, maxBytes:1GB,
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
- **Single-instance lock** via `app.requestSingleInstanceLock()` — second launch shows popup instead of starting duplicate. **The rejected instance MUST `app.exit(0)`, never `app.quit()` (fixed 2026-09-20):** before `ready`, `app.quit()` does not stop the unconditional `whenReady()` startup, so every second launch (Start Menu double-click, Startup VBS racing a manual start, an `electron .` probe) booted a FULL duplicate - tray, hooks, clipboard polling, sync - on the live data dir and stayed up (`app.start pid 16452` ran 3+ min beside the primary). The lock is per Electron `userData`, so a dev-checkout `electron .` collides with the live app too - that is the test: it must print 'Another instance is already running' and exit before `whenReady`. Guarded in `test/popup-lifecycle.test.js`
- **Auto-launch**: `app.setLoginItemSettings({ openAtLogin: true })` — toggled in Settings UI
- **Windows dev auto-launch**: un-packaged Electron writes `BoardClip.vbs` into the Startup folder and the VBS runs `start.bat` hidden. Avoid pointing login startup directly at `electron.exe`; without a stable working directory it can launch bare Electron or fail to start the app module.

## UI Patterns

- **`icon-btn` base class** — all small clickable icons share 24x24 rounded style. Every one hovers `--text` + `--hover` (the `.accent` hover variant is gone: accent is selection / primary / focus / active, never hover); `.danger` hovers red on `--red-bg`; every close is `<span class="mi">close</span>` (`.close-btn` is a hook only; the clip windows have no page close, the OS controls replace it)
- **Null-guard `it.text`** — always use `(it.text||'')` in templates
- **Filter tags**: shared app/site UI. Left click includes a filter, right click excludes it, and the global clear X resets search plus include/exclude filters.
- **Confirm dialog** shared between numpad reassign, group delete, and clear all
- **Opening a clip in the editor/viewer from the popup (2026-09-02/03):** "open several" gestures
  pass `{ keepPopup: true }`: middle-click or RIGHT-click on the row's own open button (the owner's
  actual ask - right-click there opens, it never shows the row menu), middle-click / alt+click on
  the row body, and the detached right-click/"..." menu's Open in editor / Open image (detected via
  `.bc-menu-item`). A NORMAL click on the row's open button and Ctrl/Alt+Enter stay a hand-off
  (popup closes). middle-click is `controller.onMousedown` (prevents the
  default: the ONLY way to stop Chromium's autoscroll widget, measured) + `controller.onMouseup`
  (opens on an in-place release; a preventDefault'ed middle mousedown makes Chromium SKIP
  `auxclick`, measured 2026-09-03) - `onAuxclick` is only a fallback for consumers that don't
  route mousedown. Both consumers must wire mousedown + mouseup (ui-parity guard).
  The keepPopup gestures
  -> main's `presentSecondaryWindow` shows the window with `showInactive()` and does NOT
  `hidePopup()`, so several results can be opened one after another; the popup still
  blur-hides the moment the user clicks into one of the windows (that is what makes it NOT
  "sticky" - the July complaint was a popup that ignored blur, never revisit a blur-suppress
  flag). Keyboard opens (Ctrl/Alt+Enter) stay a hand-off: show + focus + hidePopup.
- **Settings auto-save** — max age/size save on input change, no Save button
- **`saveSettingsFile({ localOnly: true })`** for per-machine keys (popup/editor/viewer geometry, and a
  `save-settings` body made only of `LOCAL_ONLY_SETTING_KEYS`, e.g. `image_preview_height`): writes the
  file but skips the revision bump. A bump makes the popup re-clone ~10k items over IPC and rebuild, which
  every Ctrl+wheel zoom and window resize used to trigger.
- **Keep-your-place list (2026-10-07)**: both popups render rows through ONE `Core.createClipList`
  (windowed: ~60 rows around the kept place, grown both ways on scroll; `update({ids, tsAt, mode,
  queryKey})` per rebuild). The PURE `Core.resolveListAnchor` decides where a rebuild sits: anchor = the
  cursor row if on screen else the top visible row, restored to the same pixel offset; starting a search
  (typing into an EMPTY box, `started`) = top, any other edit (a chip, a word after a chip, Recent ->
  Best) keeps the clip while it matches; the Best/Recent override ends when the box empties (by any
  route); leaving a search (clear / text removed) keeps the clip even unscrolled;
  refine keeps it if it still matches, else nearest-in-time for time-ordered lists (`Search.rankMode`
  'none'/'new') or top for Best; unscrolled with no cursor stays at the top. A query change clears the
  multi-select at once (`controller.onQueryChange`) and keeps the cursor only if it was the on-screen
  anchor and stayed put (`reconcileVisible`) - Enter must never paste a hidden row. Rebuild repaints use
  `repaintSelection({scroll:false})`. "Newest"/"Top" pill (+ dot for clips that arrived above) lives in the
  shared shell (`.list-wrap`). Reopening the popup scrolls to the top. Measured (sandbox, 500 clips):
  clear-to-deep rebuild 12-17 ms, 60 DOM rows, anchor within 1 px. QA: `node scripts/qa-popup-sandbox.js`
  (hidden popup, never touches the clipboard; a hidden page fires no scroll/rAF, so it dispatches scroll
  events and calls `rerenderList()` itself).
- **Drag clips out (2026-10-07)**: popup rows are `draggable`; `controller.onDragstart` (both consumers
  wire `dragstart`) sends image rows to the host's `dragImages` (app: cancel the page drag +
  `start-drag` IPC -> `startImageDrag` -> `webContents.startDrag({files})`; demo: URL + `DownloadURL`)
  and text rows as `text/plain` (+ `text/html` for one rich clip). A 2+ selection drags every selected
  clip of the grabbed row's kind; presses on row controls never drag. The OS always gets TEMP COPIES in
  `%TEMP%/BoardClip-drag/<per-drag>/` named by `lib/drag-files.js` (title, else "BoardClip image <local
  time>"): a same-drive drop into a folder is a MOVE and must never take the original out of
  clipboard-images; folders older than a day are pruned. Viewer (`createImageViewer` `onDragOut`): at fit
  size a drag pulls out, zoomed in it pans, Alt+drag pulls out, the title-bar handle always pulls out.
  NEVER fire a real `startDrag` from automation: with no button held, Windows "drops" onto whatever
  window is under the user's cursor. `app.on('web-contents-created')` blocks `will-navigate` in every
  window: a file dropped on the popup/editor/viewer used to navigate it to that file.
- **Image preview zoom**: `Core.createImageZoom` owns `image_preview_height` (40-600, default 60,
  per machine, excluded in `remoteSettingsPayload`) as `--clip-img-h` on the popup root, capped by
  `--clip-img-cap` (the list's height). Ctrl+wheel (document listener, `{passive:false}`, via
  `controller.onWheel`) always preventDefaults so the PAGE never zooms. Ctrl/Cmd+=/-/0 in the APP are
  claimed in main (`before-input-event` on the popup, shared `Core.imageZoomKey`, sent as `image-zoom-key`
  -> `imageZoom.applyKey`) because macOS menu key equivalents beat the page; the demo uses the
  `controller.onKeydown` path. No async image decoding: rebuilt rows painted blank for a frame. Preview markup carries `width`/`height` + `--ar`/`--nw`; CSS width =
  min(row, height x ratio, real width). Stored dims match the real PNGs (checked on 1529 live images).
- **Dev auto-reload** — `fs.watch` on index.html / clipboard-ui-core.js / the popup + token sheets
  triggers `reloadIgnoringCache()` (debounced 300ms) ONLY when the file's size or mtime moved (fixed
  2026-10-07, `26947e2`): with Windows last-access updates on (default "system managed"), a READ fires
  the watcher, so opening an editor (which loads the same files) or an indexer/AV scan reloaded the
  popup from scratch, list and icon font included. Never react to a bare watch event.
- **Build info git is lock-free** (`lib/build-info.js`, `--no-optional-locks`, `b66ddcd`): its 1 s
  timeout killed a slow `git status` while it held `.git/index.lock`, leaving a stale lock that blocked
  every commit (and would block an install's updater pull). A 0-byte `index.lock` with no git running
  = stale; remove it.

## AI Access (local MCP server)

- **Shape:** `mcp/boardclip-mcp.js` is a stdio MCP server (`@modelcontextprotocol/sdk` v1.x) spawned by AI clients. It reads shared clips straight from the JSON files (works app-closed); anything beyond the allowlist / any mutation / clipboard-write forwards to the running app over a **named pipe / Unix socket** control channel (`lib/control-server.js` in main.js, `lib/control-client.js` in the helper). NOT HTTP, no port. The helper never writes data files -> no races.
- **Allowlist by curation (fully opt-in):** a clip is AI-visible iff it's in a group listed in `settings.groups_shared_with_ai` (the auto-created **"AI"** group is always shared). Non-shared = metadata only. `lib/mcp-core.js` is the PURE boundary (whitelist + shaping), reused by both helper and app. There is deliberately NO "looks like a secret" auto-withholding — group sharing is the single opt-in gate, so a clip the user put in a shared group is shared as-is. (A `secret-guard` heuristic layer existed and was removed as redundant/annoying; don't reintroduce it.)
- **Gating:** `mcpNeedsApproval` -> delete/edit/clipboard-write/paste + beyond-allowlist reads ALWAYS prompt; pin/group/numpad/add are free on *shared* clips. Approval modal = a native frameless BrowserWindow (`mcp-approval.html`, NOT a browser) with once/session/always-per-tool + deny-by-default countdown; `ai_always_allow` persists grants. Modal auto-sizes via the `approval-resize` IPC.
  **The modal must explain the ACTION, not show the clip (2026-09-03, owner: "I never understand
  what is actually happening")**: `buildApprovalRequest` returns `title` (verb + object, e.g. "Add
  clip to group X" / "Remove clip from group X" - assign_group is a TOGGLE, so membership is
  checked), `explain` (one plain sentence: what changes and what does not, e.g. "tagged ..., its
  text is not changed and nothing is deleted" / "removed from your history on every device, text
  stays in the local backups"), `why` (why it is asking: always-gated vs not-in-a-shared-group),
  `facts` ([Clip size, Captured, Groups, Numpad]) and a LABELLED `preview` ("Clip text" / "New
  text" / "Text to append" / "Query"). The modal also states that Always/Session apply to that
  kind of action only. Sandbox proof: `node scripts/qa-approval-shot.js` (isolated instance
  with `ai_access_enabled`, `BOARDCLIP_MCP_DISCOVERY` + `BOARDCLIP_MCP_PIPE_TAG` overrides and a
  fake HOME/APPDATA so the registrar never touches real client configs; screenshot each modal
  over CDP). `BOARDCLIP_MCP_PIPE_TAG` is the test seam that lets a sandbox run its own control
  channel beside the live app instead of colliding on the per-user pipe.
  **Hover pauses the countdown (2026-09-03, owner: "pause the timer while mouse over")**: the
  modal stops ticking on `mouseenter` of `<html>` (label "Paused while your mouse is over this",
  resumes from the same second on `mouseleave`; a resting cursor is caught via `:hover` after
  render) and reports `approval-hold(id, held, remainingSec)`; main's timer was only ever the
  safety net 3 s behind the renderer, so `requestApproval` clears it while held (bounded by
  `APPROVAL_MAX_HOLD_MS` = 15 min, then `timeout`) and re-arms it with the reported seconds on
  resume. Two control-channel rules make the pause SAFE end to end: (1) `ControlServer` passes
  `{ signal }` to `handleRequest`, aborted when the caller's socket closes, and `requestApproval`
  then finishes with `client_gone` (modal closes, nothing executes for a caller that gave up -
  before this an allow clicked after the helper's 60 s timeout still ran the action); (2) a
  client that sends `keepalive` in its envelope gets `{id, pending:true}` every 10 s while the
  request runs and `control-client` treats `timeoutMs` as MAX SILENCE, so the helper waits as
  long as the user reads. Legacy helpers (no flag, still-running MCP children spawned before the
  update) get exactly one line as before. Tests: `test/control-channel.test.js` (keepalive,
  legacy first-line, abort-on-disconnect); sandbox proof `node scripts/qa-approval-hold.js` (5 s
  timeout held past 8 s, resume, client_gone).
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
- **Demo windows (2026-10-09, owner: "why cant we drag windows in the browser... even resize...
  allow maximise close etc, mimic animations/buttons of local user OS")**: the demo popup and ONE
  clip window (editor, image viewer, Unify; it replaced the in-popup overlay AND the image
  lightbox) are windows on the page through the shared `Core.attachWebWindow` (the generic
  layer; the app's windows are real OS windows): moved by their handles (`handle(el)` =
  `attachWindowDrag` whose `move` now also gets `{cx, cy, x, y}` in CSS px), resized from 8
  edge / corner grips (`.bc-ww-rs`), raised + `data-active` on a press, maximised to the
  viewport (FLIP), minimised into the dock, opened / closed, all with the visitor's OS motion
  (mac softer, Windows snappier; none under reduced motion). `renderWindowBar({webControls})`
  (non-native = the demo) draws the OS controls: macOS traffic lights first (grey while
  inactive), Windows caption buttons last (close red); close carries `data-x="close"` so the
  view's own close runs. The popup has no maximise (the app's has none); its close goes to the
  dock under the demo, whose BoardClip icon reopens it (the tray icon). Menus open in the window
  they came from (adapter `menuHostAt(x, y)` -> `createMenu` picks its host per open); the
  clip window gets `controller.onClick` + `installSubmenuAutoflip` itself; both roots wear the
  theme / appearance (`demoRoots`). The guide tour dims the page (`.demo-dim` = `--scrim`, 10 s
  ease back) and comes back after 12 s, 24 s, 48 s... until the visitor has made 3 presses /
  keys in the demo (`PLAYED_ENOUGH`), never while they are busy (8 s idle). QA:
  `qa-ui-shots --only site-windows` (real CDP mouse drags: header move, corner resize, cascade,
  max / restore, dock min / restore, close, reopen).
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

## Search engine + image viewer (2026-07)

- **ONE shared search engine** = `site/shared/clip-search.js` (isomorphic UMD, same
  header as clipboard-ui-core.js). Pure, no DOM. THE authority for query syntax +
  filtering + ranking, consumed by the app popup, the demo, AND `lib/mcp-core.js`
  (`search_clips`). Loaded as a `<script>` BEFORE clipboard-ui-core.js in EVERY html
  window (index.html, site/index.html, editor.html, viewer.html) → `window.BoardClipSearch`;
  Node/tests `require` it. clipboard-ui-core re-exports it as `Core.search`. Tests:
  `test/clip-search.test.js`.
- **The search bar TEXT is the single source of truth.** Facets (`group:`/`is:`/`num:`/
  `since:`…) live as tokens INSIDE the query string; the chip bar's active/excluded state
  is DERIVED via `facetState(parseQuery(q))`. There is NO separate `activeFilters`/
  `excludedFilters` Set anymore (that dual-model was the drift Forge killed; its last helpers,
  `filterStateFrom`/`applyFilterIntent`/`matchesFilter`/`clearFilterState`, went 2026-10-08:
  `filterItemIndexes` and `hasActiveFilters` read only `state.query`). A chip click
  rewrites query tokens through `Core.search.applyFacet(query, token, intent)`; deleting a
  group strips its `group:`/`-group:` tokens. `ui-parity.test.js` #11 guards that neither
  consumer reintroduces filter Sets.
- **Grammar** (colon-uniform, quote-aware, `-` negates): free text (ALWAYS literal) · `/re/`
  (one regex term, also `title:/re/` `text:/re/`) · `a OR b` (binds TIGHTER than side by side,
  Gmail's rule: `x a OR b` = x AND (a OR b)) · `( )` at any depth, `-( )` · `title:` · `text:`/
  `body:` · `group:` · `is:pinned|image|text|numpad` · `num:1-9` · `since:`/`before:`
  (`7d`/`24h`/`30d`) · `len:>N` · `id:` · `sort:new|best`. `item.ts` is Unix SECONDS.
  Unknown `word:val` → stripped to `val` as free text + recorded in `parsed.unknown` for a
  hint. URL/Windows-path values (`http://`, `C:\`) are left verbatim. A quoted token is literal
  (`"-foo"`, `"title:x"`, `"OR"`); `/usr/bin` and an unclosed `/abc` are text.
- **One query language, a Regex TYPING toggle, the chip-row cluster (2026-10-08, `SEARCH-MODES-PLAN.md`)**:
  ONE scanner (`scanQuery`) feeds parse, lex, validate and the chip edits. `parseQuery` builds an
  AND/OR/NOT tree: top-level leaves fill the flat fields as before (now `num:1 num:2` = AND, flagged
  with an "OR" fix; a negated single-valued filter is IGNORED and flagged with its inverse), a
  same-dimension OR of filter values is `anyOf` (dims = group, kinds of clip
  (image/text/url/multiline/rich), num; pinned and numpad are their own), anything else is
  `compound` (evaluated as a tree; a chip whose value sits inside one is greyed "part of a custom
  filter"). `terms` = every positive content term, the ones inside an OR too (highlight +
  relevance). ONE compile primitive `compileTerm(value, {regex, caseSensitive})` serves search, the
  row highlight (`termSpans`: every word marked; the old whole-query highlight marked nothing for
  two words) and the editor find (`findAllMatches`); `prepareQuery`/`matchesQuery` are gone.
  **The field's text IS the query, always; there are NO search modes** (a Basic / Regex / Advanced
  picker with filter pills shipped in fadbba7 and was folded back the same day, owner: "the inline
  or thing feels like duplication... basic basically just becomes regex off"). The Regex toggle
  (`#regexBtn`, Alt+R / Cmd+Option+R) only TYPES for you: with it on, typing at a fresh spot (start,
  after a space / `(` / lone `-` / `title:` / `text:`, or right after a regex) wraps the text in
  `/.../` with the caret inside; a `/` inside is escaped, at the closing slash it steps over; an
  emptied `//` goes with one Backspace; a paste is one term; a filter value or a quote is typed as
  usual (`Search.regexTypingEdit` / `regexBackspaceEdit`, wired in `attachSearchBox`'s
  `beforeinput`). Flipping the toggle wraps / unwraps the word at the caret (`toggleRegexAt`).
  `attachSearchBox` owns the query (`getQuery`/`setQuery`, onChange); one toggle component
  `Core.attachToggle` = the search box's Regex and the find bar's Regex + case (Alt+C); every
  toggle chord goes through ONE document listener and the innermost scope holding the focus takes it
  (the demo's editor overlay sits inside its popup; the search box's scope is its `.main-view`).
  Regex typing (key by key, QA'd): a fresh `-` `(` `)` `"` types natively, `:` after a recognised
  key unwraps `/group/` to `group:`, typing over a selection and IME/dead-key compositions go
  through the same edit, and every edit is undoable (`insertText`, one Ctrl/Cmd+Z per wrap).
  **Chip row = [builtins] | [or/and][selected][excluded] | [usable by use][greyed]**
  (`renderFilterBar`): the cluster holds EXACTLY the values in the query (a sub-group is its own
  chip there under its full name, work/api; its parent stays with the rest), between `.cluster-sep`
  hairlines (keyed, so they fade too), led by a `.conn-toggle` once two or more of the dimension are
  joined, or ONE under a remembered "and" (`Search.dimConnective(parsed, dim, joins)`: the visible
  way back to "or"; a click =
  `setDimConnective`, written `group:A OR group:B` vs side by side); the options panel's Type row
  leads with the same `connToggleHtml`. Chips glide on every repaint (`Core.flipChildren`, FLIP via
  `element.animate`, keyed by data-group / data-filter / data-dim; a new one fades in, one that left
  fades out where it was as an inert, unkeyed `.flip-ghost` (owner: "so it doesn't feel like it
  crashed"); instant under reduced motion). Every chip goes through the SEARCH BOX
  (`searchBox.applyFacet(token, intent)` / `setConnective`, which own the remembered join; the
  controller's `filterIntent` reads the chip's own data-filter / data-group; adapters pass
  `applyFacet`/`setConnective` through, no per-consumer chip code). A second chip
  of a kind joins the first the way the user LAST flipped that kind's or/and (`facet_joins`
  {group, type}, per device; numpad keys never "and": a clip has one key); an existing OR / AND
  keeps the join it is written with. The census is keyed on it (`createCensusCache({ joins })`,
  `openDims`): under a remembered "and" a lone value is a plain filter, so a chip "and" would
  empty is greyed, never a click that returns nothing (seed QA groups that OVERLAP). Kinds of clip
  picked under the default "or" never block each other structurally (`structuralReason` reads the
  census's `open` dims: is:text then the Images chip = "text or image"). One choice
  per group FAMILY (`group:Work` already holds `Work/Clients`): a picked group replaces its
  selected parents and sub-groups (last click wins: a parent widens, a sub-group drills down,
  the join kept), excluding a parent drops its selected sub-groups, an excluded sub-group under
  an included parent stays ("Work except Clients"). A click on a value in an OR takes it out;
  right-click excludes. Key / "Since..."
  chips write their prefix into the field (the autocomplete offers values; `FIELD_EXAMPLE` is the
  tooltip example). Settings: `regex_search`, `facet_joins`, `find_regex`, `find_case` are
  LOCAL-ONLY (never synced); the hour-old `search_mode: 'regex'` migrates to `regex_search: true`
  and the old `find_mode: 'regex'` to `find_regex: true`, both keys stripped (the demo's
  `boardclip-demo-search-mode` key and `{mode}` find prefs likewise). The find bar's saved Regex
  changes only by its toggle; a popup hand-off (`editorFindFor` -> `findRegex`) sets it for that
  search only.
  The editor hand-off is `Core.editorFindFor(query)` (its words and patterns, never its filters;
  several terms = one regex alternation). MCP `search_clips` takes the whole language; legacy
  `regex: true` = `legacyRegexQuery` (the free words as ONE /regex/). QA: `qa-popup-header`
  (regex typing, Alt+R wrap/unwrap, the cluster + or/and + exclude + glide + fade-out ghost, the
  remembered join, the group family, the Type row),
  `qa-ui-shots` `popup-chips-cluster` / `popup-search-regex-typing` / `popup-search-or-groups` /
  `editor-find-regex`.
- **Group usage = ONE decayed score (2026-10-08, owner)**: `Search.groupWeights(list)` = each
  group's clips weighted by `decayWeight(age, 14 d)` (ts moves on every use; parents count their
  sub-groups; kept per list + hour). It orders the chip row (`buildTagTree(groups, {weights,
  tier})`: usable chips first, then greyed, then structural, each by use), the group pickers and
  the group autocomplete, and nudges Best match (`GROUP_USE_WEIGHT` 8 for a clip of the most-used
  group). The ranking's recency term uses the same `decayWeight` (3-day scale). No per-clip use
  counter exists (a new primitive was not worth it): ts is the usage signal.
- **Per-keystroke search speed (fixed 2026-10-07, measured on the owner's 13.9k clips / 70.8 MB, one
  31 MB clip): 430-840 ms -> ~25 ms per keystroke** (search 5-18 ms, list rebuild ~13 ms). Three costs
  were the old 400 ms: (1) `filterItemIndexes` was called without `docs`, so every keystroke rebuilt
  `clipToDoc` for every clip, which split every body for lines/words (~250 ms); (2) the term matcher
  lowercased the ALREADY-lowercase `searchTextLower` haystack again (70 MB per keystroke); (3)
  `relevanceScore` lowercased each matched body. Rules: the popup builds `searchDocs` +
  `searchTextLower` once per history revision in `rebuildItemIndexes`; matchers are compiled once per
  query (`compileContent`); body positions come from the lowercase haystack (`bodyIndexOf`); doc
  `lines`/`words`/`url` are lazy (`docLines`/`docWords`/`docUrl`). Measure with
  `QA_PERF=1 node scripts/qa-popup-sandbox.js` (synthetic owner-scale history, prints p50/p90 per
  keystroke). The renderer logs `renderer.list.rerender` with `ms` when diagnostics are on - compare
  those before guessing.
- **Loads never block typing (2026-10-07, "it still hangs")**: the real hang was `history.refresh` at
  ~1 s (re-cloning all 70 MB over IPC + re-lowercasing it) on EVERY capture / sync merge / settings
  save, all on the popup's only thread. Now: `get-history-state` answers through `lib/history-feed.js`
  (per-renderer snapshot of id -> stamp; a request carrying the revision it was last sent gets only the
  changed clips + the id order, anything else a full snapshot) and `Core.applyHistoryDelta` keeps
  unchanged clip OBJECTS, so `searchIndexFor` (WeakMap item -> {hay, doc}) re-indexes only new/changed
  clips. Previews take the match position from the haystack (`collapsedPreviewText` `matchIndex`;
  never flatten/lowercase a whole body: a visible 31 MB clip cost ~300 ms/keystroke). The filter bar
  re-renders only when facets/groups/counts change, focus refreshes are not forced, and
  `scheduleRerenderList` runs the rebuild AFTER the next paint so a typed character always shows
  first. Measure blocking with a `longtask` PerformanceObserver, not wall time (main saving the file
  runs off the popup thread): a background change now blocks the popup 0 ms (was ~1 s).
- **Short + long alias for EVERY prefix** — ONE `PREFIX_ALIASES` map in clip-search.js
  feeds parse + `lexQuery` (highlight) + `suggestQuery` (autocomplete): `t`=title, `b`=text/
  body, `g`=group, `n`=num, `s`=since (also `after`), `bf`=before, `l`=len, `o`=sort, plus
  `is`/`id`. Add a new alias in that map ONLY. Autocomplete offers the long form and hints
  the short (`title: · or t:`); both forms color as prefixes.
- **Ranking**: `filterRankIndexes` returns ORIGINAL indexes. Relevance (`relevanceScore`:
  title/body/phrase hits + `fuzzyMatch` abbreviation + recency blend) when a content query
  is present; pure history/caller order when idle. A **Best⇄Recent** `sortBtn` (in the
  shared shell, shown only while searching) forces `sort:best`/`sort:new`. `sort:` token or
  the toggle wins over the default.
- **Live highlight + autocomplete** = `Core.attachSearchBox(input, opts)` — ONE enhancer
  shared by app + demo. Transparent input over a colored backdrop mirror (`lexQuery` →
  `.qh-*` spans); autocomplete dropdown (`suggestQuery`) for prefixes/group names/`is:`/
  `sort:`/`since:` presets/`num:`.
- **Search behaviour from Forge (2026-10-08, all pure in clip-search.js, unit-tested)**:
  `facetCensus` (one pass, `facetFailures` + FAILURE_CAP 2; single-valued facets hold their
  dim open, AND facets only their own token; free text never part of it) ->
  `facetOptionVerdict` (selected never greyed; absent `is:` kind hidden; `structural` .25
  before `transient` .4; a group with no clips greys ONLY while other filters are active,
  else its click lands on the "No clips in X yet" state); chips carry
  `aria-disabled` and the controller ignores them (click AND contextmenu). ONE census per
  `Core.createCensusCache` (key = `facetKey` + groups + minute + docs identity); with
  `onUpdate` a history/minute change recomputes AFTER the paint (a background change blocks
  0 ms). `validateQuery` is the ONE invalid rule (`lexQuery` paints its `problemRanges`;
  a valid prefix is never flagged; a regex, a dangling OR or an unclosed group at the caret is
  `pending` until 700 ms idle).
  Autocomplete = Forge rules (caret at a token END, complete value = nothing, ghost via
  `ghostCompletion`, unique value auto-fill with the suffix selected, Esc parks until the
  text changes). `applyFacet` EDITS the text (removes its tokens, inserts at the canonical
  FACET_ORDER place) - never re-serializes what the user typed. `bestRelaxation` = the
  empty-state nudge (pass a `cache`: typing more words refines like `filterRankIndexes`).
  Multi-word paste auto-quoted (`quotePastedText`; Ctrl/Cmd+Shift+V raw) ONLY for single-
  spaced one-line text: a phrase is a substring test, so a quoted multi-line paste could not
  find its own clip. `KEY_TOKEN_RE` is the ONE "what is a filter key" rule (parser, lexer,
  suggest, validate; `Content-Type:` is text). Group names match EXACTLY (`group:work` with
  the group Work is flagged with a did-you-mean). Unknown-key did-you-mean = `KEY_GUESSES`
  (type: -> is:) or a near FULL filter name, offered only if the value is valid there.
  Dates are ISO-like only (`DATE_RE`): V8 `Date.parse` reads '>5' or '7' as 2001.
- **Keystroke rebuild cost (measured 2026-10-08, owner scale)**: the list renders ~2
  screenfuls sized from the measured row height (`rowsFor`), rows are parsed in ONE
  template pass, row markup has no inter-tag whitespace, closed `.bc-reveal-inner` is
  `content-visibility: hidden` (allow-discrete transition), and typing more of a term
  refines the last result (`filterRankIndexes` `cache`). Profile with CDP `Profiler` +
  `Tracing` (Layout/UpdateLayoutTree/ParseHTML) before guessing.
- **In-app "AI search" mode REMOVED (2026-09-02)** - the sparkle/Tab toggle, offline IDF
  "smart ranking" (`rankFuzzyIndexes`/`buildIdf`), the BYO-endpoint agent (`lib/ai-search-agent.js`),
  the `ai-search` IPC and the `ai_search_*` settings are all gone (owner: "remove the shitty AI
  search for now, will impl better later"). Clean excision: keyword/structured search is the ONLY
  mode, `attachSearchBox` no longer takes `getAiMode`, `loadSettings` strips the dead `ai_search_*`
  keys (one held a plaintext API key). `ui-parity.test.js` #11 fails if any piece creeps back.
  Rebuild from git history (`git log -S rankFuzzyIndexes`) when a better version is designed -
  don't resurrect this one.
- **Regression from that removal (shipped 36c82a9 06:18, fixed same day):** `clearSearchAndFilters` still called the
  deleted `resetAiRun()`, so every clear-X / filter-bar-clear threw a ReferenceError AFTER emptying the input
  and `query` but BEFORE `searchBox.refresh()`/`rerenderList()` - the highlight mirror kept showing the old
  query while results showed everything ("search stuck with an old search"). Lessons baked in: (a) when
  excising a block, grep for EVERY identifier it defined (the guard regex now lists them all), (b) the
  sandbox check must exercise the clear paths (clear X, filter-bar clear chip, chip click/right-click),
  (c) renderer exceptions now reach the diagnostics file as `renderer.error` via the shared
  `Core.installRendererErrorReporting` + `record-diagnostics` (forceFile for errors) - a thrown popup
  handler is never silent again.
- **In-app image viewer** = `Core.createImageViewer` (the image twin of `createEditor`;
  SAME `.bc-bar` + foot so the two windows read as one family). Fit-to-window
  default, click toggles fit⇄100% at the point, wheel zooms around the cursor, drag pans
  when zoomed (`ResizeObserver` re-fits); the footer has zoom out / % / zoom in / Fit /
  100%, and Ctrl/Cmd+= / - / 0 are claimed in main (`claimImageZoomKeys`, shared with the
  popup) and zoom the image. The bar's leading image glyph is the drag-out handle (a
  title-bar proxy icon). `viewer.html` + `viewer-preload.js` mount it;
  main's `openImageViewer` (one window per clip, `viewer_bounds` persisted via the shared
  `windowBoundsFromSettings`/`scheduleWindowBoundsSave`). `viewer_bounds` is explicitly
  defaulted and excluded from `remoteSettingsPayload` like every other machine-local window
  geometry. `open-image` IPC opens it; `open-image-external` keeps the OS-default-app path.
- **Clip windows (editor, viewer, unify, conflict) = ONE `.bc-bar` (`Core.renderWindowBar`)
  + the OS's own window controls (2026-10-08)**: main spreads `windowControlOptions()` into
  all four (`titleBarStyle:'hidden'` + `titleBarOverlay` on Windows/Linux, traffic lights
  at `trafficLightPosition` on macOS). NEVER `frame:false` there: it hides the traffic
  lights and the Window Controls Overlay. The page (`Core.attachWindowControls`) reserves
  the room (`env(titlebar-area-*)` on Windows, `--wc-left` 76px on macOS) and reports
  `{height: bar.clientHeight, color, symbolColor}` (resolved by painting, `#00rrggbb` =
  clear under glass) on every theme/accent/surface change via `window-chrome` ->
  `setTitleBarOverlay` / `setWindowButtonPosition`. clientHeight, not the full 32px: the
  bar's bottom hairline must run on under the caption buttons. No close button in the
  app's bars (`nativeControls: true`); the demo's clip window draws the visitor's OS controls
  (`webControls`, see "Demo windows"). Two tones per window (see
  "Two tones" below: bars a `--surface` band, content on `--canvas`). Bounds save the
  NORMAL bounds + `maximized` (`trackWindowBounds`); a maximised window comes back
  maximised only on a hand-off open, because `maximize()` shows AND activates (the QA
  sandbox turns it into a work-area `setBounds`). Unify/conflict keep their own
  `merge_bounds` (780 px default: two or three panes with heads). No PAGE zoom in the text
  clip windows: main's `claimZoomKeys` swallows Ctrl/Cmd+= / - / 0 before the default
  menu's zoom roles (a zoomed page slid its bar out from under the DIP-sized caption
  buttons; Electron turns Ctrl+wheel into a `zoom-changed` event, not a zoom); the popup
  and viewer zoom their IMAGES via `claimImageZoomKeys`. CDP screenshots never show the native
  caption buttons: capture the whole window with `PrintWindow(hwnd, dc, 2)` via koffi in a
  sandbox main eval (works on a cloaked window). macOS paths are reviewed, not run here.
- **A clip window's bar shows the clip exactly as its list row does (2026-10-08, owner: "pinning
  of text editors inconsistent with the main view")**: the row's `.star` before the title and
  the row's meta keys after it (ONE `renderClipKeys`: `#N` badge, group names, ghosts # and +
  on the reveal, open while the bar is hovered / focused); `updateTagStrip` (setTags) paints
  both and puts the clip's id on each. In a window a group name opens the picker (no list to
  filter; the picker's check removes it). The strip scrolls sideways under the same fade as the
  chip row. `openGroupPickerAt` reuses `clipGroupTreeHtml` and the controller's mutations -
  never duplicate a picker or mutation path. New notes supply `ensureClipId`: pin, # and + all
  commit first, re-query the id, then act; measure the anchor rect *before* awaiting (the commit
  refresh replaces the button). The old chip strip with an x (`renderClipTagChips`, `.gtag-x`,
  `untag`) is gone. The editor's and merge view's TITLE field is header while idle (the popup
  search field's rule, `attachWindowDrag(titleInput, { field: 'idle', move: o.windowDrag })`): a drag
  moves the window (`window-drag` IPC, a maximised window stays put), a click starts a rename with
  the caret where it was clicked (`caretIndexAtX`); while it is being edited a drag selects text.
- **The popup opens at the REAL cursor** (`getCursorScreenPoint`): a QA check that compares two
  opens must pin it in the sandbox main (`qa-popup-header` stubs `screen.getCursorScreenPoint`
  for its slide/drag runs), or the owner moving the mouse fails it.
- **Hermetic Electron QA**: `BOARDCLIP_DATA_DIR` relocates data and may be a legitimate user
  configuration. Set **`BOARDCLIP_ISOLATED=1`** as well for throwaway instances; only that
  explicit flag suppresses cloud account discovery/sync probing. JSON loaders accept an initial
  UTF-8 BOM because Windows PowerShell tools can produce BOM-prefixed valid JSON.
- **Context-menu parity** across popup rows / editor / viewer: `renderClipMenu` grew a
  `context` option (`'popup'` default | `'editor'` | `'viewer'`). Editor drops "Open in
  editor" (it IS the editor); viewer swaps "Open image" for "Open externally"
  (`open-img-ext`). The standalone windows drive the SAME `createClipController` via a light
  `clip-window-state` IPC snapshot (items for numpad previews, groups, pin state — NO full
  bodies to a second renderer); `controller.openClipMenu(id,x,y)` is the entry for hosts
  with no clip rows. Right-click + the "…" button both open it; **delete closes the window**.
  Editor title renames ride the session commit (`editor.setTitle`+`commit`, not a separate
  clip write); editor delete sets `session.suppressCommit` so the close-commit can't
  resurrect the clip from the draft. `ui-parity.test.js` #12 guards the viewer/menu contexts.
  The editor menu holds "Revert to original" (`editor.revert()` commits at once and, given
  `toastEl`, offers Undo: assigning the textarea drops its native undo). The demo editor overlay
  gets the SAME menu: `controller.openClipMenu(id, x, y, 'editor')` (the 4th arg overrides the
  adapter's menuContext) + `revertClip` / `setClipTitle` routed through the open editor.
- **QA harness = `scripts/lib/qa-sandbox.js` (2026-10-07), never a hand-rolled launch**: one
  isolated instance per run (own `BOARDCLIP_DATA_DIR` + `--user-data-dir`,
  `BOARDCLIP_ISOLATED=1` = no cloud probing / keyboard hook / shortcuts / tray / updater, its own
  `BOARDCLIP_MCP_PIPE_TAG`, CDP + inspector on port 0, so several runs can go in parallel),
  windows CLOAKED (never shown or focused), a `-r` main preload + page stub so no page or window
  reaches the OS clipboard, kill limited to its own sandbox dir. Used by `qa-popup-sandbox`
  (`QA_PERF=1` = owner-scale keystroke p50/p90, 13.9k clips; noise between runs is ~+-5 ms, run
  it alone, not beside other sandboxes), `qa-popup-header`, `qa-app-pentest`, `qa-appearance`,
  `qa-approval-shot`, `qa-approval-hold` and `qa-ui-shots.js` (every surface, light + dark:
  `--only a,b` `--theme` `--out`; JSON summary on stdout). The hidden popup's
  `requestAnimationFrame` never fires, so a driver calls `rerenderList()` after input.

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
  `toggle-group`/`np-btn` handlers resolve their target via `closest('[data-id]')` (works
  in a row's #/+ popover AND the detached menu). `createMenu(host)` = the shared click
  popover; app host = `document.body` (tokens on `:root`), demo host = `demoWindowEl`
  (tokens on `.bc-popup`).
- **ONE menu row primitive (phase 4)**: every menu, submenu, group tree and picker row is
  `menuRowHtml` (`.bc-menu-item`: icon column, label, hint / caret, `--ctl-md`, no gaps);
  `submenuNodeHtml` = a row + its `.tag-submenu`; `renderGroupChecklist` = the group tree
  (membership = accent check glyph in the icon column, dash + `aria-checked="mixed"` for
  "some of the selection", labels stay `--text`; dispatch `toggle-group` / `bulk-group`,
  "New group..." = an add row, `add-group` / `bulk-add-group`); `renderKeypadMenu` = the
  Numpad submenu AND the row # popover. The chip bar's group dropdown rows are the same
  row (`.group-filter-row`, in the controller's FILTER_TARGET). `.gp-btn` is GONE (ui-parity
  #16 fails if it returns). Bulk Group is tri-state via `groupMembership` (all -> remove).
- **Menu keyboard (`createMenu`)**: Up/Down/Home/End skip disabled rows, Right/Enter open a
  submenu, Left/Esc close one level, Enter/Space activate, 1-9 press the visible keypad,
  arrows move in 2-D on the keypad, Tab closes; focus returns to the opener. A menu opened
  from the keyboard focuses its first row, a mouse open moves nothing until the first arrow:
  decided by `trackInputModality` (the LAST real input was a key), because focus state cannot
  tell (a focused field or a script-focused element looks keyboard-focused either way).
  Shift+F10 / the menu key opens the cursor row's menu.
- **Dialogs**: Cancel then confirm; a DESTRUCTIVE confirm opens on Cancel and a bare Enter
  never confirms it (Esc cancels, Enter confirms only non-destructive dialogs).
- **Approval prompt**: shown INACTIVE (`presentSecondaryWindow(modal, {keepPopup:true})`,
  `acceptFirstMouse` for macOS), Enter AND Esc deny even with Allow focused, Ctrl/Cmd+Enter
  allows once, and the allow buttons arm only 0.8 s after it appears (a click already on its
  way cannot allow). `mcp-approval.html` must bind `const Core = window.BoardClipCore`: an
  error in one ipcRenderer listener stops the listeners after it from running.
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
  middle (Material `arrow_forward`/`arrow_back` + `close` glyphs, BOARDCLIP patch), the
  addon's default SVG connectors (`connect:'align'` is OFF and ui-parity forbids it), scroll lock
  always on (its unexplained toggle hidden), `collapseIdentical` folds unchanged stretches, `ignoreWhitespace` on by default (bar toggle rebuilds the
  view, preserving Result text). Vendored in `site/shared/vendor/cm5/`
  (codemirror@5.65 lib + merge addon + diff-match-patch browser shim; see its
  README) and loaded by BOTH `editor.html` and the demo — guarded by ui-parity #8.
  Skinned entirely with tokens in clipboard-popup.css (`.bc-merge-host` block). GOTCHA: the
  vendored merge.css draws chunk start/end borders unless zeroed (the skin does). The addon's
  window-resize redraw ran before CodeMirror's 100 ms re-measure (arrows beside the wrong
  chunk): patched to redraw again at 160 ms. Footer "Keep both" saves the union text through
  `conflictModel.conflictResolutionWrite` (it used to save NOTHING on a sync conflict, like
  "Remove conflict"); "Remove conflict" is `.btn.discard` (red on hover).
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
- **Merge seeds**: `base.text` when the record has one (true 3-way) → else
  Current (2-pane: unify + baseless conflicts). `Core.unionMergeText` (shared
  regions once + both sides of every change; built on `diffLineHunks`/
  `lcsSegments`, the in-house pure diff) backs "Keep both". **Smart merge (2026-10-03,
  owner-specified)**: ONE `autoMergeNonConflicting` backs both the toolbar merge-all and
  Unify's "Merge & continue" (which merges, then saves). 2-pane chunks go through
  `smartMergeChunk` LINE BY LINE (a diff chunk often lumps a lacked line with an
  addition): incoming additions + rewords/grown lines (`similarLine`, `losslessChange`)
  are taken, lines incoming merely lacks are KEPT (declined - a stale copy looks exactly
  like that, never delete silently), unrelated lines colliding = conflict (red, chip).
  While a conflict is left, Unify's primary is DISABLED with a tooltip (gutter arrow =
  take incoming, x = keep yours, Alt+B = both) - no "save anyway" confirm. 3-pane keeps
  the base-driven rule. Identical unify steps (CRLF-only, same title) fold silently in
  main (`skipIdenticalUnifySteps`, all-identical = no window); a whitespace-only step
  shows the `.bc-merge-note` ("only differences are whitespace") and saves the newer
  text verbatim. Layout (UI overhaul G, 2026-10-08): the result's title is the
  `.bc-bar`'s field (shown once); each read-only pane head = name + a title pick (only
  when the titles differ) + its whole-side accept ("Accept current" / "Accept incoming");
  the footer is ONE centred row in every mode (Keep both, Remove conflict on conflicts,
  the primary; a multi-step Unify's "Step 2 of 3" sits on its left gutter, out of the flow);
  ONE counter ("2 of 5 resolved" + a red chip while conflicts remain) whose total is the
  change count the view was BUILT with (a taken chunk stops being a chunk, so a live count
  made "resolved" fall as the user resolved things). A narrow head (container query) drops
  the accept's label to its glyph before squeezing the title pick (tooltip = full title).
  The primary still has a fixed `min-width` and the accepts live in the heads: a shorter
  last-step label once slid "Accept current" under a cursor aimed at "Accept incoming"
  and dropped the newest clip's tail (recovered from `clipboard-edit-archive/`). **CRLF is normalized to LF at the view
  boundary** (`toLF`) — stray `\r` defeats BOTH the addon's chunking and
  `collapseIdentical` (its ignoreWhitespace covers spaces/tabs only) and caused
  the original "all-green wall, zero matched lines" bug.
- **Word-level merge marks (vendored `bcWordDiff`, 2026-10-08)**: chunks still come from
  the addon's `getDiff`, the inline marks from a word-level copy of a RAW `diff_main`
  (in-line equalities fold into the edits around them, edits widen to whole words, a
  whole-line edit gets the wash only). Never mark from `getDiff`'s output: its
  ignoreWhitespace DROPS whitespace-only parts, equalities included, so every later
  position drifts (marks ended a character early). Conflict chunks: red wash on every
  pane, red word marks (`bc-conflict-line` wrap class), red connector (`chunkState`
  'conflict'). Patch list: `site/shared/vendor/cm5/README.md`.
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
- **Real-app pen-test**: `node scripts/qa-app-pentest.js` (32 checks: unify, conflicts, bulk
  actions) on the shared qa-sandbox harness above; never triggers `pasteMany` (would Ctrl+V into
  the focused window).
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
  `renderNumpadButtons` inside `renderKeypadMenu` (Numpad submenu AND row # popover):
  neutral keys, the clip's own key in the accent, a key another clip holds = a dim dot.
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
- **The canon (UI overhaul, 2026-10-07/08, `UI-OVERHAUL-PLAN.md`)**: ROLE tokens size everything:
  type `--fs-meta` 11 / `--fs-ui` 12 / `--fs-text` 13 (typed into) / `--fs-display` 18 (site),
  `--lh-ui`/`--lh-text`, two weights `--fw-regular`/`--fw-strong`, controls `--ctl-sm/md/lg`
  20/24/28, radii `--r-ctl`/`--r-chip`/`--r-panel`, `--gutter` 14 on every bar/content edge,
  `--bar-h`, lines `--line` / `--line-faint` / `--menu-edge` only, `--edge-ctl` (a trailing icon
  button's inset so its GLYPH lands on the gutter: popup header, search row, selection bar,
  settings header, `.bc-bar`, find bar). ONE of each: `.btn` (default / primary / danger / quiet
  / `.sm`; `.btn.quiet.sm.accent` = every accent text action: Undo, "Did you mean", Accept, the
  merge note; `.btn.discard` = red on hover), `.icon-btn` (hovers `--text` + `--hover`, `.danger`
  = red + `--red-bg`; accent is never a hover colour), `.bc-menu-item` (every menu / submenu /
  picker / suggest row), `.filter-tag` chip, `.overline` (uppercase SECTION heading) vs `.bc-label`
  (sentence-case label for a control group / pane: options rows, settings list titles, merge
  heads), `.bc-bar` window bar (every clip window + the approval prompt), one scrollbar, one
  `::selection`, one floating-surface rule, and `clipboard-window.css` = the window base sheet
  (body paints `--canvas`, glass scrim) every window links. GOTCHAS: Chromium 121+ IGNORES
  `::-webkit-scrollbar` on an element that sets `scrollbar-width`/`scrollbar-color` (only the
  `@supports not` fallback may set them); a ROLE token resolved on `:root` misses a `.bc-popup`
  variant override of the primitive it points at (density/corners remap the role tokens
  themselves; derived tokens like `--edge-ctl` live in the `[data-theme]` block for that reason).
- **Two tones, every window (owner 2026-10-08: "it was 2 tone before... did u not get what i
  meant?", a hairline alone was NOT it)**: chrome = a band in `--surface` (the popup header with
  search, options panel and chip row; `.settings-hdr`; every `.bc-bar`, `.bc-editor-foot`,
  `.bc-merge-heads`, `.bc-reconcile-actions`), ending on the `--line` hairline; content sits
  on `--canvas` (role token: solid = `--bg`, glass = `--glass-tint`), painted ONLY by the
  window (`body` in clipboard-window.css, `.demo-window`, the demo's `.bc-editor-overlay`); the
  content roots (`.settings-view`, `.bc-editor`, `.bc-viewer`, `.bc-reconcile`, list) paint
  nothing. Raised things on the canvas use `--surface` (expanded preview, approval card). The
  editor's find row is a band too (its bottom hairline IS the field underline, accent on focus);
  the approval prompt has a foot band (countdown + decisions) like the editor's foot. Tokens that
  sit on BOTH tones are washes, never opaque fills tuned to one base: `--input` (dark: a light
  g-100 wash, light: a g-900 tint) and dark `--line-faint` (an opaque g-900 vanished on the g-950
  canvas and was the hardest line over a glass desktop). Under glass the band is a LIFT over the
  ONE scrim (dark: white 6 %, light: white 70 %), so it reads lighter than the content whatever
  the desktop is (a g-850 mix inverted over bright desktops); no second blur (qa-ui-shots
  glass-popup / glass-all check it). The light scrim is white 84 % with dim text g-600 on it: at
  50 % a dark desktop or a dark system acrylic turned the list mid-grey (owner 2026-10-09: "can
  barely see shit in light theme"). The results list has the shared scroll-edge fade
  (`createClipList` -> `attachScrollFade(listEl, 'panel')`, `scroll-padding-block` keeps the
  cursor row out of it). Light `--hover`
  is 7 % so it reads on white; `.item.similar` = `--similar-mix` of `--hover` (60 % dark, 35 %
  light), so hover stays the strongest neutral row state. The theme blocks keep the solid values
  as `--surface-solid`/`--surface2-solid`/`--input-solid` (glass overrides `--surface`): the
  demo's editor overlay re-takes them under "Glass on: Popup only" (`data-glass-scope` on the
  demo popup via `applyVariants`), so it paints exactly the app editor window's surface.
- **Rows (`Core.renderClipItem`)**: one anatomy (primary line: a real title at `--fw-strong`, an
  untitled clip's first line regular; dim mono preview; meta line), star = pin only (`--icon-md`
  in a `--ctl-md` box centred on the first line), row buttons on the shared `.bc-reveal` (held
  while the menu is open / dragged / focus inside), image rows' buttons at the SAME place (the row's
  top right) but floating, so the picture never resizes; plain like a text row's, frosted
  (`.img-under`) only while the picture reaches under them (`Core.markImageUnder` on row entry, a
  ResizeObserver while open: zoom / resize), the chip's padding cancelled by its margin so the
  buttons never move (owner 2026-10-08: "on the image corner instead of content corner feels dumb";
  no row ever changes height on hover). Meta line (`renderClipMeta`): time, size, `#N`
  badge and group names as plain text, every text gap `--sp-3` (badge + names pull their hover
  padding back out with a negative margin), hover ghosts `#` (only without a key) and `+` on the
  reveal -> the keypad / group picker popovers. `Core.fitMetaTags` (on row pointer/focus entry,
  `createClipList`) marks names that would not fit beside the open ghosts `.meta-cut` so the `+`
  follows the last shown name. One numpad glyph: `tag` (#) in the chip bar, meta and menu.
  Similar-clip tint: `Core.similarClipIds` (cached per hovered id until the history revision
  changes, sliced off the typing path) + "Select N similar". Empty states: `Core.renderEmptyState`
  (`emptyStateKind`: no clips / no match / filtered / empty group), same in app and demo.
- **Appearance variants** are `data-*` attributes on the same root that carries
  `data-theme`, swapping a small disjoint token set (see the tier-(c) blocks):
  `data-surface` (glass/solid), `data-accent` (blue/teal/mono), `data-density`
  (normal/compact), `data-corners` (soft/sharp), `data-borders`
  (bordered/borderless). EVERY window (popup, editor/unify/conflict, viewer, approval)
  and the demo paint main's payload (`appearanceVariantPayload` + the window's surface,
  `lib/appearance.js` validates/syncs: theme, accent, density and corners are stamped synced
  groups, the newest change wins on every device) through ONE `Core.applyAppearance(root, look)`
  (2026-10-08): `applyVariants` plus a System/Custom colour as `data-accent="custom"` +
  six inline vars (`Core.accentShades`: per theme the colour, or the nearest shade
  reaching 3:1 on the theme surfaces with an ink at 4.5:1, plus a TEXT shade; tokens pick
  the set, so a theme flip needs no script). The light theme has darker Teal/Mono presets for
  the same rule (`ui-tokens.test.js` #25 checks presets + a hue sweep). Accent used AS TEXT
  (active chip, current numpad key, Accept, zoom step, clipboard status, link-like buttons)
  is `--accent-text` (4.5:1 on the surface AND on the `--accent-bg` tint; the stock Windows
  #0078d4 is only 3.97:1 as dark-theme text); `--accent` stays for fills, glyphs, focus
  ring, switches. Each accent swatch previews the colour its choice paints in the current
  theme (`--dot`; System not chosen = a ring, never a twin of Blue). Settings > Appearance
  (Theme, Accent swatches + Custom hue/#rrggbb, Surface, Glass on, Density, Corners) is
  bound by `Core.mountSettings` in app AND demo; NO native colour input (its dialog takes
  focus and the popup blur-hides). Only Borders stays an audit axis behind
  `BOARDCLIP_DEBUG_VARIANTS=1` (env-only since 2026-09-02: a stale `ui_borders` made tags
  filled chips on one machine only). The popup merges partial updates (surface-changed)
  into its last full payload: a bare `applyVariants` call resets every axis not passed.
- **Settings body** = ONE `.setting-row` grid (label + one-line help | control | reserved
  reset column) and ONE list row (`Core.renderSettingsItem`; numpad slots, groups, sync,
  peers, AI clients, grants, conflicts all render through it), status lines via
  `Core.setSettingHelp` (an empty help takes no space, so no "Off" lines). Order: conflicts
  (top, only when present), General, Appearance, Quick paste and numpad, Groups, Sync, AI
  access, History, Diagnostics (`ui-parity.test.js` #31).
- **Native glass: the popup by default; every window with Settings > Appearance > "Glass on: All
  windows"** (`glass_scope: 'all'`, per machine). Centralized in main.js: `glassSupport()`
  (macOS -> vibrancy; Win build >= 22000 -> acrylic; else none), `resolvedSurfaceStyle()` /
  `glassOn()` / `secondaryGlassOn()`, and ONE options source, `lib/appearance.js`
  `surfaceWindowOptions`: `popupSurfaceOptions()` is spread into `createPopup` only, and every
  other window (editor, viewer, unify, conflict, approval) spreads
  `secondaryWindowSurfaceOptions()` and records what it got with `noteSecondarySurface` (a macOS
  window created solid stays opaque until reopened). Live toggles without recreating a window:
  `applySurfaceToPopup()` / `applySurfaceToWindows()` (mac keeps `transparent:true` +
  `setVibrancy`, Win `setBackgroundMaterial`). Each window has exactly ONE frosted layer (the
  scrim); its bars are translucent `--surface` lifts, its content paints nothing. `notifyColorSchemeChanged` must
  NOT stamp an opaque bg over live glass. The glass scrim (`:root[data-surface="glass"]
  body::before`, `--glass-tint` + `backdrop-filter`) lives in `clipboard-window.css`; the OS
  provides the real blur behind a transparent window. Every window renders the SAME appearance
  payload through `Core.applyAppearance` (variants, the window's own `surfaceStyle`, the accent
  colour): the popup from `runtime_info` + the `appearance-changed` broadcast, the clip windows
  from `editor-init` / `viewer-init` (`windowAppearance(w)`), the approval modal from
  `approval-settings`. Clip windows also get `windowControls` and report their bar back
  (`window-chrome` -> `applyWindowChrome`) so the native caption buttons match it.
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
  builds (no `.git`). **GOTCHA (fixed 2026-07-07, commit 5b4fb07):** "dirty" is
  computed from tracked changes only (`build-info.js` passes `--untracked-files=no`,
  matching `update.bat`). Before the fix it counted UNTRACKED files too, so recovery
  artifacts left in the install dir (`clipboard-RECOVERED/`, `*.PRE-RECOVERY-*.json`,
  `clipboard-edit-archive/`) silently blocked auto-update for hours (heartbeat build
  shows `<sha>-dirty`). Also: `update.bat`'s own `npm install` can rewrite the tracked
  `package-lock.json` and re-block the NEXT update — restore it (`git checkout -- package-lock.json`;
  node_modules is unaffected) so the checkout stays clean.
  **GOTCHA #2 (2026-09-03 -> 2026-09-20, every auto-update silently half-applied):** the
  lockfile-restore comment above was written as `::` lines INSIDE the `if defined NEED_INSTALL
  ( ... )` block. cmd does not treat `::` as a comment inside a `( )` block - the line is parsed,
  the `)` in `(node_modules is already installed).` closed the block early and the script died
  with `. was unexpected at this time.` (exit 255) AFTER `git pull` and BEFORE `start.bat`. The
  updater then (a) swallowed the error (only `manual` checks logged) and (b) on the next poll
  compared `latest` against the ON-DISK HEAD, which the pull had already moved, so it reported
  "current" while the process still ran the old commit. Five pulls in the install's reflog
  (Sep 7 x3, Sep 13 x2) relaunched nothing; the app ran stale code until a human restarted it.
  Fixed: `rem` in the block (`test/auto-update.test.js` #4 scans every .bat/.cmd for `::` at
  paren depth > 0), `check()` compares against the RUNNING commit (`currentCommit`) so a
  half-applied update retries the relaunch, and every apply outcome is recorded as
  `update.applied` / `update.apply_failed {from,to,disk_head,code,message}` (forceFile). An
  `update.apply_failed` line, or disk HEAD != the `build` in `app.start`, = stale process.
  **GOTCHA #3 (fixed 2026-10-07):** an install AHEAD of GitHub main (a local commit fast-forwarded
  into it before a push) relaunched ~90 s after every start: the no-op pull changed no files, mode
  'none' fell into the relaunch branch. Now no change on disk = `update.unchanged`, stay up.
  Diagnose a suspected stale install with `git -C <install> reflog --date=iso` vs the running
  process StartTime: a `pull --ff-only` newer than the process with no `app.quit
  {reason:update-relaunch}` after it is exactly this.
- **Windows popup is PARKED, never hidden (2026-10-07, the "opens twice" rim)**: every ShowWindow of
  the acrylic popup drew the glass full size at once while Windows scaled + faded the web content in
  ~130-200 ms later (measured with a ~100 fps CopyFromScreen recording). DWMWA_TRANSITIONS_FORCEDISABLED
  and acrylic->mica did NOT change it (the first "fix" shipped that and the owner still saw it); child
  HWNDs reject DWM attributes (E_HANDLE). Fix: `lib/windows-dwm.js` `setParked` = DWMWA_CLOAK +
  WS_EX_NOACTIVATE. Closed = shown + cloaked (painted, not drawn, not hit-tested, not in Alt-Tab, never
  handed focus by Windows); open = uncloak (complete in ONE frame) + a 10 px / 130 ms window-level slide
  (`setPosition` steps: glass and content move together; `setOpacity` would make it layered and kill
  the acrylic). RULES: (1) "open" is `isPopupOpen()` (popupOpen && isVisible), NEVER `win.isVisible()`
  (a parked popup IS visible); (2) MOVE the cloaked window first, uncloak second (the reverse flashed one
  frame at the last spot); (3) hide hands focus back (`setForegroundWindow(saved)`, else `blur()`), a
  cloaked window keeps it otherwise; (4) cross-DPI move waits one renderer frame before the reveal.
  Failures log `popup.park_failed` / `popup.unpark_failed` and fall back to hide/show.
  Open motion = `popupOpenMotion()`: Windows + glass = the one-frame uncloak + 10 px slide;
  Windows + Solid = fade + slide (layered alpha, then WS_EX_LAYERED cleared; kill switch
  `BOARDCLIP_SOLID_FADE=0`); macOS = fade + slide (window alpha, vibrancy survives); reduced
  motion = none. Fading glass on Windows was tried and rejected (layered alpha shows the content
  with NO blur during the fade, and a none->acrylic backdrop switch paints an opaque slab first).
  Verify by recording the open (frame N empty, frame N+1 complete) with the popup parked ELSEWHERE first.
- **Popup renders but paints NOTHING on Windows (2026-09-20, ~40h uptime): Chromium native
  window occlusion.** The popup is `show:false` + hidden on every blur, the pattern
  `CalculateNativeWinOcclusion` mishandles: it stops compositing the "occluded" window and never
  re-attaches the content layer on the next show. Renderer JS keeps running (diagnostics showed
  full `renderer.list.rerender rendered=30`, no `renderer.error`, no `render-process-gone`,
  window at the right bounds and not cloaked) but nothing reaches the screen; with
  `backgroundMaterial:'acrylic'` over a `#00000000` background an unpainted window reads as a
  BLURRED EMPTY SHELL, not a blank box. Reloading the page re-renders into the same dead surface.
  Fix (`18c0467`): `app.commandLine.appendSwitch('disable-features',
  'CalculateNativeWinOcclusion')` on win32 before ready + `backgroundThrottling:false` on the
  popup; `app.start.win_occlusion` reports `disabled`. A restart clears the bad compositor state
  on its own; the switch is what stops the recurrence.
- **Installer downloads** (`.exe`/`.dmg`): `release-binaries.yml` now runs on
  every push to `main` that touches app code (`paths-ignore: site/**`, docs) and
  republishes a single rolling **`latest`** GitHub release (`make_latest: true`)
  that the site's `/releases/latest/download/...` button points at. So the
  download stays in lockstep with `main` — no version tag needed. (Packaged
  installs still don't self-update; that'd need electron-updater — not wired.)
  **macOS = ONE universal app (2026-10-09)**: `BoardClip-macOS.dmg` / `.zip` (Apple Silicon +
  Intel; `mac.target` arch `universal`, built on `macos-15`). koffi ships a prebuilt .node per
  arch that is IDENTICAL in both slices, so `x64ArchFiles: **/koffi/**` (else @electron/universal
  throws "same in both x64 and arm64 builds"). The publish job drops assets this build no longer
  makes (the old `-Apple-Silicon` / `-Intel` files). Unverifiable on Windows: the first push is
  the test. **Gatekeeper "Not Opened / could not verify"** = unsigned + unnotarised. The
  workflow signs + notarises the mac build by itself once these repo secrets exist:
  `MAC_CSC_LINK` (Developer ID Application cert, base64 .p12), `MAC_CSC_KEY_PASSWORD`,
  `APPLE_ID`, `APPLE_APP_SPECIFIC_PASSWORD`, `APPLE_TEAM_ID` (Windows never sees them; hardened
  runtime with `assets/entitlements.mac.plist` = electron-builder's defaults + Apple Events for
  the osascript paste path). Until then the site's Mac note says System Settings > Privacy &
  Security > Open Anyway; the curl install (git clone) is never quarantined.
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
- **Silent main-process death = check the System event log FIRST** (`Get-WinEvent -FilterHashtable @{LogName='System'; Id=2004}` / Application Popup 26). 2026-09-01 21:52: BoardClip (9-day uptime) vanished mid-keystroke with NO Event 1000, NO crash dump, NO diag quit event; the tiny MCP helpers survived. Cause was a machine-wide *Out of Virtual Memory* (commit exhausted by chrome.exe 13GB + WSL 5GB + a node 4GB) - the allocating process aborts and WER can't even record it. Not a BoardClip bug. Every editor draft was already idle-committed (verified byte-for-byte against history via `clipboard-edit-archive`), zero data loss.
- **Silent stops #2 and #3 (2026-09-03 05:54 and 06:30 local) = console-close kills of instances
  launched from an agent shell (see the bullet below)**: heartbeats simply ended, RSS flat, no
  Event 1000/2004, no crashpad dump, updater ruled out (`.git/FETCH_HEAD` untouched since 05:15).
  Indistinguishable from a tray Quit because nothing logged exits, so main.js now records
  `app.quit {reason: tray-quit|update-relaunch|quit}` on before-quit, `app.exit {code}` on process
  exit, `main.uncaught_exception` / `main.unhandled_rejection`, and `app.child_process_gone` /
  `app.render_process_gone`. A death with heartbeats and NO `app.quit` line = external kill or
  native crash. Check `git reflog --date=iso` in the install + `.git/FETCH_HEAD` mtime to rule
  the auto-updater in or out (its relaunch is `app.exit(0)` after `update.bat`).
- **NEVER launch the live app as `electron.exe .` from an agent tool shell (2026-09-03, two
  "crashes")**: electron attaches to the parent console, and the harness's hidden PowerShell/Bash
  console is torn down later (26 min and 58 min after launch today) - Windows then sends a console
  control event to every attached process: the Network Service child logged
  `app.child_process_gone exit_code -1073741510` (0xC000013A = STATUS_CONTROL_C_EXIT) and the main
  process died in the same second with NO `app.quit` line. The user's Start Menu shortcut /
  Startup `BoardClip.vbs` run `start.bat` in a NEW hidden console that the app then owns, which is
  why it runs for days. To relaunch from a tool: `Start-Process -FilePath <install>\start.bat
  -WindowStyle Hidden` (ShellExecute gives the batch its own console), or `wscript.exe
  "%APPDATA%\Microsoft\Windows\Start Menu\Programs\Startup\BoardClip.vbs"`. Verify afterwards
  that the new electron.exe's parent has exited (`Win32_Process.ParentProcessId` dead = it owns
  its console). Code hardening (2026-09-03, `lib/windows-console.js`): at startup on win32 the app
  `FreeConsole()`s any console that OTHER processes are attached to (`GetConsoleProcessList` > 1 =
  a shell that may close it); a console it is alone on (the VBS/start.bat path after cmd exits)
  is kept. A "window visible" heuristic was tried first and is WRONG - an agent shell's hidden
  console still reports WS_VISIBLE. `npx electron .` output in the terminal now needs
  `BOARDCLIP_KEEP_CONSOLE=1`. `app.start.console` reports `{action: detached|kept|none, reason,
  attached}` plus `ppid`; stdout/stderr are error-guarded and only logSafe writes to them. Unit:
  `test/windows-console.test.js`; sandbox proof = launch via `Start-Process electron.exe` from a
  tool shell and read `app.start.console` (`detached`, `shared-console`).
- **Electron `crashReporter` is now started at boot (local only, `uploadToServer:false`)**, so a
  native crash of main/GPU/renderer leaves a minidump under `%APPDATA%\BoardClip\Crashpad`.
  `app.start.crash_reporter` says `on`. Third silent stop of 2026-09-03 (11:05 local, an instance
  the user launched from the Start Menu, console owned, WER enabled and working, no dump, no
  `app.quit`, no child event): the only remaining signature is an external `TerminateProcess`,
  e.g. another agent session running `taskkill /IM electron.exe` for its own Electron app (Forge
  is Electron too) - the global rule "never kill by image name" exists for exactly this.
- **Machine-wide OOM kills (2026-09-01 and 2026-09-07) + the WMI wedge that blocks a reopen**:
  both silent stops were Windows *low virtual memory* events (System log Id 2004; 09-07: commit
  101 of 104 GB, chrome.exe 44 GB private, vmmemWSL 3.4 GB) - the allocating process is aborted
  with NO app.quit line, no dump, no Event 1000. The same starvation wedges winmgmt, so every
  `Get-CimInstance` hangs, which used to hang `kill.bat` -> `start.bat` -> the Start Menu shortcut
  and the user's reopen attempts ("randomly closed, reopen won't work"). FIX (2026-09-07):
  main.js writes `boardclip.pid` (`{pid, startedAt, exe}`, app dir, untracked) once it holds the
  single-instance lock and removes it on exit; `kill.bat` now runs `scripts/kill-app.ps1`, which
  stops that pid with plain `Get-Process` (path + start-time verified, so a recycled pid is never
  hit), then runs the old WMI sweep in a `Start-Job` capped at 8 s (skipped when winmgmt does
  not answer). Proof: `node scripts/qa-kill-script.js` (pid-file-only kill with the sweep
  disabled, normal kill.bat, nothing-running, other checkouts' electron count unchanged).
  Diagnose a stop WITHOUT WMI: `netstat -ano | findstr 45454` (the app owns UDP 45454),
  `Get-Process electron` (WMI-free; a 30 MB / 10-thread electron is an MCP helper, the app is
  40+ threads / 300+ MB), `Get-Counter '\Memory\Committed Bytes','\Memory\Commit Limit'`, and
  `Get-WinEvent -FilterHashtable @{LogName='System'; Id=2004}`. Relaunch from a tool ONLY with
  `Start-Process -FilePath <app>\start.bat -WindowStyle Hidden` (kill.bat inside it is now
  WMI-proof). **The OLD kill.bat left time bombs**: every reopen attempt the user made while WMI
  was wedged (Start Menu -> start.bat -> kill.bat) parked a powershell inside `Get-CimInstance`;
  when WMI finally answered, each loop `Stop-Process`ed every non-helper electron of the
  checkout and exited - that is what killed the relaunched instances at 14:35 and 14:37 on
  2026-09-07 (no app.quit, `console: none`). Two more were still hung (14:09, 14:10) and were
  killed by hand. Find them WITHOUT WMI via `NtQueryInformationProcess` parent pids (a
  powershell whose parent is cmd.exe is a kill.bat); the new kill-app.ps1 cannot leave one
  behind (Wait-Job cap + Remove-Job -Force kills the sweep's process).
- **A wedged cloud mount BLOCKS, it does not fail (2026-09-13)**: Google DriveFS hung with `G:` in
  an uninterruptible kernel wait, so `fs.existsSync('G:\\My Drive')` never returned - and neither
  did `timeout 8 ls` (9.4 min, exit 124 only once the mount was freed), `tasklist`, or ANY
  PowerShell session (it stats every drive at startup: "InitializeDefaultDrives ... failed").
  Symptom order: the popup renders BLANK/frozen, one sync pass holds `insideSync` (29 min of
  `sync.skip_inside_sync`, `sync.timeout.late ms=1752620` against a 12 s budget), a tray quit still
  works, and then the app WILL NOT LAUNCH - startup blocks inside cloud discovery before any window
  exists, and the half-started process holds the single-instance lock so every further click does
  nothing. Diagnose WITHOUT PowerShell: `ps -W` (MSYS, no WMI) for processes + start times,
  `netstat -ano` for the app's UDP 45454, and probe a mount only from a BACKGROUND bash task (a
  foreground one cannot be killed - `timeout` cannot interrupt an uninterruptible wait). Remedy:
  kill the stuck app process, then restart the cloud client by pid (DriveFS had TWO versions
  running, 129 and 130); that frees every hung handle at once and the drive letters come back in
  ~60 ms. FIX shipped 2026-09-13: `lib/fs-probe.js` - `probePath` gives every existence check on a
  mount a deadline (resolves false, never throws, never outlives it), and `createPathHealth` hides
  a provider that timed out until a SINGLE-FLIGHT probe says it is back. Single-flight is the
  point: a hung probe owns a libuv threadpool thread for ever and there are only 4, so RETRYING a
  wedged mount is how one drive letter kills every async read in the app. `cloud-accounts.js` now
  probes drive letters in parallel (2 s each, mac CloudStorage + OneDrive + iCloud too - no
  `fs.existsSync` survives there), `getEnabledSyncPaths` filters on health and kicks a background
  re-check, a `timed out` provider or journal read marks the path unresponsive
  (`sync.provider.unresponsive` / `sync.provider.recovered` diagnostics + tray tooltip), and the
  watcher's `mkdirSync` is an async mkdir that reserves its slot. Tests: `test/fs-probe.test.js`
  (note: it must hold the event loop open, since probePath unrefs its timer).
- **Orphan-draft recovery was DEAD from the `-<seq>` filename change until 2026-09-01**: `EDIT_DRAFT_RE` only matched legacy `boardclip-edit-<12hex>-<ts>.txt`, but sessions write `...-<ts>-<seq>.txt`, so `recoverOrphanedEdits` skipped every in-flight draft (15 lingered since July, never retired). Fixed + guarded by `test/edit-draft-recovery.test.js` (reads the regex + generator out of main.js). Idle-commit had covered the gap in practice. Recovery now also SKIPS a draft whose text already sits inside a longer clip (an older prefix of a note edited after the crash) so the first restart doesn't resurrect stale duplicates - only genuinely unsaved text comes back as a new clip.
- **Popup-open / save hot path (2026-09-02, ~10k items, 7.7MB history) - measured, don't regress:**
  the 1-2s "freeze on open" was FOUR stacked costs, none of them the file write (15ms) or
  stringify (23ms). (1) `backupStore.writeSnapshot` ran INLINE in every save: ~0.9s warm (an
  existsSync per item = 10k stats) / 9.5s cold -> p50 636ms, p90 2.4s, max 5.8s of main-thread
  block per clipboard capture. Now: `lib/backup.js` keeps an in-memory pool index (one readdir,
  invalidated by GC) and main hands the PRE-write JSON strings (cached, never re-read) to
  `lib/backup-worker.js` on a worker thread (one at a time; failure -> async full-JSON fallback).
  (2) `get-settings` (called on EVERY popup open via `refreshGroups`) shipped ~475KB of
  tombstones/supersedes + spawned git (65ms) + walked the blob dirs: now `rendererSettingsView()`
  strips the ledgers, `refreshBuildInfo({maxAgeMs})` and `cachedStorageBytes()` cache. (3) the
  renderer re-cloned all items over IPC on every refresh even when unchanged: `get-history-state`
  takes the renderer's known revision and answers `{unchanged:true}`; `refreshGroupsAndList`
  coalesces (one in flight + one queued) instead of stacking five refreshes. (4) Ctrl+A moved focus
  to the LAST row and the lazy list materialised all 9.7k rows to scroll there: `selectAll` keeps
  the cursor. Guards: `popup-lifecycle.test.js` (source), `backup.test.js` #8-9, `multiselect`.
- Main process errors go to terminal, renderer errors to DevTools (Cmd+Option+I)
- To test the app's renderer (`index.html`) without Electron, serve the repo root
  and load it with a stubbed `window.api` (CDP `Page.addScriptToEvaluateOnNewDocument`)
  — it renders the popup + settings and exercises the shared controller/dialogs.
