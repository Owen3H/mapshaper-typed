---
title: Snip tool design
description: Design notes for the GUI "snip polylines" interaction mode.
---

# Snip Tool Design

The snip tool is a new GUI interaction mode (`snip_lines`, menu label
"snip polylines") for cutting polyline features apart at a point chosen with the
mouse. Its hover interface mirrors the draw/edit polylines tool (`edit_lines`):
hovering a line highlights the feature and shows its vertices as dots, hovering
near a vertex highlights that vertex, and hovering between vertices shows a dot
at the interpolated location that would be targeted.

This document describes the tool's behavior and the reasoning behind its
implementation.

## Terminology

- **feature** / **shape**: one entry in `lyr.shapes`; an array of parts.
- **part** / **path**: one entry in a shape; an array of arc ids (negative id =
  arc traversed in reverse), forming a contiguous path.
- **node**: a vertex that is an endpoint of one of the part's arcs, i.e. a
  junction between two consecutive arcs in the part's sequence.
- **traversal**: the ordered vertex sequence produced by walking a part's arcs
  in sequence order and orientation.
- **ring**: a part whose traversal starts and ends at the same coordinates
  (`geom.pathIsClosed(part, arcs)`).
- **cut**: one snip location, normalized to a position along a part's traversal.

## User-visible behavior

### Hover

1. The hit test finds the nearest polyline feature under the pointer (tight
   hit buffer, same as `edit_lines`).
2. The whole hovered feature is drawn in the overlay style with `vertices: true`
   (already the case: `getLineEditingStyle()` handles `snip_lines`).
3. Within `HOVER_THRESHOLD` (10px) of a traversal vertex, that vertex is
   highlighted (violet, 2.5× dot).
4. Otherwise, if within threshold of a segment, an interpolated dot is drawn at
   the closest point on the segment (black, 2× dot).
5. Part endpoints of open paths are **not** offered as targets (see
   [Endpoints](#endpoints)).

### Click

A snip is triggered by the `click` event (fired on mouseup without an
intervening drag), not on mousedown, so that dragging to pan still works while
the pointer is over a line. Effects depend on the part:

| Part | State | Result |
| --- | --- | --- |
| Open path, cut strictly inside | — | Part divides into two sub-paths |
| Open path, cut at a part endpoint | — | No-op |
| Ring, first cut | no pending cut | No geometry change; cut is recorded as pending and marked on the map |
| Ring, second cut on the same part | pending cut | Ring divides into two open sub-paths with endpoints at the two cut locations |
| Ring, second cut at the same location as the pending cut | pending cut | Pending cut is cancelled |

After a part divides into sub-paths A and B, the **shorter** sub-path is split
off into a new single-part feature appended to the end of the layer, and the
longer sub-path replaces the original part. For a multipart feature this leaves
the longer piece connected to the rest of the feature; for a single-part feature
the two halves simply become two features. One rule, one code path.

The new feature gets a duplicate of the original attribute record, including any
id fields — a snip is not expected to invent new identifiers, so which half keeps
the original feature index is not attribute-visible.

This is what makes a lattice (many crossing parts in one multipart feature)
behave sanely: a cut only ever restructures the part it lands in, and only the
shorter piece leaves the feature.

### Endpoints

"Endpoint" here means an endpoint of the **part's traversal**, not an arc
endpoint. Interior nodes of a multi-arc part are perfectly good snip targets —
in fact they are the cheapest kind, because no arc has to be split. (The current
stub tests `internal.vertexIsArcStart/End`, which is the wrong predicate and
would reject valid interior nodes.)

- Open path: clicking either traversal endpoint is a no-op. The endpoint still
  gets a hover dot, drawn in a muted gray with the default cursor, so it reads as
  "not snippable" rather than as an unresponsive target.
- Ring: the traversal start/end vertex is not an open endpoint, so clicking it
  is a normal cut and counts as one of the ring's two cuts.

### Pending ring cut

A ring cannot be represented as "cut once": rotating a closed path so that it
starts and ends at the cut location produces a path that is still closed and
geometrically identical. There is no structural difference to record, so the
first cut on a ring must live in tool state, not in the model.

- At most one pending cut exists at a time.
- It is stored as `{fid, partId, seq, offset, point, displayPoint}` and rendered
  as a distinct marker (orange dot) so the user can see it registered.
- It reaches the renderer through `setPendingSnip()` / `clearPendingSnip()` on
  `HitControl`, mirroring the existing `setHoverVertex()` / `clearHoverVertex()`
  pair. `HitControl` replaces its whole stored hit object whenever the hit ids
  change, so — exactly like the hover vertex — the tool re-applies the marker on
  each hover event.
- Choosing the first cut does not change the model, so any `model.updated()`
  event between the two clicks means something else has changed and the pending
  cut is discarded. This is what invalidates it after a console command, an
  undo, or a layer switch.
- It is cleared by: completing the division, clicking the same location again,
  pressing Esc, leaving `snip_lines` mode, switching the target layer, undo/redo,
  or any other edit to the layer.
- Clicking a different feature or part while a cut is pending replaces the
  pending cut rather than queuing a second one.
- Because nothing is mutated by the first cut, the recorded position stays valid
  as long as the above invalidation rules hold, and the whole two-cut division
  is applied as a single atomic, undoable operation.

## Geometry implementation

### Strategy: append new arcs, never renumber

A cut that lands strictly inside an arc requires that arc to be divided, since a
part can only reference whole arcs. Two approaches are possible:

1. **In-place split with global remap** (what `insertCutPoints()` /
   `remapDividedArcs()` do): split the arc in the collection and shift every arc
   id above it in every layer of the dataset.
2. **Append the two halves as new arcs** at the end of the collection and
   rewrite only the affected part's arc ids. The original arc stays in the
   collection, orphaned unless another feature still references it.

The design uses (2), for several reasons:

- It touches only the feature being edited. If the arc is shared with another
  feature (or another layer in the same dataset), that feature is unaffected —
  which is the correct semantics for "snip this line".
- Undo is exact and cheap: restore the affected shapes and pop the appended
  arcs.
- It matches how the drawing tools already grow the arc collection
  (`appendNewPath` / `deleteLastPath`).

The cost is orphaned arcs. These are harmless for output (GeoJSON/Shapefile
export iterates shapes; TopoJSON export prunes unused arcs) and can be cleaned
up by existing utilities (`pruneArcs`, `dissolveArcs`) when needed.

Note also that the design never inserts a vertex into an existing arc. An
interpolated cut point is materialized only inside the two newly appended arcs,
so shared geometry is never modified.

### Cut normalization

A cut is normalized against a part's traversal as:

```js
{
  seq: k,        // index into part[]: which arc in the sequence
  offset: m,     // vertex index within that arc, in traversal orientation
  point: p       // interpolated coords, or null for an existing vertex
}
```

Normalization rules:

- `point` non-null: cut lies on the segment between traversal vertices `m` and
  `m + 1` of arc `part[k]`.
- `point` null, `0 < m < nn - 1`: cut at an interior vertex of arc `part[k]`;
  the arc must be split.
- `point` null, `m == 0`: cut at the node before arc `part[k]`; no arc split.
- `point` null, `m == nn - 1`: rewritten to `{seq: k + 1, offset: 0}` (or to a
  traversal endpoint if `k` is the last arc).

Traversal orientation is converted to forward arc orientation before touching
the arc collection: for `part[k] < 0`, forward offset is `nn - 1 - m`.

### Core primitive

`src/paths/mapshaper-arc-split.mjs`, reached from the GUI as `internal.*`:

```js
// Append 2 or 3 new arcs built from slices of an existing arc.
// cuts: 1 or 2 cut positions in forward orientation, ascending, each
//   {offset: m, point: p|null}
// Returns the ids of the appended arcs, in forward order.
splitArcAtCuts(arcs, arcId, cuts) -> [id1, id2] | [id1, id2, id3]
```

Slice semantics for one cut `{offset: m, point: p}`, computed by the pure helper
`getArcSlices(n, cuts)`:

- `p` given: head = `coords[0..m]` + `p`, tail = `p` + `coords[m+1..n-1]`.
- `p` null: head = `coords[0..m]`, tail = `coords[m..n-1]` (the cut vertex is
  duplicated, which is what makes the two paths meet at the cut).

Two cuts in the same arc produce three slices by the same rule. `zz` values are
copied along with `xx`/`yy` so simplification thresholds survive; interpolated
points get `zz = Infinity`, and so do the endpoints of every new arc, since an
arc endpoint must never be simplified away. The GUI wrapper `splitArc()` in
`gui-drawing-utils.mjs` applies the identical operation to
`lyr.gui.source.dataset.arcs` and, for dynamically reprojected layers, to
`lyr.gui.displayArcs`, so arc ids stay in lockstep between the two collections.

### Division planner (pure)

The sequencing logic is a pure function, unit-tested without an ArcCollection or
a live GUI:

```js
// path: array of arc ids
// cuts: 1 cut (open path) or 2 cuts (ring), in any order
// arcLen: function(arcId) -> vertex count
// baseId: arcs.size(), used to predict ids of arcs that will be appended
// closed: whether the path is a ring
// Returns:
//   {splits: [{arcId, cuts: [...]}], a: [arcIds], b: [arcIds]}
//   or null if the cut set is degenerate (endpoint cut, duplicate cuts)
planPathDivision(path, cuts, arcLen, baseId, closed)
```

Internally it builds an *expanded* arc-id sequence — the path with any cut arcs
replaced by their pieces — plus the positions in that sequence where cuts fall
(a cut position sits *between* two expanded elements). Then:

- open path, one cut at position `q`: `a = expanded[0..q-1]`,
  `b = expanded[q..]`; `q == 0` or `q == expanded.length` means the cut is at a
  traversal endpoint, which is a no-op.
- ring, two cuts at positions `q1 < q2`: `a = expanded[q1..q2-1]`,
  `b = expanded[q2..] ++ expanded[0..q1-1]`; `q1 == q2` is degenerate.

This handles the awkward ring cases uniformly, including both cuts landing
inside the same arc (three-way slice) and a single-arc closed ring (`b` wraps
through the ring's original start/end).

### Applying the division

`snipPath(lyr, fid, partId, cuts)` in `gui-snipping-utils.mjs`:

1. `plan = internal.planPathDivision(...)`; bail out if null.
2. Execute `plan.splits` against both arc collections.
3. Measure `plan.a` and `plan.b` with `internal.getPlanarPathLength()`; the
   shorter one is the piece that splits off.
4. Replace `shape[partId]` with the longer sub-path; append a new feature
   `[shorter]` plus a copy of the original attribute record.
5. Return a descriptor for undo:

```js
{
  fid, partId,
  prevShape,          // the shape's part array before the edit
  newFeatureId,       // index of the appended feature
  appendedArcCount,   // 2 or 3, or 0 for a node cut
  cuts                // for redo
}
```

`undoSnip(lyr, result)` reverses it: remove the appended feature, restore the
shape, and pop the appended arcs from both collections.

## Undo/redo

Following the existing in-mode closure pattern in `gui-undo.mjs`, the tool
dispatches a `snip` event and `gui-undo.mjs` registers:

- **undo**: `undoSnip()`, which restores `lyr.shapes[fid]`, pops the appended
  feature and its attribute record, and pops `appendedArcCount` arcs from both
  arc collections (LIFO order is guaranteed by the history stack).
- **redo**: re-run `snipPath()` with the recorded `cuts`. Because the previous
  snip's arcs were removed from the end of the collection, the redo produces the
  same arc ids; the new result descriptor replaces the old one.

Adding `snip_lines` to `InteractionMode.modeSupportsUndo()` also gives the mode
app-level undo for free: `captureEditTarget()` already captures layer, table,
and arcs before-state for path layers, and the edit session collapses into one
stored undo entry when the mode is exited.

A pending ring cut is *not* an undo entry, since it does not change the model.
Esc cancels it.

## Session command history

There is no CLI command that expresses "cut feature 3, part 0, at this point",
so snips produce no session history entry — the same as the other interactive
geometry tools (draw/edit polylines, add/drag points). A future `-snip`
command could make the operation replayable; that is out of scope here.

## Where the code lives

| File | Role |
| --- | --- |
| `src/paths/mapshaper-arc-split.mjs` | `getArcSlices()`, `splitArcAtCuts()`, `planPathDivision()`, `getPlanarPathLength()` |
| `src/mapshaper-internal.mjs` | exports the above as `internal.*` |
| `src/gui/gui-snipping-utils.mjs` | `snipPath()`, `undoSnip()` |
| `src/gui/gui-snip-tool.mjs` | the tool: path-aware hover, pending ring cut, endpoint no-op, click handling, cursor, instructions |
| `src/gui/gui-drawing-utils.mjs` | `splitArc()`, `deleteLastArcs()`, `appendFeature()` |
| `src/gui/gui-interaction-mode-control.mjs` | `snip_lines` in `menus.lines` and `modeSupportsUndo()` |
| `src/gui/gui-shape-hit.mjs` | tight `vertexTest` hit detection for `snip_lines` |
| `src/gui/gui-hit-control.mjs` | `hover`/`click` enabled for `snip_lines`; `setPendingSnip()` / `clearPendingSnip()` |
| `src/gui/gui-overlay-styler.mjs` | muted colour for a disabled vertex; pending-cut point |
| `src/gui/gui-canvas.mjs` | draws the pending-cut marker in `drawVertices()` |
| `www/page.css` | `.snip-tool` and `.snip-tool.no-snip` cursors |
| `test/arc-split-test.mjs` | slicing and division planning |
| `test/gui-snipping-utils-test.mjs` | snip and undo against a stand-in map layer |
| `docs/essentials/web-app.md` | user documentation |

## Known limitations

- Snips produce no session command history entry, so they are not part of a
  replayable script. This matches the other interactive geometry tools.
- Hover targets are found on full-detail geometry. With simplification active,
  the tool can therefore snap to a vertex that is not currently drawn. The cut
  itself stays correct, and the new arcs keep their thresholds, but hover and
  display can disagree until simplification is turned off.
- Orphaned arcs accumulate in the collection until something prunes them.

## Remaining test work

The pure logic and the layer-level snip are covered by unit tests. Still worth a
Playwright regression: snipping an open line, snipping a ring in two clicks,
cancelling a pending cut, and undo/redo of each, driven through the real UI.
