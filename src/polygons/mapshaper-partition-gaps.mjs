import { buildInterFeatureMedialLines } from '../buffer/mapshaper-buffer-voronoi';
import { mergeArcs } from '../dataset/mapshaper-merging';
import geom from '../geom/mapshaper-geom';
import { ArcCollection } from '../paths/mapshaper-arcs';
import { getSliverFilter } from '../polygons/mapshaper-slivers';
import { MosaicIndex } from '../polygons/mapshaper-mosaic-index';
import { message } from '../utils/mapshaper-logging';
import utils from '../utils/mapshaper-utils';

var MIN_GAP_OWNERS = 3;
var WIDTH_FACTOR = 4;

// Split enclosed sliver gaps that border three or more features along local
// nearest-boundary (Voronoi) lines. The existing mosaic assignment can then
// distribute the resulting pieces among their adjacent features instead of
// handing the entire long gap to one owner.
//
// The medial construction receives only arcs on selected gap boundaries, so its
// cost scales with the gaps being repaired rather than with the full mosaic.
// Returns true after adding cut-line arcs to the dataset.
export function partitionPolygonMosaicGaps(lyr, dataset, nodes, opts) {
  if (!lyr.shapes || lyr.shapes.length < MIN_GAP_OWNERS) return false;
  var mosaicIndex = new MosaicIndex(lyr, nodes, {flat: true});
  var sliverOpts = utils.extend({sliver_control: 1, gap_fill_area: 'auto'}, opts);
  var filter = getSliverFilter(lyr, dataset, sliverOpts).filter;
  var gaps = mosaicIndex.getUnusedTileData(filter).filter(function(gap) {
    return countOwners(gap.boundary) >= MIN_GAP_OWNERS;
  });
  if (gaps.length === 0) return false;

  var cuts = [];
  gaps.forEach(function(gap) {
    var result = buildGapMedialLines(gap, lyr.shapes.length, nodes.arcs);
    if (!result) return;
    result.lines.forEach(function(line) {
      if (line.length < 2) return;
      cuts.push(line);
    });
  });
  if (cuts.length === 0) return false;

  var firstCutArc = dataset.arcs.size();
  dataset.arcs = mergeArcs([dataset.arcs, new ArcCollection(cuts)]);
  // Keep cut arcs in a temporary line layer while addIntersectionCuts() nodes
  // them against the gap boundary. The caller removes this layer before polygon
  // cleaning and passes its updated arc ids to the mosaic node filter.
  var cutLayer = {
    geometry_type: 'polyline',
    shapes: cuts.map(function(line, i) {
      return [[firstCutArc + i]];
    })
  };
  dataset.layers.push(cutLayer);
  message(utils.format('Partitioned %s multi-feature interior gap%s',
    gaps.length, utils.pluralSuffix(gaps.length)));
  return cutLayer;
}

function countOwners(boundary) {
  var owners = {};
  boundary.forEach(function(o) { owners[o.shapeId] = true; });
  return Object.keys(owners).length;
}

function buildGapMedialLines(gap, shapeCount, arcs) {
  var shapes = new Array(shapeCount);
  var distances = new Array(shapeCount).fill(0);
  var owners = {};
  gap.boundary.forEach(function(o) {
    if (!shapes[o.shapeId]) shapes[o.shapeId] = [];
    // Each boundary arc is a separate path; joining arcs from different portions
    // of a concave gap would introduce synthetic connecting segments.
    shapes[o.shapeId].push([o.arcId]);
    owners[o.shapeId] = true;
  });

  var ownerIds = Object.keys(owners).map(Number);
  if (ownerIds.length < MIN_GAP_OWNERS) return null;
  var width = estimateGapWidth(gap.tile[0], arcs);
  if (!(width > 0)) return null;
  ownerIds.forEach(function(id) { distances[id] = width; });
  var medial = buildInterFeatureMedialLines(shapes, distances, arcs, {
    smooth: true,
    no_extend: true
  });
  if (!medial || !medial.coordinates.length) return null;
  return {
    lines: connectMedialJunctions(medial.coordinates, width)
  };
}

// The sampled Voronoi branches around a 3+ owner junction can terminate at
// separate nearby circumcenters, leaving every branch acyclic. Join clusters of
// three or more such endpoints to a common hub so the local cut network divides
// the gap into owner-facing regions. Far endpoints (where branches cross the gap
// boundary) remain untouched.
function connectMedialJunctions(lines, width) {
  var endpoints = [];
  lines.forEach(function(line, lineId) {
    endpoints.push({point: line[0], lineId: lineId});
    endpoints.push({point: line[line.length - 1], lineId: lineId});
  });
  var maxDist = width * 3;
  var used = new Uint8Array(endpoints.length);
  var junctionEnds = new Uint8Array(endpoints.length);
  var connectors = [];
  endpoints.forEach(function(endpoint, i) {
    if (used[i]) return;
    var group = [];
    var stack = [i];
    used[i] = 1;
    while (stack.length) {
      var id = stack.pop();
      group.push(endpoints[id]);
      endpoints.forEach(function(other, j) {
        if (used[j] || other.lineId == endpoints[id].lineId) return;
        if (geom.distance2D(
          endpoints[id].point[0], endpoints[id].point[1],
          other.point[0], other.point[1]) <= maxDist) {
          used[j] = 1;
          stack.push(j);
        }
      });
    }
    var lineIds = {};
    group.forEach(function(o) { lineIds[o.lineId] = true; });
    if (Object.keys(lineIds).length < MIN_GAP_OWNERS) return;
    var hub = group.reduce(function(memo, o) {
      memo[0] += o.point[0];
      memo[1] += o.point[1];
      return memo;
    }, [0, 0]);
    hub[0] /= group.length;
    hub[1] /= group.length;
    group.forEach(function(o) {
      connectors.push([o.point, hub]);
    });
    group.forEach(function(o) {
      junctionEnds[endpoints.indexOf(o)] = 1;
    });
  });
  var extended = lines.map(function(line, lineId) {
    var out = line.concat();
    if (!junctionEnds[lineId * 2]) {
      var head = projectPast(out[0], out[1], width);
      if (head) out.unshift(head);
    }
    if (!junctionEnds[lineId * 2 + 1]) {
      var n = out.length;
      var tail = projectPast(out[n - 1], out[n - 2], width);
      if (tail) out.push(tail);
    }
    return out;
  });
  return extended.concat(connectors);
}

function projectPast(from, toward, distance) {
  var dx = from[0] - toward[0];
  var dy = from[1] - toward[1];
  var len = Math.sqrt(dx * dx + dy * dy);
  if (!(len > 0)) return null;
  return [
    from[0] + dx / len * distance,
    from[1] + dy / len * distance
  ];
}

function estimateGapWidth(ring, arcs) {
  var area = Math.abs(geom.getPlanarPathArea(ring, arcs));
  // Medial construction operates in source-coordinate space, so area and
  // perimeter must both be planar here even when the source CRS is geographic.
  var perimeter = geom.getPlanarPathPerimeter(ring, arcs);
  // For a long narrow polygon, 2A/P approximates its width. A modest multiplier
  // gives opposite banks enough reach at locally wider junctions without using
  // the gap's (potentially enormous) length as the medial sampling scale.
  return perimeter > 0 ? area / perimeter * 2 * WIDTH_FACTOR : 0;
}
