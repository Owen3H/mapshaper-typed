import assert from 'assert';
import {
  getMinDivisibleGapWidth,
  getOwnerRuns
} from '../src/polygons/mapshaper-partition-gaps';
import { ArcCollection } from '../src/paths/mapshaper-arcs';

// -clean divides a gap that borders three or more features so that each of them
// receives the part nearest to it, rather than one feature receiving the whole
// gap. The division follows the lines midway between the neighbors' boundaries,
// which are found from the gap's own boundary: a cyclic sequence of arcs, each
// belonging to one neighbor.

describe('mapshaper-partition-gaps.mjs', function () {

  describe('getOwnerRuns()', function () {

    it('groups a boundary into one run per neighbor', function () {
      var runs = getOwnerRuns([
        {arcId: 1, shapeId: 5},
        {arcId: 2, shapeId: 5},
        {arcId: 3, shapeId: 8}
      ]);
      assert.deepEqual(runs, [
        {shapeId: 5, arcIds: [1, 2]},
        {shapeId: 8, arcIds: [3]}
      ]);
    })

    it('rejoins a run split across the start of the cyclic boundary', function () {
      // The boundary is a ring, so the last arc continues into the first one: the
      // arcs below are two runs, not three.
      var runs = getOwnerRuns([
        {arcId: 1, shapeId: 5},
        {arcId: 2, shapeId: 8},
        {arcId: 3, shapeId: 5}
      ]);
      assert.deepEqual(runs, [
        {shapeId: 5, arcIds: [3, 1]},
        {shapeId: 8, arcIds: [2]}
      ]);
    })

    it('leaves a boundary that alternates between two neighbors', function () {
      // Rejoining here would merge the ring into a single run and lose the
      // alternation, so a two-run boundary is left as it is.
      var runs = getOwnerRuns([
        {arcId: 1, shapeId: 5},
        {arcId: 2, shapeId: 8}
      ]);
      assert.equal(runs.length, 2);
    })
  })

  describe('getMinDivisibleGapWidth()', function () {
    // Narrower than this and a gap is better given whole to one neighbor, whose
    // boundary then shifts by less than the width of the gap, than divided into
    // a hairline sliver for each of them.

    // A square ring of side @side, so that every segment is that long.
    function squareLayer(x, y, side) {
      return {
        lyr: {geometry_type: 'polygon', shapes: [[[0]]]},
        arcs: new ArcCollection([[
          [x, y], [x + side, y], [x + side, y + side], [x, y + side], [x, y]
        ]])
      };
    }

    it('is one hundredth of the distance between vertices', function () {
      var o = squareLayer(1e6, 1e6, 10);
      assert.strictEqual(getMinDivisibleGapWidth(o.lyr, o.arcs), 0.1);
    })

    it('follows the scale of the data', function () {
      var coarse = squareLayer(1e6, 1e6, 1000);
      assert.strictEqual(getMinDivisibleGapWidth(coarse.lyr, coarse.arcs), 10);
    })

    it('is measured in coordinate units for geographic coordinates', function () {
      // Segment lengths are measured in meters there, but the caller compares
      // the result against widths measured in degrees.
      var o = squareLayer(0, 0, 0.001);
      var width = getMinDivisibleGapWidth(o.lyr, o.arcs);
      assert.ok(Math.abs(width - 1e-5) < 1e-8, width + ' should be 1e-5 degrees');
    })
  })
})
