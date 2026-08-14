import assert from 'assert';
import {
  buildSegmentGrid,
  recenterMedialChain
} from '../src/buffer/mapshaper-buffer-voronoi';

// A sampled Voronoi cannot resolve a channel that narrows past the site spacing:
// the triangles spanning the neck are slivers whose circumcenters land on, or
// past, one bank, so the assembled medial chain zigzags between the two sides
// instead of running down the middle. recenterMedialChain corrects that after the
// fact, by measuring each vertex against the source segments themselves.
//
// Fixtures below are channels between two features. Source rings are traversed
// with the polygon interior on their right, which is what tells the centering
// pass which side of a bank is inside a polygon, so a bank whose polygon lies
// above it runs in -x and one whose polygon lies below runs in +x.

function makeVerts(paths) {
  var count = 0;
  var layout = paths.map(function(path) {
    var vids = path.points.map(function() { return count++; });
    return {
      owner: path.owner,
      points: path.points,
      vids: vids,
      forward: path.forward !== false
    };
  });
  return {paths: layout, count: count};
}

// banks at y = 0 (polygon below) and y = @top (polygon above)
function parallelChannel(top, reach) {
  var verts = makeVerts([
    {owner: 0, points: [[0, 0], [100, 0]]},
    {owner: 1, points: [[100, top], [0, top]]}
  ]);
  return buildSegmentGrid(verts, [reach, reach]);
}

// same, but the upper bank dips to y = @neck at x = 50
function pinchedChannel(top, neck, reach) {
  var verts = makeVerts([
    {owner: 0, points: [[0, 0], [100, 0]]},
    {owner: 1, points: [[100, top], [75, top], [50, neck], [25, top], [0, top]]}
  ]);
  return buildSegmentGrid(verts, [reach, reach]);
}

describe('mapshaper-buffer-voronoi.mjs medial centering', function () {

  describe('recenterMedialChain()', function () {
    it('leaves a centered chain untouched', function () {
      var ctx = parallelChannel(2, 5);
      var chain = [[10, 1], [30, 1], [50, 1], [70, 1]];
      assert.deepStrictEqual(recenterMedialChain(chain, ctx), chain);
    });

    it('lifts a vertex that sits on a bank back to the centerline', function () {
      var ctx = parallelChannel(2, 5);
      var out = recenterMedialChain([[10, 1], [50, 0.02], [90, 1]], ctx);
      assert.equal(out.length, 3);
      assert(Math.abs(out[1][1] - 1) < 1e-9,
        'expected the middle vertex at the channel center, got ' + out[1][1]);
    });

    // The zigzag's worst form: the vertex is not merely off-center but has
    // crossed a bank into the polygon behind it. Its distance ratio alone looks
    // like a legitimately off-center point, so this depends on the interior-side
    // test rather than on distance.
    it('pulls a vertex that crossed into a polygon back into the channel', function () {
      var ctx = parallelChannel(2, 5);
      var out = recenterMedialChain([[10, 1], [50, -0.5], [90, 1]], ctx);
      assert(Math.abs(out[1][1] - 1) < 1e-9,
        'expected the middle vertex back at the center, got ' + out[1][1]);
    });

    it('runs a corrected vertex through the neck of a pinch', function () {
      var ctx = pinchedChannel(2, 0.2, 5);
      var out = recenterMedialChain([[10, 1], [50, 1.6], [90, 1]], ctx);
      // At x = 50 the channel spans y = 0 to y = 0.2. The correction lands
      // between the two footpoints, which is inside that neck (the footpoint on
      // the V-shaped bank sits slightly up its slope, so not exactly at y = 0.1).
      assert(out[1][1] > 0.05 && out[1][1] < 0.15,
        'expected the vertex within the neck, got ' + out[1][1]);
    });

    // Endpoints are extended past the source boundary on purpose, so that a
    // medial chain nodes against the boundary of the region it divides.
    it('preserves the chain endpoints', function () {
      var ctx = parallelChannel(2, 5);
      var chain = [[10, -3], [50, 1], [90, 5]];
      var out = recenterMedialChain(chain, ctx);
      assert.deepStrictEqual(out[0], chain[0]);
      assert.deepStrictEqual(out[out.length - 1], chain[chain.length - 1]);
    });

    // A chain trails past the mouth of a gap into ground where the banks have
    // converged, and there is no channel left to center it in. The run is
    // collapsed to a straight segment: the chain keeps its reach (it still has to
    // poke out past the gap to node against the enclosing boundary) and loses
    // only its wandering.
    it('straightens a wandering tail without shortening the chain', function () {
      var ctx = parallelChannel(2, 5);
      var tail = [[95, -1], [97, -3], [99, -2], [101, -4]];
      var chain = [[10, 1], [50, 1], [90, 1]].concat(tail);
      var out = recenterMedialChain(chain, ctx);
      assert.deepStrictEqual(out[out.length - 1], [101, -4],
        'the far end of the tail should be kept');
      assert.equal(out.length, 4,
        'the tail should collapse to one segment, got ' + JSON.stringify(out));
    });

    // Past the mouth of a gap the nearest other feature can be arbitrarily far
    // away; those two banks are not a channel, and their footpoint midpoint would
    // be nowhere near either of them.
    it('ignores an opposite bank beyond the buffer reach', function () {
      var ctx = parallelChannel(200, 5); // banks 200 apart, combined reach 10
      var chain = [[10, 1], [50, 1], [90, 1]];
      assert.deepStrictEqual(recenterMedialChain(chain, ctx), chain);
    });

    it('returns short chains unchanged', function () {
      var ctx = parallelChannel(2, 5);
      var chain = [[10, -1], [90, 3]];
      assert.deepStrictEqual(recenterMedialChain(chain, ctx), chain);
    });
  });
});
