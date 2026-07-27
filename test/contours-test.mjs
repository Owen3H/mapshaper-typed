import api from '../mapshaper.js';
import assert from 'assert';

var internal = api.internal;
var GEOTIFF = 'test/data/geotiff/wgs84-geographic-epsg4326.tif';

// Builds a north-up single-band grid whose bbox is one map unit per pixel, so
// pixel centers land on half-unit coordinates.
function makeGrid(width, height, fn, opts) {
  var o = opts || {};
  var samples = new (o.arrayType || Float32Array)(width * height);
  for (var y = 0; y < height; y++) {
    for (var x = 0; x < width; x++) {
      samples[y * width + x] = fn(x, y);
    }
  }
  return {
    width: width,
    height: height,
    bands: 1,
    pixelType: 'float32',
    samples: samples,
    sampleBands: [0],
    nodata: 'nodata' in o ? o.nodata : null,
    bbox: [0, 0, width, height],
    transform: [1, 0, 0, 0, -1, height]
  };
}

function makeRasterLayer(grid) {
  return {
    name: 'raster',
    raster_type: 'grid',
    raster: {
      sourceId: 'raster',
      interpretation: 'continuous',
      grid: grid,
      derivation: {type: 'gray', sourceId: 'raster', bands: [0]},
      view: {recipe: {type: 'gray', bands: [0]}}
    }
  };
}

function makeRasterDataset(grid) {
  return {
    info: {crs_string: 'wgs84'},
    layers: [makeRasterLayer(grid)]
  };
}

function getCoordBounds(coords) {
  var xs = coords.map(function(p) { return p[0]; });
  var ys = coords.map(function(p) { return p[1]; });
  return [Math.min.apply(null, xs), Math.min.apply(null, ys),
    Math.max.apply(null, xs), Math.max.apply(null, ys)];
}

function isClosed(coords) {
  var a = coords[0];
  var b = coords[coords.length - 1];
  return coords.length > 3 && a[0] === b[0] && a[1] === b[1];
}

describe('mapshaper-contours.mjs', function () {

  describe('tracing', function () {
    it('traces a linear ramp as a straight line through pixel centers', function () {
      // Values 0,10,20,30,40 left to right. Level 15 falls midway between the
      // second and third columns, whose centers are at x=1.5 and x=2.5.
      var grid = makeGrid(5, 3, function(x) { return x * 10; });
      var lines = internal.traceRasterContours(grid, 0, [15]);
      assert.equal(lines.length, 1);
      assert.equal(lines[0].value, 15);
      assert.deepEqual(lines[0].coords, [[2, 2.5], [2, 1.5], [2, 0.5]]);
    });

    it('traces closed nested rings from a pyramid', function () {
      var grid = makeGrid(11, 11, function(x, y) {
        return 100 - Math.max(Math.abs(x - 5), Math.abs(y - 5)) * 10;
      });
      var lines = internal.traceRasterContours(grid, 0, [60, 90]);
      var inner, outer;
      assert.equal(lines.length, 2);
      lines.forEach(function(line) {
        assert(isClosed(line.coords), 'contour at ' + line.value + ' is not closed');
      });
      outer = getCoordBounds(lines[0].coords);
      inner = getCoordBounds(lines[1].coords);
      assert.equal(lines[0].value, 60);
      assert.equal(lines[1].value, 90);
      assert(inner[0] > outer[0] && inner[1] > outer[1] &&
        inner[2] < outer[2] && inner[3] < outer[3],
        'the higher contour is not inside the lower one');
    });

    it('splits a saddle into separate branches instead of crossing itself', function () {
      var grid = makeGrid(5, 5, function(x, y) {
        return (x - 2) * (x - 2) - (y - 2) * (y - 2);
      });
      var lines = internal.traceRasterContours(grid, 0, [0]);
      assert.equal(lines.length, 2);
      lines.forEach(function(line) {
        assert(!isClosed(line.coords));
        assert.equal(line.coords.length, 5);
      });
    });

    it('breaks contours around a nodata hole', function () {
      // A ramp with a nodata block in the middle. The level-35 contour runs
      // down column x=4, so the hole should cut it into two pieces.
      var grid = makeGrid(9, 9, function(x, y) {
        return (x > 2 && x < 6 && y > 2 && y < 6) ? -9999 : x * 10;
      }, {nodata: -9999});
      var lines = internal.traceRasterContours(grid, 0, [35]);
      assert.equal(lines.length, 2);
      lines.forEach(function(line) {
        line.coords.forEach(function(p) {
          assert.equal(p[0], 4);
        });
      });
      // The rows spanned by the hole (map y 3.5 to 5.5) carry no vertices.
      var ys = lines.reduce(function(memo, line) {
        return memo.concat(line.coords.map(function(p) { return p[1]; }));
      }, []);
      assert.deepEqual(ys.sort(function(a, b) { return b - a; }),
        [8.5, 7.5, 6.5, 2.5, 1.5, 0.5]);
    });

    it('skips NaN samples', function () {
      var grid = makeGrid(5, 3, function(x, y) {
        return y === 1 ? NaN : x * 10;
      });
      var lines = internal.traceRasterContours(grid, 0, [15]);
      // Only the cells that avoid the NaN row can be contoured, and a single
      // lattice row on each side of it cannot form a segment on its own.
      lines.forEach(function(line) {
        line.coords.forEach(function(p) {
          assert(p[1] !== 1.5);
        });
      });
    });

    it('produces nothing from a flat raster', function () {
      var grid = makeGrid(5, 5, function() { return 42; });
      assert.deepEqual(internal.traceRasterContours(grid, 0, [42]), []);
    });

    it('reads the requested band', function () {
      var grid = makeGrid(4, 2, function() { return 0; });
      var samples = new Float32Array(4 * 2 * 2);
      var i;
      for (i = 0; i < 8; i++) {
        samples[i * 2] = 0;          // band 0 is flat
        samples[i * 2 + 1] = (i % 4) * 10; // band 1 is a ramp
      }
      grid.bands = 2;
      grid.samples = samples;
      assert.deepEqual(internal.traceRasterContours(grid, 0, [15]), []);
      assert.equal(internal.traceRasterContours(grid, 1, [15]).length, 1);
    });

    it('positions contours half a pixel inside the grid bbox', function () {
      var grid = makeGrid(4, 4, function(x) { return x * 10; });
      grid.bbox = [100, 200, 140, 240]; // 10 map units per pixel
      var lines = internal.traceRasterContours(grid, 0, [15]);
      var bounds = getCoordBounds(lines[0].coords);
      assert.equal(bounds[0], 120); // between centers at 115 and 125
      assert.equal(bounds[1], 205); // center of the bottom row
      assert.equal(bounds[3], 235); // center of the top row
    });
  });

  describe('levels', function () {
    it('picks a round interval when none is given', function () {
      var grid = makeGrid(20, 20, function(x, y) { return 1240 + x * 20 + y; });
      var levels = internal.getContourLevels(grid, 0, {});
      assert(levels.length > 5 && levels.length < 40);
      levels.forEach(function(level) {
        assert.equal(level % 20, 0, level + ' is not a round value');
      });
    });

    it('aligns interval= to base=', function () {
      var grid = makeGrid(10, 2, function(x) { return x * 100; });
      assert.deepEqual(internal.getContourLevels(grid, 0, {interval: 200}),
        [200, 400, 600, 800]);
      assert.deepEqual(internal.getContourLevels(grid, 0, {interval: 200, base: 50}),
        [50, 250, 450, 650, 850]);
    });

    it('sorts and dedupes an explicit levels= list', function () {
      var grid = makeGrid(4, 2, function(x) { return x; });
      assert.deepEqual(internal.getContourLevels(grid, 0, {levels: [5, 1, 5, 3]}),
        [1, 3, 5]);
    });

    it('keeps fractional levels free of floating point noise', function () {
      var grid = makeGrid(10, 2, function(x) { return x * 0.1; });
      var levels = internal.getContourLevels(grid, 0, {interval: 0.1});
      assert.deepEqual(levels, [0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8]);
    });

    it('ignores nodata pixels when measuring the data range', function () {
      var grid = makeGrid(10, 2, function(x, y) {
        return y === 0 ? 1e6 : x * 10;
      }, {nodata: 1e6});
      var range = internal.getRasterSampleRange(grid, 0);
      assert.equal(range.min, 0);
      assert.equal(range.max, 90);
    });

    it('returns no levels for a flat raster', function () {
      var grid = makeGrid(5, 5, function() { return 7; });
      assert.deepEqual(internal.getContourLevels(grid, 0, {}), []);
    });

    it('rejects an interval that would generate too many levels', function () {
      var grid = makeGrid(4, 2, function(x) { return x * 1e6; });
      assert.throws(function () {
        internal.getContourLevels(grid, 0, {interval: 0.001});
      }, /limit is 2000/);
    });

    it('rejects a non-positive interval', function () {
      var grid = makeGrid(4, 2, function(x) { return x; });
      assert.throws(function () {
        internal.getContourLevels(grid, 0, {interval: -5});
      }, /must be a positive number/);
    });
  });

  describe('validation', function () {
    it('rejects a rotated raster', function () {
      var grid = makeGrid(4, 4, function(x) { return x; });
      grid.transform = [1, 0.5, 0, 0.5, -1, 4];
      assert.throws(function () {
        internal.validateRasterGridForContours(grid);
      }, /rotated or skewed/);
    });

    it('rejects a raster too small to contour', function () {
      var grid = makeGrid(1, 4, function(x, y) { return y; });
      assert.throws(function () {
        internal.validateRasterGridForContours(grid);
      }, /too small/);
    });

    it('rejects an out-of-range band', function () {
      var grid = makeGrid(4, 4, function(x) { return x; });
      assert.throws(function () {
        internal.getContourBand(grid, {band: 3});
      }, /this raster has 1 band/);
    });

    it('rejects a non-raster layer', function () {
      var dataset = {
        layers: [{name: 'points', geometry_type: 'point', shapes: [[[0, 0]]]}],
        info: {}
      };
      assert.throws(function () {
        api.cmd.contours(dataset.layers[0], dataset, {interval: 10});
      }, /requires a raster layer/);
    });
  });

  describe('command', function () {
    it('creates a polyline layer with contour values', function () {
      var dataset = makeRasterDataset(makeGrid(5, 3, function(x) { return x * 10; }));
      var layers = api.cmd.contours(dataset.layers[0], dataset, {levels: [15, 25]});
      assert.equal(layers.length, 1);
      assert.equal(layers[0].geometry_type, 'polyline');
      assert.equal(layers[0].shapes.length, 2);
      assert.deepEqual(layers[0].data.getRecords(), [{value: 15}, {value: 25}]);
      // The polylines need arcs, which a raster-only dataset does not have.
      assert(dataset.arcs);
      assert.equal(dataset.arcs.size(), 2);
    });

    it('honours field=', function () {
      var dataset = makeRasterDataset(makeGrid(5, 3, function(x) { return x * 10; }));
      var layers = api.cmd.contours(dataset.layers[0], dataset, {levels: [15], field: 'elev'});
      assert.deepEqual(layers[0].data.getRecords(), [{elev: 15}]);
    });

    it('returns an empty polyline layer when nothing crosses a level', function () {
      var dataset = makeRasterDataset(makeGrid(5, 3, function() { return 5; }));
      var layers = api.cmd.contours(dataset.layers[0], dataset, {levels: [99]});
      assert.equal(layers.length, 1);
      assert.equal(layers[0].geometry_type, 'polyline');
      assert.deepEqual(layers[0].shapes, []);
    });

    it('reads the current samples, not the imported ones', function () {
      // The point of contouring the working store: an in-place edit to the
      // samples, as -blur makes, has to show up in the contours.
      var dataset = makeRasterDataset(makeGrid(5, 3, function(x) { return x * 10; }));
      var lyr = dataset.layers[0];
      var samples = lyr.raster.grid.samples;
      var before = api.cmd.contours(lyr, dataset, {levels: [15]});
      var beforeX = internal.getLayerBounds(before[0], dataset.arcs).xmin;
      var after, afterX, i;
      assert.equal(beforeX, 2);
      for (i = 0; i < samples.length; i++) {
        samples[i] += 3;
      }
      after = api.cmd.contours(lyr, dataset, {levels: [15]});
      afterX = internal.getLayerBounds(after[0], dataset.arcs).xmin;
      assert(afterX < beforeX, 'contour did not move after the samples changed');
    });
  });

  describe('smoothing', function () {
    // A cone quantized to whole units, which is what makes marching squares
    // produce a visible one-pixel staircase.
    function coneDataset(quantize) {
      var grid = makeGrid(60, 60, function(x, y) {
        var v = 100 - Math.sqrt(Math.pow(x - 29.5, 2) + Math.pow(y - 29.5, 2));
        return quantize ? Math.round(v) : v;
      });
      var dataset = makeRasterDataset(grid);
      delete dataset.info.crs_string; // smooth in planar coordinate units
      return dataset;
    }

    function vertexCount(dataset) {
      return dataset.arcs.getPointCount();
    }

    it('smooths contours by default', function () {
      var smoothed = coneDataset(true);
      var raw = coneDataset(true);
      api.cmd.contours(smoothed.layers[0], smoothed, {levels: [80]});
      api.cmd.contours(raw.layers[0], raw, {levels: [80], no_smoothing: true});
      assert(vertexCount(smoothed) < vertexCount(raw),
        'smoothing did not reduce the vertex count (' + vertexCount(smoothed) +
        ' vs ' + vertexCount(raw) + ')');
    });

    it('leaves geometry untouched with no-smoothing', function () {
      var a = coneDataset(true);
      var b = coneDataset(true);
      api.cmd.contours(a.layers[0], a, {levels: [80], no_smoothing: true});
      api.cmd.contours(b.layers[0], b, {levels: [80], no_smoothing: true});
      // Two identical runs must agree exactly, so the comparison below is
      // meaningful rather than incidentally equal.
      assert.equal(vertexCount(a), vertexCount(b));
      assert.deepEqual(internal.traceRasterContours(
        a.layers[0].raster.grid, 0, [80])[0].coords.length, vertexCount(a));
    });

    it('moves contours closer to the true shape of a quantized surface', function () {
      // The level-80 contour of the cone is a circle of radius 20 centered on
      // the grid. Quantizing to whole units puts a staircase on it; smoothing
      // at one pixel should reduce the deviation from the true circle.
      function radialError(dataset) {
        var arcs = dataset.arcs;
        var sum = 0, n = 0;
        var i, iter, r;
        for (i = 0; i < arcs.size(); i++) {
          iter = arcs.getArcIter(i);
          while (iter.hasNext()) {
            r = Math.sqrt(Math.pow(iter.x - 30, 2) + Math.pow(iter.y - 30, 2));
            sum += Math.pow(r - 20, 2);
            n++;
          }
        }
        return Math.sqrt(sum / n);
      }
      var smoothed = coneDataset(true);
      var raw = coneDataset(true);
      api.cmd.contours(smoothed.layers[0], smoothed, {levels: [80]});
      api.cmd.contours(raw.layers[0], raw, {levels: [80], no_smoothing: true});
      assert(radialError(smoothed) < radialError(raw),
        'smoothed contour is further from the true circle (' +
        radialError(smoothed).toFixed(3) + ' vs ' + radialError(raw).toFixed(3) + ')');
    });

    it('selects an interval of one pixel in coordinate units without a CRS', function () {
      var grid = makeGrid(10, 10, function(x) { return x; });
      grid.bbox = [0, 0, 50, 50]; // 5 units per pixel
      assert.equal(internal.getContourSmoothingDistance(grid, null), 5);
    });

    it('converts the interval to meters for a projected CRS', function () {
      var grid = makeGrid(10, 10, function(x) { return x; });
      grid.bbox = [0, 0, 50, 50]; // 5 units per pixel
      assert.equal(internal.getContourSmoothingDistance(grid, {to_meter: 1}), 5);
      // A CRS in feet: five feet per pixel is about 1.524 m.
      assert(Math.abs(internal.getContourSmoothingDistance(
        grid, {to_meter: 0.3048}) - 1.524) < 1e-9);
    });

    it('converts the interval to meters for a lat-long CRS', function () {
      var grid = makeGrid(10, 10, function(x) { return x; });
      // One degree per pixel, centered on the equator where a degree of
      // longitude and a degree of latitude are the same length.
      grid.bbox = [0, -5, 10, 5];
      var d = internal.getContourSmoothingDistance(grid, {is_latlong: true});
      assert(Math.abs(d - 111195) < 500, 'expected about 111km, got ' + d);
    });

    it('does not collapse the interval to zero at the poles', function () {
      var grid = makeGrid(10, 10, function(x) { return x; });
      grid.bbox = [0, 80, 10, 90]; // a degree of longitude is tiny up here
      var d = internal.getContourSmoothingDistance(grid, {is_latlong: true});
      assert(d > 0, 'interval collapsed to ' + d);
    });

    it('averages the two resolutions of a non-square grid', function () {
      var grid = makeGrid(10, 10, function(x) { return x; });
      grid.bbox = [0, 0, 40, 90]; // 4 units per pixel across, 9 down
      assert.equal(internal.getContourSmoothingDistance(grid, null), 6);
    });

    it('picks a sane interval for a one-arcsecond DEM', function () {
      // An SRTM-style tile: 3601 samples of one arcsecond, at latitude 45.
      var grid = makeGrid(8, 8, function(x) { return x; });
      grid.bbox = [10, 45, 10 + 8 / 3600, 45 + 8 / 3600];
      var d = internal.getContourSmoothingDistance(grid, {is_latlong: true});
      assert(d > 20 && d < 32, 'expected roughly 26m, got ' + d);
    });
  });

  describe('CLI', function () {
    it('parses contour options', function () {
      var cmd = internal.parseCommands('-contours interval=100 base=50 band=2 field=elev')[0];
      assert.equal(cmd.name, 'contours');
      assert.equal(cmd.options.interval, 100);
      assert.equal(cmd.options.base, 50);
      assert.equal(cmd.options.band, 2);
      assert.equal(cmd.options.field, 'elev');
    });

    it('parses a levels= list', function () {
      var cmd = internal.parseCommands('-contours levels=0,100,500')[0];
      assert.deepEqual(cmd.options.levels, [0, 100, 500]);
    });

    it('parses the no-smoothing flag', function () {
      assert.equal(internal.parseCommands('-contours interval=10')[0]
        .options.no_smoothing, undefined);
      assert.equal(internal.parseCommands('-contours interval=10 no-smoothing')[0]
        .options.no_smoothing, true);
    });

    it('converts a GeoTIFF to contour lines', async function () {
      var out = await api.applyCommands(
        '-i ' + GEOTIFF + ' -contours levels=100 -o out.json', {});
      var geojson = JSON.parse(out['out.json']);
      assert.equal(geojson.features.length, 1);
      assert.equal(geojson.features[0].geometry.type, 'LineString');
      assert.equal(geojson.features[0].properties.value, 100);
    });

    it('replaces the raster layer by default', async function () {
      // A second -contours run against the raster fails once it is gone.
      await assert.rejects(function () {
        return api.applyCommands('-i ' + GEOTIFF +
          ' -contours levels=100 -contours levels=150 -o out.json', {});
      }, /requires a raster layer/);
    });

    it('keeps the raster layer when + is used', async function () {
      var out = await api.applyCommands('-i ' + GEOTIFF +
        ' -contours levels=100 + name=iso' +
        ' -contours target=wgs84-geographic-epsg4326 levels=150 + name=iso2' +
        ' -o target=iso2 out.json', {});
      var geojson = JSON.parse(out['out.json']);
      assert.equal(geojson.features[0].properties.value, 150);
    });
  });
});
