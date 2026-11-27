# Turnkey

Turnkey opens a local renovation project, assembles its Three.js builders and furniture schedules, and builds a static site for review. A project owns its source material, design choices, room and level geometry, custom checks, and publishing configuration. The public helper modules keep project builders independent of the viewer implementation.

## Work on the viewer

Use Node.js 22.12 or later. From this checkout:

```sh
npm ci
npm test
npm run dev -- --project ../my-house
```

The project argument identifies the directory containing the house files. Edit the application here and the project geometry in the project checkout, then inspect the printed local URL. Build the static site with `npm run build -- --project ../my-house`. Output goes into the project's `dist/`. Run `node bin/turnkey.mjs validate --project ../my-house` for generic format checks.

## Project interface

The [starter directories](templates/) show the asset, room, and level layouts. A project builder returns a Three.js group. Asset modules export `buildAsset({ THREE })`; levels export `buildLevel({ THREE })` and their elevation; rooms export `buildRoom({ THREE, option, furniture })` and their level ID. Use `turnkey/frame` for plan coordinates and `turnkey/furniture` for schedules and placement. Project-specific rules may use additional files beside the builder.

The viewer discovers model entries and schedules under the selected root. A project can supply its own viewer integration in `project/viewer.mjs` and Vite plugins from `turnkey.project.mjs`. The build includes the selected project revision in `build-info.json`.

### Shared furniture layouts

**Place furniture** edits a draft across rooms. Choose **Collaborate** and start a shared design to work on the same draft. An invitation carries the session UUID, project, branch and saved `HEAD`. Joining synchronizes the current revision and completed edits. **Save shared layout** commits the whole draft. **Save as branch** starts a new branch at that design. Open an exact version with `?designVersion=<commit-id>` or the latest version of a branch with `?designBranch=<branch-name>`.

Projects opt in with `sharedDesigns: true` in the viewer configuration and a `designStore({ root, revision, catalog })` factory in `turnkey.project.mjs`. Return a stable `projectId`, a `seedSnapshot()` for the first use, and a `validateSnapshot(snapshot, parent)` function for the project's rooms, footprints and catalog. Instances have stable IDs, room IDs, asset revision IDs, room-local millimetres and yaw in degrees. On Node 22.12, enable SQLite with `NODE_OPTIONS=--experimental-sqlite`, or use Node 22.13 or later. The local service stores commits and catalog records in the project's `.turnkey/` directory. Include this directory in local data backups and exclude it from Git. Hosted projects can use the `turnkey/design-store`, `turnkey/design-api` and `turnkey/catalog-service` adapters with durable SQLite and their editor authorization.

Each design pins a geometry revision and immutable furniture revisions. To reopen layouts against a previous house model, supply `loadDesignGeometry(revision)` in the viewer configuration and retain that revision's geometry module, bundled assets and placement rules. Imported furniture is available as soon as its catalog entry is approved. A dimensional proxy is sufficient for placement. A self-contained GLB can supply the detailed model.

For **Extract with AI**, configure `OPENAI_API_KEY` on the server. `TURNKEY_IMPORT_MODEL` and `TURNKEY_IMPORT_BASE_URL` select the model and Responses API endpoint. Paste manufacturer specifications or enter a product URL, review the evidence and units for each dimension, then approve the asset. Room position and orientation are assigned in the editor.

### Design history

The viewer opens a revision in its Design model. **Before renovation** in history opens the original condition of the selected space. **Display → Show planned removals** highlights the recorded removals in the model. **Back to design** restores the selected room option. For projects with drawing builders, **Construction drawings** opens Existing, Demolition or Proposed plans. The lower-left viewport controls hold the floor layout alongside the view and camera controls. Whole-house drawings start side by side.

Link to a model comparison with `?compare=before` or `?compare=removals`. Use `?drawings=existing`, `?drawings=demolition` or `?drawings=proposed` for a sheet. Existing `condition` links still open their corresponding model or drawing. For a historical model, an entry can provide an exact-revision `links.design` URL in addition to the original gallery, image and review links.

Set `designHistoryUrl` on the default export of `project/viewer.mjs` to show **Design history** in the toolbar. The panel opens from `?history=on` and fetches its JSON feed on first use. A room opens on its own history. The area menu shows other rooms and **All house changes**. A link with `historyScope=room/kitchen` or `historyScope=all` sets the filter independently of the viewer scope. Projects without a feed have no history control.

Supply an `entries` array. Each entry needs a `title`, Git `revision` and `status` (`merged` for changes on main, `open` or `current` for branch proposals). Use an ISO `date` for chronological ordering. List each affected area in `changes` with its viewer `scope`, readable `label` and `summary` of what changed there. A change affecting two rooms appears under either filter. Older records may supply a single `scope` and use their `title` as the description.

Revision details accept `integration` (`direct`, `squash`, or `merge`) and `parentRevision` (previous main revision). When the branch is known, include its `branch`, `baseRevision`, tip `revision` and, if merged, `mergedRevision`. A matching starting revision links to the recorded design. An optional same-origin `thumbnail` illustrates the change. An entry’s `links` can include `preview` for an interactive model, `image` for a saved image, and `review` for its pull request or commit. Use verified URLs for that entry.

## Ship a release

Run the package tests, inspect `npm pack --dry-run`, and package the exact version with `npm pack`. CI verifies tagged versions (for example, `v0.1.0`) and attaches the package archive to the workflow run. Applications that need a single private checkout can commit the resulting archive and its npm lockfile in the project repository. Their collaborators install with `npm ci`, run the project's own preview and validation scripts, and merge through the project's deployment workflow. New viewer capabilities are adopted by updating the project’s pinned archive and lockfile together.
