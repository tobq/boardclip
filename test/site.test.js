'use strict';
// Website (boardclip.app) guards: the page renders from the shared token tier
// in both themes, references its own files with relative URLs (Netlify serves
// site/ as the root, so they resolve the same as root-absolute ones and also
// from a file or the QA static server), and the embedded demo is the app popup
// with nothing the app does not have.
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const read = (rel) => fs.readFileSync(path.join(__dirname, '..', rel), 'utf8');
const siteHtml = read('site/index.html');
const siteCss = read('site/styles.css');
const appHtml = read('index.html');
const mainJs = read('main.js');
const stripComments = (css) => css.replace(/\/\*[\s\S]*?\*\//g, '');
const rules = (css) => [...stripComments(css).matchAll(/([^{}]+)\{([^{}]*)\}/g)].map((m) => ({ sel: m[1].trim(), body: m[2] }));
const decls = (css, prop) => [...stripComments(css).matchAll(new RegExp(`(?:^|[;{\\s])${prop}\\s*:\\s*([^;}]+)`, 'g'))].map((m) => m[1].trim());
// The marketing part of the page: everything before the shared scripts the demo runs on.
const marketing = siteHtml.slice(0, siteHtml.indexOf('<script src="shared/clip-search.js">'));
assert.ok(marketing.length > 1000, 'the demo scripts load from relative shared/ paths');

// 1) Relative URLs for every own file (page, demo data, stylesheet import).
{
  const absolute = siteHtml.match(/(?:href|src)="\/(?!\/)[^"]*"|["'`]\/(?:assets|shared|styles\.css|favicon)[^"'`]*["'`]/g);
  assert.strictEqual(absolute, null, `site/index.html references its own files root-absolute: ${absolute}`);
  for (const ref of ['href="favicon.png"', 'href="styles.css"', 'href="shared/clipboard-popup.css"', 'src="shared/clipboard-ui-core.js"']) {
    assert.ok(siteHtml.includes(ref), `site/index.html should reference ${ref}`);
  }
  assert.ok(/^@import url\("shared\/clipboard-tokens\.css"\);/m.test(siteCss), 'site/styles.css imports the shared token layer first, relatively');
  assert.ok(!/url\(\s*["']?\//.test(stripComments(siteCss)), 'site/styles.css has a root-absolute url()');
}

// 2) Light + dark from the shared semantic tier: <html> gets data-theme from
//    the system theme, and the page CSS has no palette or scale of its own.
{
  assert.ok(/documentElement\.dataset\.theme = dark\.matches \? "dark" : "light"/.test(marketing + siteHtml.slice(0, 2000)), 'the page writes data-theme on <html> from prefers-color-scheme');
  assert.ok(/dark\.addEventListener\("change"/.test(siteHtml), 'the page theme follows a live system theme change');
  assert.ok(!/color-scheme\s*:/.test(stripComments(siteCss)), 'site/styles.css locks a color-scheme (the token tier sets it per theme)');
  assert.ok(!/#[0-9a-f]{3,8}\b|rgba?\(|hsla?\(/i.test(stripComments(siteCss)), 'site/styles.css hard-codes a colour (use the semantic tokens)');
  assert.ok(!/var\(--(?:g|blue|teal|green|red|amber)-\d/.test(siteCss), 'site/styles.css reaches for a primitive colour (use the semantic tier)');
  for (const v of decls(siteCss, 'font-size')) assert.ok(/^var\(--fs-(?:meta|ui|text|display)\)$/.test(v), `site font-size "${v}" is not a role token`);
  for (const v of decls(siteCss, 'font-weight')) assert.ok(/^var\(--fw-(?:regular|strong)\)$/.test(v), `site font-weight "${v}" is not --fw-regular/--fw-strong`);
  for (const v of decls(siteCss, 'border-radius')) assert.ok(/^var\(--r-(?:1|ctl|chip|panel)\)$/.test(v), `site border-radius "${v}" is not a radius token`);
  for (const v of decls(siteCss, 'line-height')) assert.ok(/^(?:var\(--lh-(?:ui|text)\)|1)$/.test(v), `site line-height "${v}" is not a role token`);
  for (const v of decls(siteCss, 'font-family')) assert.ok(/^var\(--font-(?:sans|mono)\)$/.test(v), `site font-family "${v}" spells out a stack`);
}

// 3) Page rules target classes, so nothing leaks into the demo popup: no bare
//    element selector beyond the page reset (html, body, *, [hidden]).
{
  const allowed = /^(?:html|body|\*(?:::?before|::?after)?|\[hidden\]|:root|:where\(\.demo-window, \.demo-window \*\))$/;
  for (const r of rules(siteCss)) {
    if (/^@|^(?:from|to|\d+%)$/.test(r.sel)) continue;
    for (const part of r.sel.split(/,\s*/)) {
      const first = part.trim().split(/\s+|>|\+|~/)[0];
      if (/^[a-z]/i.test(first)) assert.ok(allowed.test(part.trim()), `site/styles.css: "${part.trim()}" styles a bare element (scope it to a page class)`);
    }
  }
}

// 4) One filled primary on the page (Download); tabs are the shared .seg.
{
  assert.strictEqual((marketing.match(/class="btn primary"/g) || []).length, 1, 'the page has exactly one filled primary button');
  assert.ok((marketing.match(/class="seg"/g) || []).length >= 3, 'install method + OS tabs use the shared .seg');
  assert.ok(!/method-tab|os-tab|download-button|github-button/.test(siteHtml + siteCss), 'a retired site tab/button component is back (use .seg / .btn)');
}

// 5) The demo is the app popup: its default size, no footer strip, no ghost
//    cursor, and the Appearance rows the app shows without the debug flag.
{
  const winW = Number((mainJs.match(/^const WIN_W = (\d+);/m) || [])[1]);
  const winH = Number((mainJs.match(/^const WIN_H = (\d+);/m) || [])[1]);
  assert.ok(new RegExp(`--demo-w:\\s*${winW}px`).test(siteCss) && new RegExp(`--demo-h:\\s*${winH}px`).test(siteCss),
    `the demo frame must be the app popup's default ${winW}x${winH}`);
  assert.ok(!/afterListHtml/.test(siteHtml), 'the demo passes afterListHtml (the app popup has no footer strip)');
  assert.ok(!/demo-foot|random-query|demo-guide|runGuide|guideTimer/.test(siteHtml + siteCss), 'the demo footer strip or the ghost cursor is back');
  const appFields = (appHtml.match(/\n\s*: \[('surfaceStyle'[^\]]*)\];/) || [])[1];
  assert.ok(appFields, "index.html's non-debug appearance field list was not found");
  const siteFields = (siteHtml.match(/fields: \[([^\]]*)\],/) || [])[1];
  assert.ok(siteFields, 'the demo must pass an explicit appearance field list to createVariantSwitcher');
  assert.deepStrictEqual(siteFields.replace(/["']/g, '').split(/,\s*/), appFields.replace(/["']/g, '').split(/,\s*/),
    'the demo shows the same Appearance rows as the app (no audit axes)');
  assert.ok(!/uiBorders|uiCorners|accentVariant|uiDensity/.test(siteHtml), 'the demo applies or stores an audit axis');
}

// 6) Copy: no em dashes, no slop vocabulary in the marketing text.
{
  assert.ok(!/\u2014/.test(marketing + siteCss), 'site copy or CSS contains an em dash');
  assert.ok(!/supercharge|seamless|effortless|blazing|unleash|revolution|game.?chang|next.?level/i.test(marketing), 'site copy uses slop vocabulary');
}

console.log('site.test.js: all assertions passed');
