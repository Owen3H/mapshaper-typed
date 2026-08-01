---
title: File formats
description: A quick comparison of every file format Mapshaper can read and write, with links to per-format details.
---

# File formats

This section explains how each supported file format is handled, what format-specific options are available, and what to watch out for.

## Comparison

<div class="formats-table-wrap">

| Format | Extension | Read | Write | Geometry | Attributes | Topology | Multi-layer |
|---|---|:---:|:---:|---|---|:---:|:---:|
| [Shapefile](/docs/formats/shapefile.html.md) | `.shp` `.shx` `.dbf` `.prj` `.cpg` | &check; | &check; | vector | DBF (10-char names) | &mdash; | &mdash; |
| [GeoJSON](/docs/formats/geojson.html.md) | `.json` `.geojson` | &check; | &check; | vector | yes | &mdash; | &mdash; |
| [TopoJSON](/docs/formats/topojson.html.md) | `.json` `.topojson` | &check; | &check; | vector | yes | **&check;** | &check; |
| [GeoPackage](/docs/formats/geopackage.html.md) | `.gpkg` | &check; | &check; | vector | yes | &mdash; | &check; |
| [FlatGeobuf](/docs/formats/flatgeobuf.html.md) | `.fgb` | &check; | &check; | vector | yes | &mdash; | &mdash; |
| [GeoParquet](/docs/formats/geoparquet.html.md) | `.parquet` `.geoparquet` | &check; | &check; | vector | yes | &mdash; | &mdash; |
| [KML / KMZ](/docs/formats/kml.html.md) | `.kml` `.kmz` | &check; | &check; | vector | limited | &mdash; | &check; |
| [CSV / TSV](/docs/formats/csv.html.md) | `.csv` `.tsv` | &check; | &check; | points (X/Y) | yes | &mdash; | &mdash; |
| [DBF](/docs/formats/dbf.html.md) | `.dbf` | &check; | &check; | none | yes | &mdash; | &mdash; |
| [JSON records](/docs/formats/json.html.md) | `.json` | &check; | &check; | none | yes | &mdash; | &mdash; |
| GeoTIFF | `.tif` `.tiff` | &check; | &check; | raster | &mdash; | &mdash; | &mdash; |
| PNG / JPEG raster | `.png` `.jpg` `.jpeg` | &check; | &mdash; | raster (with world file) | &mdash; | &mdash; | &mdash; |
| [SVG](/docs/formats/svg.html.md) | `.svg` | &check; | &check; | vector | as `data-*` | &mdash; | &check; |
| [Mapshaper snapshot](/docs/formats/snapshot.html.md) | `.msx` | &check; | &check; | vector | yes | **&check;** | &check; |

</div>

A few things worth knowing across all formats:

- **Auto-detection by extension.** You usually don't need to tell Mapshaper what format a file is — the input and output format are both inferred from the file extension. Use `format=` on `-i` or `-o` to override.
- **TopoJSON is the only interchange format that preserves topology** in the file itself. Topology-aware operations like [`-dissolve`](/docs/reference.html.md#-dissolve), [`-clean`](/docs/reference.html.md#-clean) and [`-simplify`](/docs/reference.html.md#-simplify) work correctly regardless of the input format, but only TopoJSON keeps shared boundaries between adjacent polygons from being duplicated on disk. (Mapshaper's own [`.msx`](/docs/formats/snapshot.html.md) snapshots also preserve topology, but they're not readable by other tools.)
- **Encoding.** The `encoding=` option on `-i` and `-o` applies to Shapefile, DBF and CSV/TSV i/o (UTF-8 is the default) &mdash; the other formats are UTF-8-only.
- **Raster and vector layers export separately.** GeoTIFF is the only output format that takes a raster layer's pixels, and it takes nothing else, so `-o` needs a `target=` when a session holds both kinds of layer. SVG and `.msx` snapshots are the two formats that accept a mix. A GeoTIFF written by Mapshaper keeps the pixel values as they are, in the type they were read in, so an elevation model comes out as elevations rather than as an image; the pixels are Deflate-compressed unless you ask for `compression=none`. The layer's projection is written into the file, either as an EPSG code or spelled out parameter by parameter. A handful of projections &mdash; Mapshaper's interrupted and composite ones among them &mdash; have no GeoTIFF representation at all; for those, Mapshaper writes the projection to a small `.aux.xml` file next to the `.tif`, so keep the two together, since that's where GIS software will look for it.
