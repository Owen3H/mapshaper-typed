import assert from 'assert';
import {
  buildSegmentGrid,
  gapAtPoint
} from '../src/buffer/mapshaper-buffer-voronoi';
import { pointSegDistSq2 } from '../src/geom/mapshaper-basic-geom';

// The medial construction answers "how far is the nearest segment of another
// feature, within reach?" from two indexes over the same segments: a uniform
// grid scanned over the query point's 3x3 cell neighborhood, and an R-tree
// searched over a widening box. Which one runs is a speed decision, so these
// tests check both against brute force, check that the grid stays bounded when
// the buffer distance is much smaller than a boundary segment (the case that
// used to exceed the maximum Map size), and pin the cost against the buffer
// distance (the axis the grid alone scaled quadratically on).

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

// Segments in the 3x3 cell window around a point -- what gapAtPoint weighs when
// deciding whether to scan the window or ask the tree.
function windowLoad(ctx, x, y) {
  var cx = ctx.colOf(x), cy = ctx.rowOf(y), n = 0;
  for (var gx = cx - 1; gx <= cx + 1; gx++) {
    for (var gy = cy - 1; gy <= cy + 1; gy++) {
      var bucket = ctx.grid.get(ctx.cellKey(gx, gy));
      if (bucket) n += bucket.length;
    }
  }
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

    // The two fuzz cases above stay under the window-scan threshold, so they
    // only exercise the grid. This one packs enough segments around each query
    // point to send it to the R-tree instead, which has to agree exactly: the
    // index is chosen for speed alone and may never change the answer.
    it('matches brute force on a crowded neighborhood, where the tree answers', function () {
      var random = makeRandom(101);
      var paths = [];
      var coordDistances = [];
      // 200 features x 60 segments in a 400-unit extent, with a reach wide
      // enough that a query's cell window holds thousands of them.
      for (var i = 0; i < 200; i++) {
        var x = random() * 400;
        var y = random() * 400;
        var pts = [[x, y]];
        for (var k = 0; k < 60; k++) {
          x += (random() - 0.5) * 12;
          y += (random() - 0.5) * 12;
          pts.push([x, y]);
        }
        paths.push({owner: i, points: pts});
        coordDistances.push(40);
      }
      var ctx = buildSegmentGrid(makeVerts(paths), coordDistances);
      assert(windowLoad(ctx, 200, 200) > 3000,
        'test needs a crowded window to reach the tree, got ' + windowLoad(ctx, 200, 200));
      var mismatches = 0, inReach = 0;
      for (var q = 0; q < 600; q++) {
        var path = paths[Math.floor(random() * paths.length)];
        var vertex = path.points[Math.floor(random() * path.points.length)];
        var qx = vertex[0] + (random() - 0.5) * 80;
        var qy = vertex[1] + (random() - 0.5) * 80;
        var feat = path.owner;
        var got = gapAtPoint(ctx, qx, qy, feat, coordDistances[feat]);
        var want = bruteGap(paths, coordDistances, qx, qy, feat);
        if (isFinite(want)) inReach++;
        if (got !== want && Math.abs(got - want) > 1e-9) mismatches++;
      }
      assert(inReach > 300, 'fuzz should find in-reach pairs, got ' + inReach);
      assert.equal(mismatches, 0);
    });

    // Cost axis. The query used to scan the whole 3x3 cell window, and the cell
    // is floored at the reach, so widening the buffer distance grew the work
    // per query as the square of the distance -- on a county mosaic that turned
    // a 4-second command into one that ran for a quarter of an hour. The bound
    // here is loose (the answer set genuinely does grow with the reach, just
    // not quadratically) but the old behavior overshoots it by an order of
    // magnitude: measured on this input, a 16x wider reach cost 79x more before
    // and 5x more after.
    it('query cost does not grow quadratically with the buffer distance', function () {
      this.timeout(20000);
      var random = makeRandom(5);
      var paths = [];
      for (var i = 0; i < 400; i++) {
        var x = random() * 1000;
        var y = random() * 1000;
        var pts = [[x, y]];
        for (var k = 0; k < 100; k++) {
          x += (random() - 0.5) * 8;
          y += (random() - 0.5) * 8;
          pts.push([x, y]);
        }
        paths.push({owner: i, points: pts});
      }
      var verts = makeVerts(paths);
      var queries = [];
      for (var q = 0; q < 20000; q++) {
        var path = paths[Math.floor(random() * paths.length)];
        var vertex = path.points[Math.floor(random() * path.points.length)];
        queries.push([vertex[0] + (random() - 0.5) * 20, vertex[1] + (random() - 0.5) * 20,
          path.owner]);
      }
      function timeQueries(dist) {
        var coordDistances = [];
        for (var f = 0; f < paths.length; f++) coordDistances.push(dist);
        var ctx = buildSegmentGrid(verts, coordDistances);
        var t = Date.now();
        for (var j = 0; j < queries.length; j++) {
          gapAtPoint(ctx, queries[j][0], queries[j][1], queries[j][2], dist);
        }
        return Date.now() - t;
      }
      var narrow = Math.max(timeQueries(16), 20); // floor keeps the ratio stable
      var wide = timeQueries(256);
      assert(wide < narrow * 20,
        'a 16x reach cost ' + (wide / narrow).toFixed(1) + 'x (' + narrow + 'ms -> ' + wide + 'ms)');
    });
  });
});
