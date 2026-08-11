import api from '../mapshaper.js';
import assert from 'assert';

var ArcCollection = api.internal.ArcCollection;
var getArcSlices = api.internal.getArcSlices;
var splitArcAtCuts = api.internal.splitArcAtCuts;
var planPathDivision = api.internal.planPathDivision;
var getPlanarPathLength = api.internal.getPlanarPathLength;

// read back the coordinates of every arc in a collection
function getCoords(arcs) {
  var coords = [];
  for (var i=0; i<arcs.size(); i++) {
    coords.push(api.internal.getUnfilteredArcCoords(i, arcs));
  }
  return coords;
}

// a straight line of n vertices, one unit apart
function makeLine(n) {
  var points = [];
  for (var i=0; i<n; i++) points.push([i, 0]);
  return new ArcCollection([points]);
}

// arcLen function for planPathDivision(), from an array of arc lengths
function lengths(arr) {
  return function(arcId) { return arr[arcId]; };
}

function vertexCut(seq, offset) {
  return {seq: seq, offset: offset, point: null, displayPoint: null, t: 0};
}

function pointCut(seq, offset, point, t) {
  return {seq: seq, offset: offset, point: point, displayPoint: point, t: t || 0};
}

describe('mapshaper-arc-split.mjs', function () {

  describe('getArcSlices()', function () {

    it('cutting at a vertex duplicates it', function () {
      assert.deepEqual(getArcSlices(5, [{offset: 2, point: null}]), [
        {start: 0, end: 2, prefix: null, suffix: null},
        {start: 2, end: 4, prefix: null, suffix: null}
      ]);
    })

    it('cutting a segment inserts the cut point in both slices', function () {
      assert.deepEqual(getArcSlices(5, [{offset: 1, point: [1.5, 0]}]), [
        {start: 0, end: 1, prefix: null, suffix: [1.5, 0]},
        {start: 2, end: 4, prefix: [1.5, 0], suffix: null}
      ]);
    })

    it('two cuts make three slices', function () {
      assert.deepEqual(getArcSlices(6, [{offset: 1, point: null}, {offset: 3, point: null}]), [
        {start: 0, end: 1, prefix: null, suffix: null},
        {start: 1, end: 3, prefix: null, suffix: null},
        {start: 3, end: 5, prefix: null, suffix: null}
      ]);
    })

    it('two cuts on the same segment make a two-point middle slice', function () {
      var slices = getArcSlices(3, [{offset: 0, point: [0.2, 0]}, {offset: 0, point: [0.8, 0]}]);
      assert.deepEqual(slices[1], {start: 1, end: 0, prefix: [0.2, 0], suffix: [0.8, 0]});
      assert.equal(api.internal.getArcSliceLength(slices[1]), 2);
    })

    it('a mixed vertex and segment cut', function () {
      assert.deepEqual(getArcSlices(5, [{offset: 2, point: null}, {offset: 2, point: [2.5, 0]}]), [
        {start: 0, end: 2, prefix: null, suffix: null},
        {start: 2, end: 2, prefix: null, suffix: [2.5, 0]},
        {start: 3, end: 4, prefix: [2.5, 0], suffix: null}
      ]);
    })

    it('rejects a vertex cut at an arc endpoint', function () {
      assert.throws(function() { getArcSlices(5, [{offset: 0, point: null}]); });
      assert.throws(function() { getArcSlices(5, [{offset: 4, point: null}]); });
    })
  })

  describe('splitArcAtCuts()', function () {

    it('splits at a vertex, leaving the original arc in place', function () {
      var arcs = makeLine(4);
      var ids = splitArcAtCuts(arcs, 0, [{offset: 1, point: null}]);
      assert.deepEqual(ids, [1, 2]);
      assert.deepEqual(getCoords(arcs), [
        [[0, 0], [1, 0], [2, 0], [3, 0]],
        [[0, 0], [1, 0]],
        [[1, 0], [2, 0], [3, 0]]
      ]);
    })

    it('splits on a segment', function () {
      var arcs = makeLine(4);
      splitArcAtCuts(arcs, 0, [{offset: 1, point: [1.5, 0]}]);
      assert.deepEqual(getCoords(arcs).slice(1), [
        [[0, 0], [1, 0], [1.5, 0]],
        [[1.5, 0], [2, 0], [3, 0]]
      ]);
    })

    it('splits at two locations', function () {
      var arcs = makeLine(5);
      var ids = splitArcAtCuts(arcs, 0, [{offset: 1, point: null}, {offset: 2, point: [2.5, 0]}]);
      assert.deepEqual(ids, [1, 2, 3]);
      assert.deepEqual(getCoords(arcs).slice(1), [
        [[0, 0], [1, 0]],
        [[1, 0], [2, 0], [2.5, 0]],
        [[2.5, 0], [3, 0], [4, 0]]
      ]);
    })

    it('splits an arc that is not the last one in the collection', function () {
      var arcs = new ArcCollection([
        [[0, 0], [1, 0], [2, 0]],
        [[0, 1], [1, 1], [2, 1]]
      ]);
      splitArcAtCuts(arcs, 0, [{offset: 1, point: null}]);
      assert.deepEqual(getCoords(arcs), [
        [[0, 0], [1, 0], [2, 0]],
        [[0, 1], [1, 1], [2, 1]],
        [[0, 0], [1, 0]],
        [[1, 0], [2, 0]]
      ]);
    })

    it('copies simplification thresholds and protects new endpoints', function () {
      var arcs = makeLine(5);
      var zz = [Infinity, 3, 7, 2, Infinity];
      arcs.setThresholds(new Float64Array(zz));
      arcs.setRetainedInterval(5);
      splitArcAtCuts(arcs, 0, [{offset: 2, point: null}]);
      assert.equal(arcs.getRetainedInterval(), 5);
      assert.deepEqual(Array.from(arcs.getVertexData().zz), zz.concat(
        [Infinity, 3, Infinity], // new arc 1: interior threshold kept
        [Infinity, 2, Infinity]  // new arc 2
      ));
    })
  })

  describe('planPathDivision()', function () {

    it('divides a single-arc path at a vertex', function () {
      var plan = planPathDivision([0], [vertexCut(0, 2)], lengths([5]), 1, false);
      assert.deepEqual(plan.splits, [{arcId: 0, cuts: [{offset: 2, point: null, displayPoint: null}]}]);
      assert.deepEqual(plan.a, [1]);
      assert.deepEqual(plan.b, [2]);
    })

    it('divides a single-arc path on a segment', function () {
      var plan = planPathDivision([0], [pointCut(0, 1, [1.5, 0])], lengths([5]), 3, false);
      assert.deepEqual(plan.splits, [{arcId: 0, cuts: [{offset: 1, point: [1.5, 0], displayPoint: [1.5, 0]}]}]);
      assert.deepEqual(plan.a, [3]);
      assert.deepEqual(plan.b, [4]);
    })

    it('divides a multi-arc path at an interior node without splitting an arc', function () {
      var plan = planPathDivision([0, 1, 2], [vertexCut(1, 2)], lengths([3, 3, 3]), 3, false);
      assert.deepEqual(plan.splits, []);
      assert.deepEqual(plan.a, [0, 1]);
      assert.deepEqual(plan.b, [2]);
    })

    it('the same node reached from either arc gives the same division', function () {
      var arcLen = lengths([3, 3, 3]);
      var a = planPathDivision([0, 1, 2], [vertexCut(1, 2)], arcLen, 3, false);
      var b = planPathDivision([0, 1, 2], [vertexCut(2, 0)], arcLen, 3, false);
      assert.deepEqual(a, b);
    })

    it('splits only the arc containing the cut', function () {
      var plan = planPathDivision([0, 1, 2], [vertexCut(1, 1)], lengths([3, 3, 3]), 3, false);
      assert.deepEqual(plan.splits, [{arcId: 1, cuts: [{offset: 1, point: null, displayPoint: null}]}]);
      assert.deepEqual(plan.a, [0, 3]);
      assert.deepEqual(plan.b, [4, 2]);
    })

    it('handles a reversed arc', function () {
      // traversal offset 1 of ~0 is forward offset 3 of arc 0
      var plan = planPathDivision([~0], [vertexCut(0, 1)], lengths([5]), 1, false);
      assert.deepEqual(plan.splits, [{arcId: 0, cuts: [{offset: 3, point: null, displayPoint: null}]}]);
      assert.deepEqual(plan.a, [~2]);
      assert.deepEqual(plan.b, [~1]);
    })

    it('handles a segment cut in a reversed arc', function () {
      // the traversal segment from offset 1 to 2 is the forward segment 2 to 3
      var plan = planPathDivision([~0], [pointCut(0, 1, [9, 9])], lengths([5]), 1, false);
      assert.deepEqual(plan.splits, [{arcId: 0, cuts: [{offset: 2, point: [9, 9], displayPoint: [9, 9]}]}]);
      assert.deepEqual(plan.a, [~2]);
      assert.deepEqual(plan.b, [~1]);
    })

    it('rejects a cut at either endpoint of an open path', function () {
      var arcLen = lengths([3, 3]);
      assert.strictEqual(planPathDivision([0, 1], [vertexCut(0, 0)], arcLen, 2, false), null);
      assert.strictEqual(planPathDivision([0, 1], [vertexCut(1, 2)], arcLen, 2, false), null);
    })

    it('rejects the wrong number of cuts', function () {
      var arcLen = lengths([5]);
      assert.strictEqual(planPathDivision([0], [], arcLen, 1, false), null);
      assert.strictEqual(planPathDivision([0], [vertexCut(0, 2), vertexCut(0, 3)], arcLen, 1, false), null);
      assert.strictEqual(planPathDivision([0], [vertexCut(0, 2)], arcLen, 1, true), null);
    })

    it('divides a single-arc ring at two vertices', function () {
      var plan = planPathDivision([0], [vertexCut(0, 2), vertexCut(0, 4)], lengths([6]), 1, true);
      assert.deepEqual(plan.splits, [{arcId: 0, cuts: [
        {offset: 2, point: null, displayPoint: null},
        {offset: 4, point: null, displayPoint: null}
      ]}]);
      assert.deepEqual(plan.a, [2]);
      assert.deepEqual(plan.b, [3, 1]); // wraps through the ring's seam
    })

    it('orders two cuts on the same segment of a ring', function () {
      var plan = planPathDivision([0],
        [pointCut(0, 1, [1.8, 0], 0.8), pointCut(0, 1, [1.2, 0], 0.2)], lengths([6]), 1, true);
      assert.deepEqual(plan.splits, [{arcId: 0, cuts: [
        {offset: 1, point: [1.2, 0], displayPoint: [1.2, 0]},
        {offset: 1, point: [1.8, 0], displayPoint: [1.8, 0]}
      ]}]);
      assert.deepEqual(plan.a, [2]);
      assert.deepEqual(plan.b, [3, 1]);
    })

    it('orders two cuts in a reversed arc', function () {
      // traversal offsets 1 and 3 of ~0 are forward offsets 4 and 2, so the
      // cuts have to be reversed before the arc is divided
      var plan = planPathDivision([~0], [vertexCut(0, 1), vertexCut(0, 3)],
        lengths([6]), 1, true);
      assert.deepEqual(plan.splits, [{arcId: 0, cuts: [
        {offset: 2, point: null, displayPoint: null},
        {offset: 4, point: null, displayPoint: null}
      ]}]);
      // pieces in traversal order are ~3, ~2, ~1
      assert.deepEqual(plan.a, [~2]);
      assert.deepEqual(plan.b, [~1, ~3]);
    })

    it('divides a multi-arc ring, with one cut at the seam', function () {
      var plan = planPathDivision([0, 1], [vertexCut(0, 0), vertexCut(0, 1)], lengths([3, 3]), 2, true);
      assert.deepEqual(plan.a, [2]);
      assert.deepEqual(plan.b, [3, 1]);
    })

    it('treats the two ends of a ring as the same place', function () {
      var arcLen = lengths([3, 3]);
      var a = planPathDivision([0, 1], [vertexCut(0, 0), vertexCut(0, 1)], arcLen, 2, true);
      var b = planPathDivision([0, 1], [vertexCut(1, 2), vertexCut(0, 1)], arcLen, 2, true);
      assert.deepEqual(a, b);
    })

    it('divides a multi-arc ring at two nodes without splitting an arc', function () {
      var plan = planPathDivision([0, 1, 2, 3], [vertexCut(1, 0), vertexCut(3, 0)],
        lengths([3, 3, 3, 3]), 4, true);
      assert.deepEqual(plan.splits, []);
      assert.deepEqual(plan.a, [1, 2]);
      assert.deepEqual(plan.b, [3, 0]);
    })

    it('rejects two cuts in the same place on a ring', function () {
      var arcLen = lengths([3, 3]);
      assert.strictEqual(planPathDivision([0, 1], [vertexCut(0, 0), vertexCut(1, 2)], arcLen, 2, true), null);
      assert.strictEqual(planPathDivision([0, 1], [vertexCut(1, 0), vertexCut(0, 2)], arcLen, 2, true), null);
    })
  })

  describe('a plan applied to real arcs', function () {

    it('a ring divides into two paths that meet at the cut points', function () {
      var arcs = new ArcCollection([
        [[0, 0], [2, 0], [2, 2], [0, 2], [0, 0]]
      ]);
      var path = [0];
      var plan = planPathDivision(path, [vertexCut(0, 1), vertexCut(0, 3)],
        function(id) { return arcs.getVertexData().nn[id]; }, arcs.size(), true);
      plan.splits.forEach(function(split) {
        splitArcAtCuts(arcs, split.arcId, split.cuts);
      });
      assert.deepEqual(getPathCoords(plan.a, arcs), [[2, 0], [2, 2], [0, 2]]);
      assert.deepEqual(getPathCoords(plan.b, arcs), [[0, 2], [0, 0], [2, 0]]);
    })

    it('a reversed multi-arc path divides correctly', function () {
      var arcs = new ArcCollection([
        [[0, 0], [1, 0], [2, 0]],
        [[2, 0], [3, 0], [4, 0]]
      ]);
      var path = [~1, ~0]; // traversal: 4,0 -> 0,0
      var plan = planPathDivision(path, [pointCut(0, 1, [2.5, 0], 0.5)],
        function(id) { return arcs.getVertexData().nn[id]; }, arcs.size(), false);
      plan.splits.forEach(function(split) {
        splitArcAtCuts(arcs, split.arcId, split.cuts);
      });
      assert.deepEqual(getPathCoords(plan.a, arcs), [[4, 0], [3, 0], [2.5, 0]]);
      assert.deepEqual(getPathCoords(plan.b, arcs), [[2.5, 0], [2, 0], [1, 0], [0, 0]]);
    })
  })

  describe('getPlanarPathLength()', function () {

    it('sums segment lengths across arcs', function () {
      var arcs = new ArcCollection([
        [[0, 0], [3, 0]],
        [[3, 0], [3, 4]]
      ]);
      assert.equal(getPlanarPathLength([0], arcs), 3);
      assert.equal(getPlanarPathLength([0, 1], arcs), 7);
      assert.equal(getPlanarPathLength([~1, ~0], arcs), 7);
    })
  })
})

function getPathCoords(ids, arcs) {
  var iter = arcs.getShapeIter(ids);
  var coords = [];
  while (iter.hasNext()) {
    coords.push([iter.x, iter.y]);
  }
  return coords;
}
