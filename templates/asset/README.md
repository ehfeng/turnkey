# Asset name

Copy this folder to `assets/<asset-id>/`. Keep the ID when the display name changes.

| Asset record | Value |
| --- | --- |
| Asset ID | `<asset-id>` |
| Represents | Product name, model number, finish |
| Source and licence | Where the files or data came from and the known usage terms |
| Editable entry point | `model/build.mjs`, or the supplied file it loads |
| Native units, axes and pivot | For supplied models, before the import transform |
| Real size (W × D × H) | In millimetres, with the spec or measurement it comes from. Flag estimates. |
| Anchor | The point at the builder's origin, e.g. footprint centre at the underside |

## Import transform

Describe how `model/build.mjs` turns the supplied file into the project frame (metres, Y up, origin at the anchor) and record one dimension you checked after import, such as "seat width 0.80 m in the viewer".

## Placement library

In `model/metadata.mjs`, export `catalogEntry` with a name, positive `size_x_mm`, `size_y_mm`, `size_z_mm`, and an anchor description. The viewer reads this metadata without loading the asset mesh.

## Preview

Open `/?scope=asset/<asset-id>` on the local preview server.
