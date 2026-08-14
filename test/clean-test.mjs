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

    describe('close-gaps option', function() {
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

      function getSeamXCoords(feature) {
        var ring = feature.geometry.coordinates[0];
        return ring.filter(function(p) {
          return p[0] > 4.9 && p[0] < 5.1;
        }).map(function(p) { return p[0]; });
      }

      it('closes an external seam automatically', async function() {
        var out = await api.applyCommands(
          '-i ' + ex26 + ' -clean close-gaps -o out.json');
        var json = JSON.parse(String(out['out.json']));
        var tips = getEasternTips(json);
        assert.deepEqual(tips[0], tips[1],
          'the two polygons should share the snapped mouth vertex');
        // The rest of this fixture's crack consists of corresponding vertices.
        // Once the mouth is snapped, clean rebuilds it as one shared boundary
        // rather than assigning a long gap polygon to either feature.
        assert(tips[0][0] > -75.868);
      })

      it('respects an explicit close-distance', async function() {
        var out = await api.applyCommands(
          '-i ' + ex26 + ' -clean close-gaps close-distance=0.001m -o out.json');
        var json = JSON.parse(String(out['out.json']));
        var tips = getEasternTips(json);
        assert.notDeepEqual(tips[0], tips[1],
          'a 1mm limit should not close the approximately 3mm mouth');

        out = await api.applyCommands(
          '-i ' + ex26 + ' -clean close-gaps close-distance=1m -o out.json');
        json = JSON.parse(String(out['out.json']));
        tips = getEasternTips(json);
        assert.deepEqual(tips[0], tips[1]);
      })

      it('does not close a cut within one polygon', async function() {
        var normal = await api.applyCommands('-i ' + ex25 + ' -clean -o out.json');
        var closing = await api.applyCommands(
          '-i ' + ex25 + ' -clean close-gaps -o out.json');
        assert.equal(String(closing['out.json']), String(normal['out.json']),
          'single-feature geometry should be byte-identical');
      })

      // Facing edges stay within tolerance for a sustained length, but vertices
      // on either bank are staggered -- the old mutual-nearest run filter would
      // reject this seam. The mouth is a within-tolerance vertex pair.
      it('closes a staggered external seam', async function() {
        var out = await api.applyCommands(
          '-i ' + ex27 +
          ' -clean close-gaps close-distance=500m -o out.json');
        var json = JSON.parse(String(out['out.json']));
        var left = json.features.find(function(f) {
          return f.properties.name == 'left';
        });
        var right = json.features.find(function(f) {
          return f.properties.name == 'right';
        });
        var leftXs = getSeamXCoords(left);
        var rightXs = getSeamXCoords(right);
        assert(leftXs.length > 0 && rightXs.length > 0);
        // After snapping, the two banks should meet near the midline (x = 5).
        // Coordinates are degree-like; the ~0.003° (~333m) crack is closed with
        // close-distance=500m. Vertices on either bank are staggered in y.
        leftXs.forEach(function(x) {
          assert(Math.abs(x - 5) < 0.001,
            'left seam should collapse toward the midline, got ' + x);
        });
        rightXs.forEach(function(x) {
          assert(Math.abs(x - 5) < 0.001,
            'right seam should collapse toward the midline, got ' + x);
        });

        // A short distant near-miss must not be snapped (locality / min length).
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

      // Guards against a quadratic seam walk: before the staggered-edge change,
      // this national mosaic finished in ~0.7s. A generous 3s bound fails CI on a
      // clear regression without being flaky on ordinary machines.
      it('close-gaps stays fast on a national mosaic', async function() {
        this.timeout(10000);
        var file = 'test/data/features/buffer/__01_thin_gap_polygons.json';
        var t0 = Date.now();
        await api.applyCommands('-i ' + file + ' -clean close-gaps -o out.json');
        var ms = Date.now() - t0;
        assert(ms < 3000,
          'close-gaps on the national mosaic should stay under 3s, took ' + ms + 'ms');
      })

      it('partitions a three-feature interior gap among its neighbors', async function() {
        var sourceOut = await api.applyCommands(
          '-i ' + ex24 + ' -each "area=this.area" -o source.json');
        var cleanOut = await api.applyCommands(
          '-i ' + ex24 + ' -clean close-gaps -each "area=this.area" -o clean.json');
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

      // Where this fixture's gap narrows past the medial's sampling spacing, the
      // partition boundary used to jump clear across the channel and back --
      // hugging one bank for a stretch, then the other -- because the sampled
      // Voronoi throws its circumcenters out of a pinching channel. Walk the
      // cleaned boundary through the gap corridor and count how often it flips
      // from one bank to the other; it used to flip 98 times.
      it('keeps the partition boundary off the banks where the gap pinches', async function() {
        var out = await api.applyCommands('-i ' + ex24 + ' -clean close-gaps -o out.json');
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
        assert(centered > 100, 'expected a populated gap corridor');
        assert.equal(flips, 0, 'the boundary should not zigzag between the banks');
        assert(hugging < 25,
          'the boundary should stay between the banks, hugging count ' + hugging);
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
