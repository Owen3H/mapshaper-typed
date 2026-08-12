import { expect, test } from '@playwright/test';

// feature 0 is a ring: [0,0] [4,0] [4,4] [0,4] [0,0]
// feature 1 is an open line: [10,0] [11,0] [14,0]
var SNIP_FIXTURE = 'test/data/features/snip/ring_and_line.json';

function vertexCut(seq, offset) {
  return {seq: seq, offset: offset, point: null, displayPoint: null, t: 0};
}

test('snipping an open line is undoable', async function({page}) {
  var errors = collectPageErrors(page);
  await loadFixture(page, SNIP_FIXTURE);
  var before = await getChecksum(page);

  await snip(page, 1, 0, [vertexCut(0, 1)]);
  var after = await getChecksum(page);
  expect(after.datasets[0].layers[0].shapeCount).toBe(3);
  expect(after.checksum).not.toBe(before.checksum);

  await undo(page);
  var restored = await getChecksum(page);
  expect(restored.datasets[0].layers[0].shapeCount).toBe(2);
  expect(restored.checksum).toBe(before.checksum);
  expect(errors).toEqual([]);
});

test('snipping a ring at two places is undoable', async function({page}) {
  var errors = collectPageErrors(page);
  await loadFixture(page, SNIP_FIXTURE);
  var before = await getChecksum(page);

  // the two cuts divide the ring into two open paths
  await snip(page, 0, 0, [vertexCut(0, 1), vertexCut(0, 2)]);
  var after = await getChecksum(page);
  expect(after.datasets[0].layers[0].shapeCount).toBe(3);
  expect(after.datasets[0].arcCount).toBeGreaterThan(before.datasets[0].arcCount);

  await undo(page);
  var restored = await getChecksum(page);
  expect(restored.datasets[0].layers[0].shapeCount).toBe(2);
  expect(restored.datasets[0].arcCount).toBe(before.datasets[0].arcCount);
  // an exact round trip: shapes, records and arc coordinates all match
  expect(restored.checksum).toBe(before.checksum);
  expect(errors).toEqual([]);
});

test('a snipped ring can be redone and undone again', async function({page}) {
  var errors = collectPageErrors(page);
  await loadFixture(page, SNIP_FIXTURE);
  var before = await getChecksum(page);

  await snip(page, 0, 0, [vertexCut(0, 1), vertexCut(0, 2)]);
  var snipped = await getChecksum(page);

  await undo(page);
  expect((await getChecksum(page)).checksum).toBe(before.checksum);

  await redo(page);
  expect((await getChecksum(page)).checksum).toBe(snipped.checksum);

  await undo(page);
  expect((await getChecksum(page)).checksum).toBe(before.checksum);
  expect(errors).toEqual([]);
});

test('snips accumulate and unwind one at a time', async function({page}) {
  var errors = collectPageErrors(page);
  await loadFixture(page, SNIP_FIXTURE);
  var before = await getChecksum(page);

  await snip(page, 0, 0, [vertexCut(0, 1), vertexCut(0, 2)]);
  var afterFirst = await getChecksum(page);
  await snip(page, 1, 0, [vertexCut(0, 1)]);
  expect((await getChecksum(page)).datasets[0].layers[0].shapeCount).toBe(4);

  await undo(page);
  expect((await getChecksum(page)).checksum).toBe(afterFirst.checksum);
  await undo(page);
  expect((await getChecksum(page)).checksum).toBe(before.checksum);
  expect(errors).toEqual([]);
});

function collectPageErrors(page) {
  var errors = [];
  page.on('pageerror', function(err) {
    errors.push(String(err.message || err));
  });
  return errors;
}

async function loadFixture(page, fixture) {
  await page.goto('/?undo=on&undo-test=on&files=' + encodeURIComponent(fixture));
  await page.waitForFunction(function() {
    return window.mapshaper && window.mapshaper.undoTest;
  });
  await page.waitForFunction(function() {
    return window.mapshaper.undoTest.getState().model.datasetCount > 0;
  });
  await page.evaluate(function() {
    window.mapshaper.undoTest.clearUndoHistory();
    window.mapshaper.undoTest.setInteractionMode('snip_lines');
  });
}

async function snip(page, fid, partId, cuts) {
  return page.evaluate(function(args) {
    return window.mapshaper.undoTest.snipActiveLayerPath(args.fid, args.partId, args.cuts);
  }, {fid: fid, partId: partId, cuts: cuts});
}

async function undo(page) {
  await page.evaluate(function() {
    window.mapshaper.undoTest.undo();
  });
}

async function redo(page) {
  await page.evaluate(function() {
    window.mapshaper.undoTest.redo();
  });
}

async function getChecksum(page) {
  return page.evaluate(function() {
    return window.mapshaper.undoTest.getModelChecksum();
  });
}
