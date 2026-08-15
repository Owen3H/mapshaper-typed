import Delaunator from 'delaunator';
import Flatbush from 'flatbush';
import { smoothArcCoords } from '../smooth/mapshaper-smooth-algos';
import { pointSegDistSq2 } from '../geom/mapshaper-basic-geom';
import { findMedian } from '../utils/mapshaper-utils';
import { profileStart, profileEnd, profileEnabled } from '../utils/mapshaper-profile';
import { message } from '../utils/mapshaper-logging';

// Build approximate inter-feature Voronoi (medial-axis) cut lines for the
// topological polygon buffer. Where two features' buffers overlap, the
// contested space should be partitioned by proximity to the source polygons;
// the locus of points equidistant from two sources is a generalized Voronoi
// boundary. We approximate it by sampling points along the source rings (one
// label per feature) and emitting the dual Voronoi edges that separate sites of
// different features.
//
// The returned lines are injected into the buffer mosaic as cut-lines: they
// subdivide each contested tile along the equidistant boundary, and any portion
// lying outside the buffers is pruned by the mosaic builder (detachAcyclicArcs).
// Only the boundary between two features' final regions survives the per-feature
// tile dissolve.
//
// @coordDistances: per-feature buffer distance in source-coordinate units (the
// caller converts from meters via getCoordinateDistance), used both as the
// densification scale and as the proximity prune (two sites can only be jointly
// contested if they are within the sum of their features' radii).

// Baseline cap used to derive the spacing floor totalLen/MAX_SITES. On small
// inputs this floor sits well below the buffer distance and adaptive sampling
// works; it is the floor that keeps simple mosaics stable.
var MAX_SITES = 60000;

// The spacing floor is also capped at FLOOR_DISTANCE_FRACTION of the buffer
// distance. On a large mosaic totalLen/MAX_SITES grows until it approaches (or
// exceeds) the buffer distance, which flattens the floor onto maxSpacing and
// disables adaptive densification -- so the narrowest channels (a river between
// two states) zig-zag. Capping the floor at a fraction of the buffer distance
// guarantees adaptive headroom regardless of input size. The value matches the
// floor/maxSpacing ratio at which small mosaics already sample cleanly.
var FLOOR_DISTANCE_FRACTION = 0.1;

// Soft cap on the number of entries in the boundary-segment grid, used to floor
// the cell size (see buildSegmentGrid). The cell otherwise tracks the buffer
// distance alone, so a small distance on a large input gives cells far shorter
// than a single boundary segment and the index grows in inverse proportion to
// the distance: a nationwide mosaic buffered at 1m spans ~1e7 cells, which costs
// hundreds of megabytes and seconds of build time before any distance is
// measured. A wider cell is always correct -- the 3x3 query window only requires
// cell >= reach -- it just puts more segments in each bucket, so the budget
// trades index size against bucket scan length. This value keeps the average
// bucket near one segment on a nationwide mosaic, so the queries stay as cheap as
// they are at large buffer distances.
var GRID_INSERTION_BUDGET = 5e5;

// Rungs of the widening box search in treeGapAtPoint, and the factor between
// them: four rungs a factor of 16 apart, so the search starts at 1/4096 of the
// reach and climbs to it in three more steps. The step is coarse deliberately.
// The rungs cost a geometric series dominated by the last, so a query that has
// to climb the whole ladder pays only a few percent more than one that jumps
// straight to the top, while a short ladder keeps the fixed per-search cost
// down. Both numbers are fixed, and the last rung is always the full reach,
// which is what bounds the query: it makes at most LADDER_RUNGS searches
// whatever the input, and cannot widen past the reach.
var LADDER_RUNGS = 4;
var LADDER_STEP = 16;
var LADDER_BASE = Math.pow(LADDER_STEP, LADDER_RUNGS - 1);

// Window size (segments in the 3x3 cell neighborhood) above which gapAtPoint
// asks the tree instead of scanning. A scan rejects a segment belonging to the
// query point's own feature in a couple of nanoseconds, so a window of a few
// thousand still costs about what one tree query does -- that equivalence is
// what the threshold marks, and below it the scan wins on fixed costs alone.
// Purely a speed tradeoff: the two paths return the same distance, so this can
// be retuned freely. Measured on two county mosaics, scanning up to this size
// left the cheapest cases at their original speed while still handing over
// early enough to keep the widest buffers off the scan's quadratic path.
var WINDOW_SCAN_LIMIT = 3000;

// Soft target total site count. coarsen scales the gap-proportional spacing up
// until the predicted total falls under this, keeping the Delaunay bounded on
// dense shared-border mosaics while leaving sparse inputs at coarsen=1 (fully
// adaptive). Set above the site counts of typical large inputs so those stay
// fully resolved.
var SITE_BUDGET = 800000;

export function buildInterFeatureMedialLines(shapes, coordDistances, arcs, opts) {
  opts = opts || {};
  profileStart('medial:collectSites');
  var sites = collectSites(shapes, coordDistances, arcs);
  profileEnd('medial:collectSites');
  if (!sites || sites.coords.length < 3) return null;
  if (profileEnabled()) {
    message('[medial] sample sites: ' + sites.coords.length);
  }
  profileStart('medial:computeSegments');
  var medial = computeMedialSegments(sites, coordDistances, sites.grid);
  profileEnd('medial:computeSegments');
  if (medial.segments.length === 0) return null;
  // Stitch the individual Voronoi edges (2-point segments that meet at shared
  // circumcenters) into maximal polylines so the medial axis can be simplified
  // and injected as connected paths rather than a swarm of tiny stubs.
  profileStart('medial:assembleChains');
  var chains = assembleChains(medial.segments, medial.coords);
  profileEnd('medial:assembleChains');
  profileStart('medial:recenter');
  chains = chains.map(function(chain) {
    return recenterMedialChain(chain, sites.grid);
  });
  profileEnd('medial:recenter');
  if (opts.smooth) {
    profileStart('medial:smooth');
    chains = chains.map(function(chain) {
      // Smoothing uses one kernel width for the whole chain (see
      // smoothMedialChain), so on a channel whose width varies it can bow the
      // line out of the narrow stretches; re-center again to pull it back.
      return recenterMedialChain(smoothMedialChain(chain, sites.grid), sites.grid);
    });
    profileEnd('medial:smooth');
  }
  // Extend each chain's endpoints outward along their terminal tangent. A medial
  // chain is a cut-line: it only subdivides a contested buffer tile if it spans
  // from boundary to boundary, so the mosaic builder keeps it (an end that
  // terminates in a tile's interior is acyclic and detachAcyclicArcs prunes the
  // whole path). The sampled-site Voronoi stops a fraction of the site spacing
  // short of where two source rings meet (the gap pinches shut), leaving that end
  // dangling INSIDE the buffer. Extending past the source boundary lets the cut
  // node against it; the overshoot lands outside the contested region and is
  // self-pruned. Without this, a whole river-gap tile is left uncut and assigned
  // wholesale to one feature (e.g. the Columbia between Oregon and Washington).
  var extendDist = 0;
  for (var di = 0; di < coordDistances.length; di++) {
    if (coordDistances[di] > extendDist) extendDist = coordDistances[di];
  }
  // Local gap partitioning joins multi-owner junctions before extending only
  // the remaining outer endpoints; it opts out of this blanket extension.
  if (extendDist > 0 && !opts.no_extend) {
    chains = chains.map(function(chain) {
      return extendChainEndpoints(chain, extendDist);
    });
  }
  return {
    type: 'MultiLineString',
    coordinates: chains
  };
}

// Extend an open chain past both endpoints by @len along the direction of the
// terminal segment (so the cut-line pokes out of the contested tile at each end
// and nodes against the enclosing boundary). Zero-length terminal segments and
// chains shorter than 2 points are left unchanged.
function extendChainEndpoints(chain, len) {
  if (!chain || chain.length < 2) return chain;
  var out = chain.concat();
  var head = projectPast(out[0], out[1], len);
  if (head) out.unshift(head);
  var n = out.length;
  var tail = projectPast(out[n - 1], out[n - 2], len);
  if (tail) out.push(tail);
  return out;
}

// Point at distance @len beyond @from, going away from @toward (i.e. continuing
// the from->beyond ray that the toward->from segment defines). Returns null for a
// degenerate (coincident) segment.
function projectPast(from, toward, len) {
  var dx = from[0] - toward[0];
  var dy = from[1] - toward[1];
  var d = Math.sqrt(dx * dx + dy * dy);
  if (d === 0) return null;
  return [from[0] + dx / d * len, from[1] + dy / d * len];
}

// Build the medial-construction triangles for the -buffer debug-delaunay option
// as a GeometryCollection of triangle polygons. collectSites returns only the
// contested sites, so the Delaunay is already the per-region mesh from which the
// medial axis is derived; this keeps the triangles whose circumcenter is an
// actual medial vertex. A triangle qualifies when it has a cross-feature edge
// within buffer reach AND its circumcenter lies inside the overlap
// (circumradius <= reach). The second test drops the long, thin triangles that
// span a ribbon's concave bends: their circumcenters are wild and the medial
// computation discards their segments, so showing them would just add spurious
// spans. Returns null when nothing bridges two features.
export function buildInterFeatureDelaunay(shapes, coordDistances, arcs) {
  var sites = collectSites(shapes, coordDistances, arcs);
  if (!sites || sites.coords.length < 3) return null;
  var coords = sites.coords;
  var owner = sites.owner;
  var triangles = Delaunator.from(coords).triangles;
  var geometries = [];
  for (var i = 0; i < triangles.length; i += 3) {
    var ia = triangles[i], ib = triangles[i + 1], ic = triangles[i + 2];
    var reach = Math.max(
      bridgingReach(ia, ib, coords, owner, coordDistances),
      bridgingReach(ib, ic, coords, owner, coordDistances),
      bridgingReach(ic, ia, coords, owner, coordDistances));
    if (reach <= 0) continue; // no contested edge
    var a = coords[ia], b = coords[ib], c = coords[ic];
    var cc = circumcenter(a, b, c);
    if (!cc) continue; // degenerate (near-collinear)
    var rx = cc[0] - a[0], ry = cc[1] - a[1];
    if (rx * rx + ry * ry > reach * reach) continue; // wild circumcenter
    geometries.push({
      type: 'Polygon',
      coordinates: [[
        [a[0], a[1]], [b[0], b[1]], [c[0], c[1]], [a[0], a[1]]
      ]]
    });
  }
  if (geometries.length === 0) return null;
  return {type: 'GeometryCollection', geometries: geometries};
}

// Buffer reach (sum of the two source radii) of edge (i, j) if its endpoints are
// different features and close enough for their buffers to overlap -- the same
// test computeMedialSegments uses to decide whether an edge's bisector is a
// contested medial edge. Returns 0 when the edge does not bridge features.
function bridgingReach(i, j, coords, owner, coordDistances) {
  if (owner[i] === owner[j]) return 0;
  var dx = coords[i][0] - coords[j][0];
  var dy = coords[i][1] - coords[j][1];
  var reach = coordDistances[owner[i]] + coordDistances[owner[j]];
  return Math.sqrt(dx * dx + dy * dy) <= reach ? reach : 0;
}

// Stitch 2-point medial segments into maximal polylines. The medial network is
// a graph whose vertices are the Delaunay triangles' circumcenters: every
// segment endpoint is a vertex id indexing @coords, so adjacent edges that meet
// at a shared circumcenter share an id directly -- no coordinate hashing needed.
// Degree-2 vertices lie mid-path; degree-1 (hull-ray ends) and degree-3+ (where
// 3+ features meet) vertices are junctions. Each returned chain runs between two
// junctions (or around an isolated loop).
function assembleChains(segments, coords) {
  var nodes = new Array(coords.length);
  function getNode(id) {
    var n = nodes[id];
    if (!n) { n = nodes[id] = {coord: coords[id], edges: []}; }
    return n;
  }
  var edges = segments.map(function(seg) {
    var a = getNode(seg[0]);
    var b = getNode(seg[1]);
    var edge = {a: a, b: b, used: false};
    a.edges.push(edge);
    b.edges.push(edge);
    return edge;
  });
  function other(edge, node) {
    return edge.a === node ? edge.b : edge.a;
  }
  function walk(start, firstEdge) {
    var chain = [start.coord];
    var node = start;
    var edge = firstEdge;
    while (true) {
      edge.used = true;
      node = other(edge, node);
      chain.push(node.coord);
      if (node.edges.length !== 2) break; // junction or dangling end
      var next = node.edges[0] === edge ? node.edges[1] : node.edges[0];
      if (next.used) break; // closed loop back to start
      edge = next;
    }
    return chain;
  }
  var chains = [];
  // Chains anchored at junctions / dangling ends first...
  for (var id = 0; id < nodes.length; id++) {
    var node = nodes[id];
    if (!node || node.edges.length === 2) continue;
    node.edges.forEach(function(edge) {
      if (!edge.used) chains.push(walk(node, edge));
    });
  }
  // ...then any remaining all-degree-2 loops.
  edges.forEach(function(edge) {
    if (!edge.used) chains.push(walk(edge.a, edge));
  });
  return chains;
}

// Gaussian smoothing distance for a medial chain, as a fraction of the local
// channel half-width (see smoothMedialChain). The shared smoother widens this
// distance into its kernel (window several times wider), so a small fraction
// keeps the smoothed centerline well inside the channel -- the smoothed line
// deviates from the raw medial by roughly this fraction of the half-width --
// while still averaging out the discrete-sampling zigzag. 0.4 measured a worst-
// case deviation of ~0.3 of the half-width across buffer distances from 8 to
// 80 km on the Columbia gap.
var MEDIAL_SMOOTH_CLEARANCE_FACTOR = 0.4;

// Replace the discrete-sampling zigzag of a raw medial polyline with a smooth
// centerline using the shared scale-aware Gaussian low-pass filter.
//
// The smoothing distance is keyed to the medial's own local clearance (its
// distance to the nearest source = the channel half-width, read from the segment
// grid), NOT to the buffer distance. This decoupling is deliberate: in fill-gaps
// a user may pick a buffer distance far larger than the actual gaps (to be sure
// the gaps close), and a distance-keyed kernel would then be wide enough to bow
// the medial clean out of a narrow channel and mispartition it. Keyed to the
// channel width, the kernel is always proportional to the channel it smooths.
//
// Planar (the medial is constructed in planar coordinate space), no corner
// preservation (a medial axis between two features has no structural corners,
// and the zigzag we want gone would read as corners), and gain=0 -- the
// curvature-correction term (gain>0) has a transition-band overshoot that would
// re-amplify the very zigzag we are removing. Open-path endpoints are preserved
// exactly, so extendChainEndpoints' terminal-tangent extension still works.
function smoothMedialChain(points, grid) {
  var n = points.length;
  if (n < 3) return points;
  var xx = new Float64Array(n);
  var yy = new Float64Array(n);
  var clearances = [];
  for (var i = 0; i < n; i++) {
    xx[i] = points[i][0];
    yy[i] = points[i][1];
    var c = clearanceAt(grid, points[i][0], points[i][1]);
    if (isFinite(c)) clearances.push(c);
  }
  var halfWidth = findMedian(clearances); // NaN when no clearance was measured
  var dist = halfWidth * MEDIAL_SMOOTH_CLEARANCE_FACTOR;
  if (!(dist > 0)) return points; // no measurable channel -- leave raw
  var res = smoothArcCoords(xx, yy, {
    tolerance: dist,
    method: 'gaussian',
    spherical: false,
    closed: false,
    keepCorners: false,
    gain: 0
  });
  var out = [];
  for (i = 0; i < res.xx.length; i++) out.push([res.xx[i], res.yy[i]]);
  return out.length >= 2 ? out : [points[0], points[n - 1]];
}

// Distance from (x, y) to the nearest source segment of any feature -- the
// medial clearance, i.e. the local channel half-width -- probing the 3x3
// grid-cell neighborhood (cell == max reach). Infinity if no segment is near or
// the grid is absent.
function clearanceAt(grid, x, y) {
  if (!grid) return Infinity;
  var seg = grid.seg;
  var cx = grid.colOf(x), cy = grid.rowOf(y), best = Infinity;
  for (var gx = cx - 1; gx <= cx + 1; gx++) {
    for (var gy = cy - 1; gy <= cy + 1; gy++) {
      var bucket = grid.grid.get(grid.cellKey(gx, gy));
      if (!bucket) continue;
      for (var b = 0; b < bucket.length; b++) {
        var s = bucket[b];
        var d2 = pointSegDistSq2(x, y, seg.x0[s], seg.y0[s], seg.x1[s], seg.y1[s]);
        if (d2 < best) best = d2;
      }
    }
  }
  return Math.sqrt(best);
}

// A medial vertex counts as off-center when its distance to the nearer bank
// falls below this fraction of its distance to the opposite bank (1 = exactly
// centered). Where a channel narrows past the site spacing the sampled Voronoi
// can no longer resolve it: the triangles spanning the neck are slivers whose
// circumcenters land on, or beyond, one bank, so the assembled chain zigzags
// from side to side instead of running down the middle. Finer sampling cannot
// cure this -- a channel that pinches to a point has zero width while the
// spacing has a floor (see spacingFromGap) -- so the geometry is corrected
// afterwards instead. 0.5 leaves the well-sampled interior (measured balance
// ~0.9) untouched and catches the zigzag (~0.1 and below).
var MEDIAL_BALANCE_TOLERANCE = 0.5;

// Pull medial vertices that are off-center, or have slipped inside a source
// polygon, back onto the local centerline: each is replaced by the midpoint of
// its nearest footpoint on either bank. That midpoint is equidistant from the two
// banks by construction and lies between them, so it stays inside the channel
// however narrow it gets; where the channel pinches shut both footpoints converge
// on the neck and the line passes straight through it rather than bouncing off
// the sides.
//
// Valid vertices are left exactly as sampled, so a well-resolved channel keeps
// its true Voronoi geometry. Chain endpoints are also left alone: they sit
// outside the overlap on purpose (hull rays, junction ends) so the cut-line can
// reach the enclosing boundary, and re-centering them would pull the cut back
// inside the tile it has to span.
export function recenterMedialChain(points, ctx) {
  if (!ctx || points.length < 3) return points;
  points = straightenChainTails(points, ctx);
  if (points.length < 3) return points;
  var out = [points[0]];
  for (var i = 1; i < points.length - 1; i++) {
    var p = recenteredVertex(ctx, points[i]);
    // Successive off-center vertices can re-center onto the same neck point;
    // keep one copy so the chain has no zero-length segments.
    if (!samePoint(p, out[out.length - 1])) out.push(p);
  }
  var last = points[points.length - 1];
  if (!samePoint(last, out[out.length - 1])) out.push(last);
  return out.length >= 2 ? out : points;
}

// Straighten the runs of vertices at each end of a chain that lie inside a
// source polygon. Such a vertex cannot be a medial point (its distance to that
// polygon's boundary would be 0), and it cannot be re-centered either: these
// runs trail past the mouth of a gap, where the banks converge into a border the
// medial construction deliberately does not see (a shared arc partitions any
// overlap by itself, so collectCandidateArcPaths prunes it), leaving no channel
// to center them in. They are not dropped, because a chain has to poke out past
// the gap it divides to node against the enclosing boundary (see
// extendChainEndpoints): the run is collapsed to one straight segment, which
// keeps the chain's reach and loses only its wandering.
function straightenChainTails(points, ctx) {
  var last = points.length - 1;
  var lo = 0, hi = last;
  while (lo < hi && insideAnyPolygon(ctx, points[lo])) lo++;
  while (hi > lo && insideAnyPolygon(ctx, points[hi])) hi--;
  if (hi - lo < 1) return points; // no interior vertex survives: leave it alone
  if (lo === 0 && hi === last) return points;
  var out = points.slice(lo, hi + 1);
  if (lo > 0) out.unshift(points[0]);
  if (hi < last) out.push(points[last]);
  return out;
}

function insideAnyPolygon(ctx, p) {
  var near = nearestSegment(ctx, p[0], p[1], -1);
  return near.id !== -1 && insideOwnerPolygon(ctx.seg, near.id, p[0], p[1]);
}

// @p re-centered between its two nearest banks, or @p itself when it is already
// a valid centerline point or only one feature is in range.
var footA = [0, 0], footB = [0, 0]; // scratch, not retained
function recenteredVertex(ctx, p) {
  var near = nearestSegment(ctx, p[0], p[1], -1);
  if (near.id === -1) return p;
  var far = nearestSegment(ctx, p[0], p[1], ctx.seg.feat[near.id]);
  if (far.id === -1) return p;
  // Only a pair of banks within their combined buffer reach forms a channel this
  // vertex could be the centerline of. Past the mouth of a gap the opposite bank
  // can be arbitrarily far away, and pulling the vertex to the midpoint of that
  // pair would move it hundreds of metres off any boundary.
  if (far.dist > ctx.seg.reach[near.id] + ctx.seg.reach[far.id]) return p;
  var offCenter = near.dist < far.dist * MEDIAL_BALANCE_TOLERANCE;
  if (!offCenter && !insideOwnerPolygon(ctx.seg, near.id, p[0], p[1])) return p;
  segmentFoot(ctx.seg, near.id, p[0], p[1], footA);
  segmentFoot(ctx.seg, far.id, p[0], p[1], footB);
  return [(footA[0] + footB[0]) / 2, (footA[1] + footB[1]) / 2];
}

// True when (x, y) lies on the interior side of indexed segment @s, i.e. inside
// the feature that owns it. Source rings are traversed with the polygon interior
// on their right, and seg.side records whether the stored segment direction
// matches its owner's traversal, so the sign of the cross product places the
// point. Judged against the point's nearest segment, this is the test that
// catches a medial vertex thrown out of a pinching gap into a neighbouring
// polygon -- distance cannot: such a vertex is a channel width behind one bank
// and two channel widths from the other, the same ratio as a merely off-center
// point still inside the channel. A true medial vertex is never inside a source
// polygon (its distance to that polygon's boundary would be 0).
function insideOwnerPolygon(seg, s, x, y) {
  var dx = seg.x1[s] - seg.x0[s], dy = seg.y1[s] - seg.y0[s];
  var cross = dx * (y - seg.y0[s]) - dy * (x - seg.x0[s]);
  return cross * seg.side[s] < 0;
}

// The nearest indexed source segment to (x, y), skipping segments owned by
// @excludeFeat (-1 excludes nothing). Probes the 3x3 grid-cell neighborhood
// (cell == max reach). id is -1 when the window holds no eligible segment.
function nearestSegment(ctx, x, y, excludeFeat) {
  var seg = ctx.seg;
  var cx = ctx.colOf(x), cy = ctx.rowOf(y);
  var bestId = -1, best = Infinity;
  for (var gx = cx - 1; gx <= cx + 1; gx++) {
    for (var gy = cy - 1; gy <= cy + 1; gy++) {
      var bucket = ctx.grid.get(ctx.cellKey(gx, gy));
      if (!bucket) continue;
      for (var b = 0; b < bucket.length; b++) {
        var s = bucket[b];
        if (seg.feat[s] === excludeFeat) continue;
        var d2 = pointSegDistSq2(x, y, seg.x0[s], seg.y0[s], seg.x1[s], seg.y1[s]);
        if (d2 < best) { best = d2; bestId = s; }
      }
    }
  }
  return {id: bestId, dist: Math.sqrt(best)};
}

// Closest point to (x, y) on indexed segment @s, clamped to its endpoints,
// written into @out.
function segmentFoot(seg, s, x, y, out) {
  var ax = seg.x0[s], ay = seg.y0[s];
  var dx = seg.x1[s] - ax, dy = seg.y1[s] - ay;
  var len2 = dx * dx + dy * dy;
  var t = len2 > 0 ? ((x - ax) * dx + (y - ay) * dy) / len2 : 0;
  if (t < 0) t = 0;
  if (t > 1) t = 1;
  out[0] = ax + t * dx;
  out[1] = ay + t * dy;
}

function samePoint(a, b) {
  return a[0] === b[0] && a[1] === b[1];
}

// Boundary sample spacing as a fraction of the local gap width: smaller gives a
// smoother medial axis (more sites) in narrow channels. 0.5 keeps the spacing
// at most half the gap, so a channel of width w has at least two samples per
// bank across it.
var GAP_FACTOR = 0.5;

// Gaps narrower than this fraction of the buffer distance are treated as
// "touching" (at or below the buffer's positional tolerance, ~1%): no medial is
// densified there, since the shared source boundary already partitions the
// overlap. This keeps coincident mosaic borders from flooding the triangulation
// with collinear sites while leaving real channels (the Columbia is ~3% of the
// buffer distance) fully sampled.
var TOUCHING_GAP_FRACTION = 0.002;

// Boundary arcs that could bound a gap, found from the layer topology: in a
// shared-arc polygon mosaic an interior border between two features is one arc
// used once forward and once reversed, so the source boundary already
// partitions any buffer overlap there and it needs no medial. An arc used in
// only one direction is an external boundary, an inlet edge, or a hole edge --
// the only places a gap can be. Pruning the shared borders here drops the bulk
// of a dense mosaic (most county/state borders are shared) before any distance
// work; keptSites' distance test still separates the real gaps from the open
// external boundary, so inputs whose coincident borders are NOT shared arcs
// (each polygon carries its own copy) still come out correct, just less pruned.
// Returns one open path per candidate arc, tagged with its owner feature.
function collectCandidateArcPaths(shapes, coordDistances, arcs) {
  var n = arcs.size();
  var fwd = new Int32Array(n).fill(-1);
  var rev = new Int32Array(n).fill(-1);
  for (var s = 0; s < shapes.length; s++) {
    var shape = shapes[s];
    if (!shape || !(coordDistances[s] > 0)) continue;
    for (var p = 0; p < shape.length; p++) {
      var ids = shape[p];
      for (var k = 0; k < ids.length; k++) {
        var id = ids[k];
        if (id < 0) { if (rev[~id] === -1) rev[~id] = s; }
        else if (fwd[id] === -1) fwd[id] = s;
      }
    }
  }
  var paths = [];
  for (var i = 0; i < n; i++) {
    var f = fwd[i], r = rev[i];
    if (f === -1 && r === -1) continue; // arc not used by a buffered feature
    if (f !== -1 && r !== -1) continue; // shared interior border -- not a gap
    var pts = arcCoords(arcs, i);
    // forward records whether the owner traverses the arc in the stored
    // direction, which is what fixes the interior side of its segments (see
    // insideOwnerPolygon).
    if (pts.length >= 2) {
      paths.push({owner: f !== -1 ? f : r, points: pts, forward: f !== -1});
    }
  }
  return paths;
}

function arcCoords(arcs, arcId) {
  var iter = arcs.getArcIter(arcId);
  var pts = [];
  while (iter.hasNext()) pts.push([iter.x, iter.y]);
  return pts;
}

// Gather labeled Voronoi sites from the gap-candidate boundary arcs (see
// collectCandidateArcPaths) of the buffered features.
//
// Those arcs are sampled adaptively: where two features run close together
// (e.g. the opposite banks of a narrow river) the boundary is sampled finely so
// the medial axis tracks the channel centerline instead of zigzagging between
// the banks; where features are far apart the spacing relaxes to the buffer
// distance. The local gap width is measured directly to the candidate boundary
// segments (computeVertexGaps), driving the densification in a single pass.
function collectSites(shapes, coordDistances, arcs) {
  if (!arcs) return null;
  var paths = collectCandidateArcPaths(shapes, coordDistances, arcs);
  if (paths.length < 2) return null;

  // Assign every candidate vertex a stable id (vid) so a per-vertex gap can be
  // looked up while densifying its segments.
  var verts = buildVertexLayout(paths);
  if (verts.count < 2) return null;
  var totalLen = ringsLength(paths.map(function(p) { return p.points; }));
  // Spacing floor: totalLen/MAX_SITES is the simple-mosaic floor (keeps small
  // inputs stable and near-coincident borders from over-sampling), but it is
  // capped at a fraction of the buffer distance so a large mosaic keeps adaptive
  // headroom instead of flattening onto maxSpacing. When the cap binds, fitCoarsen
  // is what bounds the actual site total.
  var maxDistance = 0;
  for (var ci = 0; ci < coordDistances.length; ci++) {
    if (coordDistances[ci] > maxDistance) maxDistance = coordDistances[ci];
  }
  var spacingFloor = Math.min(totalLen / MAX_SITES,
    maxDistance * FLOOR_DISTANCE_FRACTION);

  // Sample spacing is proportional to the local gap (gap * GAP_FACTOR * coarsen),
  // floored at spacingFloor and capped at the buffer distance, so the narrowest
  // channels (a river between two states) get the finest sampling and wide
  // overlaps the coarsest. coarsen scales the whole distribution up just enough
  // to fit the site budget on dense mosaics (counties), keeping narrow channels
  // proportionally finer than wide ones; on sparse inputs it stays 1 (fully
  // adaptive). The per-vertex gap is computed directly from the boundary geometry
  // in a single pass, then we densify once.
  var grid = buildSegmentGrid(verts, coordDistances);
  var gaps = computeVertexGaps(grid, verts, coordDistances);
  // No contested channel anywhere: every vertex is either out of reach of every
  // other feature (open coast) or within the touching threshold of one (where the
  // source boundary already partitions). densify + Delaunay would only allocate
  // sites that keptSites then discards, so stop here. Single-feature inputs and
  // mosaics whose features are all farther than a buffer-diameter apart take this
  // path; a mosaic with even one real gap continues.
  if (!hasContestedGap(gaps, maxDistance)) return null;
  var coarsen = fitCoarsen(verts, gaps, coordDistances, spacingFloor, grid);
  var sites = densifyVertices(verts, gaps, coordDistances, spacingFloor, coarsen, grid);
  // Triangulate only the sites bordering a real gap. Its medial segments come
  // exclusively from cross-feature edges, and the well-shaped triangles that
  // bridge a gap have their apex within reach too (a far apex makes a thin
  // triangle whose wild circumcenter is filtered out, or a hull edge that is
  // extrapolated as an outward ray). Dropping the touching interior borders and
  // the no-feature coastline shrinks the one remaining Delaunay and avoids
  // building a redundant medial where the source boundary already partitions.
  var kept = keptSites(sites, grid, coordDistances);
  // Keep the segment grid with the sites so computeMedialSegments can re-measure
  // the true source gap when the sample-pair proximity test is too coarse.
  kept.grid = grid;
  return kept;
}

// Bucket every boundary segment into a uniform grid so the nearest cross-feature
// segment to an arbitrary point can be found by probing its 3x3 cell
// neighborhood. The cell is at least the maximum reach (sum of the two largest
// buffer distances), so any in-reach segment is guaranteed to fall in that 3x3
// window. Returns null when there is no positive reach. Reused for both the
// per-vertex gap (drives adaptive sampling) and the per-site keep test
// (gapAtPoint).
export function buildSegmentGrid(verts, coordDistances) {
  var paths = verts.paths;
  var maxDist = 0;
  for (var d = 0; d < coordDistances.length; d++) {
    if (coordDistances[d] > maxDist) maxDist = coordDistances[d];
  }
  var reach = 2 * maxDist; // upper bound on any pair's reach
  if (!(reach > 0)) return null;
  var xmin = Infinity, ymin = Infinity, ymax = -Infinity;
  var totalLen = 0;
  paths.forEach(function(path) {
    var pts = path.points;
    for (var i = 0; i < pts.length; i++) {
      if (pts[i][0] < xmin) xmin = pts[i][0];
      if (pts[i][1] < ymin) ymin = pts[i][1];
      if (pts[i][1] > ymax) ymax = pts[i][1];
      if (i > 0) {
        var sdx = pts[i][0] - pts[i - 1][0];
        var sdy = pts[i][1] - pts[i - 1][1];
        totalLen += Math.sqrt(sdx * sdx + sdy * sdy);
      }
    }
  });
  // A segment occupies about len/cell cells, so the whole index is about
  // totalLen/cell entries; widening the cell to fit the budget bounds it (see
  // GRID_INSERTION_BUDGET). The reach is the floor, not the target: a cell
  // narrower than the reach would break the 3x3 query window.
  var cell = Math.max(reach, totalLen / GRID_INSERTION_BUDGET);
  // +1 cell index shift keeps probed -1 neighbors non-negative; rowSpan packs
  // (col, row) into a collision-free integer key.
  var rowSpan = Math.floor((ymax - ymin) / cell) + 3;
  function cellKey(cx, cy) { return (cx + 1) * rowSpan + (cy + 1); }
  function colOf(x) { return Math.floor((x - xmin) / cell); }
  function rowOf(y) { return Math.floor((y - ymin) / cell); }
  var seg = {x0: [], y0: [], x1: [], y1: [], feat: [], reach: [], side: []};
  var grid = new Map();

  // Index a segment into every cell it crosses, column by column: within one
  // column the segment covers a single y-range (it is a straight line clipped to
  // that column's x-range), so the exact row span is two floor()s. This costs
  // O(len/cell) entries, where stamping the segment's bounding box instead costs
  // O((len/cell)^2) for a diagonal segment -- on a nationwide input buffered by a
  // few meters that quadratic term ran to ~1e9 entries and exceeded the runtime's
  // maximum Map size.
  function addSegment(ax, ay, bx, by, idx) {
    if (ax > bx) {
      var tx = ax; ax = bx; bx = tx;
      var ty = ay; ay = by; by = ty;
    }
    var dx = bx - ax, dy = by - ay;
    var cxa = colOf(ax), cxb = colOf(bx);
    for (var gx = cxa; gx <= cxb; gx++) {
      var yLo = ay, yHi = by;
      if (dx > 0) {
        // clip the segment to this column and take the y-range of the piece
        var xLo = Math.max(ax, xmin + gx * cell);
        var xHi = Math.min(bx, xmin + (gx + 1) * cell);
        yLo = ay + dy * (xLo - ax) / dx;
        yHi = ay + dy * (xHi - ax) / dx;
      }
      var gya = rowOf(Math.min(yLo, yHi));
      var gyb = rowOf(Math.max(yLo, yHi));
      for (var gy = gya; gy <= gyb; gy++) {
        var key = cellKey(gx, gy);
        var bucket = grid.get(key);
        if (bucket) bucket.push(idx); else grid.set(key, [idx]);
      }
    }
  }

  paths.forEach(function(path) {
    var pts = path.points;
    var feat = path.owner;
    var featReach = coordDistances[feat];
    var side = path.forward === false ? -1 : 1;
    for (var k = 0; k + 1 < pts.length; k++) {
      var ax = pts[k][0], ay = pts[k][1], bx = pts[k + 1][0], by = pts[k + 1][1];
      var idx = seg.feat.length;
      seg.x0.push(ax); seg.y0.push(ay); seg.x1.push(bx); seg.y1.push(by);
      seg.feat.push(feat); seg.reach.push(featReach); seg.side.push(side);
      addSegment(ax, ay, bx, by, idx);
    }
  });
  return {seg: seg, grid: grid, cellKey: cellKey, colOf: colOf, rowOf: rowOf,
    index: buildSegmentTree(seg), maxReach: maxDist};
}

// R-tree over the same segments, used only by gapAtPoint and only where the
// grid's query window has grown expensive (see there). The grid remains the
// index of record: it answers every other probe in this file.
function buildSegmentTree(seg) {
  var n = seg.feat.length;
  if (n === 0) return null;
  var index = new Flatbush(n);
  for (var i = 0; i < n; i++) {
    var x0 = seg.x0[i], x1 = seg.x1[i], y0 = seg.y0[i], y1 = seg.y1[i];
    index.add(Math.min(x0, x1), Math.min(y0, y1), Math.max(x0, x1), Math.max(y0, y1));
  }
  index.finish();
  return index;
}

// The channel width at (x, y): distance to the nearest different-feature segment
// within their combined reach, or Infinity if none. Works for any point, not
// just original vertices, so a long edge whose endpoints are out of reach but
// whose middle crosses a gap is still measured correctly at the interior sites.
// Answered from whichever index is cheaper here. Both return the same number,
// so the choice is a speed decision only: the window scan costs one pass over
// the segments in the point's grid cells, which is nothing on a sparse
// neighborhood but grows as the square of the buffer distance (the cell is
// floored at the reach), while the tree search does not grow that way but pays
// fixed costs on every call.
export function gapAtPoint(ctx, x, y, feat, reachF) {
  var n = collectWindow(ctx, x, y);
  if (ctx.index && windowSize > WINDOW_SCAN_LIMIT) {
    return treeGapAtPoint(ctx, x, y, feat, reachF);
  }
  return scanWindow(ctx.seg, n, x, y, feat, reachF, Infinity);
}

// Number of segments in the 3x3 cell window last collected by collectWindow.
var windowSize = 0;
// Scratch list of that window's buckets, reused across calls to keep the query
// allocation-free. Safe because a query never re-enters gapAtPoint: the buckets
// are consumed by scanWindow before anything else runs.
var windowBuckets = [];

// Gather the buckets of the 3x3 cell neighborhood around (x, y) into the
// scratch list, returning how many there are and setting windowSize to the
// total segment count. The cell is at least the maximum reach, so this window
// is guaranteed to hold every segment within reach of the point.
function collectWindow(ctx, x, y) {
  var cx = ctx.colOf(x), cy = ctx.rowOf(y);
  var n = 0;
  windowSize = 0;
  for (var gx = cx - 1; gx <= cx + 1; gx++) {
    for (var gy = cy - 1; gy <= cy + 1; gy++) {
      var bucket = ctx.grid.get(ctx.cellKey(gx, gy));
      if (!bucket) continue;
      windowBuckets[n++] = bucket;
      windowSize += bucket.length;
    }
  }
  return n;
}

// Exhaustive scan of the collected window: distance to the nearest
// different-feature segment within their combined reach, or @best if none is
// closer.
function scanWindow(seg, n, x, y, feat, reachF, best) {
  for (var i = 0; i < n; i++) {
    var bucket = windowBuckets[i];
    for (var b = 0; b < bucket.length; b++) {
      var s = bucket[b];
      if (seg.feat[s] === feat) continue;
      var reach = reachF + seg.reach[s];
      var dsq = pointSegDistSq2(x, y, seg.x0[s], seg.y0[s], seg.x1[s], seg.y1[s]);
      if (dsq <= reach * reach) {
        var dist = Math.sqrt(dsq);
        if (dist < best) best = dist;
      }
    }
  }
  return best;
}

// Same query answered from the R-tree, by widening a box search along a fixed
// ladder of radii until the answer it holds is provably the global one.
//
// The invariant that makes an intermediate rung conclusive: a box of half-width
// r contains the whole disc of radius r, so every segment closer than r to the
// point is among the hits. If the nearest in-reach hit is itself within r, no
// unreturned segment can beat it and the search can stop. Otherwise the answer
// might lie in the annulus beyond r and the next rung has to look.
//
// The ladder is what keeps the cost sane in both directions. Starting small
// makes the common case -- a point on one bank of a narrow gap, its neighbor a
// few meters away -- cost one search of a tiny box, independent of the buffer
// distance. Ending at the full reach makes the rare case -- a point with no
// feature anywhere near it, so nothing can be proven short of exhausting the
// reach -- cost the geometric sum of the rungs, a small multiple of going there
// directly. The step is coarse so that there are only a handful of rungs.
//
// A previous attempt used neighbors() to take the k nearest instead. It was
// much worse here, because a query that cannot find k in-reach candidates makes
// neighbors() heap-walk every leaf in the whole reach disc -- and points with
// no feature within reach are exactly what a coastline is made of.
function treeGapAtPoint(ctx, x, y, feat, reachF) {
  var seg = ctx.seg;
  var index = ctx.index;
  // Nothing beyond the largest possible pair reach can pass the test below, so
  // the ladder tops out there rather than searching the whole extent.
  var maxDist = reachF + ctx.maxReach;
  var filter = function(s) { return seg.feat[s] !== feat; };
  var r = maxDist / LADDER_BASE;
  for (var k = 0; k < LADDER_RUNGS - 1; k++) {
    var best = nearestInBox(seg, index, x, y, r, reachF, filter);
    if (best <= r) return best;
    r *= LADDER_STEP;
  }
  // The top rung covers every segment that could be in reach at all, so its
  // answer is final even when nothing was found.
  return nearestInBox(seg, index, x, y, maxDist, reachF, filter);
}

// Distance from (x, y) to the nearest segment that passes @filter and lies
// within its pair reach, considering only segments whose bounding box meets the
// box of half-width @r. Infinity if there is none.
function nearestInBox(seg, index, x, y, r, reachF, filter) {
  var ids = index.search(x - r, y - r, x + r, y + r, filter);
  var best = Infinity;
  for (var i = 0; i < ids.length; i++) {
    var s = ids[i];
    var reach = reachF + seg.reach[s];
    var dsq = pointSegDistSq2(x, y, seg.x0[s], seg.y0[s], seg.x1[s], seg.y1[s]);
    if (dsq <= reach * reach) {
      var dist = Math.sqrt(dsq);
      if (dist < best) best = dist;
    }
  }
  return best;
}

// Local gap at each original vertex (drives adaptive sampling, see
// segmentSpacing). Measuring straight to the boundary segments yields the true
// gap in a single pass, replacing the old triangulate -> estimate-gap ->
// re-densify refinement loop that existed only because a coarse sampling can't
// see a narrow gap (its nearest cross-feature SAMPLE is far).
function computeVertexGaps(ctx, verts, coordDistances) {
  profileStart('medial:segmentGaps');
  var gaps = filledArray(verts.count, Infinity);
  if (ctx) {
    verts.paths.forEach(function(path) {
      var pts = path.points;
      var vids = path.vids;
      var feat = path.owner;
      var reachF = coordDistances[feat];
      for (var k = 0; k < vids.length; k++) {
        var g = gapAtPoint(ctx, pts[k][0], pts[k][1], feat, reachF);
        if (g < gaps[vids[k]]) gaps[vids[k]] = g;
      }
    });
  }
  profileEnd('medial:segmentGaps');
  return gaps;
}

// True when medial vertex c lies in the buffer overlap of features fp and fq:
// within fp's radius of an fp-owned source segment AND within fq's radius of an
// fq-owned source segment. Measured against the actual source segments via the
// grid, so it is correct regardless of how coarsely the banks were sampled --
// unlike the sample-pair distance, which overestimates the gap when the nearest
// samples on opposite banks are staggered or far from the true closest approach.
// Slack on each reach when rescuing a cross-feature edge whose sample endpoints
// fell outside the cheap proximity test. It absorbs the discretization of the
// medial graph near a pinch point: the connecting Voronoi edge is bounded by the
// site spacing (capped at the buffer distance), so a genuinely contested edge can
// run up to ~1.5x reach and its medial vertices can land a similar fraction
// outside the overlap. 1.3 covers the worst real case observed (~1.18) with
// headroom, while spurious edges between sites contested with *other* features
// miss by far more (>=1.5 or have no nearby source segment) and stay pruned.
var MEDIAL_OVERLAP_SLACK = 1.3;

function medialVertexInOverlap(ctx, c, fp, fq, rp, rq) {
  var sp = rp * MEDIAL_OVERLAP_SLACK, sq = rq * MEDIAL_OVERLAP_SLACK;
  return pointFeatureDistSq(ctx, c[0], c[1], fp) <= sp * sp &&
    pointFeatureDistSq(ctx, c[0], c[1], fq) <= sq * sq;
}

// Squared distance from (x, y) to the nearest segment owned by feature @feat,
// probing the 3x3 grid-cell neighborhood (cell == max reach, so any segment
// within a single feature's radius is in the window). Infinity if none.
function pointFeatureDistSq(ctx, x, y, feat) {
  var seg = ctx.seg, grid = ctx.grid;
  var cx = ctx.colOf(x), cy = ctx.rowOf(y);
  var best = Infinity;
  for (var gx = cx - 1; gx <= cx + 1; gx++) {
    for (var gy = cy - 1; gy <= cy + 1; gy++) {
      var bucket = grid.get(ctx.cellKey(gx, gy));
      if (!bucket) continue;
      for (var b = 0; b < bucket.length; b++) {
        var s = bucket[b];
        if (seg.feat[s] !== feat) continue;
        var d2 = pointSegDistSq2(x, y, seg.x0[s], seg.y0[s], seg.x1[s], seg.y1[s]);
        if (d2 < best) best = d2;
      }
    }
  }
  return best;
}

// Keep only the sites that border a real gap: a different feature within reach
// (finite gap) but farther than the touching threshold. These are the only sites
// that can shape the medial axis. Touching/coincident interior borders (gap ~ 0,
// the shared source boundary already partitions them) and the no-feature
// coastline (gap = Infinity) are dropped, so the Delaunay covers just the
// genuine gaps -- no triangulation is wasted on borders that need no medial.
// The gap is measured per site (not per vertex) so a long edge whose endpoints
// fall out of reach but whose middle crosses a gap keeps its interior points.
function keptSites(sites, ctx, coordDistances) {
  profileStart('medial:contested');
  var result = {coords: [], owner: [], origin: []};
  if (!ctx) {
    profileEnd('medial:contested');
    return result;
  }
  var coords = sites.coords, owner = sites.owner, origin = sites.origin;
  for (var i = 0; i < coords.length; i++) {
    var feat = owner[i];
    var reach = coordDistances[feat];
    var g = gapAtPoint(ctx, coords[i][0], coords[i][1], feat, reach);
    if (isFinite(g) && g > reach * TOUCHING_GAP_FRACTION) {
      result.coords.push(coords[i]);
      result.owner.push(feat);
      result.origin.push(origin[i]);
    }
  }
  profileEnd('medial:contested');
  return result;
}

function ringsLength(rings) {
  var sum = 0;
  rings.forEach(function(points) {
    for (var i = 1; i < points.length; i++) {
      var dx = points[i][0] - points[i - 1][0];
      var dy = points[i][1] - points[i - 1][1];
      sum += Math.sqrt(dx * dx + dy * dy);
    }
  });
  return sum;
}

function filledArray(n, v) {
  var a = new Float64Array(n);
  a.fill(v);
  return a;
}

// Flatten the candidate arc paths into a vertex layout: one entry per path
// carrying its owner feature, its points, and a stable id (vid) for each vertex,
// so densifyVertices can re-sample using a per-vid gap estimate. Each candidate
// arc is an open polyline (every coordinate is a vertex, no wrap-around); a
// closed ring made of a single arc arrives with its first point repeated at the
// end, so treating it as open still covers the full loop.
function buildVertexLayout(paths) {
  var layout = [];
  var count = 0;
  paths.forEach(function(path) {
    var points = path.points;
    var m = points.length;
    if (m < 2) return;
    var vids = [];
    for (var i = 0; i < m; i++) vids.push(count++);
    layout.push({owner: path.owner, points: points, vids: vids});
  });
  return {paths: layout, count: count};
}

// True when any vertex borders a real gap: within reach of another feature, but
// farther than the touching threshold. Matching keptSites' keep rule, so when
// this is false every densified site would be discarded and there is nothing for
// the medial to cut.
export function hasContestedGap(gaps, maxDistance) {
  var touch = maxDistance * TOUCHING_GAP_FRACTION;
  for (var i = 0; i < gaps.length; i++) {
    if (isFinite(gaps[i]) && gaps[i] > touch) return true;
  }
  return false;
}

// The spacing for a path segment: the tighter of its two endpoints' gap-derived
// spacings (so a segment straddling a narrowing gap samples at the finer rate).
// Infinity means "do not densify" (see spacingFromGap). When both endpoints are
// open-coast but the segment is long enough that its middle could still pass
// within reach of another feature, the midpoint is probed via @ctx so a
// contested channel bounded by long unvertexed edges is not missed.
function segmentSpacing(path, k, gaps, maxSpacing, spacingFloor, coarsen, ctx) {
  var gA = gaps[path.vids[k]], gB = gaps[path.vids[k + 1]];
  var sA = spacingFromGap(gA, maxSpacing, spacingFloor, coarsen);
  var sB = spacingFromGap(gB, maxSpacing, spacingFloor, coarsen);
  var s = Math.min(sA, sB);
  if (isFinite(s) || !ctx) return s;
  // both endpoints open: only a long segment can hide a contested middle
  // (shorter than the reach, either endpoint would have seen it)
  var a = path.points[k], b = path.points[k + 1];
  var dx = b[0] - a[0], dy = b[1] - a[1];
  if (dx * dx + dy * dy <= 4 * maxSpacing * maxSpacing) return s;
  var midGap = gapAtPoint(ctx, (a[0] + b[0]) / 2, (a[1] + b[1]) / 2,
    path.owner, maxSpacing);
  return spacingFromGap(midGap, maxSpacing, spacingFloor, coarsen);
}

// Re-sample every candidate path: emit each original vertex (tagged with its
// vid) plus interior points spaced by the local gap-derived spacing (see
// segmentSpacing). Paths are open, so the last vertex has no following segment.
// Open-coast segments (both endpoints out of reach of every other feature) are
// not densified -- keptSites would discard those interior points, and densifying
// them at spacing = buffer distance is what used to emit tens of millions of
// sites along a nationwide coastline. A segment with one contested endpoint
// still densifies at that endpoint's rate, so a channel that pinches shut is
// sampled into its mouth. Long open-coast edges are midpoint-probed (see
// segmentSpacing) so a contested channel whose bounding edges lack a vertex
// within reach is still sampled.
export function densifyVertices(verts, gaps, coordDistances, spacingFloor, coarsen, ctx) {
  var coords = [];
  var owner = [];
  var origin = []; // vid for original vertices, -1 for interpolated points
  verts.paths.forEach(function(path) {
    var maxSpacing = coordDistances[path.owner];
    var m = path.vids.length;
    for (var k = 0; k < m; k++) {
      var a = path.points[k];
      coords.push([a[0], a[1]]);
      owner.push(path.owner);
      origin.push(path.vids[k]);
      if (k + 1 >= m) continue; // open path: no segment past the last vertex
      var b = path.points[k + 1];
      var s = segmentSpacing(path, k, gaps, maxSpacing, spacingFloor, coarsen, ctx);
      var dx = b[0] - a[0], dy = b[1] - a[1];
      var len = Math.sqrt(dx * dx + dy * dy);
      // s == Infinity for open-coast segments (see spacingFromGap): skip
      if (s > 0 && isFinite(s) && len > s) {
        var steps = Math.floor(len / s);
        for (var t = 1; t <= steps; t++) {
          var f = t / (steps + 1);
          coords.push([a[0] + dx * f, a[1] + dy * f]);
          owner.push(path.owner);
          origin.push(-1);
        }
      }
    }
  });
  return {coords: coords, owner: owner, origin: origin};
}

// Spacing used to densify a segment endpoint. Open coast (no other feature
// within reach) returns Infinity so densifyVertices emits no interior points --
// those sites cannot shape the medial and used to dominate the site count on
// large inputs. Touching/coincident borders keep the coarse buffer-distance
// spacing (the source boundary already partitions them; fine sampling would only
// flood the triangulation with collinear sites). Real gaps densify at a fraction
// of the local width, floored and capped.
export function spacingFromGap(gap, maxSpacing, spacingFloor, coarsen) {
  if (!isFinite(gap)) return Infinity;
  // A gap at or below the buffer's positional tolerance means the two features
  // effectively touch: there is no contested channel to run a medial down, and
  // the shared source boundary already partitions the overlap. Densifying it
  // would only flood a coincident border with collinear sites (millions of them
  // on a clean topological mosaic), so leave it at the coarse spacing.
  if (gap < maxSpacing * TOUCHING_GAP_FRACTION) return maxSpacing;
  var s = gap * GAP_FACTOR * coarsen;
  if (s > maxSpacing) s = maxSpacing;
  if (s < spacingFloor) s = spacingFloor;
  return s;
}

// Predicted total site count for a given coarsen, matching densifyVertices'
// emission rule exactly (one site per original vertex plus floor(len/spacing)
// interior points per segment). Pure counting, no Delaunay -- cheap enough to
// binary-search coarsen against. Counts pre-keep sites (the densification work),
// which is what coarsen actually bounds.
function predictSiteCount(verts, gaps, coordDistances, spacingFloor, coarsen, ctx) {
  var total = verts.count; // every original vertex is emitted
  verts.paths.forEach(function(path) {
    var maxSpacing = coordDistances[path.owner];
    var m = path.vids.length;
    for (var k = 0; k + 1 < m; k++) {
      var s = segmentSpacing(path, k, gaps, maxSpacing, spacingFloor, coarsen, ctx);
      var a = path.points[k];
      var b = path.points[k + 1];
      var dx = b[0] - a[0], dy = b[1] - a[1];
      var len = Math.sqrt(dx * dx + dy * dy);
      if (s > 0 && isFinite(s) && len > s) total += Math.floor(len / s);
    }
  });
  return total;
}

// Smallest coarsen (>= 1) whose predicted site count fits SITE_BUDGET. Site
// count decreases monotonically as coarsen grows (spacing widens), so binary
// search converges; capped because near-coincident gaps (gap ~ 0) can't be
// thinned by coarsen and are bounded by spacingFloor instead.
function fitCoarsen(verts, gaps, coordDistances, spacingFloor, ctx) {
  if (predictSiteCount(verts, gaps, coordDistances, spacingFloor, 1, ctx) <= SITE_BUDGET) {
    return 1;
  }
  var lo = 1, hi = 1024;
  if (predictSiteCount(verts, gaps, coordDistances, spacingFloor, hi, ctx) > SITE_BUDGET) {
    return hi; // even fully coarsened we can't fit; accept the floor-bounded count
  }
  for (var i = 0; i < 20; i++) {
    var mid = (lo + hi) / 2;
    if (predictSiteCount(verts, gaps, coordDistances, spacingFloor, mid, ctx) > SITE_BUDGET) {
      lo = mid;
    } else {
      hi = mid;
    }
  }
  return hi;
}

function nextHalfedge(e) {
  return e % 3 === 2 ? e - 2 : e + 1;
}

function triangleOfEdge(e) {
  return Math.floor(e / 3);
}

function computeMedialSegments(sites, coordDistances, ctx) {
  var coords = sites.coords;
  var owner = sites.owner;
  profileStart('medial:delaunay');
  var del = Delaunator.from(coords);
  profileEnd('medial:delaunay');
  var triangles = del.triangles;
  var halfedges = del.halfedges;
  var ntri = triangles.length / 3;
  // Medial-graph vertex coords, indexed by id. Triangle t's circumcenter is
  // vertex id t (so the three medial edges meeting at it share that id without
  // coordinate hashing); hull-ray ends are appended with fresh ids.
  var verts = new Array(ntri);
  var i;
  for (i = 0; i < ntri; i++) {
    verts[i] = circumcenter(
      coords[triangles[3 * i]],
      coords[triangles[3 * i + 1]],
      coords[triangles[3 * i + 2]]);
  }
  var segments = [];
  for (var e = 0; e < triangles.length; e++) {
    var opp = halfedges[e];
    var p = triangles[e];
    var q = triangles[nextHalfedge(e)];
    var fp = owner[p], fq = owner[q];
    if (fp === fq) continue;
    var dx = coords[p][0] - coords[q][0];
    var dy = coords[p][1] - coords[q][1];
    var siteDist = Math.sqrt(dx * dx + dy * dy);
    var rp = coordDistances[fp], rq = coordDistances[fq];
    var reach = rp + rq;
    var t1 = triangleOfEdge(e);
    var c1 = verts[t1];
    if (!c1) continue; // degenerate (near-collinear) triangle
    // Sites within the sum of their radii are accepted directly; this is the
    // common, cheap case. When they are farther apart, the bisector might still
    // be contested -- the nearest sample pair overestimates the true source gap
    // where banks are sampled coarsely or staggered. Re-measure the actual gap
    // at the medial vertex against the source segments (the grid) and rescue the
    // edge if it really lies in the buffer overlap. Without the rescue the medial
    // axis fragments at such spots, leaving the equidistant cut wall open so the
    // overlap face is never subdivided and a whole contested corridor is assigned
    // to one feature (a feature wrapping a neighbor's enclosed island).
    var near = siteDist <= reach;
    if (opp === -1) {
      if (!near && !(ctx && medialVertexInOverlap(ctx, c1, fp, fq, rp, rq))) continue;
      // Hull edge: the Voronoi edge here is an unbounded ray (the bisector of
      // two sites on the convex hull). Emit it as an outward ray from the
      // circumcenter so the medial line reaches and crosses the buffer
      // boundary -- otherwise an interior medial segment that ends at this
      // circumcenter would dangle inside a tile and be pruned, leaving no cut.
      // The excess outside the buffers is trimmed by detachAcyclicArcs.
      var third = coords[triangles[nextHalfedge(nextHalfedge(e))]];
      var end = outwardRayEnd(c1, coords[p], coords[q], third, reach);
      if (end) {
        var rayId = verts.length;
        verts.push(end);
        segments.push([t1, rayId]);
      }
      continue;
    }
    // interior edge: emit once (at the lower halfedge index)
    if (opp < e) continue;
    var t2 = triangleOfEdge(opp);
    var c2 = verts[t2];
    if (!c2) continue;
    if (!near && !(ctx &&
        (medialVertexInOverlap(ctx, c1, fp, fq, rp, rq) ||
         medialVertexInOverlap(ctx, c2, fp, fq, rp, rq)))) continue;
    var sx = c1[0] - c2[0], sy = c1[1] - c2[1];
    var segLen = Math.sqrt(sx * sx + sy * sy);
    // a real medial edge inside the overlap is short (on the order of the site
    // spacing plus the gap); a very long segment comes from a near-degenerate
    // triangle whose circumcenter is wild, so drop it
    if (segLen > 3 * (reach + siteDist)) continue;
    segments.push([t1, t2]);
  }
  return {segments: segments, coords: verts};
}

// Endpoint of the outward Voronoi ray for a hull edge (p, q) whose triangle's
// third vertex is @third: starts at the circumcenter @c, runs along the edge's
// perpendicular bisector, away from @third (outward), a length proportional to
// the buffer reach so it clears the buffer boundary.
function outwardRayEnd(c, p, q, third, reach) {
  var ex = q[0] - p[0], ey = q[1] - p[1];
  var nx = -ey, ny = ex; // a normal to the edge
  var mx = (p[0] + q[0]) / 2, my = (p[1] + q[1]) / 2;
  // orient the normal away from the third vertex (outward from the hull)
  if (nx * (mx - third[0]) + ny * (my - third[1]) < 0) {
    nx = -nx;
    ny = -ny;
  }
  var len = Math.sqrt(nx * nx + ny * ny);
  if (len === 0 || !isFinite(len)) return null;
  var L = 3 * reach;
  return [c[0] + nx / len * L, c[1] + ny / len * L];
}

function circumcenter(a, b, c) {
  var ax = a[0], ay = a[1], bx = b[0], by = b[1], cx = c[0], cy = c[1];
  var d = 2 * (ax * (by - cy) + bx * (cy - ay) + cx * (ay - by));
  if (d === 0 || !isFinite(d)) return null;
  var a2 = ax * ax + ay * ay;
  var b2 = bx * bx + by * by;
  var c2 = cx * cx + cy * cy;
  var ux = (a2 * (by - cy) + b2 * (cy - ay) + c2 * (ay - by)) / d;
  var uy = (a2 * (cx - bx) + b2 * (ax - cx) + c2 * (bx - ax)) / d;
  if (!isFinite(ux) || !isFinite(uy)) return null;
  return [ux, uy];
}
