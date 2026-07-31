import { expect, test } from '@playwright/test';

var SOURCE_FIXTURE = 'test/data/geojson/three_points.geojson';
var RASTER_FIXTURE = 'test/data/geotiff/wgs84-geographic-epsg4326.tif';

test('GUI exports GeoJSON file', async function({page}) {
  await loadFixture(page, SOURCE_FIXTURE);
  await openExportMenu(page);
  await selectExportFormat(page, 'geojson');
  await clearAdvancedOptions(page);
  var download = await triggerExportDownload(page);
  expect(download.suggestedFilename()).toMatch(/\.(geojson|json)$/i);
  var errors = await getExportErrors(page);
  expect(errors).toEqual([]);
});

test('GUI exports FlatGeobuf file', async function({page}) {
  await loadFixture(page, SOURCE_FIXTURE);
  await openExportMenu(page);
  await selectExportFormat(page, 'flatgeobuf');
  await clearAdvancedOptions(page);
  var download = await triggerExportDownload(page);
  expect(download.suggestedFilename()).toMatch(/\.fgb$/i);
  var errors = await getExportErrors(page);
  expect(errors).toEqual([]);
});

test('GUI exports GeoParquet with zstd option', async function({page}) {
  await loadFixture(page, SOURCE_FIXTURE);
  await openExportMenu(page);
  await selectExportFormat(page, 'geoparquet');
  await setAdvancedOptions(page, 'compression=zstd level=10');
  var download = await triggerExportDownload(page);
  expect(download.suggestedFilename()).toMatch(/\.parquet$/i);
  var errors = await getExportErrors(page);
  expect(errors).toEqual([]);
});

// GeoTIFF is offered only for raster layers, and its deflate compression takes
// a different code path in the browser than in Node.
test('GUI exports GeoTIFF file for a raster layer', async function({page}) {
  await loadFixture(page, RASTER_FIXTURE);
  await openExportMenu(page);
  await selectExportFormat(page, 'geotiff');
  await clearAdvancedOptions(page);
  var download = await triggerExportDownload(page);
  expect(download.suggestedFilename()).toMatch(/\.tif$/i);
  var errors = await getExportErrors(page);
  expect(errors).toEqual([]);
});

test('GUI does not offer GeoTIFF for a vector layer', async function({page}) {
  await loadFixture(page, SOURCE_FIXTURE);
  await openExportMenu(page);
  await expect(page.locator('.export-formats input[value="geotiff"]')).toHaveCount(0);
});

async function loadFixture(page, fixture) {
  await page.goto('/?undo=on&undo-test=on&files=' + encodeURIComponent(fixture));
  await page.waitForFunction(function() {
    return window.mapshaper &&
      window.mapshaper.undoTest &&
      window.mapshaper.undoTest.getState().model.datasetCount > 0;
  });
}

async function openExportMenu(page) {
  await page.locator('.export-btn').click();
  await expect(page.locator('.export-options')).toBeVisible();
}

async function selectExportFormat(page, format) {
  await page.locator('.export-formats input[value="' + format + '"]').check();
}

async function setAdvancedOptions(page, text) {
  var input = page.locator('.export-options .advanced-options');
  await input.click();
  await input.fill(text);
}

async function clearAdvancedOptions(page) {
  await setAdvancedOptions(page, '');
}

async function triggerExportDownload(page) {
  var downloadPromise = page.waitForEvent('download');
  await page.locator('.export-options #export-btn').click();
  return downloadPromise;
}

async function getExportErrors(page) {
  return page.evaluate(function() {
    return window.mapshaper.undoTest.getMessages().filter(function(item) {
      return item && item.severity == 'error';
    });
  });
}
