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

## Ship a release

Run the package tests, inspect `npm pack --dry-run`, and package the exact version with `npm pack`. CI verifies tagged versions (for example, `v0.1.0`) and attaches the package archive to the workflow run. Applications that need a single private checkout can commit the resulting archive and its npm lockfile in the project repository. Their collaborators install with `npm ci`, run the project's own preview and validation scripts, and merge through the project's deployment workflow. New viewer capabilities are adopted by updating the project’s pinned archive and lockfile together.
