# Room name

Copy this folder to `rooms/<room-id>/`, replace the heading with the room name, and fill in the room record below. Set `levelId` in the builder when the parent level is known.

## Working on this room

| Change | Edit and verify |
| --- | --- |
| Move or resize furniture | For a model with its own dimensions, update the named values in [model/build.mjs](model/build.mjs) and its row in [furniture.csv](furniture.csv). For an asset placed directly from its schedule row with `placeFromRow`, edit the row. Check the footprint, opening travel and walking space in the viewer. |
| Change a finish | Update [finishes.csv](finishes.csv) and the corresponding material in the builder. |
| Compare layouts | Use the same option ID in the builder and its option-specific furniture rows. Preview the layout with `&option=<option-id>` and record the owner's selection under [Options](#options). |
| Change a wall or opening | The parent level owns the shell. Record field readings in its `measurements.csv`, edit its plan, and check the adjoining rooms in `/?scope=level/<level-id>&view=plan`. Replace this entry with the level's path and shared feature IDs when known. |

### Try the furniture check

The starter's default room is empty. Start `npm run preview` and open `/?scope=room/<room-id>&option=example-shelf` using the new room ID. The builder draws the shelf from `exampleShelf`. Its anchor is the centre of the underside, and its placement and dimensions use room-local millimetres. `compareFurnitureSchedule` checks the resolved `example-shelf` row against those model values.

Run `npm run validate` with the matching row. To try a placement error, increase only `x_mm` by 20 in the CSV and run validation again. The error names the room, option, item and field. Restore `x_mm` and repeat with `size_y_mm` to test depth. Restore the depth and confirm validation passes. When adding the real furniture, replace or remove the example in both the builder and the CSV.

## Room record

| Room record | Value |
| --- | --- |
| Room ID | `<room-id>` |
| Level and shell | `house/levels/<level-id>/` |
| Design brief | Intended uses, priorities, and constraints |
| Evidence | Measurement IDs and paths under `sources/` |
| Open questions | See [Open questions](#open-questions) |

## Existing, demolition, and proposed work

- **Existing** — Describe what is present, cite the measured boundaries and openings in the level shell, and identify items to retain.
- **Demolition** — Identify existing elements or furniture to remove or move, with references to their IDs.
- **Proposed** — Describe the changes and link their plans, furniture layouts, or models. If a change moves a shared wall or opening, identify the affected rooms and coordinate the edit in the level shell.

## Options

Give each alternative a short stable ID. Record the question it answers, its assumptions, and any decision or supporting evidence. Group option-specific files under `options/<option-id>/` when needed. Identify the selected option here once a decision is recorded.

## Browser preview

Set `levelId` in [model/build.mjs](model/build.mjs) to the parent level's folder name. If the room is drawn in its own frame, record its origin here and set `placement` to where that origin sits in the level (or `null` while unknown). Add room-owned geometry in `buildRoom` and open `/?scope=room/<room-id>` on the local preview server. Add `&option=<option-id>` to show an option. To check the furnished room against its shell, open `/?scope=level/<level-id>`. Record the option currently shown here. If you add a `buildProvisionalShell`, say which walls it draws and what evidence they come from.

## Open questions

- One bullet per missing piece of information or model fix.

## Owner decisions

- One bullet per design item the owner still has to decide. Record the selected option, rationale, and the evidence used after the owner decides.

## Furniture

`furniture.csv` holds one row per physical item, phase, and option. Reuse its `item_id` when the same piece moves or appears in another option. Distinguish identical pieces with separate IDs. Use `existing`, `demolition`, or `proposed` in `phase`. For an item present across options, leave `option_id` blank as its default. A matching row for a selected option replaces the entire default row for that item and phase. For an item present only in certain options, list it only in those options. Leave unknown values blank and explain material assumptions in `notes`.

- **Dimensions** — Enter the physical envelope in the item's local X, Y, and Z directions. All lengths use millimetres.
- **Placement** — Describe a reproducible point on the item in `anchor` (for example, the footprint centre at the underside). Enter that point's coordinates in room-local millimetres when the room has its own origin, or in level coordinates when the builder uses the level frame. +X is right, +Y is up-plan, and +Z is up. At zero yaw the item's local +X points along level +X. Positive yaw rotates the item counterclockwise about its anchor, viewed from above.
- **Clearance** — Enter the required free space beyond each named local face, measured from the physical envelope. These clearances rotate with the item. Describe door swings, pull-out travel, or other nonrectangular requirements in `notes` or a linked drawing.
- **Sources** — Use repository-relative paths without a leading slash in `asset_path` and `spec_path`. Reference reusable models under `assets/` and source documents under `sources/`. Use `measurement_refs` for measurements supporting the dimensions or placement.
- **Scope of work** — Set `trade` (see `TRADES` in `turnkey/furniture`) on each proposed row, and `position` as dimensions from a named wall or the floor, for example `on wall D; 22 in from wall A; 35 in AFF` (prefix `~` for an assumed value, suffix `@<measurement-id>` to cite one). `name_zh` holds the Chinese name. Set `scope_flag` to `changed` or `blocks-pricing` to bold the row.

## Finishes

`finishes.csv` holds one row per finish: `surface` (where it goes), `product` with model or SKU, `finish`, `color`, `quantity` and `unit`, and `existing`, `demolition` or `proposed` in `status`. Put the supplier link in `source` and reasons in `notes`. The `trade`, `position`, `surface_zh`, `spec_zh` (Chinese for product, finish and colour) and `scope_flag` columns work as in `furniture.csv`.
