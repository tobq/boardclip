'use strict';

// File names for image clips dragged out of BoardClip (popup rows, the image
// viewer). The drag hands the OS a temporary COPY named after the clip's title
// (else "BoardClip image <local date time>"), never the content-addressed
// original: a drop into a folder on the same drive is a MOVE by default, which
// would pull the image out from under its clip. Pure, so it is unit-tested.

const pad = (n) => String(n).padStart(2, '0');

function localStamp(tsSeconds) {
  const d = new Date((Number(tsSeconds) || 0) * 1000);
  if (!Number.isFinite(d.getTime())) return 'unknown time';
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}.${pad(d.getMinutes())}.${pad(d.getSeconds())}`;
}

// Windows-safe: no reserved characters, no trailing dots/spaces, no reserved
// device names, bounded length.
function safeBaseName(text) {
  let s = String(text || '')
    .replace(/[\u0000-\u001f<>:"/\\|?*]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 80)
    .replace(/[. ]+$/, '');
  if (/^(con|prn|aux|nul|com\d|lpt\d)$/i.test(s)) s = `${s} image`;
  return s;
}

function extensionOf(item) {
  const m = /\.([a-z0-9]{1,5})$/i.exec(String(item && item.image || ''));
  return m ? `.${m[1].toLowerCase()}` : '.png';
}

// One name per item, unique (case-insensitively) within the drag.
function dragFileNames(items) {
  const used = new Set();
  return (items || []).map((item) => {
    const base = safeBaseName(item && item.title) || `BoardClip image ${localStamp(item && item.ts)}`;
    const ext = extensionOf(item);
    let name = `${base}${ext}`;
    for (let n = 2; used.has(name.toLowerCase()); n += 1) name = `${base} (${n})${ext}`;
    used.add(name.toLowerCase());
    return name;
  });
}

module.exports = { dragFileNames, safeBaseName, localStamp };
