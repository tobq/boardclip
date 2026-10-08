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
    assert.ok(html.includes('controller.onMousedown(') && html.includes('controller.onMouseup('), `${name} must route mousedown + mouseup through the controller (middle-click open without autoscroll)`);
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
  const sentinels = ['id="aiAccessEnabled"', 'id="diagnosticsEnabled"', 'id="updateBuild"', 'id="clearAll"', 'data-appearance="ui_density"'];
  const body = ui.renderSettingsBody();
  for (const sentinel of sentinels) {
    assert.ok(body.includes(sentinel), `clipboard-ui-core.js should own the settings markup (${sentinel})`);
    assert.ok(!appHtml.includes(sentinel), `index.html re-inlined settings markup (${sentinel}); use Core.renderSettingsBody()`);
    assert.ok(!siteHtml.includes(sentinel), `site/index.html re-inlined settings markup (${sentinel}); use Core.renderSettingsBody()`);
  }
}

// 4) Popup component styles live ONLY in the shared stylesheet. The app inline
//    <style> and the marketing CSS must not re-declare them (that is exactly how
//    the palettes drifted before).
{
  const popupSelectors = [
    'filter-tag', 'numpad-picker', 'np-btn', 'setting-row', 'settings-item', 'settings-list',
    'input-affix', 'accent-swatch', 'shortcut-btn', 'switch',
    // the shared canon primitives (one button family, one dialog, one overline)
    'btn', 'dialog', 'overline',
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
    // Painting goes through the shared list (which renders an off-window
    // focused row first, then calls the shared Core.applySelectionUI).
    assert.ok(/renderSelection\s*:\s*\([^)]*\)\s*=>\s*\w+\.paintSelection\(/.test(html), `${name} must paint selection via the shared clip list's paintSelection`);
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
  // The note's title is edited in place in the bar (no separate title row).
  assert.ok(!coreSrc.includes('bc-title-row') && !coreSrc.includes('bc-note-title'), 'the title row is gone: the title is the bar\'s own field');
  assert.ok(/title: barTitleField\('titleinput'/.test(coreSrc), 'the editor\'s title is the bar\'s editable field');
  assert.ok(/const focusTitle = \(\) => \{ titleInput\.focus\(\); titleInput\.select\(\); \};/.test(coreSrc), 'edit-title focuses the bar\'s title field');
  // Editor styles live in the shared stylesheet, not re-declared per consumer.
  const declares = (css, sel) => new RegExp(`(^|[\\s,])\\.${sel}\\s*[,{]`, 'm').test(css);
  assert.ok(declares(popupCss, 'bc-editor'), 'clipboard-popup.css should define .bc-editor');
  assert.ok(!declares(siteCss, 'bc-editor-area'), 'site/styles.css re-declares editor style (belongs in clipboard-popup.css)');
  assert.ok(popupCss.includes('.tag-submenu { display: none; position: absolute; top: 100%;'),
    'tag submenus must touch their parent so hover does not drop while moving into the menu');
  assert.ok(popupCss.includes('.bc-menu .tag-submenu { top: -4px; left: calc(100% - 1px);'),
    'menu and popover submenus must overlap horizontally with their parent so hover does not drop');
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
//     hover submenus and the popover menus (the clip menu, a row's keypad and
//     group popovers; no per-surface shadow/padding forks), and the numpad
//     renders in real keypad formation (7 8 9 / 4 5 6 / 1 2 3) from the ONE
//     shared renderer.
{
  assert.ok(/\.tag-submenu,\s*\.bc-menu\s*\{/.test(popupCss),
    'clipboard-popup.css must define the single shared floating-surface rule (.tag-submenu, .bc-menu)');
  const surfaceForks = (popupCss.match(/box-shadow:[^;]*var\(--menu-edge\)/g) || []).length;
  assert.strictEqual(surfaceForks, 1, `floating surfaces re-forked their shadows (${surfaceForks} menu-edge shadows; dialogs, the toast and the Newest pill ride the ONE shared rule too)`);
  const order = (html) => [...html.matchAll(/data-n="(\d)"/g)].map((m) => Number(m[1]));
  const expected = [7, 8, 9, 4, 5, 6, 1, 2, 3];
  assert.deepStrictEqual(order(ui.renderClipMenu({ id: 'x', type: 'text', text: 'a' }, { items: [], groups: [], numpadMap: {} })), expected,
    'renderClipMenu numpad submenu must be in keypad formation');
  assert.ok(/\.np-row\s*\{[^}]*grid-template-columns:\s*repeat\(3/.test(popupCss), '.np-row must be a 3-column grid (keypad formation)');
  // A row's # popover reuses the same keypad renderer inside the shared menu.
  const coreSrc = read('site/shared/clipboard-ui-core.js');
  const popover = coreSrc.slice(coreSrc.indexOf('function openNumpadPickerAt('), coreSrc.indexOf('function openNumpadPickerAt(') + 1200);
  assert.ok(/renderKeypadMenu\(item/.test(popover) && /menu\.open\(/.test(popover), "a row's keypad popover = renderKeypadMenu in the shared createMenu");
  const keypadSub = ui.renderClipMenu({ id: 'x', type: 'text', text: 'a' }, { items: [], groups: [], numpadMap: {} });
  assert.ok(/<div class="tag-submenu bc-keypad" role="menu"><div class="numpad-picker"/.test(keypadSub), "the clip menu's Numpad submenu is the same renderKeypadMenu block");
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
  // The strip container is part of the SHARED chrome (the one window bar both
  // factories render), not host markup.
  const barStrips = (coreSrc.match(/class="bc-tag-strip" data-x="tags"/g) || []).length;
  assert.strictEqual(barStrips, 1, `bc-tag-strip must appear exactly once in core (renderWindowBar), found ${barStrips}`);
  assert.ok(ui.renderWindowBar({ tags: true }).includes('class="bc-tag-strip" data-x="tags"'), 'renderWindowBar carries the tag strip');
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

// 13b) Clip windows (UI overhaul G): ONE window bar (.bc-bar, Core.renderWindowBar)
//      for the editor, the viewer and the merge view (unify + conflict); the
//      app's windows carry the OS's own window controls (one main.js helper at
//      every creation site, no page-drawn close); ONE surface per window;
//      word-level merge marks from the vendored merge.js patch.
{
  const coreSrc = read('site/shared/clipboard-ui-core.js');
  const mainSrc = read('main.js');
  const editorHtml = read('editor.html');
  const viewerHtml = read('viewer.html');
  const fnSrc = (name) => coreSrc.slice(coreSrc.indexOf(`  function ${name}(`), coreSrc.indexOf('\n  }\n', coreSrc.indexOf(`  function ${name}(`)));
  // One bar: every clip-window factory renders it, nothing else draws a bar.
  for (const name of ['createEditor', 'createImageViewer', 'createReconciliationView']) {
    assert.ok(fnSrc(name).includes('renderWindowBar({'), `${name} renders the shared .bc-bar`);
    assert.ok(/close: !o\.nativeControls/.test(fnSrc(name)), `${name}: the close button only without native window controls`);
  }
  assert.ok(!/bc-editor-bar|bc-editor-title|bc-title-opts|bc-title-use|bc-actions-stacked|bc-pending-chip/.test(coreSrc + popupCss), 'the old bar / title row / stacked footer / pending pill are gone');
  assert.strictEqual((coreSrc.match(/<div class="bc-bar">/g) || []).length, 1, 'one .bc-bar markup (renderWindowBar)');
  const bar = ui.renderWindowBar({ title: '<span class="bc-bar-title"></span>', tags: true, actions: '<button data-x="menu"></button>' });
  assert.ok(/^<div class="bc-bar"><span class="bc-bar-title"><\/span><div class="bc-tag-strip"[^>]*><\/div><span class="bc-bar-spacer"><\/span><div class="bc-bar-actions"><button data-x="menu"><\/button><\/div><\/div>$/.test(bar), 'bar anatomy: title, tags, spacer (drag region), actions');
  assert.ok(!bar.includes('data-x="close"') && ui.renderWindowBar({ close: true }).includes('<span class="mi">close</span>'), 'a close only on request (the demo overlay), as the shared mi glyph');
  // No custom close in the app's windows: every factory call there asks for native controls.
  assert.strictEqual((editorHtml.match(/nativeControls: true/g) || []).length, 2, 'editor.html: the editor AND the merge view use the native window controls');
  assert.ok(viewerHtml.includes('nativeControls: true'), 'viewer.html uses the native window controls');
  for (const [name, html, api] of [['editor.html', editorHtml, 'editorApi'], ['viewer.html', viewerHtml, 'viewerApi']]) {
    assert.ok(html.includes(`Core.attachWindowControls(init.windowControls, window.${api}.windowChrome)`), `${name} reserves the controls' room and reports the bar's colours`);
  }
  assert.ok(!/data-x="revert"/.test(fnSrc('createEditor')), 'Revert left the bar (it is the editor clip menu\'s row)');
  assert.ok(fnSrc('createEditor').includes('editorSaveState(') && coreSrc.includes("saving: 'Saving...', saved: 'Saved'") && !coreSrc.includes('Saved automatically'), 'the editor footer shows the live save state, derived by the one pure editorSaveState');
  assert.ok(!/setSaveState\('saving'\)/.test(fnSrc('createEditor')), 'no latched "Saving..." (an edit undone before the idle save must read Saved again)');
  // Save-state rules (pure): type then undo before the idle save -> Saved;
  // an emptied note is never written -> says so; a refused write sticks until the next edit.
  assert.strictEqual(ui.editorSaveState({ dirty: true, hasSaved: true }), 'saving', 'an unsaved edit reads Saving...');
  assert.strictEqual(ui.editorSaveState({ dirty: false, hasSaved: true }), 'saved', 'typed then undone before the idle save: Saved again');
  assert.strictEqual(ui.editorSaveState({ dirty: true, blank: true, hasSaved: true }), 'blank', 'emptied note: not saved, not "Saved"');
  assert.strictEqual(ui.editorSaveState({ dirty: true, failed: true, hasSaved: true }), 'failed', 'a refused write reads Not saved');
  assert.strictEqual(ui.editorSaveState({ dirty: false, inFlight: true, hasSaved: true }), 'saving', 'a write in flight reads Saving...');
  assert.strictEqual(ui.editorSaveState({ dirty: false, hasSaved: false }), '', 'a new, untouched note shows nothing');
  for (const x of ['zoomout', 'zoomin', 'fit', 'actual']) assert.ok(fnSrc('createImageViewer').includes(`data-x="${x}"`), `viewer footer zoom control ${x}`);
  assert.ok(!/drag_indicator/.test(coreSrc), 'the drag-out handle is the image proxy glyph, not a second menu-like grip');
  // main.js: ONE window-options helper at every clip-window creation site.
  for (const title of ['BoardClip - editor', 'BoardClip - image', 'BoardClip - resolve conflict', 'BoardClip - unify clips']) {
    const at = mainSrc.indexOf(`title: '${title}'`);
    const site = mainSrc.slice(mainSrc.lastIndexOf('new BrowserWindow({', at), mainSrc.indexOf('webPreferences', at));
    assert.ok(site.includes('...windowControlOptions(),'), `${title}: created with windowControlOptions()`);
    assert.ok(!/frame:\s*false|titleBarStyle|titleBarOverlay|trafficLightPosition/.test(site), `${title}: no hand-rolled frame / title-bar option`);
  }
  assert.strictEqual(mainSrc.split('...windowControlOptions(),').length - 1, 4, 'exactly the four clip windows get native controls (not the popup or the approval modal)');
  assert.ok(/function windowControlOptions\(\) \{\s*if \(process\.platform === 'darwin'\) return \{ titleBarStyle: 'hidden', trafficLightPosition:/.test(mainSrc)
    && /return \{ titleBarStyle: 'hidden', titleBarOverlay: titleBarOverlayGuess\(\) \};/.test(mainSrc), 'Windows: caption-button overlay; macOS: traffic lights');
  assert.strictEqual(mainSrc.split('windowControls: windowControlsInfo(),').length - 1, 4, 'every clip window\'s init payload says where the controls are');
  const barH = (/--bar-h:\s*(\d+)px;/.exec(read('site/shared/clipboard-tokens.css')) || [])[1];
  assert.ok(barH && mainSrc.includes(`const WINDOW_BAR_H = ${barH};`), `main's first-paint caption height follows --bar-h (${barH}px)`);
  assert.ok(/ipcMain\.on\('window-chrome', \(event, chrome\) => \{\s*applyWindowChrome\(BrowserWindow\.fromWebContents\(event\.sender\), chrome\);/.test(mainSrc), 'the page\'s colours reach setTitleBarOverlay');
  assert.ok(/w\.setTitleBarOverlay\(overlay\)/.test(mainSrc) && /w\.setWindowButtonPosition\(trafficLightPosition\(height\)\)/.test(mainSrc), 'overlay refreshed on Windows, traffic lights re-centred on macOS');
  // No page zoom under the native controls: the text clip windows swallow the
  // zoom chords in main (the popup and the viewer zoom their images instead),
  // and the bar re-reports when the scale changes anyway.
  for (const w of ['editorWin', 'conflictWin', 'unifyWin']) assert.ok(mainSrc.includes(`claimZoomKeys(${w})`), `${w}: Ctrl/Cmd+= / - / 0 claimed in main (a zoomed page slides its bar out from under the native controls)`);
  for (const w of ['win', 'viewerWin']) assert.ok(mainSrc.includes(`claimImageZoomKeys(${w})`), `${w}: the zoom chords zoom its images`);
  assert.ok(/JSON\.stringify\(\[msg, [^\n]*devicePixelRatio/.test(fnSrc('attachWindowControls')), 'attachWindowControls re-reports when the page scale changes');
  for (const [key, n] of [['editor_bounds', 1], ['merge_bounds', 2], ['viewer_bounds', 1]]) {
    assert.strictEqual(mainSrc.split(`trackWindowBounds(`).filter((s) => s.includes(`'${key}');`)).length >= n, true, `${key}: bounds tracked`);
  }
  assert.ok(/const maximized = childWin\.isMaximized\(\) \|\| childWin\.isFullScreen\(\);\s*const \{ x, y, width, height \} = maximized \? childWin\.getNormalBounds\(\) : childWin\.getBounds\(\);/.test(mainSrc), 'a maximised window saves its NORMAL bounds + the flag');
  assert.ok(/saved\.maximized !== true \|\| \(options && options\.keepPopup\)/.test(mainSrc), 'maximised state comes back only on a hand-off open (maximize() activates)');
  // ONE surface per clip window: the roots paint it, every band is transparent.
  const rule = (sel) => (popupCss.match(new RegExp(`(^|\\n)${sel.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')} \\{([^}]*)\\}`)) || [])[2] || '';
  for (const sel of ['.bc-editor', '.bc-viewer', '.bc-reconcile']) assert.ok(/background: var\(--surface\)/.test(rule(sel)), `${sel} paints the window's one surface`);
  for (const sel of ['.bc-bar', '.bc-find', '.bc-editor-foot', '.bc-merge-heads', '.bc-reconcile-actions', '.bc-editor-area-wrap']) {
    assert.ok(/background: transparent/.test(rule(sel)), `${sel} is transparent (one layer, also under glass)`);
  }
  assert.ok(/\.bc-merge-host \.CodeMirror-merge-gap \{ background: transparent; border: 0; \}/.test(popupCss), 'the merge gap has no fill and no box');
  assert.ok(!/CodeMirror-merge-pane[^{]*\{[^}]*opacity/.test(popupCss), 'no read-only pane dimming');
  assert.ok(/-connect \{ fill: var\(--green-bg\); stroke: none; \}/.test(popupCss), 'connectors: one green layer, no stroke');
  assert.ok(/\.bc-conflict-line \.CodeMirror-merge-l-inserted/.test(popupCss), 'word marks turn red inside conflicts');
  assert.ok(/\.bc-merge-host \.CodeMirror-merge-scrolllock-wrap \{ display: none; \}/.test(popupCss), 'no unicode scroll-lock glyph');
  // Merge heads: each title once (the bar's field), accepts in the pane heads, ONE footer row.
  const mergeSrc = fnSrc('createReconciliationView');
  assert.ok(mergeSrc.includes("title: barTitleField('title'") && mergeSrc.includes('data-title-pick') && mergeSrc.includes('bc-head-accept'), 'result title in the bar, title picks + accepts in the pane heads');
  assert.ok(!/fitActions|ResizeObserver/.test(mergeSrc), 'no footer-fitting measurement (one footer layout)');
  // Vendored merge.js: the BOARDCLIP word-diff + glyph patches.
  const vendored = read('site/shared/vendor/cm5/merge.js');
  for (const patch of ['function bcWordDiff(', 'function bcMarkDiff(', '"arrow_forward" : "arrow_back"', '"CodeMirror-merge-copy mi bc-decline"', 'unchanged lines', '!part[2]']) {
    assert.ok(vendored.includes(patch), `vendored merge.js missing the ${patch} patch`);
  }
  // (The editable-originals "push" button keeps its arrow: that mode is never on.)
  assert.ok(!/\\u21dd|\\u21dc|"\\u00d7"/.test(vendored.slice(vendored.indexOf('function drawConnectorsForChunk'), vendored.indexOf('if (editOriginals) {'))), 'no unicode gutter arrows');
  const README = read('site/shared/vendor/cm5/README.md');
  assert.ok(/bcWordDiff/.test(README) && /Material Symbols/.test(README), 'the vendored patches are documented');
  assert.ok(vendored.includes('diff.bcRaw = raw;') && /var raw = dv\.diff\.bcRaw;/.test(vendored) && /bcRaw/.test(README), 'the word marks reuse getDiff\'s raw diff (one diff_main per update)');
  // Heads at any width: a title pick says its full title, a narrow head drops
  // the accept's label (container query) before the pick, the first head and
  // the first pane's text start on the gutter with the bar title.
  assert.ok(mergeSrc.includes('`Use this title: ${title || \'Untitled\'}`') && mergeSrc.includes('<span class="bc-accept-label">'), 'title pick tooltip = its full title; the accept label can collapse');
  assert.ok(/\.bc-merge-head \{[^}]*container: bc-head \/ inline-size;/.test(popupCss) && /@container bc-head \(max-width: \d+px\) \{\s*\.bc-merge-head:has\(\.bc-head-title\) \.bc-accept-label \{ display: none; \}/.test(popupCss), 'a narrow head keeps the pick readable');
  assert.ok(/\.bc-merge-head:first-child \{ padding-left: var\(--gutter\); \}/.test(popupCss) && /\.CodeMirror-merge-pane:first-child \.CodeMirror pre\.CodeMirror-line,[^{]*\{ padding-left: var\(--gutter\); \}/.test(popupCss), 'one left edge: bar title, first head, first pane text');
  // A multi-step Unify's step lives in the footer (the bar's context gives way first).
  assert.ok(mergeSrc.includes('class="bc-step" data-x="step">Step ${Number(step.at)} of ${Number(step.of)}') && /step: \{ at: session\.step \+ 1, of: session\.total \}/.test(mainSrc) && /step: \{ at: step \+ 1, of: total \}/.test(siteHtml), 'unify step in the footer, app and demo');
  assert.ok(!/\bbc-chip\b/.test(popupCss + coreSrc), 'the retired .bc-chip is gone');
  // The counter's total is fixed at build (+ taken before a whitespace rebuild),
  // and a dismissal is keyed by WHAT the change is, so taking a neighbour (the
  // diff re-aligns) never re-opens it (qa-app-pentest measures both end to end).
  assert.ok(/if \(changeTotal == null\) changeTotal = info\.changes \+ takenBeforeRebuild;/.test(mergeSrc) && /\$\{total - open\} of \$\{total\} resolved/.test(mergeSrc), 'merge counter: a fixed total, resolved = total - open');
  assert.ok(/declinedKeys\.add\(declineKeyOf\(/.test(mergeSrc) && !/declinedKeys\.(has|add)\(keyOf\(/.test(mergeSrc), 'dismissals keyed by content, never by chunk coordinates');
  // bcWordDiff itself: word-level marks, line structure untouched, round-trips.
  require('../site/shared/vendor/cm5/diff-match-patch.js');
  const bcWordDiff = new Function('DIFF_EQUAL', 'DIFF_DELETE', 'DIFF_INSERT',
    `${vendored.slice(vendored.indexOf('  var BC_WORD_END'), vendored.indexOf('  function bcMarkDiff'))}\nreturn bcWordDiff;`)(0, -1, 1);
  const dmp = new globalThis.diff_match_patch();
  const side = (d, keep) => d.filter(([t]) => t === 0 || t === keep).map(([, s]) => s).join('');
  for (const [a, b] of [['on Thursday\nnext', 'on Tuesday\nnext'], ['a\nOLD line\nb', 'a\nNEW one\nb'], ['a\nb\n', 'a\nX\nb\n'], ['colour', 'color']]) {
    const w = bcWordDiff(dmp.diff_main(a, b));
    assert.ok(side(w, -1) === a && side(w, 1) === b, `bcWordDiff round-trips ${JSON.stringify([a, b])}`);
  }
  const words = bcWordDiff(dmp.diff_main('on Thursday\nnext', 'on Tuesday\nnext'));
  assert.deepStrictEqual(words.filter(([t]) => t !== 0).map(([t, s]) => [t, s]), [[-1, 'Thursday'], [1, 'Tuesday']], 'a changed word is marked whole, not as letter fragments');
  assert.ok(bcWordDiff(dmp.diff_main('a\nOLD line\nb', 'a\nNEW one\nb')).filter(([t]) => t !== 0).every((p) => p[2] === true), 'a rewritten line is flagged whole-line (wash only)');
  assert.ok(bcWordDiff(dmp.diff_main('a b', 'a  b'), true).filter(([t]) => t !== 0).every((p) => p[3] === true), 'under ignoreWhitespace a whitespace-only edit is quiet');
  assert.ok(/dmp\.diff_main\(dv\.orig\.getValue\(\), dv\.edit\.getValue\(\)\)/.test(vendored) && vendored.includes('!part[3]'), 'marks come from the raw (lossless) diff; quiet edits mark nothing');
}

// 14) Keep-your-place list + image zoom are single-sourced: both consumers
//     render rows through Core.createClipList (no per-side lazy loader or
//     innerHTML list rebuild), feed it Search.rankMode, size previews through
//     Core.createImageZoom, and route Ctrl+wheel through the controller with a
//     NON-passive listener (a passive one cannot stop the page zoom). A query
//     change goes through controller.onQueryChange, not a cursor wipe.
{
  const coreSrc = read('site/shared/clipboard-ui-core.js');
  for (const fn of ['createClipList', 'resolveListAnchor', 'createImageZoom']) {
    assert.ok(typeof ui[fn] === 'function', `core must export ${fn}`);
  }
  assert.ok(typeof ui.search.rankMode === 'function', 'clip-search must export rankMode');
  for (const [name, html] of [['index.html', appHtml], ['site/index.html', siteHtml]]) {
    assert.ok(html.includes('Core.createClipList('), `${name} must render through the shared Core.createClipList`);
    assert.ok(html.includes('Core.search.rankMode('), `${name} must tell the list its ranking mode via Search.rankMode`);
    assert.ok(html.includes('Core.createImageZoom('), `${name} must size image previews through Core.createImageZoom`);
    assert.ok(/addEventListener\(\s*["']wheel["']\s*,\s*\([^)]*\)\s*=>\s*controller\.onWheel\([^)]*\)\s*,\s*\{\s*passive:\s*false\s*\}/.test(html),
      `${name} must route wheel events to controller.onWheel with { passive: false }`);
    assert.ok(html.includes('imageZoom.bindInput(') || html.includes('Zoom.bindInput('), `${name} must bind the Settings image-height row`);
    assert.ok(!/function loadBatch\b|scrollHeight \* 0\.85/.test(html), `${name} re-inlined a lazy loader; the shared list renders rows`);
    assert.ok(!/clearSelection\(\{\s*paint:\s*false\s*\}\);\s*\n\s*(renderClips|scheduleRerenderList|updateClearControls)/.test(html),
      `${name} wipes the cursor on a query change; call controller.onQueryChange()`);
    assert.ok(html.includes('controller.onQueryChange()'), `${name} must route query changes through controller.onQueryChange`);
    // Drag-out: the shared controller routes every row drag; the host only
    // supplies how an IMAGE leaves (native file in the app, URL in the demo).
    assert.ok(/addEventListener\(\s*["']dragstart["']\s*,\s*\([^)]*\)\s*=>\s*controller\.onDragstart\(/.test(html), `${name} must route dragstart through controller.onDragstart`);
    assert.ok(/dragImages\s*:/.test(html), `${name} must supply dragImages for image rows`);
  }
  assert.ok(ui.renderSettingsBody().includes('id="imagePreviewHeight"'), 'the shared settings body must carry the image preview height row');
  assert.ok(ui.renderPopupShell({}).includes('class="list-newest"'), 'the shared shell must carry the Newest pill');
  assert.ok(coreSrc.includes('function resolveListAnchor('), 'anchor policy lives in the shared core');
}

// 14) Popup header, search field, options panel (UI overhaul B): ONE shared
//     window-drag helper on the popup header and the settings header (a click
//     focuses the search, a press-and-move past 4 px moves the window; the demo
//     has no move), never -webkit-app-region: drag there (it swallowed clicks and
//     double-click maximised); the field is flat with its buttons on the ONE
//     reveal primitive; the "?" hover popover is gone, replaced by the "tune"
//     options panel the shared attachSearchBox owns (Esc closes it first, every
//     popup open starts with it shut, its height is a per-machine setting).
{
  const coreSrc = read('site/shared/clipboard-ui-core.js');
  const mainJs = read('main.js');
  const preload = read('preload.js');
  const model = require('../lib/clipboard-model');
  const stripComments = (css) => css.replace(/\/\*[\s\S]*?\*\//g, '');
  const rules = (css) => [...stripComments(css).matchAll(/([^{}]+)\{([^{}]*)\}/g)].map((m) => ({ sel: m[1].trim(), body: m[2] }));
  assert.ok(typeof ui.attachWindowDrag === 'function', 'core must export attachWindowDrag');
  for (const [name, html] of [['index.html', appHtml], ['site/index.html', siteHtml]]) {
    assert.ok(/Core\.attachWindowDrag\([^\n]*\.sticky/.test(html), `${name} must attach the shared window drag to the popup header (.sticky)`);
    assert.ok(/Core\.attachWindowDrag\([^\n]*\.settings-hdr/.test(html), `${name} must attach the shared window drag to the settings header`);
    assert.ok(/closeSearchOptions:\s*\(\)\s*=>/.test(html), `${name} adapter must let Esc close the options panel (closeSearchOptions)`);
    assert.ok(!/(searchClear|clearSearch|sortBtn|demoSortBtn)\.classList\.toggle\(\s*["']show["']/.test(html), `${name} toggles a search button itself; the shared reveal (attachSearchBox) owns their visibility`);
    assert.ok(/Core\.paintSortButton\(/.test(html) && !/Sorted by/.test(html), `${name} paints the sort toggle through the shared Core.paintSortButton, never its own copy`);
  }
  assert.ok(/Core\.attachWindowDrag\([^\n]*move:\s*window\.api\.windowDrag/.test(appHtml), 'the app header drag moves the window through window.api.windowDrag');
  assert.ok(!/attachWindowDrag\([^\n]*move:/.test(siteHtml), 'the demo header drag has no move (a page cannot move its window)');
  assert.ok(typeof ui.paintSortButton === 'function' && !/Sorted by[^\n]*—/.test(coreSrc), 'the shared sort toggle copy has no em dash');
  assert.ok(/windowDrag:\s*\(phase, dx, dy\)\s*=>\s*ipcRenderer\.send\('window-drag'/.test(preload), 'preload exposes windowDrag over the window-drag channel');
  assert.ok(/ipcMain\.on\('window-drag'[\s\S]{0,400}BrowserWindow\.fromWebContents\(event\.sender\)[\s\S]{0,800}setBounds\(windowDragBounds\(start, x, y\)\)/.test(mainJs),
    'main moves the SENDER window from its bounds at the press');
  assert.ok(/ipcMain\.on\('window-drag', \(event, phase, dx, dy\) => \{\s*if \(phase !== 'start' && phase !== 'move' && phase !== 'end'\) return;/.test(mainJs), 'window-drag accepts only its three phases');
  assert.ok(/function windowDragBounds\(start, dx, dy\) \{[\s\S]{0,900}width: start\.width,\s*height: start\.height/.test(mainJs), 'a drag keeps the start size and clamps the target to the desktop (windowDragBounds)');
  assert.ok(/if \(phase === 'start'\) \{\s*if \(w === win\) settlePopupSlide\(\);/.test(mainJs), 'a drag that starts mid-slide settles the open slide first');
  assert.ok(/function onPopupClosed\(\) \{[\s\S]{0,300}windowDragStarts\.delete\(win\)/.test(mainJs), 'closing the popup drops a drag cut short');
  const createPopupSrc = mainJs.slice(mainJs.indexOf('function createPopup('), mainJs.indexOf('function createPopup(') + 1500);
  assert.ok(/acceptFirstMouse: true/.test(createPopupSrc), 'macOS: the popup header drags on the first press of an inactive popup (acceptFirstMouse)');
  for (const r of rules(popupCss)) {
    if (r.sel.split(/,\s*/).some((sel) => /^\.(sticky|settings-hdr)\b/.test(sel))) {
      assert.ok(!/app-region/.test(r.body), `${r.sel}: the popup and settings headers drag through Core.attachWindowDrag, never -webkit-app-region`);
    }
  }
  // Flat field: no fill, no border, a hairline underline that turns accent on focus.
  const searchRow = rules(popupCss).find((r) => r.sel === '.search-row');
  assert.ok(searchRow && /background:\s*transparent/.test(searchRow.body) && /border:\s*none/.test(searchRow.body) && /box-shadow:\s*inset 0 -1px 0 var\(--line\)/.test(searchRow.body),
    'the search field is flat: no fill, no border, a --line hairline underline');
  // The accent underline and the placeholder follow ONE focus state (the field
  // focused AND the window focused): a class attachSearchBox sets, never a bare
  // :focus-within that stays lit in an unfocused window beside "Click here...".
  assert.ok(rules(popupCss).some((r) => r.sel === '.search-row.is-focused' && /box-shadow:\s*inset 0 -1px 0 var\(--accent\)/.test(r.body)), 'the search underline turns accent while focused');
  assert.ok(!rules(popupCss).some((r) => /\.search-row:focus-within/.test(r.sel)), 'no :focus-within underline (it ignores window focus)');
  const coreText = read('site/shared/clipboard-ui-core.js');
  assert.ok(/row\.classList\.toggle\('is-focused', focusInside\)/.test(coreText) && /inputEl\.placeholder = focusInside \?/.test(coreText) && /document\.hasFocus\(\)/.test(coreText),
    'attachSearchBox sets the underline class and the placeholder from the SAME value (incl. window focus; Tab onto a field button keeps both)');
  // ONE reveal primitive (grid 0fr -> 1fr width track with both belts).
  const revealTracks = rules(popupCss).filter((r) => /grid-template-columns:\s*0fr/.test(r.body));
  assert.deepStrictEqual(revealTracks.map((r) => r.sel), ['.bc-reveal'], 'ONE reveal primitive (.bc-reveal) owns the 0fr width track');
  assert.ok(rules(popupCss).some((r) => r.sel === '.bc-reveal > *' && /min-width:\s*0/.test(r.body)), 'reveal belt 1: min-width: 0 on the track child');
  assert.ok(rules(popupCss).some((r) => r.sel.startsWith('.bc-reveal-inner') && /padding:\s*0/.test(r.body)), 'reveal belt 2: a padding-less inner wrapper');
  assert.ok(rules(popupCss).some((r) => r.sel === '.bc-reveal-inner > :first-child' && /margin-inline-start:\s*var\(--reveal-gap/.test(r.body))
    && searchRow && /gap:\s*0/.test(searchRow.body), 'a closed reveal takes 0 px: the space before it is --reveal-gap inside the track, the search row has no flex gap');
  const shell = ui.renderPopupShell({});
  for (const name of ['clear', 'sort', 'tools']) assert.ok(shell.includes(`class="bc-reveal" data-reveal="${name}"`), `the ${name} search buttons ride the shared reveal`);
  assert.ok(/id="searchOptsBtn"[^>]*aria-controls="searchOpts"/.test(shell) && shell.includes('<span class="mi">tune</span>'), 'the options toggle is the tune icon controlling the panel');
  assert.ok(/class="search-opts" id="searchOpts" aria-hidden="true" inert/.test(shell), 'the options panel renders closed (aria-hidden + inert)');
  assert.ok(/id="searchClear"[^>]*tabindex="-1"/.test(shell), 'the clear button stays out of the Tab order');
  // The syntax reference is SYNTAX_HELP, rendered in the panel; the hover popover is gone.
  for (const h of ui.search.SYNTAX_HELP) assert.ok(shell.includes(`<code>${ui.escapeHtml(h.token)}</code>`), `the options panel must list ${h.token}`);
  for (const opt of ui.search.OPTION_FACETS.flatMap((row) => row.options)) assert.ok(shell.includes(`>${ui.escapeHtml(opt.label)}</button>`), `the options panel must offer ${opt.label}`);
  for (const [name, text] of [['clipboard-ui-core.js', coreSrc], ['clipboard-popup.css', popupCss], ['index.html', appHtml], ['site/index.html', siteHtml], ['renderPopupShell', shell]]) {
    assert.ok(!/attachSearchHelp|renderSearchHelp|search-help|help-btn|searchHelpBtn/.test(text), `${name} still carries the removed "?" search help popover`);
  }
  // Esc closes the panel before anything else; every popup open starts with it shut.
  assert.ok(/event\.key === 'Escape'\) \{\s*\n\s*if \(a\.closeSearchOptions && a\.closeSearchOptions\(\)\) return;/.test(coreSrc), 'controller: Esc closes the options panel first');
  assert.ok(/window\.resetPopupState = function\(\) \{[\s\S]{0,600}searchBox\.closeOptions\(\{ instant: true \}\)/.test(appHtml), 'resetPopupState closes the options panel');
  // The panel height: per machine, like image_preview_height (never synced, clamped, a local-only save).
  assert.strictEqual(model.DEFAULT_SETTINGS.options_panel_height, 0, 'options_panel_height defaults to 0 (= the default share)');
  assert.ok(/LOCAL_ONLY_SETTING_KEYS = new Set\(\[[^\]]*'options_panel_height'/.test(mainJs), 'options_panel_height is a local-only save');
  assert.ok(mainJs.includes('delete remoteSave.options_panel_height;'), 'options_panel_height must stay out of synced settings');
  assert.ok(/body\.options_panel_height[\s\S]{0,240}Math\.min\(2000, Math\.max\(80, px\)\)/.test(mainJs), 'save-settings clamps options_panel_height');
  assert.ok(/saveOptionsHeight:\s*\(px\)\s*=>\s*window\.api\.saveSettings\(\{ options_panel_height: px \}\)/.test(appHtml), 'the app saves the panel height as options_panel_height');
  assert.ok(/searchBox\.setOptionsHeight\(s\.options_panel_height\)/.test(appHtml), 'the app restores the saved panel height');
  assert.ok(/saveOptionsHeight:[^\n]*localStorage/.test(siteHtml), 'the demo keeps the panel height in localStorage');
  // The scroll fade (Forge's useScrollFade): a fade only on an edge with hidden content.
  const sizes = ui.FADE_PRESETS.box;
  assert.deepStrictEqual(ui.resolveFadeVars({ scrollTop: 0, clientHeight: 100, scrollHeight: 100 }, sizes), { top: 0, bottom: 0 }, 'no overflow, no fade');
  assert.deepStrictEqual(ui.resolveFadeVars({ scrollTop: 0, clientHeight: 100, scrollHeight: 300 }, sizes), { top: 0, bottom: 24 }, 'at the top: bottom fade only');
  assert.deepStrictEqual(ui.resolveFadeVars({ scrollTop: 50, clientHeight: 100, scrollHeight: 300 }, sizes), { top: 24, bottom: 24 }, 'mid-scroll: both edges');
  assert.deepStrictEqual(ui.resolveFadeVars({ scrollTop: 200, clientHeight: 100, scrollHeight: 300 }, sizes), { top: 24, bottom: 0 }, 'at the end: top fade only');
  assert.ok(rules(popupCss).some((r) => r.sel === '.bc-scroll-fade' && /mask-image:/.test(r.body) && /var\(--fade-top\)/.test(r.body) && /var\(--fade-bottom\)/.test(r.body)), 'the ONE .bc-scroll-fade mask');
  assert.ok(/@property --fade-top/.test(popupCss) && /@property --fade-bottom/.test(popupCss), 'the fade edges are @property-registered so they animate');
}

// 15) Rows (UI overhaul D / D2): ONE row anatomy from the shared renderer, the
//     star only pins (its hover picker is gone), a text row's buttons ride the
//     shared reveal and an image row's float over the picture, the meta line's
//     ghost # / + open the keypad / group popovers, a filter chip never deletes
//     a group, the selection bar takes the chip bar's place, the empty states
//     and the similar-clip highlight come from the shared core for app + demo.
{
  const coreSrc = read('site/shared/clipboard-ui-core.js');
  const stripComments = (css) => css.replace(/\/\*[\s\S]*?\*\//g, '');
  const rules = (css) => [...stripComments(css).matchAll(/([^{}]+)\{([^{}]*)\}/g)].map((m) => ({ sel: m[1].trim(), body: m[2] }));
  const row = (item) => ui.renderClipItem({ ts: 1, ...item }, { actionsHtml: ui.renderClipActions(item), imageSrc: () => 'x.png' });
  // Anatomy: real title (strong) + the whole text as the dim preview, minus a
  // first line that only repeats the title (it is not shown twice).
  const titled = row({ id: 't', type: 'text', title: 'Launch plan', text: '\nLaunch Plan \n1. Freeze' });
  assert.ok(/<div class="clip-title">Launch plan<\/div>\s*<div class="preview collapsed">1\. Freeze<\/div>/.test(titled), 'a titled row whose first line is the title: title + the rest');
  const retitled = row({ id: 't2', type: 'text', title: 'Release', text: 'Launch plan\n1. Freeze' });
  assert.ok(/<div class="clip-title">Release<\/div>\s*<div class="preview collapsed">Launch plan 1\. Freeze<\/div>/.test(retitled), 'a titled row: title line + the text as the preview');
  assert.ok(!row({ id: 't3', type: 'text', title: 'Just this', text: 'just this' }).includes('class="preview'), 'a text that IS its title has no preview line');
  // Untitled: the first non-empty line is the primary line, the rest the preview.
  const untitled = row({ id: 'u', type: 'text', text: '\n\n  First line\nsecond\nthird' });
  assert.ok(/<div class="clip-title derived">First line<\/div>\s*<div class="preview collapsed">second third<\/div>/.test(untitled), 'an untitled row: its first line (derived) + the rest');
  const single = row({ id: 's', type: 'text', text: 'just one line' });
  assert.ok(single.includes('<div class="clip-title derived">just one line</div>') && !single.includes('class="preview'), 'a single-line untitled row has no preview line');
  const hl = ui.renderClipItem({ id: 'h', type: 'text', ts: 1, text: 'alpha beta\ngamma delta' }, { query: 'gamma', actionsHtml: '' });
  assert.ok(hl.includes('<mark>gamma</mark>'), 'search highlighting reaches the preview part');
  assert.ok(ui.renderClipItem({ id: 'h', type: 'text', ts: 1, text: 'alpha beta\ngamma' }, { query: 'beta' }).includes('alpha <mark>beta</mark>'), 'and the derived primary line');
  assert.ok(rules(popupCss).some((r) => r.sel === '.clip-title.derived' && /font-weight:\s*var\(--fw-regular\)/.test(r.body)), 'the derived line is the regular weight');
  // Each part is a one-line window around the match (a long line lays out only
  // what a row can show, with the match on screen), never the whole text.
  const long = `${'x'.repeat(3000)}NEEDLE${'y'.repeat(3000)}\n${'z'.repeat(2000)}`;
  const parts = ui.clipRowText({ type: 'text', text: long }, { query: 'needle', matchIndex: 3000 });
  assert.ok(parts.derived && parts.primary.length <= 330 && parts.primary.indexOf('NEEDLE') >= 0 && parts.primary.indexOf('NEEDLE') < 40, 'the derived line windows onto the match');
  assert.ok(parts.rest.length <= 330 && /^z+\.\.\.$/.test(parts.rest), 'the rest is a bounded window too');
  // The first line's end is looked for within ROW_LINE_SCAN chars only: a huge
  // one-line clip (minified JSON, base64) is never scanned whole per render.
  const oneLine = ui.clipRowText({ type: 'text', text: `${'w'.repeat(70000)}\nsecond` }, {});
  assert.ok(oneLine.derived && /^w+\.\.\.$/.test(oneLine.primary) && oneLine.primary.length <= 330 && oneLine.rest === '', 'no newline within the scan: the rest counts as the first line');
  assert.ok(rules(popupCss).some((r) => r.sel === '.preview' && /color:\s*var\(--text-dim\)/.test(r.body) && /var\(--font-mono\)/.test(r.body)), 'the preview is dim mono');
  // The star only pins: no hover picker anywhere.
  assert.ok(!('renderItemPicker' in ui) && !/renderItemPicker|pickerHtml/.test(coreSrc + appHtml + siteHtml), 'the star hover picker (renderItemPicker / pickerHtml) is gone');
  assert.ok(!/\.pin-area:hover|\.gp-row/.test(stripComments(popupCss)), 'no CSS for the star hover picker');
  assert.ok(/<div class="pin-area">\s*<button class="star"[^>]*data-action="pin"[^>]*>[\s\S]*?<\/button>\s*<\/div>/.test(single), 'the pin area holds only the star');
  // Meta line: badge + tags as text + the hover ghosts on the reveal.
  const meta = row({ id: 'm', type: 'text', text: 'body text here', pin: { number: 3, groups: ['Work'] } });
  assert.ok(/data-action="numpad-open"[^>]*>#3<\/button>/.test(meta) && /class="meta-tag" type="button" data-group="Work"/.test(meta), 'meta: #N badge + group names as text');
  assert.ok(/<span class="bc-reveal meta-reveal"><span class="bc-reveal-inner"><button class="meta-ghost"[^>]*data-action="tag-add"/.test(meta), 'meta: a set key has no ghost # (the badge opens the keypad); the + rides the reveal');
  assert.ok(/class="meta-ghost"[^>]*data-action="numpad-open"/.test(single), 'meta: an unset key shows the ghost # on the reveal');
  assert.ok(/\.meta \{[^}]*white-space:\s*nowrap/.test(stripComments(popupCss)) && /\.meta \{[^}]*height:\s*var\(--meta-h\)/.test(stripComments(popupCss)), 'the meta line is one fixed-height line (the ghosts never wrap it)');
  assert.ok(/\[data-action="numpad-open"\][\s\S]{0,300}openNumpadPickerAt\(/.test(coreSrc), 'the badge / ghost # opens the keypad popover');
  // Row buttons: text rows on the reveal, image rows floating over the picture.
  assert.ok(/<span class="bc-reveal row-actions"><span class="bc-reveal-inner">[^]*data-action="clip-menu"/.test(titled), "a text row's buttons ride the shared reveal");
  const image = row({ id: 'i', type: 'image', image: 'a.png', width: 400, height: 100 });
  assert.ok(/<span class="preview-img"[^>]*><img [^>]*><span class="img-actions-anchor"><span class="img-actions">[^]*data-action="open-img"/.test(image) && !image.includes('row-actions'),
    "an image row's buttons float over the picture (no actions column)");
  for (const want of ['.item:hover .bc-reveal.row-actions', '.item:focus-within .bc-reveal.row-actions', '.item.actions-held .bc-reveal.row-actions']) {
    assert.ok(rules(popupCss).some((r) => r.sel.split(/,\s*/).includes(want) && /grid-template-columns:\s*1fr/.test(r.body)), `row buttons open on ${want}`);
  }
  assert.ok(rules(popupCss).some((r) => r.sel === '.img-actions' && /backdrop-filter/.test(r.body) && /var\(--menu\)/.test(r.body)), 'the image chip is frosted, on the opaque menu colour');
  assert.ok(/el\.classList\.toggle\('actions-held', id === state\.heldId\)/.test(coreSrc) && /onClose: releaseOnClose\(id\)/.test(coreSrc), "a row's buttons are held while its menu is open");
  assert.ok(/holdWhileDragging\(row\.dataset\.id\)/.test(coreSrc), "and while it is dragged");
  // Closing a mouse-opened row menu / popover (Esc, a scroll) hands focus back
  // to the search field, so the opener's leftover focus (:focus-within) does not
  // keep the row's buttons out; a keyboard-opened one leaves focus where Tab put it.
  assert.ok(/function releaseOnClose\(id\)[\s\S]{0,700}opener\.matches\(':focus-visible'\)[\s\S]{0,500}a\.focusSearch\(\)/.test(coreSrc), 'a closed row menu does not leave the row held by focus');
  // A consumer that rewrites the search text (clear X, a chip) closes a
  // suggestion list built for the old text (it covered the chip bar).
  assert.ok(/function refresh\(\) \{\s*if \(suggestOpen && inputEl\.value !== suggestFor\) closeSuggest\(\);/.test(coreSrc), 'searchBox.refresh() closes a stale suggestion list');
  // Chips: one renderer, and a filter chip never deletes a group.
  const bar = ui.renderFilterBar({ items: [{ id: 'x', type: 'text', text: 'a', pin: { groups: ['Work'] } }], groups: ['Work'], activeFilters: new Set(['Work']), query: 'group:Work' });
  assert.ok(!/delete-group|gtag-x/.test(bar) && !/data-action="delete-group"/.test(coreSrc), 'no hover x that deletes a group on a filter chip');
  assert.ok(/class="filter-tag group-tag active"/.test(bar), 'an active group chip');
  assert.ok((coreSrc.match(/renderChip\(\{/g) || []).length >= 3, 'the chip bar (icon facets + group chips) and the options panel chips share renderChip');
  assert.ok(rules(popupCss).some((r) => r.sel.split(/,\s*/).includes('.filter-tag.active') && /var\(--accent-bg\)/.test(r.body) && /color:\s*var\(--accent-text\)/.test(r.body)), 'active chip = the accent tint, its label in the accent text shade');
  assert.ok(!rules(popupCss).some((r) => /\.filter-tag\.group-tag$/.test(r.sel) && /--accent/.test(r.body)), 'idle group chips are text colours, never accent');
  assert.ok(!/borders="borderless"\][^{]*\.filter-tag/.test(popupCss), 'no filled-chip variant');
  // Selection bar in the chip bar's place, at its height.
  const shell = ui.renderPopupShell({});
  assert.ok(/<div class="chip-row">\s*<div class="group-filters"[^>]*><\/div>\s*<div class="selection-bar hidden"/.test(shell), 'the selection bar shares the chip row');
  assert.ok(rules(popupCss).some((r) => r.sel === '.chip-row:has(> .selection-bar:not(.hidden)) > .group-filters' && /visibility:\s*hidden/.test(r.body)), 'the chips step aside while selecting');
  assert.ok(rules(popupCss).some((r) => /\.chip-row > \.group-filters, \.chip-row > \.selection-bar/.test(r.sel) && /grid-area:\s*1 \/ 1/.test(r.body)), 'both in one grid cell: no height change');
  const selBar = rules(popupCss).find((r) => r.sel === '.selection-bar');
  assert.ok(selBar && !/background|border/.test(selBar.body), 'no tinted band, no border');
  // Empty states: ONE renderer, both consumers.
  for (const [name, html] of [['index.html', appHtml], ['site/index.html', siteHtml]]) {
    assert.ok(/emptyHtml:\s*\(\)\s*=>\s*Core\.renderEmptyState\(/.test(html), `${name} renders the shared empty states`);
    assert.ok(!/class="empty"/.test(html), `${name} still builds its own empty markup`);
    // Similar highlight: the controller owns it; the host routes hover to it.
    assert.ok(/["']mouseover["'],\s*\([^)]*\)\s*=>\s*controller\.onMouseover\(/.test(html) && /["']mouseout["'],\s*\([^)]*\)\s*=>\s*controller\.onMouseout\(/.test(html), `${name} routes hover to the shared controller (similar clips)`);
    assert.ok(/selection:\s*controller \? controller\.selection\(\) : null/.test(html), `${name} paints rows from the controller's selection state (cursor, checked, held, similar)`);
  }
  for (const kind of ['no-clips', 'no-match', 'filtered', 'empty-group']) assert.ok(ui.renderEmptyState({ kind }).includes(`data-empty="${kind}"`), `empty state ${kind}`);
  assert.strictEqual(ui.emptyStateKind({ total: 0, query: 'x' }), 'no-clips');
  assert.strictEqual(ui.emptyStateKind({ total: 5, query: 'zzz' }), 'no-match');
  assert.strictEqual(ui.emptyStateKind({ total: 5, query: 'group:Work' }), 'empty-group');
  assert.strictEqual(ui.emptyStateKind({ total: 5, query: 'is:pinned since:7d' }), 'filtered');
  assert.ok(ui.renderEmptyState({ total: 5, query: 'zzz' }).includes('data-action="clear-search-filters"'), 'a no-match state offers the way out');
  assert.ok(ui.renderEmptyState({ kind: 'no-match', nudgeHtml: '<b>n</b>' }).includes('<div class="empty-nudge"><b>n</b></div>'), 'the nudge slot is there for the search work');
  // Similar rows: a neutral wash + a dim dotted edge, never the selection hue
  // (the cursor / checked rows own --accent-bg), and a pin edge wins over it.
  const similarRule = rules(popupCss).find((r) => r.sel === '.item.similar');
  assert.ok(similarRule && /var\(--hover\)/.test(similarRule.body) && !/--accent/.test(similarRule.body) && /--row-edge:[^;]*var\(--text-dim\)/.test(similarRule.body), 'similar rows: a neutral wash + dim edge, no accent');
  const cssRules = rules(popupCss);
  assert.ok(cssRules.findIndex((r) => r.sel === '.item.similar') < cssRules.findIndex((r) => r.sel === '.item.has-pin'), 'the pin edge wins over the similar edge (later rule)');
  // Meta line: group names whole or not at all (a wrapping, clipped box), never fragments.
  assert.ok(/<span class="meta-tags"><button class="meta-tag"/.test(meta), 'meta: group names sit in one .meta-tags box');
  const tagsRule = cssRules.find((r) => r.sel === '.meta-tags');
  assert.ok(tagsRule && /flex-wrap:\s*wrap/.test(tagsRule.body) && /height:\s*var\(--meta-h\)/.test(tagsRule.body) && /overflow:\s*hidden/.test(tagsRule.body), 'a name that does not fit wraps out of the one-line box whole');
  // The chip cell keeps a populated chip bar's height even when no chip exists,
  // so the selection bar never pushes the list down.
  const chipRow = cssRules.find((r) => r.sel === '.chip-row');
  assert.ok(chipRow && /min-height:\s*max\(var\(--ctl-md\),\s*calc\(var\(--ctl-sm\) \+ 2 \* var\(--sp-1\)\)\)/.test(chipRow.body), 'the chip row reserves the bar height when the chip bar is empty');
}

// 16) Menus, pickers, dialogs, approval (UI overhaul E): ONE menu row type
//     (.bc-menu-item) behind every menu, submenu, group checklist and "New
//     group..."; membership is the accent check glyph (a dash for "some"),
//     never a colour fill; createMenu owns the keyboard; destructive dialogs
//     never confirm on a bare Enter; the approval prompt never allows on Enter
//     and never takes focus.
{
  const coreSrc = read('site/shared/clipboard-ui-core.js');
  const approvalHtml = read('mcp-approval.html');
  const mainSrc = read('main.js');
  const rules = (css) => [...css.replace(/\/\*[\s\S]*?\*\//g, '').matchAll(/([^{}]+)\{([^{}]*)\}/g)].map((m) => ({ sel: m[1].trim(), body: m[2] }));
  // One row type: the old .gp-btn row (and its fills) is gone everywhere.
  for (const [name, src] of [['clipboard-ui-core.js', coreSrc], ['clipboard-popup.css', popupCss], ['index.html', appHtml], ['site/index.html', siteHtml]]) {
    assert.ok(!/gp-btn/.test(src), `${name} still uses the retired .gp-btn row`);
  }
  assert.ok(!/\.(assigned|available|partial)\b/.test(popupCss), 'no membership colour states in the shared sheet');
  const work = { id: 'txt:w', type: 'text', text: 'w', pin: { groups: ['Work'], number: 4 } };
  const surfaces = {
    clipMenu: ui.renderClipMenu(work, { items: [work], groups: ['Work', 'AI', 'Work/Clients'] }),
    bulkMenu: ui.renderBulkMenu({ count: 2, hasImage: false }, { groups: ['Work', 'AI'], selectedItems: [work, { id: 'txt:o', type: 'text', text: 'o' }] }),
    groupPicker: ui.clipGroupTreeHtml(['Work', 'AI'], work),
    bulkGroups: ui.bulkGroupTreeHtml(['Work', 'AI'], [work]),
    keypad: ui.renderKeypadMenu(work, [work], ui.numpadMap([work])),
  };
  for (const [name, html] of Object.entries(surfaces)) {
    // Every clickable row is a .bc-menu-item <button> with an icon column; the
    // only other menu items are the keypad's keys.
    for (const m of html.matchAll(/<(\w+)[^>]*role="(menuitem\w*)"[^>]*>/g)) {
      assert.ok(m[1] === 'button' && (/class="bc-menu-item/.test(m[0]) || /class="np-btn/.test(m[0])), `${name}: menu item is not the shared row: ${m[0]}`);
    }
    for (const m of html.matchAll(/<button class="bc-menu-item[^>]*>(.*?)<\/button>/g)) {
      assert.ok(/^<span class="mi[ "]/.test(m[1]), `${name}: a row without the icon column: ${m[0].slice(0, 120)}`);
    }
  }
  // "New group..." is a normal row (icon column + label), after a separator.
  for (const name of ['clipMenu', 'bulkMenu', 'groupPicker', 'bulkGroups']) {
    assert.ok(/<div class="bc-menu-sep" role="separator"><\/div><button class="bc-menu-item"[^>]*data-action="(bulk-)?add-group"><span class="mi" aria-hidden="true">add<\/span><span class="bc-menu-label">New group\.\.\.<\/span>/.test(surfaces[name]), `${name}: "New group..." must be a normal row after a separator`);
  }
  assert.ok(!/<div class="bc-menu-sep"/.test(ui.clipGroupTreeHtml([], { id: 'x', type: 'text', text: 'x' })), 'no separator above "New group..." when there are no groups');
  // Membership: check glyph + aria-checked; labels never coloured by state.
  assert.ok(/data-group="Work" aria-checked="true"[^>]*><span class="mi bc-menu-check" aria-hidden="true">check<\/span>/.test(surfaces.groupPicker), 'a member group carries the check glyph');
  assert.ok(/data-group="AI" aria-checked="false"[^>]*><span class="mi bc-menu-check" aria-hidden="true"><\/span>/.test(surfaces.groupPicker), 'a non-member group has an empty icon column');
  assert.ok(/data-group="Work" aria-checked="mixed"[^>]*><span class="mi bc-menu-check" aria-hidden="true">remove<\/span>/.test(ui.bulkGroupTreeHtml(['Work'], [work, { id: 'txt:o', type: 'text', text: 'o' }])), 'bulk "some" = the dash glyph, aria-checked mixed');
  assert.ok(rules(popupCss).some((r) => r.sel === '.bc-menu-item > .bc-menu-check' && /color:\s*var\(--accent\)/.test(r.body)), 'the membership glyph is the accent');
  // Group rows with child tags open a submenu (aria-haspopup) and still toggle.
  assert.ok(/data-action="toggle-group" data-group="Work" aria-checked="true" title="Work" aria-haspopup="menu"/.test(surfaces.clipMenu), 'a parent tag row toggles and opens its children');
  // Keypad: neutral keys, the clip's own key in the accent, a taken key a dot.
  assert.ok(/class="np-btn current"[^>]*aria-checked="true"[^>]*data-n="4"/.test(surfaces.keypad) && /data-action="numpad-unassign" data-slot="4"/.test(surfaces.keypad), 'keypad: the current key is checked, and it can be removed');
  const npRules = rules(popupCss).filter((r) => /\.np-btn/.test(r.sel));
  assert.ok(npRules.some((r) => r.sel === '.np-btn' && /background: var\(--ctl-fill\)/.test(r.body) && /color: var\(--text\)/.test(r.body)), 'keys are neutral (--text on --ctl-fill)');
  assert.ok(npRules.some((r) => r.sel === '.np-btn.current' && /var\(--accent-bg\)/.test(r.body) && /color: var\(--accent-text\)/.test(r.body)), 'the current key is the accent (its digit in the accent text shade)');
  assert.ok(!npRules.some((r) => /--green|--line-strong/.test(r.body)) && !/\.np-btn\.free\s*\{/.test(popupCss), 'no green / link-coloured / line-dependent key states');
  // Distinct glyphs for the image menu's open / open externally / save.
  const imgMenu = ui.renderClipMenu({ id: 'img:a.png', type: 'image', image: 'a.png' }, { items: [], groups: [] });
  const glyph = (action) => (new RegExp(`data-action="${action}"[^>]*><span class="mi" aria-hidden="true">([a-z_]+)<`).exec(imgMenu) || [])[1];
  const glyphs = ['open-img', 'open-img-ext', 'save-img'].map(glyph);
  assert.ok(glyphs.every(Boolean) && new Set(glyphs).size === 3, `image menu actions need distinct glyphs: ${glyphs}`);
  // One rename wording (dialog-opening rows end with "..."); Revert is in the editor menu.
  for (const ctx of ['popup', 'editor', 'viewer']) {
    for (const it of [work, { id: 'img:a.png', type: 'image', image: 'a.png' }]) {
      assert.ok(/<span class="bc-menu-label">Rename\.\.\.<\/span>/.test(ui.renderClipMenu(it, { items: [], groups: [], context: ctx })), `${ctx} menu: "Rename..."`);
    }
  }
  assert.ok(/data-action="revert"/.test(ui.renderClipMenu(work, { items: [], groups: [], context: 'editor' })) && !/data-action="revert"/.test(surfaces.clipMenu), 'Revert is an editor-menu row only');
  assert.ok(read('editor.html').includes('revertClip:') && /t\.closest\('\[data-action="revert"\]'\)/.test(coreSrc) && /a\.revertClip\(/.test(coreSrc), 'the editor wires the menu Revert to its own revert');
  // Keyboard: createMenu handles the keys (pure model unit-tested here).
  const createMenuSrc = coreSrc.slice(coreSrc.indexOf('function createMenu('), coreSrc.indexOf('function fitSubmenu('));
  for (const key of ['ArrowDown', 'ArrowUp', 'ArrowLeft', 'ArrowRight', 'Home', 'End', 'Enter', 'Escape', 'Tab']) {
    assert.ok(createMenuSrc.includes(`'${key}'`), `createMenu must handle ${key}`);
  }
  assert.ok(/back\.focus\(/.test(createMenuSrc) && /role', 'menu'/.test(createMenuSrc), 'createMenu returns focus to the opener and is a role=menu');
  const off = (set) => (i) => set.includes(i);
  assert.strictEqual(ui.menuNavIndex(4, -1, 'ArrowDown'), 0, 'Down from nothing = first');
  assert.strictEqual(ui.menuNavIndex(4, -1, 'ArrowUp'), 3, 'Up from nothing = last');
  assert.strictEqual(ui.menuNavIndex(4, 3, 'ArrowDown'), 0, 'Down wraps');
  assert.strictEqual(ui.menuNavIndex(4, 0, 'ArrowDown', off([1, 2])), 3, 'Down skips disabled rows');
  assert.strictEqual(ui.menuNavIndex(4, 3, 'ArrowUp', off([2])), 1, 'Up skips disabled rows');
  assert.strictEqual(ui.menuNavIndex(4, 2, 'Home', off([0])), 1, 'Home = first enabled');
  assert.strictEqual(ui.menuNavIndex(4, 0, 'End', off([3])), 2, 'End = last enabled');
  assert.strictEqual(ui.menuNavIndex(3, 0, 'ArrowDown', off([0, 1, 2])), -1, 'nothing enabled = nothing');
  assert.deepStrictEqual([0, 4, 8].map((p) => ui.keypadStep(p, 'ArrowRight')), [1, 5, null], 'keypad Right');
  assert.deepStrictEqual([0, 4, 6].map((p) => ui.keypadStep(p, 'ArrowLeft')), ['left', 3, 'left'], 'keypad Left (the left edge closes a submenu)');
  assert.deepStrictEqual([1, 4, 7].map((p) => ui.keypadStep(p, 'ArrowDown')), [4, 7, 'down'], 'keypad Down');
  assert.deepStrictEqual([1, 4].map((p) => ui.keypadStep(p, 'ArrowUp')), ['up', 1], 'keypad Up');
  // The menu key / Shift+F10 opens the cursor row's menu from the keyboard.
  assert.ok(/event\.key === 'ContextMenu' \|\| \(event\.key === 'F10' && event\.shiftKey/.test(coreSrc), 'controller opens the row menu from the keyboard');
  // Dialogs: Cancel then confirm; a destructive confirm never runs on a bare
  // Enter (it opens on Cancel); Esc cancels.
  const dialogsSrc = coreSrc.slice(coreSrc.indexOf('function createDialogs('), coreSrc.indexOf('function confirm(opts)'));
  assert.ok(/<button type="button" class="btn" data-x="no"><\/button><button type="button" class="btn primary" data-x="yes">/.test(dialogsSrc), 'dialog buttons: Cancel, then the confirm');
  assert.ok(/if \(!danger\) onYes\(\);/.test(dialogsSrc) && /e\.key === 'Escape'\) \{[^}]*onNo\(\)/.test(dialogsSrc), 'Enter confirms only a non-destructive dialog; Esc cancels');
  assert.ok(/q\(confirmEl, o\.danger \? 'no' : 'yes'\), !!o\.danger\)/.test(coreSrc), 'a destructive confirm opens with Cancel focused');
  // Approval: Enter / Esc deny, allowing takes a click or Ctrl/Cmd+Enter, the
  // allow buttons arm after a delay, and the window never takes focus.
  assert.ok(/<script src="site\/shared\/clipboard-ui-core\.js"><\/script>/.test(approvalHtml) && /const Core = window\.BoardClipCore;/.test(approvalHtml), 'approval: loads the shared core and binds Core (its applyLook throws without it, and a throwing IPC listener starves the next one)');
  const keyHandler = approvalHtml.slice(approvalHtml.indexOf("window.addEventListener('keydown'"), approvalHtml.indexOf("window.addEventListener('keyup'"));
  assert.ok(/e\.key === 'Escape'\) \{[^}]*decide\('deny'\)/.test(keyHandler), 'approval: Esc denies');
  assert.ok(/if \(\(e\.ctrlKey \|\| e\.metaKey\) && !e\.altKey && !e\.shiftKey\) decide\('once'\);\s*else decide\('deny'\);/.test(keyHandler), 'approval: Enter denies; only Ctrl/Cmd+Enter allows once');
  assert.ok(!/decide\('(session|always)'\)/.test(keyHandler), 'approval: no key ever allows for the session / always');
  assert.ok(/\}, true\);/.test(keyHandler), 'approval: the key handler runs in the capture phase (a focused Allow never sees Enter first)');
  assert.ok(/if \(choice !== 'deny' && choice !== 'timeout' && !armed\(\)\) return;/.test(approvalHtml), 'approval: allow is ignored until the buttons arm');
  assert.ok(/class="btn" id="deny"[\s\S]{0,120}class="btn primary" id="allowOnce"/.test(approvalHtml), 'approval: one action row, [Deny] [Allow once]');
  assert.ok(/class="btn quiet sm" id="allowSession"/.test(approvalHtml) && /class="btn quiet sm" id="allowAlways"/.test(approvalHtml), 'approval: session / always are quiet secondary options');
  const approvalFn = mainSrc.slice(mainSrc.indexOf('function requestApproval('), mainSrc.indexOf('function buildApprovalRequest('));
  assert.ok(/ready-to-show', \(\) => \{ try \{ presentSecondaryWindow\(modal, \{ keepPopup: true \}\); \} catch \{\} \}\)/.test(approvalFn), 'approval is shown inactive (presentSecondaryWindow keepPopup = showInactive)');
  assert.ok(!/modal\.(show|focus)\(\)/.test(approvalFn), 'approval never calls show()/focus() (focus stealing)');
  assert.ok(/acceptFirstMouse: true/.test(approvalFn), 'macOS: the first click on the inactive prompt reaches it');
}

// 30) Search behaviour from Forge (phase 4), ONE implementation for the app and
//     the demo: availability-greyed chips are inert, one hint line, a ghost in
//     the mirror, suggest rows are menu rows, the census + nudge + setQuery are
//     wired on BOTH sides.
{
  const coreSrc = read('site/shared/clipboard-ui-core.js');
  const strip = (css) => css.replace(/\/\*[\s\S]*?\*\//g, '');
  const rules = (css) => [...strip(css).matchAll(/([^{}]+)\{([^{}]*)\}/g)].map((m) => ({ sel: m[1].trim(), body: m[2] }));
  // Disabled chips: inert to click AND right-click (the controller), panel chips
  // are disabled buttons whose contextmenu is swallowed too.
  assert.ok(/ftag && ftag\.getAttribute\('aria-disabled'\) === 'true'\) \{ event\.stopPropagation\(\); return true; \}/.test(coreSrc), 'a greyed chip-bar chip ignores clicks');
  assert.ok(/if \(ftag\.getAttribute\('aria-disabled'\) === 'true'\) return true;/.test(coreSrc), 'a greyed chip-bar chip ignores right-clicks');
  assert.ok(/closest\('\.facet-opt:disabled'\)\) \{ e\.preventDefault\(\); e\.stopPropagation\(\); return; \}/.test(coreSrc), 'a greyed panel chip ignores right-clicks');
  const census = ui.search.facetCensus([ui.search.clipToDoc({ id: 'txt:a', type: 'text', text: 'hello', ts: 1 })], ui.search.parseQuery('is:text'), {});
  const bar = ui.renderFilterBar({ items: [], groups: ['Nope'], query: 'is:text', census });
  assert.ok(/class="filter-tag group-tag[^"]*is-disabled[^"]*"[^>]*aria-disabled="true"/.test(bar), 'the chip bar greys a group with nothing behind it (aria-disabled, inert)');
  assert.ok(/title="Nope - No clips in this group yet"/.test(bar), 'the greyed chip says why in its tooltip');
  assert.ok(!/is-disabled/.test(ui.renderFilterBar({ items: [], groups: ['Nope'], query: '', census })), 'with no other filter an empty group stays a live chip');
  // A group chip's dropdown holds the shared menu rows, filtering like chips.
  const dd = ui.renderFilterBar({ items: [], groups: ['Work', 'Work/Clients'], excludedFilters: new Set(['Work/Clients']), query: '' });
  assert.ok(/<button class="bc-menu-item group-filter-row excluded"[^>]*data-group="Work\/Clients"/.test(dd) && !/<span class="filter-tag[^"]*"[^>]*data-group="Work\/Clients"/.test(dd), 'a chip dropdown row is the shared menu row, not a chip');
  assert.ok(/FILTER_TARGET = [^;]*\.group-filter-row\[data-group\]/.test(coreSrc), 'dropdown rows filter like chips (click includes, right-click excludes)');
  const tiers = rules(popupCss);
  assert.ok(tiers.some((r) => /\.filter-tag\.is-disabled\b/.test(r.sel) && /opacity:\s*\.4/.test(r.body)) && tiers.some((r) => r.sel === '.filter-tag.is-disabled.dis-structural' && /opacity:\s*\.25/.test(r.body)),
    'two disabled tiers: transient .4, structural .25');
  // ONE hint line: created by attachSearchBox, a rows fold with nothing reserved.
  assert.ok(/hint\.className = 'search-hint'/.test(coreSrc), 'attachSearchBox owns the one hint line');
  assert.ok(tiers.some((r) => r.sel === '.search-hint' && /grid-template-rows:\s*0fr/.test(r.body)) && tiers.some((r) => r.sel === '.search-hint.show' && /grid-template-rows:\s*1fr/.test(r.body)),
    'the hint line folds (0 px when there is no hint)');
  assert.ok(tiers.some((r) => r.sel === '.qh-unknown' && /wavy/.test(r.body) && /var\(--red\)/.test(r.body)), 'an invalid key / value is red with a wavy underline');
  // Ghost completion painted in the highlight mirror.
  assert.ok(/class="qh-ghost"/.test(coreSrc) && tiers.some((r) => r.sel === '.qh-ghost'), 'the ghost is painted in the mirror');
  // Suggest rows ARE menu rows; their hints come from one table.
  assert.ok(/class="bc-menu-item search-suggest-item/.test(coreSrc), 'suggest rows use the shared menu-row look');
  assert.ok(!/PREFIX_HINTS\['is:'\]/.test(read('site/shared/clip-search.js')), 'no single hint repeated down the is: rows');
  // Both consumers: the census (chip bar + panel), the nudge, setQuery.
  for (const [name, src] of [['index.html', appHtml], ['site/index.html', siteHtml]]) {
    assert.ok(/Core\.createCensusCache\(/.test(src), `${name}: one census cache`);
    assert.ok(/getCensus:/.test(src), `${name}: the options panel reads the census`);
    assert.ok(/renderFilterBar\(\{[\s\S]{0,300}census/.test(src), `${name}: the chip bar reads the census`);
    assert.ok(/Core\.renderRelaxNudge\(Core\.search\.bestRelaxation\(/.test(src), `${name}: the empty state shows the relax nudge`);
    assert.ok(/setQuery: \(next\) =>/.test(src), `${name}: the adapter applies the nudge's query`);
  }
  assert.ok(/data-action="apply-query"\]'\)/.test(coreSrc) && /a\.setQuery\(/.test(coreSrc), 'the controller dispatches the nudge');
  // Paste auto-quote + the raw-paste chord live in the shared box.
  assert.ok(/inputEl\.addEventListener\('paste', onPaste\)/.test(coreSrc) && /Search\.quotePastedText\(/.test(coreSrc) && /e\.shiftKey && \(e\.key === 'v' \|\| e\.key === 'V'\)/.test(coreSrc),
    'a multi-word paste is quoted (Ctrl/Cmd+Shift+V pastes raw)');
}

// 31) Settings + Appearance (UI overhaul F / H), ONE source for the app and the
//     demo: the section order, ONE row grid and ONE list style (the shared
//     renderers, never a consumer-side template), the Appearance controls bound
//     by the shared Core.mountSettings, and ONE appearance applier in every
//     window, which never reads the retired accent_variant.
{
  const coreSrc = read('site/shared/clipboard-ui-core.js');
  const strip = (css) => css.replace(/\/\*[\s\S]*?\*\//g, '');
  const rules = (css) => [...strip(css).matchAll(/([^{}]+)\{([^{}]*)\}/g)].map((m) => ({ sel: m[1].trim(), body: m[2] }));
  const body = ui.renderSettingsBody();
  // Section order (the conflicts section sits on top, shown only when present).
  const heads = [...body.matchAll(/<h3>([^<]+)<\/h3>/g)].map((m) => m[1]);
  assert.deepStrictEqual(heads, ['Sync conflicts', 'General', 'Appearance', 'Quick paste and numpad', 'Groups', 'Sync', 'AI access', 'History', 'Diagnostics'], 'settings sections in the planned order');
  assert.ok(/<section class="settings-section hidden" id="conflictsSection">/.test(body.slice(0, 120)), 'unresolved sync conflicts surface at the top');
  for (const head of heads) assert.ok(head.split(' ').slice(1).every((w) => w === w.toLowerCase() || w === w.toUpperCase()), `section "${head}" is sentence case`);
  // ONE row grid: every row is a .setting-row whose cells are the label text,
  // the control and the reserved reset column; lists are .settings-item rows on
  // the same columns.
  const grid = rules(popupCss).filter((r) => /grid-template-columns/.test(r.body) && /\.setting-row|\.settings-item/.test(r.sel));
  assert.ok(grid.length === 1 && /\.setting-row/.test(grid[0].sel) && /\.settings-item/.test(grid[0].sel) && /minmax\(0, 1fr\) auto var\(--ctl-md\)/.test(grid[0].body),
    'ONE grid (label | control | reset column) shared by .setting-row and .settings-item');
  assert.ok(!/<div class="setting-row">\s*<label>/.test(body) && !/class="setting-row shortcut-row"/.test(body), 'no free-form row markup (label | control | reset only)');
  for (const retired of ['np-text', 'group-slot', 'gp-name', 'sync-account', 'settings-action', 'ai-client-row', 'ai-grant-row', 'settings-footer', 'shortcut-status', 'settings-status', 'sync-status', 'ai-subhead', 'build-info-line', 'developer-update-label', 'settings-usage']) {
    for (const [name, src] of [['clipboard-popup.css', popupCss], ['clipboard-ui-core.js', coreSrc], ['index.html', appHtml], ['site/index.html', siteHtml]]) {
      assert.ok(!new RegExp(`\\b${retired}\\b`).test(src), `${name} still uses the retired settings class .${retired}`);
    }
  }
  // Lists come from the shared renderers only.
  for (const [name, src] of [['index.html', appHtml], ['site/index.html', siteHtml]]) {
    assert.ok(!/class="(np-slot|settings-item|switch-wrap)/.test(src), `${name} hand-writes a settings list row (use Core.renderSettingsItem / renderNumpadSlotRows / renderGroupRows)`);
    assert.ok(src.includes('Core.renderNumpadSlotRows(') && src.includes('Core.renderGroupRows(') && src.includes('Core.renderSettingsItem('), `${name} renders its settings lists through the shared renderers`);
    assert.ok(src.includes('Core.mountSettings('), `${name} binds the settings view through Core.mountSettings`);
    assert.ok(!/\.className = '(sync|settings|shortcut)-status/.test(src), `${name} sets a status line's class by hand (use Core.setSettingHelp)`);
  }
  const slots = ui.renderNumpadSlotRows({ 3: 'txt:a' }, () => ({ id: 'txt:a', type: 'text', text: 'hello\nworld' }));
  assert.ok(/class="settings-item np-slot has-content clickable" data-slot-id="txt:a"/.test(slots) && /class="si-key">#3</.test(slots) && /class="icon-btn np-remove" type="button" data-slot="3"/.test(slots) && !/#1/.test(slots),
    'numpad: only assigned slots, one list row each (copy on click, x unassigns)');
  const grp = ui.renderGroupRows(['Work', 'AI'], { counts: new Map([['Work', 2]]), shared: new Set(['Work']), aiGroup: 'AI' });
  assert.ok(/<input type="checkbox" class="gp-share" aria-label="Share Work with AI" checked data-group="Work">/.test(grp) && /class="icon-btn gp-del" type="button" data-group="Work"/.test(grp), 'groups: an AI-sharing switch + delete per row');
  assert.ok(/class="gp-share" aria-label="The AI group is always shared with AI" checked disabled data-group="AI"/.test(grp) && !/data-group="AI" title="Delete group"/.test(grp), 'the AI group is always shared and never deleted');
  assert.ok(/^<div class="settings-list-title settings-list-cols"[^>]*><span class="si-text"><\/span><span class="si-control">Shared with AI<\/span>/.test(grp) && ui.renderGroupRows([], {}) === '',
    'the switch column is labelled above the switches (not explained only under the list)');
  assert.ok(rules(popupCss).some((r) => r.sel.split(/,\s*/).includes('.settings-list-cols') && /grid-template-columns/.test(r.body) && r.sel.includes('.settings-item')), 'the column head rides the rows\' one grid');
  assert.ok(!rules(popupCss).some((r) => /\.gp-name|\.np-num/.test(r.sel)), 'group names / slot numbers are not accent-coloured link look-alikes');
  // No redundant "Off" status lines; full-width free text; units in the control.
  assert.ok(!/'Off'/.test(appHtml), 'index.html writes an "Off" status line under a switch');
  assert.ok(/class="setting-row stack"[^>]*>[\s\S]{0,400}id="p2pPinned" type="text"/.test(body), 'pinned peers is a full-width free-text row');
  for (const id of ['maxAge', 'maxSize', 'aiTimeout', 'imagePreviewHeight']) {
    assert.ok(new RegExp(`<span class="input-affix"><input id="${id}" type="number"[^>]*><span class="affix">`).test(body), `${id} carries its unit inside the control`);
  }
  assert.ok(!/\((px|days|GB|seconds)\)/.test(body), 'no units in labels');
  assert.ok(/>Clear all<\/button>/.test(body) && /New group<\/button>/.test(body) && !/Clear All|New Group|Copy Diagnostics|AI Access/.test(body), 'sentence case on every label and button');
  assert.ok(/attachScrollFade\(body, 'panel'\)/.test(coreSrc.slice(coreSrc.indexOf('function mountSettings('))), 'the settings body gets the shared scroll fade');
  // Appearance controls: Theme, Accent (System default + presets + Custom),
  // Surface, Glass on, Density, Corners, Image preview height.
  for (const key of ['surface_style', 'glass_scope', 'ui_density', 'ui_corners']) assert.ok(body.includes(`data-appearance="${key}"`), `Appearance control ${key}`);
  for (const mode of ['system', 'blue', 'teal', 'mono', 'custom']) assert.ok(body.includes(`data-accent-mode="${mode}"`), `accent swatch ${mode}`);
  assert.ok(/\.accent-swatch\[data-accent-mode="system"\]:not\(\[aria-checked="true"\]\) \.accent-dot \{[^}]*box-shadow: inset 0 0 0 \d+px var\(--dot\)/.test(popupCss), 'System (not chosen) is a ring of its colour, never a twin of the Blue dot');
  assert.ok(/btn\.style\.setProperty\('--dot-dark', s\.dark\.accent\)/.test(coreSrc) && /btn\.style\.setProperty\('--dot-light', s\.light\.accent\)/.test(coreSrc), 'System / Custom swatches preview their per-theme shade');
  assert.ok(body.includes('id="themeMode"') && body.includes('id="accentCustom"') && body.includes('id="accentHue"') && body.includes('id="glassScopeRow"'), 'theme, custom colour and glass scope controls');
  assert.ok(!/type="color"/.test(body), 'no native colour dialog (it takes focus from the popup, which hides on blur)');
  // ONE applier in every window + the demo; nobody reads accent_variant.
  for (const [name, src] of [['index.html', appHtml], ['site/index.html', siteHtml], ['editor.html', read('editor.html')], ['viewer.html', read('viewer.html')], ['mcp-approval.html', read('mcp-approval.html')]]) {
    assert.ok(src.includes('Core.applyAppearance('), `${name} renders the appearance through Core.applyAppearance`);
    assert.ok(!src.includes('Core.applyVariants('), `${name} calls applyVariants directly (the accent colour would be lost)`);
    assert.ok(!/accent_variant/.test(src), `${name} reads the retired accent_variant`);
  }
  assert.ok(!/accentVariant:\s*'accent_mode'|uiDensity: 'ui_density'/.test(appHtml), 'the app no longer saves accent / density through the debug switcher');
}

console.log('ui-parity.test.js: all parity guards passed');
