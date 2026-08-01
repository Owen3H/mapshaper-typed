import { expect, test } from '@playwright/test';

var REQUIRE_ERROR_RX = /require is not defined/i;
var FIXTURES = [{
  name: 'GeoJSON',
  files: 'test/data/geojson/three_points.geojson'
}, {
  name: 'FlatGeobuf',
  files: 'test/data/flatgeobuf/countries.fgb'
}, {
  name: 'GeoParquet',
  files: 'test/data/geoparquet/example-crs_vermont-4326_geo.parquet'
}];

FIXTURES.forEach(function(fixture) {
  test('GUI imports ' + fixture.name + ' fixture', async function({page}) {
    var pageErrors = [];
    var consoleErrors = [];
    var result;

    page.on('pageerror', function(err) {
      pageErrors.push(String(err && err.message || err));
    });
    page.on('console', function(msg) {
      if (msg.type() == 'error') {
        consoleErrors.push(msg.text());
      }
    });

    await page.goto('/?undo=on&undo-test=on&files=' + encodeURIComponent(fixture.files));
    result = await getImportResult(page);

    expect(result.datasetCount).toBeGreaterThan(0);
    expect(result.layerCount).toBeGreaterThan(0);
    expect(result.errorMessages).toEqual([]);
    expect(containsRequireError(pageErrors)).toBe(false);
    expect(containsRequireError(consoleErrors)).toBe(false);
  });
});

test('GUI imports multiple fixtures in one session', async function({page}) {
  var files = [
    'test/data/geojson/three_points.geojson',
    'test/data/features/clean/ex20_ogc_line.json'
  ].join(',');
  var result;

  await page.goto('/?undo=on&undo-test=on&files=' + encodeURIComponent(files));
  result = await getImportResult(page);

  expect(result.datasetCount).toBeGreaterThan(0);
  expect(result.layerCount).toBeGreaterThanOrEqual(2);
  expect(result.errorMessages).toEqual([]);
});

// A raster whose CRS mapshaper cannot read is still a picture with a known
// place in its own coordinates, so it is drawn. It used to be loaded but never
// drawn: the modal popup about its CRS took the app out of import mode, and
// leaving import mode is what draws what was imported.
test('GUI displays a raster with no readable CRS', async function({page}) {
  var files = 'test/data/geotiff/no-crs-rgb-3x3.tif';
  await page.goto('/?undo=on&undo-test=on&files=' + encodeURIComponent(files));
  await getImportResult(page);

  await expect(page.locator('.alert-box')).toHaveCount(0);
  await expect.poll(function() {
    return getPaintedMapPixels(page);
  }).toBeGreaterThan(1000);
});

// The number of pixels the map canvases have drawn anything into.
function getPaintedMapPixels(page) {
  return page.evaluate(function() {
    return Array.from(document.querySelectorAll('.map-layers canvas')).reduce(
      function(memo, canvas) {
        var data = canvas.getContext('2d').getImageData(
          0, 0, canvas.width, canvas.height).data;
        var count = 0;
        for (var i = 3; i < data.length; i += 4) {
          if (data[i] > 0) count++;
        }
        return memo + count;
      }, 0);
  });
}

async function getImportResult(page) {
  await page.waitForFunction(function() {
    return window.mapshaper &&
      window.mapshaper.undoTest &&
      window.mapshaper.undoTest.getState().model.datasetCount > 0;
  });
  return page.evaluate(function() {
    var state = window.mapshaper.undoTest.getState();
    var messages = window.mapshaper.undoTest.getMessages();
    return {
      datasetCount: state.model.datasetCount,
      layerCount: state.model.layerCount,
      errorMessages: messages.filter(function(item) {
        return item && item.severity == 'error';
      })
    };
  });
}

function containsRequireError(messages) {
  return messages.some(function(msg) {
    return REQUIRE_ERROR_RX.test(msg);
  });
}
