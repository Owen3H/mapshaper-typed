import assert from 'assert';
import {
  formatDistanceValue,
  getDistanceDisplay,
  getDistanceUnit,
  interpolateGreatCirclePoint,
  pointIsInLngLatRange,
  pointIsNearPole,
  segmentCrossesAntimeridian
} from '../src/gui/gui-ruler-utils';

describe('gui-ruler-utils', function() {
  it('formats distance values with useful precision', function() {
    assert.equal(formatDistanceValue(1234.56), '1235');
    assert.equal(formatDistanceValue(12.34), '12.3');
    assert.equal(formatDistanceValue(1.234), '1.23');
    assert.equal(formatDistanceValue(2.1), '2.10');
    assert.equal(formatDistanceValue(0.1234), '0.123');
    assert.equal(formatDistanceValue(0), '0.0');
  });

  it('chooses a unit to suit the size of a meter distance', function() {
    assert.equal(getDistanceUnit(999.9), 'm');
    assert.equal(getDistanceUnit(1000), 'km');
    assert.equal(getDistanceUnit(0.05), 'cm');
    assert.equal(getDistanceUnit(0.005), 'mm');
    assert.equal(getDistanceUnit(0), 'm');
  });

  it('formats display labels in an automatically chosen unit', function() {
    assert.deepEqual(getDistanceDisplay(1500), {
      value: 1.5,
      unit: 'km',
      label: '1.50 km'
    });
    assert.deepEqual(getDistanceDisplay(150), {
      value: 150,
      unit: 'm',
      label: '150 m'
    });
    assert.deepEqual(getDistanceDisplay(0.05), {
      value: 5,
      unit: 'cm',
      label: '5.00 cm'
    });
    assert.deepEqual(getDistanceDisplay(0.005), {
      value: 5,
      unit: 'mm',
      label: '5.00 mm'
    });
    assert.deepEqual(getDistanceDisplay(0), {
      value: 0,
      unit: 'm',
      label: '0.0 m'
    });
  });

  it('detects coordinates outside lat-long bounds', function() {
    assert.equal(pointIsInLngLatRange([-180, -90]), true);
    assert.equal(pointIsInLngLatRange([180, 90]), true);
    assert.equal(pointIsInLngLatRange([-180.1, 0]), false);
    assert.equal(pointIsInLngLatRange([0, 90.1]), false);
    assert.equal(pointIsInLngLatRange(null), false);
  });

  it('detects antimeridian-crossing segments', function() {
    assert.equal(segmentCrossesAntimeridian([179, 0], [-179, 1]), true);
    assert.equal(segmentCrossesAntimeridian([10, 0], [20, 1]), false);
    assert.equal(segmentCrossesAntimeridian([181, 0], [-179, 1]), false);
  });

  it('detects points near the poles', function() {
    assert.equal(pointIsNearPole([0, 89.9]), true);
    assert.equal(pointIsNearPole([0, -89.9]), true);
    assert.equal(pointIsNearPole([0, 89.89]), false);
  });

  it('interpolates points on a spherical great circle', function() {
    assert.deepEqual(roundPoint(interpolateGreatCirclePoint([0, 0], [90, 0], 0.5)), [45, 0]);
    assert.deepEqual(roundPoint(interpolateGreatCirclePoint([0, 0], [0, 90], 0.5)), [0, 45]);
    assert.deepEqual(roundPoint(interpolateGreatCirclePoint([170, 0], [-170, 0], 0.5)), [180, 0]);
  });
});

function roundPoint(p) {
  return p.map(function(n) {
    return Math.round(n * 1e10) / 1e10;
  });
}
