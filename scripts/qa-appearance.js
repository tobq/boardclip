// node scripts/qa-appearance.js
// Sandbox proof for the main-process appearance plumbing, against this
// checkout in an isolated, cloaked instance (scripts/lib/qa-sandbox.js; no
// window reaches the desktop, nothing touches the real clipboard):
//  0. Windows + Solid with the kill switch BOARDCLIP_SOLID_FADE=0 keeps the
//     plain slide (no alpha call, never layered); the fade is the default
//     (recorded clean on screen 2026-10-08), so the steps below turn it back on;
//  1. open fade, Windows + Solid: the window alpha rises 0 -> 1 on the slide's
//     ease, then the window is NOT layered any more (WS_EX_LAYERED cleared,
//     alpha 255, Electron opacity 1) at its resting place;
//  2. a close mid-fade leaves it un-layered too;
//  3. Windows + glass keeps the unchanged path (no alpha call, never layered,
//     the 10 px slide); reduced motion skips slide and fade;
//  4. glass scope: an editor opened under "Popup only" is solid (DWM backdrop
//     not acrylic, init surface 'solid'); "All windows" gives open windows the
//     acrylic live plus an appearance-changed saying glass, new windows are
//     created glass, and "Popup only" puts them back;
//  5. appearance-changed: one event per window per real change (accent preset,
//     custom colour, OS accent change), none for an invalid or unchanged save;
//     the approval modal gets the same payload.
// Frame recordings of the fade are a separate step on an idle machine.
'use strict';
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const qa = require('./lib/qa-sandbox');

const IS_WIN = process.platform === 'win32';
const { check, summary } = qa.createChecks();
const item = { id: qa.txtId('appearance proof clip\nsecond line'), type: 'text', text: 'appearance proof clip\nsecond line', ts: 1788000000, pin: null };

// Main-process recorders: the fade's alpha calls, the popup's positions, the
// material switches and the appearance-related sends to every window.
const SETUP = `(() => {
  const path = __qa.require('path');
  const { BrowserWindow } = __qa.electron;
  const dwm = __qa.require(path.join(__qa.root, 'lib', 'windows-dwm.js'));
  const rec = globalThis.__rec = { alpha: [], clear: [], pos: [], sends: [], material: [] };
  const popup = globalThis.__popup = () => BrowserWindow.getAllWindows().find((w) => /index\\.html/.test(w.webContents.getURL()));
  const byPage = globalThis.__byPage = (re) => BrowserWindow.getAllWindows().filter((w) => re.test(w.webContents.getURL()));
  const page = (w) => (w.webContents.getURL() || '').split('/').pop();
  for (const name of ['setWindowAlpha', 'clearLayered']) {
    const orig = dwm[name];
    dwm[name] = (w, ...rest) => { const r = orig(w, ...rest); (name === 'setWindowAlpha' ? rec.alpha : rec.clear).push({ t: Date.now(), popup: w === popup(), a: rest[0], ok: r.ok }); return r; };
  }
  const wrap = (obj, name, log) => { const orig = obj[name]; obj[name] = function (...args) { const r = orig.apply(this, args); try { log(this, args); } catch {} return r; }; };
  wrap(BrowserWindow.prototype, 'setPosition', (w, a) => { if (w === popup()) rec.pos.push({ t: Date.now(), x: a[0], y: a[1] }); });
  wrap(BrowserWindow.prototype, 'setBackgroundMaterial', (w, a) => rec.material.push({ page: page(w), m: a[0] }));
  wrap(Object.getPrototypeOf(popup().webContents), 'send', (wc, a) => {
    if (/^(appearance-changed|editor-init|viewer-init|approval-settings|surface-changed)$/.test(a[0])) rec.sends.push({ t: Date.now(), page: (wc.getURL() || '').split('/').pop(), ch: a[0], p: a[1] });
  });
  if (process.platform === 'win32') {
    const koffi = __qa.require('koffi');
    const getAttr = koffi.load('dwmapi.dll').func('int32 __stdcall DwmGetWindowAttribute(uintptr_t hwnd, uint32 attr, _Out_ int32 *value, uint32 size)');
    // DWMWA_SYSTEMBACKDROP_TYPE: 0 auto, 1 none, 2 mica, 3 acrylic, 4 tabbed.
    globalThis.__backdrop = (w) => { const out = [0]; return getAttr(dwm.hwndFromHandle(w.getNativeWindowHandle()), 38, out, 4) === 0 ? out[0] : null; };
  } else {
    globalThis.__backdrop = () => null;
  }
  globalThis.__state = (w) => ({ layered: dwm.layeredState(w), opacity: w.getOpacity(), bounds: w.getBounds(), backdrop: __backdrop(w) });
  globalThis.__reset = () => { for (const k of Object.keys(rec)) rec[k].length = 0; return true; };
  globalThis.__toggle = () => (__qa.electron.app.emit('second-instance', {}, [], process.cwd()), true);
  return true;
})()`;

(async () => {
  let sb = null;
  const facts = {};
  try {
    sb = await qa.launch({
      name: 'appearance',
      ai: true,
      settings: { groups: ['AI'], surface_style: 'solid', ai_approval_timeout_sec: 60 },
      history: [{ ...item, pin: { groups: ['AI'] } }],
    });
    const popupPage = await sb.popup();
    await popupPage.waitFor('!!(window.api && window.api.onAppearanceChanged)', 'popup preload');
    await qa.waitFor(() => sb.mainEval(`__qa.electron.BrowserWindow.getAllWindows().some((x) => /index\\.html/.test(x.webContents.getURL()) && x.isVisible())`), 'popup parked', 20000);
    await sb.mainEval(SETUP);
    const rec = () => sb.mainEval('__rec');
    const popupState = () => sb.mainEval('__state(__popup())');
    const isOpen = () => sb.mainEval(`(() => { const w = __popup(); return w.isVisible() && !!w.webContents; })()`);
    const save = (body) => popupPage.eval(`window.api.saveSettings(${JSON.stringify(body)}).then(() => true)`);
    const listen = (page, api) => page.eval(`(window.__looks = [], window.${api}.onAppearanceChanged((l) => window.__looks.push(l)), true)`);
    const looks = (page) => page.eval('window.__looks');
    const closePopup = async () => {
      // The second launch toggles: open -> close. Opened state = a recent show.
      await sb.mainEval('__toggle()');
      await qa.sleep(350);
    };
    await listen(popupPage, 'api');
    const rt = (await popupPage.eval('window.api.getSettings()')).runtime_info;
    facts.runtime = { appearance: rt.appearance, system_accent: rt.system_accent, surface_style: rt.surface_style, secondary_surface_style: rt.secondary_surface_style };
    check('runtime_info carries the appearance payload + the OS accent', rt.appearance && rt.appearance.accentMode === 'system' && 'systemAccent' in rt.appearance && rt.secondary_surface_style === 'solid',
      JSON.stringify(facts.runtime).slice(0, 150));
    if (IS_WIN) {
      // The accent Settings writes (0xAABBGGRR); Electron's getAccentColor is
      // DWM's blended colorization colour, recorded for comparison only.
      const reg = spawnSync('reg', ['query', 'HKCU\\Software\\Microsoft\\Windows\\DWM', '/v', 'AccentColor'], { encoding: 'utf8', windowsHide: true });
      const m = /0x([0-9a-f]{1,8})/i.exec(reg.stdout || '');
      const n = m ? parseInt(m[1], 16) >>> 0 : null;
      facts.settingsAccent = n == null ? null : `#${[n & 0xff, (n >>> 8) & 0xff, (n >>> 16) & 0xff].map((c) => c.toString(16).padStart(2, '0')).join('')}`;
      facts.electronAccent = await sb.mainEval('__qa.electron.systemPreferences.getAccentColor()');
      check('the OS accent is the one Settings shows', !facts.settingsAccent || rt.system_accent === facts.settingsAccent, `${rt.system_accent} vs Settings ${facts.settingsAccent} (Electron: ${facts.electronAccent})`);
    }

    // ---- 0. Windows + Solid with the kill switch: the plain slide, no fade ----
    if (IS_WIN) {
      await sb.mainEval(`(process.env.BOARDCLIP_SOLID_FADE = '0', true)`);
      await sb.mainEval('__reset()');
      await sb.mainEval('__toggle()');
      await qa.sleep(450);
      const r0 = await rec();
      const st0 = await popupState();
      const ys0 = r0.pos.map((p) => p.y);
      check('solid open, kill switch: no alpha call', r0.alpha.filter((x) => x.popup).length === 0);
      check('solid open, kill switch: never layered, opacity 1, the 10 px slide', st0.layered && st0.layered.layered === false && st0.opacity === 1
        && ys0.length >= 3 && ys0[0] === st0.bounds.y + 10 && ys0[ys0.length - 1] === st0.bounds.y, JSON.stringify({ l: st0.layered, n: ys0.length }));
      await closePopup();
      await sb.mainEval(`(process.env.BOARDCLIP_SOLID_FADE = '1', true)`);
    }

    // ---- 1. open fade, Windows + Solid (the default) ----
    await sb.mainEval('__reset()');
    await sb.mainEval('__toggle()');
    await qa.sleep(450);
    let r = await rec();
    let st = await popupState();
    const fade = r.alpha.filter((x) => x.popup);
    if (IS_WIN) {
      const alphas = fade.map((x) => x.a);
      const rising = alphas.every((a, i) => i === 0 || a >= alphas[i - 1]);
      check('solid open: alpha starts at 0 (set while still cloaked)', alphas[0] === 0, alphas.slice(0, 4).map((a) => a.toFixed(2)).join(','));
      check('solid open: alpha rises to exactly 1 on the slide ease', rising && alphas[alphas.length - 1] === 1 && alphas.length >= 4, `${alphas.length} steps, last ${alphas[alphas.length - 1]}`);
      const span = fade.length ? fade[fade.length - 1].t - fade[0].t : 0;
      check('solid open: fade lasts the slide (~130 ms)', span >= 100 && span <= 400, `${span} ms`);
      check('solid open: every alpha call succeeded', fade.every((x) => x.ok));
      check('solid open: WS_EX_LAYERED cleared at the end', r.clear.some((x) => x.popup && x.ok) && st.layered && st.layered.layered === false && st.layered.alpha === 255, JSON.stringify(st.layered));
      check('solid open: Electron opacity is 1', st.opacity === 1, st.opacity);
      const ys = r.pos.map((p) => p.y);
      check('solid open: slid up 10 px into its resting place', ys.length >= 3 && ys[0] === st.bounds.y + 10 && ys[ys.length - 1] === st.bounds.y, ys.slice(0, 3).concat(['..', ys[ys.length - 1]]).join(','));
      check('solid popup has no acrylic backdrop', st.backdrop !== 3, `backdrop ${st.backdrop}`);
    } else {
      check('macOS: setWindowAlpha is never used (setOpacity path)', fade.length === 0);
    }
    check('popup open', await isOpen());

    // ---- 2. a close mid-fade ----
    await closePopup();
    await sb.mainEval('__reset()');
    await sb.mainEval(`(__toggle(), new Promise((res) => setTimeout(() => { __toggle(); res(true); }, 35)))`);
    await qa.sleep(400);
    r = await rec();
    st = await popupState();
    if (IS_WIN) {
      const alphas = r.alpha.filter((x) => x.popup).map((x) => x.a);
      check('mid-fade close: the fade was cut short', alphas.length > 0 && alphas[alphas.length - 1] < 1, alphas.map((a) => a.toFixed(2)).join(','));
      check('mid-fade close: the parked window is not left layered', st.layered && st.layered.layered === false, JSON.stringify(st.layered));
    }

    // ---- 3. glass keeps the unchanged path; reduced motion ----
    await sb.mainEval('__reset()');
    await save({ surface_style: 'glass' });
    await qa.sleep(250);
    r = await rec();
    st = await popupState();
    const glassSupported = (await popupPage.eval('window.api.getSettings()')).runtime_info.surface_supported;
    facts.glassSupported = glassSupported;
    if (IS_WIN && glassSupported) {
      check('surface -> glass: popup material switched to acrylic live', r.material.some((x) => x.page === 'index.html' && x.m === 'acrylic') && st.backdrop === 3, `backdrop ${st.backdrop}`);
      check('surface -> glass: surface-changed + appearance-changed reach the popup', r.sends.some((x) => x.page === 'index.html' && x.ch === 'surface-changed' && x.p === 'glass')
        && r.sends.some((x) => x.page === 'index.html' && x.ch === 'appearance-changed' && x.p.surfaceStyle === 'glass'));
      await sb.mainEval('__reset()');
      await sb.mainEval('__toggle()');
      await qa.sleep(450);
      r = await rec();
      st = await popupState();
      const ys = r.pos.map((p) => p.y);
      check('glass open: no alpha call (a layered window drops the acrylic)', r.alpha.filter((x) => x.popup).length === 0);
      check('glass open: never layered, opacity 1, acrylic intact', st.layered && st.layered.layered === false && st.opacity === 1 && st.backdrop === 3, JSON.stringify({ l: st.layered, b: st.backdrop }));
      check('glass open: the unchanged 10 px slide', ys.length >= 3 && ys[0] === st.bounds.y + 10 && ys[ys.length - 1] === st.bounds.y, `${ys.length} positions`);
      await closePopup();
    }
    // Reduced motion: neither slide nor fade, on either surface.
    await sb.mainEval(`(globalThis.__anim = __qa.electron.systemPreferences.getAnimationSettings, __qa.electron.systemPreferences.getAnimationSettings = () => ({ prefersReducedMotion: true, shouldRenderRichAnimation: true, scrollAnimationsEnabledBySystem: true }), true)`);
    for (const surface of ['glass', 'solid']) {
      await save({ surface_style: surface });
      await qa.sleep(150);
      await sb.mainEval('__reset()');
      await sb.mainEval('__toggle()');
      await qa.sleep(350);
      r = await rec();
      st = await popupState();
      const ys = r.pos.map((p) => p.y);
      check(`reduced motion (${surface}): straight to the resting place, no fade`, r.alpha.filter((x) => x.popup).length === 0 && ys.every((y) => y === st.bounds.y) && st.opacity === 1
        && (!IS_WIN || (st.layered && !st.layered.layered)), `positions ${ys.join(',')}`);
      await closePopup();
    }
    await sb.mainEval(`(__qa.electron.systemPreferences.getAnimationSettings = __anim, true)`);

    // ---- 4. glass scope ----
    await save({ surface_style: 'glass' });
    await qa.sleep(150);
    await sb.mainEval('__toggle()'); // open, so the editor opens from a live popup
    await qa.sleep(350);
    await sb.mainEval('__reset()');
    const ed1 = await sb.newPage(/editor\.html/, () => popupPage.eval('window.api.newNote({ keepPopup: true }).then(() => true)'), { label: 'editor 1' });
    await ed1.waitFor('!!(window.editorApi && window.editorApi.onAppearanceChanged)', 'editor preload');
    await qa.waitFor(async () => (await rec()).sends.some((x) => x.ch === 'editor-init'), 'editor-init', 10000);
    await qa.sleep(200);
    await listen(ed1, 'editorApi');
    r = await rec();
    const init1 = r.sends.find((x) => x.ch === 'editor-init').p;
    const edState = () => sb.mainEval('__state(__byPage(/editor\\.html/)[0])');
    st = await edState();
    check('scope popup: editor init payload says solid', init1.surfaceStyle === 'solid' && init1.glassScope === 'popup' && init1.accentMode === 'system', JSON.stringify({ s: init1.surfaceStyle, g: init1.glassScope }));
    check('scope popup: the editor page renders solid', (await ed1.eval(`document.documentElement.getAttribute('data-surface')`)) === 'solid');
    if (IS_WIN) check('scope popup: the editor window has no acrylic backdrop', st.backdrop !== 3, `backdrop ${st.backdrop}`);
    await sb.mainEval('__reset()');
    await popupPage.eval('(window.__looks = [], true)');
    await save({ glass_scope: 'all' });
    await qa.sleep(300);
    r = await rec();
    st = await edState();
    let edLooks = await looks(ed1);
    let popLooks = await looks(popupPage);
    if (IS_WIN && glassSupported) check('scope all: the open editor gets the acrylic live', r.material.some((x) => x.page === 'editor.html' && x.m === 'acrylic') && st.backdrop === 3, `backdrop ${st.backdrop}`);
    check('scope all: ONE appearance-changed to the editor, saying glass', edLooks.length === 1 && edLooks[0].surfaceStyle === (glassSupported ? 'glass' : 'solid') && edLooks[0].glassScope === 'all', JSON.stringify(edLooks.map((l) => [l.surfaceStyle, l.glassScope])));
    check('scope all: ONE appearance-changed to the popup', popLooks.length === 1 && popLooks[0].glassScope === 'all' && popLooks[0].surfaceStyle === (glassSupported ? 'glass' : 'solid'));
    await sb.mainEval('__reset()');
    const ed2 = await sb.newPage(/editor\.html/, () => popupPage.eval('window.api.newNote({ keepPopup: true }).then(() => true)'), { label: 'editor 2' });
    await qa.waitFor(async () => (await rec()).sends.some((x) => x.ch === 'editor-init'), 'editor-init 2', 10000);
    r = await rec();
    const init2 = r.sends.find((x) => x.ch === 'editor-init').p;
    check('scope all: a new editor is created glass', init2.surfaceStyle === (glassSupported ? 'glass' : 'solid'));
    if (IS_WIN && glassSupported) {
      const b2 = await sb.mainEval('__byPage(/editor\\.html/).map((w) => __backdrop(w))');
      check('scope all: the new editor has the acrylic from creation (no live switch)', b2.every((b) => b === 3) && !r.material.some((x) => x.page === 'editor.html'), JSON.stringify(b2));
    }
    await sb.mainEval('__reset()');
    await ed1.eval('(window.__looks = [], true)');
    await save({ glass_scope: 'popup' });
    await qa.sleep(300);
    edLooks = await looks(ed1);
    const backs = await sb.mainEval('__byPage(/editor\\.html/).map((w) => __backdrop(w))');
    check('scope back to popup: editors solid again', edLooks.length === 1 && edLooks[0].surfaceStyle === 'solid' && (!IS_WIN || backs.every((b) => b !== 3)), JSON.stringify(backs));
    await ed1.eval('(window.__looks = [], true)');
    await save({ glass_scope: 'popup' });
    await save({ glass_scope: 'everything' });
    await qa.sleep(200);
    check('an unchanged or invalid save sends nothing', (await looks(ed1)).length === 0);
    ed2.close();

    // ---- 5. accent broadcasts ----
    await popupPage.eval('(window.__looks = [], true)');
    await ed1.eval('(window.__looks = [], true)');
    await save({ accent_mode: 'teal' });
    await qa.sleep(200);
    edLooks = await looks(ed1);
    popLooks = await looks(popupPage);
    check('accent teal: one event per window', edLooks.length === 1 && popLooks.length === 1 && edLooks[0].accentMode === 'teal' && edLooks[0].accentVariant === 'teal' && edLooks[0].accentColor === null);
    await save({ accent_mode: 'custom', accent_custom: '#FF8800' });
    await qa.sleep(200);
    edLooks = await looks(ed1);
    check('custom accent: normalised colour reaches the windows', edLooks.length === 2 && edLooks[1].accentColor === '#ff8800' && edLooks[1].accentCustom === '#ff8800', JSON.stringify(edLooks[1] && edLooks[1].accentColor));
    await save({ accent_mode: 'purple', accent_custom: 'orange', ui_density: 'huge' });
    await qa.sleep(200);
    check('invalid accent / density values: no event', (await looks(ed1)).length === 2);
    await save({ accent_mode: 'system', ui_density: 'compact', ui_corners: 'sharp' });
    await qa.sleep(200);
    edLooks = await looks(ed1);
    const last = edLooks[edLooks.length - 1];
    check('system accent + density + corners in one event', edLooks.length === 3 && last.accentMode === 'system' && last.accentColor === rt.system_accent && last.uiDensity === 'compact' && last.uiCorners === 'sharp');
    // Every window RENDERS the same values from that payload (the popup used to
    // gate them behind the debug flag while the editor applied them).
    const attrs = `['data-accent', 'data-density', 'data-corners', 'data-borders'].map((a) => document.documentElement.getAttribute(a))`;
    const popAttrs = await popupPage.eval(attrs);
    const edAttrs = await ed1.eval(attrs);
    check('popup and editor render the same accent / density / corners / borders', JSON.stringify(popAttrs) === JSON.stringify(edAttrs) && popAttrs[1] === 'compact' && popAttrs[2] === 'sharp', JSON.stringify({ popAttrs, edAttrs }));
    // The colour itself (Core.applyAppearance): a Custom accent paints the
    // contrast-checked shade for the window's theme, with its ink, in the popup
    // and the editor alike; back on a preset the inline colour is cleared.
    const painted = `(() => { const r = document.documentElement, s = getComputedStyle(r); return { theme: r.getAttribute('data-theme'), accent: s.getPropertyValue('--accent').trim(), ink: s.getPropertyValue('--active-fg').trim(), data: r.getAttribute('data-accent'), inline: r.style.getPropertyValue('--accent-custom-dark') }; })()`;
    for (const color of ['#ffb900', '#1a1a6e']) {
      await save({ accent_mode: 'custom', accent_custom: color });
      await qa.sleep(250);
      const pop = await popupPage.eval(painted);
      const ed = await ed1.eval(painted);
      const want = await popupPage.eval(`window.BoardClipCore.accentShades(${JSON.stringify(color)})`);
      const exp = want[pop.theme === 'light' ? 'light' : 'dark'];
      check(`custom ${color}: popup + editor paint the ${pop.theme} shade and its ink`, pop.data === 'custom' && pop.accent === exp.accent && pop.ink === exp.ink
        && ed.accent === pop.accent && ed.ink === pop.ink, JSON.stringify({ pop, ed: ed.accent, exp }));
    }
    await save({ accent_mode: 'teal' });
    await qa.sleep(250);
    const teal = await ed1.eval(painted);
    check('a preset clears the inline accent colour', teal.data === 'teal' && teal.inline === '', JSON.stringify(teal));
    await save({ accent_mode: 'system' });
    await qa.sleep(250);
    // OS accent change, simulated on the real event path (Windows reads the
    // accent through windows-dwm, so that read is what changes).
    const DWM = `__qa.require(__qa.require('path').join(__qa.root, 'lib', 'windows-dwm.js'))`;
    await sb.mainEval(`(globalThis.__accent = ${DWM}.readAccentColor, ${DWM}.readAccentColor = () => '#ff0000', ${IS_WIN ? "__qa.electron.systemPreferences.emit('accent-color-changed', {}, 'ff0000ff')" : '0'}, true)`);
    if (IS_WIN) {
      await qa.sleep(200);
      edLooks = await looks(ed1);
      popLooks = await looks(popupPage);
      const e = edLooks[edLooks.length - 1];
      check('OS accent change: every window hears it', e.systemAccent === '#ff0000' && e.accentColor === '#ff0000' && popLooks[popLooks.length - 1].systemAccent === '#ff0000' && e.reason === 'system-accent');
      await sb.mainEval(`(${DWM}.readAccentColor = __accent, __qa.electron.systemPreferences.emit('accent-color-changed', {}, ''), true)`);
      await qa.sleep(200);
      check('OS accent restored', (await looks(ed1)).slice(-1)[0].systemAccent === rt.system_accent);
    }
    const onDisk = JSON.parse(fs.readFileSync(path.join(sb.dataDir, 'clipboard-settings.json'), 'utf8'));
    check('settings file: synced choices stamped, scope per machine, no accent_variant', onDisk.accent_mode === 'system' && onDisk.ui_density === 'compact'
      && onDisk.appearance_stamps && onDisk.appearance_stamps.accent > 0 && onDisk.appearance_stamps.density > 0 && onDisk.glass_scope === 'popup' && !('accent_variant' in onDisk),
      JSON.stringify(onDisk.appearance_stamps));

    // ---- approval modal: same payload, follows the broadcast ----
    const clip = (await sb.historyState()).find((i) => i.id === item.id);
    await sb.mainEval('__reset()');
    let req = null;
    const modal = await sb.newPage(/mcp-approval\.html/, () => {
      req = sb.mcp('delete_clip', { id: clip.id, expected_rev: clip.rev }, { client: 'appearance proof', timeoutMs: 30000 }).then(() => 'unexpected success', (e) => e.message);
    }, { label: 'approval modal', timeoutMs: 15000 });
    await qa.waitFor(async () => (await rec()).sends.some((x) => x.ch === 'approval-settings'), 'approval-settings', 15000);
    r = await rec();
    const ap = r.sends.find((x) => x.ch === 'approval-settings').p;
    check('approval: the shared payload (+ the resolved theme)', ap.accentMode === 'system' && ap.surfaceStyle === 'solid' && ap.accentVariant === 'blue' && ap.uiDensity === 'compact' && ap.uiCorners === 'sharp' && /^(light|dark)$/.test(ap.theme), JSON.stringify({ m: ap.accentMode, s: ap.surfaceStyle, a: ap.accentVariant, d: ap.uiDensity, t: ap.theme }));
    await modal.waitFor('!!(window.approval && window.approval.onAppearanceChanged)', 'approval preload');
    await listen(modal, 'approval');
    await save({ glass_scope: 'all' });
    await qa.sleep(300);
    const mLooks = await looks(modal);
    check('approval: hears appearance-changed', mLooks.length === 1 && mLooks[0].glassScope === 'all');
    if (IS_WIN && glassSupported) check('approval: glass under "All windows"', (await sb.mainEval('__byPage(/mcp-approval\\.html/).map((w) => __backdrop(w))'))[0] === 3);
    await save({ glass_scope: 'popup' });
    modal.close();
    await sb.mainEval(`(__byPage(/mcp-approval\\.html/).forEach((w) => w.close()), true)`);
    facts.approvalResult = await req;
    check('approval: closing the modal denies, the clip stays', (await sb.historyState()).some((i) => i.id === item.id), facts.approvalResult);
    ed1.close();

    const events = await sb.events();
    check('sandbox: no paste, no clipboard write, no focus taken', !events.some((e) => /paste_blocked|clipboard_write|start_drag_blocked/.test(e.type)), JSON.stringify(events.map((e) => e.type)).slice(0, 150));
  } catch (error) {
    check('run completed', false, error.message);
  } finally {
    if (sb) {
      const cleanup = await sb.finish();
      check('sandbox cleaned up', cleanup.ok, (cleanup.problems || []).join('; '));
    }
    console.log(JSON.stringify(facts));
    const s = summary();
    process.exitCode = s.failed ? 1 : 0;
  }
})();
