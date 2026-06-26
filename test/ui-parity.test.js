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
    'aiAccessBody', 'aiClients', 'aiMoreClients', 'aiClientsMore', 'aiSecretsHead', 'aiSecrets',
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

// 5) Popup THEME variables live only in the shared stylesheet.
{
  assert.ok(/--accent:\s*#a78bfa/.test(popupCss), 'clipboard-popup.css should define the dark popup --accent');
  assert.ok(!/--accent:\s*#a78bfa/.test(appHtml), 'index.html still defines popup theme vars (move to clipboard-popup.css)');
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

// 7) renderClipActions emits the same data-action contract both popups depend on.
{
  const textActions = ui.renderClipActions({ id: 'x', type: 'text', text: 'a'.repeat(200) + '\nb' }, { expanded: false });
  for (const a of ['expand', 'edit', 'del']) {
    assert.ok(textActions.includes(`data-action="${a}"`), `renderClipActions text item missing data-action="${a}"`);
  }
  const imageActions = ui.renderClipActions({ id: 'y', type: 'image' }, {});
  for (const a of ['open-img', 'save-img', 'del']) {
    assert.ok(imageActions.includes(`data-action="${a}"`), `renderClipActions image item missing data-action="${a}"`);
  }
}

// 8) The built-in editor is single-sourced too: both the app editor window
//    (editor.html) and the website demo mount the SAME Core.createEditor, and
//    the demo must not keep a bespoke contenteditable inline-edit.
{
  const editorHtml = read('editor.html');
  assert.ok(editorHtml.includes('Core.createEditor('), 'editor.html must mount the shared Core.createEditor');
  assert.ok(siteHtml.includes('Core.createEditor('), 'site/index.html must mount the shared Core.createEditor');
  assert.ok(!siteHtml.includes('contenteditable'), 'site/index.html still uses a bespoke contenteditable edit; use Core.createEditor');
  assert.ok(typeof ui.createEditor === 'function', 'core must export createEditor');
  // Editor styles live in the shared stylesheet, not re-declared per consumer.
  const declares = (css, sel) => new RegExp(`(^|[\\s,])\\.${sel}\\s*[,{]`, 'm').test(css);
  assert.ok(declares(popupCss, 'bc-editor'), 'clipboard-popup.css should define .bc-editor');
  assert.ok(!declares(siteCss, 'bc-editor-area'), 'site/styles.css re-declares editor style (belongs in clipboard-popup.css)');
}

console.log('ui-parity.test.js: all parity guards passed');
