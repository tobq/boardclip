'use strict';

// Appearance settings, pure: validation, the one-time promotion of the old
// debug-only axes, the synced merge and the window surface options. main.js
// owns the live parts (OS accent watchers, window broadcasts); everything here
// is data in, data out, so it is unit-tested without Electron.
//
// Which keys travel between devices:
// - SYNCED (one choice the user makes once): accent_mode + accent_custom,
//   ui_density, ui_corners. Each group carries a last-change stamp in
//   appearance_stamps; a remote copy wins only with a NEWER stamp, so a device
//   that never touched a setting (stamp 0, or an older build that sends no
//   stamps) can never overwrite one that did. "System" accent is synced as the
//   CHOICE; the colour it resolves to is read per device.
// - PER MACHINE: surface_style (glass support is hardware-dependent),
//   glass_scope, and the audit-only ui_borders.

const ACCENT_MODES = ['system', 'blue', 'teal', 'mono', 'custom'];
const ACCENT_PRESETS = ['blue', 'teal', 'mono'];
const DENSITIES = ['normal', 'compact'];
const CORNERS = ['soft', 'sharp'];
const BORDERS = ['bordered', 'borderless'];
const SURFACE_STYLES = ['auto', 'glass', 'solid'];
const GLASS_SCOPES = ['popup', 'all'];

// Synced groups -> the settings keys each stamp covers.
const SYNCED_GROUPS = {
  accent: ['accent_mode', 'accent_custom'],
  density: ['ui_density'],
  corners: ['ui_corners'],
};

// '#rgb', '#rrggbb', '#rrggbbaa', or the same without '#' (Electron's
// getAccentColor and 'accent-color-changed' give 'rrggbbaa') -> '#rrggbb'
// lowercase, alpha dropped. Anything else -> null. ONE rule for main's
// validator and the renderer's Custom field: the shared core's.
const { normalizeHexColor: normalizeAccentHex } = require('../site/shared/clipboard-ui-core');

// The accent a window paints with. preset = the token palette the CSS keys on
// (data-accent); color = an explicit '#rrggbb' laid over it (System, Custom),
// null when the preset alone applies or the colour is unknown.
function resolveAccent({ mode, custom, system } = {}) {
  const m = ACCENT_MODES.includes(mode) ? mode : 'system';
  if (ACCENT_PRESETS.includes(m)) return { mode: m, preset: m, color: null };
  const color = m === 'custom' ? normalizeAccentHex(custom) : normalizeAccentHex(system);
  return { mode: m, preset: 'blue', color };
}

// Validators for every appearance key save-settings and the synced merge accept.
const VALIDATORS = {
  accent_mode: (v) => (ACCENT_MODES.includes(v) ? v : undefined),
  // '' clears the custom colour.
  accent_custom: (v) => (v === '' ? '' : (normalizeAccentHex(v) || undefined)),
  ui_density: (v) => (DENSITIES.includes(v) ? v : undefined),
  ui_corners: (v) => (CORNERS.includes(v) ? v : undefined),
  ui_borders: (v) => (BORDERS.includes(v) ? v : undefined),
  surface_style: (v) => (SURFACE_STYLES.includes(v) ? v : undefined),
  glass_scope: (v) => (GLASS_SCOPES.includes(v) ? v : undefined),
};
const GROUP_OF = Object.fromEntries(Object.entries(SYNCED_GROUPS).flatMap(([g, keys]) => keys.map((k) => [k, g])));

function stampOf(settings, group) {
  const stamps = settings && settings.appearance_stamps;
  const n = Number(stamps && typeof stamps === 'object' ? stamps[group] : 0);
  return Number.isFinite(n) && n > 0 ? n : 0;
}
// A new stamps object (never the shared default's) in one key order, so two
// devices holding the same stamps serialize them identically.
function withStamps(settings, updates) {
  const stamps = {};
  for (const group of Object.keys(SYNCED_GROUPS)) {
    const n = updates[group] !== undefined ? updates[group] : stampOf(settings, group);
    if (n > 0) stamps[group] = n;
  }
  return stamps;
}

// Applies the appearance keys of a save-settings body to `settings` (mutated).
// Invalid values are ignored. A synced group whose value changed gets a fresh
// stamp. The old debug switcher's accent_variant is an alias for accent_mode.
// -> { changed: [keys whose value changed], synced: true when a synced group changed }
function applyAppearanceSettings(settings, body, { now = Date.now() } = {}) {
  const changed = [];
  const b = body && typeof body === 'object' ? body : {};
  const input = { ...b };
  if (input.accent_mode === undefined && ACCENT_PRESETS.includes(input.accent_variant)) input.accent_mode = input.accent_variant;
  const stamped = new Set();
  for (const [key, validate] of Object.entries(VALIDATORS)) {
    if (input[key] === undefined) continue;
    const value = validate(input[key]);
    if (value === undefined || settings[key] === value) continue;
    settings[key] = value;
    changed.push(key);
    if (GROUP_OF[key]) stamped.add(GROUP_OF[key]);
  }
  if (stamped.size) {
    const updates = {};
    for (const group of stamped) updates[group] = Math.max(now, stampOf(settings, group) + 1);
    settings.appearance_stamps = withStamps(settings, updates);
  }
  return { changed, synced: stamped.size > 0 };
}

// Folds a remote device's synced appearance into `local` (mutated): per group,
// the newer stamp wins, and only with values that validate. -> true if changed.
function mergeSyncedAppearance(local, remote) {
  if (!local || !remote || typeof remote !== 'object') return false;
  let changed = false;
  for (const [group, keys] of Object.entries(SYNCED_GROUPS)) {
    const theirs = stampOf(remote, group);
    if (!(theirs > stampOf(local, group))) continue;
    const values = {};
    let valid = true;
    for (const key of keys) {
      const value = remote[key] === undefined ? undefined : VALIDATORS[key](remote[key]);
      if (value === undefined) { valid = false; break; }
      values[key] = value;
    }
    if (!valid) continue;
    Object.assign(local, values);
    local.appearance_stamps = withStamps(local, { [group]: theirs });
    changed = true;
  }
  return changed;
}

// One-time promotion of the old audit axes, run on the settings file AS READ
// (before defaults fill it in). A file that already has accent_mode is done.
// The old accent_variant / ui_density / ui_corners applied ONLY under
// BOARDCLIP_DEBUG_VARIANTS, so a value left in a file from an audit session
// was never on screen (the live install still held ui_corners 'sharp' from
// 2026-09). Promoting such a value would change the look on upgrade and then
// sync it to every device: the 2026-09-02 "looks different per machine" bug.
// So they carry over only where the flag is on (where they WERE the look);
// elsewhere the defaults apply, which is exactly what that machine showed.
// 'blue' was the old default, indistinguishable from "never chosen", so it
// becomes the new default (System) like an unset value. Migrated values get
// no stamp: they stay on this device until the user picks something.
function migrateAppearanceSettings(raw, { debugVariants = false } = {}) {
  if (!raw || typeof raw !== 'object') return raw;
  const out = { ...raw };
  if (out.accent_mode === undefined) {
    const legacy = out.accent_variant;
    out.accent_mode = debugVariants && (legacy === 'teal' || legacy === 'mono') ? legacy : 'system';
    if (!debugVariants) { delete out.ui_density; delete out.ui_corners; }
  }
  delete out.accent_variant;
  return out;
}

// BrowserWindow options for a window's surface. support = 'vibrancy' (macOS)
// | 'acrylic' (Windows 11) | 'none'. Windows uses acrylic (transparent stays
// false) and switches it live on any window. On macOS transparency is fixed at
// creation: a window that must switch glass <-> solid while open (live: the
// popup) stays transparent:true and switches its vibrancy; one created solid
// otherwise (a secondary window under "Glass on: Popup only") is an ordinary
// OPAQUE window, which keeps the native shadow macOS gives opaque windows, and
// a later scope change reaches it the next time it opens.
function surfaceWindowOptions({ support, on, solidBackground, live = false }) {
  if (support === 'vibrancy' && (on || live)) {
    return { transparent: true, vibrancy: on ? 'popover' : undefined, visualEffectState: 'active', backgroundColor: '#00000000' };
  }
  if (support === 'acrylic' && on) return { backgroundMaterial: 'acrylic', backgroundColor: '#00000000' };
  return { backgroundColor: solidBackground };
}

module.exports = {
  ACCENT_MODES,
  ACCENT_PRESETS,
  DENSITIES,
  CORNERS,
  GLASS_SCOPES,
  SYNCED_GROUPS,
  normalizeAccentHex,
  resolveAccent,
  applyAppearanceSettings,
  mergeSyncedAppearance,
  migrateAppearanceSettings,
  surfaceWindowOptions,
};
