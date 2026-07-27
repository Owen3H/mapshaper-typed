// Trace contour lines (isolines) from a raster layer's working samples using
// marching squares.
//
// Samples are treated as point measurements at pixel centers, so a W x H grid
// contours over a lattice of W x H values and (W-1) x (H-1) cells. Contour
// vertices therefore span from the first pixel center to the last, half a
// pixel inside the grid bbox. This matches gdal_contour.

import { getRasterGrid, rasterGridIsRotated } from './mapshaper-raster-utils';
import { getRasterValidityMask } from './mapshaper-raster-grid';
import { D2R, degreesToMeters } from '../geom/mapshaper-basic-geom';
import { stop } from '../utils/mapshaper-logging';

var MAX_CONTOUR_LEVELS = 2000;
var TARGET_LEVEL_COUNT = 15;

// Marching squares traces a staircase with treads one pixel wide, so smoothing
// at one pixel is what removes the stepping. Measured against an analytic cone
// quantized to whole meters (as elevation models usually are), one pixel gives
// the lowest deviation from the true contour: 0.16 px, against 0.29 px
// unsmoothed and 0.18 px at 1.5 px. On unquantized float data, where there is
// no staircase to remove, the cost is under 0.1 px.
var SMOOTHING_PIXELS = 1;

// A degree of longitude vanishes at the poles; keep the implied pixel width
// from collapsing to zero there.
var MIN_LATITUDE_SCALE = 0.05;

// Cell corners, and the edges between them:
//
//        edge 0
//   c0 --------- c1
//   |             |
//   | edge 3      | edge 1
//   |             |
//   c3 --------- c2
//        edge 2
//
// Corner bits: 1 = c0, 2 = c1, 4 = c2, 8 = c3. A corner is set when its value
// is >= the contour level.
//
// Each entry is the pair of edges a contour segment crosses, directed so that
// the above-level side is always on the same hand. Consistent orientation is
// what lets segments be stitched together by edge id alone: a crossing is the
// exit of one cell and the entry of its neighbor.
var CONTOUR_CASES = [
  null,     // 0: none above
  [3, 0],   // 1: c0
  [0, 1],   // 2: c1
  [3, 1],   // 3: c0 c1
  [1, 2],   // 4: c2
  null,     // 5: c0 c2 -- saddle
  [0, 2],   // 6: c1 c2
  [3, 2],   // 7: c0 c1 c2
  [2, 3],   // 8: c3
  [2, 0],   // 9: c0 c3
  null,     // 10: c1 c3 -- saddle
  [2, 1],   // 11: c0 c1 c3
  [1, 3],   // 12: c2 c3
  [1, 0],   // 13: c0 c2 c3
  [0, 3],   // 14: c1 c2 c3
  null      // 15: all above
];

// A saddle cell has crossings on all four edges, which can be paired two ways.
// The cell-center average breaks the tie: when the center is above the level,
// the two above-level corners are joined through the middle of the cell and
// the below-level corners are cut off separately.
var SADDLE_C0_C2_JOINED = [[1, 0], [3, 2]];
var SADDLE_C0_C2_SPLIT = [[3, 0], [1, 2]];
var SADDLE_C1_C3_JOINED = [[0, 3], [2, 1]];
var SADDLE_C1_C3_SPLIT = [[0, 1], [2, 3]];

export function getRasterContourLines(raster, opts) {
  var grid = getRasterGrid(raster);
  var band, levels;
  validateRasterGridForContours(grid);
  band = getContourBand(grid, opts);
  levels = getContourLevels(grid, band, opts);
  return {
    levels: levels,
    lines: traceRasterContours(grid, band, levels)
  };
}

// Auto-selected smoothing interval for traced contours, returned the way
// -smooth reads a plain distance= number: as meters when the CRS is known, and
// as raw coordinate units when it is not.
export function getContourSmoothingDistance(grid, crs) {
  var bbox = grid.bbox;
  var dx = Math.abs(bbox[2] - bbox[0]) / grid.width;
  var dy = Math.abs(bbox[3] - bbox[1]) / grid.height;
  var lat;
  if (crs && crs.is_latlong) {
    lat = (bbox[1] + bbox[3]) / 2;
    dx = degreesToMeters(dx) * Math.max(Math.cos(lat * D2R), MIN_LATITUDE_SCALE);
    dy = degreesToMeters(dy);
  } else if (crs && crs.to_meter > 0) {
    dx *= crs.to_meter;
    dy *= crs.to_meter;
  }
  // Geometric mean, so a grid with non-square pixels gets an interval between
  // its two resolutions rather than one axis winning.
  return Math.sqrt(dx * dy) * SMOOTHING_PIXELS;
}

export function validateRasterGridForContours(grid) {
  if (!grid || !grid.samples || !grid.bbox) {
    stop('Raster layer is missing required grid data');
  }
  if (rasterGridIsRotated(grid)) {
    stop('Tracing contours from a rotated or skewed raster is not supported');
  }
  if (grid.width < 2 || grid.height < 2) {
    stop('Raster layer is too small to contour (needs to be at least 2x2 pixels)');
  }
}

export function getContourBand(grid, opts) {
  var band = opts && 'band' in opts ? opts.band : 0;
  if (!(band >= 0) || band !== Math.floor(band) || band >= grid.bands) {
    stop('Invalid band=' + band + '; this raster has ' + grid.bands +
      (grid.bands == 1 ? ' band' : ' bands'));
  }
  return band;
}

export function getContourLevels(grid, band, opts) {
  var levels = opts && opts.levels ?
    getExplicitLevels(opts.levels) :
    getIntervalLevels(getRasterSampleRange(grid, band), opts || {});
  if (levels.length > MAX_CONTOUR_LEVELS) {
    stop('Contouring would generate ' + levels.length + ' levels; the limit is ' +
      MAX_CONTOUR_LEVELS + '. Use a larger interval= or an explicit levels= list.');
  }
  return levels;
}

function getExplicitLevels(arg) {
  var levels = [];
  arg.forEach(function(val) {
    if (typeof val != 'number' || !isFinite(val)) {
      stop('Invalid contour level:', val);
    }
    if (levels.indexOf(val) == -1) levels.push(val);
  });
  return levels.sort(ascending);
}

function getIntervalLevels(range, opts) {
  var base = 'base' in opts ? opts.base : 0;
  var levels = [];
  var interval, k, level;
  // Only fall back to an automatic interval when none was given: a bad
  // interval= should be reported, not quietly replaced.
  if (opts.interval === null || opts.interval === undefined) {
    interval = getAutoContourInterval(range);
  } else {
    interval = opts.interval;
    if (!(interval > 0) || !isFinite(interval)) {
      stop('Contour interval= must be a positive number');
    }
  }
  if (!isFinite(base)) {
    stop('Contour base= must be a number');
  }
  // A level at exactly the data minimum has no cell to cross, because every
  // corner counts as above it.
  if (!(range.max > range.min)) return levels;
  k = Math.ceil((range.min - base) / interval);
  while (levels.length <= MAX_CONTOUR_LEVELS) {
    level = cleanLevelValue(base + k * interval);
    if (level > range.max) break;
    if (level > range.min) levels.push(level);
    k++;
  }
  return levels;
}

// Choose a round interval that divides the data range into roughly
// TARGET_LEVEL_COUNT steps.
function getAutoContourInterval(range) {
  var span = range.max - range.min;
  var raw, magnitude, normalized;
  if (!(span > 0) || !isFinite(span)) return 1;
  raw = span / TARGET_LEVEL_COUNT;
  magnitude = Math.pow(10, Math.floor(Math.log(raw) / Math.LN10));
  normalized = raw / magnitude;
  return (normalized >= 5 ? 5 : normalized >= 2 ? 2 : 1) * magnitude;
}

// Repeated addition of a fractional interval accumulates error that shows up
// in output field values, e.g. 0.30000000000000004.
function cleanLevelValue(value) {
  return value === 0 ? 0 : Number(value.toPrecision(12));
}

export function getRasterSampleRange(grid, band) {
  var samples = grid.samples;
  var bands = grid.bands;
  var valid = getRasterValidityMask(grid);
  var n = grid.width * grid.height;
  var min = Infinity;
  var max = -Infinity;
  var v, i;
  for (i = 0; i < n; i++) {
    if (valid && !valid[i]) continue;
    v = samples[i * bands + band];
    if (v !== v) continue; // NaN, used as a nodata value by some float rasters
    if (v < min) min = v;
    if (v > max) max = v;
  }
  return {min: min, max: max};
}

export function traceRasterContours(grid, band, levels) {
  var segments = collectContourSegments(grid, band, levels);
  var toMapXY = getLatticeToMapTransform(grid);
  var hCount = (grid.width - 1) * grid.height;
  var lines = [];
  segments.forEach(function(levelSegments, i) {
    stitchContourSegments(levelSegments).forEach(function(path) {
      var coords = getPathCoords(path, grid, band, levels[i], hCount, toMapXY);
      if (coords.length > 1) {
        lines.push({value: levels[i], coords: coords});
      }
    });
  });
  return lines;
}

// Visit each cell once and march it for every level that falls inside its
// value range, rather than scanning the whole grid once per level.
function collectContourSegments(grid, band, levels) {
  var W = grid.width;
  var H = grid.height;
  var bands = grid.bands;
  var samples = grid.samples;
  var hCount = (W - 1) * H;
  var valid = getRasterValidityMask(grid);
  var rowStride = W * bands;
  var out = levels.map(function() { return {from: [], to: []}; });
  var cx, cy, pixelId, off, v0, v1, v2, v3, min, max, i;
  if (levels.length === 0) return out;
  for (cy = 0; cy < H - 1; cy++) {
    for (cx = 0; cx < W - 1; cx++) {
      pixelId = cy * W + cx;
      if (valid && (!valid[pixelId] || !valid[pixelId + 1] ||
          !valid[pixelId + W] || !valid[pixelId + W + 1])) continue;
      off = pixelId * bands + band;
      v0 = samples[off];
      v1 = samples[off + bands];
      v3 = samples[off + rowStride];
      v2 = samples[off + rowStride + bands];
      if (v0 !== v0 || v1 !== v1 || v2 !== v2 || v3 !== v3) continue; // NaN
      min = v0 < v1 ? v0 : v1;
      if (v2 < min) min = v2;
      if (v3 < min) min = v3;
      max = v0 > v1 ? v0 : v1;
      if (v2 > max) max = v2;
      if (v3 > max) max = v3;
      // A level crosses the cell when min < level <= max, which matches the
      // >= test that classifies each corner.
      for (i = firstLevelAbove(levels, min); i < levels.length && levels[i] <= max; i++) {
        addCellSegments(out[i], levels[i], v0, v1, v2, v3, cx, cy, W, hCount);
      }
    }
  }
  return out;
}

function firstLevelAbove(levels, value) {
  var lo = 0;
  var hi = levels.length;
  var mid;
  while (lo < hi) {
    mid = (lo + hi) >> 1;
    if (levels[mid] > value) hi = mid;
    else lo = mid + 1;
  }
  return lo;
}

function addCellSegments(dest, level, v0, v1, v2, v3, cx, cy, W, hCount) {
  var caseId = (v0 >= level ? 1 : 0) | (v1 >= level ? 2 : 0) |
    (v2 >= level ? 4 : 0) | (v3 >= level ? 8 : 0);
  var pairs, pair;
  if (caseId === 5 || caseId === 10) {
    pairs = getSaddlePairs(caseId, level, v0, v1, v2, v3);
    addSegment(dest, pairs[0], cx, cy, W, hCount);
    addSegment(dest, pairs[1], cx, cy, W, hCount);
    return;
  }
  pair = CONTOUR_CASES[caseId];
  if (pair) addSegment(dest, pair, cx, cy, W, hCount);
}

function getSaddlePairs(caseId, level, v0, v1, v2, v3) {
  var centerAbove = (v0 + v1 + v2 + v3) / 4 >= level;
  if (caseId === 5) {
    return centerAbove ? SADDLE_C0_C2_JOINED : SADDLE_C0_C2_SPLIT;
  }
  return centerAbove ? SADDLE_C1_C3_JOINED : SADDLE_C1_C3_SPLIT;
}

function addSegment(dest, pair, cx, cy, W, hCount) {
  dest.from.push(getCellEdgeId(pair[0], cx, cy, W, hCount));
  dest.to.push(getCellEdgeId(pair[1], cx, cy, W, hCount));
}

// Edges are numbered so that neighboring cells agree on the id of the edge
// they share: horizontal edges run left to right along a lattice row,
// vertical edges run top to bottom down a lattice column.
function getCellEdgeId(edge, cx, cy, W, hCount) {
  if (edge === 0) return cy * (W - 1) + cx;           // top
  if (edge === 1) return hCount + cy * W + cx + 1;    // right
  if (edge === 2) return (cy + 1) * (W - 1) + cx;     // bottom
  return hCount + cy * W + cx;                        // left
}

// Join directed segments end to end. Because every segment is oriented the
// same way relative to the contour, each edge is the start of at most one
// segment and the end of at most one, so following the chain is unambiguous.
function stitchContourSegments(segments) {
  var from = segments.from;
  var to = segments.to;
  var next = new Map();
  var hasIncoming = new Set();
  var visited = new Set();
  var paths = [];
  var i, ring;
  for (i = 0; i < from.length; i++) {
    next.set(from[i], to[i]);
    hasIncoming.add(to[i]);
  }
  // Trace open contours first, starting from the edges nothing leads into, so
  // that a contour running between two grid boundaries is not entered part
  // way along and split in two.
  for (i = 0; i < from.length; i++) {
    if (hasIncoming.has(from[i]) || visited.has(from[i])) continue;
    paths.push(followContour(from[i], next, visited));
  }
  // Anything left over forms a closed ring.
  for (i = 0; i < from.length; i++) {
    if (visited.has(from[i])) continue;
    ring = followContour(from[i], next, visited);
    ring.push(ring[0]);
    paths.push(ring);
  }
  return paths;
}

function followContour(startEdge, next, visited) {
  var path = [];
  var edge = startEdge;
  while (edge !== undefined && !visited.has(edge)) {
    visited.add(edge);
    path.push(edge);
    edge = next.get(edge);
  }
  return path;
}

function getPathCoords(path, grid, band, level, hCount, toMapXY) {
  var coords = [];
  var prev = null;
  var point, xy;
  for (var i = 0; i < path.length; i++) {
    point = getEdgeCrossing(grid, band, level, path[i], hCount);
    xy = toMapXY(point[0], point[1]);
    // A corner value exactly equal to the level puts two crossings in the
    // same place; keeping both would emit zero-length segments.
    if (prev && xy[0] === prev[0] && xy[1] === prev[1]) continue;
    coords.push(xy);
    prev = xy;
  }
  return coords;
}

// Returns the crossing point in lattice coordinates. The result depends only
// on the edge and the level, so both cells sharing an edge compute the same
// point, down to the last bit.
function getEdgeCrossing(grid, band, level, edgeId, hCount) {
  var W = grid.width;
  var bands = grid.bands;
  var samples = grid.samples;
  var x, y, v0, v1;
  if (edgeId < hCount) {
    y = Math.floor(edgeId / (W - 1));
    x = edgeId - y * (W - 1);
    v0 = samples[(y * W + x) * bands + band];
    v1 = samples[(y * W + x + 1) * bands + band];
    return [x + interpolateCrossing(level, v0, v1), y];
  }
  edgeId -= hCount;
  y = Math.floor(edgeId / W);
  x = edgeId - y * W;
  v0 = samples[(y * W + x) * bands + band];
  v1 = samples[((y + 1) * W + x) * bands + band];
  return [x, y + interpolateCrossing(level, v0, v1)];
}

function interpolateCrossing(level, v0, v1) {
  var t;
  if (v1 === v0) return 0.5;
  t = (level - v0) / (v1 - v0);
  return t < 0 ? 0 : t > 1 ? 1 : t;
}

// Lattice coordinates are indexed from the center of the first pixel, not the
// corner of the grid.
function getLatticeToMapTransform(grid) {
  var bbox = grid.bbox;
  var dx = (bbox[2] - bbox[0]) / grid.width;
  var dy = (bbox[3] - bbox[1]) / grid.height;
  var x0 = bbox[0] + dx / 2;
  var y0 = bbox[3] - dy / 2;
  return function(col, row) {
    return [x0 + col * dx, y0 - row * dy];
  };
}

function ascending(a, b) {
  return a - b;
}
