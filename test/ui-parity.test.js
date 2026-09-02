'use strict';

// Guards that the desktop app popup (index.html) and the website demo
// (site/index.html) stay structurally identical by both rendering from the
// shared clipboard-ui-core.js + clipboard-popup.css. If a future change
// re-inlines the settings markup, re-duplicates popup CSS, or makes the shell
// renderer branch on ids, one of these assertions fails the build.

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const ui = require('../site/shared/clipboard-ui-core');

const root = path.join(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(root, rel), 'utf8');
const appHtml = read('index.html');
const siteHtml = read('site/index.html');
const popupCss = read('site/shared/clipboard-popup.css');
const siteCss = read('site/styles.css');

// 1) The shared settings body exposes every element id the desktop app binds.
//    These are the runtime-filled containers + inputs the app's JS drives; if
//    any goes missing the app silently loses a settings control.
{
  const body = ui.renderSettingsBody();
  const requiredIds = [
    'autoLaunch', 'shortcutRecord', 'shortcutReset', 'quickPasteRecord', 'quickPasteReset',
    'maxAge', 'maxSize', 'usage', 'numpadSlots', 'syncAccounts', 'syncNow', 'addSyncFolder',
    'syncStatus', 'p2pEnabled', 'p2pStatus', 'updateBuild', 'updateDetail', 'updateNow',
    'updateStatus', 'diagnosticsEnabled', 'diagnosticsStatus', 'aiAccessEnabled', 'aiAccessStatus',
    'aiAccessBody', 'aiClients', 'aiMoreClients', 'aiClientsMore',
    'aiAlwaysHead', 'aiAlwaysAllow', 'aiTimeout', 'groupSlots', 'addGroupBtn', 'clearAll',
    'copyDiagnostics', 'buildInfo',
  ];
  for (const id of requiredIds) {
    assert.ok(body.includes(`id="${id}"`), `renderSettingsBody() is missing id="${id}"`);
  }
}

// 2) Both consumers actually USE the shared renderers AND the shared interaction
//    controller — they must not re-inline their own popup shell / settings body /
//    action row / click-dispatch / dialog system. This is what stops behavior
//    (e.g. the group-delete confirm) from drifting between the two popups.
{
  for (const [name, html] of [['index.html', appHtml], ['site/index.html', siteHtml]]) {
    assert.ok(html.includes('Core.renderPopupShell('), `${name} must call Core.renderPopupShell()`);
    assert.ok(html.includes('Core.renderSettingsBody()'), `${name} must call Core.renderSettingsBody()`);
    assert.ok(html.includes('Core.renderClipActions('), `${name} must call Core.renderClipActions()`);
    assert.ok(html.includes('Core.createClipController('), `${name} must drive the shared Core.createClipController`);
    assert.ok(/controller\.onClick|controller\.onKeydown/.test(html), `${name} must route events through the shared controller`);
    assert.ok(html.includes('controller.onMousedown('), `${name} must route mousedown through the controller (middle-button autoscroll suppression)`);
  }
  // The shared controller owns the dialogs; neither side may re-introduce a
  // bespoke confirm/prompt overlay or a hand-rolled pendingAssign dispatch.
  for (const sentinel of ['pendingAssign', 'id="confirmOverlay"', 'id="demo-confirm"']) {
    assert.ok(!appHtml.includes(sentinel), `index.html re-introduced a bespoke dialog (${sentinel}); use the shared controller/dialogs`);
    assert.ok(!siteHtml.includes(sentinel), `site/index.html re-introduced a bespoke dialog (${sentinel}); use the shared controller/dialogs`);
  }
  assert.ok(ui.renderSettingsBody().includes('id="themeMode"'), 'renderSettingsBody must include the shared Theme control');
}

// 3) Anti-re-inline guard: settings markup must come ONLY from the shared
//    renderer at runtime, never be hand-written back into a consumer's source.
{
  const sentinels = ['id="aiAccessEnabled"', 'id="diagnosticsEnabled"', 'id="updateBuild"', 'class="settings-footer"'];
  const coreSrc = read('site/shared/clipboard-ui-core.js');
  for (const sentinel of sentinels) {
    assert.ok(coreSrc.includes(sentinel.replace(/"/g, "'")) || coreSrc.includes(sentinel),
      `clipboard-ui-core.js should own the settings markup (${sentinel})`);
    assert.ok(!appHtml.includes(sentinel), `index.html re-inlined settings markup (${sentinel}); use Core.renderSettingsBody()`);
    assert.ok(!siteHtml.includes(sentinel), `site/index.html re-inlined settings markup (${sentinel}); use Core.renderSettingsBody()`);
  }
}

// 4) Popup component styles live ONLY in the shared stylesheet. The app inline
//    <style> and the marketing CSS must not re-declare them (that is exactly how
//    the palettes drifted before).
{
  const popupSelectors = [
    'filter-tag', 'numpad-picker', 'np-btn', 'ai-client-row', 'sync-account',
    'settings-footer', 'shortcut-btn', 'np-slot', 'group-slot',
  ];
  const declares = (css, sel) => new RegExp(`(^|[\\s,])\\.${sel}\\s*[,{]`, 'm').test(css);
  for (const sel of popupSelectors) {
    assert.ok(declares(popupCss, sel), `clipboard-popup.css should define .${sel}`);
    assert.ok(!declares(appHtml, sel), `index.html re-declares popup style .${sel} (belongs in clipboard-popup.css)`);
    assert.ok(!declares(siteCss, sel), `site/styles.css re-declares popup style .${sel} (belongs in clipboard-popup.css)`);
  }
}

// 5) Popup THEME variables + design tokens live only in the shared token layer,
//    and the old AI-slop purple palette is gone from every consumer.
{
  const tokensCss = read('site/shared/clipboard-tokens.css');
  assert.ok(/--blue-500:\s*#3b82f6/.test(tokensCss), 'clipboard-tokens.css should define the brand blue primitive');
  assert.ok(/--accent:\s*var\(--blue-500\)/.test(tokensCss), 'dark --accent should map to the brand blue primitive');
  assert.ok(/^@import url\("clipboard-tokens\.css"\)/m.test(popupCss), 'clipboard-popup.css must @import the token layer');
  assert.ok(!/--accent:\s*#a78bfa/.test(popupCss), 'clipboard-popup.css should no longer hard-code a theme --accent (moved to tokens)');
  for (const [name, css] of [['clipboard-tokens.css', tokensCss], ['clipboard-popup.css', popupCss], ['site/styles.css', siteCss], ['index.html', appHtml], ['site/index.html', siteHtml]]) {
    assert.ok(!/#a78bfa|#7c3aed|#8b5cf6/i.test(css), `${name} still contains the old purple palette`);
  }
}

// 6) The shell renderer is structurally id-agnostic: same inputs but different
//    id sets must yield an identical tag+class skeleton. This is what lets the
//    app and demo pass their own ids yet render the same popup.
{
  const skeleton = (html) => (html.match(/<([a-z0-9]+)([^>]*)>/gi) || []).map((tag) => {
    const name = tag.match(/<([a-z0-9]+)/i)[1].toLowerCase();
    const cls = (tag.match(/class="([^"]*)"/) || [, ''])[1].trim();
    return `${name}.${cls}`;
  });
  const opts = (ids) => ({ ids, settingsBodyHtml: ui.renderSettingsBody() });
  const appShell = ui.renderPopupShell(opts({ mainView: 'mainView', list: 'list' }));
  const demoShell = ui.renderPopupShell(opts({ mainView: 'demo-main-view', list: 'clip-list' }));
  assert.deepStrictEqual(skeleton(appShell), skeleton(demoShell),
    'renderPopupShell produced different structure for different ids — the shell must be id-agnostic');
}

// 7) renderClipActions emits the SLIM hover row (primary action + "..." menu);
//    Set title + Delete are demoted into renderClipMenu (the advanced surface).
{
  const textActions = ui.renderClipActions({ id: 'x', type: 'text', text: 'a'.repeat(200) + '\nb' }, { expanded: false });
  assert.ok(!textActions.includes('data-action="expand"'), 'text item should use editor open, not inline expand');
  for (const a of ['edit', 'clip-menu']) {
    assert.ok(textActions.includes(`data-action="${a}"`), `renderClipActions text row missing data-action="${a}"`);
  }
  for (const a of ['rename', 'del']) {
    assert.ok(!textActions.includes(`data-action="${a}"`), `renderClipActions row should NOT keep demoted action "${a}" (moved to the menu)`);
  }
  const imageActions = ui.renderClipActions({ id: 'y', type: 'image' }, {});
  for (const a of ['open-img', 'save-img', 'clip-menu']) {
    assert.ok(imageActions.includes(`data-action="${a}"`), `renderClipActions image row missing data-action="${a}"`);
  }
  assert.ok(!imageActions.includes('data-action="edit"'), 'image item should not offer the text editor');
  assert.ok(!imageActions.includes('data-action="del"'), 'delete is demoted to the menu, not the image row');
  // The "..." menu is the complete surface: it carries the demoted + all quick
  // actions, keyed by the SAME data-action attributes the controller dispatches.
  const textMenu = ui.renderClipMenu({ id: 'x', type: 'text', text: 'hi' }, { items: [], groups: ['Work'], numpadMap: {} });
  for (const a of ['pin', 'edit', 'rename', 'add-group', 'del']) {
    assert.ok(textMenu.includes(`data-action="${a}"`), `renderClipMenu text missing data-action="${a}"`);
  }
  assert.ok(textMenu.includes('class="np-btn'), 'renderClipMenu should embed the numpad grid');
  const imageMenu = ui.renderClipMenu({ id: 'y', type: 'image', image: 'a.png' }, { items: [], groups: [], numpadMap: {} });
  for (const a of ['pin', 'open-img', 'save-img', 'rename', 'del']) {
    assert.ok(imageMenu.includes(`data-action="${a}"`), `renderClipMenu image missing data-action="${a}"`);
  }
  assert.ok(!imageMenu.includes('data-action="edit"'), 'image menu should not offer the text editor');
  // A named image is searchable by its title (shared title field feeds search).
  const named = ui.itemSearchText({ type: 'image', title: 'Q3 revenue chart', image: 'abc.png' });
  assert.ok(/q3 revenue chart/i.test(named), 'image title must be part of its search text');
}

// 9) Multi-select is single-sourced: both consumers drive the shared selection
//    contract (visibleIds/renderSelection) + shared bulk renderers, and neither
//    re-inlines a bespoke selection index or bar.
{
  assert.ok(typeof ui.renderClipMenu === 'function', 'core must export renderClipMenu');
  assert.ok(typeof ui.renderBulkMenu === 'function', 'core must export renderBulkMenu');
  assert.ok(typeof ui.renderSelectionBar === 'function', 'core must export renderSelectionBar');
  assert.ok(typeof ui.applySelectionUI === 'function', 'core must export applySelectionUI');
  assert.ok(typeof ui.createMenu === 'function', 'core must export the shared popover menu');
  // Bulk menu content: paste-all + group + delete always; unify only for all-text.
  const bulkText = ui.renderBulkMenu({ count: 3, hasImage: false }, { groups: ['Work'], selectedItems: [] });
  for (const a of ['bulk-paste', 'bulk-group', 'bulk-add-group', 'bulk-unify', 'bulk-delete']) {
    assert.ok(bulkText.includes(`data-action="${a}"`), `renderBulkMenu missing data-action="${a}"`);
  }
  const bulkMixed = ui.renderBulkMenu({ count: 2, hasImage: true }, { groups: [], selectedItems: [] });
  assert.ok(!bulkMixed.includes('data-action="bulk-unify"'), 'Unify must be hidden when the selection contains an image');
  const bar = ui.renderSelectionBar({ count: 4, hasImage: false });
  // Group is its OWN bar button (opens the tri-state group popover) — not fused
  // with an ambiguous "more" menu.
  for (const a of ['bulk-paste', 'bulk-group-open', 'bulk-unify', 'bulk-delete', 'bulk-clear']) {
    assert.ok(bar.includes(`data-action="${a}"`), `renderSelectionBar missing data-action="${a}"`);
  }
  for (const [name, html] of [['index.html', appHtml], ['site/index.html', siteHtml]]) {
    assert.ok(html.includes('Core.applySelectionUI('), `${name} must paint selection via the shared Core.applySelectionUI`);
    assert.ok(/visibleIds\s*:/.test(html), `${name} must supply the visibleIds() selection hook`);
    assert.ok(/renderSelection\s*:/.test(html), `${name} must supply the renderSelection() selection hook`);
    assert.ok(!/selectedIdx/.test(html), `${name} still uses a bespoke selectedIdx; selection lives in the shared controller now`);
  }
}

// 8) The built-in editor is single-sourced too: both the app editor window
//    (editor.html) and the website demo mount the SAME Core.createEditor, and
//    the demo must not keep a bespoke contenteditable inline-edit.
{
  const coreSrc = read('site/shared/clipboard-ui-core.js');
  const editorHtml = read('editor.html');
  assert.ok(editorHtml.includes('Core.createEditor('), 'editor.html must mount the shared Core.createEditor');
  assert.ok(siteHtml.includes('Core.createEditor('), 'site/index.html must mount the shared Core.createEditor');
  assert.ok(!siteHtml.includes('contenteditable'), 'site/index.html still uses a bespoke contenteditable edit; use Core.createEditor');
  assert.ok(typeof ui.createEditor === 'function', 'core must export createEditor');
  assert.ok(typeof ui.createReconciliationView === 'function', 'core must export shared reconciliation UI');
  // The reconciliation view is the vendored CodeMirror 5 MergeView (IntelliJ-style:
  // 2-pane Result|Incoming by default, 3-pane only with a true base; editable
  // Result, SVG chunk connectors carrying apply + decline) — both consumers must
  // load the vendor bundle, and the view must actually build a MergeView.
  assert.ok(coreSrc.includes('CM.MergeView(host'), 'createReconciliationView must build a CodeMirror MergeView');
  assert.ok(!/connect:\s*['"]align['"]/.test(coreSrc),
    "the merge view must NOT use connect:'align' (it disables SVG connectors and breaks scrolling with lineWrapping+collapse)");
  for (const opt of ['chunkState', 'declineChunk']) {
    assert.ok(coreSrc.includes(opt), `merge view must wire the vendored ${opt} hook`);
  }
  const vendoredMerge = read('site/shared/vendor/cm5/merge.js');
  assert.ok(vendoredMerge.includes('BOARDCLIP PATCH'), 'vendored merge.js must carry the BOARDCLIP patches (chunkState/decline/bcRedraw)');
  for (const patched of ['chunkState', 'bcDecline', 'bcRedraw']) {
    assert.ok(vendoredMerge.includes(patched), `vendored merge.js missing the ${patched} patch`);
  }
  for (const [name, html] of [['editor.html', editorHtml], ['site/index.html', siteHtml]]) {
    for (const asset of ['vendor/cm5/codemirror.js', 'vendor/cm5/diff-match-patch.js', 'vendor/cm5/merge.js', 'vendor/cm5/codemirror.css', 'vendor/cm5/merge.css']) {
      assert.ok(html.includes(asset), `${name} must load ${asset} for the shared merge view`);
    }
  }
  for (const vendored of ['codemirror.js', 'codemirror.css', 'merge.js', 'merge.css', 'diff-match-patch.js']) {
    assert.ok(fs.existsSync(path.join(root, 'site/shared/vendor/cm5', vendored)), `vendored cm5/${vendored} missing`);
  }
  assert.ok(ui.renderSettingsBody().includes('id="conflictSlots"'), 'settings should expose unresolved conflict entries');
  assert.ok(coreSrc.includes('<div class="bc-title-row" hidden>'), 'clip title input row should be hidden unless edit-title opens it');
  assert.ok(coreSrc.includes('focusTitle: () => { showTitleInput();'), 'edit-title focus path should reveal the hidden title input row');
  // Editor styles live in the shared stylesheet, not re-declared per consumer.
  const declares = (css, sel) => new RegExp(`(^|[\\s,])\\.${sel}\\s*[,{]`, 'm').test(css);
  assert.ok(declares(popupCss, 'bc-editor'), 'clipboard-popup.css should define .bc-editor');
  assert.ok(!declares(siteCss, 'bc-editor-area'), 'site/styles.css re-declares editor style (belongs in clipboard-popup.css)');
  assert.ok(popupCss.includes('.tag-submenu { display: none; position: absolute; top: 100%;'),
    'tag submenus must touch their parent so hover does not drop while moving into the menu');
  assert.ok(popupCss.includes('.gp-row > .tag-menu-node > .tag-submenu { top: -4px; left: calc(100% - 1px); }'),
    'picker submenus must overlap horizontally with their parent so hover does not drop');
}

// 11) Search bar parity: BOTH consumers render the shared shell's sort + regex
//     buttons and drive the ONE attachSearchBox enhancer + shared query engine
//     (bar text = source of truth; no bespoke filter Sets). The in-app "AI search"
//     mode (sparkle/Tab toggle, BYO-endpoint agent, offline IDF ranking) was REMOVED
//     on 2026-09-02 ("remove the shitty AI search for now, will impl better later");
//     neither consumer, the shared shell, nor the search engine may grow it back.
{
  const shell = ui.renderPopupShell({});
  for (const id of ['sortBtn', 'regexBtn']) {
    assert.ok(shell.includes(`id="${id}"`), `renderPopupShell missing the shared ${id} control`);
  }
  for (const [name, html] of [['index.html', appHtml], ['site/index.html', siteHtml]]) {
    assert.ok(html.includes('Core.attachSearchBox('), `${name} must decorate the search box via the shared Core.attachSearchBox`);
    assert.ok(!/activeFilters\s*=\s*new Set|excludedFilters\s*=\s*new Set/.test(html),
      `${name} re-introduced bespoke filter Sets; the query text is the single source of truth`);
  }
  const searchCore = read('site/shared/clip-search.js');
  const uiCore = read('site/shared/clipboard-ui-core.js');
  for (const [name, text] of [['renderPopupShell', shell], ['index.html', appHtml], ['site/index.html', siteHtml], ['clip-search.js', searchCore], ['clipboard-ui-core.js', uiCore]]) {
    assert.ok(!/aiBtn|aiStatus|ai-search|aiSearch|rankFuzzyIndexes|getAiMode|resetAiRun|runAiSearch|aiStatusText|aiRunning|aiResultIds|updateAiUi|setAiMode|searchIdf/.test(text), `${name} re-introduced a piece of the removed AI search mode`);
  }
  assert.ok(!require('fs').existsSync(require('path').join(__dirname, '..', 'lib', 'ai-search-agent.js')), 'lib/ai-search-agent.js was removed with the AI search mode');
}

// 12) In-app image viewer + context-menu parity: the viewer window mounts the
//     SHARED Core.createImageViewer, its menu is the SAME renderClipMenu the
//     popup rows use (context-aware: viewer swaps "Open image" for "Open
//     externally"; editor drops "Open in editor"), and both standalone windows
//     drive the shared controller for dispatch.
{
  const viewerHtml = read('viewer.html');
  const editorHtml = read('editor.html');
  assert.ok(typeof ui.createImageViewer === 'function', 'core must export createImageViewer');
  assert.ok(viewerHtml.includes('Core.createImageViewer('), 'viewer.html must mount the shared Core.createImageViewer');
  assert.ok(viewerHtml.includes('Core.createClipController('), 'viewer.html must drive the shared controller for its menu');
  assert.ok(editorHtml.includes('Core.createClipController('), 'editor.html must drive the shared controller for its menu');
  const declares = (css, sel) => new RegExp(`(^|[\\s,])\\.${sel}\\s*[,{]`, 'm').test(css);
  assert.ok(declares(popupCss, 'bc-viewer'), 'clipboard-popup.css should define .bc-viewer');
  const img = { id: 'img:a.png', type: 'image', image: 'a.png' };
  const popupMenu = ui.renderClipMenu(img, { items: [], groups: [], numpadMap: {} });
  for (const a of ['pin', 'open-img', 'open-img-ext', 'save-img', 'rename', 'del']) {
    assert.ok(popupMenu.includes(`data-action="${a}"`), `popup image menu missing data-action="${a}"`);
  }
  const viewerMenu = ui.renderClipMenu(img, { items: [], groups: [], numpadMap: {}, context: 'viewer' });
  // NB: the closing quote makes this exact — it does NOT match open-img-ext.
  assert.ok(!viewerMenu.includes('data-action="open-img"'), 'viewer menu must not offer "Open image" (it IS the open image)');
  for (const a of ['pin', 'open-img-ext', 'save-img', 'rename', 'del']) {
    assert.ok(viewerMenu.includes(`data-action="${a}"`), `viewer menu missing data-action="${a}"`);
  }
  const editorMenu = ui.renderClipMenu({ id: 'txt:x', type: 'text', text: 'hi' }, { items: [], groups: [], numpadMap: {}, context: 'editor' });
  assert.ok(!editorMenu.includes('data-action="edit"'), 'editor menu must not offer "Open in editor" (it IS the editor)');
  for (const a of ['pin', 'rename', 'del']) {
    assert.ok(editorMenu.includes(`data-action="${a}"`), `editor menu missing data-action="${a}"`);
  }
}

// 10) Menu-system consistency: ONE shared floating-surface rule covers the
//     in-row picker, hover submenus, and the popover menus (no per-surface
//     shadow/padding forks), and the numpad renders in real keypad formation
//     (7 8 9 / 4 5 6 / 1 2 3) from the ONE shared renderer.
{
  assert.ok(/\.numpad-picker,\s*\.tag-submenu,\s*\.bc-menu\s*\{/.test(popupCss),
    'clipboard-popup.css must define the single shared floating-surface rule (.numpad-picker, .tag-submenu, .bc-menu)');
  const surfaceForks = (popupCss.match(/box-shadow:[^;]*var\(--menu-edge\)/g) || []).length;
  assert.ok(surfaceForks <= 2, `menu surfaces re-forked their shadows (${surfaceForks} menu-edge shadows; expected the shared floating-surface rule + .dialog only)`);
  const order = (html) => [...html.matchAll(/data-n="(\d)"/g)].map((m) => Number(m[1]));
  const expected = [7, 8, 9, 4, 5, 6, 1, 2, 3];
  assert.deepStrictEqual(order(ui.renderItemPicker({ id: 'x', type: 'text', text: 'a' }, { items: [], groups: [] })), expected,
    'renderItemPicker numpad must be in keypad formation (7 8 9 / 4 5 6 / 1 2 3)');
  assert.deepStrictEqual(order(ui.renderClipMenu({ id: 'x', type: 'text', text: 'a' }, { items: [], groups: [], numpadMap: {} })), expected,
    'renderClipMenu numpad submenu must be in keypad formation');
  assert.ok(/\.np-row\s*\{[^}]*grid-template-columns:\s*repeat\(3/.test(popupCss), '.np-row must be a 3-column grid (keypad formation)');
}

// 13) Title-bar tag strip: ONE shared renderer (renderClipTagChips) + ONE
//     group-picker builder (clipGroupTreeHtml) behind BOTH the clip menu's
//     "Add to group" submenu and the strip's + popover; the strip container
//     ships inside the shared createEditor/createImageViewer chrome and every
//     host (app editor, app viewer, demo editor) drives it via setTags.
{
  const viewerHtml = read('viewer.html');
  const editorHtml = read('editor.html');
  const coreSrc = read('site/shared/clipboard-ui-core.js');
  assert.ok(typeof ui.renderClipTagChips === 'function', 'core must export renderClipTagChips');
  assert.ok(typeof ui.clipGroupTreeHtml === 'function', 'core must export clipGroupTreeHtml');
  // One picker builder: the clip menu's submenu AND the picker popover both call it.
  const treeCalls = (coreSrc.match(/clipGroupTreeHtml\(/g) || []).length;
  assert.ok(treeCalls >= 3, `clipGroupTreeHtml should back both the menu submenu and the + popover (found ${treeCalls} references)`);
  // Chips: exact filter-tag/group-tag visual, hover ×(untag) carrying the group,
  // inert body (data-strip-group, NOT the filter chips' data-group), and the +.
  const item = { id: 'txt:x', type: 'text', text: 'hi', pin: { groups: ['work', 'todo/forge'] } };
  const chips = ui.renderClipTagChips(item);
  assert.ok(chips.includes('filter-tag group-tag'), 'tag chips must reuse the filter-tag group-tag visual');
  assert.ok(chips.includes('data-strip-group="work"') && !/data-group="work"[^>]*>(?!<span class="tag-label")/.test(chips.split('gtag-x')[0]),
    'chip body must be inert (data-strip-group), never a filter-intent data-group target');
  assert.ok(chips.includes('data-action="untag"') && chips.includes('data-group="todo/forge"'), 'chip × must dispatch untag with its group');
  assert.ok(/<button class="gtag-x mi" type="button"[^>]*data-action="untag"/.test(chips), 'chip × must be a keyboard-focusable button');
  assert.ok(chips.includes('data-action="tag-add"'), 'strip must include the + (tag-add) button');
  assert.ok(ui.renderClipTagChips(null).includes('data-action="tag-add"'), 'a new note (null item) still renders the +');
  // The strip container is part of the SHARED chrome (both factories), not host markup.
  const barStrips = (coreSrc.match(/class="bc-tag-strip" data-x="tags"/g) || []).length;
  assert.strictEqual(barStrips, 2, `bc-tag-strip must appear exactly twice in core (createEditor + createImageViewer), found ${barStrips}`);
  for (const [name, html] of [['editor.html', editorHtml], ['viewer.html', viewerHtml], ['site/index.html', siteHtml]]) {
    assert.ok(html.includes('.setTags('), `${name} must drive the shared title-bar tag strip via setTags`);
    assert.ok(!html.includes('bc-tag-strip'), `${name} re-inlined the tag strip markup; it belongs to the shared chrome`);
  }
  // Commit-on-add: the hosts with a new-note flow supply ensureClipId, and the
  // controller (not the hosts) owns the untag/tag-add dispatch.
  assert.ok(editorHtml.includes('ensureClipId'), 'editor.html must supply ensureClipId (commit-on-add)');
  assert.ok(siteHtml.includes('ensureClipId'), 'site/index.html must supply ensureClipId (commit-on-add)');
  assert.ok(coreSrc.includes(`closest('[data-action="untag"]')`) || /data-action="untag"/.test(coreSrc), 'controller must own the untag dispatch');
  // Commit-on-add refreshes the strip (and replaces the + DOM node), so the
  // picker anchor must be measured before the async commit.
  const tagAddDispatch = coreSrc.indexOf("const tagAdd = t.closest('[data-action=\"tag-add\"]');");
  const tagAddAnchor = coreSrc.indexOf('const r = tagAdd.getBoundingClientRect();', tagAddDispatch);
  const ensureClip = coreSrc.indexOf('await a.ensureClipId()', tagAddDispatch);
  assert.ok(tagAddDispatch >= 0 && tagAddAnchor > tagAddDispatch && ensureClip > tagAddAnchor,
    'tag-add must capture its anchor before awaiting commit-on-add');
  const declares = (css, sel) => new RegExp(`(^|[\\s,])\\.${sel}\\s*[,{]`, 'm').test(css);
  assert.ok(declares(popupCss, 'bc-tag-strip'), 'clipboard-popup.css should define .bc-tag-strip');
}

console.log('ui-parity.test.js: all parity guards passed');
