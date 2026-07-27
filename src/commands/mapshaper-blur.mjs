import cmd from '../mapshaper-cmd';
import { getDatasetCRS, requireProjectedDataset } from '../crs/mapshaper-projections';
import { layerHasRaster } from '../dataset/mapshaper-layer-utils';
import { blurRasterGrid } from '../rasters/mapshaper-raster-blur';
import { createRasterPreview } from '../rasters/mapshaper-raster-utils';
import { runningInBrowser } from '../mapshaper-env';
import { stop } from '../utils/mapshaper-logging';
import {
  markLayerChanged,
  noteLayerWillChange
} from '../undo/mapshaper-undo-tracking';

cmd.blur = blurRasterLayers;

export function blurRasterLayers(layers, dataset, optsArg) {
  var opts = optsArg || {};
  var crs = getDatasetCRS(dataset);
  requireProjectedDataset(dataset);
  layers.forEach(function(lyr) {
    if (!layerHasRaster(lyr)) {
      stop('Command requires a raster layer');
    }
    blurRasterLayer(lyr, opts, crs);
  });
}

function blurRasterLayer(lyr, opts, crs) {
  var raster = lyr.raster;
  noteLayerWillChange(lyr, {operation: 'blurRasterLayer', unit: 'raster'});
  raster.grid = blurRasterGrid(raster, opts, crs);
  raster.view = raster.view || {};
  delete raster.view.scalingStats;
  if (runningInBrowser()) {
    raster.view.preview = createRasterPreview(raster, opts);
  } else {
    delete raster.view.preview;
  }
  markLayerChanged(lyr, {operation: 'blurRasterLayer', unit: 'raster'});
}
