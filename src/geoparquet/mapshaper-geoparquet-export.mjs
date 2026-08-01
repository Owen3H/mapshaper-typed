import { getFeatureCursor } from '../geojson/geojson-export';
import { parseCrsString, parsePrj } from '../crs/mapshaper-projections';
import { runningInBrowser } from '../mapshaper-env';
import { getFileExtension } from '../utils/mapshaper-filename-utils';
import { stop, warn } from '../utils/mapshaper-logging';
import utils from '../utils/mapshaper-utils';
import require from '../mapshaper-require';

var writerPromise = null;
var zstdPromise = null;
var dynamicImportModule = Function('id', 'return import(id)');

export async function exportGeoParquet(dataset, opts, filenameOverride) {
  var writer = await loadGeoParquetWriter();
  var compression = await getGeoParquetCompression(opts);
  var rowGroupOverride = validateRowGroupSize(opts.rowgroup);
  var extension = opts.extension || 'parquet';
  var files = [];
  if (opts.file) {
    extension = getFileExtension(opts.file) || extension;
  }
  dataset.layers.forEach(function(lyr) {
    files.push({
      filename: filenameOverride || (lyr.name + '.' + extension),
      content: writeLayer(writer, lyr, dataset, opts, compression, rowGroupOverride)
    });
  });
  return files;
}

var GEOMETRY_COLUMN = 'geometry';

// Rows are converted and handed to the writer one row group at a time. The
// GeoJSON form of a geometry is several times larger than the WKB the writer
// encodes it into, so materializing a whole layer of it was the largest
// allocation the export made -- larger than the dataset and the output file
// combined. Converting a group at a time makes that cost a function of the
// row group size rather than of the layer size.
function writeLayer(writer, lyr, dataset, opts, compression, rowGroupOverride) {
  var cursor = getFeatureCursor(lyr, dataset, opts, true);
  var rowCount = cursor.length;
  if (rowCount === 0) {
    stop('GeoParquet export requires at least one record');
  }
  var hasGeometry = layerHasGeometry(lyr);
  var fields = getFieldTypes(cursor, opts);
  if (!hasGeometry && fields.length === 0) {
    stop('GeoParquet export requires geometry or attribute data');
  }
  if (!hasGeometry) {
    warn('GeoParquet export: layer has no geometry; writing attribute data only.');
  }
  var crs = hasGeometry ? getGeoMetadataCrs(dataset) : null;
  var byteWriter = new writer.ByteWriter();
  var pq = new writer.ParquetWriter({
    writer: byteWriter,
    schema: buildSchema(writer, fields, hasGeometry, crs),
    codec: compression.codec,
    compressors: compression.compressors
  });
  var geometryTypes = {};
  var plan = getRowGroupSize(cursor, fields, hasGeometry, rowCount, rowGroupOverride);
  eachRowGroupRange(rowCount, plan, function(start, end) {
    pq.write({
      columnData: buildChunkColumns(cursor, fields, hasGeometry, start, end, geometryTypes),
      rowGroupSize: end - start,
      pageSize: compression.pageSize
    });
  });
  if (hasGeometry) {
    // Set on the writer rather than passed to the constructor: the geometry
    // types aren't known until every group has been converted.
    pq.kvMetadata = [{
      key: 'geo',
      value: JSON.stringify(buildGeoMetadata(Object.keys(geometryTypes), crs))
    }];
  }
  avoidIntegerBboxBounds(pq.row_groups);
  pq.finish();
  return byteWriter.getBuffer();
}

// hyparquet-writer (0.14) infers each thrift wire type from the runtime value, so
// a bounding box bound that lands on a whole number is written as I32 where the
// Parquet spec requires a double. Readers that parse geospatial statistics
// (pyarrow 21+, GDAL 3.11+) then fail to deserialize the footer and cannot open
// the file at all -- which rounded, snapped or integer-grid coordinates make easy
// to hit. Widening each bound to the adjacent double forces the double path.
// Reported upstream; remove once the writer carries declared field types.
function avoidIntegerBboxBounds(rowGroups) {
  (rowGroups || []).forEach(function(group) {
    (group.columns || []).forEach(function(col) {
      var stats = col.meta_data && col.meta_data.geospatial_statistics;
      if (!stats || !stats.bbox) return;
      if (!widenIntegerBounds(stats.bbox)) {
        // Past 2^53 doubles are spaced too widely to step off an integer. Drop
        // the box rather than write a footer that no reader can parse.
        delete stats.bbox;
      }
    });
  });
}

// Nudges whole-number bounds outward, so that the box still covers every
// geometry in the group: an oversized box only costs a reader the chance to skip
// the group, while an undersized one would hide rows that match a filter.
// Returns false if any bound could not be made non-integral.
function widenIntegerBounds(bbox) {
  return Object.keys(bbox).every(function(key) {
    var val = bbox[key];
    var widened;
    if (!Number.isInteger(val)) return true;
    widened = nextDouble(val, /min$/.test(key) ? -1 : 1);
    if (Number.isInteger(widened)) return false;
    bbox[key] = widened;
    return true;
  });
}

var nextDoubleFloats = new Float64Array(1);
var nextDoubleBits = new BigInt64Array(nextDoubleFloats.buffer);

// Returns the adjacent double to @val in the direction of @sign (-1 down, 1 up).
function nextDouble(val, sign) {
  if (!Number.isFinite(val)) return val;
  if (val === 0) return sign > 0 ? Number.MIN_VALUE : -Number.MIN_VALUE;
  nextDoubleFloats[0] = val;
  // Incrementing the bit pattern moves a positive double up and a negative one
  // further down, so the step direction depends on the sign of the value.
  nextDoubleBits[0] += (val > 0) === (sign > 0) ? 1n : -1n;
  return nextDoubleFloats[0];
}

// A shape that survives to this point can still export as null geometry if all
// of its paths collapse, in which case the column is written as nulls.
function layerHasGeometry(lyr) {
  if (!lyr.geometry_type || !lyr.shapes) return false;
  return lyr.shapes.some(Boolean);
}

function eachRowGroupRange(rowCount, plan, cb) {
  var sizes = Array.isArray(plan) ? plan : [plan];
  var start = 0;
  for (var i = 0; start < rowCount; i++) {
    var end = Math.min(start + sizes[Math.min(i, sizes.length - 1)], rowCount);
    cb(start, end);
    start = end;
  }
}

function buildChunkColumns(cursor, fields, hasGeometry, start, end, geometryTypes) {
  var n = end - start;
  var geometry = hasGeometry ? new Array(n) : null;
  var values = fields.map(function() { return new Array(n); });
  for (var i = 0; i < n; i++) {
    var feat = cursor.getFeature(start + i);
    var props = feat.properties;
    if (hasGeometry) {
      var geom = feat.geometry || null;
      geometry[i] = geom;
      if (geom && geom.type) geometryTypes[geom.type] = true;
    }
    for (var j = 0; j < fields.length; j++) {
      values[j][i] = normalizeFieldValue(props ? props[fields[j].name] : null, fields[j].type);
    }
  }
  var columnData = hasGeometry ? [{name: GEOMETRY_COLUMN, data: geometry}] : [];
  fields.forEach(function(field, j) {
    columnData.push({name: field.name, data: values[j]});
  });
  return columnData;
}

function getFieldTypes(cursor, opts) {
  var properties = cursor.properties;
  if (!properties) return [];
  return getPropertyNames(properties, opts).map(function(name) {
    return {name: name, type: inferColumnType(properties, name)};
  });
}

function inferColumnType(properties, name) {
  var type = null;
  for (var i = 0; i < properties.length; i++) {
    var props = properties[i];
    var valueType = inferValueType(props ? props[name] : null);
    if (!valueType) continue;
    if (!type) {
      type = valueType;
    } else if (type != valueType) {
      if ((type == 'INT32' || type == 'DOUBLE') &&
          (valueType == 'INT32' || valueType == 'DOUBLE')) {
        type = 'DOUBLE';
      } else {
        return 'STRING';
      }
    }
  }
  return type || 'STRING';
}

function inferValueType(value) {
  if (value === null || value === undefined) return null;
  if (typeof value == 'boolean') return 'BOOLEAN';
  if (typeof value == 'number') {
    if (!Number.isFinite(value)) return 'STRING';
    if (Math.floor(value) === value && value >= -2147483648 && value <= 2147483647) {
      return 'INT32';
    }
    return 'DOUBLE';
  }
  if (typeof value == 'bigint') return 'STRING';
  if (value instanceof Date) return 'TIMESTAMP';
  if (value instanceof Uint8Array) return 'BYTE_ARRAY';
  if (typeof Buffer == 'function' && Buffer.isBuffer(value)) return 'BYTE_ARRAY';
  if (Array.isArray(value) || utils.isObject(value)) return 'JSON';
  return 'STRING';
}

function normalizeFieldValue(value, type) {
  if (value === undefined) return null;
  if (value === null) return null;
  if (type == 'TIMESTAMP') return value instanceof Date ? value : new Date(value);
  if (type == 'BYTE_ARRAY') {
    if (value instanceof Uint8Array) return value;
    if (typeof Buffer == 'function' && Buffer.isBuffer(value)) {
      return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
    }
    return null;
  }
  if (type == 'JSON') return value;
  if (type == 'BOOLEAN') return !!value;
  if (type == 'INT32' || type == 'DOUBLE') {
    var num = Number(value);
    return Number.isFinite(num) ? num : null;
  }
  return String(value);
}

function getPropertyNames(properties, opts) {
  var index = {};
  // Hoisted fields are moved to the root of a GeoJSON Feature, so they are not
  // among a feature's properties and don't become columns.
  var hoisted = Array.isArray(opts.hoist) ? opts.hoist : [];
  properties.forEach(function(props) {
    Object.keys(props || {}).forEach(function(name) {
      if (hoisted.indexOf(name) == -1) index[name] = true;
    });
  });
  return Object.keys(index);
}

// A reader has to materialize an entire row group, so the meaningful unit is
// bytes, not rows: a row of point geometry runs to a few dozen bytes where a
// row of detailed polygon geometry can be tens of kilobytes. Sizing by a fixed
// row count therefore lands hundreds of times off in either direction, so the
// group size is derived from an estimate of the encoded row size instead.
// The estimate ignores Parquet's own encoding, which only ever shrinks a
// column, so groups tend to come out at half the target or less.
//
// The target is well below the 128MB that Hadoop-era guidance suggests, which
// assumed a row group should fill an HDFS block. Mapshaper holds a whole
// dataset in memory and needs roughly twenty times the output size to write
// it, so it tops out around a couple of hundred megabytes -- at 128MB nearly
// every file it can produce would be a single row group, giving readers no
// parallelism and nothing to skip when filtering. Measured on a 23MB layer,
// splitting one group into eight costs 0.03% of file size, so the smaller
// target is close to free.
export var ROW_GROUP_TARGET_BYTES = 16 * 1024 * 1024;
// A small leading group lets a reader fetching byte ranges over HTTP show the
// start of the table without pulling a full-sized group.
var ROW_GROUP_PREVIEW_BYTES = 1024 * 1024;
var ROW_GROUP_MAX_ROWS = 1000000;
var ROW_GROUP_SAMPLE_ROWS = 1000;

function getRowGroupSize(cursor, fields, hasGeometry, rowCount, override) {
  if (override) return override;
  var bytesPerRow = estimateRowBytes(cursor, fields, hasGeometry, rowCount);
  if (!bytesPerRow) return rowCount; // one group rather than the writer's default
  return planRowGroups(rowCount, bytesPerRow);
}

// Returns a rowGroupSize for the Parquet writer: either a row count, or a
// [preview, bulk] pair where the bulk size repeats for the rest of the file.
export function planRowGroups(rowCount, bytesPerRow) {
  var bulkRows = clampRowCount(ROW_GROUP_TARGET_BYTES / bytesPerRow, ROW_GROUP_MAX_ROWS);
  // Keep the preview well below a full group, otherwise splitting it off buys
  // a range reader nothing.
  var previewRows = clampRowCount(ROW_GROUP_PREVIEW_BYTES / bytesPerRow, Math.floor(bulkRows / 4));
  if (rowCount <= previewRows * 4) {
    return bulkRows;
  }
  // Spread the remaining rows evenly so that the file doesn't end with a runt
  // group holding a handful of rows.
  var rest = rowCount - previewRows;
  var groups = Math.ceil(rest / bulkRows);
  return [previewRows, Math.ceil(rest / groups)];
}

function clampRowCount(rows, max) {
  if (!(rows > 1)) return 1;
  if (max >= 1 && rows > max) return max;
  return Math.floor(rows);
}

// Converts the sampled rows one at a time and discards them, so that sizing
// the row groups doesn't itself materialize the layer.
function estimateRowBytes(cursor, fields, hasGeometry, rowCount) {
  // Sample at a stride rather than taking a prefix: layers are often sorted or
  // clustered, so the first rows are not representative.
  var step = Math.max(1, Math.floor(rowCount / ROW_GROUP_SAMPLE_ROWS));
  var total = 0;
  var sampled = 0;
  for (var i = 0; i < rowCount; i += step) {
    var feat = cursor.getFeature(i);
    var props = feat.properties;
    if (hasGeometry) {
      total += estimateValueBytes(feat.geometry || null);
    }
    for (var j = 0; j < fields.length; j++) {
      total += estimateValueBytes(
        normalizeFieldValue(props ? props[fields[j].name] : null, fields[j].type));
    }
    sampled++;
  }
  return sampled > 0 ? total / sampled : 0;
}

function estimateValueBytes(value) {
  if (value === null || value === undefined) return 1;
  if (typeof value == 'string') return value.length + 4;
  if (typeof value == 'number' || typeof value == 'bigint') return 8;
  if (typeof value == 'boolean') return 1;
  if (value instanceof Date) return 8;
  if (value instanceof Uint8Array) return value.byteLength + 4;
  if (utils.isObject(value) && utils.isString(value.type)) {
    return estimateWkbBytes(value);
  }
  return 32; // a JSON-encoded column; the exact width doesn't change the sizing
}

// WKB spends 1 byte on the byte order and 4 on the geometry type, 4 more on
// each nested element count, and 16 on each XY position.
function estimateWkbBytes(geom) {
  if (!geom || !geom.type) return 1;
  if (geom.type == 'GeometryCollection') {
    return (geom.geometries || []).reduce(function(memo, part) {
      return memo + estimateWkbBytes(part);
    }, 9);
  }
  return 5 + estimateCoordinateBytes(geom.coordinates);
}

function estimateCoordinateBytes(coords) {
  if (!Array.isArray(coords)) return 0;
  if (typeof coords[0] == 'number') return 16;
  var bytes = 4;
  for (var i = 0; i < coords.length; i++) {
    bytes += estimateCoordinateBytes(coords[i]);
  }
  return bytes;
}

function validateRowGroupSize(rowgroup) {
  if (rowgroup === undefined) return undefined;
  if (rowgroup >= 1 && Math.floor(rowgroup) === rowgroup) {
    return rowgroup;
  }
  stop('The rowgroup= option must be a positive integer number of rows');
}

// The schema is derived from the column types alone, before any rows are
// converted, because each row group is written as it is built and they all
// have to share one schema.
//
// A reader that understands the Parquet 2.11 GEOMETRY logical type takes the
// CRS from the logical type and ignores the "geo" metadata. When the logical
// type carries no CRS the spec default is OGC:CRS84, so projected data was
// being reported as WGS 84. Write the CRS in both places, as GDAL does, so
// that GeoParquet 1.x readers keep working.
function buildSchema(writer, fields, hasGeometry, crs) {
  var columnData = hasGeometry ?
    [{name: GEOMETRY_COLUMN, type: 'GEOMETRY'}] : [];
  var overrides;
  fields.forEach(function(field) {
    columnData.push({name: field.name, type: field.type});
  });
  if (hasGeometry && crs) {
    overrides = {};
    overrides[GEOMETRY_COLUMN] = {
      name: GEOMETRY_COLUMN,
      type: 'BYTE_ARRAY',
      repetition_type: 'OPTIONAL',
      logical_type: {type: 'GEOMETRY', crs: JSON.stringify(crs)}
    };
    // An overridden column must not also declare a type.
    columnData[0] = {name: GEOMETRY_COLUMN};
  }
  return writer.schemaFromColumnData({
    columnData: columnData,
    schemaOverrides: overrides
  });
}

function buildGeoMetadata(geomTypes, crs) {
  var geomMeta = {
    encoding: 'WKB',
    geometry_types: geomTypes
  };
  if (crs) {
    geomMeta.crs = crs;
  }
  return {
    version: '1.1.0',
    primary_column: 'geometry',
    columns: {
      geometry: geomMeta
    }
  };
}

function getGeoMetadataCrs(dataset) {
  var info = dataset && dataset.info || {};
  if (info.geoparquet_crs && utils.isObject(info.geoparquet_crs)) {
    return info.geoparquet_crs;
  }
  return convertCrsToProjjson(info.crs_string, info.wkt1);
}

function convertCrsToProjjson(crsString, wkt1) {
  var mproj = require('mproj');
  var converter = getProjjsonFromProj4Converter(mproj);
  if (!converter) return null;
  try {
    var crsObj = crsString ? parseCrsString(crsString) : (wkt1 ? parsePrj(wkt1) : null);
    if (!crsObj) return null;
    var projjson = converter(crsObj);
    if (utils.isString(projjson)) {
      projjson = JSON.parse(projjson);
    }
    return utils.isObject(projjson) ? projjson : null;
  } catch (e) {
    return null;
  }
}

function getProjjsonFromProj4Converter(mproj) {
  if (mproj && typeof mproj.projjson_from_proj4 == 'function') {
    return mproj.projjson_from_proj4;
  }
  if (mproj && mproj.internal && typeof mproj.internal.projjson_from_proj4 == 'function') {
    return mproj.internal.projjson_from_proj4;
  }
  return null;
}

function isGeoParquetWriter(mod) {
  return !!mod && typeof mod.ParquetWriter == 'function' &&
    typeof mod.ByteWriter == 'function' &&
    typeof mod.schemaFromColumnData == 'function';
}

async function loadGeoParquetWriter() {
  if (runningInBrowser()) {
    var mod = require('hyparquet-writer');
    if (mod && mod.default && !isGeoParquetWriter(mod)) {
      mod = mod.default;
    }
    if (!isGeoParquetWriter(mod)) {
      stop('GeoParquet writer library is not loaded');
    }
    return mod;
  }
  if (!writerPromise) {
    writerPromise = dynamicImportModule('hyparquet-writer');
  }
  var nodeMod = await writerPromise;
  return nodeMod.default && !isGeoParquetWriter(nodeMod) ? nodeMod.default : nodeMod;
}

async function getGeoParquetCompression(opts) {
  var codec = normalizeGeoParquetCompression(opts.compression);
  var level = validateGeoParquetCompressionLevel(opts.level, codec);
  if (codec != 'ZSTD') {
    return {codec: codec, compressors: null};
  }
  var zstd = await loadZstdLib();
  if (!zstd || typeof zstd.compress != 'function') {
    stop('GeoParquet ZSTD compressor is not loaded');
  }
  return {
    codec: codec,
    pageSize: getGeoParquetPageSize(level),
    compressors: {
      ZSTD: function(bytes) {
        return compressZstdPage(zstd, bytes, level);
      }
    }
  };
}

function compressZstdPage(zstd, bytes, level) {
  var compressed;
  try {
    compressed = zstd.compress(bytes, level);
  } catch (e) {
    stop('Unable to apply GeoParquet ZSTD compression. Try a lower level= value.');
  }
  if (!compressed) {
    stop('Unable to apply GeoParquet ZSTD compression. Try a lower level= value.');
  }
  return compressed;
}

function getGeoParquetPageSize(level) {
  return level >= 10 ? 64 * 1024 : undefined;
}

function normalizeGeoParquetCompression(compression) {
  var str = compression === undefined || compression === null ? 'snappy' : String(compression).toLowerCase();
  if (str == 'snappy') return 'SNAPPY';
  if (str == 'zstd') return 'ZSTD';
  if (str == 'none' || str == 'uncompressed') return null;
  stop('Unsupported GeoParquet compression:', compression);
}

function validateGeoParquetCompressionLevel(level, codec) {
  if (level === undefined) return undefined;
  if (codec != 'ZSTD') {
    stop('The level= option only applies with compression=zstd');
  }
  if (level >= 1 && level <= 22 && Math.floor(level) === level) {
    return level;
  }
  stop('GeoParquet ZSTD level= option must be an integer from 1 to 22');
}

async function loadZstdLib() {
  var mod;
  if (runningInBrowser()) {
    mod = require('@bokuweb/zstd-wasm');
  } else {
    if (!zstdPromise) {
      zstdPromise = dynamicImportModule('@bokuweb/zstd-wasm');
    }
    mod = await zstdPromise;
  }
  if (mod && mod.default && !mod.compress) {
    mod = mod.default;
  }
  if (!mod || typeof mod.init != 'function' || typeof mod.compress != 'function') {
    stop('GeoParquet ZSTD compressor is not loaded');
  }
  await mod.init();
  return initZstdCodec(mod);
}

function initZstdCodec(codec) {
  return codec;
}
