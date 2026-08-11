import assert from 'assert';
import { createRequire } from 'module';

var api = createRequire(import.meta.url)('../mapshaper.js');
var ArcCollection = api.internal.ArcCollection;
var DataTable = api.internal.DataTable;

// A minimal stand-in for a map layer: not dynamically reprojected, so the
// display arcs and the source arcs are the same collection.
function makeLayer(arcData, shapes, records) {
  var arcs = new ArcCollection(arcData);
  return {
    geometry_type: 'polyline',
    shapes: shapes,
    data: records ? new DataTable(records) : null,
    gui: {
      source: {dataset: {arcs: arcs}},
      displayArcs: arcs
    }
  };
}

function getArcs(lyr) {
  return lyr.gui.source.dataset.arcs;
}

function getShapeCoords(lyr, fid) {
  return lyr.shapes[fid].map(function(path) {
    var iter = getArcs(lyr).getShapeIter(path);
    var coords = [];
    while (iter.hasNext()) coords.push([iter.x, iter.y]);
    return coords;
  });
}

function vertexCut(seq, offset) {
  return {seq: seq, offset: offset, point: null, displayPoint: null, t: 0};
}

function pointCut(seq, offset, point, t) {
  return {seq: seq, offset: offset, point: point, displayPoint: point, t: t || 0};
}

describe('gui-snipping-utils.mjs', function() {

  it('divides an open line into two features', async function() {
    var utils = await importSnippingUtils();
    var lyr = makeLayer([[[0, 0], [1, 0], [2, 0], [3, 0], [4, 0]]], [[[0]]],
      [{name: 'A', id: 7}]);
    var result = utils.snipPath(lyr, 0, 0, [vertexCut(0, 1)]);

    assert.equal(lyr.shapes.length, 2);
    // the longer piece stays at the original feature id
    assert.deepEqual(getShapeCoords(lyr, 0), [[[1, 0], [2, 0], [3, 0], [4, 0]]]);
    assert.deepEqual(getShapeCoords(lyr, 1), [[[0, 0], [1, 0]]]);
    assert.equal(result.newFeatureId, 1);
    assert.equal(result.appendedArcCount, 2);
  });

  it('duplicates the attributes of the snipped feature', async function() {
    var utils = await importSnippingUtils();
    var lyr = makeLayer([[[0, 0], [1, 0], [2, 0], [3, 0], [4, 0]]], [[[0]]],
      [{name: 'A', id: 7}]);
    utils.snipPath(lyr, 0, 0, [vertexCut(0, 1)]);
    var records = lyr.data.getRecords();

    assert.equal(records.length, 2);
    assert.deepEqual(records[1], {name: 'A', id: 7});
    assert.ok(records[1] !== records[0]); // a copy, not a shared reference
  });

  it('cuts a segment between two vertices', async function() {
    var utils = await importSnippingUtils();
    var lyr = makeLayer([[[0, 0], [1, 0], [4, 0]]], [[[0]]], [{}]);
    utils.snipPath(lyr, 0, 0, [pointCut(0, 1, [3, 0], 0.667)]);

    assert.deepEqual(getShapeCoords(lyr, 0), [[[0, 0], [1, 0], [3, 0]]]);
    assert.deepEqual(getShapeCoords(lyr, 1), [[[3, 0], [4, 0]]]);
  });

  it('splits off the shorter path, leaving the rest of a multipart feature intact',
    async function() {
      var utils = await importSnippingUtils();
      var lyr = makeLayer([
        [[0, 0], [1, 0], [10, 0]],
        [[0, 5], [5, 5]]
      ], [[[0], [1]]], [{name: 'A'}]);
      var result = utils.snipPath(lyr, 0, 0, [vertexCut(0, 1)]);

      // the longer half stays in the multipart feature, alongside the other part
      assert.deepEqual(getShapeCoords(lyr, 0), [
        [[1, 0], [10, 0]],
        [[0, 5], [5, 5]]
      ]);
      assert.deepEqual(getShapeCoords(lyr, 1), [[[0, 0], [1, 0]]]);
      assert.equal(result.partId, 0);
    });

  it('divides at a node between arcs without adding any arcs', async function() {
    var utils = await importSnippingUtils();
    var lyr = makeLayer([
      [[0, 0], [1, 0], [2, 0]],
      [[2, 0], [3, 0], [6, 0]]
    ], [[[0, 1]]], [{}]);
    var result = utils.snipPath(lyr, 0, 0, [vertexCut(0, 2)]);

    assert.equal(result.appendedArcCount, 0);
    assert.equal(getArcs(lyr).size(), 2);
    assert.deepEqual(getShapeCoords(lyr, 0), [[[2, 0], [3, 0], [6, 0]]]);
    assert.deepEqual(getShapeCoords(lyr, 1), [[[0, 0], [1, 0], [2, 0]]]);
  });

  it('divides a ring into two open paths at two cuts', async function() {
    var utils = await importSnippingUtils();
    var lyr = makeLayer([[[0, 0], [4, 0], [4, 4], [0, 4], [0, 0]]], [[[0]]], [{}]);
    utils.snipPath(lyr, 0, 0, [vertexCut(0, 1), vertexCut(0, 2)]);

    assert.deepEqual(getShapeCoords(lyr, 0), [[[4, 4], [0, 4], [0, 0], [4, 0]]]);
    assert.deepEqual(getShapeCoords(lyr, 1), [[[4, 0], [4, 4]]]);
  });

  it('refuses to divide an open path at its endpoints', async function() {
    var utils = await importSnippingUtils();
    var lyr = makeLayer([[[0, 0], [1, 0], [2, 0]]], [[[0]]], [{}]);

    assert.strictEqual(utils.snipPath(lyr, 0, 0, [vertexCut(0, 0)]), null);
    assert.strictEqual(utils.snipPath(lyr, 0, 0, [vertexCut(0, 2)]), null);
    assert.equal(lyr.shapes.length, 1);
    assert.equal(getArcs(lyr).size(), 1);
  });

  it('undo restores shapes, attributes and arcs', async function() {
    var utils = await importSnippingUtils();
    var lyr = makeLayer([[[0, 0], [1, 0], [2, 0], [3, 0], [4, 0]]], [[[0]]],
      [{name: 'A'}]);
    var before = getShapeCoords(lyr, 0);
    var result = utils.snipPath(lyr, 0, 0, [pointCut(0, 2, [2.5, 0], 0.5)]);

    utils.undoSnip(lyr, result);
    assert.equal(lyr.shapes.length, 1);
    assert.equal(lyr.data.getRecords().length, 1);
    assert.equal(getArcs(lyr).size(), 1);
    assert.equal(getArcs(lyr).getPointCount(), 5);
    assert.deepEqual(getShapeCoords(lyr, 0), before);
  });

  it('a snip can be redone with the same cuts after an undo', async function() {
    var utils = await importSnippingUtils();
    var lyr = makeLayer([[[0, 0], [1, 0], [2, 0], [3, 0], [4, 0]]], [[[0]]], [{}]);
    var result = utils.snipPath(lyr, 0, 0, [vertexCut(0, 1)]);
    var snipped = [getShapeCoords(lyr, 0), getShapeCoords(lyr, 1)];

    utils.undoSnip(lyr, result);
    result = utils.snipPath(lyr, 0, 0, result.cuts);
    assert.deepEqual([getShapeCoords(lyr, 0), getShapeCoords(lyr, 1)], snipped);

    utils.undoSnip(lyr, result);
    assert.equal(lyr.shapes.length, 1);
    assert.equal(getArcs(lyr).size(), 1);
  });

  it('undo unwinds a series of snips', async function() {
    var utils = await importSnippingUtils();
    var lyr = makeLayer([[[0, 0], [1, 0], [2, 0], [3, 0], [4, 0]]], [[[0]]], [{}]);
    var before = getShapeCoords(lyr, 0);
    var a = utils.snipPath(lyr, 0, 0, [vertexCut(0, 1)]);
    var b = utils.snipPath(lyr, 0, 0, [vertexCut(0, 1)]);

    assert.equal(lyr.shapes.length, 3);
    utils.undoSnip(lyr, b);
    utils.undoSnip(lyr, a);
    assert.equal(lyr.shapes.length, 1);
    assert.equal(getArcs(lyr).size(), 1);
    assert.deepEqual(getShapeCoords(lyr, 0), before);
  });
});

var importedUtils;

async function importSnippingUtils() {
  if (!importedUtils) {
    Object.defineProperty(global, 'window', {
      value: {mapshaper: api},
      configurable: true
    });
    Object.defineProperty(global, 'document', {
      value: {createElement: function() { return {style: {cssText: ''}}; }},
      configurable: true
    });
    importedUtils = import('../src/gui/gui-snipping-utils');
  }
  return importedUtils;
}
