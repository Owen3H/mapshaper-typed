import assert from 'assert';
import fs from 'fs';
import api from '../mapshaper.js';
var ArcCollection = api.internal.ArcCollection;

function featureRings(feature) {
  var g = feature.geometry;
  var polygons = g.type == 'Polygon' ? [g.coordinates] : g.coordinates;
  var rings = [];
  polygons.forEach(function(poly) {
    poly.forEach(function(ring) { rings.push(ring); });
  });
  return rings;
}

function distToRings(px, py, rings) {
  var min = Infinity;
  rings.forEach(function(ring) {
    for (var i = 1; i < ring.length; i++) {
      var d = api.geom.pointSegDistSq(px, py, ring[i - 1][0], ring[i - 1][1],
        ring[i][0], ring[i][1]);
      if (d < min) min = d;
    }
  });
  return Math.sqrt(min);
}

function clean(shapes, arcs) {
  var dataset = {
    arcs: arcs,
    layers: [{
      geometry_type: 'polygon',
      shapes: shapes
    }]
  };
  api.cmd.cleanLayers(dataset.layers, dataset, {no_arc_dissolve: true});
  return dataset.layers[0].shapes;
}

function cleanArcs(dataset) {
  api.cmd.cleanLayers(dataset.layers, dataset, {arcs: true});
}

describe('mapshaper-clean.js', function () {

  describe('clean polylines', function () {
    it('contiguous parts are combined', function(done) {
      var data = {
        type: 'MultiLineString',
        coordinates: [[[0,0], [1,0]], [[3,0], [2,0]], [[2,0], [1,0]]]
      };
      var cmd = '-i data.json -clean -o';
      api.applyCommands(cmd, {'data.json': data}, function(err, out) {
        var json = JSON.parse(out['data.json']);
        var obj = json.geometries[0];
        assert.equal(obj.type, 'LineString');
        assert.deepEqual(obj.coordinates, [[0,0], [1,0], [2,0], [3,0]]);
        done();
      });
    })

    it('duplicate arcs are uniqified', function(done) {
      var data = {
        type: 'MultiLineString',
        coordinates: [[[0,0], [1,0]], [[1,0], [1,1]], [[1,1], [1,0]]]
      };
      var cmd = '-i data.json -clean -o';
      api.applyCommands(cmd, {'data.json': data}, function(err, out) {
        var json = JSON.parse(out['data.json']);
        var obj = json.geometries[0];
        assert.deepEqual(obj, {
          type: 'LineString',
          coordinates: [[0,0], [1,0], [1,1]]
        })
        done();
      });
    })

    it('feature is split at node', function (done) {
      // UPDATE: now, spikes like this are removed, even from line layers...
      //
      // // current behavior retains a doubled-back spike
      // TODO: remove one of the duplicate segments
      var data = {
        type: 'LineString',
        coordinates: [[0,0], [1,0], [1,1], [1,0], [2,0]]
      };
      var cmd = '-i data.json -clean -o';
      api.applyCommands(cmd, {'data.json': data}, function(err, out) {
        var json = JSON.parse(out['data.json']);
        var obj = json.geometries[0];
        // assert.equal(obj.type, 'MultiLineString');
        // assert.equal(obj.coordinates.length, 3);
        // assert.deepEqual(obj.coordinates[0], [[0,0], [1,0]]);
        assert.equal(obj.type, 'LineString');
        assert.deepEqual(obj.coordinates, [[0,0], [1,0], [2,0]]);
        done();
      });
    })
  })

  describe('Tests based on sample datasets (real-world and made up)', function () {
    it('clean/ex3.json -- all polygons are retained', function (done) {
      var cmd = '-i test/data/features/clean/ex3.json -clean -o clean.json';
      api.applyCommands(cmd, {}, function(err, out) {
        var json = JSON.parse(out['clean.json']);
        assert.equal(json.geometries.length, 3);
        done();
      });
    })

    it('clean/ex9_FranklinTwoPrecinctsDetail.json -- all polygons are retained', function (done) {
      var cmd = '-i test/data/features/clean/ex9_FranklinTwoPrecinctsDetail.json -clean -o clean.json';
      api.applyCommands(cmd, {}, function(err, out) {
        var json = JSON.parse(out['clean.json']);
        assert.equal(json.features.length, 2);
        done();
      });
    })

    it('clean/ex8_britain.json -- all polygons are retained', function (done) {
      var cmd = '-i test/data/features/clean/ex8_britain.json -clean -o clean.json';
      api.applyCommands(cmd, {}, function(err, out) {
        var json = JSON.parse(out['clean.json']);
        assert.equal(json.features.length, 12);
        done();
      });
    })

    it('clean/ex7_britain.json -- all polygons are retained', function (done) {
      var cmd = '-i test/data/features/clean/ex7_britain.json -clean -o clean.json';
      api.applyCommands(cmd, {}, function(err, out) {
        var json = JSON.parse(out['clean.json']);
        assert.equal(json.features.length, 3);
        done();
      });
    })

    it('clean/ex5_three_precincts.json -- all polygons are retained', function (done) {
      var cmd = '-i test/data/features/clean/ex5_three_precincts.json -clean -o clean.json';
      api.applyCommands(cmd, {}, function(err, out) {
        var json = JSON.parse(out['clean.json']);
        assert.equal(json.features.length, 3);
        done();
      });
    })

    it('clean/ex1_yemen.json -- all polygons are retained', function (done) {
      var cmd = '-i test/data/features/clean/ex1_yemen.json -clean -o clean.json';
      api.applyCommands(cmd, {}, function(err, out) {
        var json = JSON.parse(out['clean.json']);
        assert.equal(json.features.length, 2);
        done();
      });
    })

    it('clean/ex2_yemen.json -- all polygons are retained', function (done) {
      var cmd = '-i test/data/features/clean/ex2_yemen.json -clean -o clean.json';
      api.applyCommands(cmd, {}, function(err, out) {
        var json = JSON.parse(out['clean.json']);
        assert.equal(json.features.length, 3);
        done();
      });
    })

    // TODO: explode creates 4 features, one of which is a sliver --
    // investigate why the sliver is not removed
    it('clean/ex5_three_precincts.json', async function() {
      var cmd = '-i test/data/features/clean/ex5_three_precincts.json -clean -o clean.json';
      var out = await api.applyCommands(cmd);
      var json = JSON.parse(out['clean.json']);
      assert.equal(json.features.length, 3);
    })

    it('clean/ex22_three_ia_precincts.json', async function() {
      var cmd = '-i test/data/features/clean/ex22_three_ia_precincts.json -clean -o clean.json';
      var out = await api.applyCommands(cmd);
      var json = JSON.parse(out['clean.json']);
      assert.equal(json.features.length, 3);
    })

    it('clean/ex23_three_ca_precincts.json', async function() {
      var cmd = '-i test/data/features/clean/ex23_three_ca_precincts.json -clean -each "area = this.area" -o clean.json';
      var out = await api.applyCommands(cmd);
      var json = JSON.parse(out['clean.json']);
      assert.equal(json.features.length, 3);
      var area1 = json.features[1].properties.area;
      var area2 = json.features[2].properties.area;
      assert(area1 > 60000000);
      assert(area2 > 25000000)
    })

    describe('close-outer-gaps option', function() {
      var ex25 = 'test/data/features/clean/ex25_slice_in_polygon.json';
      var ex26 = 'test/data/features/clean/ex26_external_gap_between_polygons.json';
      var ex24 = 'test/data/features/clean/ex24_three_state_internal_gap.json';
      var ex27 = 'test/data/features/clean/ex27_staggered_external_gap.json';

      function getEasternTips(json) {
        return json.features.map(function(f) {
          var coords = f.geometry.type == 'Polygon' ?
            f.geometry.coordinates : f.geometry.coordinates.flat();
          var best = null;
          coords.forEach(function(ring) {
            ring.forEach(function(p) {
              if (p[0] < -75.868 || p[0] > -75.865 ||
                  p[1] < 36.5503 || p[1] > 36.5506) return;
              if (!best || p[0] > best[0]) best = p;
            });
          });
          return best;
        });
      }

      // Every distinct x coordinate along the crack, across all features.
      function getSeamXCoords(json) {
        var xs = {};
        json.features.forEach(function(f) {
          f.geometry.coordinates.flat().forEach(function(p) {
            if (p[0] > 4.9 && p[0] < 5.1) xs[p[0]] = true;
          });
        });
        return Object.keys(xs).map(parseFloat).sort();
      }

      // A crack that opens onto the space outside the mosaic is not enclosed by
      // polygons, so no tile covers it and gap filling cannot reach it. Pinching
      // its mouths shut encloses it, and the filling that follows awards it to one
      // of its neighbors: one bank becomes the boundary between them, and the
      // other is gone.
      it('closes a crack that opens to the outside', async function() {
        var plain = await api.applyCommands('-i ' + ex27 + ' -clean -o out.json');
        assert.deepEqual(getSeamXCoords(JSON.parse(String(plain['out.json']))),
          [4.9985, 5.0015], 'without the flag both banks should survive');

        var out = await api.applyCommands(
          '-i ' + ex27 + ' -clean close-outer-gaps gap-width=500m -o out.json');
        var banks = getSeamXCoords(JSON.parse(String(out['out.json'])));
        assert(banks.indexOf(5.0015) == -1,
          'the east bank should be gone, got ' + banks.join(' '));
        assert(banks.indexOf(4.9985) > -1,
          'the west bank should be untouched, got ' + banks.join(' '));
        // Only the mouths move, to the midpoint of the pair pinched together.
        assert.deepEqual(banks, [4.9985, 5]);
      })

      it('respects an explicit gap-width', async function() {
        var out = await api.applyCommands(
          '-i ' + ex27 + ' -clean close-outer-gaps gap-width=100m -o out.json');
        assert.deepEqual(getSeamXCoords(JSON.parse(String(out['out.json']))),
          [4.9985, 5.0015], 'a 100m limit should leave the ~333m crack open');

        out = await api.applyCommands(
          '-i ' + ex27 + ' -clean close-outer-gaps gap-width=500m -o out.json');
        assert.deepEqual(getSeamXCoords(JSON.parse(String(out['out.json']))),
          [4.9985, 5]);
      })

      // Two features whose shared boundary coincides for 100km, but whose eastern
      // ends stop 3mm short of each other. The boundary is merged without being
      // asked, and what is left is a near-touch rather than a crack: two edges
      // that diverge immediately into the width of the features they bound.
      it('leaves a near-touch at the edge of the mosaic alone', async function() {
        var plain = await api.applyCommands('-i ' + ex26 + ' -clean -o out.json');
        var tips = getEasternTips(JSON.parse(String(plain['out.json'])));
        var apart = api.geom.greatCircleDistance(tips[0][0], tips[0][1],
          tips[1][0], tips[1][1]);
        assert(apart < 0.005, 'the tips are millimeters apart, got ' + apart);

        var out = await api.applyCommands(
          '-i ' + ex26 + ' -clean close-outer-gaps gap-width=1m -o out.json');
        assert.equal(String(out['out.json']), String(plain['out.json']),
          'a near-touch this short is not a crack to close');
      })

      // What the flag must not do is change how an interior gap is handled: those
      // are enclosed, so gap filling reaches them whether or not this pass runs.
      it('leaves interior gaps to gap filling', async function() {
        var input = '-i ' + ex24 + ' -clean gap-width=250m';
        var plain = await api.applyCommands(input + ' -o out.json');
        var flagged = await api.applyCommands(
          input + ' close-outer-gaps -o out.json');
        assert(String(plain['out.json']).length > 0);
        assert.equal(String(flagged['out.json']), String(plain['out.json']),
          'interior geometry should be byte-identical');
      })

      // A channel between two features that runs right through the coverage opens
      // to the outside at both of its ends, so sealing one leaves it open at the
      // other. Dissolving the pair tells us whether anything is left between them.
      it('closes a channel that is open at both ends', async function() {
        var west = [], east = [];
        for (var i = 0; i <= 20; i++) {
          west.push([5, i * 0.5]);
          east.push([5.02, i * 0.5]);
        }
        var input = {'in.json': JSON.stringify({
          type: 'FeatureCollection',
          features: [{
            type: 'Feature', properties: {name: 'A'},
            geometry: {type: 'Polygon',
              coordinates: [[[0, 0]].concat(west, [[0, 10], [0, 0]])]}
          }, {
            type: 'Feature', properties: {name: 'B'},
            geometry: {type: 'Polygon',
              coordinates: [[[10, 0]].concat(east.slice().reverse(),
                [[10, 10], [10, 0]])]}
          }]
        })};
        var plain = await api.applyCommands(
          '-i in.json -clean gap-width=3km -dissolve -o out.json', input);
        assert.equal(JSON.parse(String(plain['out.json'])).geometries[0].type,
          'MultiPolygon',
          'the channel is not enclosed, so filling cannot reach it');

        var out = await api.applyCommands(
          '-i in.json -clean close-outer-gaps gap-width=3km -dissolve -o out.json',
          input);
        var dissolved = JSON.parse(String(out['out.json'])).geometries[0];
        assert.equal(dissolved.type, 'Polygon',
          'both mouths pinched shut, the channel becomes a gap and is filled');
        assert.equal(dissolved.coordinates.length, 1, 'and nothing is left of it');
      })

      it('does not close a cut within one polygon', async function() {
        var normal = await api.applyCommands('-i ' + ex25 + ' -clean -o out.json');
        var closing = await api.applyCommands(
          '-i ' + ex25 + ' -clean close-outer-gaps -o out.json');
        assert.equal(String(closing['out.json']), String(normal['out.json']),
          'single-feature geometry should be byte-identical');
      })

      // Facing edges stay within tolerance for a sustained length, but vertices on
      // either bank are staggered, so no pairing of vertices can find them. The
      // crack above is detected all the same; a short near-miss elsewhere in the
      // same fixture must not be.
      it('leaves a short near-miss between two features open', async function() {
        var out = await api.applyCommands(
          '-i ' + ex27 +
          ' -clean close-outer-gaps gap-width=500m -o out.json');
        var json = JSON.parse(String(out['out.json']));
        var distant = json.features.find(function(f) {
          return f.properties.name == 'distant';
        });
        var neighbor = json.features.find(function(f) {
          return f.properties.name == 'distant_neighbor';
        });
        var dRight = Math.max.apply(null, distant.geometry.coordinates[0].map(
          function(p) { return p[0]; }));
        var nLeft = Math.min.apply(null, neighbor.geometry.coordinates[0].map(
          function(p) { return p[0]; }));
        assert(nLeft - dRight > 0.002,
          'short distant near-miss should remain open');
      })

      // Two features whose facing boundaries are the same line digitized twice,
      // @n vertices each, a crack @width degrees apart. Detail like this arrives
      // as a single long arc, and every facing pair of vertices along it is a
      // mouth seed, so the pair is the shape that costs the seam walk most: the
      // county mosaics above are the same thing in miniature, a few vertices per
      // arc at a time.
      function longDuplicateBoundary(n, width) {
        var west = [], east = [];
        for (var i = 0; i <= n; i++) {
          var y = 46 + i * 9e-6;
          var wiggle = Math.sin(i / 7) * 3e-6;
          west.push([-119 + wiggle, y]);
          // staggered, so no pairing of vertices can be found by snapping
          east.push([-119 + width + Math.sin((i + 0.5) / 7) * 3e-6, y + 4.5e-6]);
        }
        // each feature runs up its side of the crack and back round the outside
        function feature(name, side, outerX) {
          var ring = side.concat([
            [outerX, side[side.length - 1][1]],
            [outerX, side[0][1]],
            side[0]
          ]);
          return {
            type: 'Feature',
            properties: {name: name},
            geometry: {type: 'Polygon', coordinates: [ring]}
          };
        }
        return {
          type: 'FeatureCollection',
          features: [
            feature('west', west, -119.01),
            feature('east', east, -118.99)
          ]
        };
      }

      // Every seed along a crack grows into the same run of the same two arcs, so
      // walking that run once per seed rather than once, and scanning a whole arc
      // per vertex test rather than the segments near it, each cost this pair the
      // product of its own detail twice over. At the size below either one on its
      // own takes over ten seconds, and together they never finished.
      it('close-outer-gaps stays fast on a long detailed crack', async function() {
        this.timeout(30000);
        var input = {
          'in.json': JSON.stringify(longDuplicateBoundary(20000, 4.5e-6))
        };
        var t0 = Date.now();
        var out = await api.applyCommands(
          '-i in.json -clean close-outer-gaps gap-width=1m -dissolve -o out.json',
          input);
        var ms = Date.now() - t0;
        // dissolving away the only attribute leaves bare geometry
        var dissolved = JSON.parse(String(out['out.json'])).geometries[0];
        assert.equal(dissolved.type, 'Polygon',
          'the crack should be closed, leaving one ring');
        assert.equal(dissolved.coordinates.length, 1, 'and no hole behind it');
        assert(ms < 3000, 'closing a long crack should stay under 3s, took ' +
          ms + 'ms');
      })

      // Guards against a quadratic seam walk: before the staggered-edge change,
      // this national mosaic finished in ~0.7s. A generous 3s bound fails CI on a
      // clear regression without being flaky on ordinary machines.
      it('close-outer-gaps stays fast on a national mosaic', async function() {
        this.timeout(10000);
        var file = 'test/data/features/buffer/__big/01_thin_gap_polygons.json';
        if (!fs.existsSync(file)) this.skip();
        var t0 = Date.now();
        await api.applyCommands('-i ' + file + ' -clean close-outer-gaps -o out.json');
        var ms = Date.now() - t0;
        assert(ms < 3000,
          'close-outer-gaps on the national mosaic should stay under 3s, took ' + ms + 'ms');
      })
    })

    // A boundary shared by two features, but digitized or computed twice, leaves
    // a slit far too narrow to see. Filling it as a gap awards it to one feature,
    // which then carries a zero-width spike along a border it shares with others
    // -- visible as a stray line as soon as that feature is stroked. -clean
    // collapses these seams without being asked, unlike the wider cracks that
    // close-outer-gaps handles.
    describe('duplicate boundary collapse', function() {

      // Two polygons whose facing edges are the same boundary twice over,
      // @width apart, with vertices staggered so that no amount of pairwise
      // vertex snapping can see the pairing.
      function duplicateBoundary(width) {
        var left = [[0, 0], [2, 0]];
        var right = [[2 + width, 0], [4, 0], [4, 1], [2 + width, 1]];
        for (var i = 1; i <= 20; i++) left.push([2, i / 20]);
        left.push([0, 1], [0, 0]);
        for (var j = 19; j >= 1; j--) right.push([2 + width, (j - 0.5) / 20]);
        right.push([2 + width, 0]);
        return {
          type: 'FeatureCollection',
          features: [{
            type: 'Feature',
            properties: {name: 'a'},
            geometry: {type: 'Polygon', coordinates: [left]}
          }, {
            type: 'Feature',
            properties: {name: 'b'},
            geometry: {type: 'Polygon', coordinates: [right]}
          }]
        };
      }

      // Every distinct x coordinate along the seam, across both features.
      function seamXCoords(json) {
        var xs = {};
        json.features.forEach(function(f) {
          f.geometry.coordinates.flat().forEach(function(p) {
            if (Math.abs(p[0] - 2) < 1e-6) xs[p[0]] = true;
          });
        });
        return Object.keys(xs);
      }

      // Vertices where an outline doubles back on itself, with the length of the
      // shorter arm: the signature of a zero-width sliver merged into a feature.
      function spikeArms(feature) {
        var arms = [];
        var polygons = feature.geometry.type == 'Polygon' ?
          [feature.geometry.coordinates] : feature.geometry.coordinates;
        polygons.flat().forEach(function(ring) {
          for (var i = 1; i + 1 < ring.length; i++) {
            var ux = ring[i][0] - ring[i - 1][0], uy = ring[i][1] - ring[i - 1][1];
            var vx = ring[i + 1][0] - ring[i][0], vy = ring[i + 1][1] - ring[i][1];
            var lu = Math.sqrt(ux * ux + uy * uy), lv = Math.sqrt(vx * vx + vy * vy);
            if (!lu || !lv) continue;
            if ((ux * vx + uy * vy) / (lu * lv) < -0.999) {
              arms.push(Math.min(lu, lv) * 111320); // degrees to approximate meters
            }
          }
        });
        return arms;
      }

      it('collapses a seam narrow enough to be a rounding artifact', async function() {
        // 1e-13 degrees is about 11 nanometers.
        var out = await api.applyCommands('-i in.json -clean -o out.json',
          {'in.json': duplicateBoundary(1e-13)});
        var xs = seamXCoords(JSON.parse(String(out['out.json'])));
        assert.equal(xs.length, 1,
          'both banks should land on one boundary, got ' + xs.join(' '));
      })

      it('leaves a seam wide enough to be real, unless asked', async function() {
        // 1e-10 degrees is about 11 microns: still invisible, but orders of
        // magnitude above the precision of the coordinates, so -clean does not
        // presume the two banks are the same line.
        var input = {'in.json': duplicateBoundary(1e-10)};
        var out = await api.applyCommands('-i in.json -clean -o out.json', input);
        assert.equal(seamXCoords(JSON.parse(String(out['out.json']))).length, 2);

        // The crack is open at both ends of this fixture, so close-outer-gaps
        // pinches those shut and the filling that follows awards what is left to
        // one of the two features: the west bank goes, leaving one boundary.
        out = await api.applyCommands(
          '-i in.json -clean close-outer-gaps -o out.json', input);
        var banks = seamXCoords(JSON.parse(String(out['out.json'])));
        assert(banks.indexOf('2') == -1,
          'the west bank should be gone, got ' + banks.join(' '));
      })

      // Precinct boundaries carrying thousands of duplicate seams, several of
      // them kilometers long. Awarding one to a single precinct used to grow that
      // precinct's outline by 167m of doubled-back boundary.
      it('keeps a precinct mosaic free of long spikes', async function() {
        this.timeout(10000);
        var file = 'test/data/features/clean/__franklin.json';
        if (!fs.existsSync(file)) this.skip();
        var out = await api.applyCommands('-i ' + file + ' -clean -o out.json');
        var json = JSON.parse(String(out['out.json']));
        var worst = 0;
        json.features.forEach(function(f) {
          spikeArms(f).forEach(function(arm) {
            worst = Math.max(worst, arm);
          });
        });
        assert(worst < 50,
          'no outline should double back over tens of meters, worst was ' +
          worst.toFixed(1) + 'm');
      })
    })

    describe('interior gap partition', function() {
      var ex24 = 'test/data/features/clean/ex24_three_state_internal_gap.json';

      it('partitions a three-feature interior gap among its neighbors', async function() {
        var sourceOut = await api.applyCommands(
          '-i ' + ex24 + ' -each "area=this.area" -o source.json');
        var cleanOut = await api.applyCommands(
          '-i ' + ex24 +
          ' -clean gap-width=250m -each "area=this.area" -o clean.json');
        var source = JSON.parse(String(sourceOut['source.json']));
        var clean = JSON.parse(String(cleanOut['clean.json']));
        var gains = clean.features.map(function(f, i) {
          return f.properties.area - source.features[i].properties.area;
        });
        assert(gains.every(function(gain) { return gain > 1e6; }),
          'all three polygons should receive a substantial portion of the gap');
        assert(Math.max.apply(null, gains) / Math.min.apply(null, gains) < 2,
          'no polygon should receive a long winner-take-all spike');

        var dataset = api.internal.importGeoJSON(clean, {});
        api.internal.buildTopology(dataset);
        var arcOwners = Array.from({length: dataset.arcs.size()}, function() {
          return new Set();
        });
        api.internal.traversePaths(dataset.layers[0].shapes, function(o) {
          var arcId = o.arcId < 0 ? ~o.arcId : o.arcId;
          arcOwners[arcId].add(o.shapeId);
        });
        var sharedArcs = dataset.arcs.toArray().filter(function(arc, i) {
          return arcOwners[i].size > 1;
        });
        var endpointCounts = {};
        sharedArcs.forEach(function(arc) {
          [arc[0], arc[arc.length - 1]].forEach(function(p) {
            var key = p.join('~');
            endpointCounts[key] = (endpointCounts[key] || 0) + 1;
          });
        });
        var junctionKey = Object.keys(endpointCounts).find(function(key) {
          return endpointCounts[key] == 3;
        });
        assert(junctionKey, 'the partition should have one three-way junction');
        var junction = junctionKey.split('~').map(Number);
        var incidentVectors = sharedArcs.reduce(function(vectors, arc) {
          var a = arc[0], b = arc[arc.length - 1], neighbor;
          if (a[0] == junction[0] && a[1] == junction[1]) neighbor = arc[1];
          if (b[0] == junction[0] && b[1] == junction[1]) {
            neighbor = arc[arc.length - 2];
          }
          if (neighbor) {
            vectors.push([
              neighbor[0] - junction[0],
              neighbor[1] - junction[1]
            ]);
          }
          return vectors;
        }, []);
        assert.equal(incidentVectors.length, 3);
        assert(incidentVectors.every(function(v) {
          var major = Math.max(Math.abs(v[0]), Math.abs(v[1]));
          var minor = Math.min(Math.abs(v[0]), Math.abs(v[1]));
          return major < 0.002 || minor / major < 0.1;
        }), 'the junction should not contain long diagonal connectors');
        var sharedPointCount = sharedArcs.reduce(function(sum, arc) {
          return sum + arc.length;
        }, 0);
        assert(sharedPointCount < 500,
          'medial boundaries should be smoothed rather than retaining raw zigzags');
      })

      // A partition boundary is only in the right place if it runs between the
      // two features it separates. Where this fixture's gap narrows, an earlier
      // construction sampled its way out of the channel and put the boundary on
      // one bank for a stretch and then the other, moving a state line by the
      // full width of the gap and flipping sides 98 times. Walk the cleaned
      // boundary through the gap corridor and check where it sits.
      it('keeps the partition boundary off the banks where the gap pinches', async function() {
        var out = await api.applyCommands(
          '-i ' + ex24 + ' -clean gap-width=250m -o out.json');
        var source = JSON.parse(fs.readFileSync(ex24, 'utf8'));
        var cleaned = JSON.parse(String(out['out.json']));
        var banks = source.features.map(featureRings);
        var flips = 0, hugging = 0, centered = 0;
        cleaned.features.forEach(function(feature, featureId) {
          featureRings(feature).forEach(function(ring) {
            var bank = 0; // which bank the boundary last hugged, 0 == neither
            ring.forEach(function(p) {
              var dists = banks.map(function(rings, i) {
                return {id: i, dist: distToRings(p[0], p[1], rings)};
              }).sort(function(a, b) { return a.dist - b.dist; });
              var near = dists[0], far = dists[1];
              // Consider only vertices inside a real gap corridor: a second
              // feature nearby (0.003 degrees) but not coincident.
              if (far.dist > 0.003 || far.dist < 1e-7) { bank = 0; return; }
              var offset = (far.dist - near.dist) / (far.dist + near.dist);
              if (offset > 0.8) { // sitting on one bank rather than between them
                hugging++;
                var side = near.id === featureId ? 1 : -1;
                if (bank !== 0 && side !== bank) flips++;
                bank = side;
              } else if (offset < 0.3) {
                centered++;
              }
            });
          });
        });
        assert(centered > 20, 'expected a populated gap corridor');
        assert.equal(flips, 0, 'the boundary should not zigzag between the banks');
        // A ratio rather than a count: a partition boundary needs no more
        // vertices than the banks it runs between, so the absolute number of
        // them is a property of the fixture, not of the partition's quality.
        assert(hugging * 4 < centered,
          'the boundary should stay between the banks, hugging ' + hugging +
          ' of ' + (hugging + centered) + ' vertices in the corridor');
      })

      // A corridor 998 units long and @w wide, enclosed by a slab to the north,
      // a slab to the south and a block at each end. The two long banks carry a
      // vertex every @step, so the corridor can be orders of magnitude narrower
      // than the features around it are long while still being coarser than the
      // scale the data was drawn at.
      function hairlineCorridor(w, step) {
        var north = [], south = [];
        for (var x = 1; x < 999; x += step) {
          north.push([x, w]);
          south.push([x, 0]);
        }
        north.push([999, w]);
        south.push([999, 0]);
        function feature(name, points) {
          return {
            type: 'Feature',
            properties: {name: name},
            geometry: {type: 'Polygon', coordinates: [points.concat([points[0]])]}
          };
        }
        return {
          type: 'FeatureCollection',
          features: [
            feature('west', [[0, -1], [1, -1], [1, 1], [0, 1]]),
            feature('east', [[999, -1], [1000, -1], [1000, 1], [999, 1]]),
            feature('north', north.concat([[999, 1], [1, 1]])),
            feature('south', south.reverse().concat([[1, -1], [999, -1]]))
          ]
        };
      }

      async function corridorGains(w, step) {
        var input = {'in.json': JSON.stringify(hairlineCorridor(w, step))};
        var before = await api.applyCommands(
          '-i in.json -each "area=this.area" -o out.json', input);
        var after = await api.applyCommands('-i in.json -clean gap-width=' +
          (w * 2) + ' -each "area=this.area" -o out.json', input);
        var source = JSON.parse(String(before['out.json'])).features;
        return JSON.parse(String(after['out.json'])).features
          .map(function(f, i) {
            return f.properties.area - source[i].properties.area;
          });
      }

      // Dividing a gap this shape defeated an earlier construction that sampled
      // points inside it and joined the ones equidistant from three boundaries:
      // such a sample only finds the middle of a channel while the samples are
      // closer together than the channel is wide, so the work grew with the
      // gap's length-to-width ratio until it exhausted memory. Taking the
      // division from the boundary's own vertices instead costs the same at any
      // aspect ratio.
      it('divides a hairline corridor however narrow it is', async function() {
        this.timeout(20000);
        for (var o of [[0.05, 1], [0.0025, 0.05]]) {
          var gap = 998 * o[0];
          var gains = await corridorGains(o[0], o[1]);
          var aspect = ', aspect ratio ' + Math.round(998 / o[0]);
          assert(Math.abs(gains[2] - gap / 2) < gap / 20 &&
            Math.abs(gains[3] - gap / 2) < gap / 20,
            'the corridor should be halved between the features along it' +
            aspect + ', gains were ' + gains.join(' '));
          assert(gains[0] < gap / 20 && gains[1] < gap / 20,
            'the blocks capping the corridor should receive little of it' +
            aspect + ', gains were ' + gains.join(' '));
        }
      })

      // Dividing a gap gives each neighbor a strip of it, and the boundary
      // between two strips runs half the gap's width from the bank it was cut
      // from, out and back. That is a fair division of a gap wide enough to see
      // and a hairline sliver on a gap narrower than the data's own detail, which
      // is better given whole to one neighbor: its boundary then moves across to
      // the far bank, by less than the width of the gap.
      it('gives a gap finer than the data whole to one neighbor', async function() {
        var gains = (await corridorGains(0.001, 1)).sort(function(a, b) {
          return b - a;
        });
        var gap = 998 * 0.001;
        assert(Math.abs(gains[0] - gap) < gap / 20,
          'one feature should receive the whole corridor, gains were ' +
          gains.join(' '));
        assert(gains[1] < gap / 20, 'the rest should receive none of it');
      })
    })

  })

  describe('OGC Simple Features tests', function () {

    it('invalid holes are not created', function (done) {
      var cmd = '-i test/data/features/clean/ex11_ogc.geojson -filter-fields -clean -o out.json';
      api.applyCommands(cmd, {}, function(err, out) {
        var json = JSON.parse(out['out.json']);
        assert.equal(json.geometries[0].type, 'MultiPolygon');
        assert.equal(json.geometries[0].coordinates.length, 2);
        assert.equal(json.geometries.length, 1);
        done();
      });
    })

    it('polygon rings that share an edge are merged', function (done) {
      var cmd = '-i test/data/features/clean/ex12_ogc.geojson -filter-fields -clean -o gj2008 out.json';
      api.applyCommands(cmd, {}, function(err, out) {
        var json = JSON.parse(out['out.json']);
        var target = {
          type: 'GeometryCollection',
          geometries: [{
            type: 'Polygon',
            coordinates: [[[5,2],[3,1],[1,2],[1,4],[3,5],[5,4],[7,5],[9,4],[9,2],[7,1],[5,2]]]
          }]
        }
        assert.deepEqual(json, target)
        done();
      });
    })

    it('cuts are removed', function (done) {
      var cmd = '-i test/data/features/clean/ex13_ogc.json -clean -o gj2008 out.json';
      api.applyCommands(cmd, {}, function(err, out) {
        var json = JSON.parse(out['out.json']);
        var target = {
          type: 'GeometryCollection',
          geometries: [{
            type: 'MultiPolygon',
            coordinates: [
              [[[5,3],[6,3],[6,1],[4,1],[4,3],[5,3]]],
              [[[2,3],[3,3],[3,1],[1,1],[1,3],[2,3]]]]
          }]
        }
        assert.deepEqual(json, target)
        done();
      });
    })

    it('spikes are removed', function (done) {
      var cmd = '-i test/data/features/clean/ex14_ogc.json -filter-fields -clean -o gj2008 out.json';
      api.applyCommands(cmd, {}, function(err, out) {
        var json = JSON.parse(out['out.json']);
        var target = {
          type: 'GeometryCollection',
          geometries: [{
            type: 'MultiPolygon',
            coordinates: [
              [[[5,3],[6,3],[6,1],[4,1],[4,3],[5,3]]],
              [[[2,3],[3,3],[3,1],[1,1],[1,3],[2,3]]]]
          }]
        }
        assert.deepEqual(json, target)
        done();
      });
    })

    it('holes cannot touch outer ring at more than one point', function (done) {
      var cmd = '-i test/data/features/clean/ex15_ogc.json -clean -o out.json';
      api.applyCommands(cmd, {}, function(err, out) {
        var json = JSON.parse(out['out.json']);
        assert.equal(json.geometries[0].type, 'MultiPolygon');
        assert.equal(json.geometries[0].coordinates.length, 4);
        done();
      });
    })

   it('self-intersecting loops are converted to holes', function (done) {
      var cmd = '-i test/data/features/clean/ex16_ogc.json -clean -o out.json';
      api.applyCommands(cmd, {}, function(err, out) {
        var json = JSON.parse(out['out.json']);
        assert.equal(json.geometries[0].type, 'Polygon');
        assert.equal(json.geometries[0].coordinates.length, 2); // one hole
        done();
      });
    })

    it('self-intersections are converted to multipart polygons', function (done) {
      var cmd = '-i test/data/features/clean/ex17_ogc.json -clean -o out.json';
      api.applyCommands(cmd, {}, function(err, out) {
        var json = JSON.parse(out['out.json']);
        assert.equal(json.geometries[0].type, 'MultiPolygon');
        assert.equal(json.geometries[0].coordinates.length, 2);
        done();
      });
    })

    it('a polygon can not have two lobes connected by a linear portion', function (done) {
      var cmd = '-i test/data/features/clean/ex19_ogc.json -clean -o out.json';
      api.applyCommands(cmd, {}, function(err, out) {
        var json = JSON.parse(out['out.json']);
        assert.equal(json.geometries[0].type, 'MultiPolygon');
        assert.equal(json.geometries[0].coordinates.length, 2);
        done();
      });
    })

  })

  describe('clean arcs', function () {
    it('removes unused arcs', function () {
      var arcs = [[[0, 0], [1, 0]], [[0, 1], [1, 1]], [[0, 2], [1, 2]], [[0, 3], [1, 3]]];
      var dataset = {
        layers: [{
          geometry_type: 'polyline',
          shapes: [[[0, 1], [3]]]
        }],
        arcs: new ArcCollection(arcs)
      };
      cleanArcs(dataset);
      var expectedShapes = [[[0, 1], [2]]];
      var expectedArcs = [[[0, 0], [1, 0]], [[0, 1], [1, 1]], [[0, 3], [1, 3]]];
      assert.deepEqual(dataset.arcs.toArray(), expectedArcs)
      assert.deepEqual(dataset.layers[0].shapes, expectedShapes)
    })
  })


  it('Ignores layers with no geometry', function() {
    var records = [{id: 'a'}]
    var dataset = {
      info: {},
      layers: [{
        data: new api.internal.DataTable(records)
      }]
    };
    api.cmd.cleanLayers(dataset.layers, dataset);
    assert.deepEqual(dataset.layers[0].data.getRecords(), [{id: 'a'}]);
  });

  it('Converts segment intersections in line features to multipart geometries', function(done) {
    var data = {
      type: 'LineString',
      coordinates: [[0, 0], [1, 1], [0, 1], [1, 0]]
    };
    var target = {
      type: 'MultiLineString',
      coordinates: [[[0, 0], [0.5, 0.5]], [[0.5, 0.5], [1, 1], [0, 1], [0.5, 0.5]],
       [[0.5, 0.5], [1, 0]]]
    }
    var cmd = '-i data.json -clean -o';
    api.applyCommands(cmd, {'data.json': data}, function(err, out) {
      var json = JSON.parse(out['data.json']);
      assert.deepEqual(json.geometries[0], target)
      done();
    });


  });

  it('Removes empty line geometries by default', function(done) {
    var data = {
      type: 'FeatureCollection',
      features: [{
        type: 'Feature',
        geometry: null,
        properties: {id: 'a'}
      }, {
        type: 'Feature',
        geometry: {
          type: 'LineString',
          coordinates: [[0, 0], [1, 1]]
        },
        properties: {id: 'b'}
      }]
    };
    var cmd = '-i data.json -clean -o';
    api.applyCommands(cmd, {'data.json': data}, function(err, out) {
      var json = JSON.parse(out['data.json']);
      assert.deepEqual(json, {
        type: 'FeatureCollection',
        features: [data.features[1]]
      });
      done();
    });
  });

  it('Removes duplicate coordinates within multipoint features', function() {
    var dataset = {
      info: {},
      layers: [{
        geometry_type: 'point',
        shapes: [[[0, 0]], [[1, 1], [1, 1], [0, 0]]]
      }]
    };
    api.cmd.cleanLayers(dataset.layers, dataset);
    assert.deepEqual(dataset.layers[0].shapes, [[[0, 0]], [[1, 1], [0, 0]]]);
  })

  it('Removes empty point geometries by default', function() {
    var dataset = {
      info: {},
      layers: [{
        geometry_type: 'point',
        shapes: [null, [[0, 0]], null, [[1, 1], [2, 2]] ],
        data: null
      }]
    };
    api.cmd.cleanLayers(dataset.layers, dataset);
    assert.deepEqual(dataset.layers[0], {
      geometry_type: 'point',
      shapes: [ [[0, 0]], [[1, 1], [2, 2]] ],
      data: null
    });

  })

  it('Removes empty polygon geometries by default', function(done) {
      //  a ----- b
      //  |       |
      //  |       |
      //  |       |
      //  d ----- c

      var input = {
        type: 'FeatureCollection',
        features: [{
          type: "Feature",
          properties: {id: 0},
          geometry: null
        }, {
          type: "Feature",
          properties: {id: 1},
          geometry: {
            type: 'Polygon',
            coordinates: [[[0, 1], [1, 1], [1, 0], [0, 0], [0, 1]]]
          }
        }, {
          type: "Feature",
          properties: {id: 2},
          geometry: null
        }]};

      var expected = {
        type: 'FeatureCollection',
        features: [{
          type: "Feature",
          properties: {id: 1},
          geometry: {
            type: 'Polygon',
            coordinates: [[[0, 1], [1, 1], [1, 0], [0, 0], [0, 1]]]
          }
        }]};
      api.applyCommands('-i poly.json -clean -o gj2008', {'poly.json': input}, function(err, output) {
        var poly2 = JSON.parse(output['poly.json']);
        assert.deepEqual(poly2, expected);
        done();
      });
    })

  it('Retains empty geometries if "allow-empty" flag is present', function(done) {
    //  a ----- b
    //  |       |
    //  |       |
    //  |       |
    //  d ----- c

    var input = {
      type: 'FeatureCollection',
      features: [{
        type: "Feature",
        properties: {id: 0},
        geometry: null
      }, {
        type: "Feature",
        properties: {id: 1},
        geometry: {
          type: 'Polygon',
          coordinates: [[[0, 1], [1, 1], [1, 0], [0, 0], [0, 1]]]
        }
      }, {
        type: "Feature",
        properties: {id: 2},
        geometry: null
      }]};

    api.applyCommands('-i poly.json -clean allow-empty -o gj2008', {'poly.json': input}, function(err, output) {
      var poly2 = JSON.parse(output['poly.json']);
      assert.deepEqual(poly2, input);
      done();
    });
  });


  it('Removes overlapping section in GeoJSON input', function(done) {
    api.applyCommands('-i test/data/features/clean/ex6.json -clean -o gj2008 out.json', null, function(err, data) {
      var geojson = JSON.parse(data['out.json']);
      var a = geojson.geometries[0].coordinates;
      var b = geojson.geometries[1].coordinates;
      assert.deepEqual(a, [ [ [ 0, 0 ], [ 0, 2 ], [ 2, 2 ], [ 1, 1 ], [ 2, 0 ], [ 0, 0 ] ] ])
      assert.deepEqual(b, [ [ [ 2, 0 ], [ 1, 1 ], [ 2, 2 ], [ 3, 3 ], [ 5, 1 ], [ 3, -1 ], [ 2, 0 ] ] ])
      done();
    })

  })

  it('Removes spurious endpoints (arc dissolve)', function(done) {
    //  a ----- b
    //  |       |
    //  |       c
    //  |       |
    //  f - e - d

    var poly = {
      type: 'Polygon',
      coordinates: [[[0, 1], [1, 1], [1, 0.5], [1, 0], [0.5, 0], [0.5, 0], [0, 0], [0, 1]]]
    }
    var expected = poly = {
      type: 'Polygon',
      coordinates: [[[0, 1], [1, 1], [1, 0], [0, 0], [0, 1]]]
    }
    api.applyCommands('-i poly.json -clean -o', {'poly.json': poly}, function(err, output) {
      var poly2 = JSON.parse(output['poly.json']).geometries[0];
      assert.deepEqual;(poly2, expected);
      done();

    });

  })

  // Change in -clean changed this shape's output... need to assess
  if (false) it('handles bowtie shapes', function(done) {
    // Fig 16 in figures.txt
    var a = {
      type: "Polygon",
      coordinates: [[[0, 2], [2, 2], [3, 2], [2, 3], [2, 2], [2, 0], [0, 0], [0, 2]]]
    }
    var b = {
      type: "Polygon",
      coordinates: [[[4, 2], [2, 2], [2, 4], [4, 2]]]
    }
    var input = {
      type: 'GeometryCollection',
      geometries: [a, b]
    };
    var expected = [{
      type: 'MultiPolygon',
      coordinates: [[[[3, 2], [2, 2], [2, 3], [3, 2]]], [[[2, 2], [2, 0], [0, 0], [0, 2], [2, 2]]]]
    }, {
      type: 'Polygon',
      coordinates: [[[3, 2], [2, 3], [2, 4], [4, 2], [3, 2]]]
    }];
    api.applyCommands('-i input.json -clean -o output.json', {'input.json': input}, function(err, out) {
      var geojson = JSON.parse(out['output.json']);
      assert.deepEqual(geojson.geometries, expected);
      done();
    })
  })

  describe('rewind option', function () {
    it('holes outside of rings are converted to rings', function (done) {
      var input = {
        type: 'Polygon',
        coordinates: [
          [[0, 0], [0, 1], [1, 1], [1, 0], [0, 0]], [[2, 0], [2, 1], [3, 1], [3, 0], [2, 0]]
        ]
      };
      api.applyCommands('-i in.json -clean rewind -o out.json', {'in.json': input}, function(err, out) {
        var json = JSON.parse(out['out.json']);
        assert.deepEqual(json.geometries[0], {
          type: 'MultiPolygon',
          coordinates: [
            [[[0, 0], [1, 0], [1, 1], [0, 1], [0, 0]]],
            [[[2, 0], [3, 0], [3, 1], [2, 1], [2, 0]]]
          ]
        })
        done();
      });
    })

    it('without rewind, holes outside of rings are removed', function (done) {
      var input = {
        type: 'Polygon',
        coordinates: [
          [[0, 0], [0, 1], [1, 1], [1, 0], [0, 0]], [[2, 0], [2, 1], [3, 1], [3, 0], [2, 0]]
        ]
      };
      api.applyCommands('-i in.json -clean -o out.json', {'in.json': input}, function(err, out) {
        var json = JSON.parse(out['out.json']);
        assert.deepEqual(json.geometries[0], {
          type: 'Polygon',
          coordinates: [
            [[0, 0], [1, 0], [1, 1], [0, 1], [0, 0]]
          ]
        })
        done();
      });
    })


  })

  describe('cleanLayers()', function() {

    describe('Fig. 1', function() {
      //
      //      b --- d
      //     / \   /
      //    /   \ /
      //   a --- c
      //

      it('adjacent shapes are preserved', function () {
        //   cab, bc, bdc
        //   0,   1,  2
        var coords = [[[3, 1], [1, 1], [2, 3]], [[2, 3], [3, 1]], [[2, 3], [4, 3], [3, 1]]];
        var arcs = new api.internal.ArcCollection(coords);

        var shapes = [[[1, 0]], [[2, -2]]];
        var target = [[[0, 1]], [[-2, 2]]]; // new mosaic-based clean function can re-arrange arc order
        assert.deepEqual(clean(shapes, arcs), target);
      })
    })


    describe('triangles containing collapsed arcs', function () {
      //
      //      b --- d
      //     / \   /
      //    /   \ /
      //   a --- c
      //
      //   cab, bc, bd, dc, bb, dd, a
      //   0,   1,  2,  3,  4,  5
      var coords = [[[3, 1], [1, 1], [2, 3]], // 0
          [[2, 3], [3, 1]],
          [[2, 3], [4, 3]],
          [[4, 3], [3, 1]], // 4
          [[2, 3], [2, 3]],
          [[4, 3], [4, 3]], // 6
          [[1, 1]]];

      it ('ignores collapsed arcs', function() {
        var arcs = new api.internal.ArcCollection(coords);
        var shapes = [[[1, 0]], [[2, 5, 3, -2]]];
        var target = [[[0, 1]], [[~1, 2, 3]]];
        assert.deepEqual(clean(shapes, arcs), target);
      })


      it ('ignores collapsed arcs 2', function() {
        var arcs = new api.internal.ArcCollection(coords);
        var shapes = [[[4, 1, 0]], [[~4, 2, 3, -2]]];
        var target = [[[0, 1]], [[~1, 2, 3]]];
        arcs = new api.internal.ArcCollection(coords);
        assert.deepEqual(clean(shapes, arcs), target);
      })

      it ('ignores collapsed arcs 3', function() {
        var arcs = new api.internal.ArcCollection(coords);
        var shapes = [[[4, 4, 1, 0, 4]], [[~4, 2, 3, -2, 4]]];
        var target = [[[0, 1]], [[~1, 2, 3]]];
        assert.deepEqual(clean(shapes, arcs), target);
      })
    })

    describe('Fig. 2', function () {
      //
      //       e
      //      /|\
      //     / | \
      //    /  a  \
      //   /  / \  \
      //  h  d   b  f
      //   \  \ /  /
      //    \  c  /
      //     \   /
      //      \ /
      //       g
      //
      //   abcda, ae, efghe
      //   0,     1,  2

      var coords = [[[3, 4], [4, 3], [3, 2], [2, 3], [3, 4]],
          [[3, 4], [3, 5]],
          [[3, 5], [5, 3], [3, 1], [1, 3], [3, 5]]];
      var arcs = new ArcCollection(coords);

      it('paths are preserved', function () {
        var shapes = [[[1, 2, -2, -1]]];
        // var target = [[[1, 2, -2, -1]]];
        var target = [[[-1], [2]]]; // new clean function dissolves the shape
        assert.deepEqual(clean(shapes, arcs), target);

      })
    })

    describe('Fig. 3', function () {
      //
      //  d -- e -- a
      //  |   / \   |
      //  |  g - f  |
      //  |         |
      //  c ------- b
      //
      //   abcde, efge, ea
      //   0,     1,    2

      var coords = [[[5, 3], [5, 1], [1, 1], [1, 3], [3, 3]],
          [[3, 3], [4, 2], [2, 2], [3, 3]],
          [[3, 3], [5, 3]]];
      var arcs = new ArcCollection(coords);

      it('self intersection converted to ring + hole', function () {
        var shapes = [[[0, ~1, 2]], [[1]]];
        var target = [[[0, 2], [~1]], [[1]]];
        var output = clean(shapes, arcs);
        assert.deepEqual(output, target);
      })
    })

    describe('Fig. 4', function () {
      //
      //  d -- e -- a
      //  |   /|\   |
      //  |  h | f  |
      //  |   \|/   |
      //  |    g    |
      //  |         |
      //  c ------- b
      //
      //   abcde, efg,  eg,   ghe,  ea
      //   0,     1/-2, 2/-3, 3/-4, 4

      var coords = [[[5, 4], [5, 1], [1, 1], [1, 4], [3, 4]],
          [[3, 4], [4, 3], [3, 2]],
          [[3, 4], [3, 2]],
          [[3, 2], [2, 3], [3, 4]],
          [[3, 4], [5, 4]]];
      var arcs = new ArcCollection(coords);

      it('self-intersecting loops are converted to holes', function () {
        var shapes = [[[0, ~3, ~1, 4]], [[2, 3]], [[1, ~2]]];
        // var target = [[[0, ~3, ~1, 4]], [[2, 3]], [[1, ~2]]];
        var target = [ [ [ 0, 4 ], [ -4, -2 ] ], [ [ 2, 3 ] ], [ [ 1, -3 ] ] ];
        var output = clean(shapes, arcs);
        assert.deepEqual(output, target);
      })

    })


    describe('Fig. 5 - hourglass shape', function () {
      //
      //   b - c
      //    \ /
      //     a
      //     |
      //     d
      //    / \
      //   f - e
      //
      //   abca, ad, de, efd
      //   0,    1,  2,  3

      var coords = [[[2, 3], [1, 4], [3, 4], [2, 3]],
          [[2, 3], [2, 2]],
          [[2, 2], [3, 1]],
          [[3, 1], [1, 1], [2, 2]]];
      var arcs = new ArcCollection(coords);

      it('hourglass shape is preserved', function () {
        var shapes = [[[0, 1, 2, 3, ~1]]];
        var target = [[[0], [2, 3]]];
        assert.deepEqual(clean(shapes, arcs), target);
      })
    })

    describe('Fig. 6', function () {
      //
      //  a - b - d
      //  |   |   |
      //  |   c   |
      //  |       |
      //  f ----- e
      //
      //   ab, bc, bdefa
      //   0,  1,  2

      var coords = [[[1, 3], [2, 3]],
          [[2, 3], [2, 2]],
          [[2, 3], [3, 3], [3, 1], [1, 1], [1, 3]]];

      it ('should skip spike - test 1', function() {
        var shapes = [[[0, 1, ~1, 2]]];
        var target = [[[0, 1]]];
        var arcs = new ArcCollection(coords);
        assert.deepEqual(clean(shapes, arcs), target);
      })

      it ('should skip spike - test 2', function() {
        var shapes = [[[1, ~1, 2, 0]]];
        var target = [[[0, 1]]];
        var arcs = new ArcCollection(coords);
        assert.deepEqual(clean(shapes, arcs), target);
      })

      it ('should skip spike - test 3', function() {
        var shapes = [[[~1, 2, 0, 1]]];
        var target = [[[0, 1]]];
        var arcs = new ArcCollection(coords);
        assert.deepEqual(clean(shapes, arcs), target);
      })
    })

    describe('Fig. 7', function () {

      //     b
      //    / \
      //  a --- c
      //  | \ / |
      //  |  d  |
      //  |     |
      //  f --- e
      //
      //   abc, cda, ac, cefa
      //   0,   1,   2,  3

      var coords = [[[1, 3], [2, 4], [3, 3]],
          [[3, 3], [2, 2], [1, 3]],
          [[1, 3], [3, 3]],
          [[3, 3], [3, 1], [1, 1], [1, 3]]];
      var arcs = new ArcCollection(coords);

      it ('should remove overlapping portion of smaller ring', function() {
        var shapes = [[[0, 1]], [[2, 3]]];
        //var target = [[[0, ~2]], [[2, 3]]]
        var target = [[[0, ~2]], [[3, 2]]]; // changed tile traversal in mapshaper-polygon-tiler.js
        var output = clean(shapes, arcs);
        // console.log(output)
        assert.deepEqual(output, target);
      })
    })
  })
})
