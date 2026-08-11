import { error } from '../utils/mapshaper-logging';
import { absArcId } from './mapshaper-arc-utils';
import { distance2D } from '../geom/mapshaper-basic-geom';

// Utilities for dividing a path at one or two points ("snipping").
//
// The new arcs are appended to the end of the collection; the original arc is
// left in place (it may still be referenced by other shapes). Callers are
// responsible for updating the shapes that should use the new arcs.

// Divide an arc's vertices into slices at one or two cut locations.
// n: number of vertices in the arc
// cuts: one or two cut objects, ordered from the start of the arc:
//   {offset: i, point: [x, y]} cuts the segment between vertices i and i + 1
//   {offset: i, point: null} cuts at vertex i (which is duplicated, so that
//     both adjacent slices contain it)
// Returns slice descriptors {start, end, prefix, suffix}, where start and end
// are an inclusive vertex range (empty if start > end) and prefix/suffix are
// points inserted at a cut location.
export function getArcSlices(n, cuts) {
  var slices = [];
  var start = 0;
  var prefix = null;
  cuts.forEach(function(cut) {
    var i = cut.offset;
    if (cut.point) {
      if (i < 0 || i > n - 2) error('Out-of-range arc cut offset:', i);
      slices.push({start: start, end: i, prefix: prefix, suffix: cut.point});
      prefix = cut.point;
      start = i + 1;
    } else {
      if (i < 1 || i > n - 2) error('Out-of-range arc cut offset:', i);
      slices.push({start: start, end: i, prefix: prefix, suffix: null});
      prefix = null;
      start = i;
    }
  });
  slices.push({start: start, end: n - 1, prefix: prefix, suffix: null});
  return slices;
}

export function getArcSliceLength(slice) {
  var n = slice.end >= slice.start ? slice.end - slice.start + 1 : 0;
  if (slice.prefix) n++;
  if (slice.suffix) n++;
  return n;
}

// Append the slices of a divided arc to an ArcCollection.
// Returns the ids of the new arcs, ordered from the start of the original arc.
export function splitArcAtCuts(arcs, arcId, cuts) {
  var data = arcs.getVertexData();
  var zlimit = arcs.getRetainedInterval();
  var arcStart = data.ii[arcId];
  var arcCount = data.nn.length;
  var slices = getArcSlices(data.nn[arcId], cuts);
  var pointCount = data.xx.length;
  var added = slices.reduce(function(memo, slice) {
    return memo + getArcSliceLength(slice);
  }, 0);
  var xx2 = new Float64Array(pointCount + added);
  var yy2 = new Float64Array(pointCount + added);
  var zz2 = arcs.isFlat() ? null : new Float64Array(pointCount + added);
  var nn2 = new Uint32Array(arcCount + slices.length);
  var i = pointCount;
  var ids = [];

  xx2.set(data.xx);
  yy2.set(data.yy);
  nn2.set(data.nn);
  if (zz2) zz2.set(data.zz);

  slices.forEach(function(slice, sliceId) {
    var first = i;
    var j;
    if (slice.prefix) {
      xx2[i] = slice.prefix[0];
      yy2[i] = slice.prefix[1];
      i++;
    }
    for (j = slice.start; j <= slice.end; j++) {
      xx2[i] = data.xx[arcStart + j];
      yy2[i] = data.yy[arcStart + j];
      if (zz2) zz2[i] = data.zz[arcStart + j];
      i++;
    }
    if (slice.suffix) {
      xx2[i] = slice.suffix[0];
      yy2[i] = slice.suffix[1];
      i++;
    }
    if (zz2) {
      // arc endpoints must never be removed by simplification
      zz2[first] = Infinity;
      zz2[i - 1] = Infinity;
    }
    nn2[arcCount + sliceId] = i - first;
    ids.push(arcCount + sliceId);
  });

  arcs.updateVertexData(nn2, xx2, yy2, zz2);
  arcs.setRetainedInterval(zlimit);
  return ids;
}

// A cut identifies one location along a path (an array of arc ids):
//   seq:          index into the path of the arc containing the cut
//   offset:       vertex index within that arc, in traversal orientation
//   point:        coords of the cut, or null to cut at vertex <offset>
//   displayPoint: coords of the cut in the GUI's display CRS, or null
//   t:            position along the segment (0-1), used to order two cuts
//                 that land on the same segment

// Work out how to divide a path at one cut (open path) or two cuts (ring),
// without mutating anything.
//
// path: array of arc ids
// cutsArg: one cut (open path) or two cuts (ring), in any order
// arcLen: function(arcId) returning the number of vertices in an arc
// baseId: arcs.size(), used to predict the ids of arcs that will be appended
// closed: whether the path is a ring
//
// Returns {splits, a, b}, where splits are arc divisions to perform in order
// and a and b are the two resulting paths, or null if the cuts are degenerate
// (at the endpoint of an open path, or two cuts in the same place on a ring).
//
export function planPathDivision(path, cutsArg, arcLen, baseId, closed) {
  var cuts = sortCuts(cutsArg);
  var boundaryCuts = []; // cuts that fall between two arcs
  var interiorCuts = {}; // cuts that fall inside an arc, by path index
  var expanded = []; // path with divided arcs replaced by their pieces
  var positions = []; // position of each cut within the expanded path
  var splits = [];
  var nextArcId = baseId;
  var a, b, q, q1, q2;

  if (cuts.length != (closed ? 2 : 1)) return null;

  cuts.forEach(function(cut, cutId) {
    var n = arcLen(absArcId(path[cut.seq]));
    var seq;
    if (!cut.point && (cut.offset === 0 || cut.offset === n - 1)) {
      // a cut at an arc endpoint doesn't divide the arc, it divides the
      // sequence of arcs
      seq = cut.offset === 0 ? cut.seq : cut.seq + 1;
      if (closed && seq === path.length) seq = 0; // a ring's seam is one place
      boundaryCuts.push({cutId: cutId, seq: seq});
    } else {
      if (!interiorCuts[cut.seq]) interiorCuts[cut.seq] = [];
      interiorCuts[cut.seq].push({cutId: cutId, cut: cut, arcLen: n});
    }
  });

  for (var k=0; k<=path.length; k++) {
    boundaryCuts.forEach(function(item) {
      if (item.seq === k) positions[item.cutId] = expanded.length;
    });
    if (k === path.length) break;
    if (!interiorCuts[k]) {
      expanded.push(path[k]);
      continue;
    }
    addDividedArc(interiorCuts[k], path[k]);
  }

  if (!closed) {
    q = positions[0];
    if (q === 0 || q === expanded.length) return null; // cut at a path endpoint
    a = expanded.slice(0, q);
    b = expanded.slice(q);
  } else {
    q1 = Math.min(positions[0], positions[1]);
    q2 = Math.max(positions[0], positions[1]);
    if (q1 === q2) return null; // both cuts in the same place
    a = expanded.slice(q1, q2);
    b = expanded.slice(q2).concat(expanded.slice(0, q1));
  }
  return {splits: splits, a: a, b: b};

  function addDividedArc(group, arcId) {
    var fwd = arcId >= 0;
    var n = group[0].arcLen;
    // convert traversal offsets to forward-orientation offsets
    var fwdCuts = group.map(function(item) {
      return {
        offset: fwd ? item.cut.offset :
          n - (item.cut.point ? 2 : 1) - item.cut.offset,
        point: item.cut.point || null,
        displayPoint: item.cut.displayPoint || null
      };
    });
    // a reversed arc is traversed from its last vertex, so traversal order is
    // the reverse of forward order
    var pieces = getSplitArcIds(nextArcId, group.length, fwd);
    splits.push({
      arcId: absArcId(arcId),
      cuts: fwd ? fwdCuts : fwdCuts.concat().reverse()
    });
    nextArcId += group.length + 1;
    pieces.forEach(function(id, i) {
      if (i > 0) positions[group[i - 1].cutId] = expanded.length;
      expanded.push(id);
    });
  }
}

// Ids of the pieces of a divided arc, in traversal order
function getSplitArcIds(baseId, cutCount, fwd) {
  var ids = [];
  for (var i=0; i<=cutCount; i++) {
    ids.push(fwd ? baseId + i : ~(baseId + cutCount - i));
  }
  return ids;
}

function sortCuts(cuts) {
  return cuts.concat().sort(function(a, b) {
    return a.seq - b.seq || getCutOffset(a) - getCutOffset(b);
  });
}

// A sortable offset within one arc. A cut on the segment following a vertex
// comes after the vertex itself; two cuts on the same segment are ordered by
// their position along it.
function getCutOffset(cut) {
  if (!cut.point) return cut.offset;
  return cut.offset + 0.5 + (cut.t > 0 ? Math.min(cut.t, 1) : 0) * 0.4;
}

export function getPlanarPathLength(ids, arcs) {
  var iter = arcs.getShapeIter(ids);
  var len = 0;
  var x, y;
  if (iter.hasNext()) {
    x = iter.x;
    y = iter.y;
  }
  while (iter.hasNext()) {
    len += distance2D(x, y, iter.x, iter.y);
    x = iter.x;
    y = iter.y;
  }
  return len;
}
