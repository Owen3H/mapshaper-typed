import api from '../mapshaper.js';
import assert from 'assert';
import fs from 'fs';

var aux = api.internal;

describe('GeoTIFF .aux.xml sidecars', function () {

  describe('parseAuxCrsString()', function () {
    it('reads the SRS a sidecar carries', function () {
      var xml = aux.formatAuxXml('+proj=moll +ellps=WGS84');
      assert.equal(aux.parseAuxCrsString(xml), '+proj=moll +ellps=WGS84');
    });

    it('unescapes markup characters in the SRS', function () {
      var wkt = 'PROJCS["a & b",EXTENSION["PROJ4","+proj=moll <x>"]]';
      assert.equal(aux.parseAuxCrsString(aux.formatAuxXml(wkt)), wkt);
    });

    it('reads a sidecar that says more than the SRS', function () {
      var xml = '<PAMDataset>\n<Metadata><MDI key="k">v</MDI></Metadata>\n' +
        '<SRS dataAxisToSRSAxisMapping="1,2">EPSG:3857</SRS>\n' +
        '<PAMRasterBand band="1"><Histograms/></PAMRasterBand>\n</PAMDataset>';
      assert.equal(aux.parseAuxCrsString(xml), 'EPSG:3857');
    });

    it('returns null for a sidecar with no SRS, and for junk', function () {
      assert.strictEqual(aux.parseAuxCrsString('<PAMDataset></PAMDataset>'), null);
      assert.strictEqual(aux.parseAuxCrsString('<PAMDataset><SRS></SRS></PAMDataset>'), null);
      assert.strictEqual(aux.parseAuxCrsString(''), null);
      assert.strictEqual(aux.parseAuxCrsString(null), null);
    });
  });

  describe('file naming', function () {
    it('names the sidecar after the whole raster filename', function () {
      assert.equal(aux.getAuxFilename('dir/world.tif'), 'dir/world.tif.aux.xml');
      assert.equal(aux.getAuxSourceFilename('dir/world.tif.aux.xml'), 'dir/world.tif');
    });

    // The .xml extension is the sidecar's, not the raster's, so the type has to
    // be recognized from the whole name.
    it('recognizes a sidecar as an auxiliary input file', function () {
      assert.equal(aux.guessInputFileType('world.tif.aux.xml'), 'aux');
      assert.equal(aux.isAuxiliaryInputFileType('aux'), true);
      // Kept when unpacking a zip, so it arrives with the raster it belongs to.
      assert.equal(aux.looksLikeContentFile('world.tif.aux.xml'), true);
    });

    it('does not mistake other XML for a sidecar', function () {
      assert.equal(aux.guessInputFileType('world.xml'), null);
      assert.equal(aux.isAuxFilename('world.xml'), false);
    });
  });

  // GDAL and mapshaper both write WKT2 where they can, and fall back to WKT1
  // for a projection WKT2 has no method for.
  it('reads a sidecar written in WKT2', async function () {
    var dataset = await api.internal.importFileAsync(
      'test/data/geotiff/moll-aux-sidecar.tif', {});
    assert(dataset.info.crs_string.startsWith('+proj=moll'),
      'read as ' + dataset.info.crs_string);
    assert(dataset.info.wkt1.startsWith('PROJCRS['));
  });

  it('reads a sidecar that states a CRS as a code rather than WKT', async function () {
    var dataset = await api.internal.importFileAsync('out.tif', {input: {
      'out.tif': fs.readFileSync('test/data/geotiff/moll-aux-sidecar.tif'),
      'out.tif.aux.xml': aux.formatAuxXml('EPSG:3857')
    }});
    assert.equal(dataset.info.crs_string, 'EPSG:3857');
    assert.equal(dataset.info.wkt1, undefined);
  });

  // A sidecar on its own has no pixels, only a projection, which is worth
  // reading rather than refusing.
  it('imports a lone sidecar as a CRS with no layers', async function () {
    var out = await api.applyCommands('-i world.tif.aux.xml -o out.json', {
      'world.tif.aux.xml': aux.formatAuxXml('+proj=moll +ellps=WGS84')
    });
    assert.deepEqual(Object.keys(out), []);
  });
});
