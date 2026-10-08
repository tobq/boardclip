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
4. `unclearNearChunks`: skips `chunkState==='quiet'` chunks so identical-
   ignoring-whitespace regions collapse straight through them.
5. `MergeView.prototype.bcRecollapse()` + `_bcCollapseMarks` tracking: re-fold
   identical stretches after the diff changes (merge/decline/WS toggle).
6. `bcWordDiff` + `bcMarkDiff` (after `getDiff`), used by `registerUpdate`'s
   `update()`: the inline marks come from a WORD-level copy of the diff. In-line
   equalities (no line break) no longer than the edits on both sides fold into
   them (the diff_cleanupSemantic rule, kept off line breaks), edits widen to
   whole words, and an edit covering whole lines on every side is flagged
   (`part[2]`); under ignoreWhitespace a whitespace-only edit is flagged quiet
   (`part[3]`). It is built from the raw diff_main of the two texts, because
   getDiff's ignoreWhitespace drops whitespace-only parts (equalities too) and
   its positions drift. `getDiff` keeps that raw result on the cleaned diff
   (`diff.bcRaw`, a copy: its clean-up loop rewrites parts in place), so the
   texts are diffed ONCE per update (a second diff_main doubled the cost, up to
   the 1 s Diff_Timeout each on large rewritten texts). Chunks keep getDiff's diff, so the gutter buttons, the
   connectors and the wrapper's merge logic are unchanged.
7. `markChanges`: a flagged whole-line edit gets no inline mark (the chunk wash
   says it), so a rewritten line is one layer, not a wash plus a tile; a quiet
   (whitespace-only) edit moves the position and marks nothing.
8. `drawConnectorsForChunk`: the apply / decline buttons are Material Symbols
   ligatures (`mi` class: `arrow_forward` / `arrow_back`, `close`) instead of
   the unicode arrows and x.
9. `collapseSingle`: the folded-stretch widget says how much it hides
   ("12 unchanged lines").
10. `drawConnectorsForChunk`: `chunkState` may also return `'conflict'`, which
    adds `bc-conflict-connect` to the connector (drawn red like its lines).
