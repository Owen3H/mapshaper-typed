import Flatbush from 'flatbush';
import { getDatasetCRS, isLatLngCRS } from '../crs/mapshaper-projections';
import { fastLonLatDistance, distance2D, R2D, R } from '../geom/mapshaper-basic-geom';
import { convertDistanceParam } from '../geom/mapshaper-units';
import { traversePaths } from '../paths/mapshaper-path-utils';
import { buildTopology } from '../topology/mapshaper-topology';
import { message } from '../utils/mapshaper-logging';
import utils from '../utils/mapshaper-utils';

// Automatic closing is intentionally conservative. A valid seam must also stay
// within tolerance for a sustained edge length (see growSeamFromSeed), so this
// distance is only a candidate-search radius, not a global snapping tolerance.
var AUTO_SEGMENT_FRACTION = 1e-4;
// Minimum accepted seam length as a multiple of the median external segment.
// Replaces the old MIN_RUN_PAIRS vertex-alignment filter so staggered vertices
// along a real crack still qualify.
var MIN_SEAM_SEGMENT_FACTOR = 3;

// Close narrow exterior cracks between two or more polygon features by snapping
// vertices on facing external arcs toward a shared centerline. A seam needs a
// mouth formed by a within-tolerance vertex pair; along the crack, edges must
// stay within tolerance for a minimum length, but vertices may be staggered.
//
// Returns the number of distinct seams that were snapped.
export function closePolygonMosaicGaps(layers, dataset, opts) {
  var polygonLayers = layers.filter(function(lyr) {
    return lyr.geometry_type == 'polygon' && lyr.shapes && lyr.shapes.length > 1;
  });
  if (polygonLayers.length === 0 || !dataset.arcs) return 0;

  var crs = getDatasetCRS(dataset);
  var spherical = isLatLngCRS(crs);
  var changed = 0;
  polygonLayers.forEach(function(lyr) {
    changed += closeLayerGaps(lyr, dataset.arcs, crs, spherical, opts);
  });
  if (changed > 0) {
    dataset.arcs.dedupCoords();
    buildTopology(dataset);
    message(utils.format('Closed %s exterior gap%s',
      changed, utils.pluralSuffix(changed)));
  }
  return changed;
}

function closeLayerGaps(lyr, arcs, crs, spherical, opts) {
  var owners = getArcOwners(lyr.shapes, arcs.size());
  var records = collectExternalVertices(arcs, owners);
  if (records.length < 4) return 0;

  var medianSeg = getMedianExternalSegmentLength(records, arcs, spherical);
  var autoDistance = medianSeg * AUTO_SEGMENT_FRACTION;
  var distance = opts.close_distance ?
    convertDistanceParam(opts.close_distance, crs) :
    autoDistance;
  if (!(distance > 0)) return 0;

  // Keep the automatic search radius when the user supplies a smaller closing
  // distance. This lets us see the complete seam and reject it as a unit instead
  // of partially snapping the already-near portion while leaving its wider mouth
  // open.
  var searchDistance = Math.max(distance, autoDistance);
  var seeds = findMouthSeeds(records, searchDistance, spherical);
  if (seeds.length === 0) return 0;

  var arcsById = indexArcRecords(records);
  var minSeamLength = medianSeg * MIN_SEAM_SEGMENT_FACTOR;
  var seams = growSeamsFromSeeds(seeds, arcsById, arcs, distance, spherical,
    minSeamLength);
  if (seams.length === 0) return 0;
  return snapSeams(seams, seeds, arcsById, arcs, distance, spherical);
}

// An external arc belongs to exactly one feature. Shared arcs are excluded: they
// already represent clean topology and must not be moved by this repair.
function getArcOwners(shapes, arcCount) {
  var first = new Int32Array(arcCount);
  var second = new Int32Array(arcCount);
  for (var i = 0; i < arcCount; i++) {
    first[i] = -1;
    second[i] = -1;
  }
  traversePaths(shapes, function(o) {
    var id = o.arcId < 0 ? ~o.arcId : o.arcId;
    var owner = o.shapeId;
    if (first[id] == -1) first[id] = owner;
    else if (first[id] != owner) second[id] = owner;
  });
  return {first: first, second: second};
}

function collectExternalVertices(arcs, owners) {
  var data = arcs.getVertexData();
  var records = [];
  var offs = 0;
  for (var arcId = 0; arcId < data.nn.length; arcId++) {
    var n = data.nn[arcId];
    if (owners.first[arcId] >= 0 && owners.second[arcId] == -1) {
      for (var k = 0; k < n; k++) {
        var i = offs + k;
        records.push({
          x: data.xx[i],
          y: data.yy[i],
          i: i,
          arc: arcId,
          k: k,
          owner: owners.first[arcId]
        });
      }
    }
    offs += n;
  }
  return records;
}

function indexArcRecords(records) {
  var byArc = {};
  records.forEach(function(o) {
    if (!byArc[o.arc]) byArc[o.arc] = [];
    byArc[o.arc].push(o);
  });
  Object.keys(byArc).forEach(function(id) {
    byArc[id].sort(function(a, b) { return a.k - b.k; });
  });
  return byArc;
}

function getMedianExternalSegmentLength(records, arcs, spherical) {
  var lengths = [];
  var data = arcs.getVertexData();
  var external = new Uint8Array(arcs.size());
  records.forEach(function(o) { external[o.arc] = 1; });
  var offs = 0;
  for (var arcId = 0; arcId < data.nn.length; arcId++) {
    var n = data.nn[arcId];
    if (external[arcId]) {
      for (var k = 1; k < n; k++) {
        var a = offs + k - 1, b = offs + k;
        var len = spherical ?
          fastLonLatDistance(data.xx[a], data.yy[a], data.xx[b], data.yy[b]) :
          distance2D(data.xx[a], data.yy[a], data.xx[b], data.yy[b]);
        if (len > 0 && isFinite(len)) lengths.push(len);
      }
    }
    offs += n;
  }
  if (lengths.length === 0) return 0;
  lengths.sort(function(a, b) { return a - b; });
  return lengths[Math.floor(lengths.length / 2)];
}

// Mouth seeds: mutual nearest external vertices on different owners/arcs.
// A single positive-distance pair is enough to start an edge walk.
function findMouthSeeds(records, distance, spherical) {
  var index = new Flatbush(records.length);
  records.forEach(function(o) { index.add(o.x, o.y, o.x, o.y); });
  index.finish();

  var nearest = new Int32Array(records.length);
  var distances = new Float64Array(records.length);
  nearest.fill(-1);
  records.forEach(function(a, ai) {
    var padY = getCoordinatePad(distance, a.y, spherical, false);
    var padX = getCoordinatePad(distance, a.y, spherical, true);
    var ids = index.search(a.x - padX, a.y - padY, a.x + padX, a.y + padY);
    var best = -1, bestDist = Infinity;
    ids.forEach(function(bi) {
      var b = records[bi];
      if (bi == ai || b.owner == a.owner || b.arc == a.arc) return;
      var d = spherical ?
        fastLonLatDistance(a.x, a.y, b.x, b.y) :
        distance2D(a.x, a.y, b.x, b.y);
      if (d <= distance && d < bestDist) {
        best = bi;
        bestDist = d;
      }
    });
    nearest[ai] = best;
    distances[ai] = bestDist;
  });

  var seen = {};
  var seeds = [];
  records.forEach(function(a, ai) {
    var bi = nearest[ai];
    if (bi < 0 || !(distances[ai] > 0)) return;
    var best = records[bi];
    // Positive-distance matches must be mutual nearest neighbors.
    if (nearest[bi] != ai) return;
    var lo = Math.min(a.i, best.i), hi = Math.max(a.i, best.i);
    var key = lo + ':' + hi;
    if (seen[key]) return;
    seen[key] = true;
    seeds.push({a: a, b: best, distance: distances[ai]});
  });
  return seeds;
}

function getCoordinatePad(distance, lat, spherical, longitude) {
  if (spherical) {
    var deg = distance / R * R2D;
    return longitude ? deg / Math.max(Math.cos(lat / R2D), 0.01) : deg;
  }
  // convertDistanceParam() has already converted physical units into projected
  // coordinate units (or left unitless values unchanged).
  return distance;
}

// Grow a seam from each mouth seed by walking both arcs while each vertex stays
// within closeDistance of the opposite arc's edges. Accept only seams whose
// walked length on both sides meets minSeamLength. Overlapping seeds that grow
// into the same arc-pair range are merged.
export function growSeamsFromSeeds(seeds, arcsById, arcs, closeDistance,
    spherical, minSeamLength) {
  var seams = [];
  seeds.forEach(function(seed) {
    var seam = growSeamFromSeed(seed, arcsById, arcs, closeDistance, spherical);
    if (!seam) return;
    if (seam.lengthA < minSeamLength || seam.lengthB < minSeamLength) return;
    seams.push(seam);
  });
  return mergeOverlappingSeams(seams);
}

function growSeamFromSeed(seed, arcsById, arcs, closeDistance, spherical) {
  var sideA = arcsById[seed.a.arc];
  var sideB = arcsById[seed.b.arc];
  if (!sideA || !sideB) return null;

  var rangeA = expandRangeOnArc(sideA, seed.a.k, sideB, arcs, closeDistance,
    spherical);
  var rangeB = expandRangeOnArc(sideB, seed.b.k, sideA, arcs, closeDistance,
    spherical);
  if (!rangeA || !rangeB) return null;

  return {
    arcA: seed.a.arc,
    arcB: seed.b.arc,
    loA: rangeA.lo,
    hiA: rangeA.hi,
    loB: rangeB.lo,
    hiB: rangeB.hi,
    lengthA: rangeA.length,
    lengthB: rangeB.length
  };
}

// Expand along @side from seed index @seedK while each vertex remains within
// closeDistance of @other's edges. Returns the inclusive index range and the
// path length covered by the accepted stretch.
function expandRangeOnArc(side, seedK, other, arcs, closeDistance, spherical) {
  if (seedK < 0 || seedK >= side.length) return null;
  if (!vertexWithinTolerance(side[seedK], other, arcs, closeDistance, spherical)) {
    return null;
  }
  var lo = seedK;
  var hi = seedK;
  while (lo > 0 &&
      vertexWithinTolerance(side[lo - 1], other, arcs, closeDistance, spherical)) {
    lo--;
  }
  while (hi + 1 < side.length &&
      vertexWithinTolerance(side[hi + 1], other, arcs, closeDistance, spherical)) {
    hi++;
  }
  return {
    lo: lo,
    hi: hi,
    length: pathLengthBetween(side, lo, hi, spherical)
  };
}

function vertexWithinTolerance(vertex, otherSide, arcs, closeDistance, spherical) {
  var foot = closestPointOnArc(vertex.x, vertex.y, otherSide, arcs);
  if (!foot) return false;
  var d = spherical ?
    fastLonLatDistance(vertex.x, vertex.y, foot[0], foot[1]) :
    distance2D(vertex.x, vertex.y, foot[0], foot[1]);
  return isFinite(d) && d <= closeDistance;
}

function pathLengthBetween(side, lo, hi, spherical) {
  var len = 0;
  for (var k = lo; k < hi; k++) {
    var a = side[k], b = side[k + 1];
    len += spherical ?
      fastLonLatDistance(a.x, a.y, b.x, b.y) :
      distance2D(a.x, a.y, b.x, b.y);
  }
  return len;
}

function mergeOverlappingSeams(seams) {
  if (seams.length <= 1) return seams;
  var out = [];
  seams.forEach(function(seam) {
    var a = Math.min(seam.arcA, seam.arcB);
    var b = Math.max(seam.arcA, seam.arcB);
    var swapped = seam.arcA > seam.arcB;
    var norm = {
      arcA: a,
      arcB: b,
      loA: swapped ? seam.loB : seam.loA,
      hiA: swapped ? seam.hiB : seam.hiA,
      loB: swapped ? seam.loA : seam.loB,
      hiB: swapped ? seam.hiA : seam.hiB,
      lengthA: swapped ? seam.lengthB : seam.lengthA,
      lengthB: swapped ? seam.lengthA : seam.lengthB
    };
    var existing = out.find(function(o) {
      return o.arcA === norm.arcA && o.arcB === norm.arcB &&
        rangesOverlap(o.loA, o.hiA, norm.loA, norm.hiA) &&
        rangesOverlap(o.loB, o.hiB, norm.loB, norm.hiB);
    });
    if (existing) {
      existing.loA = Math.min(existing.loA, norm.loA);
      existing.hiA = Math.max(existing.hiA, norm.hiA);
      existing.loB = Math.min(existing.loB, norm.loB);
      existing.hiB = Math.max(existing.hiB, norm.hiB);
      existing.lengthA = Math.max(existing.lengthA, norm.lengthA);
      existing.lengthB = Math.max(existing.lengthB, norm.lengthB);
    } else {
      out.push(norm);
    }
  });
  return out;
}

function rangesOverlap(lo1, hi1, lo2, hi2) {
  return lo1 <= hi2 && lo2 <= hi1;
}

// Snap every vertex in an accepted seam range to the midpoint between itself
// and its nearest footpoint on the opposite arc. Works with staggered vertices:
// the opposite side need not have a coinciding vertex. Mouth seed pairs are
// forced to their shared vertex midpoint so the crack tip closes exactly.
function snapSeams(seams, seeds, arcsById, arcs, closeDistance, spherical) {
  var data = arcs.getVertexData();
  var targets = {};
  var changed = 0;

  seams.forEach(function(seam) {
    var sideA = arcsById[seam.arcA];
    var sideB = arcsById[seam.arcB];
    if (!sideA || !sideB) return;
    var before = Object.keys(targets).length;
    snapSideToOpposite(sideA, seam.loA, seam.hiA, sideB, arcs, closeDistance,
      spherical, targets);
    snapSideToOpposite(sideB, seam.loB, seam.hiB, sideA, arcs, closeDistance,
      spherical, targets);
    if (Object.keys(targets).length > before) changed++;
  });

  // Mouth pairs win over footpoint midpoints so both tips land on one point.
  seeds.forEach(function(seed) {
    if (!(seed.distance > 0)) return;
    if (!seamContainsSeed(seams, seed)) return;
    var mid = [(seed.a.x + seed.b.x) / 2, (seed.a.y + seed.b.y) / 2];
    targets[seed.a.x + '~' + seed.a.y] = mid;
    targets[seed.b.x + '~' + seed.b.y] = mid;
  });

  var keys = Object.keys(targets);
  if (keys.length === 0) return 0;

  // Move every occurrence of a selected coordinate, including coincident arc
  // endpoints, so existing nodes remain connected. Coordinates outside the
  // detected seams are untouched.
  for (var i = 0; i < data.xx.length; i++) {
    var target = targets[data.xx[i] + '~' + data.yy[i]];
    if (target) {
      data.xx[i] = target[0];
      data.yy[i] = target[1];
    }
  }
  arcs.updateVertexData(data.nn, data.xx, data.yy, data.zz);
  return changed;
}

function seamContainsSeed(seams, seed) {
  return seams.some(function(seam) {
    var aOnA = seed.a.arc === seam.arcA &&
      seed.a.k >= seam.loA && seed.a.k <= seam.hiA;
    var aOnB = seed.a.arc === seam.arcB &&
      seed.a.k >= seam.loB && seed.a.k <= seam.hiB;
    var bOnA = seed.b.arc === seam.arcA &&
      seed.b.k >= seam.loA && seed.b.k <= seam.hiA;
    var bOnB = seed.b.arc === seam.arcB &&
      seed.b.k >= seam.loB && seed.b.k <= seam.hiB;
    return (aOnA && bOnB) || (aOnB && bOnA);
  });
}

function snapSideToOpposite(side, lo, hi, other, arcs, closeDistance, spherical,
    targets) {
  var data = arcs.getVertexData();
  for (var k = lo; k <= hi; k++) {
    var v = side[k];
    var foot = closestPointOnArc(v.x, v.y, other, arcs);
    if (!foot) continue;
    var d = spherical ?
      fastLonLatDistance(v.x, v.y, foot[0], foot[1]) :
      distance2D(v.x, v.y, foot[0], foot[1]);
    if (!(d > 0) || d > closeDistance) continue;
    var mid = [(v.x + foot[0]) / 2, (v.y + foot[1]) / 2];
    targets[data.xx[v.i] + '~' + data.yy[v.i]] = mid;
  }
}

function closestPointOnArc(x, y, side, arcs) {
  var data = arcs.getVertexData();
  var best = null, bestD2 = Infinity;
  for (var i = 0; i + 1 < side.length; i++) {
    var a = side[i], b = side[i + 1];
    var ax = data.xx[a.i], ay = data.yy[a.i];
    var bx = data.xx[b.i], by = data.yy[b.i];
    var dx = bx - ax, dy = by - ay;
    var len2 = dx * dx + dy * dy;
    var t = len2 > 0 ? ((x - ax) * dx + (y - ay) * dy) / len2 : 0;
    if (t < 0) t = 0;
    if (t > 1) t = 1;
    var fx = ax + t * dx, fy = ay + t * dy;
    var d2 = (x - fx) * (x - fx) + (y - fy) * (y - fy);
    if (d2 < bestD2) {
      bestD2 = d2;
      best = [fx, fy];
    }
  }
  return best;
}
