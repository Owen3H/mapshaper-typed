import { exportLayerAsGeoJSON } from '../geojson/geojson-export';
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
    var features = exportLayerAsGeoJSON(lyr, dataset, opts, true, null);
    var hasGeometry = features.some(function(feat) {
      return !!feat.geometry;
    });
    var output = buildGeoParquetColumns(features, hasGeometry);
    var crs = hasGeometry ? getGeoMetadataCrs(dataset) : null;
    var writeOptions = {
      columnData: output.columnData,
      codec: compression.codec,
      compressors: compression.compressors,
      pageSize: compression.pageSize,
      rowGroupSize: getRowGroupSize(output.columnData, features.length, rowGroupOverride)
    };
    if (hasGeometry) {
      writeOptions.kvMetadata = [{
        key: 'geo',
        value: JSON.stringify(buildGeoMetadata(features, crs))
      }];
      applyGeometryColumnCrs(writer, writeOptions, output.geometryColumn, crs);
    } else {
      warn('GeoParquet export: layer has no geometry; writing attribute data only.');
    }
    var content = writer.parquetWriteBuffer(writeOptions);
    files.push({
      filename: filenameOverride || (lyr.name + '.' + extension),
      content: content
    });
  });
  return files;
}

function buildGeoParquetColumns(features, includeGeometry) {
  var geometryName = 'geometry';
  var names = getPropertyNames(features);
  var columnData = [];
  if (features.length === 0) {
    stop('GeoParquet export requires at least one record');
  }
  if (includeGeometry) {
    columnData.push({
      name: geometryName,
      data: features.map(function(feat) {
        return feat.geometry || null;
      }),
      type: 'GEOMETRY'
    });
  }
  names.forEach(function(name) {
    var values = features.map(function(feat) {
      return feat.properties ? feat.properties[name] : null;
    });
    columnData.push(buildAttributeColumn(name, values));
  });
  if (columnData.length === 0) {
    stop('GeoParquet export requires geometry or attribute data');
  }
  return {columnData: columnData, geometryColumn: geometryName};
}

function buildAttributeColumn(name, values) {
  var info = inferColumnType(values);
  return {
    name: name,
    data: values.map(function(value) {
      return normalizeFieldValue(value, info.type);
    }),
    type: info.type
  };
}

function inferColumnType(values) {
  var type = null;
  for (var i = 0; i < values.length; i++) {
    var valueType = inferValueType(values[i]);
    if (!valueType) continue;
    if (!type) {
      type = valueType;
    } else if (type != valueType) {
      if ((type == 'INT32' || type == 'DOUBLE') &&
          (valueType == 'INT32' || valueType == 'DOUBLE')) {
        type = 'DOUBLE';
      } else {
        type = 'STRING';
        break;
      }
    }
  }
  return {type: type || 'STRING'};
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

function getPropertyNames(features) {
  var index = {};
  features.forEach(function(feat) {
    var props = feat.properties || {};
    Object.keys(props).forEach(function(name) {
      index[name] = true;
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

function getRowGroupSize(columnData, rowCount, override) {
  if (override) return override;
  if (!rowCount) return undefined; // let the writer apply its own default
  var bytesPerRow = estimateRowBytes(columnData, rowCount);
  if (!bytesPerRow) return undefined;
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

function estimateRowBytes(columnData, rowCount) {
  // Sample at a stride rather than taking a prefix: layers are often sorted or
  // clustered, so the first rows are not representative.
  var step = Math.max(1, Math.floor(rowCount / ROW_GROUP_SAMPLE_ROWS));
  var total = 0;
  var sampled = 0;
  for (var i = 0; i < rowCount; i += step) {
    for (var j = 0; j < columnData.length; j++) {
      total += estimateValueBytes(columnData[j].data[i]);
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

// A reader that understands the Parquet 2.11 GEOMETRY logical type takes the
// CRS from the logical type and ignores the "geo" metadata. When the logical
// type carries no CRS the spec default is OGC:CRS84, so projected data was
// being reported as WGS 84. Write the CRS in both places, as GDAL does, so
// that GeoParquet 1.x readers keep working.
function applyGeometryColumnCrs(writer, writeOptions, geometryName, crs) {
  if (!crs || typeof writer.schemaFromColumnData != 'function') return;
  var column = writeOptions.columnData.find(function(col) {
    return col.name === geometryName;
  });
  if (!column || column.type != 'GEOMETRY' && column.type != 'GEOGRAPHY') return;
  var override = {
    name: geometryName,
    type: 'BYTE_ARRAY',
    repetition_type: 'OPTIONAL',
    logical_type: {type: column.type, crs: JSON.stringify(crs)}
  };
  var overrides = {};
  overrides[geometryName] = override;
  // The writer rejects a column that declares both a type and a schema, so the
  // schema has to be derived before the declared types are dropped.
  var schema = writer.schemaFromColumnData({
    columnData: writeOptions.columnData.map(function(col) {
      return col.name === geometryName ? omitColumnType(col) : col;
    }),
    schemaOverrides: overrides
  });
  writeOptions.schema = schema;
  writeOptions.columnData = writeOptions.columnData.map(omitColumnType);
}

function omitColumnType(col) {
  var copy = {};
  Object.keys(col).forEach(function(key) {
    if (key != 'type') copy[key] = col[key];
  });
  return copy;
}

function buildGeoMetadata(features, crs) {
  var geomTypes = utils.uniq(features.map(function(feat) {
    return feat.geometry && feat.geometry.type || null;
  }).filter(Boolean));
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

async function loadGeoParquetWriter() {
  if (runningInBrowser()) {
    var mod = require('hyparquet-writer');
    if (mod && mod.default && !mod.parquetWriteBuffer) {
      mod = mod.default;
    }
    if (!mod || !mod.parquetWriteBuffer) {
      stop('GeoParquet writer library is not loaded');
    }
    return mod;
  }
  if (!writerPromise) {
    writerPromise = dynamicImportModule('hyparquet-writer');
  }
  var nodeMod = await writerPromise;
  return nodeMod.default && !nodeMod.parquetWriteBuffer ? nodeMod.default : nodeMod;
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
