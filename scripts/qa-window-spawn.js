'use strict';

// Sandbox QA: where clip windows open (owner 2026-10-13: "spawns under BC
// itself", "when i click on note, bc doesnt close... inconsisntent", "multi
// spawning they dont stack, it jsut all sits on top"). Against the real app in
// a throwaway instance (scripts/lib/qa-sandbox.js: temp data, cloaked windows,
// no system clipboard, no focus taken):
// 1. middle-clicking several notes with the popup up opens each BESIDE the
//    popup, never under it, each on its own cascade spot, and the popup stays;
// 2. a plain click on the clip menu's "Open in editor" closes the popup, like
//    the row's own open button;
// 3. with the popup gone, editors opened from the same saved spot cascade.
//
// Usage: node scripts/qa-window-spawn.js

const qa = require('./lib/qa-sandbox');

const checks = qa.createChecks();
const check = (ok, name) => checks.check(name, ok);
const J = JSON.stringify;

const overlap = (a, b) => a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;

async function main() {
  const now = Math.floor(Date.now() / 1000);
  const history = [];
  for (let i = 0; i < 6; i += 1) history.push({ type: 'text', title: `Note ${i}`, text: `note ${i} body`, ts: now - i * 60 });
  // The editors' saved spot; the popup is opened right over it (below).
  const SAVED = { x: 200, y: 200, width: 560, height: 520 };
  const sb = await qa.launch({ name: 'spawn', history, settings: { editor_bounds: SAVED, diagnostics_enabled: true } });
  console.log(`sandbox data: ${sb.dataDir}`);
  try {
    // The popup opens at the cursor: pin the cursor inside the saved spot.
    const cursor = { x: SAVED.x + 60, y: SAVED.y + 60 };
    await sb.mainEval(`(() => { const s = __qa.electron.screen; s.getCursorScreenPoint = () => (${J(cursor)}); return true; })()`);
    const popup = await sb.openPopup();
    await popup.waitFor(`typeof clipList !== 'undefined' && clipList.ids().length === ${history.length}`, 'popup rendered');
    const popupWin = '__qa.electron.BrowserWindow.getAllWindows().find((w) => /index\\.html/.test(w.webContents.getURL()))';
    const popupBounds = await sb.mainEval(`${popupWin}.getBounds()`);
    // A closed popup on Windows is parked (shown + cloaked), so isVisible()
    // says nothing: count main's popup.hide records instead.
    const hides = () => sb.diagnostics().filter((e) => e.event === 'popup.hide').length;
    const editors = () => sb.mainEval('__qa.electron.BrowserWindow.getAllWindows().filter((w) => !w.isDestroyed() && /editor\\.html/.test(w.webContents.getURL())).map((w) => w.getBounds())');
    const ids = await popup.eval('clipList.ids()');
    console.log(`popup ${J(popupBounds)}, saved editor spot ${J(SAVED)}`);
    check(overlap(popupBounds, SAVED), "set-up: the popup covers the editors' saved spot");

    // 1. Three middle-click opens (keepPopup) with the popup up.
    for (let i = 0; i < 3; i += 1) {
      const before = (await editors()).length;
      await popup.eval(`window.api.openEditor(${J(ids[i])}, { keepPopup: true })`);
      await qa.waitFor(async () => (await editors()).length === before + 1, `editor ${i} open`, 15000);
    }
    const kept = await editors();
    check(hides() === 0, 'the popup stays up through middle-click opens');
    check(kept.every((b) => !overlap(b, popupBounds)), `no editor opens under the popup: popup ${J(popupBounds)}, editors ${J(kept)}`);
    const spots = new Set(kept.map((b) => `${b.x},${b.y}`));
    check(spots.size === kept.length, `each editor has its own cascade spot: ${[...spots].join(' ')}`);

    // 2. The clip menu's Open in editor is a hand-off: the popup closes.
    const menuOpened = await popup.eval(`(async () => {
      const row = document.querySelector('#list [data-id="${ids[4]}"]');
      if (!row) return 'no row';
      const r = row.getBoundingClientRect();
      row.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: r.left + 20, clientY: r.top + 10, button: 2 }));
      await new Promise((res) => setTimeout(res, 300));
      const item = document.querySelector('.bc-menu [data-action="edit"]');
      if (!item) return 'no menu item';
      item.click();
      return 'clicked';
    })()`);
    check(menuOpened === 'clicked', `the clip menu offers Open in editor (${menuOpened})`);
    await qa.waitFor(async () => (await editors()).length === kept.length + 1, 'menu open', 15000);
    await qa.waitFor(() => hides() > 0, 'popup closed after the menu open', 5000).catch(() => {});
    check(hides() > 0, "a plain click on the menu's Open in editor closes the popup, like the row button");
    const handed = (await editors()).find((b) => !kept.some((k) => k.x === b.x && k.y === b.y));
    check(handed && handed.x === SAVED.x && handed.y === SAVED.y, `with the popup closing, the window opens at its saved spot: ${J(handed)}`);

    // 3. Popup gone: more editors from the same saved spot cascade, none on another's spot.
    for (const id of [ids[3], ids[5]]) {
      const before = (await editors()).length;
      await popup.eval(`window.api.openEditor(${J(id)})`);
      await qa.waitFor(async () => (await editors()).length === before + 1, 'editor opened with the popup closed', 15000);
    }
    const all = await editors();
    const allSpots = new Set(all.map((b) => `${b.x},${b.y}`));
    check(allSpots.size === all.length, `every open editor has its own spot (${all.length} windows): ${[...allSpots].join(' ')}`);
  } finally {
    const r = await sb.kill();
    console.log(`sandbox removed: ${r.removed}`);
  }
  if (checks.summary().failed) process.exitCode = 1;
}

main().catch((error) => { console.error(error); process.exit(1); });
