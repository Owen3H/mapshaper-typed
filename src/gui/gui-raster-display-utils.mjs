// Rules for drawing a raster that is being displayed larger than its data.
// Kept free of browser and mapshaper dependencies so they can be tested
// directly.

// Screen pixels per raster pixel at which a magnified raster is drawn as
// squares instead of being smoothed. Below this there is little detail to lose
// and smoothing looks better; above it, the smoothing is what a user sees
// instead of the data.
export var MIN_CRISP_MAGNIFICATION = 2;

// True if a preview image holds every raster pixel in view, and so is showing
// the data itself rather than a scaled-down rendering of it. Only such an
// image is worth drawing as squares: magnifying a coarser preview would show
// crisp squares that are not pixels of the raster.
export function previewHasSourcePixels(width, height, sourceWidth, sourceHeight) {
  if (!(sourceWidth > 0) || !(sourceHeight > 0)) return false;
  return width >= sourceWidth && height >= sourceHeight;
}

// sourcePixels: from previewHasSourcePixels()
// magnification: screen pixels per pixel of the preview image
export function rasterPreviewIsSmoothed(sourcePixels, magnification) {
  return !sourcePixels || !(magnification >= MIN_CRISP_MAGNIFICATION);
}
