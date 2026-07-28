import assert from 'assert';
import { createRequire } from 'module';

describe('gui-undo.js', function() {
  it('accepts app-wide undo history entries', async function() {
    var Undo = await importUndo();
    var gui = makeGui();
    var undo = new Undo(gui);
    var val = 'initial';

    gui.undo = undo;
    undo.addHistoryState(function() {
      val = 'undone';
    }, function() {
      val = 'redone';
    });

    assert.equal(undo.canUndo(), true);
    assert.equal(undo.canRedo(), false);

    await undo.undo();

    assert.equal(val, 'undone');
    assert.equal(undo.canUndo(), false);
    assert.equal(undo.canRedo(), true);

    await undo.redo();

    assert.equal(val, 'redone');
    assert.equal(undo.canUndo(), true);
    assert.equal(undo.canRedo(), false);
  });

  it('cleans invalidated redo entries', async function() {
    var Undo = await importUndo();
    var gui = makeGui();
    var undo = new Undo(gui);
    var cleaned = false;

    undo.addHistoryState(function() {}, function() {}, function() {
      cleaned = true;
    });
    await undo.undo();
    undo.addHistoryState(function() {}, function() {});

    assert.equal(cleaned, true);
  });

  // History is bounded by the size of the stored restore data, not by a number
  // of entries, so adding states never discards an older one on its own.
  it('keeps entries as the history grows', async function() {
    var Undo = await importUndo();
    var gui = makeGui();
    var undo = new Undo(gui);
    var cleaned = [];
    var undone = [];
    var i;

    for (i = 0; i < 50; i++) {
      addNumberedState(undo, i, undone, cleaned);
    }
    assert.deepEqual(cleaned, []);

    for (i = 0; i < 50; i++) {
      await undo.undo();
    }
    assert.equal(undone.length, 50);
    assert.equal(undone[0], 49); // undone in reverse order, back to the first
    assert.equal(undone[49], 0);
    assert.equal(undo.canUndo(), false);
  });

  it('evicts the oldest entry on request', async function() {
    var Undo = await importUndo();
    var gui = makeGui();
    var undo = new Undo(gui);
    var cleaned = [];
    var undone = [];

    addNumberedState(undo, 0, undone, cleaned);
    addNumberedState(undo, 1, undone, cleaned);
    assert.equal(await undo.evictOldestHistoryState(), true);
    assert.deepEqual(cleaned, [0]);

    await undo.undo();
    assert.deepEqual(undone, [1]);
    assert.equal(undo.canUndo(), false);
  });

  it('restores undo offset after an async undo failure', async function() {
    var Undo = await importUndo();
    var gui = makeGui();
    var undo = new Undo(gui);
    var error = console.error;
    var err;

    undo.addHistoryState(async function() {
      throw new Error('undo failed');
    }, function() {});

    try {
      console.error = function() {};
      await undo.undo();
    } catch(e) {
      err = e;
    } finally {
      console.error = error;
    }

    assert.ok(err);
    assert.equal(undo.canUndo(), true);
    assert.equal(undo.canRedo(), false);
  });

  it('ignores rejected async cleanup handlers', async function() {
    var Undo = await importUndo();
    var gui = makeGui();
    var undo = new Undo(gui);

    undo.addHistoryState(function() {}, function() {}, function() {
      return Promise.reject(new Error('cleanup failed'));
    });

    assert.doesNotThrow(function() {
      undo.clear();
    });
  });
});

var importedUndo;

async function importUndo() {
  if (!importedUndo) {
    installGuiGlobals();
    importedUndo = import('../src/gui/gui-undo').then(function(mod) {
      return mod.Undo;
    });
  }
  return importedUndo;
}

function installGuiGlobals() {
  var require = createRequire(import.meta.url);
  Object.defineProperty(global, 'window', {
    value: {mapshaper: require('../mapshaper.js')},
    configurable: true
  });
  Object.defineProperty(global, 'document', {
    configurable: true,
    value: {
    createElement: function() {
      return {style: {cssText: ''}};
    }
    }
  });
}

function addNumberedState(undo, num, undone, cleaned) {
  undo.addHistoryState(function() {
    undone.push(num);
  }, function() {}, function() {
    cleaned.push(num);
  });
}

function makeGui() {
  return {
    keyboard: {
      on: function() {}
    },
    on: function() {},
    dispatchEvent: function() {}
  };
}
