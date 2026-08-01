import { fromFeature } from 'flatgeobuf/lib/mjs/geojson/feature.js';
import { serialize } from 'flatgeobuf/lib/mjs/geojson/featurecollection.js';
import { buildFeature } from 'flatgeobuf/lib/mjs/generic/feature.js';
import { buildHeader } from 'flatgeobuf/lib/mjs/generic/featurecollection.js';
import { magicbytes, SIZE_PREFIX_LEN } from 'flatgeobuf/lib/mjs/constants.js';
import { Header } from 'flatgeobuf/lib/mjs/flat-geobuf/header.js';
import { Crs } from 'flatgeobuf/lib/mjs/flat-geobuf/crs.js';
import { Column } from 'flatgeobuf/lib/mjs/flat-geobuf/column.js';
import { GeometryType } from 'flatgeobuf/lib/mjs/flat-geobuf/geometry-type.js';
import { parseGC, parseGeometry } from 'flatgeobuf/lib/mjs/geojson/geometry.js';
import * as flatbuffers from 'flatbuffers';
import { fromByteBuffer } from 'flatgeobuf/lib/mjs/header-meta.js';
import { calcTreeSize } from 'flatgeobuf/lib/mjs/packedrtree.js';
import { Feature } from 'flatgeobuf/lib/mjs/flat-geobuf/feature.js';


// bytes: Uint8Array
function getHeaderMeta(bytes) {
  if (!bytes.subarray(0, 3).every((v, i) => magicbytes[i] === v)) {
    throw new Error('Not a FlatGeobuf file');
  }
  var bb = new flatbuffers.ByteBuffer(bytes);
  bb.setPosition(magicbytes.length + SIZE_PREFIX_LEN);
  return fromByteBuffer(bb);
}

// bytes: Uint8Array
function getFeatureReader(bytes, headerMetaArg) {
  if (!bytes.subarray(0, 3).every((v, i) => magicbytes[i] === v)) {
    throw new Error('Not a FlatGeobuf file');
  }
  var bb = new flatbuffers.ByteBuffer(bytes);
  var headerLength = bb.readUint32(magicbytes.length);
  var headerMeta = headerMetaArg || getHeaderMeta(bytes);
  var offset = magicbytes.length + SIZE_PREFIX_LEN + headerLength;
  var { indexNodeSize, featuresCount } = headerMeta;
  // protect against infinite loop in calcTreeSize()
  if (indexNodeSize > 0 && featuresCount > 0) {
    offset += calcTreeSize(featuresCount, indexNodeSize);
  }
  var id = 0;
  return function readFeature() {
    var geojsonFeature;
    if (offset >= bb.capacity()) {
      return null;
    }
    var featureLength = bb.readUint32(offset);
    bb.setPosition(offset);
    var feature = Feature.getSizePrefixedRootAsFeature(bb);
    geojsonFeature = fromFeature(id++, feature, headerMeta);
    delete geojsonFeature.id;
    offset += SIZE_PREFIX_LEN + featureLength;
    return geojsonFeature;
  };
}

function buildHeaderWithCRS(headerMeta, crsMeta) {
  var builder = new flatbuffers.Builder();
  var columnsOffset = createColumnsVector(builder, headerMeta.columns || []);
  var crsOffset = createCrs(builder, crsMeta);
  var nameOffset = builder.createString((headerMeta && headerMeta.name) || 'L1');
  var titleOffset = headerMeta && headerMeta.title ? builder.createString(headerMeta.title) : 0;
  var descriptionOffset = headerMeta && headerMeta.description ? builder.createString(headerMeta.description) : 0;
  var metadataOffset = headerMeta && headerMeta.metadata ? builder.createString(headerMeta.metadata) : 0;

  Header.startHeader(builder);
  Header.addName(builder, nameOffset);
  if (crsOffset) Header.addCrs(builder, crsOffset);
  Header.addFeaturesCount(builder, BigInt(headerMeta.featuresCount || 0));
  Header.addGeometryType(builder, headerMeta.geometryType || 0);
  Header.addIndexNodeSize(builder, headerMeta.indexNodeSize || 0);
  if (columnsOffset) Header.addColumns(builder, columnsOffset);
  if (titleOffset) Header.addTitle(builder, titleOffset);
  if (descriptionOffset) Header.addDescription(builder, descriptionOffset);
  if (metadataOffset) Header.addMetadata(builder, metadataOffset);
  var offset = Header.endHeader(builder);
  builder.finishSizePrefixed(offset);
  return builder.asUint8Array();
}

// source: a feature cursor, {length, getFeature(i)}. Features are pulled and
// encoded one at a time rather than as a collection, because the GeoJSON form
// of a layer is several times larger than the FlatGeobuf it encodes into.
function serializeWithColumns(source, columns) {
  if (source.length === 0) {
    throw new Error('Could not infer geometry type for collection of features.');
  }
  // The header precedes the features and declares the collection's geometry
  // type, but that type isn't known until every feature has been seen. Assume
  // the layer is homogeneous, which nearly all are, and encode again as
  // Unknown in the rare case that it isn't.
  return encodeCollection(source, columns, null) ||
    encodeCollection(source, columns, GeometryType.Unknown);
}

// Returns null if forcedType is null and the features turn out to have more
// than one geometry type.
function encodeCollection(source, columns, forcedType) {
  var headerMeta = null;
  var sink = null;
  for (var i = 0; i < source.length; i++) {
    var feature = source.getFeature(i);
    var type = GeometryType[feature.geometry.type] || GeometryType.Unknown;
    if (!headerMeta) {
      headerMeta = {
        geometryType: forcedType === null ? type : forcedType,
        columns: columns,
        envelope: null,
        featuresCount: source.length,
        indexNodeSize: 0,
        crs: null,
        title: null,
        description: null,
        metadata: null
      };
      sink = new ByteSink(magicbytes.length + estimateEncodedBytes(source));
      sink.append(magicbytes);
      sink.append(buildHeader(headerMeta));
    } else if (forcedType === null && type != headerMeta.geometryType) {
      return null;
    }
    var geometry = feature.geometry.type == 'GeometryCollection' ?
      parseGC(feature.geometry) :
      parseGeometry(feature.geometry);
    omitRedundantGeometryType(geometry, headerMeta.geometryType);
    sink.append(buildFeature(geometry, normalizeProperties(feature.properties, columns), headerMeta));
  }
  return sink.toBytes();
}

// Encoding the first feature is the only sample available before the buffer
// has to be allocated; overshooting costs a resize, which is why it is loose.
function estimateEncodedBytes(source) {
  return Math.max(source.length * 64, 1024);
}

function ByteSink(initialSize) {
  this.bytes = new Uint8Array(initialSize);
  this.length = 0;
}

ByteSink.prototype.append = function(chunk) {
  if (this.length + chunk.length > this.bytes.length) {
    var size = this.bytes.length;
    while (size < this.length + chunk.length) size *= 2;
    var grown = new Uint8Array(size);
    grown.set(this.bytes.subarray(0, this.length));
    this.bytes = grown;
  }
  this.bytes.set(chunk, this.length);
  this.length += chunk.length;
};

ByteSink.prototype.toBytes = function() {
  return this.bytes.subarray(0, this.length);
};

function omitRedundantGeometryType(geometry, headerType) {
  if (headerType != GeometryType.Unknown && geometry.type == headerType) {
    geometry.type = GeometryType.Unknown;
  }
}

function normalizeProperties(properties, columns) {
  var copy = {};
  properties = properties || {};
  columns.forEach(function(column) {
    var val = properties[column.name];
    copy[column.name] = val === undefined ? null : val;
  });
  return copy;
}

function createColumnsVector(builder, columns) {
  if (!columns || columns.length === 0) return 0;
  var offsets = columns.map(function(col) {
    var nameOffset = builder.createString(col.name);
    var titleOffset = col.title ? builder.createString(col.title) : 0;
    var descriptionOffset = col.description ? builder.createString(col.description) : 0;
    var metadataOffset = col.metadata ? builder.createString(col.metadata) : 0;
    Column.startColumn(builder);
    Column.addName(builder, nameOffset);
    Column.addType(builder, col.type);
    if (titleOffset) Column.addTitle(builder, titleOffset);
    if (descriptionOffset) Column.addDescription(builder, descriptionOffset);
    if (typeof col.width == 'number') Column.addWidth(builder, col.width);
    if (typeof col.precision == 'number') Column.addPrecision(builder, col.precision);
    if (typeof col.scale == 'number') Column.addScale(builder, col.scale);
    if (typeof col.nullable == 'boolean') Column.addNullable(builder, col.nullable);
    if (typeof col.unique == 'boolean') Column.addUnique(builder, col.unique);
    if (typeof col.primary_key == 'boolean') Column.addPrimaryKey(builder, col.primary_key);
    if (metadataOffset) Column.addMetadata(builder, metadataOffset);
    return Column.endColumn(builder);
  });
  return Header.createColumnsVector(builder, offsets);
}

function createCrs(builder, crsMeta) {
  if (!crsMeta) return 0;
  var orgOffset = crsMeta.org ? builder.createString(crsMeta.org) : 0;
  var nameOffset = crsMeta.name ? builder.createString(crsMeta.name) : 0;
  var descriptionOffset = crsMeta.description ? builder.createString(crsMeta.description) : 0;
  var wktOffset = crsMeta.wkt ? builder.createString(crsMeta.wkt) : 0;
  var codeStringOffset = crsMeta.code_string ? builder.createString(crsMeta.code_string) : 0;
  Crs.startCrs(builder);
  if (orgOffset) Crs.addOrg(builder, orgOffset);
  if (typeof crsMeta.code == 'number') Crs.addCode(builder, crsMeta.code);
  if (nameOffset) Crs.addName(builder, nameOffset);
  if (descriptionOffset) Crs.addDescription(builder, descriptionOffset);
  if (wktOffset) Crs.addWkt(builder, wktOffset);
  if (codeStringOffset) Crs.addCodeString(builder, codeStringOffset);
  return Crs.endCrs(builder);
}

export {
  getHeaderMeta,
  getFeatureReader,
  serialize,
  serializeWithColumns,
  buildHeader,
  buildHeaderWithCRS,
  magicbytes,
  SIZE_PREFIX_LEN
};
