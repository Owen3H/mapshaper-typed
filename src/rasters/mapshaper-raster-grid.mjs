// Low-level access to raster grid samples, shared by the code that reads or
// rewrites pixels (-proj, -blur, clipping and preview rendering). These used
// to be reimplemented per module, which let the nodata and coverage rules
// drift apart.
//
// Samples are band-interleaved: pixel i occupies
// samples[i * bands] through samples[i * bands + bands - 1].

// A pixel is nodata only when every one of its color-carrying bands matches
// the nodata value. An alpha band is ignored, so a transparent pixel whose
// color channels hold real values is still treated as data.
export function samplesAreNodataAtOffset(samples, offset, bands, nodata) {
  var n = Math.min(bands, 3);
  if (nodata === null || nodata === undefined) return false;
  for (var i = 0; i < n; i++) {
    if (samples[offset + i] != nodata) return false;
  }
  return true;
}

export function rasterPixelIsNodata(grid, pixelId) {
  return samplesAreNodataAtOffset(grid.samples, pixelId * grid.bands, grid.bands, grid.nodata);
}

// The coverage mask is set by reprojection to record which output pixels
// received source content, independently of the nodata fill value.
export function rasterPixelIsCovered(grid, pixelId) {
  return !grid.coverage || grid.coverage[pixelId] > 0;
}

export function rasterPixelIsValid(grid, pixelId) {
  return rasterPixelIsCovered(grid, pixelId) && !rasterPixelIsNodata(grid, pixelId);
}

// False when every pixel is known to be valid, so callers can skip
// per-pixel validity testing entirely.
export function rasterGridHasInvalidPixels(grid) {
  return !!grid.coverage || grid.nodata !== null && grid.nodata !== undefined;
}

// One byte per pixel, so that code sampling a grid repeatedly can test
// validity with a single lookup instead of re-reading every band. Returns
// the coverage mask itself when there is no nodata value to fold in, and
// null when every pixel is valid.
export function getRasterValidityMask(grid) {
  var n = grid.width * grid.height;
  var mask, i;
  if (grid.nodata === null || grid.nodata === undefined) return grid.coverage || null;
  mask = new Uint8Array(n);
  for (i = 0; i < n; i++) {
    mask[i] = rasterPixelIsValid(grid, i) ? 1 : 0;
  }
  return mask;
}

export function rasterSamplesAreFloat(samples) {
  return samples instanceof Float32Array || samples instanceof Float64Array;
}

// Value range of a sample array, used to clamp computed values before
// writing them back into an integer array.
export function getSampleArrayRange(samples) {
  if (samples instanceof Uint8Array || samples instanceof Uint8ClampedArray) return {min: 0, max: 255};
  if (samples instanceof Int8Array) return {min: -128, max: 127};
  if (samples instanceof Uint16Array) return {min: 0, max: 65535};
  if (samples instanceof Int16Array) return {min: -32768, max: 32767};
  if (samples instanceof Uint32Array) return {min: 0, max: 4294967295};
  if (samples instanceof Int32Array) return {min: -2147483648, max: 2147483647};
  return {min: -Infinity, max: Infinity};
}
