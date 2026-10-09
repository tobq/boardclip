'use strict';

// Screenshots of every BoardClip surface (popup states, menus, dialogs,
// settings, editor, viewer, unify, conflict, approval prompt, website) from an
// isolated sandbox per theme (scripts/lib/qa-sandbox.js: cloaked windows, no
// focus, no page or window can reach the OS clipboard), for before/after
// comparisons of UI work.
//
// Usage: node scripts/qa-ui-shots.js [--theme dark|light|both] [--out <dir>]
//                                    [--only <substr>[,<substr>...]] [--serial]
// Writes <out>/<theme>/<shot>.png and prints a JSON summary on stdout
// (progress goes to stderr). Each STEP below is independent: it starts from a
// reset popup, and a step that throws is reported as skipped while the rest
// still run. Later work appends steps to STEPS.

const fs = require('fs');
const os = require('os');
const path = require('path');
const qa = require('./lib/qa-sandbox');

const argv = process.argv.slice(2);
const arg = (name, fallback) => { const i = argv.indexOf(`--${name}`); return i >= 0 && argv[i + 1] ? argv[i + 1] : fallback; };
const THEMES = ({ both: ['dark', 'light'], dark: ['dark'], light: ['light'] })[arg('theme', 'both')];
if (!THEMES) { console.error('--theme must be dark, light or both'); process.exit(2); }
const OUT_ARG = arg('out', '');
let OUT = ''; // created once the arguments are known to be valid
const ONLY = (arg('only', '') || '').split(',').map((s) => s.trim()).filter(Boolean);
const SERIAL = argv.includes('--serial');
const log = (...a) => console.error(...a);
const J = JSON.stringify;

// --- Seed: realistic clips, three images, a sync conflict, AI access ---------
function seed() {
  const now = Math.floor(Date.now() / 1000);
  const images = {};
  const img = (w, h, pixel, extra) => {
    const buf = qa.png(w, h, pixel);
    const file = qa.imageName(buf);
    images[file] = buf;
    return { type: 'image', image: file, width: w, height: h, ...extra };
  };
  const PLAN = 'Launch plan\n\n1. Freeze the release branch on Thursday\n2. Run the full QA pass on macOS and Windows\n3. Write the changelog and the blog post\n4. Ship to the beta channel first, then everyone on Monday\n\nOwner: release team. Risks: signing certs expire next month.';
  const texts = [
    { text: PLAN, title: 'Launch plan', pin: { groups: ['Work'], number: 1 }, ago: 120 },
    { text: 'https://example.com/docs/getting-started?ref=boardclip&utm_source=newsletter', ago: 300 },
    { text: '{\n  "name": "boardclip",\n  "version": "2.4.0",\n  "scripts": { "start": "electron .", "test": "node test/run.js" }\n}', title: 'package.json snippet', pin: { groups: ['Snippets'] }, ago: 900 },
    { text: 'The quick brown fox jumps over the lazy dog while the committee reviews the quarterly roadmap, the hiring plan and the long list of customer requests that arrived over the weekend.', ago: 1800 },
    { text: 'Groceries for Saturday\nmilk, eggs and sourdough bread\noat milk, coffee beans', ago: 2000 },
    { text: 'Thanks, see you tomorrow at 10!', pin: { groups: ['Personal'], number: 2 }, ago: 3600 },
    // Near-duplicates of the clip above (the similar-clip highlight + Select N similar).
    { text: 'Thanks, see you tomorrow at 10! I will bring the printed slides.', ago: 3700 },
    { text: 'see you   tomorrow at 10', ago: 3800 },
    { text: 'hello@example.com', ago: 5400 },
    { text: 'SELECT id, email, last_seen\nFROM users\nWHERE last_seen > now() - interval \'7 days\'\nORDER BY last_seen DESC;', title: 'SQL: active users', pin: { groups: ['Snippets', 'Work/Clients'] }, ago: 7200 },
    { text: 'Meeting notes - design review\nAttendees: Sam, Alex, Priya\nDecisions: ship the new search panel, keep the slide-in buttons', title: 'Design review', html: '<b>Meeting notes</b> - design review<br>Attendees: Sam, Alex, Priya', pin: { groups: ['Work'] }, ago: 10800 },
    { text: 'npm run build && npm test', pin: { groups: ['Snippets'] }, ago: 14400 },
    { text: '42 Wallaby Way, Sydney', ago: 20000 },
  ];
  for (let i = 0; i < 18; i += 1) texts.push({ text: `Filler clip number ${i + 1} with a little text so the list scrolls`, ago: 30000 + i * 3000 });
  const history = texts.map((s) => ({
    id: qa.txtId(s.text), type: 'text', text: s.text, ts: now - s.ago,
    ...(s.title ? { title: s.title } : {}), ...(s.html ? { html: s.html } : {}), ...(s.pin ? { pin: { ...s.pin, updatedAt: Date.now() } } : {}),
  }));
  history.push(
    img(1600, 400, (x, y) => [40 + ((x * 180 / 1600) | 0), 90 + ((y * 100 / 400) | 0), 200], { ts: now - 600, title: 'Dashboard screenshot', pin: { groups: ['Work'] } }),
    img(300, 900, (x, y) => [220, 120 + ((y * 100 / 900) | 0), 60 + ((x * 120 / 300) | 0)], { ts: now - 2400 }),
    img(64, 64, (x, y) => (((x >> 3) + (y >> 3)) & 1 ? [230, 230, 230] : [60, 60, 60]), { ts: now - 4000 }),
  );
  history.sort((a, b) => b.ts - a.ts);
  const left = PLAN.replace('Thursday', 'Wednesday').replace('Monday', 'Tuesday');
  const right = `${PLAN.replace('blog post', 'release notes')}\n5. Tell support before the launch email goes out`;
  const conflicts = { version: 1, tombstones: [], records: [{
    id: 'conf:editor:qa1', kind: 'editor', targetId: qa.txtId(PLAN), createdAt: Date.now(), updatedAt: Date.now(),
    base: { id: qa.txtId(PLAN), title: 'Launch plan', text: PLAN },
    left: { id: qa.txtId(left), title: 'Launch plan', text: left },
    right: { id: qa.txtId(right), title: 'Launch plan (Mac)', text: right },
  }] };
  // Solid surface: a glass page is translucent, and a CDP screenshot has no OS
  // blur behind it.
  const settings = { groups: ['Work', 'Work/Clients', 'Personal', 'Snippets', 'AI', 'Ideas'], groups_shared_with_ai: ['AI'], ai_approval_timeout_sec: 120, surface_style: 'solid' };
  return { history, images, conflicts, settings };
}

// --- Popup helpers (state shared by the popup steps) ---------------------------
const row = (id) => `.item[data-id=${J(id)}]`;
const menuItemCenter = (popup, re) => popup.eval(`(() => {
  const el = [...document.querySelectorAll('.bc-menu .bc-menu-item')].find((x) => ${re}.test(x.textContent));
  if (!el) return null;
  const r = el.getBoundingClientRect();
  return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
})()`);
async function resetPopup(c) {
  await c.popup.mouse('mouseMoved', -10, -10).catch(() => {});
  await c.popup.eval(`(() => {
    searchBox.setRegex(false, { load: true });
    // Clear the query BEFORE the reset: leaving a search keeps the clip it was on
    // in place, so a reset first would scroll back to it after its scrollToTop.
    clearSearchAndFilters();
    controller.clearSelection();
    window.resetPopupState();
    rerenderList();
    return true;
  })()`);
  await qa.sleep(150);
}
async function setQuery(c, q) {
  await c.popup.eval(`(() => {
    const s = document.getElementById('search');
    s.focus();
    s.value = ${J(q)};
    s.setSelectionRange(s.value.length, s.value.length);
    s.dispatchEvent(new Event('input', { bubbles: true }));
    rerenderList();
    return true;
  })()`);
  await qa.sleep(300);
}
const clickCancel = (page) => page.eval(`(() => {
  const b = [...document.querySelectorAll('.dialog button')].find((x) => /cancel/i.test(x.textContent));
  if (b) b.click(); else document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  return !!b;
})()`);
// The list renders only about two screenfuls, so a clip further down is put
// into the DOM first (no scroll: the shot keeps the list where it is).
const openRowMenu = (c, id) => c.popup.eval(`(() => {
  clipList.ensureRendered(${J(id)});
  const b = document.querySelector(${J(`${row(id)} [data-action="clip-menu"]`)});
  if (!b) throw new Error('no menu button on the row');
  b.click();
  return !!document.querySelector('.bc-menu');
})()`);
const editorMenu = (page) => page.eval(`(() => {
  const b = document.querySelector('.bc-bar [data-x="menu"]');
  if (!b) throw new Error('no menu button in the bar');
  b.click();
  return true;
})()`);
const escape = (page) => page.eval(`document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))`).catch(() => {});
// A real key press through CDP (default actions included: Enter on a focused
// button clicks it). shift / ctrl / meta hold the modifier.
const VK = { Enter: 13, Escape: 27, Tab: 9, ' ': 32, ArrowLeft: 37, ArrowUp: 38, ArrowRight: 39, ArrowDown: 40, Home: 36, End: 35, F10: 121 };
async function press(page, key, { shift = false, ctrl = false, meta = false } = {}) {
  const vk = VK[key] || key.toUpperCase().charCodeAt(0);
  const code = /^\d$/.test(key) ? `Digit${key}` : key === ' ' ? 'Space' : key;
  const ev = { key, code, windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk, modifiers: (shift ? 8 : 0) | (ctrl ? 2 : 0) | (meta ? 4 : 0) };
  await page.send('Input.dispatchKeyEvent', { type: 'rawKeyDown', ...ev });
  if (key === 'Enter' || key === ' ') await page.send('Input.dispatchKeyEvent', { type: 'char', text: key === 'Enter' ? '\r' : ' ', ...ev });
  await page.send('Input.dispatchKeyEvent', { type: 'keyUp', ...ev });
  await qa.sleep(80);
}
// The focused element, described: its label / data-n / id and where it sits.
const focused = (page) => page.eval(`(() => {
  const el = document.activeElement;
  if (!el || el === document.body) return { what: 'body' };
  const label = el.querySelector && el.querySelector('.bc-menu-label');
  const sub = el.closest('.tag-submenu');
  return { id: el.id || '', label: label ? label.textContent : '', n: el.dataset ? el.dataset.n || '' : '', text: (el.textContent || '').trim().slice(0, 40),
    inMenu: !!el.closest('.bc-menu'), inSub: !!sub, subShown: !!(sub && sub.getClientRects().length), expanded: el.getAttribute && el.getAttribute('aria-expanded'),
    dialog: !!el.closest('.dialog'), x: el.dataset ? el.dataset.x || '' : '' };
})()`);

// Each step: { name, popup (reset the popup first), run(c) }.
const STEPS = [
  { name: 'popup-list', popup: true, run: (c) => c.shot(c.popup, 'popup-list') },
  { name: 'popup-row-hover', popup: true, run: async (c) => { await c.popup.hover(`${row(c.ids.json)} .content`); await c.shot(c.popup, 'popup-row-hover'); } },
  { name: 'popup-image-row-hover', popup: true, run: async (c) => {
    // The buttons sit where a text row's do; a picture short of them leaves them plain.
    await c.popup.hover(`${row(c.ids.wide)} img`);
    await qa.sleep(250);
    const plain = await c.popup.eval(`document.querySelector(${J(row(c.ids.wide))}).classList.contains('img-under')`);
    if (plain) throw new Error('a picture that ends before the buttons should leave them unbacked');
    await c.shot(c.popup, 'popup-image-row-hover');
  } },
  { name: 'popup-image-row-under', popup: true, run: async (c) => {
    // Zoomed up, the picture reaches under the buttons: they get the frosted chip,
    // and stay exactly where they were.
    const at = () => c.popup.eval(`(() => { const r = document.querySelector(${J(row(c.ids.wide))}).querySelector('.img-actions > :first-child').getBoundingClientRect(); return [Math.round(r.left), Math.round(r.top - document.querySelector(${J(row(c.ids.wide))}).getBoundingClientRect().top)]; })()`);
    await c.popup.hover(`${row(c.ids.wide)} img`);
    await qa.sleep(250);
    const before = await at();
    await c.popup.eval(`(imageZoom.load(240), true)`);
    await qa.sleep(400);
    await c.popup.eval(`(document.querySelector(${J(row(c.ids.wide))}).scrollIntoView({ block: 'start' }), true)`);
    await c.popup.hover(`${row(c.ids.wide)} .meta`);
    await qa.sleep(350);
    const under = await c.popup.eval(`document.querySelector(${J(row(c.ids.wide))}).classList.contains('img-under')`);
    const after = await at();
    if (!under) throw new Error('a picture under the buttons should back them');
    if (before[0] !== after[0] || before[1] !== after[1]) throw new Error(`the buttons moved when backed: ${J(before)} -> ${J(after)}`);
    await c.shot(c.popup, 'popup-image-row-under');
    await c.popup.eval(`(imageZoom.load(60), true)`);
  } },
  // Rows: hover each kind (titled, untitled multi-line, single-line short and
  // long, image,
  // with tags + numpad badge). A text row's buttons slide in on the reveal, an
  // image row's float over the picture, the meta line's ghost # / + slide in,
  // and NO row of any kind changes height (measured: the step fails otherwise).
  { name: 'popup-rows-hover', popup: true, run: async (c) => {
    const kinds = { titled: c.ids.json, untitled: c.ids.groceries, single: c.ids.url, singleLong: c.ids.fox, image: c.ids.wide, tags: c.ids.plan };
    const heights = async () => new Map(await c.popup.eval(`[...document.querySelectorAll('#list > .item')].map((el) => [el.dataset.id, +el.getBoundingClientRect().height.toFixed(2)])`));
    const before = await heights();
    const checked = {};
    for (const [kind, id] of Object.entries(kinds)) {
      await c.popup.eval(`(document.querySelector(${J(row(id))}).scrollIntoView({ block: 'center' }), true)`);
      await qa.sleep(120);
      await c.popup.hover(`${row(id)} .content`);
      await qa.sleep(350); // the reveal transition
      const open = await c.popup.eval(`(() => {
        const el = document.querySelector(${J(row(id))});
        const track = el.querySelector('.row-actions');
        const chip = el.querySelector('.img-actions');
        const ghosts = el.querySelector('.meta-reveal');
        return { actions: track ? track.getBoundingClientRect().width : (chip ? +getComputedStyle(chip).opacity : 0), ghosts: ghosts.getBoundingClientRect().width };
      })()`);
      if (!(open.actions > 0.5) || !(open.ghosts > 4)) throw new Error(`hovering the ${kind} row did not reveal its buttons: ${J(open)}`);
      const after = await heights();
      const changed = [...after].filter(([rid, h]) => before.has(rid) && Math.abs(before.get(rid) - h) > 0.5);
      if (changed.length) throw new Error(`row heights changed while hovering the ${kind} row: ${J(changed.map(([rid, h]) => [rid, before.get(rid), h]))}`);
      checked[kind] = before.get(id);
      await c.shot(c.popup, `popup-row-hover-${kind}`);
    }
    c.note('rowHeightsStableOnHover', checked);
  } },
  // The meta line's ghost # (no key set) and the #N badge open the keypad
  // popover; + opens the group picker. The row keeps its buttons out while one
  // is open, even with the pointer elsewhere, and its height never changes.
  { name: 'popup-meta-popovers', popup: true, run: async (c) => {
    const heightOf = (id) => c.popup.eval(`document.querySelector(${J(row(id))}).getBoundingClientRect().height`);
    const open = async (id, selector, menuSel, shot) => {
      const h0 = await heightOf(id);
      await c.popup.hover(`${row(id)} .content`);
      await qa.sleep(300);
      await c.popup.click(`${row(id)} ${selector}`);
      await c.popup.waitFor(`!!document.querySelector(${J(menuSel)})`, `${shot} open`, 5000);
      await c.popup.mouse('mouseMoved', 6, 6); // pointer away: the row stays held
      await qa.sleep(250);
      const held = await c.popup.eval(`(() => { const el = document.querySelector(${J(row(id))}); return { held: el.classList.contains('actions-held'), track: el.querySelector('.meta-reveal').getBoundingClientRect().width, h: el.getBoundingClientRect().height }; })()`);
      if (!held.held || !(held.track > 4)) throw new Error(`${shot}: the row did not keep its buttons out (${J(held)})`);
      if (Math.abs(held.h - h0) > 0.5) throw new Error(`${shot}: the row height changed ${h0} -> ${held.h}`);
      await c.shot(c.popup, shot);
      await escape(c.popup);
      await c.popup.waitFor(`!document.querySelector('.bc-menu') && !document.querySelector('.item.actions-held')`, `${shot} closed`, 5000);
      // Mouse-opened, then dismissed: the opener's leftover focus must not keep
      // the row's buttons out (:focus-within) with the pointer elsewhere.
      await qa.sleep(350);
      const after = await c.popup.eval(`(() => { const el = document.querySelector(${J(row(id))}); return { track: el.querySelector('.meta-reveal').getBoundingClientRect().width, focusInRow: el.contains(document.activeElement) }; })()`);
      if (after.track > 0.5 || after.focusInRow) throw new Error(`${shot}: the row kept its buttons out after the popover closed (${J(after)})`);
    };
    await open(c.ids.fox, '.meta-ghost[data-action="numpad-open"]', '.bc-menu.bc-keypad .np-btn', 'popup-meta-keypad');
    await open(c.ids.plan, '.meta-np', '.bc-menu.bc-keypad .np-remove', 'popup-meta-keypad-set');
    await open(c.ids.fox, '.meta-ghost[data-action="tag-add"]', '.bc-menu .bc-group-list', 'popup-meta-group-picker');
  } },
  // Similar clips: hovering a text row tints the rendered rows that contain it
  // or that it contains; its menu offers "Select N similar", which selects
  // them all (the selection bar then offers Unify).
  { name: 'popup-similar', popup: true, run: async (c) => {
    const id = c.ids.thanks;
    await c.popup.eval(`(document.querySelector(${J(row(id))}).scrollIntoView({ block: 'center' }), true)`);
    await qa.sleep(150);
    await c.popup.hover(`${row(id)} .content`);
    await c.popup.waitFor(`controller.similar().target === ${J(id)} && controller.similar().ids.length >= 2`, 'similar clips painted', 5000);
    await qa.sleep(250);
    const painted = await c.popup.eval(`[...document.querySelectorAll('#list > .item.similar')].map((el) => el.dataset.id)`);
    for (const want of c.ids.similar) if (!painted.includes(want)) throw new Error(`similar clip ${want} not tinted (${J(painted)})`);
    if (painted.includes(id)) throw new Error('the hovered row tinted itself');
    await c.shot(c.popup, 'popup-similar-hover');
    // The keyboard cursor on the same row: the cursor row (accent) must read
    // apart from its similar rows (neutral wash + dotted edge, never accent).
    await c.popup.mouse('mouseMoved', -10, -10);
    const cursor = await c.popup.eval(`(() => {
      for (let k = 0; k < 60 && controller.focusedId() !== ${J(id)}; k += 1) controller.moveFocus(1);
      return controller.focusedId();
    })()`);
    if (cursor !== id) throw new Error(`could not put the cursor on the row (${cursor})`);
    await c.popup.waitFor(`controller.similar().target === ${J(id)} && document.querySelectorAll('#list > .item.similar').length >= 2`, 'similar clips painted for the cursor', 5000);
    await qa.sleep(250);
    const tints = await c.popup.eval(`(() => {
      const bg = (sel) => getComputedStyle(document.querySelector(sel)).backgroundColor;
      return { cursor: bg('#list > .item.selected'), similar: bg('#list > .item.similar') };
    })()`);
    if (tints.cursor === tints.similar) throw new Error(`the similar rows look like the cursor row: ${J(tints)}`);
    c.note('similarVsCursor', tints);
    await c.shot(c.popup, 'popup-similar-cursor');
    await c.popup.eval('(controller.clearSelection(), true)');
    await c.popup.hover(`${row(id)} .content`);
    await c.popup.waitFor(`controller.similar().target === ${J(id)}`, 'similar target back on hover', 5000);
    await qa.sleep(350); // the row's buttons slide back in before the menu click
    await c.popup.click(`${row(id)} [data-action="clip-menu"]`);
    await c.popup.waitFor(`[...document.querySelectorAll('.bc-menu [data-action="select-similar"]')].some((b) => !b.disabled && /Select 2 similar/.test(b.textContent))`, 'Select 2 similar', 5000);
    await c.shot(c.popup, 'popup-similar-menu');
    await c.popup.click('.bc-menu [data-action="select-similar"]');
    await c.popup.waitFor(`controller.selection().count === 3 && !document.getElementById('selectionBar').classList.contains('hidden')`, 'similar clips selected', 5000);
    const bar = await c.popup.eval(`(() => {
      const chips = document.getElementById('groupFilters').getBoundingClientRect();
      const bar = document.getElementById('selectionBar').getBoundingClientRect();
      return { unify: !!document.querySelector('#selectionBar [data-action="bulk-unify"]'), chipsHidden: getComputedStyle(document.getElementById('groupFilters')).visibility === 'hidden', sameTop: Math.abs(chips.top - bar.top) < 0.5, barH: bar.height, rowH: document.querySelector('.chip-row').getBoundingClientRect().height };
    })()`);
    if (!bar.unify || !bar.chipsHidden || !bar.sameTop) throw new Error(`selection bar not in the chip bar's place: ${J(bar)}`);
    c.note('selectionBar', bar);
    await c.shot(c.popup, 'popup-similar-selected');
  } },
  // A clip in many groups: the meta line shows whole group names or none
  // (never "D..." fragments), the hover ghosts still slide in, the row keeps
  // its height. The row is rendered into the list in the page only.
  { name: 'popup-meta-many-groups', popup: true, run: async (c) => {
    await c.popup.eval(`(() => {
      const item = { id: 'qa:many', type: 'text', ts: Math.floor(Date.now() / 1000) - 60, text: 'A clip in five groups\\nwith a second line',
        pin: { number: 3, groups: ['Alpha group long name', 'Beta group long name', 'Gamma group', 'Delta', 'Epsilon group'] } };
      const list = document.getElementById('list');
      list.insertAdjacentHTML('afterbegin', Core.renderClipItem(item, { actionsHtml: Core.renderClipActions(item) }));
      list.scrollTop = 0;
      return true;
    })()`);
    const measure = () => c.popup.eval(`(() => {
      const el = document.querySelector('.item[data-id="qa:many"]');
      const box = el.querySelector('.meta-tags').getBoundingClientRect();
      const tags = [...el.querySelectorAll('.meta-tag')].map((t) => {
        const r = t.getBoundingClientRect();
        return { text: t.textContent, shown: r.width > 0 && r.bottom <= box.bottom + 0.5 && r.right <= box.right + 0.5, cut: t.scrollWidth > t.clientWidth + 1, right: r.right };
      });
      const meta = el.querySelector('.meta');
      // Laid-out overflow past the meta box (scrollWidth also counts the closed
      // reveal's clip margin, an invisible 4 px: not a measure of what shows).
      // Margin boxes: the badge and the names box pull their hover padding back
      // out of the flow with a negative margin, which never pushes anything.
      const right = meta.getBoundingClientRect().right;
      const overflow = Math.max(0, ...[...meta.children].map((k) => k.getBoundingClientRect().right + (parseFloat(getComputedStyle(k).marginRight) || 0) - right));
      const ghost = el.querySelector('.meta-reveal .meta-ghost');
      return { tags, overflow, ghosts: el.querySelector('.meta-reveal').getBoundingClientRect().width, plusLeft: ghost ? ghost.getBoundingClientRect().left : null, h: el.getBoundingClientRect().height };
    })()`);
    const rest = await measure();
    await c.popup.hover('.item[data-id="qa:many"] .content');
    await qa.sleep(350);
    const hover = await measure();
    for (const [state, m] of [['at rest', rest], ['on hover', hover]]) {
      const shown = m.tags.filter((t) => t.shown);
      if (!shown.length) throw new Error(`${state}: no group name shown ${J(m)}`);
      if (shown.length > 1 && shown.some((t) => t.cut)) throw new Error(`${state}: a group name shows as a fragment ${J(m)}`);
      if (m.overflow > 0.5) throw new Error(`${state}: the meta line overflows by ${m.overflow} px`);
    }
    if (!(hover.ghosts > 4)) throw new Error(`the ghost # / + did not slide in: ${J(hover)}`);
    // The ghosts follow the last name that shows (Core.fitMetaTags), never the names box's far edge.
    const lastShown = hover.tags.filter((t) => t.shown).pop();
    if (lastShown && hover.plusLeft - lastShown.right > 12) throw new Error(`the ghosts sit ${Math.round(hover.plusLeft - lastShown.right)} px after the last name: ${J(hover)}`);
    if (Math.abs(rest.h - hover.h) > 0.5) throw new Error(`the row height changed on hover ${rest.h} -> ${hover.h}`);
    c.note('metaManyGroups', { rest: rest.tags.filter((t) => t.shown).map((t) => t.text), hover: hover.tags.filter((t) => t.shown).map((t) => t.text) });
    await c.shot(c.popup, 'popup-meta-many-groups');
  } },
  // The selection bar never moves the list, even with an EMPTY chip bar (a
  // fresh install: no pins, keys, images or groups): the chip cell keeps the
  // bar's height. The chips are emptied in the page only; the next reset
  // rebuilds them.
  { name: 'popup-selection-bar-empty-chips', popup: true, run: async (c) => {
    const got = await c.popup.eval(`(() => {
      const listTop = () => document.getElementById('list').getBoundingClientRect().top;
      document.getElementById('groupFilters').innerHTML = '';
      const before = listTop();
      const ids = [...document.querySelectorAll('#list > .item')].slice(0, 2).map((el) => el.dataset.id);
      for (const id of ids) controller.toggle(id);
      const shown = !document.getElementById('selectionBar').classList.contains('hidden');
      const during = listTop();
      controller.clearSelection();
      return { shown, before, during, after: listTop() };
    })()`);
    if (!got.shown) throw new Error(`the selection bar did not show: ${J(got)}`);
    if (Math.abs(got.before - got.during) > 0.5 || Math.abs(got.before - got.after) > 0.5) throw new Error(`the list moved with an empty chip bar: ${J(got)}`);
    c.note('selectionBarEmptyChips', got);
  } },
  // Empty states from the ONE shared renderer: no matches, filters exclude
  // everything, an empty group, no clips yet.
  { name: 'popup-empty-states', popup: true, run: async (c) => {
    for (const [q, kind] of [['zzqx nothing matches this', 'no-match'], ['is:image num:5', 'filtered'], ['group:Ideas', 'empty-group']]) {
      await setQuery(c, q);
      const got = await c.popup.eval(`(document.querySelector('#list > .list-empty') || { dataset: {} }).dataset.empty || null`);
      if (got !== kind) throw new Error(`"${q}" rendered empty state ${got}, expected ${kind}`);
      await c.shot(c.popup, `popup-empty-${kind}`);
    }
    // No clips yet: the same renderer for an empty history, rendered into the
    // list directly (the next reset rebuilds it from the real history).
    await c.popup.eval(`(clipList.update({ ids: [], queryKey: '', emptyHtml: Core.renderEmptyState({ total: 0 }) }), true)`);
    await c.shot(c.popup, 'popup-empty-no-clips');
  } },
  { name: 'popup-row-menu', popup: true, run: async (c) => {
    await openRowMenu(c, c.ids.plan);
    await c.shot(c.popup, 'popup-row-menu');
    for (const [re, name] of [['/group/i', 'popup-row-menu-group-sub'], ['/numpad/i', 'popup-row-menu-numpad-sub']]) {
      const at = await menuItemCenter(c.popup, re);
      if (!at) throw new Error(`no ${name} item in the row menu`);
      await c.popup.mouse('mouseMoved', at.x, at.y);
      await c.shot(c.popup, name);
    }
  } },
  // Keyboard-driven menus (real CDP keys): Shift+F10 opens the cursor row's
  // menu on its first row; Home / End / Down / Right / Left / Enter / Esc walk
  // the rows, the group submenu (a nested tag included) and the keypad; Esc
  // hands focus back to the search; Enter on a row runs it (Rename... opens the
  // prompt, Esc cancels, focus returns); a mouse-opened menu moves no focus
  // until the first arrow key; 1-9 press the visible keypad's key.
  { name: 'popup-menu-keyboard', popup: true, run: async (c) => {
    const p = c.popup;
    const expect = async (what, test) => { const f = await focused(p); if (!test(f)) throw new Error(`${what}: focus is ${J(f)}`); return f; };
    const menuGone = (what) => p.waitFor(`!document.querySelector('.bc-menu')`, what, 3000);
    await p.eval(`(document.getElementById('search').focus(), true)`);
    await press(p, 'ArrowDown'); // the list cursor onto the first row (Launch plan)
    await press(p, 'F10', { shift: true });
    await p.waitFor(`!!document.querySelector('.bc-menu')`, 'menu open', 3000);
    await expect('the menu opens on its first row', (f) => f.inMenu && f.label === 'Unpin');
    await press(p, 'End'); await expect('End = the last row', (f) => f.label === 'Delete');
    await press(p, 'Home'); await expect('Home = the first row', (f) => f.label === 'Unpin');
    for (let i = 0; i < 3; i += 1) await press(p, 'ArrowDown');
    await expect('Down x3', (f) => f.label === 'Add to group');
    await press(p, 'ArrowRight');
    // Groups sort by use (Search.groupWeights): Work, the most used, leads.
    await expect('Right opens the groups on the first group (the most used)', (f) => f.inSub && f.subShown && f.label === 'Work');
    await press(p, 'ArrowRight');
    await expect('Right opens Work > Clients', (f) => f.label === 'Clients' && f.subShown);
    await c.shot(p, 'popup-menu-keyboard-groups');
    await press(p, 'ArrowLeft'); await expect('Left closes one level', (f) => f.label === 'Work' && f.expanded === 'false');
    await press(p, 'Escape'); await expect('Esc closes one level', (f) => f.label === 'Add to group' && f.expanded === 'false');
    await press(p, 'ArrowDown'); await expect('Down to Numpad', (f) => f.label === 'Numpad');
    await press(p, 'Enter'); await expect('Enter opens the keypad on 7', (f) => f.n === '7' && f.subShown);
    await press(p, 'ArrowDown'); await press(p, 'ArrowRight'); await expect('the keypad moves in 2-D (7, 4, 5)', (f) => f.n === '5');
    await c.shot(p, 'popup-menu-keyboard-keypad');
    await press(p, 'ArrowLeft'); await press(p, 'ArrowLeft'); await expect('Left at the keypad edge closes it', (f) => f.label === 'Numpad');
    await press(p, 'Escape'); await menuGone('Esc closes the menu');
    await expect('focus back on the search', (f) => f.id === 'search');
    // Enter runs a row: Rename... opens the prompt; Esc cancels; focus returns.
    await press(p, 'F10', { shift: true });
    await p.waitFor(`!!document.querySelector('.bc-menu')`, 'menu reopened', 3000);
    await press(p, 'ArrowDown'); await press(p, 'ArrowDown'); await expect('Down to Rename...', (f) => f.label === 'Rename...');
    await press(p, 'Enter');
    await p.waitFor(`!!document.querySelector('.overlay.show .prompt-input') && document.activeElement === document.querySelector('.overlay.show .prompt-input')`, 'the rename prompt has focus', 3000);
    await press(p, 'Escape');
    await p.waitFor(`!document.querySelector('.overlay.show')`, 'prompt closed', 3000);
    await expect('focus back on the search after the dialog', (f) => f.id === 'search');
    // A mouse-opened menu (a real click on the row's "...") moves nothing
    // until the first arrow key.
    await p.hover(`${row(c.ids.url)} .content`); await qa.sleep(300);
    await p.click(`${row(c.ids.url)} [data-action="clip-menu"]`);
    await p.waitFor(`!!document.querySelector('.bc-menu')`, 'menu opened by the mouse', 3000);
    await expect('a mouse open leaves focus alone', (f) => !f.inMenu);
    await press(p, 'ArrowDown'); await expect('the first arrow enters the menu', (f) => f.inMenu && f.label === 'Pin');
    await press(p, 'Escape'); await menuGone('menu closed');
    // 1-9 on a row's # popover (mouse-opened) assigns that key; then remove it.
    const keyOf = async () => ((await c.sb.historyState()).find((i) => i.id === c.ids.url).pin || {}).number || null;
    await p.hover(`${row(c.ids.url)} .content`); await qa.sleep(300);
    await p.click(`${row(c.ids.url)} .meta-ghost[data-action="numpad-open"]`);
    await p.waitFor(`!!document.querySelector('.bc-menu.bc-keypad')`, 'keypad popover', 3000);
    await press(p, '7');
    await qa.waitFor(async () => (await keyOf()) === 7, 'digit 7 assigned key 7', 5000);
    await menuGone('the popover closes after the key');
    await p.hover(`${row(c.ids.url)} .content`); await qa.sleep(300);
    await p.click(`${row(c.ids.url)} .meta-np`);
    await p.waitFor(`!!document.querySelector('.bc-menu.bc-keypad .np-remove')`, 'keypad popover with Remove', 3000);
    await p.click('.bc-menu.bc-keypad .np-remove');
    await qa.waitFor(async () => (await keyOf()) === null, 'key 7 removed again', 5000);
    // Taking a key pins the clip and removing the key keeps the pin: unpin it,
    // so the later shots match the baselines (the URL clip starts unpinned).
    await p.eval(`(document.querySelector(${J(`${row(c.ids.url)} .star`)}).click(), true)`);
    await qa.waitFor(async () => !(await c.sb.historyState()).find((i) => i.id === c.ids.url).pin, 'the URL clip unpinned again', 5000);
  } },
  // Dialog keys: a destructive confirm opens on Cancel, so a bare Enter cancels
  // it (nothing is cleared).
  { name: 'popup-dialog-keys', popup: true, run: async (c) => {
    const p = c.popup;
    const before = (await c.sb.historyState()).length;
    await p.eval(`(document.getElementById('settingsBtn').click(), true)`);
    await qa.sleep(300);
    await p.eval(`(() => { const b = document.getElementById('clearAll'); b.scrollIntoView(); b.click(); return true; })()`);
    await p.waitFor(`!!document.activeElement && document.activeElement.dataset.x === 'no' && !!document.activeElement.closest('.overlay.show')`, 'the destructive confirm opens on Cancel', 3000);
    await press(p, 'Enter');
    await p.waitFor(`!document.querySelector('.overlay.show')`, 'dialog closed', 3000);
    const after = (await c.sb.historyState()).length;
    if (after !== before) throw new Error(`Enter on a destructive confirm cleared clips (${before} -> ${after})`);
    await p.eval(`(document.getElementById('settingsBack').click(), true)`);
  } },
  // The selection bar's Group popover: the tri-state checklist (a dash where
  // only some of the selection is in the group).
  { name: 'popup-bulk-groups', popup: true, run: async (c) => {
    await c.popup.eval(`(() => {
      const click = (id) => document.querySelector('.item[data-id="' + id + '"] .content').dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, ctrlKey: true }));
      click(${J(c.ids.plan)}); click(${J(c.ids.json)});
      return document.querySelectorAll('.item.multi-selected').length;
    })()`);
    await c.popup.click('[data-action="bulk-group-open"]');
    await c.popup.waitFor(`!!document.querySelector('.bc-menu .bc-group-list [aria-checked="mixed"]')`, 'bulk group popover (mixed rows)', 3000);
    await c.shot(c.popup, 'popup-bulk-group-popover');
    await escape(c.popup);
  } },
  { name: 'popup-filter-chip-sub', popup: true, run: async (c) => {
    await c.popup.hover('.group-filters .filter-tag[data-group="Work"]');
    const sub = await c.popup.eval(`(() => {
      const node = document.querySelector('.group-filters .filter-tag[data-group="Work"]').closest('.tag-menu-node');
      const menu = node && node.querySelector(':scope > .tag-submenu');
      if (!menu || getComputedStyle(menu).display === 'none') return 'submenu not open';
      const r = menu.getBoundingClientRect();
      const hit = document.elementFromPoint(r.left + r.width / 2, r.top + Math.min(r.height / 2, 12));
      return hit && menu.contains(hit) ? 'ok' : \`covered by \${hit ? hit.className : 'nothing'}\`;
    })()`);
    if (sub !== 'ok') throw new Error(`the Work chip's submenu is not visible: ${sub}`);
    await c.shot(c.popup, 'popup-filter-chip-sub');
  } },
  // Many groups: the chip row stays ONE line that scrolls sideways under the
  // mask fade (right edge only at the start, both mid-way), and shows every
  // chip, wrapped, while the options panel is open. The extra groups are
  // removed again so later steps see the usual set.
  { name: 'popup-chips-many', popup: true, run: async (c) => {
    const extra = ['Recipes', 'Travel', 'Invoices', 'Reading list', 'Side project', 'Gifts', 'Design system', 'Support macros', 'Interview prep'];
    await c.popup.eval(`(async () => { for (const g of ${J(extra)}) await window.api.groupCreate(g); await refreshGroupsAndList(); return true; })()`);
    await qa.sleep(400);
    const strip = () => c.popup.eval(`(() => {
      const el = document.querySelector('.group-filters');
      const tops = new Set([...el.children].map((x) => Math.round(x.getBoundingClientRect().top)));
      return { lines: tops.size, overflow: el.scrollWidth > el.clientWidth + 1, left: el.style.getPropertyValue('--fade-left'), right: el.style.getPropertyValue('--fade-right'), expanded: el.classList.contains('expanded'), h: Math.round(el.getBoundingClientRect().height) };
    })()`);
    const one = await strip();
    if (one.lines !== 1 || !one.overflow || one.right !== '36px' || one.left !== '0px') throw new Error(`collapsed chip row is not one masked line: ${J(one)}`);
    await c.shot(c.popup, 'popup-chips-many');
    await c.popup.eval(`(() => { const el = document.querySelector('.group-filters'); el.scrollLeft = 120; el.dispatchEvent(new Event('scroll')); return true; })()`);
    await qa.sleep(350);
    const mid = await strip();
    if (mid.left !== '36px' || mid.right !== '36px') throw new Error(`scrolled chip row should fade both edges: ${J(mid)}`);
    await c.shot(c.popup, 'popup-chips-many-scrolled');
    await c.popup.eval(`(document.getElementById('search').focus(), true)`);
    await c.popup.click('#searchOptsBtn');
    await qa.sleep(700);
    const all = await strip();
    if (!all.expanded || all.lines < 2 || all.overflow || all.right !== '0px') throw new Error(`panel open should show every chip, wrapped: ${J(all)}`);
    await c.shot(c.popup, 'popup-chips-many-expanded');
    await escape(c.popup);
    await qa.sleep(700);
    const back = await strip();
    if (back.expanded || back.lines !== 1 || back.h !== one.h) throw new Error(`closing the panel should fold the chips back to one line: ${J(back)}`);
    await c.popup.eval(`(async () => { for (const g of ${J(extra)}) await window.api.groupDelete(g); await refreshGroupsAndList(); return true; })()`);
    await qa.sleep(300);
  } },
  { name: 'popup-search-facet', popup: true, run: async (c) => { await setQuery(c, 'group:Work plan'); await c.shot(c.popup, 'popup-search-facet'); } },
  { name: 'popup-search-suggest', popup: true, run: async (c) => { await setQuery(c, 'is:'); await c.shot(c.popup, 'popup-search-suggest'); } },
  { name: 'popup-search-regex-invalid', popup: true, run: async (c) => {
    await c.popup.eval(`(searchBox.setRegex(true, { load: true }), true)`);
    await setQuery(c, '/[unclosed/');
    // A regex still being typed is flagged after 700 ms idle: shoot the error.
    await c.popup.waitFor(`!!document.querySelector('.search-hint.show')`, 'the broken regex hint', 1500);
    await c.shot(c.popup, 'popup-search-regex-invalid');
  } },
  { name: 'popup-search-empty', popup: true, run: async (c) => { await setQuery(c, 'zzqx nothing matches this'); await c.shot(c.popup, 'popup-search-empty'); } },
  // Search behaviour (phase 4): an unknown key painted + the one hint line, the
  // ghost completion, greyed chips (chip bar + options panel) and the
  // empty-result nudge.
  { name: 'popup-search-invalid', popup: true, run: async (c) => {
    await setQuery(c, 'plan titel:notes is:imgae');
    await c.popup.waitFor(`document.querySelector('.search-hint').classList.contains('show')`, 'hint shown', 5000);
    await qa.sleep(300);
    await c.shot(c.popup, 'popup-search-invalid');
  } },
  { name: 'popup-search-ghost', popup: true, run: async (c) => {
    await setQuery(c, 'plan ti');
    await c.popup.waitFor(`!!document.querySelector('.search-hl .qh-ghost')`, 'ghost painted', 5000);
    await c.shot(c.popup, 'popup-search-ghost');
  } },
  { name: 'popup-chips-greyed', popup: true, run: async (c) => {
    await setQuery(c, 'is:image');
    await c.popup.eval(`(searchBox.openOptions(), true)`);
    await c.popup.waitFor(`!!document.querySelector('.facet-opt.is-disabled')`, 'greyed panel chips', 5000);
    await qa.sleep(400);
    await c.shot(c.popup, 'popup-chips-greyed');
    await c.popup.eval(`(searchBox.closeOptions({ instant: true }), true)`);
  } },
  { name: 'popup-search-nudge', popup: true, run: async (c) => {
    await setQuery(c, 'plan is:image');
    await c.popup.waitFor(`!!document.querySelector('.list-empty .empty-nudge-btn')`, 'nudge shown', 5000);
    await c.shot(c.popup, 'popup-search-nudge');
  } },
  // The flat field: idle ("Click here to search...", no buttons) and focused
  // ("Search...", regex + options slid in).
  { name: 'popup-search-unfocused', popup: true, run: async (c) => {
    // Regex off (the default): an idle field reveals nothing.
    await c.popup.eval(`(searchBox.setRegex(false, { load: true }), document.getElementById('search').blur(), true)`);
    await c.popup.waitFor(`document.getElementById('search').placeholder === 'Click here to search...' && !document.querySelector('.bc-reveal[data-reveal="tools"]').classList.contains('open')`, 'idle field', 5000);
    await qa.sleep(300);
    await c.shot(c.popup, 'popup-search-unfocused');
  } },
  { name: 'popup-search-focused', popup: true, run: async (c) => {
    await c.popup.eval(`(document.getElementById('search').focus(), true)`);
    await c.popup.waitFor(`document.getElementById('search').placeholder === 'Search...' && document.querySelector('.bc-reveal[data-reveal="tools"]').classList.contains('open')`, 'focused field', 5000);
    await qa.sleep(300);
    await c.shot(c.popup, 'popup-search-focused');
  } },
  // The chip row's selection cluster: two groups joined by "or" at the front
  // between hairlines, an excluded one after them, the rest by use; the Regex
  // toggle on with a typed /regex/ term; the language painting OR, groups and a
  // /regex/.
  { name: 'popup-chips-cluster', popup: true, run: async (c) => {
    await setQuery(c, 'group:Work OR group:Ideas -group:Personal');
    await c.popup.waitFor(`!!document.querySelector('#groupFilters .conn-toggle[data-conn="or"]')`, 'the cluster with its or', 5000);
    await qa.sleep(300);
    await c.shot(c.popup, 'popup-chips-cluster');
  } },
  { name: 'popup-search-regex-typing', popup: true, run: async (c) => {
    await c.popup.eval(`(searchBox.setRegex(true, { load: true }), document.getElementById('search').focus(), true)`);
    for (const k of 'plan') {
      await c.popup.send('Input.dispatchKeyEvent', { type: 'keyDown', key: k, code: `Key${k.toUpperCase()}`, text: k, unmodifiedText: k });
      await c.popup.send('Input.dispatchKeyEvent', { type: 'keyUp', key: k, code: `Key${k.toUpperCase()}` });
    }
    await c.popup.waitFor(`document.getElementById('search').value === '/plan/' && document.getElementById('regexBtn').classList.contains('active')`, 'a typed /regex/ term', 5000);
    await qa.sleep(300);
    await c.shot(c.popup, 'popup-search-regex-typing');
    await c.popup.eval(`(searchBox.setRegex(false, { load: true }), true)`);
  } },
  { name: 'popup-search-or-groups', popup: true, run: async (c) => {
    await setQuery(c, 'group:Work OR group:Ideas (plan OR notes) -/draft\\d+/');
    await qa.sleep(300);
    await c.shot(c.popup, 'popup-search-or-groups');
  } },
  // The options panel (the tune toggle), opened by a real press, then with a
  // facet chip applied (it writes the token into the query and lights the toggle).
  { name: 'popup-options-panel', popup: true, run: async (c) => {
    await c.popup.eval(`(document.getElementById('search').focus(), true)`);
    await qa.sleep(250);
    await c.popup.click('#searchOptsBtn');
    await c.popup.waitFor(`document.getElementById('searchOpts').classList.contains('open') && !document.getElementById('searchOpts').inert`, 'options panel open', 5000);
    await qa.sleep(400);
    await c.shot(c.popup, 'popup-options-panel');
    await c.popup.click('.facet-opt[title="is:url"]'); // Type: Link
    await c.popup.waitFor(`document.getElementById('search').value.includes('is:url')`, 'facet applied', 5000);
    await qa.sleep(300);
    await c.shot(c.popup, 'popup-options-panel-facet');
    // A wide popup (the owner's 667 px): the filter units flow side by side,
    // so the panel has no dead half and takes fewer lines.
    const POP = `__qa.electron.BrowserWindow.getAllWindows().find((x) => /index\\.html/.test(x.webContents.getURL()))`;
    const narrow = await c.sb.mainEval(`${POP}.getBounds()`);
    try {
      await c.sb.mainEval(`(${POP}.setBounds({ ...${POP}.getBounds(), width: 667 }), true)`);
      await qa.sleep(400);
      const flow = await c.popup.eval(`(() => {
        const units = [...document.querySelectorAll('#searchOpts .opts-unit')];
        const lines = new Set(units.map((u) => Math.round(u.getBoundingClientRect().top))).size;
        const box = document.querySelector('#searchOpts .opts-facets').getBoundingClientRect();
        const right = Math.max(...units.map((u) => u.getBoundingClientRect().right));
        return { units: units.length, lines, emptyRight: Math.round(box.right - right) };
      })()`);
      c.note('popup-options-panel-wide', flow);
      await c.shot(c.popup, 'popup-options-panel-wide');
      if (!(flow.lines < flow.units)) throw new Error(`a wide popup should put filter units side by side: ${J(flow)}`);
    } finally {
      await c.sb.mainEval(`(${POP}.setBounds(${J(narrow)}), true)`);
      await qa.sleep(200);
    }
    await escape(c.popup);
  } },
  { name: 'popup-multiselect', popup: true, run: async (c) => {
    await c.popup.eval(`(() => {
      const click = (id) => document.querySelector('.item[data-id="' + id + '"] .content').dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, ctrlKey: true }));
      click(${J(c.ids.url)}); click(${J(c.ids.fox)});
      return document.querySelectorAll('.item.multi-selected').length;
    })()`);
    // One right edge for the stacked icon columns: the header's gear, the
    // search row's tune and the selection bar's close all end on the gutter.
    const edges = await c.popup.eval(`(() => {
      const x = (sel) => { const e = document.querySelector(sel); if (!e) return null; const r = e.getBoundingClientRect(); return r.width ? Math.round((r.left + r.width / 2) * 10) / 10 : null; };
      return { gear: x('#settingsBtn .mi'), tune: x('#searchOptsBtn .mi'), close: x('#selectionBar .selection-actions > :last-child .mi') };
    })()`);
    c.note('popup-icon-columns', edges);
    if (edges.gear == null || edges.tune == null || edges.close == null) throw new Error(`icon columns not found: ${J(edges)}`);
    if (Math.max(edges.gear, edges.tune, edges.close) - Math.min(edges.gear, edges.tune, edges.close) > 1) throw new Error(`the stacked icon columns do not line up: ${J(edges)}`);
    await c.shot(c.popup, 'popup-multiselect');
    const at = await c.popup.centerOf('.item.multi-selected .content');
    if (!at) throw new Error('no multi-selected row');
    await c.popup.eval(`document.querySelector('.item.multi-selected .content').dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: ${at.x}, clientY: ${at.y} }))`);
    await c.shot(c.popup, 'popup-bulk-menu');
  } },
  { name: 'popup-dialog-prompt', popup: true, run: async (c) => {
    await openRowMenu(c, c.ids.url);
    await c.popup.eval(`(() => { const it = document.querySelector('.bc-menu [data-action="rename"]'); if (!it) throw new Error('no rename item'); it.click(); return true; })()`);
    await c.shot(c.popup, 'popup-dialog-prompt');
    await clickCancel(c.popup);
  } },
  { name: 'popup-toast-undo', popup: true, run: async (c) => {
    await openRowMenu(c, c.ids.filler);
    await c.popup.eval(`(() => { const it = document.querySelector('.bc-menu [data-action="del"]'); if (!it) throw new Error('no delete item'); it.click(); return true; })()`);
    await c.shot(c.popup, 'popup-toast-undo');
    // Undo, so later steps (and --only runs) see the same history.
    await c.popup.eval(`(() => { const b = document.querySelector('.toast .toast-action'); if (b) b.click(); return !!b; })()`);
    await qa.sleep(300);
  } },
  { name: 'popup-settings', popup: true, run: async (c) => {
    await c.popup.eval(`(document.getElementById('settingsBtn').click(), true)`);
    await qa.sleep(300);
    const h = await c.popup.eval(`(() => { const b = document.querySelector('.settings-body'); return { sh: b.scrollHeight, ch: b.clientHeight }; })()`);
    for (let i = 0, y = 0; i < 8 && y < h.sh; i += 1, y += Math.max(200, h.ch - 40)) {
      await c.popup.eval(`document.querySelector('.settings-body').scrollTop = ${y}`);
      await c.shot(c.popup, `popup-settings-${i}`);
    }
    await c.popup.eval(`(() => { const b = document.getElementById('clearAll'); b.scrollIntoView(); b.click(); return true; })()`);
    await c.shot(c.popup, 'popup-dialog-confirm');
    await clickCancel(c.popup);
    await c.popup.eval(`(document.getElementById('settingsBack').click(), true)`);
  } },
  // Settings > Appearance driven like a user (swatches, the #rrggbb field, the
  // segs), each look shot, then the same look in the editor, viewer and
  // approval windows (ONE applier everywhere). Notes the --accent / ink each
  // window computed. Restores the defaults so later steps see the usual look.
  { name: 'appearance', popup: true, run: async (c) => {
    const look = (page) => page.eval(`(() => { const r = document.documentElement, s = getComputedStyle(r); return { accent: s.getPropertyValue('--accent').trim(), ink: s.getPropertyValue('--active-fg').trim(), data: ['data-accent', 'data-density', 'data-corners'].map((a) => r.getAttribute(a)).join(',') }; })()`);
    const settle = () => qa.sleep(350);
    await c.popup.eval(`(document.getElementById('settingsBtn').click(), true)`);
    await qa.sleep(300);
    await c.popup.eval(`(() => { const b = document.querySelector('.settings-body'); b.scrollTop = document.getElementById('accentMode').closest('.settings-section').offsetTop - 8; return true; })()`);
    const swatch = (mode) => c.popup.eval(`(document.querySelector('[data-accent-mode="${mode}"]').click(), true)`);
    const seg = (key, value) => c.popup.eval(`(document.querySelector('.seg[data-appearance="${key}"] [data-value="${value}"]').click(), true)`);
    const hex = (value) => c.popup.eval(`(() => { const f = document.getElementById('accentCustom'); f.value = ${J(value)}; f.dispatchEvent(new Event('change', { bubbles: true })); return true; })()`);
    for (const mode of ['teal', 'mono']) { await swatch(mode); await settle(); c.note(`popup-${mode}`, await look(c.popup)); await c.shot(c.popup, `appearance-${mode}`); }
    await swatch('custom');
    await settle();
    for (const [name, value] of [['yellow', '#ffb900'], ['navy', '#1a1a6e']]) {
      await hex(value); await settle();
      c.note(`popup-custom-${name}`, await look(c.popup));
      await c.shot(c.popup, `appearance-custom-${name}`);
    }
    await hex('not-a-colour'); await settle();
    await c.shot(c.popup, 'appearance-custom-invalid');
    await hex('#ffb900');
    await seg('ui_density', 'compact');
    await seg('ui_corners', 'sharp');
    await seg('surface_style', 'auto'); // shows "Glass on" where glass is available
    await settle();
    c.note('popup-compact-sharp', await look(c.popup));
    await c.shot(c.popup, 'appearance-compact-sharp');
    await seg('surface_style', 'solid');
    await c.popup.eval(`(document.getElementById('settingsBack').click(), true)`);
    await settle();
    await c.shot(c.popup, 'appearance-compact-list');
    // The same look in every other window.
    const ed = await c.sb.newPage(/editor\.html/, () => c.popup.eval(`window.api.openEditor(${J(c.ids.plan)}, {})`), { label: 'editor (appearance)' });
    await ed.waitFor(`document.documentElement.getAttribute('data-accent') === 'custom'`, 'editor applied the custom accent', 8000);
    await ed.fontsReady();
    c.note('editor', await look(ed));
    await c.shot(ed, 'appearance-editor');
    const vw = await c.sb.newPage(/viewer\.html/, () => c.popup.eval(`window.api.openImage(${J(c.ids.wide)}, {})`), { label: 'viewer (appearance)' });
    await vw.waitFor(`document.documentElement.getAttribute('data-accent') === 'custom'`, 'viewer applied the custom accent', 8000);
    await vw.fontsReady();
    await qa.sleep(400);
    c.note('viewer', await look(vw));
    await c.shot(vw, 'appearance-viewer');
    const sql = c.items.find((i) => i.title === 'SQL: active users');
    let req = null;
    const ap = await c.sb.newPage(/mcp-approval\.html/, () => {
      req = c.sb.mcp('delete_clip', { id: sql.id, expected_rev: sql.rev }, { client: 'Claude (appearance)' }).then(() => 'unexpected success', (e) => e.message);
    }, { label: 'approval (appearance)' });
    await ap.waitFor(`document.getElementById('explain').textContent.length > 0 && document.documentElement.getAttribute('data-accent') === 'custom'`, 'approval rendered with the custom accent');
    await ap.fontsReady();
    await ap.waitFor(`!document.getElementById('allowOnce').disabled`, 'allow buttons armed', 5000);
    c.note('approval', await look(ap));
    await c.shot(ap, 'appearance-approval');
    await ap.eval(`(document.getElementById('deny').click(), true)`);
    await req;
    // A live change reaches open windows (appearance-changed): System again.
    await c.popup.eval(`window.api.saveSettings({ accent_mode: 'system', ui_density: 'normal', ui_corners: 'soft' }).then(() => true)`);
    await ed.waitFor(`document.documentElement.getAttribute('data-density') === null`, 'editor followed the live change', 8000);
    c.note('editor-after-reset', await look(ed));
    ed.close();
    vw.close();
    await c.sb.mainEval(`(__qa.electron.BrowserWindow.getAllWindows().filter((w) => /(editor|viewer)\\.html/.test(w.webContents.getURL())).forEach((w) => w.close()), true)`);
  } },
  { name: 'editor', run: async (c) => {
    const ed = await c.sb.newPage(/editor\.html/, () => c.popup.eval(`window.api.openEditor(${J(c.ids.plan)}, {})`), { label: 'editor', focus: true });
    await ed.waitFor(`!!document.querySelector('textarea, .bc-editor')`, 'editor ready');
    await ed.fontsReady();
    await c.shot(ed, 'editor');
    // The idle title is header (the popup search field's rule): a drag moves the
    // window and selects nothing, a click starts a rename with the caret there.
    // CDP has no screen coordinates: one (+40, +30) move is a (+40, +30) screen
    // delta while the window has not moved yet (qa-popup-header's method).
    const edBounds = () => c.sb.mainEval(`(() => { const w = __qa.electron.BrowserWindow.getAllWindows().find((x) => /editor\\.html/.test(x.webContents.getURL())); return w.getBounds(); })()`);
    const tt = await ed.centerOf('.bc-bar-title');
    const b0 = await edBounds();
    await ed.mouse('mouseMoved', tt.x, tt.y);
    await ed.mouse('mousePressed', tt.x, tt.y, { button: 'left', buttons: 1, clickCount: 1 });
    await ed.mouse('mouseMoved', tt.x + 2, tt.y + 1, { button: 'left', buttons: 1 });
    await ed.mouse('mouseMoved', tt.x + 40, tt.y + 30, { button: 'left', buttons: 1 });
    await qa.sleep(250);
    const b1 = await edBounds();
    await ed.mouse('mouseReleased', tt.x + 40, tt.y + 30, { button: 'left', buttons: 0, clickCount: 1 });
    await qa.sleep(200);
    const afterDrag = await ed.eval(`({ titleFocused: document.activeElement === document.querySelector('.bc-bar-title'), selected: getSelection().toString() })`);
    if (b1.x - b0.x !== 40 || b1.y - b0.y !== 30 || afterDrag.titleFocused) throw new Error(`a drag on the idle title should move the window and not edit: ${J({ b0, b1, afterDrag })}`);
    const tt2 = await ed.centerOf('.bc-bar-title');
    await ed.mouse('mousePressed', tt2.x, tt2.y, { button: 'left', buttons: 1, clickCount: 1 });
    await ed.mouse('mouseReleased', tt2.x, tt2.y, { button: 'left', buttons: 0, clickCount: 1 });
    await qa.sleep(200);
    const afterClick = await ed.eval(`(() => { const t = document.querySelector('.bc-bar-title'); return { focused: document.activeElement === t, at: t.selectionStart, len: t.value.length }; })()`);
    if (!afterClick.focused || !(afterClick.at > 0 && afterClick.at < afterClick.len)) throw new Error(`a click on the idle title should start a rename with the caret where it was clicked: ${J(afterClick)}`);
    c.note('editorTitleDrag', { moved: [b1.x - b0.x, b1.y - b0.y], caret: afterClick });
    await ed.eval(`(document.querySelector('textarea').focus(), true)`);
    // The bar's own find button, as a user opens it; a step that never shows
    // the bar must be reported as skipped, not shot as the plain editor.
    await ed.click('.bc-bar [data-x="find"]');
    await ed.waitFor(`!document.querySelector('.bc-find').hidden`, 'find bar open', 5000);
    await ed.eval(`(() => { const f = document.querySelector('.bc-find-input'); f.value = 'the'; f.dispatchEvent(new Event('input', { bubbles: true })); return true; })()`);
    await ed.waitFor(`document.querySelectorAll('.bc-editor-hl mark').length > 0`, 'find matches highlighted', 5000);
    await c.shot(ed, 'editor-find');
    // The find bar's Regex and match case, lit.
    await ed.click('.bc-find [data-x="findregex"]');
    await ed.click('.bc-find [data-x="findcase"]');
    await ed.eval(`(() => { const f = document.querySelector('.bc-find-input'); f.value = 'Th.'; f.dispatchEvent(new Event('input', { bubbles: true })); return true; })()`);
    await ed.waitFor(`document.querySelector('[data-x="findregex"]').classList.contains('active') && document.querySelector('[data-x="findcase"]').classList.contains('active')`, 'find Regex + case lit', 5000);
    await ed.mouse('mouseMoved', 5, 5);
    await qa.sleep(300);
    await c.shot(ed, 'editor-find-regex');
    await ed.click('.bc-find [data-x="findregex"]');
    await ed.click('.bc-find [data-x="findcase"]');
    await escape(ed);
    await editorMenu(ed);
    await c.shot(ed, 'editor-menu');
    await escape(ed);
    await ed.eval(`(() => { const b = document.querySelector('.bc-tag-strip [data-action="tag-add"]'); if (!b) throw new Error('no tag-add button'); b.click(); return true; })()`);
    await c.shot(ed, 'editor-tag-picker');
  } },
  { name: 'viewer', run: async (c) => {
    const vw = await c.sb.newPage(/viewer\.html/, () => c.popup.eval(`window.api.openImage(${J(c.ids.wide)}, {})`), { label: 'viewer', focus: true });
    await vw.fontsReady();
    await qa.sleep(600);
    await c.shot(vw, 'viewer');
    await editorMenu(vw);
    await c.shot(vw, 'viewer-menu');
    await escape(vw);
    // The footer's zoom controls, as a user clicks them: zoom in twice, then 100%.
    await vw.click('.bc-zoom [data-x="zoomin"]');
    await vw.click('.bc-zoom [data-x="zoomin"]');
    await qa.sleep(200);
    c.note('viewer-zoom', await vw.eval(`({ pct: document.querySelector('[data-x="zoom"]').textContent, fit: document.querySelector('[data-x="fit"]').classList.contains('active') })`));
    await c.shot(vw, 'viewer-zoomed');
    await vw.click('.bc-zoom [data-x="actual"]');
    await qa.sleep(200);
    await c.shot(vw, 'viewer-actual');
  } },
  // The clip windows' bar with the OS's own window controls: the room it
  // reserves (Window Controls Overlay on Windows) and the colours it reported
  // for the caption buttons, then the editor at its display's work area (a
  // real maximize() activates the window, so the sandbox sizes it instead).
  { name: 'window-controls', run: async (c) => {
    // Its own clip: an editor already open on a clip is re-shown, not reopened.
    const ed = await c.sb.newPage(/editor\.html/, () => c.popup.eval(`window.api.openEditor(${J(c.ids.notes)}, {})`), { label: 'editor (window controls)' });
    await ed.waitFor(`!!document.querySelector('.bc-bar')`, 'bar ready');
    await ed.fontsReady();
    await qa.sleep(400);
    const bar = await ed.eval(`(() => {
      const b = document.querySelector('.bc-bar'), s = getComputedStyle(b), o = navigator.windowControlsOverlay;
      const r = o && o.getTitlebarAreaRect ? o.getTitlebarAreaRect() : null;
      return { side: document.documentElement.dataset.windowControls, wco: !!(o && o.visible), area: r && [r.x, r.width, r.height], height: b.getBoundingClientRect().height,
        padRight: s.paddingRight, padLeft: s.paddingLeft, close: !!b.querySelector('[data-x="close"]'), vw: innerWidth };
    })()`);
    const win = await c.sb.mainEval(`(() => { const w = __qa.electron.BrowserWindow.getAllWindows().find((x) => /editor\\.html/.test(x.webContents.getURL())); return { maximizable: w.isMaximizable(), minimizable: w.isMinimizable(), bounds: w.getBounds() }; })()`);
    c.note('window-controls', { bar, win });
    if (process.platform === 'win32' && !(bar.wco && parseFloat(bar.padRight) >= 100 && !bar.close)) throw new Error(`bar does not reserve the caption buttons: ${J(bar)}`);
    await c.shot(ed, 'editor-window-controls');
    // The caption buttons follow the theme: flip it and catch what the page
    // reports to main's setTitleBarOverlay (Windows / Linux).
    if (process.platform !== 'darwin') {
      const findEd = `__qa.electron.BrowserWindow.getAllWindows().find((x) => /editor\\.html/.test(x.webContents.getURL()))`;
      await c.sb.mainEval(`(() => { const w = ${findEd}; w.__overlays = []; const real = w.setTitleBarOverlay.bind(w); w.setTitleBarOverlay = (o) => { w.__overlays.push(o); return real(o); }; return true; })()`);
      const other = c.theme === 'dark' ? 'light' : 'dark';
      await c.popup.eval(`window.api.saveSettings({ theme_mode: ${J(other)} })`);
      await qa.sleep(700);
      const overlays = await c.sb.mainEval(`${findEd}.__overlays`);
      await c.popup.eval(`window.api.saveSettings({ theme_mode: ${J(c.theme)} })`);
      await qa.sleep(500);
      c.note('overlay-on-theme-flip', overlays);
      const last = overlays[overlays.length - 1];
      const want = other === 'light' ? '#ffffff' : '#14171b';
      if (!last || last.color !== want || last.height !== 31) throw new Error(`caption buttons did not follow the theme: ${J(overlays)}`);
    }
    await c.sb.mainEval(`(__qa.electron.BrowserWindow.getAllWindows().find((x) => /editor\\.html/.test(x.webContents.getURL())).maximize(), true)`);
    await qa.sleep(700);
    c.note('editor-maximized', await ed.eval(`({ w: innerWidth, h: innerHeight, padRight: getComputedStyle(document.querySelector('.bc-bar')).paddingRight })`));
    await c.shot(ed, 'editor-maximized');
    // Back to its size first: the bounds it closes with are what the next
    // editor opens at (unify and conflict keep their own merge_bounds).
    await c.sb.mainEval(`(__qa.electron.BrowserWindow.getAllWindows().find((x) => /editor\\.html/.test(x.webContents.getURL())).setBounds(${J(win.bounds)}), true)`);
    await qa.sleep(500);
    await c.sb.mainEval(`(__qa.electron.BrowserWindow.getAllWindows().filter((w) => /editor\\.html/.test(w.webContents.getURL())).forEach((w) => w.close()), true)`);
  } },
  // Glass popup: ONE sheet, ONE frost: nothing in the popup paints over the
  // window's scrim (the header used to add a second --surface band).
  { name: 'glass-popup', popup: true, run: async (c) => {
    await c.popup.eval(`window.api.saveSettings({ surface_style: 'glass' })`);
    try {
      await c.popup.waitFor(`document.documentElement.dataset.surface === 'glass'`, 'popup is glass', 8000);
      await qa.sleep(300);
      const p = await c.popup.eval(`(() => {
        const paint = (sel) => [...document.querySelectorAll(sel)].map((el) => getComputedStyle(el).backgroundColor).filter((bg) => bg !== 'rgba(0, 0, 0, 0)' && bg !== 'transparent');
        const alpha = (bg) => { const i = bg.lastIndexOf('/'); if (i >= 0) return parseFloat(bg.slice(i + 1)); if (bg.indexOf('rgba(') === 0) return parseFloat(bg.slice(bg.lastIndexOf(',') + 1)); return 1; };
        const blurred = [...document.querySelectorAll('*')].filter((el) => { const b = getComputedStyle(el).backdropFilter; return b && b !== 'none' && !el.closest('.img-actions'); /* an image row's buttons, over the picture, frost the picture, not the window */ }).map((el) => el.className || el.tagName);
        const band = getComputedStyle(document.querySelector('.sticky')).backgroundColor;
        return { surface: document.documentElement.dataset.surface, band, bandAlpha: alpha(band), blurred,
          painted: ['body', '.main-view', '.sticky header', '.search-row', '.chip-row', '.group-filters', '.list-wrap', '.list'].flatMap((sel) => paint(sel).map((bg) => sel + ' ' + bg)) };
      })()`);
      c.note('glass-popup', p);
      await c.shot(c.popup, 'glass-popup');
      // Two tones under glass: the canvas is the one scrim, the header band a
      // translucent lift over it, and nothing adds a second blur.
      if (p.painted.length) throw new Error(`a canvas layer paints over the glass scrim: ${J(p.painted)}`);
      if (!(p.bandAlpha > 0 && p.bandAlpha < 1)) throw new Error(`the header band must be a translucent lift under glass: ${J(p)}`);
      if (p.blurred.length) throw new Error(`a second blur layer: ${J(p.blurred)}`);
    } finally {
      await c.popup.eval(`window.api.saveSettings({ surface_style: 'solid' })`); // the seed's look
      await c.popup.waitFor(`document.documentElement.dataset.surface === 'solid'`, 'popup back to solid', 8000);
    }
  } },
  // "Glass on: All windows": the editor and the unify window get the glass,
  // and each has ONE frosted layer (every band transparent over the scrim).
  { name: 'glass-all', run: async (c) => {
    await c.popup.eval(`window.api.saveSettings({ surface_style: 'glass', glass_scope: 'all' })`);
    await qa.sleep(400);
    const bands = (page) => page.eval(`(() => {
      const paint = (sel) => [...document.querySelectorAll(sel)].map((el) => getComputedStyle(el).backgroundColor).filter((bg) => bg !== 'rgba(0, 0, 0, 0)' && bg !== 'transparent');
      const alpha = (bg) => { const i = bg.lastIndexOf('/'); if (i >= 0) return parseFloat(bg.slice(i + 1)); if (bg.indexOf('rgba(') === 0) return parseFloat(bg.slice(bg.lastIndexOf(',') + 1)); return 1; };
      return { surface: document.documentElement.dataset.surface,
        painted: ['.bc-editor', '.bc-reconcile', '.CodeMirror', '.CodeMirror-merge-gap', 'body'].flatMap((sel) => paint(sel).map((bg) => sel + ' ' + bg)),
        opaqueBands: ['.bc-bar', '.bc-find', '.bc-editor-foot', '.bc-merge-heads', '.bc-reconcile-actions'].flatMap((sel) => paint(sel).filter((bg) => alpha(bg) >= 1).map((bg) => sel + ' ' + bg)) };
    })()`);
    try {
      const ed = await c.sb.newPage(/editor\.html/, () => c.popup.eval(`window.api.openEditor(${J(c.ids.plan)}, {})`), { label: 'editor (glass)' });
      await ed.waitFor(`document.documentElement.dataset.surface === 'glass'`, 'editor is glass', 8000);
      await ed.fontsReady();
      const e = await bands(ed);
      c.note('glass-editor', e);
      await c.shot(ed, 'glass-editor');
      const un = await c.sb.newPage(/editor\.html/, () => c.popup.eval(`window.api.startUnify([${J(c.ids.plan)}, ${J(c.ids.notes)}])`), { label: 'unify (glass)' });
      await un.waitFor(`!!document.querySelector('.CodeMirror-merge') && document.documentElement.dataset.surface === 'glass'`, 'glass merge mounted', 8000);
      await qa.sleep(700);
      const u = await bands(un);
      c.note('glass-unify', u);
      await c.shot(un, 'glass-unify');
      // Two tones under glass: content paints nothing over the scrim, the bars
      // are translucent lifts (never an opaque slab).
      if (e.painted.length || u.painted.length) throw new Error(`a content layer paints over the glass scrim: ${J([e.painted, u.painted])}`);
      if (e.opaqueBands.length || u.opaqueBands.length) throw new Error(`a bar is opaque under glass: ${J([e.opaqueBands, u.opaqueBands])}`);
    } finally {
      await c.sb.mainEval(`(__qa.electron.BrowserWindow.getAllWindows().filter((w) => /editor\\.html/.test(w.webContents.getURL())).forEach((w) => w.close()), true)`);
      await c.popup.eval(`window.api.saveSettings({ surface_style: 'solid', glass_scope: 'popup' })`); // the seed's look
    }
  } },
  { name: 'unify', run: async (c) => {
    const un = await c.sb.newPage(/editor\.html/, () => c.popup.eval(`window.api.startUnify([${J(c.ids.plan)}, ${J(c.ids.notes)}])`), { label: 'unify', focus: true });
    await un.waitFor(`!!document.querySelector('.CodeMirror-merge')`, 'merge mounted');
    await un.fontsReady();
    await qa.sleep(900);
    // The bar at the window's size: the title must not be cut while the context can give way.
    c.note('unify-bar', await un.eval(`(() => { const w = (s) => { const e = document.querySelector(s); return e ? [Math.round(e.getBoundingClientRect().width), e.scrollWidth] : null; };
      return { title: w('.bc-bar-title'), context: w('.bc-bar-context'), spacer: w('.bc-bar-spacer'), actions: w('.bc-bar-actions'), bar: w('.bc-bar') }; })()`));
    await c.shot(un, 'unify');
  } },
  { name: 'conflict', run: async (c) => {
    const cf = await c.sb.newPage(/editor\.html/, () => c.popup.eval(`window.api.openConflict('conf:editor:qa1')`), { label: 'conflict', focus: true });
    await cf.waitFor(`!!document.querySelector('.CodeMirror-merge, .bc-merge-host')`, 'conflict mounted');
    await cf.fontsReady();
    await qa.sleep(900);
    // The word-level marks each pane shows (whole words, never letter fragments).
    c.note('conflict-marks', await cf.eval(`[...document.querySelectorAll('.CodeMirror-merge-pane')].map((p) => [...p.querySelectorAll('[class*="-inserted"], [class*="-deleted"]')].map((m) => m.textContent))`));
    await c.shot(cf, 'conflict');
    // The heads at the window's size and at its 520 px minimum: a differing
    // title stays readable (the accept drops to its glyph first).
    const heads = () => cf.eval(`(() => [...document.querySelectorAll('.bc-merge-head')].map((h) => { const t = h.querySelector('.bc-head-title'); const l = h.querySelector('.bc-accept-label'); return { w: Math.round(h.getBoundingClientRect().width), pick: t ? [Math.round(t.getBoundingClientRect().width), t.scrollWidth, t.textContent] : null, acceptLabel: l ? getComputedStyle(l).display !== 'none' : null }; }))()`);
    const fits = (hs) => hs.every((h) => !h.pick || h.pick[0] >= Math.min(h.pick[1], 48));
    const atSize = await heads();
    c.note('conflict-heads', atSize);
    if (!fits(atSize)) throw new Error(`conflict head title pick squeezed: ${J(atSize)}`);
    await cf.send('Emulation.setDeviceMetricsOverride', { width: 520, height: 560, deviceScaleFactor: 1, mobile: false });
    await qa.sleep(500);
    const narrow = await heads();
    c.note('conflict-heads-520', narrow);
    if (narrow.some((h) => h.pick && h.pick[0] < 40)) throw new Error(`conflict head title pick unreadable at 520 px: ${J(narrow)}`);
    await c.shot(cf, 'conflict-520');
    await cf.send('Emulation.clearDeviceMetricsOverride');
  } },
  { name: 'approval-modal', run: async (c) => {
    const sql = c.items.find((i) => i.title === 'SQL: active users');
    let req = null;
    const ap = await c.sb.newPage(/mcp-approval\.html/, () => {
      req = c.sb.mcp('delete_clip', { id: sql.id, expected_rev: sql.rev }, { client: 'Claude (UI audit)' }).then(() => 'unexpected success', (e) => e.message);
    }, { label: 'approval' });
    await ap.waitFor(`document.getElementById('explain').textContent.length > 0`, 'approval rendered');
    await ap.fontsReady();
    // The allow buttons arm a moment after the prompt appears.
    await ap.waitFor(`!document.getElementById('allowOnce').disabled`, 'allow buttons armed', 5000);
    await qa.sleep(200);
    await c.shot(ap, 'approval-modal');
    await ap.eval(`(document.getElementById('deny').click(), true)`);
    const result = await req;
    if (!/denied/.test(result)) throw new Error(`approval request ended with ${result}`);
  } },
  // The demo's windows (Core.attachWebWindow): the popup and its clip window
  // are windows on the page. Real mouse input (CDP) drags the popup by its
  // header and resizes it from a corner; the clip window (the same shared
  // .bc-bar as the app's window, with the visitor's OS controls drawn in it)
  // maximises to the viewport and back, minimises into the dock and comes
  // back from it, and closes; the popup closes to the dock and its icon opens
  // it again. Reduced motion is emulated so every step lands at once.
  { name: 'site-windows', run: async (c) => {
    const page = await c.sb.openWindow(c.site.url, { theme: c.theme });
    await page.send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 900, deviceScaleFactor: 1, mobile: false });
    await page.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'reduce' }] });
    await page.waitFor(`document.readyState === 'complete' && !!document.getElementById('demo-new-note')`, 'site loaded');
    await page.fontsReady();
    const rect = (sel) => page.eval(`(() => { const e = document.querySelector(${J(sel)}); if (!e || e.hidden) return null; const r = e.getBoundingClientRect(); return { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) }; })()`);
    const mouse = async (type, x, y) => page.send('Input.dispatchMouseEvent', { type, x, y, button: 'left', buttons: type === 'mouseReleased' ? 0 : 1, clickCount: 1, pointerType: 'mouse' });
    const drag = async (x0, y0, x1, y1) => {
      await page.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: x0, y: y0, buttons: 0, pointerType: 'mouse' });
      await mouse('mousePressed', x0, y0);
      for (let k = 1; k <= 6; k += 1) await mouse('mouseMoved', Math.round(x0 + (x1 - x0) * k / 6), Math.round(y0 + (y1 - y0) * k / 6));
      await mouse('mouseReleased', x1, y1);
      await qa.sleep(120);
    };
    await page.eval(`(document.getElementById('demo-window').scrollIntoView({ block: 'center' }), true)`);
    await qa.sleep(200);
    // Drag the popup by its header (the count / blank part of the header).
    const p0 = await rect('#demo-window');
    await drag(p0.x + 40, p0.y + 14, p0.x - 160, p0.y + 26);
    const p1 = await rect('#demo-window');
    c.note('site-windows-drag', { p0, p1 });
    if (Math.abs(p1.x - (p0.x - 200)) > 2 || Math.abs(p1.y - (p0.y + 12)) > 2) throw new Error(`popup header drag: ${J({ p0, p1 })}`);
    // Resize from its bottom-right corner.
    await drag(p1.x + p1.w - 2, p1.y + p1.h - 2, p1.x + p1.w + 58, p1.y + p1.h - 62);
    const p2 = await rect('#demo-window');
    c.note('site-windows-resize', p2);
    if (Math.abs(p2.w - (p1.w + 60)) > 2 || Math.abs(p2.h - (p1.h - 60)) > 2) throw new Error(`popup corner resize: ${J({ p1, p2 })}`);
    // A clip window: the editor, cascaded from the popup, with OS controls.
    const bar = await page.eval(`(() => { document.getElementById('demo-new-note').click(); const b = document.querySelector('#demo-clipwin .bc-bar'); return { bar: !!b, os: b && b.dataset.os, close: !!(b && b.querySelector('[data-wc="close"][data-x="close"]')), min: !!(b && b.querySelector('[data-wc="min"]')), max: !!(b && b.querySelector('[data-wc="max"]')), title: !!(b && b.querySelector('input.bc-bar-title')) }; })()`);
    await qa.sleep(200);
    const e0 = await rect('#demo-clipwin');
    c.note('site-windows-editor', { bar, e0 });
    if (!bar.bar || !bar.close || !bar.min || !bar.max || !bar.title || !e0) throw new Error(`demo editor window: ${J({ bar, e0 })}`);
    if (Math.abs(e0.x - (p2.x + 36)) > 2 || Math.abs(e0.y - (p2.y + 36)) > 2) throw new Error(`the clip window opens cascaded from the popup: ${J({ p2, e0 })}`);
    const both = await page.eval(`(() => { const a = document.getElementById('demo-window').getBoundingClientRect(); const b = document.getElementById('demo-clipwin').getBoundingClientRect(); const x = Math.min(a.x, b.x) - 24, y = Math.min(a.y, b.y) - 24; return { x, y, width: Math.max(a.right, b.right) + 24 - x, height: Math.max(a.bottom, b.bottom) + 96 - y }; })()`);
    await c.shot(page, 'site-windows', { clip: { ...both, scale: 1 } });
    // Its bar drags it (the empty part of the bar).
    await drag(e0.x + e0.w - 200, e0.y + 14, e0.x + e0.w - 260, e0.y + 54);
    const e1 = await rect('#demo-clipwin');
    if (Math.abs(e1.x - (e0.x - 60)) > 2 || Math.abs(e1.y - (e0.y + 40)) > 2) throw new Error(`clip window bar drag: ${J({ e0, e1 })}`);
    // Maximise: the viewport; then back.
    await page.eval(`(document.querySelector('#demo-clipwin [data-wc="max"]').click(), true)`);
    await qa.sleep(150);
    const em = await rect('#demo-clipwin');
    const vp = await page.eval('({ w: document.documentElement.clientWidth, h: innerHeight })');
    c.note('site-windows-max', { em, vp });
    if (em.x !== 0 || em.y !== 0 || Math.abs(em.w - vp.w) > 1 || Math.abs(em.h - vp.h) > 1) throw new Error(`maximise: ${J({ em, vp })}`);
    await c.shot(page, 'site-windows-max');
    await page.eval(`(document.querySelector('#demo-clipwin [data-wc="max"]').click(), true)`);
    await qa.sleep(150);
    const er = await rect('#demo-clipwin');
    if (Math.abs(er.x - e1.x) > 2 || Math.abs(er.y - e1.y) > 2 || Math.abs(er.w - e1.w) > 2) throw new Error(`restore: ${J({ e1, er })}`);
    // Minimise into the dock, then back from it.
    await page.eval(`(document.querySelector('#demo-clipwin [data-wc="min"]').click(), true)`);
    await qa.sleep(150);
    const docked = await page.eval(`({ hidden: document.getElementById('demo-clipwin').hidden, items: document.querySelectorAll('#demo-dock .dock-win').length, dock: document.getElementById('demo-dock-slot').classList.contains('show') })`);
    if (!docked.hidden || docked.items !== 1 || !docked.dock) throw new Error(`minimise: ${J(docked)}`);
    await c.shot(page, 'site-windows-dock', { clip: { ...both, scale: 1 } });
    await page.eval(`(document.querySelector('#demo-dock .dock-win').click(), true)`);
    await qa.sleep(150);
    const back = await page.eval(`({ hidden: document.getElementById('demo-clipwin').hidden, running: !!document.querySelector('#demo-dock .dock-win.running') })`);
    if (back.hidden || !back.running) throw new Error(`restore from the dock: ${J(back)}`);
    // Close it, then close the popup and open it again from the dock.
    await page.eval(`(document.querySelector('#demo-clipwin [data-x="close"]').click(), true)`);
    await qa.sleep(150);
    await page.eval(`(document.getElementById('demo-close-button').click(), true)`);
    await qa.sleep(150);
    const closed = await page.eval(`({ clip: document.getElementById('demo-clipwin').hidden, popup: document.getElementById('demo-window').hidden, running: document.getElementById('demo-dock-app').classList.contains('running'), dock: document.getElementById('demo-dock-slot').classList.contains('show'), items: document.querySelectorAll('#demo-dock .dock-win').length })`);
    if (!closed.clip || !closed.popup || closed.running || !closed.dock || closed.items !== 0) throw new Error(`close: ${J(closed)}`);
    await page.eval(`(document.getElementById('demo-dock-app').click(), true)`);
    await qa.sleep(150);
    const reopened = await page.eval(`({ popup: !document.getElementById('demo-window').hidden, running: document.getElementById('demo-dock-app').classList.contains('running'), focus: document.activeElement && document.activeElement.id, dock: document.getElementById('demo-dock-slot').classList.contains('show') })`);
    c.note('site-windows-reopen', reopened);
    // The open popup alone: no dock (a lone icon would read as a random thing).
    if (!reopened.popup || !reopened.running || reopened.focus !== 'demo-search' || reopened.dock) throw new Error(`reopen from the dock: ${J(reopened)}`);
  } },
  // The guide's entrance: a real (trusted) mouse move with the demo in view
  // starts it; the page dims and blurs under a spotlight on the demo and the
  // popup comes forward (scale) before it settles back.
  { name: 'site-tour', run: async (c) => {
    const page = await c.sb.openWindow(c.site.url, { theme: c.theme });
    await page.send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 900, deviceScaleFactor: 1, mobile: false });
    await page.waitFor(`document.readyState === 'complete' && !!document.getElementById('demo-window')`, 'site loaded');
    await page.fontsReady();
    await page.eval(`(document.getElementById('demo-window').scrollIntoView({ block: 'center' }), true)`);
    await qa.sleep(400);
    await page.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 300, y: 400, buttons: 0, pointerType: 'mouse' });
    await page.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 320, y: 410, buttons: 0, pointerType: 'mouse' });
    await qa.sleep(1900); // 600 ms before it starts, then the 900 ms dim + the scale up
    const got = await page.eval(`(() => { const d = getComputedStyle(document.getElementById('demo-dim')); const t = getComputedStyle(document.getElementById('demo-window')).transform; const m = /matrix\\(([^,]+)/.exec(t); return { dim: Number(d.opacity), blur: d.backdropFilter, scale: m ? Number(m[1]) : 1, spotX: document.getElementById('demo-dim').style.getPropertyValue('--spot-x') }; })()`);
    c.note('site-tour', got);
    if (!(got.dim > 0.6) || !(got.scale > 1.03) || !got.spotX) throw new Error(`the tour's entrance did not dim / spotlight / scale the demo: ${J(got)}`);
    await c.shot(page, 'site-tour');
  } },
  // The demo editor on a clip IS the app editor: its "..." opens the editor
  // clip menu (Revert to original, no "Open in editor"), Revert offers Undo in
  // the toast, and under "Glass on: Popup only" it paints the app editor
  // window's solid --surface (not the page --bg, not the popup's frost).
  { name: 'site-editor-menu', run: async (c) => {
    const page = await c.sb.openWindow(c.site.url, { theme: c.theme });
    await page.waitFor(`document.readyState === 'complete' && !!document.querySelector('.bc-popup .item [data-action="edit"]')`, 'site loaded');
    await page.fontsReady();
    const got = await page.eval(`(async () => {
      const pop = document.querySelector('.bc-popup');
      const edit = pop.querySelector('.item [data-action="edit"]');
      const id = edit.dataset.id;
      edit.click();
      const overlay = document.getElementById('demo-clipwin');
      overlay.scrollIntoView({ block: 'center' });
      const area = overlay.querySelector('.bc-editor-area');
      const original = area.value;
      area.value = original + ' EDITED';
      area.dispatchEvent(new Event('input', { bubbles: true }));
      const surface = getComputedStyle(overlay).backgroundColor; // the canvas the editor sits on
      const menuBtn = overlay.querySelector('[data-x="menu"]');
      if (!menuBtn) return { id, menuBtn: false, surface, glass: pop.dataset.surface, scope: pop.dataset.glassScope || 'popup' };
      menuBtn.click();
      await new Promise((r) => setTimeout(r, 120));
      const menu = document.querySelector('#demo-clipwin .bc-menu');
      const rows = menu ? [...menu.querySelectorAll('[data-action]')].map((b) => b.dataset.action) : [];
      const revert = menu && menu.querySelector('[data-action="revert"]');
      if (revert) revert.click();
      await new Promise((r) => setTimeout(r, 120));
      const afterRevert = area.value;
      const undo = document.querySelector('#demo-clip-toast.show .toast-action');
      const undoClass = undo ? undo.className : null;
      if (undo) undo.click();
      await new Promise((r) => setTimeout(r, 120));
      return { id, menuBtn: true, rows, reverted: afterRevert === original, undoClass, undone: area.value === original + ' EDITED', surface, glass: pop.dataset.surface, scope: pop.dataset.glassScope || 'popup' };
    })()`);
    c.note('site-editor-menu', got);
    const want = c.theme === 'dark' ? 'rgb(11, 13, 16)' : 'rgb(244, 245, 247)'; // --bg: the app editor window's solid canvas
    if (got.surface !== want) throw new Error(`demo editor canvas is ${got.surface}, the app editor window's is ${want}: ${J(got)}`);
    if (!got.menuBtn || !got.rows.includes('revert') || got.rows.includes('edit')) throw new Error(`demo editor menu is not the editor's: ${J(got)}`);
    if (!got.reverted || !/btn quiet sm accent/.test(got.undoClass || '') || !got.undone) throw new Error(`Revert / Undo: ${J(got)}`);
    await page.eval(`(() => { const x = document.querySelector('#demo-clipwin [data-x="close"]'); if (x) x.click(); return true; })()`);
  } },
  { name: 'site', run: async (c) => {
    const page = await c.sb.openWindow(c.site.url, { theme: c.theme });
    await page.send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 900, deviceScaleFactor: 1, mobile: false });
    await page.send('Page.reload', { ignoreCache: true }); // theme media + metrics in place before the page's own scripts run
    await page.waitFor(`document.readyState === 'complete' && !!document.querySelector('.bc-popup')`, 'site loaded');
    await page.fontsReady();
    await qa.sleep(1500);
    await c.fullPage(page, 'site', 1280);
    // The demo's Settings: the app's body, bound by the same Core.mountSettings
    // and painted by the same Core.applyAppearance (Teal, then back to System).
    await page.eval(`(() => { document.getElementById('demo-settings-button').click(); const p = document.querySelector('.bc-popup'); p.scrollIntoView({ block: 'center' }); return true; })()`);
    await qa.sleep(300);
    await page.eval(`(() => { const p = document.querySelector('.bc-popup'); const b = p.querySelector('.settings-body'); b.scrollTop = p.querySelector('#accentMode').closest('.settings-section').offsetTop - 8; p.querySelector('[data-accent-mode="teal"]').click(); return true; })()`);
    await qa.sleep(300);
    c.note('site-demo-teal', await page.eval(`(() => { const p = document.querySelector('.bc-popup'); return { accent: getComputedStyle(p).getPropertyValue('--accent').trim(), data: p.getAttribute('data-accent') }; })()`));
    await c.shot(page, 'site-settings');
    await page.eval(`(() => { const p = document.querySelector('.bc-popup'); p.querySelector('[data-accent-mode="system"]').click(); document.getElementById('demo-settings-back').click(); return true; })()`);
    await page.send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 1, mobile: true });
    await qa.sleep(800);
    await c.fullPage(page, 'site-mobile', 390);
    // The narrowest phone the page supports: still no horizontal scroll.
    await page.send('Emulation.setDeviceMetricsOverride', { width: 360, height: 800, deviceScaleFactor: 1, mobile: true });
    await qa.sleep(600);
    const overflow = await page.eval('document.documentElement.scrollWidth - document.documentElement.clientWidth');
    if (overflow > 0) throw new Error(`the site scrolls sideways at 360px (${overflow}px)`);
    await c.fullPage(page, 'site-360', 360);
  } },
];

// --- One theme: launch, run every selected step, kill ---------------------------
async function runTheme(theme, site) {
  const outDir = path.join(OUT, theme);
  fs.mkdirSync(outDir, { recursive: true });
  const result = { theme, shots: [], skipped: [], ms: {}, notes: {} };
  const t0 = Date.now();
  const c = { theme, site, outDir, note: (key, value) => { result.notes[key] = value; } };
  c.shot = async (page, name, opts) => {
    await qa.sleep(250);
    await page.screenshot(path.join(outDir, `${name}.png`), opts);
    result.shots.push(name);
  };
  c.fullPage = async (page, name, width) => {
    const height = await page.eval('Math.min(document.documentElement.scrollHeight, 16000)');
    await c.shot(page, name, { captureBeyondViewport: true, clip: { x: 0, y: 0, width, height, scale: 1 } });
  };
  let sb = null;
  try {
    sb = await qa.launch({ name: `shots-${theme}`, theme, ai: true, ...seed() });
    c.sb = sb;
    result.ms.launch = Date.now() - t0;
    c.popup = await sb.openPopup({ focus: true });
    await c.popup.waitFor(`!!(window.api && document.querySelectorAll('.item').length >= 8)`, 'popup rows');
    await c.popup.fontsReady();
    c.items = await sb.historyState();
    const by = (pred) => { const it = c.items.find(pred); if (!it) throw new Error('seeded clip missing'); return it.id; };
    c.ids = {
      plan: by((i) => i.title === 'Launch plan'), json: by((i) => i.title === 'package.json snippet'), notes: by((i) => i.title === 'Design review'),
      wide: by((i) => i.title === 'Dashboard screenshot'), url: by((i) => /^https:\/\/example\.com/.test(i.text || '')),
      fox: by((i) => /^The quick brown fox/.test(i.text || '')), groceries: by((i) => /^Groceries for Saturday\n/.test(i.text || '')), filler: by((i) => i.text === 'Filler clip number 1 with a little text so the list scrolls'),
      thanks: by((i) => i.text === 'Thanks, see you tomorrow at 10!'),
      similar: [by((i) => /I will bring the printed slides/.test(i.text || '')), by((i) => i.text === 'see you   tomorrow at 10')],
    };
    result.ms.setup = Date.now() - t0 - result.ms.launch;
    for (const step of SELECTED) {
      const started = Date.now();
      try {
        if (step.popup) await resetPopup(c);
        await step.run(c);
      } catch (error) {
        result.skipped.push({ step: step.name, reason: String(error.message).slice(0, 240) });
        log(`[${theme}] SKIP ${step.name}: ${String(error.message).slice(0, 160)}`);
      }
      result.ms[step.name] = Date.now() - started;
    }
    const blocked = (await sb.events()).filter((e) => /paste|drag|foreground|dialog|open_|notification|clipboard_(key|api|permission)/.test(e.type));
    if (blocked.length) result.blocked = blocked.map((e) => e.type);
  } catch (error) {
    result.error = String(error.stack || error.message).slice(0, 600);
  } finally {
    if (sb) {
      const cleanup = await sb.finish();
      if (!cleanup.ok) result.cleanup = cleanup.problems;
    }
  }
  log(`[${theme}] ${result.shots.length} shots, ${result.skipped.length} skipped${result.error ? `, FAILED: ${result.error.split('\n')[0]}` : ''}`);
  return result;
}

const SELECTED = STEPS.filter((step) => !ONLY.length || ONLY.some((o) => step.name.includes(o)));
if (!SELECTED.length) { console.error(`--only matched no step; steps: ${STEPS.map((step) => step.name).join(', ')}`); process.exit(2); }

(async () => {
  const t0 = Date.now();
  OUT = path.resolve(OUT_ARG || fs.mkdtempSync(path.join(os.tmpdir(), 'bc-ui-shots-')));
  const site = await qa.startStaticServer(path.join(qa.ROOT, 'site'));
  let results;
  try {
    results = SERIAL
      ? await THEMES.reduce(async (acc, theme) => [...(await acc), await runTheme(theme, site)], Promise.resolve([]))
      : await Promise.all(THEMES.map((theme) => runTheme(theme, site)));
  } finally {
    await site.close();
  }
  const ok = results.every((r) => !r.error && r.skipped.length === 0 && !r.cleanup);
  const summary = { ok, out: OUT, ms: Date.now() - t0, themes: Object.fromEntries(results.map((r) => [r.theme, r])) };
  console.log(JSON.stringify(summary, null, 2));
  process.exit(ok ? 0 : 1);
})().catch((error) => { console.error('qa-ui-shots error:', error.stack || error.message); process.exit(1); });
