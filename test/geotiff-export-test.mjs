import api from '../mapshaper.js';
import assert from 'assert';
import { fromArrayBuffer } from 'geotiff';

var encodeGeoTIFF = api.internal.encodeGeoTIFF;
var WGS84_GEOTIFF_FIXTURE = 'test/data/geotiff/wgs84-geographic-epsg4326.tif';

describe('GeoTIFF export', function () {

  describe('encoder', function () {
    it('round-trips a single-band float grid with a nodata value', async function () {
      var grid = makeGrid({
        width: 4,
        height: 3,
        samples: new Float32Array([
          -9999, 101.5, 102.5, 103.5,
          104.5, 105.5, 106.5, 107.5,
          108.5, 109.5, 110.5, 111.5
        ]),
        nodata: -9999,
        bbox: [500000, 4000000, 500400, 4000300]
      });
      var image = await decode(grid, {ProjectedCSTypeGeoKey: 32615});

      assert.equal(image.getWidth(), 4);
      assert.equal(image.getHeight(), 3);
      assert.equal(image.getSamplesPerPixel(), 1);
      assert.equal(image.getSampleFormat(), 3); // floating point
      assert.deepEqual(image.getBitsPerSample(), 32);
      assert.equal(+image.getGDALNoData(), -9999);
      assert.deepEqual(image.getBoundingBox(), [500000, 4000000, 500400, 4000300]);
      assert.deepEqual(await readSamples(image), Array.from(grid.samples));
    });

    it('round-trips an RGB grid', async function () {
      var grid = makeGrid({
        width: 3,
        height: 2,
        bands: 3,
        samples: new Uint8Array([
          255, 0, 0, 0, 255, 0, 0, 0, 255,
          255, 255, 0, 0, 255, 255, 255, 0, 255
        ]),
        bbox: [-30, -20, 30, 20]
      });
      var image = await decode(grid, {GeographicTypeGeoKey: 4326});

      assert.equal(image.getSamplesPerPixel(), 3);
      assert.equal(getTag(image, 'PhotometricInterpretation'), 2); // RGB
      assert.equal(getTag(image, 'ExtraSamples'), undefined);
      assert.deepEqual(await readSamples(image), Array.from(grid.samples));
    });

    it('flags the fourth band of an RGBA grid as alpha', async function () {
      var grid = makeGrid({
        width: 2,
        height: 1,
        bands: 4,
        samples: new Uint8Array([10, 20, 30, 255, 40, 50, 60, 128]),
        bbox: [0, 0, 2, 1]
      });
      var image = await decode(grid, {GeographicTypeGeoKey: 4326});

      assert.equal(getTag(image, 'PhotometricInterpretation'), 2);
      assert.deepEqual(Array.from(getTag(image, 'ExtraSamples')), [2]); // unassociated alpha
      assert.deepEqual(await readSamples(image), Array.from(grid.samples));
    });

    it('marks bands beyond the first of a multiband measurement grid as extra', async function () {
      var grid = makeGrid({
        width: 1,
        height: 1,
        bands: 2,
        samples: new Int16Array([-5, 700]),
        bbox: [0, 0, 1, 1]
      });
      var image = await decode(grid, {});

      assert.equal(getTag(image, 'PhotometricInterpretation'), 1); // black is zero
      assert.deepEqual(Array.from(getTag(image, 'ExtraSamples')), [0]); // unspecified
    });

    // The geotiff package's own writer mistypes signed samples, so these are
    // the types most in need of a check.
    [
      ['Int16Array', new Int16Array([-32768, -100, 0, 32767]), 2, 16],
      ['Int32Array', new Int32Array([-2000000, -1, 0, 2000000]), 2, 32],
      ['Uint8Array', new Uint8Array([0, 1, 128, 255]), 1, 8],
      ['Uint16Array', new Uint16Array([0, 300, 40000, 65535]), 1, 16],
      ['Uint32Array', new Uint32Array([0, 70000, 4e9, 12]), 1, 32],
      ['Float32Array', new Float32Array([-1.5, 0, 0.25, 1234.5]), 3, 32],
      ['Float64Array', new Float64Array([-1.5, 0, 1 / 3, 1e300]), 3, 64]
    ].forEach(function(test) {
      var name = test[0];
      it('round-trips ' + name + ' samples', async function () {
        var grid = makeGrid({
          width: 2,
          height: 2,
          samples: test[1],
          bbox: [0, 0, 2, 2]
        });
        var image = await decode(grid, {});
        assert.equal(image.getSampleFormat(), test[2]);
        assert.equal(image.getBitsPerSample(), test[3]);
        assert.deepEqual(await readSamples(image), Array.from(test[1]));
      });
    });

    it('splits a large grid into strips, compressed or not', async function () {
      var samples = new Float32Array(300 * 400);
      var i;
      for (i = 0; i < samples.length; i++) samples[i] = i % 977;
      var grid = makeGrid({
        width: 300,
        height: 400,
        samples: samples,
        bbox: [0, 0, 300, 400]
      });
      var deflated = encode(grid, {});
      var stored = encode(grid, {}, {compress: false});
      var image = await decodeBytes(deflated);
      var rawImage = await decodeBytes(stored);

      var rowsPerStrip = getTag(image, 'RowsPerStrip');
      assert(rowsPerStrip < 400);
      assert.equal(Object.keys(getTag(image, 'StripOffsets')).length,
        Math.ceil(400 / rowsPerStrip));
      assert.equal(getTag(image, 'Compression'), 8); // deflate
      assert.equal(getTag(rawImage, 'Compression'), 1); // none
      assert(deflated.length < stored.length / 2);
      assert.deepEqual(await readSamples(image), Array.from(samples));
      assert.deepEqual(await readSamples(rawImage), Array.from(samples));
    });

    it('writes the geo keys it is given', async function () {
      var image = await decode(makeGrid({}), {
        GTModelTypeGeoKey: 1,
        GTRasterTypeGeoKey: 1,
        ProjectedCSTypeGeoKey: 32615
      });
      var keys = image.getGeoKeys();
      assert.equal(keys.GTModelTypeGeoKey, 1);
      assert.equal(keys.GTRasterTypeGeoKey, 1); // pixel is area
      assert.equal(keys.ProjectedCSTypeGeoKey, 32615);
    });

    it('omits the nodata tag when a grid has no nodata value', async function () {
      var image = await decode(makeGrid({nodata: null}), {});
      assert.strictEqual(image.getGDALNoData(), null);
    });
  });

  describe('command', function () {
    it('writes a raster layer to a .tif file', async function () {
      var out = await api.applyCommands('-i ' + WGS84_GEOTIFF_FIXTURE + ' -o out.tif');
      var image = await decodeBytes(out['out.tif']);
      assert.deepEqual(Object.keys(out), ['out.tif']);
      assert.equal(image.getWidth(), 2);
      assert.equal(image.getHeight(), 2);
      assert.equal(image.getGeoKeys().GeographicTypeGeoKey, 4326);
      assert.deepEqual(image.getBoundingBox(), [-180, -90, 180, 90]);
    });

    it('is chosen by a .tiff extension and by format=geotiff', async function () {
      var byExtension = await api.applyCommands('-i ' + WGS84_GEOTIFF_FIXTURE + ' -o out.tiff');
      var byFormat = await api.applyCommands('-i ' + WGS84_GEOTIFF_FIXTURE + ' -o format=geotiff');
      assert(await decodeBytes(byExtension['out.tiff']));
      assert(await decodeBytes(byFormat['wgs84-geographic-epsg4326.tif']));
    });

    it('exports the current pixels, not the imported ones', async function () {
      var out = await api.applyCommands('-i ' + WGS84_GEOTIFF_FIXTURE +
        ' -clip bbox=-180,-90,0,90 -o out.tif');
      var image = await decodeBytes(out['out.tif']);
      assert.equal(image.getWidth(), 1);
      assert.deepEqual(image.getBoundingBox(), [-180, -90, 0, 90]);
    });

    it('stores an EPSG code recognized from a projection alias', async function () {
      var out = await api.applyCommands('-i ' + WGS84_GEOTIFF_FIXTURE +
        ' -proj wgs84 -o out.tif');
      var image = await decodeBytes(out['out.tif']);
      assert.equal(image.getGeoKeys().GeographicTypeGeoKey, 4326);
      assert.equal(image.getGeoKeys().GTModelTypeGeoKey, 2); // geographic
    });

    // Only an EPSG code fits in the geo keys this writer supports, so a CRS
    // without one has to travel in a sidecar.
    it('writes a CRS with no EPSG code to an .aux.xml sidecar', async function () {
      var out = await api.applyCommands('-i ' + WGS84_GEOTIFF_FIXTURE +
        ' -proj eqc -o out.tif');
      var image = await decodeBytes(out['out.tif']);
      var aux = String(out['out.tif.aux.xml']);
      assert.deepEqual(Object.keys(out).sort(), ['out.tif', 'out.tif.aux.xml']);
      assert(aux.includes('<SRS>'));
      assert(aux.includes('Equidistant Cylindrical'));
      // The grid is still georeferenced, just not identified.
      assert.equal(image.getGeoKeys().ProjectedCSTypeGeoKey, 32767); // user-defined
      assert.equal(image.getGeoKeys().GTModelTypeGeoKey, 1); // projected
    });

    it('accepts compression=none and rejects an unknown setting', async function () {
      var out = await api.applyCommands('-i ' + WGS84_GEOTIFF_FIXTURE +
        ' -o out.tif compression=none');
      var image = await decodeBytes(out['out.tif']);
      assert.equal(getTag(image, 'Compression'), 1);
      await assert.rejects(async function() {
        await api.applyCommands('-i ' + WGS84_GEOTIFF_FIXTURE + ' -o out.tif compression=lzw');
      }, /Unsupported GeoTIFF compression/);
    });

    it('rejects vector layers', async function () {
      await assert.rejects(async function() {
        await api.applyCommands('-i test/data/geojson/two_states.json -o out.tif');
      }, /GeoTIFF output requires raster layers/);
    });

    it('rejects other formats for raster layers, naming GeoTIFF as an option', async function () {
      await assert.rejects(async function() {
        await api.applyCommands('-i ' + WGS84_GEOTIFF_FIXTURE + ' -o out.json');
      }, /exported as GeoTIFF/);
    });
  });
});

function makeGrid(opts) {
  var grid = Object.assign({
    width: 2,
    height: 2,
    bands: 1,
    samples: new Uint8Array([1, 2, 3, 4]),
    nodata: null,
    bbox: [0, 0, 2, 2]
  }, opts);
  grid.transform = [
    (grid.bbox[2] - grid.bbox[0]) / grid.width, 0, grid.bbox[0],
    0, (grid.bbox[1] - grid.bbox[3]) / grid.height, grid.bbox[3]
  ];
  return grid;
}

function encode(grid, geoKeys, opts) {
  return encodeGeoTIFF(grid, Object.assign({geoKeys: geoKeys}, opts || {}));
}

async function decode(grid, geoKeys, opts) {
  return decodeBytes(encode(grid, geoKeys, opts));
}

// This build of geotiff.js resolves tags lazily, so a tag has to be read
// through the file directory's accessor rather than as a property.
function getTag(image, name) {
  return image.getFileDirectory().getValue(name);
}

async function decodeBytes(bytes) {
  var buf = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.length);
  var tiff = await fromArrayBuffer(buf);
  return tiff.getImage();
}

// Returns every sample in the image, in the band-interleaved order that
// mapshaper's grids use.
async function readSamples(image) {
  var arr = await image.readRasters({interleave: true});
  return Array.from(arr);
}
