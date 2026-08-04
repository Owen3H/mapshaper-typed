
import api from '../mapshaper.js';
import assert from 'assert';

// This single case takes several seconds -- most of buffer-test.mjs's runtime --
// because it buffers a whole-country coastline. Mocha runs test FILES in
// parallel but the tests within a file serially, so it lives here instead of in
// buffer-test.mjs to keep it off that file's critical path.

describe('mapshaper-buffer.js fill-gaps on a large coastline', function () {

  // Regression for a whole-country coastline as ONE dense multipolygon. Two
  // things used to break at this scale:
  //  1. The mouth-gating closing erodes the dilated union by the mouth radius.
  //     Pre-simplifying (default 1% of the radius) before that inward offset
  //     self-intersected the ~20k-vertex continental ring, the dissolve kept
  //     the wrong side, and the ring collapsed -- so (closing - land) yielded
  //     almost no gap fills. The closing erode now disables pre-simplification.
  //  2. The coast/bridge classification scanned every source segment per fill
  //     edge (O(fill edges * source segments)); on 100k+ of each this took
  //     ~50s. It now uses a segment grid.
  // The fixture is the US coastline simplified to 50% of its vertices and
  // stored as quantized TopoJSON to keep it small; both the ring collapse and
  // the quadratic scan still reproduce at this resolution, but coarsening it
  // further (or quantizing below ~1e-4 degrees) stops the erode from folding
  // and the test silently loses its teeth.
  // Assert real fill happens (a collapsed closing fills only a fraction of
  // this), the extent is preserved, and no seam slivers form where the coast
  // pinches to a point.
  it('fills a large dense single-multipolygon coastline without collapsing or leaving seams', async function () {
    this.timeout(30000);
    var file = 'test/data/features/buffer/w_usa_polygon.json';
    var out = await api.applyCommands(
      '-i ' + file + ' -buffer 4km fill-gaps -dissolve2 -o format=geojson fill.json ' +
      '-i ' + file + ' -o format=geojson src.json');
    var fill = getOutputGeometries(out, 'fill.json');
    var src = getOutputGeometries(out, 'src.json');
    function netArea(geoms) {
      var s = 0;
      geoms.forEach(function(g) {
        getSignedRingAreas(g).forEach(function(a) { s += a; });
      });
      return Math.abs(s);
    }
    var srcArea = netArea(src), fillArea = netArea(fill);
    // Fill must be substantial: the fix adds ~5.0 sq-deg, a collapsed closing
    // added under ~2.8. Island suppression only drops true island bridges (a
    // small landmass forming much of a fill's shore), not deep inlets that
    // merely graze a mid-channel island, so nearly all of the genuine gap
    // fill is retained.
    assert(fillArea - srcArea > 3.3,
      'expected substantial gap fill (added=' + (fillArea - srcArea).toFixed(2) + ' sq-deg)');
    assert(fillArea / srcArea < 1.02,
      'fill should not grossly inflate the area (ratio=' + (fillArea / srcArea).toFixed(3) + ')');
    // No seam slivers between the source land and the gap fills, even where the
    // coastline pinches to a coincident vertex. A genuine open lake is orders of
    // magnitude larger than this (~1e-6 sq-deg ~= 8500 m^2).
    var tinyHoles = 0;
    fill.forEach(function(g) {
      getSignedRingAreas(g).forEach(function(a) {
        if (a < 0 && Math.abs(a) < 1e-6) tinyHoles++;
      });
    });
    assert.equal(tinyHoles, 0, 'no micro-gap seam holes at coastline pinch points');
  })

})

function getOutputGeometries(out, filename) {
  var json = JSON.parse(out[filename || 'buffer.json']);
  return json.features ?
    json.features.map(function(feat) { return feat.geometry; }) :
    json.geometries;
}

function getSignedRingAreas(geom) {
  var polys = geom.type == 'Polygon' ? [geom.coordinates] : geom.coordinates;
  return polys.reduce(function(memo, polygon) {
    polygon.forEach(function(ring) {
      memo.push(ringArea(ring));
    });
    return memo;
  }, []);
}

function ringArea(ring) {
  var sum = 0;
  for (var i=0; i<ring.length-1; i++) {
    sum += ring[i][0] * ring[i+1][1] - ring[i+1][0] * ring[i][1];
  }
  return sum / 2;
}
