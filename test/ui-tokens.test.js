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

// 7) The new appearance settings are per-machine: defaulted, whitelisted, and
//    excluded from sync.
{
  const model = read('lib/clipboard-model.js');
  for (const key of ['surface_style', 'accent_variant', 'ui_density', 'ui_corners', 'ui_borders']) {
    assert.ok(model.includes(`${key}:`), `DEFAULT_SETTINGS should include ${key}`);
    assert.ok(mainJs.includes(`delete remoteSave.${key}`), `${key} must be excluded from synced settings`);
  }
}

console.log('ui-tokens.test.js: all token/variant/glass guards passed');
