import { highlightDemolition } from './demolition-materials.mjs';
import { applyPlacement } from '../lib/frame.mjs';
import { FURNITURE_COLUMNS, isPlaceableAsset, parseFurniture, furnitureOptions, roomOptionIds, resolveFurniture, isPlaced, placeFromRow } from '../lib/furniture.mjs';
import project from 'virtual:turnkey-project';

const placementRooms = project.placementRooms ?? new Map();
const DRAWING_STATES = ['existing', 'demolition', 'proposed'];
const EMPTY_SCHEDULE = FURNITURE_COLUMNS.join(',') + '\n';

const levelFiles = import.meta.glob('/house/levels/*/model/build.mjs');
const roomFiles = import.meta.glob('/rooms/*/model/build.mjs');
const roomMetadataFiles = import.meta.glob('/rooms/*/model/metadata.mjs', { eager: true });
const assetFiles = import.meta.glob('/assets/*/model/build.mjs');
const assetMetadata = import.meta.glob('/assets/*/model/metadata.mjs', { eager: true, import: 'catalogEntry' });
const furnitureFiles = import.meta.glob('/rooms/*/furniture.csv', { query: '?raw', import: 'default', eager: true });
const planFiles = import.meta.glob('/house/levels/*/model/plan.mjs');
const baselineFiles = import.meta.glob('/rooms/*/existing-conditions.json', { import:'default', eager:true });
const changeFiles = import.meta.glob('/rooms/*/permit-changes.json', { import:'default', eager:true });
const levelRecords = import.meta.glob('/house/levels/*/permit.json', { import:'default', eager:true });
const acceptedFiles = import.meta.glob('/rooms/*/accepted-target.json', { import:'default', eager:true });
const acceptedRenderFiles = import.meta.glob('/rooms/*/preview/*accepted*.png', { query:'?url', import:'default', eager:true });

const galleryFiles = import.meta.glob(['/house/preview/gallery.mjs', '/house/levels/*/preview/gallery.mjs', '/rooms/*/preview/gallery.mjs', '/assets/*/preview/gallery.mjs'], { eager: true });

const roomCsv = new Map(Object.entries(furnitureFiles).map(([path, text]) => [path.split('/').at(-2), text]));

export function initialRoomCsv(roomId) {
  return roomCsv.get(roomId) ?? EMPTY_SCHEDULE;
}

export function setRoomCsv(roomId, csv) {
  roomCsv.set(roomId, csv);
  furnitureByRoom.set(roomId, parseFurniture(csv));
}

const assetModules = discover(assetFiles);

export async function loadPlacementAssets() {
  const entries = new Map();
  for (const [id, module] of await loadModules(assetModules)) {
    if (typeof module.buildAsset !== 'function' || !isPlaceableAsset(module.catalogEntry)) continue;
    entries.set(id, { id, asset_path: `assets/${id}/model/build.mjs`, entry: module.catalogEntry, buildAsset: module.buildAsset });
  }
  return entries;
}

const GAP_M = 1; // space between unplaced rooms laid out beside the house

function discover(files) {
  return new Map(Object.entries(files).sort(([a], [b]) => a.localeCompare(b)).map(
    ([path, load]) => {
      let pending;
      // Share in-flight imports between option discovery and model construction. A failed import can be retried.
      const cachedLoad = () => pending ??= Promise.resolve().then(load).catch(error => {
        pending = undefined;
        throw error;
      });
      return [path.split('/').at(-3), cachedLoad];
    }
  ));
}

function loadModules(entries) {
  return Promise.all([...entries].map(async ([id, load]) => [id, await load()]));
}

const furnitureByRoom = new Map([...roomCsv].map(([id, csv]) => [id, parseFurniture(csv)]));

async function buildGroup(module, builderName, id, context) {
  if (typeof module[builderName] !== 'function') {
    throw new Error(`${id}/model/build.mjs must export ${builderName}({ THREE }).`);
  }
  const group = await module[builderName](context);
  if (!group?.isGroup) throw new Error(`${id}: ${builderName} must return a THREE.Group.`);
  group.name = id;
  return group;
}

function roomOptionFor(roomId, option, module) {
  const supported = roomOptionIds(furnitureByRoom.get(roomId) ?? [], module);
  return supported.has(option) ? option : (supported.has(module.DEFAULT_OPTION) ? module.DEFAULT_OPTION : '');
}

function roomContext(THREE, roomId, option, module, withLevelShell) {
  const roomOption = roomOptionFor(roomId, option, module);
  return { THREE, option: roomOption, furniture: resolveFurniture(furnitureByRoom.get(roomId) ?? [], roomOption), withLevelShell };
}

/** A room group, plus its provisional shell when the room is shown without its level. */
async function buildRoomGroup(module, roomId, THREE, option, { withShell }) {
  const context = roomContext(THREE, roomId, option, module, !withShell);
  // Exact builder paths are drawn here. Room-authored fixtures retain their own
  // placement rules and option checks.
  const roomFurniture = context.furniture.filter(row => !assetFiles['/' + row.asset_path]);
  const room = await buildGroup(module, 'buildRoom', roomId, { ...context, furniture: roomFurniture });
  room.userData.roomId = roomId;
  room.userData.designOption = context.option;
  room.userData.placementRoomId = roomId;
  for (const row of context.furniture) {
    const load = assetFiles['/' + row.asset_path];
    if (!load || !isPlaced(row) || row.phase === 'demolition') continue;
    if ((context.option === 'existing-measured' || option === 'existing-measured') && row.phase !== 'existing') continue;
    const asset = await (await load()).buildAsset({ THREE });
    room.add(placeFromRow(asset, row));
  }
  if (withShell && typeof module.buildProvisionalShell === 'function') {
    const shell = await module.buildProvisionalShell({ THREE, option: context.option });
    if (shell?.isObject3D) {
      shell.name = `${roomId}-provisional-shell`;
      shell.userData.provisional = true;
      room.add(shell);
    }
  }
  return room;
}

/** Lay groups out in a row along scene +X, starting beyond `startX`. */
function layOutInRow(THREE, groups, startX) {
  let x = startX;
  for (const group of groups) {
    const box = new THREE.Box3().setFromObject(group);
    if (box.isEmpty()) continue;
    group.position.x += x - box.min.x;
    x += box.max.x - box.min.x + GAP_M;
  }
}

export async function loadCatalog() {
  const levels = discover(levelFiles);
  const rooms = discover(roomFiles);
  const metadata = new Map(Object.entries(roomMetadataFiles).map(([path, module]) => [path.split('/').at(-3), module]));
  // Metadata is optional for new rooms: builders without it still work through the original import path.
  const roomDetails = new Map([...rooms].map(([id, load]) => [id, metadata.has(id) ? async () => metadata.get(id) : load]));
  const virtualRooms = new Set();
  const plans = await Promise.all(Object.values(planFiles).map(load => load()));
  for (const { plan } of plans) {
    const zoneIds = new Set((plan.zones ?? []).map(zone => zone.id));
    for (const record of placementRooms.values()) {
      if (rooms.has(record.id) || record.levelId !== plan.id || !zoneIds.has(record.zone.id)) continue;
      const module = project.placementRoomModule({ ...record, existingPlan: plan });
      const loadRoom = async () => module;
      rooms.set(record.id, loadRoom);
      roomDetails.set(record.id, loadRoom);
      virtualRooms.add(record.id);
    }
  }
  const assets = assetModules;
  const scopes = [{ id: 'house', label: 'Whole house' }];
  const readableName = id => (id.charAt(0).toUpperCase() + id.slice(1)).replaceAll('-', ' ');
  for (const id of levels.keys()) scopes.push({ id: `level/${id}`, label: readableName(id), menuGroup: 'Floors' });
  const roomScopes = [...rooms.keys()].map(id => {
    const record = placementRooms.get(id);
    const level = metadata.get(id)?.levelId ?? record?.levelId;
    return { id: `room/${id}`, label: record?.label ?? readableName(id),
      menuGroup: levels.has(level) ? readableName(level) + ' rooms' : 'Other rooms' };
  });
  scopes.push(...roomScopes.sort((a, b) => a.menuGroup.localeCompare(b.menuGroup) || a.label.localeCompare(b.label)));
  for (const id of assets.keys()) {
    const entry = assetMetadata[`/assets/${id}/model/metadata.mjs`];
    scopes.push({ id: `asset/${id}`, label: entry?.name ?? readableName(id), menuGroup: 'Assets' });
  }

  /** Rooms whose model appears in a scope, in catalog order regardless of import completion order. */
  async function roomsInScope(scopeId) {
    const [kind, id] = scopeId.split('/');
    if (kind === 'room') return rooms.has(id) ? loadModules([[id, roomDetails.get(id)]]) : [];
    if (kind === 'asset') return [];
    return (await loadModules(roomDetails)).filter(([, module]) => kind === 'house' || module.levelId === id);
  }

  /** Design options available in a scope, from furniture.csv option_id values and each room's `options` export. */
  async function optionsFor(scopeId) {
    const [kind, id] = scopeId.split('/');
    // The viewer asks for options before building. Start shell downloads now so they overlap room discovery.
    // Preloading must not make option discovery fail; build() awaits the same imports and reports any failure.
    if (kind === 'house' || kind === 'level') {
      void loadModules([...levels].filter(([levelId]) => kind === 'house' || id === levelId)).catch(() => {});
    }
    const accepted = await acceptedTargetFor(scopeId);
    if (accepted?.sole_design) return [{ id: accepted.option_id, label: accepted.display_name }];
    const found = new Map();
    for (const [roomId, module] of await roomsInScope(scopeId)) {
      for (const id of furnitureOptions(furnitureByRoom.get(roomId) ?? [])) if (!found.has(id)) found.set(id, id);
      for (const option of module.options ?? []) {
        const id = typeof option === 'string' ? option : option.id;
        if (id) found.set(id, typeof option === 'string' ? option : option.label ?? id);
      }
    }
    return [...found].map(([id, label]) => ({ id, label }));
  }

  // The recorded owner selection drives both the room and its shared level shell.
  // Explicit options remain available only where the owner has retained multiple designs.
  // A sole_design target takes precedence over stale or empty option links.
  async function acceptedTargetFor(scopeId) {
    for (const [roomId, module] of await roomsInScope(scopeId)) {
      const target = acceptedFiles[`/rooms/${roomId}/accepted-target.json`];
      if (target?.status !== 'accepted' || !roomOptionIds(furnitureByRoom.get(roomId) ?? [], module).has(target.option_id)) continue;
      return { ...target, renderUrl: acceptedRenderFiles[`/${target.render}`] };
    }
    return null;
  }

  async function defaultOptionFor(scopeId) {
    return (await acceptedTargetFor(scopeId))?.option_id ?? '';
  }

  // The library spans design options and frozen revisions independently of the selected model.
  function allPreviews() {
    const byUrl = new Map();
    for (const gallery of Object.values(galleryFiles)) {
      for (const entry of [...gallery.images, ...(gallery.additionalImages ?? [])]) {
        if (!byUrl.has(entry.url)) byUrl.set(entry.url, { ...entry, owner: gallery.owner });
      }
    }
    const order = { render: 0, existing: 1, model: 2, archive: 3 };
    return [...byUrl.values()].sort((a, b) => order[a.kind] - order[b.kind]);
  }

  /** Curated images follow the same room membership and effective design options as the model. */
  async function previewsFor(scopeId, { option, condition = 'design' } = {}) {
    if (!['design', 'existing'].includes(condition)) return [];
    const [kind, id] = scopeId.split('/');
    const target = condition === 'design' ? await acceptedTargetFor(scopeId) : null;
    const selected = target?.sole_design ? target.option_id : option ?? target?.option_id ?? '';
    const images = [];
    function addGallery(directory, ownerOption) {
      const gallery = galleryFiles[`/${directory}/preview/gallery.mjs`];
      if (!gallery) return;
      const existing = condition === 'existing' || ownerOption === 'existing-measured';
      for (const entry of gallery.images) {
        if (existing !== (entry.kind === 'existing')) continue;
        if (entry.option !== undefined && entry.option !== ownerOption) continue;
        images.push({ ...entry, owner: gallery.owner });
      }
    }

    if (kind === 'asset') {
      addGallery(`assets/${id}`, selected);
    } else {
      if (kind === 'house') addGallery('house', selected);
      for (const levelId of levels.keys()) {
        if (kind === 'house' || (kind === 'level' && id === levelId)) addGallery(`house/levels/${levelId}`, selected);
      }
      const members = await roomsInScope(scopeId);
      // Lead with the accepted room in an assembled design.
      if (target) members.sort(([a], [b]) => Number(b === target.room_id) - Number(a === target.room_id));
      for (const [roomId, module] of members) addGallery(`rooms/${roomId}`, roomOptionFor(roomId, selected, module));
    }
    // Preserve each owner's order within each group while bringing photographic renders to the front.
    return images.sort((a, b) => Number(b.kind === 'render') - Number(a.kind === 'render'));
  }

  async function buildConditions(scopeId,THREE,{option,assembly,condition}) {
    const [kind,id]=scopeId.split('/');
    if (kind==='asset') throw new Error('Condition drawings apply to a house, level or room. Choose Design for assets.');
    if (!DRAWING_STATES.includes(condition)) throw new Error(`Unknown condition ${condition}`);
    const root=new THREE.Group();
    const scopedRooms=await roomsInScope(scopeId);
    const roomLevel=kind==='room' ? scopedRooms[0]?.[1].levelId : null;
    if (kind==='room') root.userData.levelId=roomLevel;
    for (const [levelId,load] of levels) {
      if ((kind==='level' && id!==levelId) || (kind==='room' && roomLevel!==levelId)) continue;
      const loadPlan=planFiles[`/house/levels/${levelId}/model/plan.mjs`];
      const record=levelRecords[`/house/levels/${levelId}/permit.json`];
      if (!loadPlan || !record) throw new Error(`${levelId}: condition baseline metadata is missing`);
      const inputs=[];
      const warnings=[`DRAFT ${condition}: incomplete evidence; missing geometry is omitted. Black retained; red removal (demolition); blue proposed; amber unresolved.`];
      warnings.push(...record.blockers.map(b=>`${levelId}: ${b.description}`));
      // Use lightweight metadata to choose the rooms before loading builders for their placement exports.
      const selectedRooms=scopedRooms.filter(([roomId,detail])=>detail.levelId===levelId && !virtualRooms.has(roomId));
      const targets = selectedRooms.map(([roomId]) => acceptedFiles[`/rooms/${roomId}/accepted-target.json`]).filter(Boolean);
      const roomModules=await loadModules(selectedRooms.map(([roomId])=>[roomId,rooms.get(roomId)]));
      for (const [roomId,module] of roomModules) {
        const baseline=baselineFiles[`/rooms/${roomId}/existing-conditions.json`];
        const changes=changeFiles[`/rooms/${roomId}/permit-changes.json`];
        if (!baseline || !changes) { warnings.push(`${roomId}: existing inventory missing; omitted`); continue; }
        const supported=roomOptionIds(furnitureByRoom.get(roomId) ?? [], module);
        const selected=supported.has(option)?option:(module.DEFAULT_OPTION??'');
        const p=module.placement;
        inputs.push({baseline,changes,furniture:furnitureByRoom.get(roomId)??[],option:selected,
          placement:p===undefined?{xMm:0,yMm:0,yawDeg:0}:p===null?null:{xMm:p.xMm,yMm:p.yMm,yawDeg:p.yawDeg}});
        warnings.push(...baseline.blockers.map(b=>`${roomId}: ${b.description}`),...changes.blockers.map(b=>`${roomId}: ${b.description}`));
      }
      const {plan}=await loadPlan();
      const model=project.drawings.buildLevel({plan, levelRecord:record, rooms:inputs, state:condition, targets, warnings});
      if (kind==='room') model.warnings.unshift('Room condition drawing shown with its level shell for context.');
      const group=project.drawings.buildPreview({THREE,model});
      const levelModule=await load();
      if (scopeId==='house') group.position.y=(levelModule.elevationMm??0)/1000;
      // A standalone room design uses its own origin. Keep the level linework in
      // that same frame so a camera parked on a fixture stays there across phases.
      const roomPlacement = kind === 'room' && roomModules[0]?.[1].placement;
      if (roomPlacement) {
        const frame = applyPlacement(new THREE.Object3D(), roomPlacement);
        frame.updateMatrix();
        group.applyMatrix4(frame.matrix.invert());
      }
      root.add(group);
    }
    if (scopeId==='house' && assembly==='compare') {
      let cursor=0;
      for (const group of root.children) {
        const box=new THREE.Box3().setFromObject(group);
        group.position.x+=cursor-box.min.x; group.position.y=0; cursor+=box.max.x-box.min.x+2;
      }
    }
    return root;
  }

  async function build(scopeId, THREE, { option, assembly = 'stacked', condition = 'design', view = 'perspective' } = {}) {
    if (condition !== 'design' && !DRAWING_STATES.includes(condition)) throw new Error(`Unknown condition ${condition}`);
    if (condition === 'proposed' && option === 'existing-measured') option = undefined;
    const before = condition === 'existing' || condition === 'demolition';
    if (!before) {
      const accepted = await acceptedTargetFor(scopeId);
      if (accepted?.sole_design || option == null) option = accepted?.option_id ?? '';
    }
    if (condition !== 'design' && view === 'plan' && project.drawings) return buildConditions(scopeId,THREE,{option,assembly,condition});
    const [kind, id] = scopeId.split('/');
    const warnings = [];
    async function roomForView(module, roomId, withShell) {
      if (!before) return buildRoomGroup(module, roomId, THREE, option, { withShell });
      const builder = condition === 'demolition' && module.buildDemolitionRoom ? 'buildDemolitionRoom' : 'buildExistingRoom';
      if (typeof module[builder] === 'function') {
        const context = roomContext(THREE, roomId, option, module, !withShell);
        return buildGroup(module, builder, roomId, { THREE, withLevelShell: !withShell, option: context.option });
      }
      const group = new THREE.Group();
      group.userData.warnings = [`${roomId}: existing interior geometry has not been recorded.`];
      return group;
    }
    function finishModel(group) {
      group.userData.condition = condition;
      return condition === 'demolition' ? highlightDemolition(THREE, group) : group;
    }
    if (kind === 'room' && rooms.has(id)) {
      const module = await rooms.get(id)();
      const room = await roomForView(module, id, true);
      if (!levels.has(module.levelId)) {
        warnings.push(`${id}: no parent level yet (levelId ${JSON.stringify(module.levelId ?? '')}). Shown in its own frame.`);
      }
      room.userData.warnings = [...warnings, ...(room.userData.warnings ?? [])];
      room.userData.levelId = module.levelId;
      return finishModel(room);
    }
    if (kind === 'asset' && assets.has(id)) {
      if (condition !== 'design') throw new Error('Choose a house, level or room to compare renovation conditions.');
      const module = await assets.get(id)();
      const asset = await buildGroup(module, 'buildAsset', id, { THREE });
      if (!isPlaceableAsset(module.catalogEntry)) {
        asset.userData.warnings = [...(asset.userData.warnings ?? []), 'To place this asset, add catalogEntry with its name, anchor and dimensions in millimetres to its model builder.'];
      }
      return asset;
    }
    if (scopeId !== 'house' && !(kind === 'level' && levels.has(id))) {
      throw new Error(`Unknown preview scope: ${scopeId}`);
    }

    const root = new THREE.Group();
    root.name = scopeId;
    const floorGroups = new Map();
    // Fetch independent modules together, but build sequentially: imported builders can hold shared state.
    const [levelModules, roomModules] = await Promise.all([
      loadModules([...levels].filter(([levelId]) => kind !== 'level' || id === levelId)),
      kind === 'house' ? loadModules(rooms) : roomsInScope(scopeId).then(entries =>
        loadModules(entries.map(([roomId]) => [roomId, rooms.get(roomId)]))),
    ]);
    for (const [levelId, module] of levelModules) {
      const floor = await buildGroup(module, 'buildLevel', levelId, { THREE, option, scope:scopeId, condition });
      if (kind === 'house') {
        // The exterior view should not have detached floor titles floating over the entrance.
        if (assembly !== 'compare') {
          floor.traverse(node => { if (node.userData.levelTitle) node.visible = false; });
        }
        if (Number.isFinite(module.elevationMm)) {
          floor.position.y = module.elevationMm / 1000;
        } else if (levels.size > 1) {
          warnings.push(`${levelId}: elevationMm is not set, so the floor is drawn at house Z=0. Set it in house/levels/${levelId}/model/build.mjs to align the house.`);
        }
      }
      floorGroups.set(levelId, floor);
      floor.userData.levelId = levelId;
      floor.userData.elevationMm = module.elevationMm;
      root.add(floor);
    }

    const unplaced = [];
    for (const [roomId, module] of roomModules) {
      const floor = floorGroups.get(module.levelId);
      if (floor) {
        if (condition !== 'design' && module.placement === null) {
          warnings.push(`${roomId}: placement in ${module.levelId} is unknown; interior omitted.`);
          continue;
        }
        const room = await roomForView(module, roomId, false);
        if (module.placement === undefined || module.placement) {
          applyPlacement(room, module.placement ?? {});
        } else {
          warnings.push(`${roomId}: placement in ${module.levelId} is unknown (placement = null). Shown at the level origin.`);
        }
        floor.add(room);
      } else if (kind === 'house') {
        unplaced.push(await roomForView(module, roomId, true));
        warnings.push(`${roomId}: not in a level yet, so it is shown beside the house. Set levelId and placement in rooms/${roomId}/model/build.mjs.`);
      }
    }
    if (unplaced.length) {
      const group = new THREE.Group();
      group.name = 'unplaced-rooms';
      group.userData.unplaced = true;
      for (const room of unplaced) group.add(room);
      const houseBox = new THREE.Box3().setFromObject(root);
      layOutInRow(THREE, unplaced, houseBox.isEmpty() ? 0 : houseBox.max.x + GAP_M * 2);
      root.add(group);
    }
    if (scopeId === 'house' && floorGroups.size > 1) {
      const traced = [...floorGroups.values()].filter(f => f.userData.planNotice);
      if (traced.length && project.tracedHouseNotice) {
        for (const floor of traced) floor.userData.warnings = (floor.userData.warnings ?? []).filter(w => w !== floor.userData.planNotice);
        warnings.push(project.tracedHouseNotice);
      }
    }
    if (scopeId === 'house' && assembly === 'compare') {
      // Review layout only. The builders' X/Y alignment and elevation inputs stay intact.
      const ordered = [...floorGroups.values()].sort((a, b) => (a.userData.elevationMm ?? 0) - (b.userData.elevationMm ?? 0));
      let cursor = 0;
      for (const floor of ordered) {
        const box = new THREE.Box3().setFromObject(floor);
        if (box.isEmpty()) continue;
        floor.position.x += cursor - box.min.x;
        floor.position.y = 0;
        cursor += box.max.x - box.min.x + 2;
      }
      warnings.push('Compare floors: levels are spread horizontally for review. Choose Stacked to inspect provisional alignment.');
    }
    root.userData.warnings = warnings;
    return finishModel(root);
  }

  return { scopes, build, optionsFor, acceptedTargetFor, defaultOptionFor, previewsFor, allPreviews };
}
