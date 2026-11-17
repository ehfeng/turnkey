# Level name

Replace this heading with the display name and enter the directory's level ID here, `<level-id>`. Describe the extent of this level and link its rooms under `rooms/<room-id>/`.

## Alignment

| Reference | Level-specific value |
| --- | --- |
| Plan origin | Physical reference tying this level to the house X/Y origin |
| Elevation | Physical finished-floor reference at level-local z=0 and its elevation in mm above the house Z datum |
| Orientation | Physical direction of drawing-right and drawing-up, with a link to the reference plan |

Use the X/Y origin and directions in `house/README.md` on every level. Coordinates are in mm. +X is drawing-right, +Y is up the plan and +Z is vertically up. Plan rotation runs counterclockwise from +X when viewed from above. Author heights from the level's finished-floor reference and add the level elevation **once**, when assembling the house. For imports, record the source units, origin and axes plus the conversion or control points that place the file in this frame. Mark unverified alignment as unknown.

## Shared geometry

Link the editable shell and identify its inputs. Give shared walls, openings and vertical connections stable feature IDs so both adjoining rooms can refer to the same geometry. Link another level wherever a feature crosses floors.

Build the shell in [model/build.mjs](model/build.mjs). Set `elevationMm` there when the datum is known and record its evidence above. The viewer adds the rooms belonging to this floor. Open `/?scope=level/<level-id>` on the local preview server to inspect their fit.

| Feature ID | Phase (existing, demolition or proposed) | Affected room/level IDs | Editable source and measurement IDs |
| --- | --- | --- | --- |

Keep existing conditions traceable when adding demolition and proposal layers. Identify the option when more than one scheme changes a feature.

## Measurements

Record one observation per row in [measurements.csv](measurements.csv). Choose a stable ID unique within the level and cite it elsewhere as `<level-id>/<measurement-id>`.

- Describe the quantity and both endpoints. Specify the wall face, edge, or centerline and the height of the reading where relevant.
- Keep the original value and unit. Enter its numeric conversion in mm for design use. Use `measured` for a direct site reading, `reported` for a value quoted from a plan or person, and `assumed` for a design estimate.
- Record the observation date (YYYY-MM-DD) and uncertainty in mm when known. Leave unknown values blank. Set `evidence_path` to a repository-relative path without a leading slash, and `source_locator` to a sheet/detail, image label, or survey row.
- Preserve conflicting observations as separate rows with their own IDs. In the table below, cite every relevant ID, identify the reading the shell uses and explain why. Mark unresolved discrepancies and which rooms or exports may need updating.

| Feature or quantity | Observation IDs | Adopted ID or unresolved | Rationale and affected work |
| --- | --- | --- | --- |
