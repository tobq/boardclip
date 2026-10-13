'use strict';

// Where a clip window (editor, viewer, unify, conflict) opens, as pure maths so
// it is unit-tested (test/window-placement.test.js); main.js supplies the saved
// bounds, the display's work area, the clip windows already showing and the
// popup's bounds when the popup stays up. Owner 2026-10-13: "spawns under BC
// itself" / "multi spawning they dont stack, it jsut all sits on top".
// - A clip window already open at the spot pushes the new one a cascade step on,
//   wrapping inside the work area, like the OS cascades documents.
// - With the popup up (keepPopup opens) the window goes beside the popup, never
//   under it: the popup is always on top. It fans out away from the popup.

const CASCADE_STEP = 28;
const POPUP_GAP = 8;
function rectsOverlap(a, b) {
  return a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;
}
function clampInto(rect, area) {
  return {
    ...rect,
    x: Math.max(area.x, Math.min(rect.x, area.x + area.width - rect.width)),
    y: Math.max(area.y, Math.min(rect.y, area.y + area.height - rect.height)),
  };
}
// Pure placement (unit-tested): base = the saved bounds (x/y may be missing),
// area = the work area to stay in, taken = top-left corners of the clip windows
// already showing, avoid = the open popup's bounds when it stays up.
function placeClipWindowBounds(base, { area, taken = [], avoid = null } = {}) {
  const width = Math.min(base.width, area.width);
  const height = Math.min(base.height, area.height);
  let start = Number.isFinite(base.x) && Number.isFinite(base.y)
    ? clampInto({ x: base.x, y: base.y, width, height }, area)
    : { x: Math.round(area.x + (area.width - width) / 2), y: Math.round(area.y + (area.height - height) / 2), width, height };
  // Cascade direction: down and right, unless the window sits left of / above
  // the popup, where it fans out away from the popup instead.
  let dx = 1;
  let dy = 1;
  if (avoid && rectsOverlap(start, avoid)) {
    const midY = avoid.y + Math.round((avoid.height - height) / 2);
    const midX = avoid.x + Math.round((avoid.width - width) / 2);
    const sides = [
      { x: avoid.x + avoid.width + POPUP_GAP, y: midY, dx: 1, dy: 1 },
      { x: avoid.x - POPUP_GAP - width, y: midY, dx: -1, dy: 1 },
      { x: midX, y: avoid.y + avoid.height + POPUP_GAP, dx: 1, dy: 1 },
      { x: midX, y: avoid.y - POPUP_GAP - height, dx: 1, dy: -1 },
    ].map((s) => ({ ...s, rect: clampInto({ x: s.x, y: s.y, width, height }, area) }));
    const overlapArea = (r) => Math.max(0, Math.min(r.x + width, avoid.x + avoid.width) - Math.max(r.x, avoid.x))
      * Math.max(0, Math.min(r.y + height, avoid.y + avoid.height) - Math.max(r.y, avoid.y));
    const best = sides.find((s) => !rectsOverlap(s.rect, avoid))
      || sides.slice().sort((a, b) => overlapArea(a.rect) - overlapArea(b.rect))[0];
    start = best.rect;
    dx = best.dx;
    dy = best.dy;
  }
  // The cascade walks diagonals (one step down and along per window); a
  // diagonal that leaves the work area starts the next one a step further
  // along at the area's top (or bottom, when fanning upward), like the OS
  // cascade. The first spot no showing clip window holds wins.
  const near = (p, q) => Math.abs(p.x - q.x) < 8 && Math.abs(p.y - q.y) < 8;
  const fits = (p) => p.x >= area.x && p.y >= area.y && p.x + width <= area.x + area.width && p.y + height <= area.y + area.height;
  // A wrapped spot never lands under the popup (unless no side had room for
  // the window, when the least-covered spot is the best there is).
  const besideFits = !(avoid && rectsOverlap(start, avoid));
  const underPopup = (r) => !!avoid && besideFits && rectsOverlap(r, avoid);
  const spanX = Math.max(1, area.width - width + 1);
  const wrapX = (x) => area.x + ((((x - area.x) % spanX) + spanX) % spanX);
  for (let column = 0; column < 64; column += 1) {
    const x0 = wrapX(start.x + dx * column * CASCADE_STEP);
    const y0 = column === 0 ? start.y : dy > 0 ? area.y : area.y + area.height - height;
    for (let step = 0; step < 64; step += 1) {
      const p = { x: x0 + dx * step * CASCADE_STEP, y: y0 + dy * step * CASCADE_STEP };
      if (!fits(p)) break;
      if (underPopup({ ...p, width, height })) continue;
      if (!taken.some((t) => near(t, p))) return { x: p.x, y: p.y, width, height };
    }
  }
  return { x: start.x, y: start.y, width, height };
}

module.exports = { placeClipWindowBounds, rectsOverlap, clampInto, CASCADE_STEP, POPUP_GAP };
