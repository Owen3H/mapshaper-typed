import api from '../mapshaper.js';
import assert from 'assert';

function testInnerPoints(file, cmd, done) {
  var cmd = file + " " + cmd;
  api.internal.testCommands(cmd, function(err, data) {
    var polys = data.layers[0],
        points = data.layers[1];

    polys.shapes.forEach(function(shp, i) {
      var p = points.shapes[i][0];
      var isInside = api.geom.testPointInPolygon(p[0], p[1], shp, data.arcs);
      assert(isInside);
    });
    done();
  });
}


describe('mapshaper-anchor-points.js', function () {
  describe('inner points test', function () {

    var a = "-each 'cx=$.innerX, cy=$.innerY' -points x=cx y=cy +";
    var b = "-points inner +";
    it('file A', function(done) {
      testInnerPoints('test/data/features/centroids/a.shp', a, done);
    })
    it('file B', function(done) {
      testInnerPoints('test/data/features/centroids/b.shp', a, done);
    })
    it('file C', function(done) {
      testInnerPoints('test/data/shapefile/six_counties.shp', a, done);
    })
    it('file A v2', function(done) {
      testInnerPoints('test/data/features/centroids/a.shp', b, done);
    })
    it('file B v2', function(done) {
      testInnerPoints('test/data/features/centroids/b.shp', b, done);
    })
  })

  it('"-points inner" converts collapsed polygon to null geometry', function () {
    var shp = [[[0]]];
    var arcs = new api.internal.ArcCollection([[[0, 0], [0, 0], [0, 0], [0, 0]]]);
    var p = api.internal.findAnchorPoint(shp, arcs);
    assert.equal(p, null);
  })

  // A ring that runs out to a point and back along itself encloses no real
  // area, but its bounding box does, so it survives the collapsed-shape guard
  // and reaches the probing code. The coarse sweep finds a candidate there and
  // the refinement that follows finds none, which used to throw. This ring is
  // reduced from a tile produced by '-buffer 25m topological' on a county
  // mosaic, where the crash was first seen.
  it('"-points inner" handles a ring that encloses no area', function () {
    var arcs = new api.internal.ArcCollection([[
      [-118.78896251209346, 46.50151264974108],
      [-118.78864240246646, 46.50151092192038],
      [-118.7889625120934, 46.50151264974107],
      [-118.78896251209346, 46.50151264974108]
    ]]);
    var p = api.internal.findAnchorPoint([[0]], arcs);
    assert(p && isFinite(p.x) && isFinite(p.y), 'expected a point, got ' + JSON.stringify(p));
  })

  // The two shapes below used to make findAnchorPoint's vertical scan run
  // forever, or near enough. Both are ordinary rings -- no self-intersections,
  // nothing for -clean to fix -- so a hang here is reachable from "-points
  // inner" on a single feature, not just from the buffer mosaic that found it.
  it('"-points inner" terminates on a ring narrower than its own float precision', function () {
    // 20nm x 120nm at longitude -119: the probe band around the candidate point
    // rounds to zero width, so the scan's step cannot move the point at all.
    // Taken from a buffer mosaic tile that hung the process indefinitely.
    var arcs = new api.internal.ArcCollection([[
      [-119.16180153376683, 46.243339704341665],
      [-119.16180153376703, 46.243339704341665],
      [-119.16180153376699, 46.24333970434274],
      [-119.16180153376692, 46.24333970434273],
      [-119.16180153376683, 46.243339704341665]
    ]]);
    var p = api.internal.findAnchorPoint([[0]], arcs);
    assert(p && isFinite(p.x) && isFinite(p.y), 'expected a point, got ' + JSON.stringify(p));
  })

  it('"-points inner" terminates on an extremely high aspect ratio sliver', function () {
    // ~1cm wide by ~111km long. The scan walks its chord in steps proportional
    // to the width, so the steps needed grow with the aspect ratio: this shape
    // took over 45 seconds before the step ceiling, and about 30ms after.
    var w = 1e-7, h = 1, x = -119.16, y = 46;
    var arcs = new api.internal.ArcCollection([[
      [x, y], [x, y + h], [x + w, y + h], [x + w, y], [x, y]
    ]]);
    var shape = [[0]];
    var start = Date.now();
    var p = api.internal.findAnchorPoint(shape, arcs);
    var elapsed = Date.now() - start;
    assert(p && isFinite(p.x) && isFinite(p.y), 'expected a point, got ' + JSON.stringify(p));
    assert(api.geom.testPointInPolygon(p.x, p.y, shape, arcs),
      'anchor point fell outside the sliver');
    assert(elapsed < 1000, 'took ' + elapsed + 'ms, expected the scan to be bounded');
  })

  it('"-points inner" finds center of a rectangle', function () {
    var shape = [[0]];
    var arcs = new api.internal.ArcCollection([[[0, 0], [0, 1], [2, 1], [2, 0], [0, 0]]]);
    var p = api.internal.findAnchorPoint(shape, arcs);
    assert.equal(p.x, 1);
    assert.equal(p.y, 0.5);
  })

})
