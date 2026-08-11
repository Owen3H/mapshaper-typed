import { internal, geom } from './gui-core';
import {
  appendFeature,
  deleteFeature,
  deleteLastArcs,
  splitArc
} from './gui-drawing-utils';

// Divide one path of one feature at one location (open path) or two locations
// (ring). See internal.planPathDivision() for the cut format.
//
// The shorter of the two resulting paths is split off into a new feature at the
// end of the layer, with a copy of the original feature's attributes; the
// longer one stays in place. For a multipart feature this leaves the longer
// path connected to the rest of the feature.
//
// Returns a descriptor for undoing the edit, or null if the cuts are degenerate.
//
export function snipPath(lyr, fid, partId, cuts) {
  var arcs = lyr.gui.source.dataset.arcs;
  var shp = lyr.shapes[fid];
  var path = shp[partId];
  var closed = geom.pathIsClosed(path, arcs);
  var prevShape = shp.map(function(part) { return part.concat(); });
  var arcCount = arcs.size();
  var plan = internal.planPathDivision(path, cuts, function(arcId) {
    return arcs.getVertexData().nn[arcId];
  }, arcCount, closed);
  var newShape, keep, remove, rec;
  if (!plan) return null;
  plan.splits.forEach(function(split) {
    splitArc(lyr, split.arcId, split.cuts);
  });
  if (internal.getPlanarPathLength(plan.a, arcs) >=
      internal.getPlanarPathLength(plan.b, arcs)) {
    keep = plan.a;
    remove = plan.b;
  } else {
    keep = plan.b;
    remove = plan.a;
  }
  newShape = shp.concat();
  newShape[partId] = keep;
  lyr.shapes[fid] = newShape;
  rec = lyr.data ? internal.copyRecord(lyr.data.getRecordAt(fid)) : null;
  appendFeature(lyr, [remove], rec);
  return {
    fid: fid,
    partId: partId,
    cuts: cuts,
    prevShape: prevShape,
    newFeatureId: lyr.shapes.length - 1,
    appendedArcCount: arcs.size() - arcCount
  };
}

export function undoSnip(lyr, result) {
  deleteFeature(lyr, result.newFeatureId);
  lyr.shapes[result.fid] = result.prevShape;
  deleteLastArcs(lyr, result.appendedArcCount);
}
