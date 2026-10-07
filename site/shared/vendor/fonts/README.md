# Vendored icon font: Material Symbols Rounded

- `material-symbols-rounded.woff2` (561,004 bytes, sha256
  `8fbf735bcf81756bdc32d66e4f04b189b3fa49fd30c50b06faa89834ca94c51a`), Apache-2.0
  (https://github.com/google/material-design-icons/blob/master/LICENSE).
- Source (2026-10-07): the Google Fonts css2 API, fetched with a Chrome 132 User-Agent so it
  answers with one woff2:
  `https://fonts.googleapis.com/css2?family=Material+Symbols+Rounded:opsz,wght,FILL,GRAD@20,400,0..1,0&display=block`
  -> `https://fonts.gstatic.com/s/materialsymbolsrounded/v376/syl7-zNym6YjUruM-QrEh7-nyTnjDwKNJ_190FjpZIvLgyidOK7BDB_Qb9vUdV6_gjDK-P2puF_Zs-obHph2-jOcZTKPqw.woff2`
- Axes: only what the canon pins on `.mi` (clipboard-popup.css): opsz 20, wght 400, GRAD 0
  fixed; FILL 0..1 kept variable (FILL 1 is the state signal, `--icon-fill`).

Declared ONCE, by the `@font-face` at the top of `site/shared/clipboard-popup.css`, which every
app window and the website load. `font-display: block`, so a window never shows the ligature
words ("settings", "close") while the font loads, and nothing waits on Google Fonts.

Re-vendor: fetch the same css2 URL with a current Chrome User-Agent (a different axis set needs
the `.mi` rule changed too), download the woff2 it names over this file, update the size, hash
and date above.
