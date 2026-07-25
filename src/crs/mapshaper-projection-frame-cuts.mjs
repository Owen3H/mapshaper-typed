/*
 * Post-projection repair for projections whose layout wraps at a rectangular
 * frame (currently the Lee tetrahedral pair, the only ones that publish
 * frame_bounds).
 *
 * Why this is needed: such a projection is cut along a curved seam traced in
 * geographic space, and the seam mask splits any path that crosses it. But
 * without -densify, a path segment is a straight chord in lon/lat, and a chord
 * between two vertices either side of the seam can pass on the wrong side of
 * the curve entirely. The projected path then leaves one edge of the frame and
 * re-enters at the opposite edge, so the ring closes with a long run along a
 * frame side, joining two halves that belong on opposite sides of the map.
 * Densified input curves with the seam and is cut normally, which is why the
 * artifact only appears without that option.
 *
 * The repair looks for a ring that meets the same frame side in two or more
 * separate runs and splits it there. A ring that legitimately touches a frame
 * side does so once.
 *
 * Note that the jump threshold in getFrameSide is coupled to the resolution of
 * the seam trace: it recognizes a spurious connection as a single long segment
 * lying on a frame side. Coarsening the trace breaks the connection into a
 * chain of shorter segments that fall below the threshold and are missed, so
 * the two need to be changed together.
 */

import { DatasetEditor } from '../dataset/mapshaper-dataset-editor';

export function splitPolygonFrameChords(dataset, bounds) {
  var editor = new DatasetEditor(dataset);
  dataset.layers.forEach(function(lyr) {
    if (lyr.geometry_type == 'polygon') {
      editor.editLayer(lyr, function(path) {
        return splitRingAtFrameChords(path, bounds);
      });
    } else {
      editor.editLayer(lyr, function(geometry) {
        return lyr.geometry_type == 'point' ? geometry : [geometry];
      });
    }
  });
  editor.done();
}

function splitRingAtFrameChords(path, bounds, depth) {
  depth = depth || 0;
  var closed = pointsEqual(path[0], path[path.length - 1]);
  var n = path.length - (closed ? 1 : 0);
  if (n < 4) return [path];
  var width = bounds[2] - bounds[0];
  var height = bounds[3] - bounds[1];
  var tolerance = Math.max(width, height) * 1e-3;
  var edgesBySide = [[], [], [], []];
  for (var i = 0; i < n; i++) {
    var side = getFrameSide(
      path[i], path[(i + 1) % n], bounds, tolerance);
    if (side >= 0) edgesBySide[side].push({index: i, side: side});
  }
  for (var frameSide = 0; frameSide < edgesBySide.length; frameSide++) {
    var runs = groupEdgeRuns(edgesBySide[frameSide], n);
    if (runs.length > 1) {
      var parts = splitRingAtRuns(path, n, runs, frameSide, bounds);
      if (depth >= 3) return parts;
      return parts.reduce(function(memo, part) {
        return memo.concat(splitRingAtFrameChords(part, bounds, depth + 1));
      }, []);
    }
  }
  return [path];
}

function splitRingAtRuns(path, n, runs, side, bounds) {
  return runs.map(function(run, i) {
    var next = runs[(i + 1) % runs.length];
    var start = (run.end + 1) % n;
    var end = next.start;
    var part = [];
    var j = start;
    while (true) {
      part.push(path[j].concat());
      if (j == end) break;
      j = (j + 1) % n;
    }
    if (side == 0 || side == 2) {
      var y = side == 0 ? bounds[1] : bounds[3];
      part[0][1] = y;
      part[part.length - 1][1] = y;
    } else {
      var x = side == 1 ? bounds[2] : bounds[0];
      part[0][0] = x;
      part[part.length - 1][0] = x;
    }
    part.push(part[0].concat());
    return part;
  }).filter(function(part) {
    return part.length > 3;
  });
}

function getFrameSide(a, b, bounds, tolerance) {
  var dx = Math.abs(a[0] - b[0]);
  var dy = Math.abs(a[1] - b[1]);
  var width = bounds[2] - bounds[0];
  var height = bounds[3] - bounds[1];
  if (dx > width * 0.2) {
    if (Math.abs(a[1] - bounds[1]) < tolerance &&
        Math.abs(b[1] - bounds[1]) < tolerance) return 0;
    if (Math.abs(a[1] - bounds[3]) < tolerance &&
        Math.abs(b[1] - bounds[3]) < tolerance) return 2;
  }
  if (dy > height * 0.2) {
    if (Math.abs(a[0] - bounds[2]) < tolerance &&
        Math.abs(b[0] - bounds[2]) < tolerance) return 1;
    if (Math.abs(a[0] - bounds[0]) < tolerance &&
        Math.abs(b[0] - bounds[0]) < tolerance) return 3;
  }
  return -1;
}

function groupEdgeRuns(edges, n) {
  var runs = [];
  edges.forEach(function(edge) {
    var run = runs[runs.length - 1];
    if (run && edge.side == run.side && edge.index == run.end + 1) {
      run.end = edge.index;
    } else {
      runs.push({start: edge.index, end: edge.index, side: edge.side});
    }
  });
  if (runs.length > 1 && runs[0].start == 0 &&
      runs[runs.length - 1].end == n - 1 &&
      runs[0].side == runs[runs.length - 1].side) {
    runs[0].start = runs[runs.length - 1].start;
    runs.pop();
  }
  return runs;
}

function pointsEqual(a, b) {
  return a && b && a[0] == b[0] && a[1] == b[1];
}
