// Translate between mapshaper's CRS objects and the GeoTIFF geo keys that
// describe a projection, in both directions.
//
// A GeoTIFF names a projection either by an authority code or by spelling it
// out: a coordinate transformation code plus the parameters it takes. This
// module handles the second, longer form, which is the only way to write a
// projection that has no EPSG code, and the only way to read one back.
//
// The key-by-key layout follows what GDAL writes for the same projection, since
// that is what other software is used to reading.

import { crsToProj4 } from '../crs/mapshaper-projections';

var R2D = 180 / Math.PI;

// The coordinate transformation codes of the GeoTIFF spec, and where each
// projection's parameters go. Projections missing from this table, including
// mapshaper's interrupted and polyhedral ones, have no GeoTIFF representation.
//
// ct: the ProjCoordTransGeoKey code
// proj: the proj4 name to read the code back as, when it differs from the entry
// origin: the geo keys that carry lon_0 and lat_0
// falseXY: the pair that carries x_0 and y_0
// scale: the key that carries k_0, for projections that take one
// parallels: whether the standard-parallel keys carry lat_ts or lat_1 and lat_2
// azimuth: the projection is skewed by an +alpha angle
// encodeOnly: another entry with the same code is the one to read it back as
var PROJECTIONS = {
  tmerc: {ct: 1, origin: 'nat', falseXY: 'nat', scale: 'nat'},
  utm: {ct: 1, origin: 'nat', falseXY: 'nat', scale: 'nat', proj: 'tmerc', encodeOnly: true},
  // Oblique Mercator comes in two variants, which differ in whether the false
  // easting and northing are applied at the projection center or at the point
  // where its skewed axis crosses the equator. GDAL identifies the first by its
  // EPSG method code rather than by a GeoTIFF transformation code.
  omerc: {ct: 9815, origin: 'center', falseXY: 'nat', scale: 'center', azimuth: true},
  omercNoUoff: {ct: 3, origin: 'center', falseXY: 'nat', scale: 'center', azimuth: true, proj: 'omerc', noUoff: true},
  merc: {ct: 7, origin: 'nat', falseXY: 'nat', scale: 'nat'},
  // Mercator's scale can be set either by a scale factor at the equator or by a
  // parallel of true scale, and the two are alternatives.
  mercStdParallel: {ct: 7, origin: 'nat', falseXY: 'nat', parallels: 'lat_ts', proj: 'merc'},
  lcc: {ct: 8, origin: 'falseOrigin', falseXY: 'falseOrigin', parallels: 'lat_1_2'},
  // With a single standard parallel the cone touches the globe, and the scale
  // factor at that parallel becomes a parameter.
  lcc1sp: {ct: 9, origin: 'nat', falseXY: 'nat', scale: 'nat', proj: 'lcc', tangentParallel: true},
  laea: {ct: 10, origin: 'center', falseXY: 'nat'},
  aea: {ct: 11, origin: 'nat', falseXY: 'nat', parallels: 'lat_1_2'},
  aeqd: {ct: 12, origin: 'center', falseXY: 'nat'},
  eqdc: {ct: 13, origin: 'nat', falseXY: 'nat', parallels: 'lat_1_2'},
  stere: {ct: 14, origin: 'center', falseXY: 'nat', scale: 'nat'},
  sterePolar: {ct: 15, origin: 'polar', falseXY: 'nat', scale: 'nat', proj: 'stere'},
  sterea: {ct: 16, origin: 'nat', falseXY: 'nat', scale: 'nat'},
  eqc: {ct: 17, origin: 'center', falseXY: 'nat', parallels: 'lat_ts'},
  cass: {ct: 18, origin: 'nat', falseXY: 'nat'},
  gnom: {ct: 19, origin: 'center', falseXY: 'nat'},
  mill: {ct: 20, origin: 'center', falseXY: 'nat'},
  ortho: {ct: 21, origin: 'center', falseXY: 'nat'},
  poly: {ct: 22, origin: 'nat', falseXY: 'nat', scale: 'nat'},
  robin: {ct: 23, origin: 'centerLong', falseXY: 'nat'},
  sinu: {ct: 24, origin: 'centerLong', falseXY: 'nat'},
  vandg: {ct: 25, origin: 'centerLong', falseXY: 'nat'}
};

var ORIGIN_KEYS = {
  nat: ['ProjNatOriginLongGeoKey', 'ProjNatOriginLatGeoKey'],
  center: ['ProjCenterLongGeoKey', 'ProjCenterLatGeoKey'],
  centerLong: ['ProjCenterLongGeoKey', null],
  falseOrigin: ['ProjFalseOriginLongGeoKey', 'ProjFalseOriginLatGeoKey'],
  // A polar stereographic projection's longitude is the meridian running down
  // the map, and its latitude is the parallel of true scale.
  polar: ['ProjStraightVertPoleLongGeoKey', 'ProjNatOriginLatGeoKey']
};

var FALSE_XY_KEYS = {
  nat: ['ProjFalseEastingGeoKey', 'ProjFalseNorthingGeoKey'],
  falseOrigin: ['ProjFalseOriginEastingGeoKey', 'ProjFalseOriginNorthingGeoKey']
};

var SCALE_KEYS = {
  nat: 'ProjScaleAtNatOriginGeoKey',
  center: 'ProjScaleAtCenterGeoKey'
};

// Geographic CRS codes for the datums that mapshaper can name.
var DATUM_CODES = {
  WGS84: 4326,
  NAD83: 4269,
  NAD27: 4267
};

var LINEAR_UNIT_CODES = [
  [1, 9001], // metre
  [0.3048, 9002], // international foot
  [0.3048006096012192, 9003] // US survey foot
];

var USER_DEFINED = 32767;
var ANGULAR_DEGREE = 9102;
var MODEL_TYPE_PROJECTED = 1;
var MODEL_TYPE_GEOGRAPHIC = 2;

// The proj4 parameters that describe a projection's shape and placement, as
// opposed to the ellipsoid it sits on. These are the ones this module claims;
// everything else in a proj4 string is left alone.
var PROJECTION_PARAMS = ['proj', 'lat_0', 'lon_0', 'lonc', 'lat_1', 'lat_2',
  'lat_ts', 'k', 'k_0', 'x_0', 'y_0', 'alpha', 'gamma', 'zone', 'south',
  'no_uoff', 'no_off', 'no_rot'];

// Returns geo keys describing a CRS, or null if it has no GeoTIFF
// representation. Callers add the raster-type key.
export function getCrsGeoKeys(crs) {
  var proj4 = getProj4(crs);
  var params = proj4 ? parseProj4Params(proj4) : null;
  // A mixed projection is several projections in one frame, which a GeoTIFF
  // cannot describe. Its proj4 string mentions only the main one, so it has to
  // be excluded by hand rather than by failing to match the table.
  if (!params || crs.__mixed_crs) return null;
  return crs.is_latlong ? getGeographicGeoKeys(crs, params) :
    getProjectedGeoKeys(crs, params);
}

function getProj4(crs) {
  try {
    return crsToProj4(crs);
  } catch(e) {
    return null;
  }
}

function getGeographicGeoKeys(crs, params) {
  return Object.assign({
    GTModelTypeGeoKey: MODEL_TYPE_GEOGRAPHIC
  }, getDatumGeoKeys(crs, params));
}

function getProjectedGeoKeys(crs, params) {
  var defn = getEncodingDefn(crs, params);
  var keys;
  if (!defn) return null;
  keys = Object.assign({
    GTModelTypeGeoKey: MODEL_TYPE_PROJECTED
  }, getDatumGeoKeys(crs, params), {
    // The projection is spelled out in the keys below rather than named by a
    // code, which is what "user-defined" announces.
    ProjectedCSTypeGeoKey: USER_DEFINED,
    ProjectionGeoKey: USER_DEFINED,
    ProjCoordTransGeoKey: defn.ct
  }, getLinearUnitGeoKeys(crs));
  Object.assign(keys, getProjectionParamGeoKeys(crs, params, defn));
  return keys;
}

// Picks the table entry for a projection, including the cases where one proj4
// name maps to two coordinate transformations.
function getEncodingDefn(crs, params) {
  var name = params.proj;
  if (name == 'lcc' && !hasSecondParallel(params)) {
    name = 'lcc1sp';
  } else if (name == 'stere' && isPolarLatitude(crs.phi0 * R2D)) {
    name = 'sterePolar';
  } else if (name == 'merc' && isFinite(params.lat_ts)) {
    name = 'mercStdParallel';
  } else if (name == 'omerc' && params.no_uoff) {
    name = 'omercNoUoff';
  }
  return PROJECTIONS[name] || null;
}

function hasSecondParallel(params) {
  return isFinite(params.lat_2) && params.lat_2 !== params.lat_1;
}

function isPolarLatitude(deg) {
  return Math.abs(deg) > 89.999;
}

function getProjectionParamGeoKeys(crs, params, defn) {
  var origin = ORIGIN_KEYS[defn.origin];
  var falseXY = FALSE_XY_KEYS[defn.falseXY];
  var keys = {};
  keys[origin[0]] = getOriginLongitude(crs, params, defn);
  if (origin[1]) keys[origin[1]] = getOriginLatitude(crs, params, defn);
  keys[falseXY[0]] = crs.x0;
  keys[falseXY[1]] = crs.y0;
  if (defn.scale) keys[SCALE_KEYS[defn.scale]] = crs.k0;
  if (defn.parallels == 'lat_ts') {
    keys.ProjStdParallel1GeoKey = getTrueScaleLatitude(params);
  } else if (defn.parallels == 'lat_1_2') {
    keys.ProjStdParallel1GeoKey = isFinite(params.lat_1) ? params.lat_1 : 0;
    keys.ProjStdParallel2GeoKey = isFinite(params.lat_2) ? params.lat_2 : params.lat_1;
  }
  if (defn.azimuth) {
    keys.ProjAzimuthAngleGeoKey = params.alpha;
    // The angle from the skew axis to the map's vertical. Absent, it equals the
    // azimuth, which is how proj4 treats it too.
    keys.ProjRectifiedGridAngleGeoKey = isFinite(params.gamma) ?
      params.gamma : params.alpha;
  }
  return keys;
}

// An oblique Mercator's center longitude is given by +lonc, which proj4 keeps
// separate from the +lon_0 of other projections.
function getOriginLongitude(crs, params, defn) {
  if (defn.azimuth && isFinite(params.lonc)) return params.lonc;
  return degrees(crs.lam0);
}

// A polar stereographic projection is anchored at a pole, so the latitude in
// its keys is the parallel of true scale rather than the origin.
function getOriginLatitude(crs, params, defn) {
  if (defn.origin == 'polar' && isFinite(params.lat_ts)) return params.lat_ts;
  return degrees(crs.phi0);
}

// An angle in degrees, cleaned up: the CRS object holds radians, so a whole
// number of degrees comes back as 96.00000000000001 without this. Nine decimal
// places is a fraction of a millimeter on the ground.
function degrees(rad) {
  return round(rad * R2D, 9);
}

function round(val, digits) {
  var k = Math.pow(10, digits);
  return Math.round(val * k) / k;
}

function getTrueScaleLatitude(params) {
  if (isFinite(params.lat_ts)) return params.lat_ts;
  if (isFinite(params.lat_1)) return params.lat_1;
  return 0;
}

// The ellipsoid and datum, which a projected CRS carries as well as a
// geographic one.
function getDatumGeoKeys(crs, params) {
  var code = DATUM_CODES[String(params.datum).toUpperCase()] || 0;
  var keys = {
    GeographicTypeGeoKey: code || USER_DEFINED,
    GeogAngularUnitsGeoKey: ANGULAR_DEGREE,
    // Written even when the datum is named by a code, so that a reader which
    // does not recognize the code still has the shape of the earth.
    GeogSemiMajorAxisGeoKey: crs.a,
    GeogPrimeMeridianLongGeoKey: degrees(crs.from_greenwich || 0)
  };
  if (!code) {
    keys.GeogGeodeticDatumGeoKey = USER_DEFINED;
    keys.GeogEllipsoidGeoKey = USER_DEFINED;
  }
  if (crs.es > 0) {
    keys.GeogInvFlatteningGeoKey = round(1 / (1 - Math.sqrt(1 - crs.es)), 9);
  } else {
    keys.GeogSemiMinorAxisGeoKey = crs.a; // a sphere
  }
  return keys;
}

function getLinearUnitGeoKeys(crs) {
  var size = crs.to_meter || 1;
  var match = LINEAR_UNIT_CODES.filter(function(pair) {
    return Math.abs(pair[0] - size) < 1e-12;
  })[0];
  if (match) return {ProjLinearUnitsGeoKey: match[1]};
  return {
    ProjLinearUnitsGeoKey: USER_DEFINED,
    ProjLinearUnitSizeGeoKey: size
  };
}

// Reads back the projection that getCrsGeoKeys() writes: returns the proj4
// parameters naming the projection and placing it on the globe, as a string, or
// null if the keys describe a projection this module does not know.
//
// The ellipsoid, datum and units are not included, because a caller reading a
// file written by other software has better sources for those.
export function getGeoKeyProjection(keys) {
  var defn = getDecodingDefn(keys);
  var origin, falseXY, params;
  if (!defn) return null;
  origin = ORIGIN_KEYS[defn.origin];
  falseXY = FALSE_XY_KEYS[defn.falseXY];
  params = {proj: defn.proj || getProjectionName(defn)};
  addProjParam(params, defn.azimuth ? 'lonc' : 'lon_0', keys[origin[0]]);
  if (origin[1]) {
    Object.assign(params, getDecodedLatitude(keys[origin[1]], defn));
  }
  addProjParam(params, 'x_0', keys[falseXY[0]]);
  addProjParam(params, 'y_0', keys[falseXY[1]]);
  if (defn.scale) addProjParam(params, 'k_0', keys[SCALE_KEYS[defn.scale]]);
  if (defn.parallels == 'lat_ts') {
    addProjParam(params, 'lat_ts', keys.ProjStdParallel1GeoKey);
  } else if (defn.parallels == 'lat_1_2') {
    addProjParam(params, 'lat_1', keys.ProjStdParallel1GeoKey);
    addProjParam(params, 'lat_2', keys.ProjStdParallel2GeoKey);
  }
  if (defn.azimuth) {
    addProjParam(params, 'alpha', keys.ProjAzimuthAngleGeoKey);
    addProjParam(params, 'gamma', keys.ProjRectifiedGridAngleGeoKey);
    if (defn.noUoff) params.no_uoff = true;
  }
  return formatProj4Params(params);
}

function getDecodingDefn(keys) {
  var ct = keys && keys.ProjCoordTransGeoKey;
  var names;
  if (!ct || ct == USER_DEFINED) return null;
  if (ct == PROJECTIONS.merc.ct) {
    return isFinite(keys.ProjStdParallel1GeoKey) ?
      PROJECTIONS.mercStdParallel : PROJECTIONS.merc;
  }
  names = Object.keys(PROJECTIONS).filter(function(name) {
    return PROJECTIONS[name].ct === ct && !PROJECTIONS[name].encodeOnly;
  });
  return names.length == 1 ? PROJECTIONS[names[0]] : null;
}

function getProjectionName(defn) {
  return Object.keys(PROJECTIONS).filter(function(name) {
    return PROJECTIONS[name] === defn;
  })[0];
}

// The latitude in a polar stereographic projection's keys is the parallel of
// true scale; which pole the map is centered on follows from its sign.
function getDecodedLatitude(val, defn) {
  var params = {};
  if (!isFinite(val)) return params;
  if (defn.origin == 'polar') {
    params.lat_ts = val;
    params.lat_0 = val < 0 ? -90 : 90;
  } else {
    params.lat_0 = val;
  }
  if (defn.tangentParallel) {
    // A one-parallel conic touches the globe at its origin latitude, which
    // proj4 wants stated as the standard parallel.
    params.lat_1 = params.lat_0;
  }
  return params;
}

function addProjParam(params, name, val) {
  if (isFinite(val)) params[name] = val;
}

// Replaces the projection parameters of a proj4 string with a different set,
// leaving its ellipsoid, datum and unit parameters in place. Used to correct a
// projection that another parser has read loosely.
export function replaceProj4Projection(str, projectionStr) {
  var params = parseProj4Params(str) || {};
  var kept = {};
  Object.keys(params).forEach(function(name) {
    if (PROJECTION_PARAMS.indexOf(name) == -1) kept[name] = params[name];
  });
  return projectionStr + ' ' + formatProj4Params(kept);
}

function formatProj4Params(params) {
  return Object.keys(params).map(function(name) {
    return params[name] === true ? '+' + name : '+' + name + '=' + params[name];
  }).join(' ');
}

// Reads the parameters that mproj keeps inside a projection's own state, and so
// does not expose on the CRS object, out of the proj4 string that describes it.
// Numeric values come back as numbers, flags as true.
function parseProj4Params(str) {
  var params = {};
  String(str).split(/\s+/).forEach(function(part) {
    var match = /^\+([a-z_0-9]+)(?:=(.*))?$/i.exec(part);
    var val;
    if (!match) return;
    val = match[2];
    params[match[1]] = val === undefined ? true :
      val !== '' && isFinite(Number(val)) ? Number(val) : val;
  });
  return params.proj ? params : null;
}
