import assert from 'assert';
import {
  densifyVertices,
  hasContestedGap,
  spacingFromGap,
  buildSegmentGrid
} from '../src/buffer/mapshaper-buffer-voronoi';

// densifyVertices used to sample open coastline at spacing = buffer distance,
// emitting tens of millions of sites on a nationwide mosaic that keptSites then
// discarded. These tests pin the two guards that stop that: spacingFromGap
// returns Infinity for open coast (so densify emits no interior points), and
// hasContestedGap is false when every vertex is open or touching (so collectSites
// skips densify/Delaunay entirely).

function makeVerts(paths) {
  var count = 0;
  var layout = paths.map(function(path) {
    var vids = path.points.map(function() { return count++; });
    return {owner: path.owner, points: path.points, vids: vids};
  });
  return {paths: layout, count: count};
}

describe('mapshaper-buffer-voronoi.mjs densify guards', function () {

  describe('spacingFromGap()', function () {
    it('returns Infinity for open coast so densify skips interior points', function () {
      assert.strictEqual(spacingFromGap(Infinity, 10, 1, 1), Infinity);
      assert.strictEqual(spacingFromGap(NaN, 10, 1, 1), Infinity);
    });

    it('returns the buffer distance for a touching gap', function () {
      // TOUCHING_GAP_FRACTION = 0.002, so gap < 0.02 is touching at maxSpacing=10
      assert.equal(spacingFromGap(0.01, 10, 1, 1), 10);
    });

    it('returns gap * GAP_FACTOR for a real contested gap', function () {
      // GAP_FACTOR = 0.5
      assert.equal(spacingFromGap(4, 10, 0.1, 1), 2);
    });
  });

  describe('hasContestedGap()', function () {
    it('is false when every gap is open or touching', function () {
      assert.equal(hasContestedGap([Infinity, Infinity], 10), false);
      // touching threshold = 10 * 0.002 = 0.02
      assert.equal(hasContestedGap([0.01, Infinity, 0], 10), false);
    });

    it('is true when any gap is finite and above the touching threshold', function () {
      assert.equal(hasContestedGap([Infinity, 1, Infinity], 10), true);
      assert.equal(hasContestedGap([0.1], 10), true);
    });
  });

  describe('densifyVertices()', function () {
    it('does not densify open-coast segments', function () {
      // two long parallel coasts, all gaps Infinity -- previously densified at
      // spacing = maxSpacing into len/maxSpacing interior points per segment
      var verts = makeVerts([
        {owner: 0, points: [[0, 0], [1000, 0], [2000, 0]]},
        {owner: 1, points: [[0, 100], [1000, 100], [2000, 100]]}
      ]);
      var gaps = [Infinity, Infinity, Infinity, Infinity, Infinity, Infinity];
      var sites = densifyVertices(verts, gaps, [10, 10], 1, 1);
      assert.equal(sites.coords.length, verts.count,
        'open coast emits original vertices only, got ' + sites.coords.length);
    });

    it('still densifies a contested channel', function () {
      // a narrow gap of width 4 between two banks: spacing = 4 * 0.5 = 2
      var verts = makeVerts([
        {owner: 0, points: [[0, 0], [100, 0]]},
        {owner: 1, points: [[0, 4], [100, 4]]}
      ]);
      var gaps = [4, 4, 4, 4];
      var sites = densifyVertices(verts, gaps, [10, 10], 0.1, 1);
      // each 100-long bank: floor(100/2) = 50 interior points, plus 2 endpoints
      // -> 52 per bank, 104 total
      assert.equal(sites.coords.length, 104);
    });

    it('densifies into an open mouth from a contested endpoint', function () {
      // bank pinches: first vertex contested (gap 4), second open (Infinity).
      // segmentSpacing takes min(spacing(4), Infinity) = 2, so the segment that
      // opens onto the coast is still sampled.
      var verts = makeVerts([
        {owner: 0, points: [[0, 0], [100, 0]]},
        {owner: 1, points: [[0, 4], [100, 100]]}
      ]);
      var gaps = [4, Infinity, 4, Infinity];
      var sites = densifyVertices(verts, gaps, [10, 10], 0.1, 1);
      assert(sites.coords.length > verts.count,
        'contested-to-open segment should densify, got ' + sites.coords.length);
    });

    it('midpoint-probes a long open edge that hides a contested channel', function () {
      // Facing edges 150 apart; buffer reach per feature is 250 so combined
      // reach is 500. The tall edge's endpoints are >500 from the short square,
      // so both endpoint gaps are Infinity -- without the midpoint probe this
      // edge would not densify and the medial partition would be missing one bank
      // (the unequal-squares topological buffer fixture).
      var paths = [
        {owner: 0, points: [[1000, 1000], [2000, 1000], [2000, 2000], [1000, 2000], [1000, 1000]]},
        {owner: 1, points: [[2150, 500], [4150, 500], [4150, 2500], [2150, 2500], [2150, 500]]}
      ];
      var verts = makeVerts(paths);
      var dist = [250, 250];
      var ctx = buildSegmentGrid(verts, dist);
      var gaps = [];
      for (var i = 0; i < verts.count; i++) gaps[i] = Infinity;
      // mark the short square's facing-edge endpoints as contested (as
      // computeVertexGaps would); leave the tall edge's endpoints open
      // vids: path0 has 5 points (0..4), path1 has 5 points (5..9).
      // path0 right edge is vids 1..2 at (2000,1000)/(2000,2000).
      gaps[1] = 150; gaps[2] = 150;
      var sites = densifyVertices(verts, gaps, dist, 1, 1, ctx);
      // the tall left edge is vids 8..9 from (2150,2500) to (2150,500), length
      // 2000; midpoint probe finds gap 150 -> spacing 75 -> many interior sites
      assert(sites.coords.length > verts.count + 10,
        'long open facing edge should densify via midpoint, got ' + sites.coords.length);
    });
  });
});
