import assert from 'assert';
import api from '../mapshaper.js';
import { getPrecisionSeamDistance } from '../src/polygons/mapshaper-close-gaps';
import { getOutsideFacingArcFlags } from '../src/polygons/mapshaper-mosaic-index';

// -clean always collapses duplicate boundaries: two boundaries that should be
// one, but were digitized or computed twice. Left alone, such a seam becomes an
// enclosed sliver that gap filling awards to a single neighbor, giving that
// feature a zero-width spike along a border it shares with other features. The
// distance below decides what counts as a duplicate, so it has to stay well
// under the width of any gap a map could show.

describe('mapshaper-close-gaps.mjs getPrecisionSeamDistance()', function () {

  it('stays at sub-micron scale for geographic coordinates', function () {
    var meters = getPrecisionSeamDistance([-119.5, 46.2, -119.1, 46.3], true);
    assert(meters > 0);
    assert(meters < 1e-5,
      'should be far below any visible gap, got ' + meters + 'm');
  })

  it('tracks coordinate magnitude rather than extent', function () {
    // Precision is lost in the size of the numbers being subtracted, not in the
    // size of the area they cover, so a small extent far from the origin gets a
    // larger allowance than a large extent near it.
    var wideNearOrigin = getPrecisionSeamDistance([0, 0, 1, 1], false);
    var narrowFarOut = getPrecisionSeamDistance([1e6, 1e6, 1e6 + 1e-3, 1e6 + 1e-3], false);
    assert(narrowFarOut > wideNearOrigin * 1e5);
  })

  it('leaves projected units alone', function () {
    assert.strictEqual(getPrecisionSeamDistance([0, 0, 1, 1], false), 100 / 2 ** 51);
  })
})

// close-outer-gaps pinches shut the mouth of a crack that opens onto the space
// outside the mosaic, so that gap filling can reach what is left. Whether a crack
// opens onto that space is a question about the mosaic rather than the shape of
// the crack: space that polygons enclose becomes a tile, however narrow it is.
describe('mapshaper-mosaic-index.mjs getOutsideFacingArcFlags()', function () {

  // Two features either side of a channel, pinched shut at whichever ends are
  // asked for. Each bank carries enough vertices to be more than a straight edge.
  function channel(pinchBottom, pinchTop) {
    var west = [], east = [];
    for (var i = 0; i <= 20; i++) {
      var y = i * 0.5;
      var atBottom = i === 0 && pinchBottom;
      var atTop = i === 20 && pinchTop;
      west.push([atBottom || atTop ? 5.01 : 5, y]);
      east.push([atBottom || atTop ? 5.01 : 5.02, y]);
    }
    return JSON.stringify({
      type: 'FeatureCollection',
      features: [{
        type: 'Feature', properties: {name: 'A'},
        geometry: {type: 'Polygon',
          coordinates: [[[0, 0]].concat(west, [[0, 10], [0, 0]])]}
      }, {
        type: 'Feature', properties: {name: 'B'},
        geometry: {type: 'Polygon',
          coordinates: [[[10, 0]].concat(east.slice().reverse(),
            [[10, 10], [10, 0]])]}
      }]
    });
  }

  // Whether the arcs running along the channel face untiled space.
  function banksFaceOutside(geojson) {
    var dataset = api.internal.importFileContent(geojson, 'in.json', {});
    var nodes = api.internal.addIntersectionCuts(dataset, {});
    var flags = getOutsideFacingArcFlags(nodes);
    var facing = 0, enclosed = 0;
    for (var i = 0; i < flags.length; i++) {
      // a bank of the channel runs its whole length, while the outer boundary
      // meets it at a pinched end in a segment or two
      var n = dataset.arcs.getArcLength(i);
      if (n < 3) continue;
      var mid = dataset.arcs.getVertex(i, Math.floor(n / 2));
      if (mid.x < 4.9 || mid.x > 5.1) continue;
      if (flags[i] === 1) facing++;
      else enclosed++;
    }
    return {facing: facing, enclosed: enclosed};
  }

  it('flags the banks of a channel that runs through the coverage', function () {
    var counts = banksFaceOutside(channel(false, false));
    assert(counts.facing > 0);
    assert.equal(counts.enclosed, 0,
      'nothing tiles a channel open at both ends');
  })

  it('leaves the banks of a pinched channel alone', function () {
    var counts = banksFaceOutside(channel(true, true));
    assert(counts.enclosed > 0,
      'a channel pinched shut at both ends is enclosed, so it is tiled');
    assert.equal(counts.facing, 0);
  })

  it('still flags a channel pinched at one end only', function () {
    var counts = banksFaceOutside(channel(true, false));
    assert.equal(counts.enclosed, 0, 'one end open leaves it open');
    assert(counts.facing > 0);
  })
})
