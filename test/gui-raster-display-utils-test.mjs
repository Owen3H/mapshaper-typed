import assert from 'assert';
import {
  previewHasSourcePixels,
  rasterPreviewIsSmoothed
} from '../src/gui/gui-raster-display-utils';

describe('gui-raster-display-utils', function() {
  describe('previewHasSourcePixels()', function() {
    it('is true when the preview has room for every pixel in view', function() {
      assert.equal(previewHasSourcePixels(400, 300, 400, 300), true);
      assert.equal(previewHasSourcePixels(800, 600, 400, 300), true);
    });

    it('is false when the preview was scaled down', function() {
      assert.equal(previewHasSourcePixels(400, 300, 4000, 3000), false);
      // one axis is enough to make it a scaled-down rendering
      assert.equal(previewHasSourcePixels(400, 300, 400, 3000), false);
    });

    it('is false without a source size to compare with', function() {
      assert.equal(previewHasSourcePixels(400, 300, 0, 0), false);
      assert.equal(previewHasSourcePixels(400, 300, NaN, NaN), false);
    });
  });

  describe('rasterPreviewIsSmoothed()', function() {
    it('stops smoothing a magnified image of the raster pixels', function() {
      assert.equal(rasterPreviewIsSmoothed(true, 2), false);
      assert.equal(rasterPreviewIsSmoothed(true, 40), false);
    });

    it('smooths an image that is barely magnified, where squares would only look jagged', function() {
      assert.equal(rasterPreviewIsSmoothed(true, 1), true);
      assert.equal(rasterPreviewIsSmoothed(true, 1.9), true);
    });

    it('smooths an image that is not showing raster pixels, however magnified', function() {
      assert.equal(rasterPreviewIsSmoothed(false, 40), true);
    });

    it('smooths when the magnification is unknown', function() {
      assert.equal(rasterPreviewIsSmoothed(true, NaN), true);
    });
  });
});
