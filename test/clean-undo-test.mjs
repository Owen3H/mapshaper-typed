import assert from 'assert';
import api from '../mapshaper.js';

var internal = api.internal;

// -clean partitions multi-feature gaps by adding cut arcs, which means replacing
// the dataset's arc collection with a merged one. Undo captures a dataset's arc
// collection and its layer list as one unit, so that replacement has to be
// announced: restoring arc coordinates alone leaves the dataset pointing at the
// merged collection while the layers' shapes refer to arc ids from the original,
// and the next -clean then empties most of the features.

describe('mapshaper-clean.mjs undo round trip', function() {
  var ex24 = 'test/data/features/clean/ex24_three_state_internal_gap.json';

  function load(file) {
    return internal.importFile(file, {});
  }

  // Everything -clean is able to change: arc coordinates, arc lengths, the
  // shapes of every layer, and the layer list itself.
  function fullState(dataset) {
    var data = dataset.arcs.getVertexData();
    return JSON.stringify({
      nn: Array.from(data.nn),
      xx: Array.from(data.xx),
      yy: Array.from(data.yy),
      shapes: dataset.layers.map(function(lyr) { return lyr.shapes; }),
      layerCount: dataset.layers.length
    });
  }

  function cleanWithUndo(dataset, opts) {
    var tx = new internal.UndoTransaction('-clean');
    internal.setActiveUndoTransaction(tx);
    try {
      api.cmd.cleanLayers(dataset.layers, dataset, opts);
    } finally {
      internal.clearActiveUndoTransaction(tx);
    }
    return tx;
  }

  function undo(tx) {
    internal.restoreCapturedUnits(
      internal.filterUnchangedRestoreUnits(tx.getCapturedUnits()));
  }

  // 250m selects the three-state gap, so the partition path runs and replaces
  // the arc collection.
  var partitioning = {gap_width: '250m'};

  it('restores the dataset exactly after partitioning gaps', function() {
    var dataset = load(ex24);
    var before = fullState(dataset);

    undo(cleanWithUndo(dataset, partitioning));

    assert.equal(fullState(dataset), before);
  })

  it('announces the replacement of the arc collection', function() {
    var dataset = load(ex24);
    var units = cleanWithUndo(dataset, partitioning).getCapturedUnits();
    var captured = units.filter(function(unit) {
      return unit.type == 'dataset' && unit.detail &&
        unit.detail.operation == 'partitionGaps';
    });

    assert.equal(captured.length, 1);
    assert.strictEqual(captured[0].arcs, units[0].target,
      'should capture the arc collection that -clean started with');
    assert.equal(captured[0].layers.length, dataset.layers.length,
      'should capture the layer list without the temporary cut layer');
  })

  it('produces the same result when re-run after an undo', function() {
    var dataset = load(ex24);
    var tx = cleanWithUndo(dataset, partitioning);
    var cleaned = fullState(dataset);

    undo(tx);
    cleanWithUndo(dataset, partitioning);

    assert.equal(fullState(dataset), cleaned);
  })

  it('stays stable over repeated clean and undo cycles', function() {
    var dataset = load(ex24);
    var before = fullState(dataset);

    for (var i = 0; i < 3; i++) {
      undo(cleanWithUndo(dataset, partitioning));
    }

    assert.equal(fullState(dataset), before);
  })
})
