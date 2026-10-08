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

// 1) The token layer exists and defines one primitive from each scale plus the
//    ROLE tokens components size with. popup.css imports it as its very first rule.
{
  for (const t of [
    '--g-950:', '--blue-500:', '--teal-500:', '--white:', '--green-600:', '--red-600:', '--amber-600:',
    '--sp-4:', '--r-2:', '--dur:', '--ease:', '--icon-md:',
    '--fs-meta:', '--fs-ui:', '--fs-text:', '--fs-display:', '--lh-ui:', '--lh-text:', '--fw-regular:', '--fw-strong:',
    '--font-sans:', '--font-mono:', '--ctl-sm:', '--ctl-md:', '--ctl-lg:', '--r-ctl:', '--r-chip:', '--r-panel:',
    '--gutter:', '--bar-h:', '--focus-ring:', '--scrim:', '--line-faint:', '--mark-bg-current:', '--danger-fg:',
  ]) {
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
  // The audit axis (borders) must never leak into real installs: gated on the
  // env flag only (git installs are un-packaged, so `!app.isPackaged` was true
  // everywhere), in ONE place (main's appearanceVariantPayload). Every window,
  // the popup included, renders from that same payload, so no window can show
  // other accent / density / corners / borders than another (2026-09-02 drift).
  {
    const mainSrc = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8');
    const appSrc = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
    assert.ok(mainSrc.includes('debug_variants: debugVariantsEnabled(),'), 'debug_variants must come from debugVariantsEnabled()');
    assert.ok(/function debugVariantsEnabled\(\) \{\s*return !!process\.env\.BOARDCLIP_DEBUG_VARIANTS;/.test(mainSrc), 'debug variants must be gated on BOARDCLIP_DEBUG_VARIANTS only');
    assert.ok(!/debug_variants:.*isPackaged/.test(mainSrc), 'debug variants must not be tied to app.isPackaged');
    // Accent, density and corners are real settings now (lib/appearance.js,
    // test/appearance.test.js); the borders axis is still audit-only.
    assert.ok(mainSrc.includes("uiBorders: debugVariantsEnabled() && settings.ui_borders === 'borderless' ? 'borderless' : 'bordered',"), 'every window gets the default borders when debug variants are off');
    // ONE applier (Core.applyAppearance: the variants + a System / Custom
    // accent colour) in every window; a partial update (the surface alone)
    // merges into the popup's last full payload instead of resetting the rest.
    assert.ok(/function applyAppearance\(look\) \{[\s\S]{0,200}currentLook = \{ \.\.\.currentLook, \.\.\.look \};[\s\S]{0,200}Core\.applyAppearance\(document\.documentElement, currentLook\);/.test(appSrc)
      && appSrc.includes("applyAppearance({ ...(rt.appearance || {}), surfaceStyle: rt.surface_style || 'solid' });")
      && appSrc.includes('window.api.onAppearanceChanged(applyAppearance)')
      && /onSurfaceChanged\(\(style\) => applyAppearance\(\{ surfaceStyle:/.test(appSrc), 'the popup renders from runtime_info.appearance, then every appearance-changed');
    assert.ok(!/\bs\.(accent_variant|accent_mode|accent_custom|ui_density|ui_corners|ui_borders)\b/.test(appSrc), 'the popup never reads the raw appearance settings (it renders the resolved payload)');
    for (const file of ['editor.html', 'viewer.html']) {
      const src = fs.readFileSync(path.join(__dirname, '..', file), 'utf8');
      assert.ok(/Core\.applyAppearance\(document\.documentElement, init\);/.test(src)
        && /onAppearanceChanged\(\(look\) => \{[\s\S]{0,240}Core\.applyAppearance\(document\.documentElement, look\);/.test(src), `${file} renders from the init payload, then every appearance-changed`);
    }
    const approvalSrc = fs.readFileSync(path.join(__dirname, '..', 'mcp-approval.html'), 'utf8');
    assert.ok(/function applyLook\(look\) \{[\s\S]{0,400}Core\.applyAppearance\(root, look\);/.test(approvalSrc)
      && approvalSrc.includes('window.approval.onSettings(applyLook)') && approvalSrc.includes('window.approval.onAppearanceChanged(applyLook)')
      && !/setAttribute\('data-(accent|density|corners|borders)'/.test(approvalSrc), 'the approval modal renders the same payload through the shared Core.applyAppearance');
    // Accent, density, corners and the surface are real Settings > Appearance
    // controls (Core.mountSettings, saving accent_mode / accent_custom /
    // ui_density / ui_corners / surface_style / glass_scope); the debug
    // switcher keeps only the audit-only Borders axis.
    assert.ok(/fields: \['uiBorders'\]/.test(appSrc) && !/accent_variant/.test(appSrc), "the app's debug switcher holds only Borders, no retired key");
    const mount = coreSrc.slice(coreSrc.indexOf('const APPEARANCE_SEGS'), coreSrc.indexOf('function mountSettings('));
    for (const key of ['surface_style', 'glass_scope', 'ui_density', 'ui_corners']) assert.ok(mount.includes(`${key}: [`), `mountSettings saves ${key}`);
    assert.ok(/save\(\{ accent_mode: 'custom', accent_custom: c \}\)/.test(coreSrc), 'a custom colour saves accent_mode + accent_custom');
  }
  assert.ok(typeof ui.createVariantSwitcher === 'function', 'core must export createVariantSwitcher');
  for (const attr of ['data-surface', 'data-accent', 'data-density', 'data-corners', 'data-borders']) {
    assert.ok(tokensCss.includes(`[${attr}=`), `clipboard-tokens.css should define overrides for [${attr}]`);
    assert.ok(coreSrc.includes(attr), `applyVariants should set ${attr}`);
  }
  assert.ok(ui.renderSettingsBody().includes('id="appearanceVariants"'), 'settings body should host the appearance switcher');
}

// 5) The approval modal no longer carries its own palette or icon spec; it links
//    the shared sheet (tokens via its @import, .mi, .overline, focus ring) and
//    the window base sheet, so it can never drift from the app.
{
  assert.ok(!/--bg:\s*#0c0c0c/.test(approvalHtml), 'mcp-approval.html still embeds a duplicated palette');
  assert.ok(/href="site\/shared\/clipboard-popup\.css"/.test(approvalHtml), 'mcp-approval.html must link the shared clipboard-popup.css (tokens + .mi)');
  assert.ok(!/font-family:\s*'Material Symbols/.test(approvalHtml), 'mcp-approval.html must use the shared .mi rule, not its own icon font-family');
}

// 6) Native glass is centralized in one helper and spread into the popup window,
//    with the OS-support gate present (no duplicated option object).
{
  for (const fn of ['function glassSupport(', 'function popupSurfaceOptions(', 'function applySurfaceToPopup(', 'function resolvedSurfaceStyle(']) {
    assert.ok(mainJs.includes(fn), `main.js should define ${fn.replace('function ', '').replace('(', '')}`);
  }
  assert.ok(mainJs.includes('...popupSurfaceOptions()'), 'createPopup must spread the shared surface options');
  // The option objects themselves live in lib/appearance.js (surfaceWindowOptions).
  assert.ok(read('lib/appearance.js').includes("backgroundMaterial: 'acrylic'"), 'Windows acrylic backdrop should be wired');
}

// 7) Per-machine UI state is defaulted and excluded from sync. Window geometry
//    must never migrate between displays/machines (including the image viewer).
//    (The accent choice, density and corners sync: test/appearance.test.js.)
{
  const model = read('lib/clipboard-model.js');
  for (const key of [
    'surface_style', 'glass_scope', 'ui_borders',
    'popup_size', 'editor_bounds', 'merge_bounds', 'viewer_bounds',
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

// 10) An icon BUTTON must never carry the .mi class itself next to a rule that
//     sets `font: inherit` on it (that clobbers the Material Symbols ligature and
//     renders the literal word, e.g. "close"): glyphs live in a child
//     <span class="mi">. The window bar's old chip x (.gtag-x) was the case; the
//     bar now shows the row's own keys, so it is gone.
{
  assert.ok(!/gtag-x/.test(popupCss), 'the window bar chips with an x are gone (the bar shows the row\'s keys)');
}

// ---------------------------------------------------------------------------
// Design canon (UI overhaul phase 1): one type scale, two weights, one focus
// ring, one icon spec, one scrollbar, one button family, one floating surface,
// one window base sheet. These fail the build when a component forks again.
// ---------------------------------------------------------------------------
const windowCss = read('site/shared/clipboard-window.css');
const editorHtml = read('editor.html');
const viewerHtml = read('viewer.html');
const styleBlocks = (html) => [...html.matchAll(/<style>([\s\S]*?)<\/style>/g)].map((m) => m[1]).join('\n');
const windows = [['index.html', appHtml], ['editor.html', editorHtml], ['viewer.html', viewerHtml], ['mcp-approval.html', approvalHtml]];
// Every stylesheet the canon governs: the shared sheets + each window's own <style>.
const sheets = [
  ['clipboard-popup.css', popupCss], ['clipboard-window.css', windowCss],
  ...windows.map(([name, html]) => [`${name} <style>`, styleBlocks(html)]),
];
const stripComments = (css) => css.replace(/\/\*[\s\S]*?\*\//g, '');
const decls = (css, prop) => [...stripComments(css).matchAll(new RegExp(`(?:^|[;{\\s])${prop}\\s*:\\s*([^;}]+)`, 'g'))].map((m) => m[1].trim());
// Naive rule splitter (no nested blocks other than @media/@supports, which it
// flattens): [{ sel, body }] for every `selector { body }`.
const rules = (css) => [...stripComments(css).matchAll(/([^{}]+)\{([^{}]*)\}/g)].map((m) => ({ sel: m[1].trim(), body: m[2] }));

// 11) Type: only the role tokens. No raw px sizes, no retired --fs-1..6 scale,
//     icon glyphs sized with the --icon-* tokens.
{
  assert.ok(!/--fs-[1-6]\s*:/.test(tokensCss), 'the retired --fs-1..6 scale must not be defined (use --fs-meta/--fs-ui/--fs-text/--fs-display)');
  for (const [name, css] of [...sheets, ['clipboard-ui-core.js', coreSrc]]) {
    assert.ok(!/var\(--fs-[1-6]\)/.test(css), `${name} still uses the retired --fs-1..6 scale`);
  }
  for (const [name, css] of sheets) {
    for (const value of decls(css, 'font-size')) {
      assert.ok(/^var\(--(fs-(meta|ui|text|display)|icon-(sm|md|lg))\)$/.test(value),
        `${name}: font-size "${value}" must be a role token (--fs-meta/ui/text/display or --icon-*)`);
    }
    for (const value of decls(css, 'line-height')) {
      // 1 = icon/glyph boxes; normal = the search highlight mirror, which must
      // match the <input> it sits under.
      assert.ok(/^(var\(--lh-(ui|text)\)|1|normal)$/.test(value), `${name}: line-height "${value}" must be --lh-ui / --lh-text`);
    }
  }
  assert.strictEqual(decls(popupCss, 'line-height').filter((v) => v === 'normal').length, 1, 'only the search highlight mirror may use line-height: normal');
}

// 12) Two weights only, always through the tokens.
{
  assert.ok(/--fw-regular:\s*400;/.test(tokensCss) && /--fw-strong:\s*600;/.test(tokensCss), 'weights are 400 and 600');
  for (const [name, css] of sheets) {
    for (const value of decls(css, 'font-weight')) {
      assert.ok(/^var\(--fw-(regular|strong)\)$/.test(value), `${name}: font-weight "${value}" must be var(--fw-regular) or var(--fw-strong)`);
    }
  }
}

// 13) Icons: Material Symbols Rounded, SELF-HOSTED (site/shared/vendor/fonts),
//     declared by ONE @font-face in clipboard-popup.css (the sheet every window
//     and the website load) with font-display: block, so nothing waits on
//     Google Fonts and a reload never flashes ligature words. Axes pinned ONCE
//     on .mi (FILL via --icon-fill, a state signal only), and every close is
//     the Material glyph, never a text "x".
{
  for (const [name, html] of [...windows, ['site/index.html', siteHtml]]) {
    assert.ok(!/fonts\.googleapis\.com|fonts\.gstatic\.com/.test(html), `${name} loads a font from Google Fonts (the icon font is vendored)`);
    assert.ok(/<link rel="stylesheet" href="[^"]*shared\/clipboard-popup\.css">/.test(html), `${name} must load clipboard-popup.css (it declares the icon font)`);
  }
  const faces = [...stripComments(popupCss).matchAll(/@font-face\s*\{([^}]*)\}/g)].map((m) => m[1]);
  assert.strictEqual(faces.length, 1, 'clipboard-popup.css declares exactly one @font-face (the icon font)');
  assert.ok(/font-family:\s*"Material Symbols Rounded"/.test(faces[0]) && /font-display:\s*block/.test(faces[0]), 'the icon @font-face is Material Symbols Rounded with font-display: block');
  const src = /url\("([^"]+)"\)\s*format\("woff2"\)/.exec(faces[0]);
  assert.ok(src && src[1] === 'vendor/fonts/material-symbols-rounded.woff2', 'the icon font is the vendored woff2, relative to the shared sheet');
  const woff2 = fs.readFileSync(path.join(root, 'site', 'shared', src[1]));
  assert.strictEqual(woff2.subarray(0, 4).toString('latin1'), 'wOF2', 'the vendored icon font is a woff2');
  for (const [name, css] of [['site/styles.css', siteCss], ...sheets.filter(([n]) => n !== 'clipboard-popup.css')]) {
    assert.ok(!/@font-face|googleapis/.test(stripComments(css)), `${name} declares its own font (the icon font is declared once, in clipboard-popup.css)`);
  }
  const fvs = sheets.flatMap(([name, css]) => decls(css, 'font-variation-settings').map((v) => [name, v]));
  assert.strictEqual(fvs.length, 1, `font-variation-settings must be declared once (on .mi); found ${JSON.stringify(fvs)}`);
  assert.ok(/^\.mi \{[^}]*font-variation-settings: "FILL" var\(--icon-fill, 0\), "wght" 400, "GRAD" 0, "opsz" 20;/m.test(popupCss), '.mi must pin the axes (FILL via --icon-fill, wght 400, GRAD 0, opsz 20)');
  assert.ok(/\.mi\.filled \{ --icon-fill: 1; \}/.test(popupCss), '.mi.filled must only flip --icon-fill');
  assert.ok(!/&times;/.test(coreSrc), 'clipboard-ui-core.js still renders a text "x" close glyph (use <span class="mi">close</span>)');
  assert.ok(!rules(popupCss).some((r) => /(^|,)\s*\.close-btn\s*(,|$)/.test(r.sel)), '.close-btn is a hook only (no font overrides)');
  assert.ok(!/class="mi filled">settings</.test(coreSrc), 'the settings gear must be outlined (FILL is a state signal only)');
}

// 14) ONE keyboard focus ring (box-shadow via --focus-ring, no outline, so no
//     layout shift); nothing else draws an outline.
{
  assert.ok(/:focus-visible \{\s*outline: none; box-shadow: var\(--focus-ring\);\s*\}/.test(popupCss), 'popup.css must define the one :focus-visible ring');
  for (const [name, css] of sheets) {
    for (const value of decls(css, 'outline')) assert.strictEqual(value, 'none', `${name}: outline "${value}" (use the shared --focus-ring)`);
  }
}

// 15) ONE scrollbar: the shared rule in clipboard-popup.css (app windows and
//     the demo); no window keeps a copy, and nothing sets the standard
//     scrollbar-* properties that would silently disable it in Chromium.
{
  const thumbRules = rules(popupCss).filter((r) => /::-webkit-scrollbar-thumb(?!:)/.test(r.sel));
  assert.strictEqual(thumbRules.length, 1, 'exactly one ::-webkit-scrollbar-thumb rule (the shared one)');
  assert.ok(/background-clip:\s*padding-box/.test(thumbRules[0].body) && /border:\s*2px solid transparent/.test(thumbRules[0].body),
    'the shared thumb must be inset with a transparent border + padding-box clip (works on any surface)');
  for (const [name, css] of [['clipboard-window.css', windowCss], ...windows.map(([n, h]) => [n, styleBlocks(h)])]) {
    assert.ok(!/::-webkit-scrollbar/.test(css), `${name} defines its own scrollbar (the shared rule in clipboard-popup.css owns it)`);
  }
  for (const r of rules(popupCss).filter((x) => /::-webkit-scrollbar/.test(x.sel) && !/^:is\(:root\[data-theme\], \.bc-popup\) ::-webkit-scrollbar/.test(x.sel))) {
    assert.ok(/^\s*(width:\s*10px;|display:\s*none;)\s*$/.test(r.body), `only width-only / hide overrides of the shared scrollbar are allowed: ${r.sel}`);
  }
  // The standard scrollbar-* properties switch the shared ::-webkit-scrollbar
  // styling OFF in Chromium 121+. Allowed: the non-WebKit fallback block, and
  // `scrollbar-width: none` on an element whose ::-webkit-scrollbar is hidden too.
  const fallbackAt = '@supports not selector(::-webkit-scrollbar)';
  const withoutFallback = (css) => {
    const at = css.indexOf(fallbackAt);
    if (at < 0) return css;
    let i = css.indexOf('{', at);
    for (let depth = 0; i < css.length; i += 1) {
      if (css[i] === '{') depth += 1;
      else if (css[i] === '}' && (depth -= 1) === 0) break;
    }
    return css.slice(0, at) + css.slice(i + 1);
  };
  assert.ok(/scrollbar-width:\s*thin/.test(stripComments(popupCss).slice(stripComments(popupCss).indexOf(fallbackAt))), 'popup.css keeps the thin-scrollbar fallback for engines without ::-webkit-scrollbar');
  for (const [name, css] of [...sheets, ['site/styles.css', siteCss]]) {
    const own = withoutFallback(stripComments(css));
    assert.ok(!decls(own, 'scrollbar-color').length, `${name} sets scrollbar-color (it disables the shared scrollbar in Chromium)`);
    for (const r of rules(own).filter((x) => decls(x.body, 'scrollbar-width').length)) {
      assert.deepStrictEqual(decls(r.body, 'scrollbar-width'), ['none'], `${name}: ${r.sel} sets scrollbar-width (only "none", to hide a bar)`);
      for (const sel of r.sel.split(/,\s*/)) {
        assert.ok(rules(own).some((h) => h.sel.split(/,\s*/).includes(`${sel}::-webkit-scrollbar`) && /display:\s*none/.test(h.body)),
          `${name}: ${sel} hides its bar with scrollbar-width: none but has no ${sel}::-webkit-scrollbar { display: none }`);
      }
    }
  }
  assert.ok(!/--list-scrollbar-/.test(popupCss + tokensCss), 'the --list-scrollbar-* tokens were renamed --scrollbar-*');
}

// 16) ONE button family + dialog semantics: .btn (default / primary / danger /
//     quiet / sm), no green confirm, destructive confirms are red, clip text in a
//     mono preview while the dialog body stays sans.
{
  for (const sel of ['.btn {', '.btn.primary {', '.btn.danger {', '.btn.quiet {', '.btn.sm {']) assert.ok(popupCss.includes(sel), `popup.css must define ${sel}`);
  for (const [name, src] of [['clipboard-popup.css', popupCss], ['clipboard-ui-core.js', coreSrc], ['index.html', appHtml], ['site/index.html', siteHtml], ['site/styles.css', siteCss]]) {
    assert.ok(!/btn-confirm|btn-cancel/.test(src), `${name} still uses the retired .btn-confirm/.btn-cancel family`);
  }
  assert.ok(!rules(popupCss).some((r) => /\.dialog p\b/.test(r.sel) && /font-family/.test(r.body)), 'dialog body copy is sans (mono only in .dialog-preview)');
  assert.ok(/\.dialog-preview \{[^}]*font-family: var\(--font-mono\)/.test(popupCss), '.dialog-preview carries clip text in mono');
  assert.ok(/classList\.toggle\('danger', !!o\.danger\)/.test(coreSrc), 'createDialogs.confirm must honour {danger}');
  assert.ok(/title: `Delete group[^\n]*danger: true/.test(coreSrc), 'group delete must confirm with {danger:true}');
  assert.ok(/title: 'Clear all unpinned clips\?', message: 'Pinned clips are kept\.', okLabel: 'Clear all', danger: true/.test(coreSrc), 'clear all must confirm with {danger:true}, worded like its Settings row');
  assert.ok(!/already assigned[^\n]*danger/.test(coreSrc), 'numpad replace is not destructive (no danger confirm)');
  assert.ok(/class="btn danger" id="clearAll"/.test(coreSrc), 'Settings "Clear all" is the shared .btn.danger');
  // Text on red uses --danger-fg (per theme), never the accent's ink: an accent
  // variant (Mono, Custom) redefines --active-fg for ITS fill, not for red.
  assert.ok(/\.btn\.danger \{[^}]*color: var\(--danger-fg\)/.test(popupCss), '.btn.danger text is var(--danger-fg)');
  // The approval modal's buttons are the shared .btn set (its danger allow is
  // .btn.danger), with no button styling of its own.
  assert.ok(/class="btn primary" id="allowOnce"/.test(approvalHtml) && /\$\('allowOnce'\)\.classList\.toggle\('danger', danger\)/.test(approvalHtml), 'the approval allow button is the shared .btn (.danger when destructive)');
  assert.ok(!rules(styleBlocks(approvalHtml)).some((r) => /\bbutton\b|\.primary|\.deny|\.row2/.test(r.sel)), 'mcp-approval.html styles no buttons of its own (the shared .btn set does)');
  assert.strictEqual((tokensCss.match(/--danger-fg:/g) || []).length, 2, '--danger-fg is defined once per theme and never by an accent variant');
}

// 17) ONE floating surface (menus, suggest, dialog, toast, Newest pill) at
//     --r-panel; the toast is neutral (no status-colour pill).
{
  const floating = rules(popupCss).find((r) => /\.tag-submenu,\s*\.bc-menu$/.test(r.sel));
  assert.ok(floating, 'the shared floating-surface rule must exist');
  for (const cls of ['.dialog', '.toast', '.search-suggest', '.list-newest']) assert.ok(floating.sel.split(/,\s*/).includes(cls), `${cls} must ride the shared floating-surface rule`);
  assert.ok(/border-radius:\s*var\(--r-panel\)/.test(floating.body), 'floating surfaces use --r-panel');
  for (const r of rules(popupCss).filter((x) => /(^|,\s*)\.toast(\.show)?\s*$/.test(x.sel))) {
    assert.ok(!/--green|--r-pill|underline/.test(r.body), `the toast must be a neutral floating surface (${r.sel})`);
  }
  assert.ok(!/text-decoration:\s*underline/.test(rules(popupCss).filter((r) => /toast-action/.test(r.sel)).map((r) => r.body).join('')), 'the toast action is an accent text button, not an underline');
  // The hidden toast is only transparent, still over the last row: its action
  // may take the pointer only while the toast is shown.
  for (const r of rules(popupCss).filter((x) => /toast-action/.test(x.sel) && /pointer-events:\s*auto/.test(x.body))) {
    assert.ok(r.sel.split(/,\s*/).every((sel) => /^\.toast\.show \.toast-action/.test(sel)), `${r.sel}: only a SHOWN toast's action takes the pointer`);
  }
  assert.ok(rules(popupCss).some((r) => r.sel === '.toast.show .toast-action' && /pointer-events:\s*auto/.test(r.body)), 'the shown toast action opts back into the pointer');
}

// 18) Borders: a control has a fill OR a border, never both. The shared control
//     classes carry no border at all, and the only 1px lines are --line /
//     --line-faint dividers (+ the --menu-edge ring of floating surfaces).
{
  const controls = ['.btn', '.icon-btn', '.filter-tag', '.seg', '.seg-btn', '.search-row', '.setting-row input', '.prompt-input', '.shortcut-btn',
    '.bc-bar-title', 'input.bc-bar-title', '.bc-find-input', '.bc-head-title', '.bc-chg-progress', '.bc-drag-handle', '.input-affix', '.accent-swatch', '.list-newest', '.switch',
    '.toast', '.dialog', '.toast-action', '.np-btn', '.bc-menu-item'];
  for (const r of rules(popupCss)) {
    const hit = r.sel.split(/,\s*/).some((sel) => controls.some((c) => sel === c || sel.startsWith(c + '.') || sel.startsWith(c + ':')));
    if (!hit || /::-webkit-scrollbar/.test(r.sel)) continue;
    for (const value of decls(r.body, 'border')) assert.ok(/^(none|0)$/.test(value), `${r.sel} draws a border (${value}); a control has a fill OR a border`);
    assert.ok(!/border-(color|width|style)\s*:/.test(r.body), `${r.sel} sets a border colour/width/style`);
  }
  for (const [name, css] of sheets) {
    for (const m of stripComments(css).matchAll(/1px (solid|dashed|dotted) ([^;}]+)/g)) {
      assert.ok(m[1] === 'solid' && /^var\(--line(-faint)?\)$/.test(m[2].trim()), `${name}: 1px line "${m[0]}" (only var(--line) / var(--line-faint) dividers)`);
    }
  }
  assert.ok(!/--glass-border|--hover-strong/.test(tokensCss + popupCss), '--glass-border and --hover-strong were deleted');
}

// 19) Colours come from tokens: no raw hex/rgba in the shared component sheet or
//     the window sheets, and the light theme references primitives.
{
  for (const [name, css] of sheets) {
    assert.ok(!/#[0-9a-f]{3,8}\b|rgba?\(/i.test(stripComments(css)), `${name} hard-codes a colour (use a token)`);
  }
  const semantic = tokensCss.slice(tokensCss.indexOf('/* (b) SEMANTIC'));
  assert.ok(!/#[0-9a-f]{3,8}\b/i.test(stripComments(semantic)), 'semantic/variant tiers must reference primitives, not raw hex');
}

// 20) ONE window base sheet (reset, font, background, glass scrim) linked by
//     every app window; no window keeps its own copy. The demo does NOT load it.
{
  assert.ok(/font-family:\s*var\(--font-sans\)/.test(windowCss), 'clipboard-window.css sets the body font via --font-sans');
  assert.ok(/body::before/.test(windowCss), 'clipboard-window.css owns the glass scrim');
  for (const [name, html] of windows) {
    assert.ok(html.includes('href="site/shared/clipboard-window.css"'), `${name} must link the window base sheet`);
    const own = styleBlocks(html);
    assert.ok(!rules(own).some((r) => /(^|,\s*)(html|body)\s*(,|$)/.test(r.sel) && /font-family/.test(r.body)), `${name} redeclares the body font (clipboard-window.css owns it)`);
    assert.ok(!/system-ui/.test(own), `${name} spells out the UI font stack (use var(--font-sans))`);
    assert.ok(!/body::before|glass-tint/.test(own), `${name} redeclares the glass scrim (clipboard-window.css owns it)`);
    assert.ok(!/^\s*\*\s*\{/m.test(own), `${name} redeclares the reset (clipboard-window.css owns it)`);
  }
  assert.ok(!siteHtml.includes('clipboard-window.css'), 'the website demo must not load the window base sheet (it would reset the marketing page)');
}

// 22) Spacing snaps to the --sp-* scale (or --gutter): no raw px padding /
//     margin / gap (the empty state's old 60px went with its redesign).
{
  for (const [name, css] of sheets) {
    for (const prop of ['padding', 'padding-[a-z]+', 'margin', 'margin-[a-z]+', 'gap', 'row-gap', 'column-gap']) {
      for (const value of decls(css, prop)) {
        assert.ok(!/(^|[\s(])-?\d+(\.\d+)?px/.test(value), `${name}: ${prop} "${value}" must use the --sp-* scale`);
      }
    }
  }
}

// 21) Motion: ONE duration + curve for every state transition, named properties
//     only (never `all`, which also animates layout). The approval countdown
//     meter (a 1 s linear tick, not a state change) is the one exception.
{
  for (const [name, css] of sheets) {
    for (const value of decls(css, 'transition')) {
      if (name === 'mcp-approval.html <style>' && value === 'width 1s linear') continue;
      for (const part of value.split(/,\s*/)) {
        // allow-discrete only for the discrete properties it exists for (the
        // reveal's content-visibility, which skips laying out a closed reveal).
        assert.ok((/^[a-z-]+ var\(--dur\) var\(--ease\)$/.test(part) || /^(content-visibility|display) var\(--dur\) var\(--ease\) allow-discrete$/.test(part)) && !/^all /.test(part),
          `${name}: transition "${part}" must be "<property> var(--dur) var(--ease)"`);
      }
    }
  }
}

// 23) Row states: hover = the --hover overlay, the keyboard cursor (the row
//     Enter pastes) = --accent-bg; never --surface2 / --bg (light --surface2 IS
//     the list colour, so hover and the cursor vanished). The pin / multi-select
//     edge is ONE .item::before overlay, never a layout-shifting border.
{
  const rowRules = rules(popupCss).filter((r) => r.sel.split(/,\s*/).some((sel) => /^\.item(\.[a-z-]+)*(:hover)?$/.test(sel)));
  for (const r of rowRules) {
    for (const v of decls(r.body, 'background')) assert.ok(!/--surface2|--bg\b/.test(v), `${r.sel}: row state background "${v}" (use --hover / --accent-bg)`);
    assert.ok(!/border-left/.test(r.body), `${r.sel}: a row edge is the shared .item::before overlay, never a border`);
  }
  assert.ok(rowRules.some((r) => r.sel === '.item:hover' && /background: var\(--hover\)/.test(r.body)), 'row hover is the --hover overlay');
  assert.ok(rowRules.some((r) => r.sel === '.item.selected' && /background: var\(--accent-bg\)/.test(r.body)), 'the keyboard cursor row is --accent-bg');
  const edges = rules(popupCss).filter((r) => /\.item[^,]*::before/.test(r.sel));
  assert.ok(edges.length === 1 && edges[0].sel === '.item::before' && /var\(--row-edge, transparent\)/.test(edges[0].body), 'ONE .item::before edge driven by --row-edge');
  assert.ok(/\.item\.has-pin \{ --row-edge: var\(--pin\); \}/.test(popupCss) && /\.item\.multi-selected \{[^}]*--row-edge: var\(--accent\)/.test(popupCss), 'pin and multi-select set --row-edge');
}

// 24) Density keeps every step distinct: under each density the type roles
//     ascend from 11px (meta < ui < text), and so do the --sp-* and control
//     scales (a merged step silently erases a hierarchy).
{
  const pxTokens = (css) => Object.fromEntries([...stripComments(css).matchAll(/(--(?:fs-(?:meta|ui|text)|sp-\d+|ctl-(?:sm|md|lg))):\s*(\d+(?:\.\d+)?)px/g)].map((m) => [m[1], Number(m[2])]));
  const base = pxTokens(tokensCss.slice(0, tokensCss.indexOf('/* (b) SEMANTIC')));
  const compact = rules(tokensCss).find((r) => /data-density="compact"/.test(r.sel));
  assert.ok(compact, 'the compact density block exists');
  for (const [density, t] of [['normal', base], ['compact', { ...base, ...pxTokens(compact.body) }]]) {
    const ascending = (names) => names.every((n, i) => typeof t[n] === 'number' && (i === 0 || t[names[i - 1]] < t[n]));
    const show = (names) => names.map((n) => `${n}=${t[n]}`).join(' ');
    const type = ['--fs-meta', '--fs-ui', '--fs-text'];
    assert.ok(ascending(type) && t['--fs-meta'] >= 11, `${density}: type roles must ascend from 11px (${show(type)})`);
    const sp = Object.keys(t).filter((k) => /^--sp-\d+$/.test(k)).sort((a, b) => Number(a.slice(5)) - Number(b.slice(5)));
    assert.ok(sp.length >= 8 && ascending(sp), `${density}: the --sp-* scale must strictly ascend (${show(sp)})`);
    const ctl = ['--ctl-sm', '--ctl-md', '--ctl-lg'];
    assert.ok(ascending(ctl), `${density}: control heights must ascend (${show(ctl)})`);
  }
}

// 25) Accent contrast. The helper is WCAG 2 (known pairs), and every accent a
//     window can paint passes ONE rule in both themes: the accent reaches 3:1
//     against the theme's surfaces and its ink reaches 4.5:1 on it. System /
//     Custom colours are shaded until they pass (Core.accentShades, any colour,
//     light and dark OS accents included); the presets are checked against the
//     same rule straight from the token sheet.
{
  const near = (a, b) => Math.abs(a - b) < 0.01;
  assert.ok(near(ui.contrastRatio('#000000', '#ffffff'), 21) && near(ui.contrastRatio('#777777', '#ffffff'), 4.48) && near(ui.contrastRatio('#3b82f6', '#3b82f6'), 1), 'contrastRatio is the WCAG 2 ratio');
  assert.strictEqual(ui.normalizeHexColor('#FFB900'), '#ffb900');
  assert.strictEqual(ui.normalizeHexColor('0078d4ff'), '#0078d4');
  assert.strictEqual(ui.normalizeHexColor('#abc'), '#aabbcc');
  assert.strictEqual(ui.normalizeHexColor('orange'), null);
  assert.strictEqual(ui.accentShades('not a colour'), null);
  // The constants the shading measures against are the token values.
  const prim = Object.fromEntries([...tokensCss.matchAll(/(--[a-z0-9-]+):\s*(#[0-9a-f]{6})\s*;/gi)].map((m) => [m[1], m[2].toLowerCase()]));
  const SURFACE = { dark: prim['--g-800'], light: prim['--g-050'] };
  const INKS = [prim['--g-950'], prim['--white']];
  assert.ok(coreSrc.includes(`dark: { surface: '${SURFACE.dark}'`) && coreSrc.includes(`light: { surface: '${SURFACE.light}'`) && coreSrc.includes(`const ACCENT_INKS = ['${INKS[0]}', '${INKS[1]}']`),
    'the accent shading measures against --g-800 / --g-050 with the --g-950 / --white inks');
  const passes = (accent, ink, theme) => ui.contrastRatio(accent, SURFACE[theme]) >= 3 && ui.contrastRatio(accent, ink) >= 4.5 && INKS.includes(ink);
  // Accent AS TEXT (--accent-text): 4.5:1 on the surface and on the --accent-bg
  // tint over it. The tint shares are the token sheet's --accent-bg mixes.
  const TINT = {};
  for (const theme of ['dark', 'light']) {
    const m = /--accent-bg: color-mix\(in srgb, var\(--accent\) (\d+)%, transparent\)/.exec((rules(tokensCss).find((r) => r.sel.split(/,\s*/).includes(`:root[data-theme="${theme}"]`)) || { body: '' }).body);
    TINT[theme] = m ? Number(m[1]) / 100 : NaN;
  }
  assert.ok(coreSrc.includes(`surface: '${SURFACE.dark}', away: '#ffffff', tint: ${TINT.dark} }`) && coreSrc.includes(`surface: '${SURFACE.light}', away: '#000000', tint: ${TINT.light} }`),
    'the text shading measures against the same --accent-bg tint the token sheet paints');
  const mixHex = (a, b, t) => {
    const rgb = (h) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16));
    const x = rgb(a); const y = rgb(b);
    return '#' + x.map((c, i) => Math.round(c + (y[i] - c) * t).toString(16).padStart(2, '0')).join('');
  };
  const textPasses = (text, accent, theme) => ui.contrastRatio(text, SURFACE[theme]) >= 4.5 && ui.contrastRatio(text, mixHex(SURFACE[theme], accent, TINT[theme])) >= 4.5;
  // System accents from both OSes (light yellow, dark navy, the defaults) and a hue sweep.
  const sweep = [];
  for (let h = 0; h < 360; h += 15) for (const l of [0.2, 0.5, 0.8]) {
    const c = (1 - Math.abs(2 * l - 1)) * 0.8; const x = c * (1 - Math.abs(((h / 60) % 2) - 1)); const m = l - c / 2;
    const [r, g, b] = h < 60 ? [c, x, 0] : h < 120 ? [x, c, 0] : h < 180 ? [0, c, x] : h < 240 ? [0, x, c] : h < 300 ? [x, 0, c] : [c, 0, x];
    sweep.push('#' + [r, g, b].map((v) => Math.round((v + m) * 255).toString(16).padStart(2, '0')).join(''));
  }
  for (const color of ['#ffb900', '#fff100', '#0078d4', '#1a1a6e', '#000000', '#ffffff', '#777777', '#e81123', '#00cc6a', '#8764b8', '#007aff', '#ff9500', ...sweep]) {
    const s = ui.accentShades(color);
    for (const theme of ['dark', 'light']) {
      assert.ok(passes(s[theme].accent, s[theme].ink, theme), `${color} in ${theme}: ${s[theme].accent} / ink ${s[theme].ink} must pass`);
      assert.ok(textPasses(s[theme].text, s[theme].accent, theme), `${color} in ${theme}: text ${s[theme].text} must reach 4.5:1 on the surface and the tint`);
    }
  }
  // The stock Windows accent (the System default on most installs) as text in dark.
  assert.notStrictEqual(ui.accentShades('#0078d4').dark.text, '#0078d4', '#0078d4 is under 4.5:1 as dark-theme text, so its text shade lightens');
  // A colour that already passes is kept as is (the OS blue, both themes).
  assert.strictEqual(ui.accentShades('#0078d4').light.accent, '#0078d4');
  assert.strictEqual(ui.accentShades('#ffb900').dark.accent, '#ffb900');
  assert.notStrictEqual(ui.accentShades('#ffb900').light.accent, '#ffb900', 'a light yellow darkens in the light theme');
  assert.notStrictEqual(ui.accentShades('#1a1a6e').dark.accent, '#1a1a6e', 'a dark navy lightens in the dark theme');
  // Presets, resolved from the token sheet (theme block, then the variant blocks).
  const block = (sel) => (rules(tokensCss).find((r) => r.sel.split(/,\s*/).includes(sel)) || { body: '' }).body;
  const decl = (body, name) => { const m = new RegExp(`${name}:\\s*var\\((--[a-z0-9-]+)\\)`).exec(body); return m ? prim[m[1]] : undefined; };
  for (const theme of ['dark', 'light']) {
    const base = block(`:root[data-theme="${theme}"]`);
    for (const preset of ['blue', 'teal', 'mono']) {
      const layers = [base, block(`:root[data-accent="${preset}"]`), block(`:root[data-theme="${theme}"][data-accent="${preset}"]`)];
      let accent; let ink; let text;
      for (const body of layers) { accent = decl(body, '--accent') || accent; ink = decl(body, '--active-fg') || ink; text = decl(body, '--accent-text') || text; }
      assert.ok(accent && ink && passes(accent, ink, theme), `preset ${preset} in ${theme}: ${accent} / ink ${ink} must pass`);
      assert.ok(text && textPasses(text, accent, theme), `preset ${preset} in ${theme}: text ${text} must reach 4.5:1 on the surface and the tint`);
      // Its Settings swatch previews exactly that accent in that theme.
      const swatchSel = `${theme === 'light' ? ':where(:root, .bc-popup)[data-theme="light"] ' : ''}.accent-swatch${preset === 'blue' ? '' : `[data-accent-mode="${preset}"]`}`;
      const swatch = (rules(popupCss).find((r) => r.sel === swatchSel) || { body: '' }).body;
      const dotVar = /--dot: var\((?:--dot-(?:dark|light), var\()?(--[a-z0-9-]+)\)/.exec(swatch);
      assert.ok(dotVar && prim[dotVar[1]] === accent, `the ${preset} swatch in ${theme} must preview ${accent} (got ${dotVar && prim[dotVar[1]]})`);
    }
  }
  // The custom accent's tokens: per-theme pair from the applier, derived hover / mark.
  assert.ok(/--accent: var\(--accent-custom-dark\);\s*--active-fg: var\(--accent-ink-dark\);\s*--accent-text: var\(--accent-text-dark\);/.test(block(':root[data-theme="dark"][data-accent="custom"]'))
    && /--accent: var\(--accent-custom-light\);\s*--active-fg: var\(--accent-ink-light\);\s*--accent-text: var\(--accent-text-light\);/.test(block(':root[data-theme="light"][data-accent="custom"]')), 'data-accent="custom" picks the theme set');
  assert.ok(/--accent-hover: color-mix\(in srgb, var\(--accent\)/.test(block(':root[data-accent="custom"]')) && /--mark-fg: color-mix\(in srgb, var\(--accent\)/.test(block(':root[data-accent="custom"]')), 'custom hover / mark derive from the accent');
  assert.ok(/'--accent-custom-dark', '--accent-ink-dark', '--accent-text-dark', '--accent-custom-light', '--accent-ink-light', '--accent-text-light'/.test(coreSrc), 'applyAppearance sets (and clears) the six custom vars');
  assert.ok(/--input: color-mix\(in srgb, var\(--g-900\) \d+%, transparent\)/.test(block(':root[data-theme="light"][data-surface="glass"]')),
    'light glass fields are a dark wash (a white field vanished on light frost, on the demo page and on the opaque white menu)');
  // Accent AS TEXT reads --accent-text everywhere (an active chip, the current
  // numpad key, Accept, a zoom step, the clipboard status, link-like buttons);
  // --accent stays for fills, glyphs, the focus ring and switches.
  for (const sel of ['.qh-prefix', '.btn.quiet.accent', '.filter-tag.active', '.list-newest:hover', '.np-btn.current', '.shortcut-btn.recording', '.bc-editor-clip.on', '.bc-zoom .btn.quiet.active']) {
    const own = rules(popupCss).filter((x) => x.sel.split(/,\s*/).includes(sel) && /(^|[;{\s])color:/.test(x.body));
    assert.ok(own.length && own.every((r) => /(^|[;{\s])color: var\(--accent-text\)/.test(r.body)), `${sel} is accent TEXT: it must use --accent-text (4.5:1), not --accent`);
  }
  // ONE accent text action: Undo, "Did you mean", a pane head's Accept and the
  // merge note's action are the shared .btn.quiet.sm.accent, with no colour,
  // weight or radius of their own.
  for (const needle of ["btn.className = 'btn quiet sm accent toast-action'", "fix.className = 'btn quiet sm accent search-hint-fix'", 'class="btn quiet sm accent bc-head-accept"', '<button type="button" class="btn quiet sm accent" data-x="showws">']) {
    assert.ok(coreSrc.includes(needle), `the shared accent text action is missing: ${needle}`);
  }
  for (const r of rules(popupCss).filter((x) => /toast-action|search-hint-fix|bc-head-accept|bc-merge-note \.btn/.test(x.sel))) {
    assert.ok(!/(^|[;{\s])(color|font-weight|border-radius|background):/.test(r.body), `${r.sel}: an accent text action takes its look from .btn.quiet.sm.accent`);
  }
}

console.log('ui-tokens.test.js: all token/variant/glass/canon guards passed');
