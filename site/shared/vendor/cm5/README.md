# Vendored CodeMirror 5 merge view

- codemirror@5.65.21 (lib/codemirror.js|css, addon/merge/merge.js|css), MIT
- diff-match-patch@1.0.5 wrapped as diff-match-patch.js (browser globals shim), Apache-2.0

Used by the shared reconciliation view (Core.createReconciliationView) in BOTH the
app editor window (editor.html) and the website demo. Re-vendor by copying from
node_modules and re-running the shim snippet in the repo history.

## BOARDCLIP PATCHES (marked `// BOARDCLIP PATCH` in merge.js)

1. `drawConnectorsForChunk`: honors `options.chunkState(dv, chunk)` returning
   `'quiet'` (draw nothing — used for whitespace-only chunks) or `'declined'`
   (dimmed `bc-declined` connector, no buttons); renders an extra decline (x)
   button per chunk when `options.declineChunk` is set.
2. `buildGap` click delegation: decline buttons (`node.bcDecline`) route to
   `options.declineChunk(dv, chunk)` instead of copyChunk.
3. `buildGap`: exposes `dv.bcRedraw()` so the wrapper can repaint the gap after
   a chunk-state change without an editor edit.

Re-apply these when re-vendoring a newer codemirror.
