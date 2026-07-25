/*
 * Small geometric helpers shared by the polyhedral projection modules
 * (mapshaper-polyhedral-projection, mapshaper-lee-tetrahedral,
 * mapshaper-narukawa2022). These projections all unfold a polyhedral net into
 * affine layout copies and clip the copies to a rectangular frame, so they need
 * the same 2x3 affine arithmetic and the same half-plane polygon clipping.
 */

var EPS = 1e-12;

// A 2x3 affine matrix, stored as [a, b, tx, c, d, ty].
export function applyMatrix(m, p) {
  return [
    m[0] * p[0] + m[1] * p[1] + m[2],
    m[3] * p[0] + m[4] * p[1] + m[5]
  ];
}

export function invertMatrix(m) {
  var det = m[0] * m[4] - m[1] * m[3];
  return [
    m[4] / det,
    -m[1] / det,
    (m[1] * m[5] - m[4] * m[2]) / det,
    -m[3] / det,
    m[0] / det,
    (m[3] * m[2] - m[0] * m[5]) / det
  ];
}

// Sutherland-Hodgman clip of a [x, y] ring against one axis-aligned half-plane.
export function clipPolygonAxis(polygon, axis, value, keepGreater) {
  var output = [];
  if (!polygon.length) return output;
  var a = polygon[polygon.length - 1];
  var aInside = isInside(a[axis], value, keepGreater);
  polygon.forEach(function(b) {
    var bInside = isInside(b[axis], value, keepGreater);
    if (aInside != bInside) {
      var t = (value - a[axis]) / (b[axis] - a[axis]);
      var p = [
        a[0] + (b[0] - a[0]) * t,
        a[1] + (b[1] - a[1]) * t
      ];
      p[axis] = value;
      output.push(p);
    }
    if (bInside) output.push(b.concat());
    a = b;
    aInside = bInside;
  });
  return output;
}

// As clipPolygonAxis, but for raster mesh vertices, which carry the source
// grid position (sx, sy) and geographic position (lon, lat) alongside the
// projected position. The axis argument is a property name ('x' or 'y').
export function clipRasterPolygonAxis(polygon, axis, value, keepGreater) {
  var output = [];
  if (!polygon.length) return output;
  var a = polygon[polygon.length - 1];
  var aInside = isInside(a[axis], value, keepGreater);
  polygon.forEach(function(b) {
    var bInside = isInside(b[axis], value, keepGreater);
    if (aInside != bInside) {
      var t = (value - a[axis]) / (b[axis] - a[axis]);
      var vertex = {
        x: a.x + (b.x - a.x) * t,
        y: a.y + (b.y - a.y) * t,
        sx: a.sx + (b.sx - a.sx) * t,
        sy: a.sy + (b.sy - a.sy) * t,
        lon: interpolateLongitude(a.lon, b.lon, t),
        lat: a.lat + (b.lat - a.lat) * t
      };
      vertex[axis] = value;
      output.push(vertex);
    }
    if (bInside) output.push(copyRasterVertex(b, b.x, b.y));
    a = b;
    aInside = bInside;
  });
  return output;
}

export function copyRasterVertex(vertex, x, y) {
  return {
    x: x,
    y: y,
    sx: vertex.sx,
    sy: vertex.sy,
    lon: vertex.lon,
    lat: vertex.lat
  };
}

// Interpolate along the shorter of the two arcs, so a cell straddling the
// antimeridian does not interpolate the long way around the globe.
export function interpolateLongitude(a, b, t) {
  var delta = b - a;
  if (delta > 180) delta -= 360;
  if (delta < -180) delta += 360;
  return normalizeLongitude(a + delta * t);
}

export function normalizeLongitude(lon) {
  while (lon > 180) lon -= 360;
  while (lon < -180) lon += 360;
  return lon;
}

export function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function isInside(coord, value, keepGreater) {
  return keepGreater ? coord >= value - EPS : coord <= value + EPS;
}
