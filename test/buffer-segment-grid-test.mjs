import assert from 'assert';
import {
  buildSegmentGrid,
  gapAtPoint
} from '../src/buffer/mapshaper-buffer-voronoi';
import { pointSegDistSq2 } from '../src/geom/mapshaper-basic-geom';

// The medial construction's boundary-segment grid answers "how far is the
// nearest segment of another feature, within reach?" by scanning the query
// point's 3x3 cell neighborhood. That is only correct if every cell a segment
// crosses holds it, so these tests check the index against brute force, and
// check that its size stays bounded when the buffer distance is much smaller
// than a boundary segment (the case that used to exceed the maximum Map size).

function makeVerts(paths) {
  var count = 0;
  var layout = paths.map(function(path) {
    var vids = path.points.map(function() { return count++; });
    return {owner: path.owner, points: path.points, vids: vids};
  });
  return {paths: layout, count: count};
}

function bruteGap(paths, coordDistances, x, y, feat) {
  var best = Infinity;
  paths.forEach(function(path) {
    if (path.owner === feat) return;
    var reach = coordDistances[feat] + coordDistances[path.owner];
    var pts = path.points;
    for (var i = 0; i + 1 < pts.length; i++) {
      var d2 = pointSegDistSq2(x, y, pts[i][0], pts[i][1], pts[i + 1][0], pts[i + 1][1]);
      if (d2 > reach * reach) continue;
      var d = Math.sqrt(d2);
      if (d < best) best = d;
    }
  });
  return best;
}

function gridEntryCount(ctx) {
  var n = 0;
  ctx.grid.forEach(function(bucket) { n += bucket.length; });
  return n;
}

// deterministic PRNG so a failure is reproducible
function makeRandom(seed) {
  var s = seed;
  return function() {
    s = (s * 1103515245 + 12345) % 2147483648;
    return s / 2147483648;
  };
}

describe('mapshaper-buffer-voronoi.mjs segment grid', function () {

  describe('buildSegmentGrid()', function () {
    it('returns null without a positive reach', function () {
      var verts = makeVerts([
        {owner: 0, points: [[0, 0], [10, 0]]},
        {owner: 1, points: [[0, 1], [10, 1]]}
      ]);
      assert.strictEqual(buildSegmentGrid(verts, [0, 0]), null);
    });

    // A diagonal segment's bounding box covers (len/cell)^2 cells but the
    // segment itself crosses only about len/cell of them. Indexing the box is
    // what used to blow the index up on a large input with a small buffer
    // distance (~1e9 entries for a nationwide mosaic buffered at 1m).
    it('indexes a long diagonal segment in O(len/cell) cells', function () {
      var paths = [
        {owner: 0, points: [[0, 0], [1000, 1000]]},
        {owner: 1, points: [[0, 10], [1000, 1010]]}
      ];
      var dist = 0.5; // cell = 2 * dist = 1, so the diagonal spans ~1000 cells
      var ctx = buildSegmentGrid(makeVerts(paths), [dist, dist]);
      var entries = gridEntryCount(ctx);
      assert(entries < 6000, 'expected a few thousand entries, got ' + entries);
    });

    // The cell cannot shrink below the reach (that would break the 3x3 query
    // window), so a small buffer distance on a large extent is bounded by
    // widening the cell instead.
    it('bounds the index when the reach is tiny relative to the extent', function () {
      var random = makeRandom(11);
      var paths = [];
      for (var i = 0; i < 200; i++) {
        var pts = [];
        for (var k = 0; k < 20; k++) {
          pts.push([random() * 1e6, random() * 1e6]);
        }
        paths.push({owner: i % 2, points: pts});
      }
      var dist = 0.05; // reach 0.1 against a 1e6-wide extent
      var ctx = buildSegmentGrid(makeVerts(paths), [dist, dist]);
      var entries = gridEntryCount(ctx);
      // 3800 segments over a 1e6 extent: at cell = reach this would need ~1e10
      // entries. The insertion budget is 5e5; allow slack for the per-segment
      // minimum of one entry.
      assert(entries < 1e6, 'index bounded by the insertion budget, got ' + entries);
    });
  });

  describe('gapAtPoint()', function () {
    // The contract: the measured gap equals the true distance to the nearest
    // other-feature segment when that segment is within their combined reach,
    // and is Infinity when none is. Fuzzed against brute force, with long
    // diagonal segments and a reach far smaller than a segment, so every query
    // depends on the grid covering the cells its segments actually cross.
    // Query points are scattered around the boundary vertices, which is both
    // where the callers query and where in-reach pairs actually occur -- points
    // drawn from the whole extent are almost never within reach of anything.
    function fuzz(seed, dist, extent, segLen) {
      var random = makeRandom(seed);
      var paths = [];
      for (var i = 0; i < 40; i++) {
        var x = random() * extent;
        var y = random() * extent;
        var pts = [[x, y]];
        for (var k = 0; k < 5; k++) {
          x += (random() - 0.5) * segLen;
          y += (random() - 0.5) * segLen;
          pts.push([x, y]);
        }
        paths.push({owner: i % 2, points: pts});
      }
      var coordDistances = [dist, dist];
      var ctx = buildSegmentGrid(makeVerts(paths), coordDistances);
      var mismatches = 0, inReach = 0;
      for (var q = 0; q < 4000; q++) {
        var path = paths[Math.floor(random() * paths.length)];
        var vertex = path.points[Math.floor(random() * path.points.length)];
        var qx = vertex[0] + (random() - 0.5) * dist * 4;
        var qy = vertex[1] + (random() - 0.5) * dist * 4;
        var feat = q % 2;
        var got = gapAtPoint(ctx, qx, qy, feat, coordDistances[feat]);
        var want = bruteGap(paths, coordDistances, qx, qy, feat);
        if (isFinite(want)) inReach++;
        if (got !== want && Math.abs(got - want) > 1e-9) mismatches++;
      }
      return {mismatches: mismatches, inReach: inReach};
    }

    it('matches brute force when the cell equals the reach', function () {
      var res = fuzz(7, 20, 1000, 400);
      assert(res.inReach > 100, 'fuzz should find in-reach pairs, got ' + res.inReach);
      assert.equal(res.mismatches, 0);
    });

    it('matches brute force when the cell is widened by the budget', function () {
      var res = fuzz(23, 0.02, 1e6, 3e5);
      assert(res.inReach > 100, 'fuzz should find in-reach pairs, got ' + res.inReach);
      assert.equal(res.mismatches, 0);
    });
  });
});
