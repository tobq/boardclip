'use strict';

// Sandbox QA for the popup header, the flat search field and the options panel
// (UI overhaul B + D3), against the REAL popup of a throwaway instance
// (scripts/lib/qa-sandbox.js: isolated data + profile, cloaked never-focused
// windows, no OS clipboard), driven over CDP with real mouse events:
// - a click on a non-control header pixel focuses the search;
// - a press-move-release across the header moves the window (main's bounds
//   follow the pointer) and focuses nothing; double-click maximises nothing;
// - the field: placeholder per focus, buttons revealed per state, flat style;
// - the options panel: tune opens it, facet chips write tokens, its bottom
//   handle resizes it live, the height persists (local-only setting) and a
//   double-click resets it, Esc closes it before anything else, and every
//   popup open starts with it shut;
// - the icon font is the vendored file: loaded, no Google Fonts request, and
//   icons render as glyphs (not ligature words) with Google Fonts blocked;
// - review fixes: closed reveals cost no width, a press whose release is lost
//   stops at the next buttonless move, window-drag deltas are clamped, a drag
//   during the open slide is not pulled back, Enter / Space on the tune toggle
//   and the chips activate them (never a paste) and keep the chip focused,
//   nothing in the panel takes the field's focus, Esc gives it back, and the
//   autocomplete never covers the panel or outlives its text;
// - search modes: Basic words are literal, filters are pills (connective,
//   x, right-click exclude), a click cycles the mode (Basic -> Regex keeps
//   the text, -> Advanced shows the query), hover lists the modes and names
//   what a switch would remove, a lossy switch offers Undo, Alt+R cycles, a
//   touch tap lists, a key / "Since..." chip outside Advanced asks for its
//   value (refusing a bad one in place), Regex flags a broken pattern.
//
// Usage: node scripts/qa-popup-header.js

const qa = require('./lib/qa-sandbox');

const { check, summary } = qa.createChecks();
const sleep = qa.sleep;
const J = JSON.stringify;

async function main() {
  const now = Math.floor(Date.now() / 1000);
  const history = [];
  for (let i = 0; i < 40; i += 1) history.push({ type: 'text', text: i % 5 === 0 ? `https://example.com/page/${i}` : `qa header clip ${i}`, ts: now - i * 60 });
  for (const it of history) it.id = qa.txtId(it.text);
  const sb = await qa.launch({ name: 'header', history, settings: { surface_style: 'solid' } });
  let ok = false;
  try {
    // Block Google Fonts for the whole session BEFORE the popup page loads its
    // fonts: the icons must still render (the font is vendored).
    const popup = await sb.openPopup({ focus: true });
    await popup.send('Network.enable').catch(() => {});
    await popup.send('Network.setBlockedURLs', { urls: ['*fonts.googleapis.com*', '*fonts.gstatic.com*'] }).catch(() => {});
    const requests = [];
    popup.on('Network.requestWillBeSent', (p) => requests.push(p.request && p.request.url));
    await popup.send('Page.reload', { ignoreCache: true });
    await sleep(500);
    await popup.waitFor(`!!(window.api && document.querySelectorAll('.item').length >= 10)`, 'popup rows');
    await popup.fontsReady(8000);

    // --- icon font (D3) -------------------------------------------------------
    const font = await popup.eval(`(async () => {
      await document.fonts.load('16px "Material Symbols Rounded"', 'settings');
      const face = [...document.fonts].find((f) => /Material Symbols Rounded/.test(f.family));
      const gear = document.querySelector('#settingsBtn .mi').getBoundingClientRect();
      return { status: face && face.status, check: document.fonts.check('16px "Material Symbols Rounded"', 'settings'), gearW: Math.round(gear.width) };
    })()`);
    check('icon font: the vendored face is loaded', font.status === 'loaded' && font.check, J(font));
    check('icon font: the gear renders as a glyph (no ligature word)', font.gearW > 0 && font.gearW <= 20, `gear width ${font.gearW}px`);
    check('icon font: nothing requested from Google Fonts', !requests.some((u) => /fonts\.(googleapis|gstatic)\.com/.test(u || '')), requests.filter((u) => /font/.test(u || '')).join(' ') || 'no font requests');

    // --- the field ------------------------------------------------------------
    const fieldState = () => popup.eval(`(() => {
      const s = document.getElementById('search');
      const open = (n) => document.querySelector('.bc-reveal[data-reveal="' + n + '"]').classList.contains('open');
      const row = getComputedStyle(document.querySelector('.search-row'));
      return { focused: document.activeElement === s, placeholder: s.placeholder, clear: open('clear'), sort: open('sort'), tools: open('tools'),
        bg: row.backgroundColor, border: row.borderTopWidth + ' ' + row.borderBottomWidth, shadow: row.boxShadow,
        phFill: getComputedStyle(s, '::placeholder').webkitTextFillColor, inputW: Math.round(s.getBoundingClientRect().width),
        rightGap: Math.round((document.querySelector('.search-row').getBoundingClientRect().right - s.getBoundingClientRect().right) * 10) / 10 };
    })()`);
    await popup.eval(`(document.getElementById('search').blur(), true)`);
    await sleep(300);
    const idle = await fieldState();
    check('field idle: "Click here to search..." placeholder, no buttons', idle.placeholder === 'Click here to search...' && !idle.clear && !idle.sort && !idle.tools, J(idle));
    check('field idle: the placeholder is painted (not transparent)', idle.phFill && !/rgba\(0, 0, 0, 0\)|transparent/.test(idle.phFill), idle.phFill);
    check('field idle: the text takes the full row (closed reveals leave no gap)', idle.rightGap === 0, `${idle.rightGap}px right of the input`);
    check('field: flat (no fill, no border) with a hairline underline', /rgba\(0, 0, 0, 0\)|transparent/.test(idle.bg) && idle.border === '0px 0px' && /inset/.test(idle.shadow), J({ bg: idle.bg, border: idle.border, shadow: idle.shadow }));

    // A real click on a non-control header pixel (the item count) focuses the search.
    const count = await popup.centerOf('#count');
    await popup.mouse('mouseMoved', count.x, count.y);
    await popup.mouse('mousePressed', count.x, count.y, { button: 'left', buttons: 1, clickCount: 1 });
    await popup.mouse('mouseReleased', count.x, count.y, { button: 'left', buttons: 0, clickCount: 1 });
    await sleep(350);
    const focused = await fieldState();
    check('header click focuses the search', focused.focused, J(focused));
    check('field focused: "Search..." placeholder, mode + options revealed', focused.placeholder === 'Search...' && focused.tools && !focused.clear && !focused.sort, J(focused));
    check('field idle -> focused: the input gave up width for the revealed buttons', focused.inputW < idle.inputW, `${idle.inputW} -> ${focused.inputW}`);
    await popup.eval(`(() => { const s = document.getElementById('search'); s.value = 'clip'; s.dispatchEvent(new Event('input', { bubbles: true })); return true; })()`);
    await sleep(250);
    const typed = await fieldState();
    check('field with a query: clear + sort revealed too', typed.clear && typed.sort && typed.tools, J(typed));
    const clearBtn = await popup.eval(`(() => { const b = document.getElementById('searchClear'); return { tab: b.tabIndex }; })()`);
    check('clear button is out of the Tab order', clearBtn.tab === -1, J(clearBtn));
    await popup.click('#searchClear');
    await sleep(300);
    const cleared = await fieldState();
    check('clear empties the field and keeps the focus in it', cleared.focused && !cleared.clear && cleared.tools && (await popup.eval(`document.getElementById('search').value`)) === '', J(cleared));
    // The checks below type the language's tokens: Advanced (saved, so reloads keep it;
    // the search-mode section sets its own).
    await popup.eval(`(searchBox.setMode('advanced'), true)`);

    // --- window drag ------------------------------------------------------------
    const bounds = () => sb.mainEval(`(() => { const w = __qa.electron.BrowserWindow.getAllWindows().find((x) => /index\\.html/.test(x.webContents.getURL())); return w.getBounds(); })()`);
    await popup.eval(`(document.getElementById('search').blur(), true)`);
    await sleep(200);
    const before = await bounds();
    const at = await popup.centerOf('#count');
    // CDP has no screen coordinates: a single move of (+40, +30) client px is a
    // (+40, +30) screen delta while the window has not moved yet; the release at
    // the same client point carries no further move.
    await popup.mouse('mouseMoved', at.x, at.y);
    await popup.mouse('mousePressed', at.x, at.y, { button: 'left', buttons: 1, clickCount: 1 });
    await popup.mouse('mouseMoved', at.x + 2, at.y + 1, { button: 'left', buttons: 1 });
    await popup.mouse('mouseMoved', at.x + 40, at.y + 30, { button: 'left', buttons: 1 });
    await sleep(300);
    const during = await bounds();
    await popup.mouse('mouseReleased', at.x + 40, at.y + 30, { button: 'left', buttons: 0, clickCount: 1 });
    await sleep(300);
    const after = await bounds();
    const focusAfterDrag = await popup.eval(`document.activeElement === document.body`);
    check('header drag moves the window by the pointer delta', during.x - before.x === 40 && during.y - before.y === 30, `${J(before)} -> ${J(during)}`);
    check('header drag keeps the window size', after.width === before.width && after.height === before.height, `${J(before)} -> ${J(after)}`);
    check('header drag focuses nothing (no click after a drag)', focusAfterDrag, await popup.eval(`document.activeElement && (document.activeElement.id || document.activeElement.tagName)`));
    // A press whose release never arrives ends at the next move with no button held:
    // a hover never drags the window.
    const ghostStart = await bounds();
    await popup.mouse('mousePressed', at.x, at.y, { button: 'left', buttons: 1, clickCount: 1 });
    await popup.mouse('mouseMoved', at.x + 30, at.y + 20, { button: 'left', buttons: 1 });
    await sleep(250);
    const ghostDuring = await bounds();
    await popup.mouse('mouseMoved', at.x + 90, at.y + 5, { button: 'none', buttons: 0 });
    await sleep(250);
    const ghostAfter = await bounds();
    await popup.mouse('mouseReleased', at.x + 90, at.y + 5, { button: 'left', buttons: 0, clickCount: 1 });
    await sleep(200);
    check('a lost release: the next buttonless move ends the drag (no hover drag)', ghostDuring.x - ghostStart.x === 30 && J(ghostAfter) === J(ghostDuring), `${J(ghostStart)} -> ${J(ghostDuring)} -> ${J(ghostAfter)}`);
    // main clamps a renderer's delta (the window stays on the desktop, same size)
    // and ignores an unknown phase.
    const clampStart = await bounds();
    await popup.eval(`(window.api.windowDrag('start', 0, 0), window.api.windowDrag('move', 1e12, 5), true)`);
    await sleep(250);
    const far = await bounds();
    await popup.eval(`(window.api.windowDrag('bogus', -5000, -5000), true)`);
    await sleep(200);
    const afterBogus = await bounds();
    await popup.eval(`(window.api.windowDrag('end', 0, 0), true)`);
    const desk = await sb.mainEval(`(() => { const ds = __qa.electron.screen.getAllDisplays(); return { right: Math.max(...ds.map((d) => d.bounds.x + d.bounds.width)) }; })()`);
    check('window-drag clamps a huge delta: the window stays reachable at its size', far.x > clampStart.x && far.x <= desk.right - 48 && far.width === clampStart.width && far.height === clampStart.height,
      `${J(clampStart)} -> ${J(far)} (desktop right ${desk.right})`);
    check('window-drag ignores an unknown phase', J(afterBogus) === J(far), J(afterBogus));
    await sb.mainEval(`(() => { const w = __qa.electron.BrowserWindow.getAllWindows().find((x) => /index\\.html/.test(x.webContents.getURL())); w.setBounds(${J(clampStart)}); return true; })()`);
    await sleep(150);
    // Below the 4 px slop: a click, not a move.
    const slopStart = await bounds();
    await popup.mouse('mousePressed', at.x, at.y, { button: 'left', buttons: 1, clickCount: 1 });
    await popup.mouse('mouseMoved', at.x + 3, at.y + 1, { button: 'left', buttons: 1 });
    await popup.mouse('mouseReleased', at.x + 3, at.y + 1, { button: 'left', buttons: 0, clickCount: 1 });
    await sleep(300);
    const slopEnd = await bounds();
    check('a press that moves <= 4 px is a click (no move, search focused)', slopEnd.x === slopStart.x && slopEnd.y === slopStart.y && await popup.eval(`document.activeElement.id === 'search'`), `${J(slopStart)} -> ${J(slopEnd)}`);
    // The EMPTY search field is header too: a drag on it moves the window, a
    // click focuses it. With text in it, a drag selects text and never moves.
    await popup.eval(`(document.getElementById('search').blur(), true)`);
    await sleep(150);
    const fAt = await popup.centerOf('#search');
    const fStart = await bounds();
    await popup.mouse('mousePressed', fAt.x, fAt.y, { button: 'left', buttons: 1, clickCount: 1 });
    await popup.mouse('mouseMoved', fAt.x + 2, fAt.y + 1, { button: 'left', buttons: 1 });
    await popup.mouse('mouseMoved', fAt.x + 25, fAt.y + 15, { button: 'left', buttons: 1 });
    await sleep(300);
    const fDuring = await bounds();
    await popup.mouse('mouseReleased', fAt.x + 25, fAt.y + 15, { button: 'left', buttons: 0, clickCount: 1 });
    await sleep(250);
    check('a drag on the empty search field moves the window', fDuring.x - fStart.x === 25 && fDuring.y - fStart.y === 15, `${J(fStart)} -> ${J(fDuring)}`);
    await sb.mainEval(`(() => { const w = __qa.electron.BrowserWindow.getAllWindows().find((x) => /index\\.html/.test(x.webContents.getURL())); w.setBounds(${J(fStart)}); return true; })()`);
    await popup.eval(`(document.getElementById('search').blur(), true)`);
    await sleep(150);
    await popup.mouse('mousePressed', fAt.x, fAt.y, { button: 'left', buttons: 1, clickCount: 1 });
    await popup.mouse('mouseReleased', fAt.x, fAt.y, { button: 'left', buttons: 0, clickCount: 1 });
    await sleep(250);
    check('a click on the empty search field focuses it', await popup.eval(`document.activeElement.id === 'search'`), await popup.eval(`document.activeElement.id || document.activeElement.tagName`));
    await popup.eval(`(() => { const s = document.getElementById('search'); s.value = 'hello world'; s.dispatchEvent(new Event('input', { bubbles: true })); return true; })()`);
    await sleep(200);
    const tStart = await bounds();
    const tAt = await popup.centerOf('#search');
    const textLeft = await popup.eval(`(() => { const r = document.getElementById('search').getBoundingClientRect(); return Math.round(r.left + 4); })()`);
    await popup.mouse('mousePressed', textLeft, tAt.y, { button: 'left', buttons: 1, clickCount: 1 });
    await popup.mouse('mouseMoved', textLeft + 20, tAt.y, { button: 'left', buttons: 1 });
    await popup.mouse('mouseMoved', textLeft + 40, tAt.y + 10, { button: 'left', buttons: 1 });
    await sleep(250);
    const tDuring = await bounds();
    await popup.mouse('mouseReleased', textLeft + 40, tAt.y + 10, { button: 'left', buttons: 0, clickCount: 1 });
    await sleep(200);
    const sel = await popup.eval(`(() => { const s = document.getElementById('search'); return s.selectionEnd - s.selectionStart; })()`);
    check('with text in the field a drag selects text and never moves the window', J(tStart) === J(tDuring) && sel > 0, J({ tStart, tDuring, sel }));
    await popup.eval(`(() => { const s = document.getElementById('search'); s.value = ''; s.dispatchEvent(new Event('input', { bubbles: true })); return true; })()`);
    await sleep(150);
    // Double-click on the header: no maximise (only a focus).
    await popup.mouse('mousePressed', at.x, at.y, { button: 'left', buttons: 1, clickCount: 1 });
    await popup.mouse('mouseReleased', at.x, at.y, { button: 'left', buttons: 0, clickCount: 1 });
    await popup.mouse('mousePressed', at.x, at.y, { button: 'left', buttons: 1, clickCount: 2 });
    await popup.mouse('mouseReleased', at.x, at.y, { button: 'left', buttons: 0, clickCount: 2 });
    await sleep(300);
    const dbl = await bounds();
    const maximized = await sb.mainEval(`__qa.electron.BrowserWindow.getAllWindows().find((x) => /index\\.html/.test(x.webContents.getURL())).isMaximized()`);
    check('double-click on the header does not maximise', !maximized && dbl.width === slopEnd.width && dbl.height === slopEnd.height, J(dbl));
    // A header control still works (it is not a drag area): the settings gear.
    await popup.click('#settingsBtn');
    await sleep(300);
    const settingsOpen = await popup.eval(`document.getElementById('settingsView').classList.contains('show')`);
    check('header buttons still click through', settingsOpen);
    // The settings header drags too.
    const sAt = await popup.centerOf('#settingsView .settings-hdr h2');
    const sBefore = await bounds();
    await popup.mouse('mousePressed', sAt.x, sAt.y, { button: 'left', buttons: 1, clickCount: 1 });
    await popup.mouse('mouseMoved', sAt.x - 25, sAt.y + 12, { button: 'left', buttons: 1 });
    await sleep(250);
    const sDuring = await bounds();
    await popup.mouse('mouseReleased', sAt.x - 25, sAt.y + 12, { button: 'left', buttons: 0, clickCount: 1 });
    check('settings header drag moves the window', sDuring.x - sBefore.x === -25 && sDuring.y - sBefore.y === 12, `${J(sBefore)} -> ${J(sDuring)}`);
    await popup.click('#settingsBack');
    await sleep(250);

    // --- options panel ----------------------------------------------------------
    const panel = () => popup.eval(`(() => {
      const p = document.getElementById('searchOpts');
      const sc = p.querySelector('.search-opts-scroll');
      const b = document.getElementById('searchOptsBtn');
      return { open: p.classList.contains('open'), inert: p.inert, hidden: p.getAttribute('aria-hidden'), expanded: b.getAttribute('aria-expanded'),
        lit: b.classList.contains('active'), h: Math.round(sc.getBoundingClientRect().height), content: sc.scrollHeight,
        win: window.innerHeight, fadeBottom: sc.style.getPropertyValue('--fade-bottom'), fadeTop: sc.style.getPropertyValue('--fade-top') };
    })()`);
    await popup.eval(`(document.getElementById('search').focus(), true)`);
    await sleep(250);
    await popup.click('#searchOptsBtn');
    await sleep(500);
    const p1 = await panel();
    check('tune opens the panel (open, not inert, aria-expanded, lit)', p1.open && !p1.inert && p1.hidden === 'false' && p1.expanded === 'true' && p1.lit, J(p1));
    check('panel default height ~40 % of the popup', Math.abs(p1.h - Math.round(p1.win * 0.4)) <= 2 || p1.h === p1.content, `${p1.h}px of ${p1.win}px (content ${p1.content})`);
    check('panel shows a bottom fade while more is below, none at the top', p1.content > p1.h ? p1.fadeBottom === '24px' && p1.fadeTop === '0px' : true, J({ top: p1.fadeTop, bottom: p1.fadeBottom }));
    // A facet chip writes its token; the toggle stays lit while it is in the query.
    await popup.click('.facet-opt[data-row="0"][data-opt="1"]');
    await sleep(250);
    const q1 = await popup.eval(`document.getElementById('search').value`);
    check('a facet chip writes its token into the query', q1 === 'since:7d', q1);
    await popup.click('.facet-opt[data-row="0"][data-opt="1"]');
    await sleep(200);
    check('the same chip again removes it', (await popup.eval(`document.getElementById('search').value`)) === '');
    // Resize: drag the handle up by 30 px (live), then persist. The panel is
    // compact, so 30 px under its content is already a scroller.
    const hAt = await popup.centerOf('.search-opts-resize');
    await popup.mouse('mouseMoved', hAt.x, hAt.y);
    await popup.mouse('mousePressed', hAt.x, hAt.y, { button: 'left', buttons: 1, clickCount: 1 });
    await popup.mouse('mouseMoved', hAt.x, hAt.y - 15, { button: 'left', buttons: 1 });
    await popup.mouse('mouseMoved', hAt.x, hAt.y - 30, { button: 'left', buttons: 1 });
    await sleep(200);
    const live = await panel();
    await popup.mouse('mouseReleased', hAt.x, hAt.y - 30, { button: 'left', buttons: 0, clickCount: 1 });
    await sleep(500);
    check('the handle resizes the panel live', live.h === p1.h - 30, `${p1.h} -> ${live.h}`);
    const saved = await popup.eval(`window.api.getSettings().then((s) => s.options_panel_height)`);
    check('the new height is saved per machine (options_panel_height)', saved === p1.h - 30, String(saved));
    const pShort = await panel();
    check('a panel shorter than its content fades its bottom edge', pShort.content > pShort.h && pShort.fadeBottom === '24px' && pShort.fadeTop === '0px', J(pShort));
    await popup.eval(`(() => { const sc = document.querySelector('.search-opts-scroll'); sc.scrollTop = sc.scrollHeight; sc.dispatchEvent(new Event('scroll')); return true; })()`);
    await sleep(250);
    const pEnd = await panel();
    check('at the end of the panel: top fade on, bottom fade off', pEnd.fadeTop === '24px' && pEnd.fadeBottom === '0px', J({ top: pEnd.fadeTop, bottom: pEnd.fadeBottom }));
    // Clamp: never below 80 px.
    const h2 = await popup.centerOf('.search-opts-resize');
    await popup.mouse('mousePressed', h2.x, h2.y, { button: 'left', buttons: 1, clickCount: 1 });
    await popup.mouse('mouseMoved', h2.x, h2.y - 500, { button: 'left', buttons: 1 });
    await sleep(200);
    const tiny = await panel();
    await popup.mouse('mouseReleased', h2.x, h2.y - 500, { button: 'left', buttons: 0, clickCount: 1 });
    await sleep(400);
    check('the panel never shrinks below 80 px', tiny.h === 80, String(tiny.h));
    // Esc closes the panel before anything else (the popup stays open).
    await popup.eval(`document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))`);
    await sleep(300);
    const afterEsc = await panel();
    const stillOpen = await sb.mainEval(`__qa.electron.BrowserWindow.getAllWindows().some((w) => /index\\.html/.test(w.webContents.getURL()) && w.isVisible())`);
    check('Esc closes the panel first (popup still open)', !afterEsc.open && afterEsc.inert && stillOpen, J({ afterEsc, stillOpen }));
    // Reopen: the saved height comes back; then a popup reset closes it.
    await popup.eval(`(document.getElementById('search').focus(), true)`);
    await popup.click('#searchOptsBtn');
    await sleep(400);
    const reopened = await panel();
    check('reopened panel keeps the saved height', reopened.open && reopened.h === 80, String(reopened.h));
    await popup.eval(`(window.resetPopupState(), true)`);
    await sleep(300);
    const reset = await panel();
    check('every popup open starts with the panel shut', !reset.open && reset.inert && reset.expanded === 'false', J(reset));
    // Keyboard on the field's controls: native activation, never a paste.
    const pastes = () => sb.mainEval(`__qa.events.filter((e) => e.type === 'paste_blocked' || e.type === 'clipboard_write').length`);
    const key = async (k, code, vk) => {
      await popup.send('Input.dispatchKeyEvent', { type: 'rawKeyDown', key: k, code, windowsVirtualKeyCode: vk });
      // A real key press also types its character: a button activates on it (Enter's keypress).
      if (k === ' ' || k === 'Enter') await popup.send('Input.dispatchKeyEvent', { type: 'char', text: k === 'Enter' ? '\r' : ' ' });
      await popup.send('Input.dispatchKeyEvent', { type: 'keyUp', key: k, code, windowsVirtualKeyCode: vk });
    };
    const activeDesc = () => popup.eval(`(() => { const a = document.activeElement; if (!a) return null; if (a.classList.contains('facet-opt')) return 'chip ' + a.dataset.row + '/' + a.dataset.opt; return a.id || a.tagName; })()`);
    const searchValue = () => popup.eval(`document.getElementById('search').value`);
    const pasteBase = await pastes();
    await popup.eval(`(document.getElementById('search').focus(), true)`);
    await sleep(300);
    await popup.eval(`(document.getElementById('searchOptsBtn').focus(), true)`);
    await key('Enter', 'Enter', 13);
    await sleep(400);
    const kb1 = await panel();
    check('Enter on the focused tune toggle opens the panel (no paste)', kb1.open && (await pastes()) === pasteBase, J({ open: kb1.open, pastes: (await pastes()) - pasteBase }));
    await popup.eval(`(document.querySelector('.facet-opt[data-row="0"][data-opt="1"]').focus(), true)`);
    await key('Enter', 'Enter', 13);
    await sleep(300);
    const kbEnter = { q: await searchValue(), active: await activeDesc(), pastes: (await pastes()) - pasteBase };
    check('Enter on a focused chip writes its token and keeps the focus on it (no paste)', kbEnter.q === 'since:7d' && kbEnter.active === 'chip 0/1' && kbEnter.pastes === 0, J(kbEnter));
    await key(' ', 'Space', 32);
    await sleep(300);
    const kbSpace = { q: await searchValue(), active: await activeDesc(), pastes: (await pastes()) - pasteBase };
    check('Space on the focused chip toggles it off, focus kept (no paste)', kbSpace.q === '' && kbSpace.active === 'chip 0/1' && kbSpace.pastes === 0, J(kbSpace));
    await key('Escape', 'Escape', 27);
    await sleep(300);
    const kbEsc = { open: (await panel()).open, active: await activeDesc() };
    check('Esc with the focus in the panel closes it and gives the field the focus back', !kbEsc.open && kbEsc.active === 'search', J(kbEsc));
    // The autocomplete never covers the panel, nor survives a change of its text.
    const suggestRows = () => popup.eval(`document.querySelector('.search-suggest').classList.contains('hidden') ? 0 : document.querySelectorAll('.search-suggest-item').length`);
    await popup.send('Input.insertText', { text: 'is:' });
    await sleep(250);
    const sugBefore = await suggestRows();
    await popup.click('#searchOptsBtn');
    await sleep(400);
    const sugAfter = await suggestRows();
    check('opening the panel closes the autocomplete (it would cover the chip rows)', sugBefore > 0 && sugAfter === 0 && (await panel()).open && (await activeDesc()) === 'search', J({ sugBefore, sugAfter }));
    await popup.eval(`(() => { const s = document.getElementById('search'); s.value = ''; s.dispatchEvent(new Event('input', { bubbles: true })); return true; })()`);
    // A finished value offers nothing (Forge rule), so the stale list is the one
    // for a key still being typed after it.
    await popup.send('Input.insertText', { text: '-is:image ti' });
    await sleep(250);
    const sugStale = await suggestRows();
    await popup.click('.facet-opt[title="is:url"]');
    await sleep(300);
    const chipQ = await searchValue();
    check('a chip click drops suggestions computed for the old text', sugStale > 0 && (await suggestRows()) === 0 && /(^| )is:url( |$)/.test(chipQ) && /(^| )-is:image( |$)/.test(chipQ) && !/s:image/.test(chipQ.replace('-is:image', '')), J({ sugStale, q: chipQ }));
    // Nothing in the panel takes the field's focus: a click on the notes line.
    await popup.click('.opts-notes');
    await sleep(200);
    check('a click on the panel\'s notes line keeps the field focused', (await activeDesc()) === 'search', await activeDesc());
    // A key chip puts its prefix on the end of the query for typing, the field
    // focused and the autocomplete on that key's values (num: = the keys 1-9).
    await popup.eval(`(() => { const s = document.getElementById('search'); s.value = 'plan'; s.dispatchEvent(new Event('input', { bubbles: true })); return true; })()`);
    await sleep(150);
    await popup.click('.opts-field[data-insert="num:"]');
    await sleep(300);
    const keyQ = await searchValue();
    const keySug = await suggestRows();
    check('a key chip adds its prefix, keeps the field focused and suggests its values', keyQ === 'plan num:' && (await activeDesc()) === 'search' && keySug > 0, J({ keyQ, keySug }));
    await popup.eval(`(() => { const s = document.getElementById('search'); s.value = ''; s.dispatchEvent(new Event('input', { bubbles: true })); return true; })()`);
    await popup.eval(`(window.resetPopupState(), true)`);
    await sleep(300);
    // A restart (fresh page) restores the saved height from settings.
    await popup.send('Page.reload', { ignoreCache: true });
    await sleep(600);
    await popup.waitFor(`!!(window.api && document.querySelectorAll('.item').length >= 10)`, 'popup rows after reload');
    await sleep(400);
    await popup.eval(`(document.getElementById('search').focus(), true)`);
    await sleep(300); // the options toggle slides in on focus
    await popup.click('#searchOptsBtn');
    await sleep(400);
    const restored = await panel();
    check('after a reload the saved height is restored', restored.open && restored.h === 80, String(restored.h));
    // Double-click on the handle resets to the default share.
    const h3 = await popup.centerOf('.search-opts-resize');
    await popup.mouse('mousePressed', h3.x, h3.y, { button: 'left', buttons: 1, clickCount: 1 });
    await popup.mouse('mouseReleased', h3.x, h3.y, { button: 'left', buttons: 0, clickCount: 1 });
    await popup.mouse('mousePressed', h3.x, h3.y, { button: 'left', buttons: 1, clickCount: 2 });
    await popup.mouse('mouseReleased', h3.x, h3.y, { button: 'left', buttons: 0, clickCount: 2 });
    await sleep(500);
    const resetH = await panel();
    const savedReset = await popup.eval(`window.api.getSettings().then((s) => s.options_panel_height)`);
    check('double-click on the handle resets the height (saved as 0)', savedReset === 0 && (Math.abs(resetH.h - Math.round(resetH.win * 0.4)) <= 2 || resetH.h === resetH.content), `${resetH.h}px, saved ${savedReset}`);

    // --- the reveal ANIMATES (Forge's measurement rule: drive the transition's
    // own clock, a frame-starved page reads the start value) -----------------
    // The saved search mode applies from the first open (not only after Settings),
    // and a mode past Basic keeps the mode chip revealed (and lit) on an idle field.
    await popup.eval(`window.api.saveSettings({ search_mode: 'regex' })`);
    await popup.send('Page.reload', { ignoreCache: true });
    await sleep(600);
    await popup.waitFor(`!!(window.api && document.querySelectorAll('.item').length >= 10)`, 'popup rows after reload');
    await sleep(400);
    await popup.eval(`(document.getElementById('search').blur(), true)`);
    await sleep(300);
    const rx = await popup.eval(`({ mode: searchBox.getMode(), active: document.getElementById('modeBtn').classList.contains('active'), tools: document.querySelector('.bc-reveal[data-reveal="tools"]').classList.contains('open'), focused: document.activeElement === document.getElementById('search') })`);
    check('a saved search mode applies from the first open and keeps its chip revealed', rx.mode === 'regex' && rx.active && rx.tools && !rx.focused, J(rx));
    await popup.eval(`window.api.saveSettings({ search_mode: 'basic' })`); // the product default (an idle Basic field reveals nothing)
    await popup.send('Page.reload', { ignoreCache: true });
    await sleep(600);
    await popup.waitFor(`!!(window.api && document.querySelectorAll('.item').length >= 10)`, 'popup rows after reload');
    await sleep(300);
    const osReduced = await popup.eval(`matchMedia('(prefers-reduced-motion: reduce)').matches`);
    const motion = (value) => popup.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value }, { name: 'prefers-color-scheme', value: 'dark' }] });
    await motion('no-preference');
    await popup.eval(`(window.resetPopupState(), true)`); // the open panel holds the tools revealed
    await sleep(300);
    await popup.eval(`(document.getElementById('search').blur(), true)`);
    await sleep(400);
    const ramp = await popup.eval(`(() => {
      const r = document.querySelector('.bc-reveal[data-reveal="tools"]');
      document.getElementById('search').focus();
      // The inner's content-visibility (allow-discrete) is visible for every
      // moment after the start; settle it so the frozen width ramp measures
      // the contents, as every real frame after the first does.
      for (const x of r.querySelector('.bc-reveal-inner').getAnimations()) if (x.transitionProperty === 'content-visibility') x.finish();
      const a = r.getAnimations().find((x) => x.transitionProperty === 'grid-template-columns');
      if (!a) return { animation: false };
      a.pause();
      const widths = [0, 40, 80, 130].map((t) => { a.currentTime = t; return Math.round(r.getBoundingClientRect().width * 10) / 10; });
      a.finish();
      return { animation: true, widths, end: Math.round(r.getBoundingClientRect().width) };
    })()`);
    const rising = ramp.animation && ramp.widths[0] === 0 && ramp.widths[1] > 0 && ramp.widths[1] < ramp.widths[2] && ramp.widths[2] <= ramp.end && ramp.end > 40;
    check('the shared reveal animates its width (0 -> open, not a snap)', rising, J(ramp));
    // Reduced motion: the same reveal is instant (the one --dur switch).
    await motion('reduce');
    await popup.eval(`(document.getElementById('search').blur(), true)`);
    await sleep(300);
    const instant = await popup.eval(`(() => {
      const r = document.querySelector('.bc-reveal[data-reveal="tools"]');
      document.getElementById('search').focus();
      const running = r.getAnimations().filter((x) => x.transitionProperty === 'grid-template-columns' && x.effect.getTiming().duration > 0).length;
      return { running, width: Math.round(r.getBoundingClientRect().width) };
    })()`);
    check('reduced motion: the reveal is instant', instant.running === 0 && instant.width > 40, J({ ...instant, osReduced }));
    await motion('no-preference');

    // --- a header drag during the open slide: the slide settles, the drag wins --
    const W = `__qa.electron.BrowserWindow.getAllWindows().find((x) => /index\\.html/.test(x.webContents.getURL()))`;
    const slideRun = (withDrag) => sb.mainEval(`new Promise((resolve) => {
      const w = ${W};
      const { ipcMain, app } = __qa.electron;
      const trace = [];
      w.webContents.executeJavaScript('window.api.hidePopup()').then(() => setTimeout(() => {
        app.emit('second-instance', {}, [], process.cwd());
        const t0 = Date.now();
        const iv = setInterval(() => { trace.push([Date.now() - t0, w.getBounds().y]); }, 5);
        if (${withDrag}) setTimeout(() => {
          ipcMain.emit('window-drag', { sender: w.webContents }, 'start', 0, 0);
          ipcMain.emit('window-drag', { sender: w.webContents }, 'move', 0, 40);
        }, 25);
        setTimeout(() => {
          const final = w.getBounds();
          if (${withDrag}) ipcMain.emit('window-drag', { sender: w.webContents }, 'end', 0, 0);
          clearInterval(iv);
          resolve({ final, trace });
        }, 400);
      }, 600));
    })`, { timeoutMs: 10000 });
    // The popup opens at the REAL cursor (the owner may be using the machine),
    // so both opens get one pinned cursor point, restored afterwards.
    await sb.mainEval(`(() => { const s = __qa.electron.screen; s.__qaCursor = s.getCursorScreenPoint; const b = s.getPrimaryDisplay().workArea; s.getCursorScreenPoint = () => ({ x: Math.round(b.x + b.width / 2), y: Math.round(b.y + b.height / 3) }); return true; })()`);
    const slidePlain = await slideRun(false);
    const slideDrag = await slideRun(true);
    await sb.mainEval(`(() => { const s = __qa.electron.screen; if (s.__qaCursor) { s.getCursorScreenPoint = s.__qaCursor; delete s.__qaCursor; } return true; })()`);
    const pulledBack = slideDrag.trace.filter(([t, y]) => t >= 40 && y !== slidePlain.final.y + 40);
    check('a drag during the open slide moves from the resting place and is never pulled back', slideDrag.final.y === slidePlain.final.y + 40 && pulledBack.length === 0,
      J({ rest: slidePlain.final.y, final: slideDrag.final.y, off: pulledBack.slice(0, 5) }));

    // --- search modes: the chip, pills, switches, Undo, touch, Alt+R ----------
    // (the checks above run in Advanced; the product default is Basic)
    const typeIt = (v) => popup.eval(`(() => { const s = document.getElementById('search'); s.focus(); s.value = ${J(v)}; s.setSelectionRange(s.value.length, s.value.length); s.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText' })); return true; })()`);
    const modeState = () => popup.eval(`(() => {
      const b = document.getElementById('modeBtn');
      const pills = [...document.querySelectorAll('.search-pills .search-pill')].map((p) => p.textContent.replace(/close$/, ''));
      return { mode: searchBox.getMode(), query: searchBox.getQuery(), app: query, field: document.getElementById('search').value, active: b.classList.contains('active'), icon: b.querySelector('.mi').textContent,
        pills, pillsShown: !document.querySelector('.search-pills').hidden, prefix: !!document.querySelector('.search-hl .qh-prefix'), menu: !!document.querySelector('.mode-menu'),
        rows: [...document.querySelectorAll('.mode-menu [data-mode]')].map((r) => ({ m: r.dataset.mode, on: r.getAttribute('aria-checked'), hint: (r.querySelector('.bc-menu-hint') || {}).textContent || '' })) };
    })()`);
    await popup.eval(`(searchBox.closeOptions({ instant: true }), clearSearchAndFilters(), searchBox.setMode('basic'), true)`);
    await sleep(150);
    await typeIt('rm -rf group:x');
    await sleep(150);
    let ms = await modeState();
    check('Basic: the words are literal (quoted where they look like syntax), nothing painted as a key', ms.mode === 'basic' && ms.query === 'rm "-rf" "group:x"' && ms.app === ms.query && !ms.prefix && !ms.active && ms.icon === 'text_fields', J(ms));
    await popup.eval(`(searchBox.openOptions(), true)`);
    await sleep(400);
    await popup.click('#searchOpts .facet-opt[data-row="0"][data-opt="0"]');
    await sleep(200);
    ms = await modeState();
    check('Basic: a panel chip adds a pill after the text; the typed text stays', ms.query === 'rm "-rf" "group:x" since:24h' && ms.field === 'rm -rf group:x' && ms.pillsShown && J(ms.pills) === J(['since:24h']), J(ms));
    await popup.click('#searchOpts .facet-opt[data-row="1"][data-opt="0"]');
    await popup.click('#searchOpts .facet-opt[data-row="1"][data-opt="1"]');
    await sleep(200);
    ms = await modeState();
    check('two values of one kind: ONE pill with "or" (written is:text OR is:url)', /is:text OR is:url/.test(ms.query) && ms.pills.some((p) => /^is:text\s*or\s*url$/.test(p)), J(ms));
    await popup.click('.search-pills .pill-conn');
    await sleep(200);
    ms = await modeState();
    check('the pill\'s connective flips to "and" (written side by side)', /is:text is:url/.test(ms.query) && !/ OR /.test(ms.query) && ms.pills.some((p) => /^is:text\s*and\s*url$/.test(p)), J(ms));
    const textValue = await popup.centerOf('.search-pills .pill-value[data-value="text"]');
    await popup.mouse('mousePressed', textValue.x, textValue.y, { button: 'right', buttons: 2, clickCount: 1 });
    await popup.mouse('mouseReleased', textValue.x, textValue.y, { button: 'right', buttons: 0, clickCount: 1 });
    await sleep(200);
    ms = await modeState();
    check('right-click a pill value: excluded (its own pill)', /-is:text/.test(ms.query) && ms.pills.includes('-is:text'), J(ms));
    await popup.click('.search-pills .search-pill[title="since:24h"] .pill-x');
    await sleep(200);
    ms = await modeState();
    check('a pill\'s x removes it', !/since:/.test(ms.query) && !ms.pills.includes('since:24h'), J(ms));
    await popup.eval(`(searchBox.closeOptions({ instant: true }), true)`);
    // A click cycles: Basic -> Regex (the text stays, read as a pattern) -> Advanced (the query as it is).
    await popup.click('#modeBtn');
    await sleep(250);
    ms = await modeState();
    check('click: Basic -> Regex keeps the typed text and reads it as one pattern', ms.mode === 'regex' && ms.field === 'rm -rf group:x' && ms.query.startsWith('/rm -rf group:x/') && ms.active && ms.icon === 'regular_expression', J(ms));
    await popup.click('#modeBtn');
    await sleep(250);
    ms = await modeState();
    check('click: Regex -> Advanced shows the whole query (the format is learned)', ms.mode === 'advanced' && ms.field === ms.query && ms.field.startsWith('/rm -rf group:x/') && /-is:text/.test(ms.field) && !ms.pillsShown && ms.icon === 'data_object', J(ms));
    const savedMode = await popup.eval(`window.api.getSettings().then((s) => s.search_mode)`);
    check('the mode is saved per device', savedMode === 'advanced', String(savedMode));
    // Hover lists the modes; a switch that would remove part of the search says what, and offers Undo.
    await typeIt('(a OR b) c');
    await sleep(150);
    const chip = await popup.centerOf('#modeBtn');
    await popup.mouse('mouseMoved', chip.x - 30, chip.y + 60);
    await popup.mouse('mouseMoved', chip.x, chip.y);
    await sleep(450);
    ms = await modeState();
    const basicRow = ms.rows.find((r) => r.m === 'basic') || {};
    check('hover lists the three modes, the current one ticked', ms.menu && J(ms.rows.map((r) => r.m)) === J(['basic', 'regex', 'advanced']) && (ms.rows.find((r) => r.m === 'advanced') || {}).on === 'true', J(ms.rows));
    check('the list names what a switch would remove', /removes \(a OR b\)/.test(basicRow.hint), J(basicRow));
    await popup.click('.mode-menu [data-mode="basic"]');
    await sleep(250);
    ms = await modeState();
    const undo = await popup.eval(`(() => { const t = document.getElementById('toast'); return { show: t.classList.contains('show'), text: t.textContent, btn: !!t.querySelector('.toast-action') }; })()`);
    check('a lossy switch removes the custom part and offers Undo', ms.mode === 'basic' && ms.query === 'c' && undo.show && undo.btn && /removed \(a OR b\)/.test(undo.text), J({ ms, undo }));
    await popup.click('#toast .toast-action');
    await sleep(250);
    ms = await modeState();
    check('Undo brings the mode and the search back', ms.mode === 'advanced' && ms.field === '(a OR b) c' && ms.query === '(a OR b) c', J(ms));
    await popup.mouse('mouseMoved', chip.x - 30, chip.y + 120);
    await sleep(450);
    check('the hover list closes when the pointer leaves', !(await modeState()).menu);
    // Alt+R cycles (Cmd+Option+R on macOS), Shift goes back.
    await popup.eval(`(document.getElementById('search').focus(), clearSearchAndFilters(), true)`);
    const altR = async (shift) => {
      const mods = 1 | (shift ? 8 : 0);
      await popup.send('Input.dispatchKeyEvent', { type: 'rawKeyDown', modifiers: mods, key: 'r', code: 'KeyR', windowsVirtualKeyCode: 82 });
      await popup.send('Input.dispatchKeyEvent', { type: 'keyUp', modifiers: mods, key: 'r', code: 'KeyR', windowsVirtualKeyCode: 82 });
      await sleep(150);
      return (await modeState()).mode;
    };
    const r1 = await altR(false);
    const r2 = await altR(true);
    check('Alt+R cycles the mode, Alt+Shift+R goes back', r1 === 'basic' && r2 === 'advanced', `${r1} -> ${r2}`);
    // Touch (no hover): a tap lists the modes instead of cycling.
    await popup.eval(`(() => { const b = document.getElementById('modeBtn'); b.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, pointerType: 'touch' })); b.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true })); return true; })()`);
    await sleep(200);
    ms = await modeState();
    check('a touch tap lists the modes and changes nothing', ms.menu && ms.mode === 'advanced', J({ menu: ms.menu, mode: ms.mode }));
    await popup.eval(`(document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })), true)`);
    await sleep(150);
    // Outside Advanced a key chip asks for its value (the field is not syntax there).
    await popup.eval(`(searchBox.setMode('basic'), clearSearchAndFilters(), searchBox.openOptions(), true)`);
    await sleep(400);
    await popup.click('#searchOpts .opts-field[data-insert="title:"]');
    await sleep(300);
    const asked = await popup.eval(`(() => { const o = [...document.querySelectorAll('.overlay.show')].find((x) => x.querySelector('.prompt-input')); return o ? { title: o.querySelector('h3').textContent, ph: o.querySelector('.prompt-input').placeholder } : null; })()`);
    check('Basic: a key chip asks for its value (no syntax typed)', asked && asked.title === 'Title contains' && /phrase/.test(asked.ph), J(asked));
    await popup.eval(`(() => { const o = [...document.querySelectorAll('.overlay.show')].find((x) => x.querySelector('.prompt-input')); o.querySelector('.prompt-input').value = 'hello world'; o.querySelector('[data-x="yes"]').click(); return true; })()`);
    await sleep(250);
    ms = await modeState();
    check('the answer lands as a pill', ms.query === 'title:"hello world"' && ms.pills.includes('title:"hello world"'), J(ms));
    await popup.click('#searchOpts .facet-opt[data-row="0"][data-opt="3"]');
    await sleep(300);
    const sinceAsk = await popup.eval(`(() => { const o = [...document.querySelectorAll('.overlay.show')].find((x) => x.querySelector('.prompt-input')); if (!o) return null; o.querySelector('.prompt-input').value = 'soon'; o.querySelector('[data-x="yes"]').click(); const err = o.querySelector('.prompt-error'); return { title: o.querySelector('h3').textContent, err: err.hidden ? '' : err.textContent, open: o.classList.contains('show') }; })()`);
    check('"Since..." asks; a value that is not a time is refused in place', sinceAsk && sinceAsk.title === 'Since when?' && sinceAsk.open && /not a time/.test(sinceAsk.err), J(sinceAsk));
    await popup.eval(`(() => { const o = [...document.querySelectorAll('.overlay.show')].find((x) => x.querySelector('.prompt-input')); o.querySelector('.prompt-input').value = '3d'; o.querySelector('[data-x="yes"]').click(); return true; })()`);
    await sleep(250);
    const sinceChip = await popup.eval(`(() => { const b = document.querySelector('#searchOpts .facet-opt[data-row="0"][data-opt="3"]'); return { text: b.textContent.trim(), on: b.classList.contains('active') }; })()`);
    ms = await modeState();
    check('"Since..." lights with its value once answered', /since:3d/.test(ms.query) && sinceChip.on && sinceChip.text === 'Since 3d', J({ q: ms.query, sinceChip }));
    await popup.eval(`(searchBox.closeOptions({ instant: true }), true)`);
    // Regex: a broken pattern is flagged once typing pauses.
    await popup.eval(`(searchBox.setMode('regex'), clearSearchAndFilters(), true)`);
    await typeIt('[a');
    await sleep(900);
    const rxHint = await popup.eval(`(() => { const h = document.querySelector('.search-hint'); return { show: h.classList.contains('show'), text: h.textContent }; })()`);
    check('Regex: a broken pattern shows its error', rxHint.show && /regular expression/.test(rxHint.text), J(rxHint));
    await popup.eval(`(clearSearchAndFilters(), searchBox.setMode('advanced'), true)`);
    await sleep(150);

    // --- the website demo: same shell, click focuses, drag is a no-op ----------
    const site = await qa.startStaticServer(require('path').join(qa.ROOT, 'site'));
    try {
      const page = await sb.openWindow(site.url, { width: 1280, height: 900 });
      await page.waitFor(`document.readyState === 'complete' && !!document.getElementById('demo-search')`, 'site loaded');
      await page.fontsReady(8000);
      await page.eval(`(document.getElementById('demo-window').scrollIntoView({ block: 'center' }), true)`);
      await sleep(300);
      const gear = await page.eval(`Math.round(document.querySelector('#demo-settings-button .mi').getBoundingClientRect().width)`);
      check('demo: icons render from the vendored font', gear > 0 && gear <= 20, `gear ${gear}px`);
      const dc = await page.centerOf('#clip-count');
      const winBefore = await sb.mainEval(`__qa.electron.BrowserWindow.getAllWindows().find((w) => /127\\.0\\.0\\.1/.test(w.webContents.getURL())).getBounds()`);
      await page.mouse('mousePressed', dc.x, dc.y, { button: 'left', buttons: 1, clickCount: 1 });
      await page.mouse('mouseMoved', dc.x + 40, dc.y + 20, { button: 'left', buttons: 1 });
      await page.mouse('mouseReleased', dc.x + 40, dc.y + 20, { button: 'left', buttons: 0, clickCount: 1 });
      await sleep(250);
      const winAfter = await sb.mainEval(`__qa.electron.BrowserWindow.getAllWindows().find((w) => /127\\.0\\.0\\.1/.test(w.webContents.getURL())).getBounds()`);
      check('demo: a header drag is a no-op (focus unchanged, window unmoved)', J(winBefore) === J(winAfter) && await page.eval(`document.activeElement.id !== 'demo-search'`), `${J(winBefore)} -> ${J(winAfter)}`);
      await page.mouse('mousePressed', dc.x, dc.y, { button: 'left', buttons: 1, clickCount: 1 });
      await page.mouse('mouseReleased', dc.x, dc.y, { button: 'left', buttons: 0, clickCount: 1 });
      await sleep(300);
      check('demo: a header click focuses the search', await page.eval(`document.activeElement.id === 'demo-search' && document.getElementById('demo-search').placeholder === 'Search...'`));
      await page.click('#searchOptsBtn');
      await sleep(400);
      const dp = await page.eval(`(() => { const p = document.getElementById('searchOpts'); return { open: p.classList.contains('open'), h: Math.round(p.querySelector('.search-opts-scroll').getBoundingClientRect().height) }; })()`);
      check('demo: the options panel opens from the same shell', dp.open && dp.h > 80, J(dp));
      const dh = await page.centerOf('#searchOpts .search-opts-resize');
      await page.mouse('mousePressed', dh.x, dh.y, { button: 'left', buttons: 1, clickCount: 1 });
      await page.mouse('mouseMoved', dh.x, dh.y - 40, { button: 'left', buttons: 1 });
      await page.mouse('mouseReleased', dh.x, dh.y - 40, { button: 'left', buttons: 0, clickCount: 1 });
      await sleep(300);
      const stored = await page.eval(`localStorage.getItem('boardclip-demo-options-height')`);
      check('demo: the panel height persists in localStorage', Number(stored) === dp.h - 40, String(stored));
      await page.eval(`document.getElementById('demo-search').dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))`);
      await sleep(300);
      check('demo: Esc closes the panel', !(await page.eval(`document.getElementById('searchOpts').classList.contains('open')`)));
    } finally {
      await site.close();
    }
    const rendererErrors = sb.diagnostics().filter((e) => e.event === 'renderer.error');
    check('no renderer errors during the run', rendererErrors.length === 0, rendererErrors.map((e) => JSON.stringify(e).slice(0, 200)).join(' | '));
    ok = true;
  } finally {
    const cleanup = await sb.finish();
    check('sandbox cleaned up (no leftovers)', cleanup.ok, cleanup.problems.join('; '));
  }
  const s = summary();
  process.exit(ok && s.failed === 0 ? 0 : 1);
}

main().catch((error) => { console.error('qa-popup-header error:', error.stack || error.message); process.exit(1); });
