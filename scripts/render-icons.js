// Renders every icon file from the two vector sources, so the app, the
// installers and the site all draw the ONE logo:
//   assets/boardclip-logo.svg  -> icon.png (256), icon@2x.png (512),
//     assets/boardclip-icon.png (512), assets/boardclip-icon.ico (16-256),
//     site/favicon.png (256), site/favicon.svg (the source itself) and
//     assets/boardclip-icon-mac.png (1024: the tile inset to Apple's icon
//     grid, 824 px on the canvas with its soft shadow, so it sits like every
//     other Mac app icon in Finder and Launchpad; Windows, the site and the
//     tray keep the full-bleed tile)
//   assets/boardclip-tray.svg  -> iconTemplate.png (16) + @2x (32): the macOS
//     menu-bar TEMPLATE (black on transparent; macOS keeps only its alpha and
//     paints it in the menu bar's label colour)
// Each size is drawn from the vector at that size (no downscaled bitmaps), on
// a canvas in a hidden Electron window.
//   npm run sync:icons
//   npx electron scripts/render-icons.js --preview <a.svg> [b.svg ...] --out <dir>
//     (renders each SVG at 512 / 64 / 32 / 16 into <dir>, for comparing designs)
'use strict';

const fs = require('fs');
const path = require('path');
const { app, BrowserWindow } = require('electron');

const ROOT = path.join(__dirname, '..');
const ICO_SIZES = [16, 20, 24, 32, 40, 48, 64, 128, 256];

// inset: px of transparent margin on each side (the macOS grid), with the
// grid's soft shadow under the tile.
async function rasterize(win, svg, size, inset = 0) {
  const src = `data:image/svg+xml;base64,${Buffer.from(svg).toString('base64')}`;
  const body = size - 2 * inset;
  const dataUrl = await win.webContents.executeJavaScript(`new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => {
      const c = document.createElement('canvas');
      c.width = ${size};
      c.height = ${size};
      const ctx = c.getContext('2d');
      ctx.imageSmoothingQuality = 'high';
      if (${inset} > 0) {
        ctx.shadowColor = 'rgba(0, 0, 0, 0.3)';
        ctx.shadowBlur = ${Math.round(size * 0.028)};
        ctx.shadowOffsetY = ${Math.round(size * 0.012)};
      }
      ctx.drawImage(img, ${inset}, ${inset}, ${body}, ${body});
      resolve(c.toDataURL('image/png'));
    };
    img.onerror = () => reject(new Error('svg failed to load'));
    img.src = ${JSON.stringify(src)};
  })`);
  return Buffer.from(dataUrl.slice(dataUrl.indexOf(',') + 1), 'base64');
}

// An .ico holding one PNG per size (Windows picks the closest for the
// taskbar, Explorer, Start and the installer).
function icoFromPngs(entries) {
  const header = Buffer.alloc(6 + 16 * entries.length);
  header.writeUInt16LE(0, 0);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(entries.length, 4);
  let offset = header.length;
  entries.forEach(({ size, png }, i) => {
    const at = 6 + 16 * i;
    header.writeUInt8(size >= 256 ? 0 : size, at);
    header.writeUInt8(size >= 256 ? 0 : size, at + 1);
    header.writeUInt8(0, at + 2);
    header.writeUInt8(0, at + 3);
    header.writeUInt16LE(1, at + 4);
    header.writeUInt16LE(32, at + 6);
    header.writeUInt32LE(png.length, at + 8);
    header.writeUInt32LE(offset, at + 12);
    offset += png.length;
  });
  return Buffer.concat([header, ...entries.map((e) => e.png)]);
}

async function main() {
  const win = new BrowserWindow({ show: false, width: 64, height: 64, webPreferences: { offscreen: true, sandbox: true } });
  await win.loadURL('data:text/html,<!doctype html><title>icons</title>');
  const args = process.argv.slice(2);
  const preview = args.indexOf('--preview');
  if (preview >= 0) {
    const outIdx = args.indexOf('--out');
    const out = outIdx >= 0 ? args[outIdx + 1] : path.join(ROOT, '.qa', 'icon-preview');
    const files = args.slice(preview + 1, outIdx > preview ? outIdx : undefined);
    fs.mkdirSync(out, { recursive: true });
    for (const file of files) {
      const svg = fs.readFileSync(file, 'utf8');
      for (const size of [512, 64, 32, 16]) {
        fs.writeFileSync(path.join(out, `${path.basename(file, '.svg')}-${size}.png`), await rasterize(win, svg, size));
      }
    }
    console.log(`previews in ${out}`);
    return;
  }
  const logo = fs.readFileSync(path.join(ROOT, 'assets', 'boardclip-logo.svg'), 'utf8');
  const tray = fs.readFileSync(path.join(ROOT, 'assets', 'boardclip-tray.svg'), 'utf8');
  const write = (rel, buf) => fs.writeFileSync(path.join(ROOT, rel), buf);
  const png512 = await rasterize(win, logo, 512);
  const png256 = await rasterize(win, logo, 256);
  write('assets/boardclip-icon.png', png512);
  write('icon@2x.png', png512);
  write('icon.png', png256);
  write('site/favicon.png', png256);
  write('site/favicon.svg', logo);
  write('assets/boardclip-icon-mac.png', await rasterize(win, logo, 1024, 100));
  const ico = [];
  for (const size of ICO_SIZES) ico.push({ size, png: await rasterize(win, logo, size) });
  write('assets/boardclip-icon.ico', icoFromPngs(ico));
  write('iconTemplate.png', await rasterize(win, tray, 16));
  write('iconTemplate@2x.png', await rasterize(win, tray, 32));
  console.log('Rendered the app, installer, tray and site icons from assets/boardclip-logo.svg + boardclip-tray.svg');
}

app.whenReady().then(main).then(() => app.exit(0), (err) => {
  console.error(err && err.stack ? err.stack : err);
  app.exit(1);
});
