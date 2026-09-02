'use strict';

// Guards for the design-token layer, the appearance-variant system, and the
// native-glass plumbing. These lock in the overhaul so a future edit can't
// quietly reintroduce ad-hoc colours/sizes, inline styles, the old purple, or a
// duplicated palette in the approval modal / marketing site.

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const ui = require('../site/shared/clipboard-ui-core');

const root = path.join(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(root, rel), 'utf8');

const tokensCss = read('site/shared/clipboard-tokens.css');
const popupCss = read('site/shared/clipboard-popup.css');
const coreSrc = read('site/shared/clipboard-ui-core.js');
const appHtml = read('index.html');
const siteHtml = read('site/index.html');
const siteCss = read('site/styles.css');
const mainJs = read('main.js');
const approvalHtml = read('mcp-approval.html');

// 1) The token layer exists and defines one primitive from each scale, plus the
//    semantic --accent mapping. popup.css imports it as its very first rule.
{
  for (const t of ['--g-950:', '--blue-500:', '--teal-500:', '--sp-4:', '--r-2:', '--fs-3:', '--dur:', '--icon-md:']) {
    assert.ok(tokensCss.includes(t), `clipboard-tokens.css should define ${t}`);
  }
  assert.ok(/^@import url\("clipboard-tokens\.css"\)/m.test(popupCss), 'clipboard-popup.css must @import clipboard-tokens.css first');
}

// 2) No inline font-size styles remain in the markup templates; the .mi size
//    utilities that replaced them are defined once in the shared stylesheet.
{
  assert.ok(!/style="font-size/.test(coreSrc), 'clipboard-ui-core.js still has an inline font-size style');
  assert.ok(!/style="font-size/.test(appHtml), 'index.html still has an inline font-size style');
  assert.ok(!/style="display:none"/.test(coreSrc), 'clipboard-ui-core.js still has an inline display:none (use .hidden)');
  assert.ok(!/style="visibility/.test(appHtml), 'index.html still has an inline visibility style (use a class)');
  assert.ok(/\.mi\.sm\s*\{/.test(popupCss) && /\.mi\.lg\s*\{/.test(popupCss), 'popup.css should define .mi.sm and .mi.lg');
}

// 3) The old purple palette + its raw rgb are gone from every styling surface.
{
  for (const [name, css] of [
    ['clipboard-tokens.css', tokensCss], ['clipboard-popup.css', popupCss], ['site/styles.css', siteCss],
    ['index.html', appHtml], ['site/index.html', siteHtml], ['mcp-approval.html', approvalHtml],
  ]) {
    assert.ok(!/#a78bfa|#7c3aed|#8b5cf6|#c4b5fd|#6d28d9/i.test(css), `${name} still contains the old purple palette`);
    assert.ok(!/167,\s*139,\s*250|124,\s*58,\s*237/.test(css), `${name} still contains a hard-coded purple rgb`);
  }
}

// 4) The shared variant system is exported and every axis attribute the token
//    layer keys on is actually driven by the applier.
{
  assert.ok(typeof ui.applyVariants === 'function', 'core must export applyVariants');
  // The audit axes must never leak into real installs: gated on the env flag only
  // (git installs are un-packaged, so `!app.isPackaged` was true everywhere), and
  // both the popup and the secondary windows fall back to the default look.
  {
    const mainSrc = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8');
    const appSrc = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
    assert.ok(mainSrc.includes('debug_variants: debugVariantsEnabled(),'), 'debug_variants must come from debugVariantsEnabled()');
    assert.ok(/function debugVariantsEnabled\(\) \{\s*return !!process\.env\.BOARDCLIP_DEBUG_VARIANTS;/.test(mainSrc), 'debug variants must be gated on BOARDCLIP_DEBUG_VARIANTS only');
    assert.ok(!/debug_variants:.*isPackaged/.test(mainSrc), 'debug variants must not be tied to app.isPackaged');
    assert.ok(appSrc.includes("uiBorders: debug ? s.ui_borders : 'bordered',"), 'popup must apply the audit axes only under debug_variants');
    assert.ok(mainSrc.includes("return { accentVariant: 'blue', uiDensity: 'normal', uiCorners: 'soft', uiBorders: 'bordered' };"), 'secondary windows must get the default axes when debug variants are off');
  }
  assert.ok(typeof ui.createVariantSwitcher === 'function', 'core must export createVariantSwitcher');
  for (const attr of ['data-surface', 'data-accent', 'data-density', 'data-corners', 'data-borders']) {
    assert.ok(tokensCss.includes(`[${attr}=`), `clipboard-tokens.css should define overrides for [${attr}]`);
    assert.ok(coreSrc.includes(attr), `applyVariants should set ${attr}`);
  }
  assert.ok(ui.renderSettingsBody().includes('id="appearanceVariants"'), 'settings body should host the appearance switcher');
}

// 5) The approval modal no longer carries its own palette; it consumes the
//    shared token sheet instead (so it can never drift from the app).
{
  assert.ok(!/--bg:\s*#0c0c0c/.test(approvalHtml), 'mcp-approval.html still embeds a duplicated palette');
  assert.ok(/clipboard-tokens\.css/.test(approvalHtml), 'mcp-approval.html must link the shared token sheet');
}

// 6) Native glass is centralized in one helper and spread into the popup window,
//    with the OS-support gate present (no duplicated option object).
{
  for (const fn of ['function glassSupport(', 'function popupSurfaceOptions(', 'function applySurfaceToPopup(', 'function resolvedSurfaceStyle(']) {
    assert.ok(mainJs.includes(fn), `main.js should define ${fn.replace('function ', '').replace('(', '')}`);
  }
  assert.ok(mainJs.includes('...popupSurfaceOptions()'), 'createPopup must spread the shared surface options');
  assert.ok(mainJs.includes("backgroundMaterial: 'acrylic'"), 'Windows acrylic backdrop should be wired');
}

// 7) Per-machine UI state is defaulted and excluded from sync. Window geometry
//    must never migrate between displays/machines (including the image viewer).
{
  const model = read('lib/clipboard-model.js');
  for (const key of [
    'surface_style', 'accent_variant', 'ui_density', 'ui_corners', 'ui_borders',
    'popup_size', 'editor_bounds', 'viewer_bounds',
  ]) {
    assert.ok(model.includes(`${key}:`), `DEFAULT_SETTINGS should include ${key}`);
    assert.ok(mainJs.includes(`delete remoteSave.${key}`), `${key} must be excluded from synced settings`);
  }
}

// 8) A custom data directory can be a real relocation. Hermetic Electron QA is
//    opt-in so it cannot discover or write the developer's cloud mounts.
{
  assert.ok(mainJs.includes("process.env.BOARDCLIP_ISOLATED === '1'"),
    'BOARDCLIP_ISOLATED must explicitly gate cloud discovery for hermetic QA');
  assert.ok(!mainJs.includes('if (process.env.BOARDCLIP_DATA_DIR) {\n    cloudAccountsCache = []'),
    'BOARDCLIP_DATA_DIR alone must not disable real cloud discovery');
}

// 9) Every JSON store read (local AND remote provider files) goes through the
//    ONE BOM-tolerant parser. A rejected parse is destructive here: the store
//    reads as empty and the next canonical write replaces the user's data.
{
  const blobStoreSrc = read('lib/blob-store.js');
  assert.ok(/function parseJsonText\(/.test(blobStoreSrc), 'blob-store must define the shared parseJsonText');
  assert.ok(/replace\(\/\^\\uFEFF\/, ''\)/.test(blobStoreSrc), 'parseJsonText must strip a leading UTF-8 BOM');
  const storeReads = mainJs.match(/JSON\.parse\((?:await )?fs\.(?:promises\.)?read[Ff]ile(?:Sync)?\(/g) || [];
  assert.strictEqual(storeReads.length, 0, `main.js must not JSON.parse a file read directly (found ${storeReads.length}); use blobStore.parseJsonText`);
  for (const reader of ['SETTINGS_PATH', 'DB_PATH', 'CONFLICTS_PATH', 'remoteDbPath', 'remoteSettingsPath', 'remoteConflictsPath']) {
    assert.ok(mainJs.includes(`blobStore.parseJsonText(`) && mainJs.includes(reader),
      `${reader} must be read through blobStore.parseJsonText`);
  }
  const blobStore = require('../lib/blob-store');
  assert.deepStrictEqual(blobStore.parseJsonText('\uFEFF[{"id":"txt:a"}]'), [{ id: 'txt:a' }], 'BOM-prefixed JSON must parse');
  assert.deepStrictEqual(blobStore.parseJsonText('{"a":1}'), { a: 1 }, 'plain JSON must still parse');
  assert.throws(() => blobStore.parseJsonText('not json'), 'genuinely invalid JSON must still throw');
}

// 10) The tag remove control is an icon BUTTON: it must stay keyboard-focusable
//     WITHOUT `font: inherit` clobbering the Material Symbols ligature (that
//     renders the literal word "close"), and the accent ring is focus-only.
{
  const gtagRule = popupCss.split('\n').find((line) => line.trim().startsWith('.filter-tag .gtag-x {')) || '';
  assert.ok(gtagRule, 'popup.css must style .filter-tag .gtag-x');
  assert.ok(!/font:\s*inherit/.test(gtagRule), '.filter-tag .gtag-x must not set font: inherit (it overrides the .mi icon font)');
  assert.ok(!/\.filter-tag \.gtag-x:hover,\s*\.filter-tag \.gtag-x:focus-visible \{[^}]*outline:/.test(popupCss),
    'the accent outline must be focus-visible only, never on hover');
  assert.ok(/\.filter-tag \.gtag-x:focus-visible \{[^}]*outline: 1px solid var\(--accent\)/.test(popupCss),
    'focus-visible on the remove button must draw the accent ring');
}

console.log('ui-tokens.test.js: all token/variant/glass guards passed');
