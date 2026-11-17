// Validate a project against the shared format and exercise its model builders.
import { readdir, readFile, stat } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import * as THREE from 'three';
import { installDomStub } from './dom-stub.mjs';
import {
  FURNITURE_COLUMNS, NUMERIC_COLUMNS, PHASES, TRADES, SCOPE_FLAGS, parseCsv, parseCsvRows, parseFurniture, roomOptionIds, resolveFurniture,
} from './furniture.mjs';

const ID = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const MEASUREMENT_COLUMNS = ['measurement_id', 'feature_id', 'quantity', 'from_reference', 'to_reference', 'raw_value',
  'raw_unit', 'value_mm', 'status', 'uncertainty_mm', 'observed_on', 'evidence_path', 'source_locator', 'notes'];
const MEASUREMENT_STATUS = ['measured', 'reported', 'assumed'];
const FINISH_COLUMNS = ['finish_id','surface','product','finish','color','quantity','unit','status','source','notes','trade','position','surface_zh','spec_zh','scope_flag'];
const LARGE_FILE_BYTES = 10 * 1024 * 1024;

export async function validateProject(root, { planOnlyRoomIds = new Set() } = {}) {
  root = path.resolve(root);
  if (!(await stat(root)).isDirectory()) throw new Error(`Project root is not a directory: ${root}`);
  const errors = [];
  const warnings = [];
  const error = (where, message) => errors.push(`${where}: ${message}`);
  const warn = (where, message) => warnings.push(`${where}: ${message}`);

  async function subdirs(dir) {
    if (!existsSync(dir)) return [];
    return (await readdir(dir, { withFileTypes: true })).filter((d) => d.isDirectory()).map((d) => d.name).sort();
  }

  function checkHeader(file, header, expected) {
    if (header.join(',') !== expected.join(',')) {
      error(file, `header must be exactly:\n    ${expected.join(',')}\n  found:\n    ${header.join(',')}`);
      return false;
    }
    return true;
  }

  function checkPath(file, label, value) {
    if (!value || /^https?:\/\//.test(value)) return;
    if (value.startsWith('/')) error(file, `${label} "${value}" must be repository-relative (no leading slash)`);
    else if (!existsSync(path.join(root, value))) error(file, `${label} "${value}" does not exist`);
  }

  // ---- directory IDs -----------------------------------------------------------------------------------------------
  const scopes = {
    sources: await subdirs(path.join(root, 'sources')),
    levels: await subdirs(path.join(root, 'house/levels')),
    rooms: await subdirs(path.join(root, 'rooms')),
    assets: await subdirs(path.join(root, 'assets')),
  };
  for (const [kind, ids] of Object.entries(scopes)) {
    for (const id of ids) if (!ID.test(id)) error(`${kind}/${id}`, 'directory IDs must be lowercase and hyphenated');
  }
  for (const id of scopes.sources) {
    if (!existsSync(path.join(root, 'sources', id, 'intake.md'))) error(`sources/${id}`, 'add an intake.md beside the received files');
  }

  // ---- measurement registers ---------------------------------------------------------------------------------------
  const measurementIds = new Set();
  for (const levelId of scopes.levels) {
    const file = `house/levels/${levelId}/measurements.csv`;
    if (!existsSync(path.join(root, file))) { warn(file, 'missing measurement register'); continue; }
    const { header, records } = parseCsv(await readFile(path.join(root, file), 'utf8'));
    if (!checkHeader(file, header, MEASUREMENT_COLUMNS)) continue;
    for (const [i, r] of records.entries()) {
      const at = `${file} row ${i + 2}`;
      if (!ID.test(r.measurement_id)) error(at, `measurement_id "${r.measurement_id}" must be lowercase and hyphenated`);
      const key = `${levelId}/${r.measurement_id}`;
      if (measurementIds.has(key)) error(at, `duplicate measurement_id ${r.measurement_id}`);
      measurementIds.add(key);
      if (!MEASUREMENT_STATUS.includes(r.status)) error(at, `status must be one of ${MEASUREMENT_STATUS.join(', ')}`);
      if (r.value_mm && !Number.isFinite(Number(r.value_mm))) error(at, 'value_mm must be a number');
      checkPath(at, 'evidence_path', r.evidence_path);
    }
  }

  // ---- furniture schedules -----------------------------------------------------------------------------------------
  const furnitureByRoom = new Map();
  for (const roomId of scopes.rooms) {
    const file = `rooms/${roomId}/furniture.csv`;
    if (!existsSync(path.join(root, file))) { warn(file, 'missing furniture schedule'); continue; }
    const text = await readFile(path.join(root, file), 'utf8');
    const { header, records } = parseCsv(text);
    if (!checkHeader(file, header, FURNITURE_COLUMNS)) continue;
    const seen = new Set();
    for (const [i, r] of records.entries()) {
      const at = `${file} row ${i + 2} (${r.item_id || 'no item_id'})`;
      if (!ID.test(r.item_id)) error(at, 'item_id must be lowercase and hyphenated');
      if (!PHASES.includes(r.phase)) error(at, `phase must be one of ${PHASES.join(', ')}`);
      if (r.option_id && !ID.test(r.option_id)) error(at, 'option_id must be lowercase and hyphenated');
      const key = `${r.item_id}|${r.phase}|${r.option_id}`;
      if (seen.has(key)) error(at, 'duplicate item_id, phase and option_id');
      seen.add(key);
      for (const column of NUMERIC_COLUMNS) {
        if (r[column].trim() !== '' && !Number.isFinite(Number(r[column]))) error(at, `${column} must be a number or blank`);
      }
      for (const column of ['size_x_mm', 'size_y_mm', 'size_z_mm']) {
        if (r[column].trim() !== '' && Number(r[column]) <= 0) error(at, `${column} must be positive`);
      }
      if ((r.x_mm === '') !== (r.y_mm === '')) error(at, 'give both x_mm and y_mm, or neither');
      if (r.x_mm !== '' && !r.anchor) error(at, 'a placed item needs an anchor description');
      checkPath(at, 'asset_path', r.asset_path);
      checkPath(at, 'spec_path', r.spec_path);
      if (r.trade && !TRADES.includes(r.trade)) error(at, `trade must be blank or one of ${TRADES.join(', ')}`);
      for (const flag of r.scope_flag.split(/[;\s]+/).filter(Boolean)) {
        if (!SCOPE_FLAGS.includes(flag)) error(at, `scope_flag "${flag}" must be one of ${SCOPE_FLAGS.join(', ')}`);
      }
      for (const ref of r.measurement_refs.split(/[;\s]+/).filter(Boolean)) {
        if (!/^[a-z0-9-]+\/[a-z0-9-]+$/.test(ref)) error(at, `measurement_ref "${ref}" must be <level-id>/<measurement-id>`);
        else if (!measurementIds.has(ref)) error(at, `measurement_ref "${ref}" is not in a level register`);
      }
    }
    furnitureByRoom.set(roomId, parseFurniture(text));
  }

  // ---- finish schedules ---------------------------------------------------------------------------------------------
  for (const roomId of scopes.rooms) {
    const file = `rooms/${roomId}/finishes.csv`;
    if (!existsSync(path.join(root, file))) {
      const planOnly = planOnlyRoomIds.has(roomId) && !existsSync(path.join(root, 'rooms', roomId, 'model/build.mjs'));
      if (!planOnly) warn(file, 'missing finish schedule');
      continue;
    }
    const text = await readFile(path.join(root, file), 'utf8');
    const { header, records } = parseCsv(text);
    if (!checkHeader(file, header, FINISH_COLUMNS)) continue;
    for (const [i, cells] of parseCsvRows(text).slice(1).entries()) {
      if (cells.length !== header.length) error(`${file} row ${i + 2}`, `expected ${header.length} CSV fields; found ${cells.length}`);
    }
    const seen = new Set();
    for (const [i, row] of records.entries()) {
      const at = `${file} row ${i + 2} (${row.finish_id || 'no finish_id'})`;
      if (!ID.test(row.finish_id)) error(at, 'finish_id must be lowercase and hyphenated');
      if (seen.has(row.finish_id)) error(at, 'duplicate finish_id');
      seen.add(row.finish_id);
      if (row.quantity.trim() && (!Number.isFinite(Number(row.quantity)) || Number(row.quantity) < 0)) error(at, 'quantity must be a nonnegative number or blank');
      checkPath(at, 'source', row.source);
      if (row.trade && !TRADES.includes(row.trade)) error(at, `trade must be blank or one of ${TRADES.join(', ')}`);
      for (const flag of row.scope_flag.split(/[;\s]+/).filter(Boolean)) {
        if (!SCOPE_FLAGS.includes(flag)) error(at, `scope_flag "${flag}" must be one of ${SCOPE_FLAGS.join(', ')}`);
      }
    }
  }

  // ---- model builders and smoke build ------------------------------------------------------------------------------
  installDomStub();

  async function loadBuilder(file, builderName) {
    const url = pathToFileURL(path.join(root, file)).href;
    let module;
    try { module = await import(url); } catch (e) { error(file, `cannot be imported: ${e.message}`); return null; }
    if (typeof module[builderName] !== 'function') { error(file, `must export ${builderName}({ THREE })`); return null; }
    return module;
  }

  async function smoke(file, builder, context) {
    try {
      const group = await builder(context);
      if (!group?.isGroup) error(file, `${builder.name} must return a THREE.Group`);
      else if (!group.position.equals(new THREE.Vector3()) || !group.quaternion.equals(new THREE.Quaternion()) ||
               !group.scale.equals(new THREE.Vector3(1, 1, 1))) {
        error(file, `${builder.name} must return a group with an identity transform (wrap scaled content in a child group)`);
      } else {
        if (context.furniture !== undefined) {
          const csv = file.replace('model/build.mjs', 'furniture.csv');
          for (const message of group.userData.scheduleMismatches ?? []) {
            error(`${csv} [${context.option || 'default'}]`, message);
          }
        }
        const lights = [];
        group.traverse((o) => { if (o.isLight) lights.push(o); });
        for (const light of lights) {
          if (light.isAmbientLight || light.isHemisphereLight || light.isDirectionalLight) {
            error(file, `${light.type} found: ambient, hemisphere and sun lights belong to the viewer; builders add fixture lights only`);
          }
        }
        if (new THREE.Box3().setFromObject(group).isEmpty()) warn(file, 'builds no geometry yet');
      }
    } catch (e) {
      error(file, `${builder.name} threw: ${e.stack?.split('\n').slice(0, 3).join(' | ') ?? e}`);
    }
  }

  for (const levelId of scopes.levels) {
    const file = `house/levels/${levelId}/model/build.mjs`;
    if (!existsSync(path.join(root, file))) continue;
    const module = await loadBuilder(file, 'buildLevel');
    if (!module) continue;
    await smoke(file, module.buildLevel, { THREE, option: '' });
    if (module.elevationMm !== null && module.elevationMm !== undefined && !Number.isFinite(module.elevationMm)) {
      error(file, 'elevationMm must be a number or null');
    }
  }

  function checkPlacement(file, placement) {
    if (placement === undefined || placement === null) return;
    if (typeof placement !== 'object') { error(file, 'placement must be an object, null or left out'); return; }
    for (const [key, value] of Object.entries(placement)) {
      if (!['xMm', 'yMm', 'zMm', 'yawDeg'].includes(key)) error(file, `placement has unknown key "${key}"`);
      else if (!Number.isFinite(value)) error(file, `placement.${key} must be a number`);
    }
  }

  for (const roomId of scopes.rooms) {
    const file = `rooms/${roomId}/model/build.mjs`;
    if (!existsSync(path.join(root, file))) continue;
    const rows = furnitureByRoom.get(roomId) ?? [];
    const module = await loadBuilder(file, 'buildRoom');
    if (!module) continue;
    const options = roomOptionIds(rows, module);
    // The viewer resolves its default selection to DEFAULT_OPTION when that ID is selectable.
    if (!options.has(module.DEFAULT_OPTION)) options.add('');
    for (const option of options) {
      await smoke(file, module.buildRoom, { THREE, option, furniture: resolveFurniture(rows, option) });
    }
    if (typeof module.levelId !== 'string') error(file, "export levelId as a string ('' until the parent level exists)");
    else if (module.levelId && !scopes.levels.includes(module.levelId)) error(file, `levelId "${module.levelId}" has no house/levels/${module.levelId}/`);
    else if (!module.levelId) warn(file, 'levelId is empty: the room previews on its own and appears beside the house');
    checkPlacement(file, module.placement);
    if (module.levelId && module.placement === null) warn(file, 'placement in the level is unknown (null)');
    if (module.buildProvisionalShell !== undefined && typeof module.buildProvisionalShell !== 'function') {
      error(file, 'buildProvisionalShell must be a function');
    }
  }

  for (const assetId of scopes.assets) {
    const file = `assets/${assetId}/model/build.mjs`;
    if (!existsSync(path.join(root, file))) continue;
    const module = await loadBuilder(file, 'buildAsset');
    if (module) await smoke(file, module.buildAsset, { THREE });
  }

  // ---- large binaries and LFS --------------------------------------------------------------------------------------
  try {
    const tracked = execFileSync('git', ['ls-files', '-z'], { cwd: root, encoding: 'utf8' }).split('\0').filter(Boolean);
    for (const file of tracked) {
      const full = path.join(root, file);
      if (!existsSync(full)) continue;
      const { size } = await stat(full);
      if (size < LARGE_FILE_BYTES) continue;
      const attr = execFileSync('git', ['check-attr', 'filter', '--', file], { cwd: root, encoding: 'utf8' });
      if (!/filter: lfs/.test(attr)) warn(file, `${(size / 1048576).toFixed(1)} MB and not in Git LFS; see .gitattributes`);
    }
  } catch {
    warn('git', 'could not list tracked files; skipped the large-file check');
  }

  return { errors, warnings, scopes };
}
