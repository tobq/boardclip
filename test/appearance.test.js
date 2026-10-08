'use strict';
// lib/appearance.js (accent normalisation, settings validation, the synced
// merge, the one-time promotion of the audit axes, window surface options) and
// its main-process wiring: secondary windows are solid unless "Glass on: All
// windows", the synced vs per-machine split, the OS accent watchers and the ONE
// appearance-changed broadcast every window can subscribe to.
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const A = require('../lib/appearance');
const model = require('../lib/clipboard-model');

const read = (rel) => fs.readFileSync(path.join(__dirname, '..', rel), 'utf8');
const main = read('main.js');
const fnBody = (src, name) => {
  const at = src.indexOf(`function ${name}(`);
  assert.ok(at >= 0, `main.js defines ${name}`);
  return src.slice(at, src.indexOf('\n}\n', at) + 2);
};

// 1) OS accent -> '#rrggbb'. Electron gives 'rrggbbaa' (no '#') on Windows and macOS.
{
  assert.strictEqual(A.normalizeAccentHex, require('../site/shared/clipboard-ui-core').normalizeHexColor, 'ONE hex rule: main\'s validator is the core\'s (the renderer\'s Custom field)');
  assert.strictEqual(A.normalizeAccentHex('0078d4ff'), '#0078d4', 'Electron getAccentColor form: alpha dropped');
  assert.strictEqual(A.normalizeAccentHex('#0078D4'), '#0078d4');
  assert.strictEqual(A.normalizeAccentHex(' 3A6FD8 '), '#3a6fd8');
  assert.strictEqual(A.normalizeAccentHex('#abc'), '#aabbcc');
  assert.strictEqual(A.normalizeAccentHex('#11223344'), '#112233');
  for (const bad of ['', null, undefined, '#12345', '#1234567', 'blue', 'rgb(0, 0, 0)', '#ggg000', 42]) {
    assert.strictEqual(A.normalizeAccentHex(bad), null, `rejects ${JSON.stringify(bad)}`);
  }
}

// 2) The accent a window paints with.
{
  assert.deepStrictEqual(A.resolveAccent({ mode: 'system', system: 'c42b1cff' }), { mode: 'system', preset: 'blue', color: '#c42b1c' });
  assert.deepStrictEqual(A.resolveAccent({ mode: 'system', system: '' }), { mode: 'system', preset: 'blue', color: null }, 'no OS accent: the blue palette');
  assert.deepStrictEqual(A.resolveAccent({ mode: 'custom', custom: '#FF8800', system: '#0078d4' }), { mode: 'custom', preset: 'blue', color: '#ff8800' });
  assert.deepStrictEqual(A.resolveAccent({ mode: 'custom', custom: 'nope' }), { mode: 'custom', preset: 'blue', color: null });
  for (const preset of ['blue', 'teal', 'mono']) {
    assert.deepStrictEqual(A.resolveAccent({ mode: preset, custom: '#ff8800', system: '#0078d4' }), { mode: preset, preset, color: null }, `${preset} ignores the OS + custom colours`);
  }
  assert.strictEqual(A.resolveAccent({ mode: 'purple' }).mode, 'system', 'an unknown mode resolves to the default');
  assert.strictEqual(A.resolveAccent().mode, 'system');
}

// 3) save-settings validation + stamps.
{
  const s = { ...model.DEFAULT_SETTINGS };
  let r = A.applyAppearanceSettings(s, { accent_mode: 'teal' }, { now: 1000 });
  assert.deepStrictEqual(r, { changed: ['accent_mode'], synced: true });
  assert.deepStrictEqual(s.appearance_stamps, { accent: 1000 });
  assert.deepStrictEqual(model.DEFAULT_SETTINGS.appearance_stamps, {}, 'the shared default object is never mutated');
  r = A.applyAppearanceSettings(s, { accent_mode: 'teal' }, { now: 1500 });
  assert.deepStrictEqual(r, { changed: [], synced: false }, 'an unchanged value is no change (and no new stamp)');
  assert.strictEqual(s.appearance_stamps.accent, 1000);
  r = A.applyAppearanceSettings(s, { accent_mode: 'custom', accent_custom: '#FFAA00' }, { now: 2000 });
  assert.deepStrictEqual(r.changed.sort(), ['accent_custom', 'accent_mode']);
  assert.strictEqual(s.accent_custom, '#ffaa00', 'custom colours are stored normalised');
  assert.strictEqual(s.appearance_stamps.accent, 2000, 'mode + colour are one choice: one stamp');
  r = A.applyAppearanceSettings(s, { accent_mode: 'purple', accent_custom: 'orange', ui_density: 'tiny', ui_corners: 'round', glass_scope: 'some', surface_style: 'frosted', ui_borders: 'none' }, { now: 3000 });
  assert.deepStrictEqual(r, { changed: [], synced: false }, 'invalid values are ignored');
  r = A.applyAppearanceSettings(s, { accent_variant: 'mono' }, { now: 3000 });
  assert.strictEqual(s.accent_mode, 'mono', 'the old debug switcher key is an alias for accent_mode');
  assert.ok(!('accent_variant' in s), 'and is never stored');
  r = A.applyAppearanceSettings(s, { ui_density: 'compact', ui_corners: 'sharp' }, { now: 500 });
  assert.deepStrictEqual(r.changed, ['ui_density', 'ui_corners']);
  assert.ok(s.appearance_stamps.density === 500 && s.appearance_stamps.corners === 500, 'density and corners stamp separately');
  A.applyAppearanceSettings(s, { ui_density: 'normal' }, { now: 400 });
  assert.strictEqual(s.appearance_stamps.density, 501, 'a clock that went backwards still moves the stamp forward');
  r = A.applyAppearanceSettings(s, { glass_scope: 'all', surface_style: 'solid', ui_borders: 'borderless' }, { now: 9000 });
  assert.deepStrictEqual(r, { changed: ['ui_borders', 'surface_style', 'glass_scope'], synced: false }, 'per-machine keys change without a stamp');
  r = A.applyAppearanceSettings(s, { accent_custom: '' }, { now: 9100 });
  assert.strictEqual(s.accent_custom, '', "'' clears the custom colour");
}

// 4) The synced merge: newest stamp per group wins, only with valid values.
{
  const local = { accent_mode: 'system', accent_custom: '', ui_density: 'normal', ui_corners: 'soft', appearance_stamps: { accent: 100 } };
  assert.strictEqual(A.mergeSyncedAppearance(local, { accent_mode: 'teal', accent_custom: '', ui_density: 'compact', ui_corners: 'sharp' }), false,
    'a device that sends no stamps (an older build, or one that never chose) never overwrites');
  assert.strictEqual(A.mergeSyncedAppearance(local, { accent_mode: 'teal', accent_custom: '', appearance_stamps: { accent: 50 } }), false, 'an older choice loses');
  assert.strictEqual(A.mergeSyncedAppearance(local, { accent_mode: 'purple', accent_custom: '', appearance_stamps: { accent: 300 } }), false, 'an invalid newer value is ignored');
  assert.strictEqual(local.accent_mode, 'system');
  assert.strictEqual(A.mergeSyncedAppearance(local, { accent_mode: 'custom', accent_custom: '#00AA55', ui_density: 'compact', appearance_stamps: { accent: 300, density: 10 } }), true);
  assert.deepStrictEqual([local.accent_mode, local.accent_custom, local.ui_density], ['custom', '#00aa55', 'compact']);
  assert.deepStrictEqual(local.appearance_stamps, { accent: 300, density: 10 }, 'each group takes the winning stamp');
  assert.strictEqual(local.ui_corners, 'soft', 'a group the remote never stamped is untouched');
  // Two devices converge whatever order they exchange in.
  const a = { ...model.DEFAULT_SETTINGS };
  const b = { ...model.DEFAULT_SETTINGS };
  A.applyAppearanceSettings(a, { accent_mode: 'teal', ui_corners: 'sharp' }, { now: 1000 });
  A.applyAppearanceSettings(b, { accent_mode: 'mono' }, { now: 2000 });
  A.applyAppearanceSettings(b, { ui_density: 'compact' }, { now: 2500 });
  A.mergeSyncedAppearance(a, { ...b });
  A.mergeSyncedAppearance(b, { ...a });
  const pick = (x) => [x.accent_mode, x.ui_density, x.ui_corners, JSON.stringify(x.appearance_stamps)];
  assert.deepStrictEqual(pick(a), pick(b), 'both devices end on the same appearance');
  assert.deepStrictEqual(pick(a).slice(0, 3), ['mono', 'compact', 'sharp'], 'newest per group: accent + density from b, corners from a');
  assert.strictEqual(A.mergeSyncedAppearance(a, { ...b }), false, 'idempotent');
}

// 5) One-time promotion of the audit-era axes (applied to the file as read).
{
  // The live install's file (2026-10-08): audit leftovers that never showed.
  const live = { surface_style: 'glass', accent_variant: 'blue', ui_density: 'normal', ui_corners: 'sharp', ui_borders: 'borderless', groups: ['x'] };
  const out = A.migrateAppearanceSettings(live, { debugVariants: false });
  assert.strictEqual(out.accent_mode, 'system', "the old default 'blue' becomes the new default (System)");
  assert.ok(!('accent_variant' in out), 'the old key is gone');
  assert.ok(!('ui_corners' in out) && !('ui_density' in out), 'values that never showed (no debug flag) fall back to the defaults');
  assert.strictEqual(out.ui_borders, 'borderless', 'borders stays the per-machine audit knob');
  assert.deepStrictEqual(out.groups, ['x'], 'nothing else is touched');
  assert.strictEqual(live.ui_corners, 'sharp', 'the input is not mutated');
  assert.ok(!out.appearance_stamps, 'migrated values get no stamp, so they never overwrite another device');
  const hidden = A.migrateAppearanceSettings({ accent_variant: 'teal', ui_corners: 'sharp' }, { debugVariants: false });
  assert.strictEqual(hidden.accent_mode, 'system', 'an audit accent that never showed is not promoted');
  const shown = A.migrateAppearanceSettings({ accent_variant: 'teal', ui_density: 'compact', ui_corners: 'sharp' }, { debugVariants: true });
  assert.deepStrictEqual([shown.accent_mode, shown.ui_density, shown.ui_corners], ['teal', 'compact', 'sharp'], 'under the debug flag the values WERE the look: kept');
  const done = A.migrateAppearanceSettings({ accent_mode: 'blue', ui_corners: 'sharp', accent_variant: 'mono' }, { debugVariants: false });
  assert.deepStrictEqual([done.accent_mode, done.ui_corners, 'accent_variant' in done], ['blue', 'sharp', false], 'a promoted file keeps its real choices');
  assert.strictEqual(A.migrateAppearanceSettings(null), null);
  // Through loadSettings' merge: the defaults fill in what the promotion dropped.
  const merged = { ...model.DEFAULT_SETTINGS, ...out };
  assert.deepStrictEqual([merged.accent_mode, merged.ui_corners, merged.ui_density, merged.glass_scope], ['system', 'soft', 'normal', 'popup']);
}

// 6) Window surface options (one function for the popup and every other window).
{
  assert.deepStrictEqual(A.surfaceWindowOptions({ support: 'acrylic', on: true, solidBackground: '#14171b' }), { backgroundMaterial: 'acrylic', backgroundColor: '#00000000' });
  assert.deepStrictEqual(A.surfaceWindowOptions({ support: 'acrylic', on: false, solidBackground: '#14171b' }), { backgroundColor: '#14171b' }, 'Windows solid: an opaque window, no material');
  assert.deepStrictEqual(A.surfaceWindowOptions({ support: 'none', on: true, solidBackground: '#ffffff' }), { backgroundColor: '#ffffff' });
  const macGlass = A.surfaceWindowOptions({ support: 'vibrancy', on: true, solidBackground: '#14171b' });
  const macLiveSolid = A.surfaceWindowOptions({ support: 'vibrancy', on: false, solidBackground: '#00000000', live: true });
  assert.strictEqual(macGlass.vibrancy, 'popover');
  assert.ok(macGlass.transparent, 'macOS glass: a transparent window with vibrancy');
  assert.ok(macLiveSolid.transparent && macLiveSolid.vibrancy === undefined, 'the macOS popup (live) stays transparent while solid, so glass can be switched on live');
  assert.deepStrictEqual(A.surfaceWindowOptions({ support: 'vibrancy', on: false, solidBackground: '#14171b' }), { backgroundColor: '#14171b' },
    'a macOS window created solid is an ordinary opaque window (native shadow), not a transparent one with no material');
}

// 7) Defaults: the new keys exist, the retired one is gone.
{
  const d = model.DEFAULT_SETTINGS;
  assert.deepStrictEqual([d.accent_mode, d.accent_custom, d.glass_scope, d.ui_density, d.ui_corners], ['system', '', 'popup', 'normal', 'soft']);
  assert.ok(!('accent_variant' in d), 'accent_variant is retired (promoted to accent_mode)');
  assert.deepStrictEqual(d.appearance_stamps, {});
}

// 8) main.js: every window but the popup is created through the ONE secondary
//    helper (solid unless "Glass on: All windows"), and says so in its payload.
{
  const sites = [];
  let at = -1;
  while ((at = main.indexOf('new BrowserWindow({', at + 1)) >= 0) {
    const end = main.indexOf('webPreferences', at);
    sites.push({ at, before: main.slice(Math.max(0, at - 30), at), options: main.slice(at, end) });
  }
  assert.ok(sites.length >= 6, `expected the popup + 5 secondary windows, found ${sites.length}`);
  const popup = sites.filter((x) => /\bwin = $/.test(x.before));
  assert.strictEqual(popup.length, 1, 'one popup creation site');
  assert.ok(popup[0].options.includes('...popupSurfaceOptions()'), 'the popup spreads popupSurfaceOptions()');
  for (const site of sites.filter((x) => x !== popup[0])) {
    const title = (/title: '([^']+)'/.exec(site.options) || [])[1] || `@${site.at}`;
    assert.ok(site.options.includes('...secondaryWindowSurfaceOptions()'), `${title}: created through secondaryWindowSurfaceOptions()`);
    assert.ok(!site.options.includes('popupSurfaceOptions'), `${title}: never the popup's glass options`);
    assert.ok(!/backgroundMaterial|vibrancy|backgroundColor:/.test(site.options), `${title}: no hand-rolled surface option`);
  }
  for (const title of ['BoardClip - editor', 'BoardClip - image', 'BoardClip - resolve conflict', 'BoardClip - unify clips', 'BoardClip - approve AI action']) {
    assert.ok(sites.some((x) => x.options.includes(`title: '${title}'`) && x.options.includes('...secondaryWindowSurfaceOptions()')), `${title} is a guarded secondary window`);
  }
  assert.strictEqual(main.split('...popupSurfaceOptions()').length - 1, 1, 'popupSurfaceOptions() is spread only into the popup');
  assert.strictEqual(main.split('surfaceStyle: resolvedSurfaceStyle()').length - 1, 0, 'no secondary init payload sends the POPUP surface');
  for (const name of ['editorWin', 'viewerWin', 'conflictWin', 'unifyWin', 'modal']) {
    assert.ok(new RegExp(`const ${name} = new BrowserWindow\\(\\{[\\s\\S]*?\\n\\s*\\}\\);\\n\\s*noteSecondarySurface\\(${name}\\);`).test(main), `${name}: its surface is noted right after it is created`);
    assert.ok(main.includes(`...windowAppearance(${name}),`), `${name}: its init payload is its own appearance (the surface it was created with)`);
  }
  assert.ok(!main.includes('surfaceStyle: secondarySurfaceStyle(),'), 'no init payload re-derives the surface from the current scope');
  assert.ok(/function secondaryGlassOn\(\) \{ return glassOn\(\) && settings\.glass_scope === 'all'; \}/.test(main), 'secondary glass = surface on AND "All windows"');
  assert.ok(/function windowAppearance\(w\)[\s\S]{0,200}w === win \? resolvedSurfaceStyle\(\) : secondarySurfaceOf\(w\)/.test(main), 'each window gets its own surface in the broadcast');
  assert.ok(/live: glassSupport\(\) !== 'vibrancy' \|\| style === 'glass'/.test(fnBody(main, 'noteSecondarySurface')), 'macOS: only a window created glass can switch live');
  assert.ok(main.includes("surfaceWindowOptions({ support: glassSupport(), on: glassOn(), solidBackground: appBackgroundColor(), live: true })"), 'the popup is the live (always transparent on macOS) window');
  assert.ok(main.includes("surfaceWindowOptions({ support: glassSupport(), on: secondaryGlassOn(), solidBackground: solidWindowColor() })"), 'a solid secondary window is opaque with the theme colour (macOS included)');
  const approval = main.slice(main.indexOf("modal.webContents.send('approval-settings'") - 400, main.indexOf("modal.webContents.send('approval-request'"));
  assert.ok(approval.includes('windowAppearance(modal)'), 'the approval modal gets the same payload as every window');
  assert.ok(!/settings\.(accent_variant|ui_density|ui_corners|ui_borders)/.test(approval), 'never the raw settings (the audit-gate bypass)');
  // Live: a surface or scope change re-applies every open window, then broadcasts.
  const applyAll = fnBody(main, 'applySurfaceToWindows');
  assert.ok(/applySurfaceToPopup\(\);[\s\S]*for \(const w of secondaryWindows\(\)\) \{[\s\S]*if \(s && !s\.live\) continue;[\s\S]*applySurfaceMaterial\(w, on\);[\s\S]*broadcastAppearance\('surface'\);/.test(applyAll), 'live re-apply, skipping macOS windows created opaque');
  const material = fnBody(main, 'applySurfaceMaterial');
  assert.ok(/setVibrancy\(on \? 'popover' : null\)/.test(material) && /setBackgroundMaterial\(on \? 'acrylic' : 'none'\)/.test(material), 'one material switch for macOS + Windows');
}

// 9) main.js: synced vs per-machine, validation in ONE place, the broadcast.
{
  const remote = fnBody(main, 'remoteSettingsPayload');
  for (const key of ['surface_style', 'glass_scope', 'ui_borders']) assert.ok(remote.includes(`delete remoteSave.${key};`), `${key} stays on this machine`);
  for (const key of ['accent_mode', 'accent_custom', 'ui_density', 'ui_corners', 'appearance_stamps']) assert.ok(!remote.includes(`delete remoteSave.${key};`), `${key} syncs`);
  assert.ok(/LOCAL_ONLY_SETTING_KEYS = new Set\(\[[^\]]*'surface_style'[^\]]*'glass_scope'/.test(main), 'surface + scope saves skip the revision bump (no sync, no list refresh)');
  assert.ok(/appearance\.mergeSyncedAppearance\(settings, remoteSettings\)\) broadcastAppearance\('sync'\)/.test(fnBody(main, 'mergeSyncedSettings')), 'another device\'s newer choice applies here and reaches every window');
  const save = main.slice(main.indexOf("ipcMain.handle('save-settings'"), main.indexOf("ipcMain.handle('set-show-shortcut'"));
  assert.ok(save.includes('appearance.applyAppearanceSettings(settings, body)'), 'save-settings validates appearance through lib/appearance.js');
  assert.ok(!/body\.(accent_variant|ui_density|ui_corners|ui_borders|surface_style|glass_scope|accent_mode)/.test(save), 'no second, hand-rolled appearance validation');
  assert.ok(/if \(surfaceChanged\) applySurfaceToWindows\(\);\s*else broadcastAppearance\('settings'\);/.test(save));
  assert.ok(/migrateAppearanceSettings\(loaded, \{ debugVariants: debugVariantsEnabled\(\) \}\)[\s\S]{0,80}\{ \.\.\.DEFAULT_SETTINGS, \.\.\.\(promoted/.test(fnBody(main, 'loadSettings')), 'the promotion runs on the file as read, before the defaults');
  const broadcast = fnBody(main, 'broadcastAppearance');
  assert.ok(/if \(signature === lastAppearanceSignature\) return false;/.test(broadcast), 'diffed: callers call it after any change');
  assert.ok(/for \(const w of BrowserWindow\.getAllWindows\(\)\)[\s\S]*send\('appearance-changed', \{ \.\.\.windowAppearance\(w\), reason \}\)/.test(broadcast), 'ONE event to every window');
  const payload = fnBody(main, 'appearanceVariantPayload');
  assert.ok(/uiBorders: debugVariantsEnabled\(\) && settings\.ui_borders === 'borderless' \? 'borderless' : 'bordered'/.test(payload), 'borders is still gated on the audit flag');
  assert.ok(/accentColor: accent\.color/.test(payload) && /systemAccent,/.test(payload), 'the resolved accent + the OS accent reach every window');
  assert.ok(/system_accent: systemAccent,\s*appearance: appearanceVariantPayload\(\),/.test(main), 'runtime_info exposes the appearance');
  // OS accent: read per device, followed live on both platforms.
  const watch = fnBody(main, 'watchSystemAccent');
  assert.ok(/systemPreferences\.on\('accent-color-changed'/.test(watch), 'Windows: accent-color-changed');
  assert.ok(/subscribeNotification\('AppleColorPreferencesChangedNotification'/.test(watch), 'macOS: the colour-preferences notification');
  assert.ok(/subscribeLocalNotification\('NSSystemColorsDidChangeNotification'/.test(watch), 'macOS: AppKit system colours changed');
  const readAccent = fnBody(main, 'readSystemAccent');
  assert.ok(/windowsDwm\.readAccentColor\(\)[\s\S]*normalizeAccentHex\(systemPreferences\.getAccentColor\(\)\)/.test(readAccent),
    'Windows reads the accent Settings writes first, Electron (macOS, or a Windows fallback) second');
  assert.ok(/setTimeout\(\(\) => refreshSystemAccent\(/.test(watch) && /nativeTheme\.on\('updated'/.test(watch), 'a late re-read + nativeTheme updates');
  assert.ok(/watchSystemAccent\(\);\s*createPopup\(\);/.test(main), 'the accent is known before the first window opens');
  // Theme: every window follows the OS scheme, not only the popup.
  assert.ok(/for \(const w of BrowserWindow\.getAllWindows\(\)\)[\s\S]*send\('color-scheme-changed', scheme\)/.test(fnBody(main, 'notifyColorSchemeChanged')));
}

// 10) Every window's preload can subscribe.
for (const file of ['preload.js', 'editor-preload.js', 'viewer-preload.js', 'mcp-approval-preload.js']) {
  const src = read(file);
  assert.ok(/onAppearanceChanged: \(callback\) => \{[\s\S]{0,120}ipcRenderer\.on\('appearance-changed', listener\);[\s\S]{0,120}removeListener\('appearance-changed', listener\)/.test(src), `${file} exposes onAppearanceChanged`);
}

console.log('appearance tests passed');
