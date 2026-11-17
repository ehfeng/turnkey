import * as THREE from 'three';
import { placeFromRow } from '../lib/furniture.mjs';
import project from 'virtual:turnkey-project';
import { initialRoomCsv, setRoomCsv, loadPlacementAssets } from './designs.mjs';

const el = id => document.getElementById(id);
const indexEndpoint = './api/furniture';
const endpoint = id => indexEndpoint + '/' + encodeURIComponent(id);
const requestOptions = () => ({ cache: 'no-store', signal: AbortSignal.timeout(10000) });
const newerId = () => 'placed-' + crypto.getRandomValues(new Uint32Array(2)).join('-');

function footprint(entry) {
  const x = entry.size_x_mm / 2000, z = entry.size_y_mm / 2000;
  const cx = (entry.offset_x_mm ?? 0) / 1000, cz = -(entry.offset_y_mm ?? 0) / 1000;
  const points = [[-x,-z], [x,-z], [x,z], [-x,z], [-x,-z], [0,-z], [0,-z*1.5],
    [-x*.3,-z*1.15], [0,-z*1.5], [x*.3,-z*1.15]];
  return new THREE.BufferGeometry().setFromPoints(points.map(([a,b]) => new THREE.Vector3(cx+a, .008, cz+b)));
}

export function furnitureEditor({ openRoom, getCamera, scene, dispose, onModelChanged, onOpenChange, invalidate }) {
  const { placementRooms = new Map(), containsAsset, readPlacementRows, serializePlacements } = project;
  // Each room owns an independent draft, undo stack and optimistic-save baseline.
  const sessions = new Map();
  const bundledCsv = new Map([...placementRooms.keys()].map(id => [id, initialRoomCsv(id)]));
  let storage = import.meta.env.DEV ? 'local' : 'unknown';
  let writable = storage === 'local';
  let indexRequest;
  let writeCount = 0;
  let assets, assetsByPath, entries, assetsRequest;
  const panel = el('furniture-editor'), rooms = el('placement-room'), palette = el('placement-asset');
  const instances = el('placement-instance'), height = el('placement-height'), status = el('placement-status');
  const ray = new THREE.Raycaster(), plane = new THREE.Plane(), pointer = new THREE.Vector2();
  let scope = '', roomId, room, canvas, marker, markerAsset, overlay, action, start;
  let opened = false, entering = 0, busy = false;
  const draft = () => sessions.get(roomId);
  const selectedRow = () => draft()?.rows.find(row => row.item_id === draft().selected);
  const dirty = session => session.csv !== session.baseCsv;

  async function loadAssets() {
    assetsRequest ??= loadPlacementAssets().catch(error => { assetsRequest = undefined; throw error; });
    assets = await assetsRequest;
    assetsByPath = new Map([...assets.values()].map(asset => [asset.asset_path, asset]));
    entries = new Map([...assetsByPath].map(([path, asset]) => [path, asset.entry]));
    palette.replaceChildren(...[...assets.values()].map(asset => new Option(asset.entry.name, asset.id)));
    if (!assets.size) throw new Error('There are no placeable assets in this checkout.');
  }

  function resetSession(id, csv) {
    sessions.set(id, { id, baseCsv: csv, csv, rows: readPlacementRows(csv, entries), history: [], selected: null, conflict: false });
  }

  async function readIndex() {
    const before = writeCount;
    try {
      const result = await fetch(indexEndpoint, requestOptions());
      // Static servers either return a missing route or serve their HTML app entry.
      if (storage === 'unknown' && (result.status === 404 || (result.ok && result.headers.get('Content-Type')?.includes('text/html')))) {
        storage = 'static';
        return {};
      }
      if (!result.ok) throw new Error();
      const body = await result.json();
      if (body.storage !== 'cloud' || !body.layouts || Array.isArray(body.layouts) || typeof body.layouts !== 'object') throw new Error();
      storage = 'cloud';
      writable = body.writable === true;
      // A completed POST supersedes an index snapshot fetched before that write.
      if (before !== writeCount) return {};
      let changed = false;
      for (const [id, bundled] of bundledCsv) {
        const session = sessions.get(id);
        if (session && dirty(session)) continue;
        const csv = body.layouts[id] ?? bundled;
        if (typeof csv !== 'string' || csv === initialRoomCsv(id)) continue;
        if (session) resetSession(id, csv);
        setRoomCsv(id, csv);
        changed = true;
      }
      return { changed };
    } catch {
      return { warning: 'Cloud layouts could not be refreshed. Showing the last available schedules.' };
    }
  }

  function refreshLayouts() {
    if (!placementRooms.size || storage === 'static' || storage === 'local') return {};
    indexRequest ??= readIndex().finally(() => { indexRequest = undefined; });
    return indexRequest;
  }

  async function prepare(id, discard = false) {
    const session = sessions.get(id);
    if (session && dirty(session) && !discard) return false;
    const beforeRead = session?.csv;
    const beforeWrite = writeCount;
    const initial = initialRoomCsv(id);
    let csv = initial;
    if (storage === 'cloud' || storage === 'local') {
      try {
        const result = await fetch(endpoint(id), requestOptions());
        if (!result.ok) throw new Error('The saved schedule could not be read.');
        const body = await result.json();
        if (typeof body.csv !== 'string') throw new Error('The saved schedule could not be read.');
        csv = body.csv;
        if (storage === 'cloud') writable = body.writable === true;
      } catch (error) {
        if (discard) throw error; // Keep the user's draft until a saved copy is available.
      }
    }
    // Guard edits made while a room read or a conflict reload was in flight.
    if (beforeWrite !== writeCount || sessions.get(id)?.csv !== beforeRead) return false;
    if (!session || discard || csv !== session.baseCsv) resetSession(id, csv);
    setRoomCsv(id, csv);
    return csv !== initial;
  }

  function clearMarker() {
    if (overlay) {
      scene.remove(overlay);
      dispose(overlay);
    }
    overlay = marker = markerAsset = null;
  }

  function showMarker(asset, pose, valid = true) {
    if (!room || !opened || !asset || !pose) {
      if (marker) marker.visible = false;
    } else {
      if (!overlay) {
        overlay = new THREE.Group();
        room.updateWorldMatrix(true, false);
        overlay.matrix.copy(room.matrixWorld);
        overlay.matrixAutoUpdate = false;
        scene.add(overlay);
      }
      if (asset !== markerAsset) {
        if (marker) { overlay.remove(marker); dispose(marker); }
        marker = new THREE.Line(footprint(asset.entry), new THREE.LineBasicMaterial({ depthTest: false }));
        marker.renderOrder = 5;
        overlay.add(marker);
        markerAsset = asset;
      }
      marker.visible = true;
      placeFromRow(marker, pose);
      marker.material.color.setHex(valid ? 0x036749 : 0xbb301f);
    }
    invalidate();
  }

  function roomChoices() {
    const level = scope.startsWith('level/') ? scope.slice(6) : null;
    return [...placementRooms.values()].filter(item => !level || item.levelId === level);
  }

  function updateUi(message) {
    const session = draft(), selected = selectedRow();
    const choices = roomChoices();
    const available = scope === 'house' || scope.startsWith('level/') || placementRooms.has(roomId);
    el('place-furniture').hidden = !available || !choices.length;
    const show = opened && available;
    if (panel.hidden === show) {
      panel.hidden = !show;
      onOpenChange?.(show);
    }
    rooms.replaceChildren(new Option('Choose a room', ''), ...choices.map(item => {
      const changed = sessions.get(item.id);
      const label = item.label + (changed && dirty(changed) ? ' • unsaved' : '');
      return new Option(label, item.id);
    }));
    rooms.value = roomId ?? '';
    rooms.disabled = busy;
    const ready = Boolean(room && session && assets);
    el('placement-tools').hidden = !ready;
    el('cancel-placement').hidden = !action || !ready || busy;
    el('save-layout').hidden = !ready;
    el('save-layout').textContent = writable ? 'Save room layout' : 'Export room CSV';
    el('layout-key-label').hidden = !ready || storage !== 'cloud' || !writable;
    el('export-layout').hidden = !ready || !writable || !dirty(session);
    el('reload-layout').hidden = !ready || !session.conflict;
    el('reload-layout').disabled = busy;
    el('save-layout').disabled = !ready || !dirty(session) || busy;
    if (ready) {
      instances.replaceChildren(new Option('Choose an item', ''), ...session.rows.map((row, i) =>
        new Option((i + 1) + ' · ' + assetsByPath.get(row.asset_path).entry.name, row.item_id)));
      instances.value = session.selected ?? '';
      instances.disabled = busy || !session.rows.length;
      for (const id of ['move-item','rotate-item','duplicate-item','remove-item']) el(id).disabled = !selected || busy;
      el('undo-item').disabled = !session.history.length || busy;
      palette.disabled = height.disabled = el('add-item').disabled = busy;
    }
    el('scene').classList.toggle('placing', Boolean(action) && !panel.hidden);
    if (message !== undefined) status.textContent = message;
    invalidate();
  }

  function choose(id) {
    const session = draft();
    session.selected = id;
    action = null;
    const row = selectedRow(), asset = row && assetsByPath.get(row.asset_path);
    if (asset) {
      palette.value = asset.id;
      height.value = row.z_mm;
    } else {
      height.value = assets.get(palette.value)?.entry.default_z_mm ?? 0;
    }
    showMarker(asset, row);
    const notes = row ? 'Facing ' + row.yaw_deg + '°.' : 'Choose an asset, then Place.';
    const destination = storage === 'cloud' && !writable ? ' This cloud viewer is read-only.' : '';
    updateUi(notes + (dirty(session) ? ' Unsaved room changes.' : ' Placements apply across design options.') + destination);
  }

  async function enterRoom(id, discard = false) {
    if (!placementRooms.has(id)) return;
    const ticket = ++entering, initialScope = scope;
    updateUi('Opening room…');
    try {
      if (!assets) await loadAssets();
      if (ticket !== entering || initialScope !== scope || !opened) return;
      const changed = await prepare(id, discard);
      if (ticket !== entering || initialScope !== scope || !opened) return;
      await openRoom(id, changed);
      if (ticket !== entering || roomId !== id || !room) return;
      opened = true;
      choose(draft().selected);
    } catch (error) {
      if (ticket === entering) updateUi('Could not open room placement. ' + error.message);
    }
  }

  function currentHeight() {
    return height.value.trim() && Number.isFinite(height.valueAsNumber) && height.valueAsNumber >= 0 ? height.valueAsNumber : null;
  }

  function assetForAction() {
    return action === 'add' ? assets.get(palette.value) : assetsByPath.get(selectedRow()?.asset_path);
  }

  function begin(kind) {
    if (currentHeight() === null) { updateUi('Enter the anchor height in millimetres.'); return; }
    action = kind;
    showMarker();
    const verb = kind === 'move' ? 'move the item' : kind === 'duplicate' ? 'place the copy' : 'place the asset';
    updateUi('Choose a spot on the room plan to ' + verb + '.');
  }

  function aim(event) {
    const rect = canvas.getBoundingClientRect();
    pointer.set((event.clientX - rect.left) / rect.width * 2 - 1, 1 - (event.clientY - rect.top) / rect.height * 2);
    room.updateWorldMatrix(true, false);
    ray.setFromCamera(pointer, getCamera());
    const z = currentHeight();
    if (z === null) return null;
    const anchor = room.localToWorld(new THREE.Vector3(0, z / 1000, 0));
    plane.setFromNormalAndCoplanarPoint(new THREE.Vector3(0, 1, 0), anchor);
    const point = ray.ray.intersectPlane(plane, new THREE.Vector3());
    if (!point) return null;
    room.worldToLocal(point);
    return { x_mm: Math.round(point.x * 1000), y_mm: Math.round(-point.z * 1000),
      z_mm: z, yaw_deg: action === 'add' ? 0 : selectedRow()?.yaw_deg ?? 0 };
  }

  const fits = (asset, pose) => containsAsset(roomId, asset.entry, pose.x_mm, pose.y_mm, pose.yaw_deg);
  function hover(event) {
    if (!action || panel.hidden || !room) return;
    const pose = aim(event), asset = assetForAction();
    showMarker(asset, pose, pose && fits(asset, pose));
  }

  // Build additions before updating the CSV and the active group. An async builder
  // may complete after navigation, in which case its result is discarded.
  async function edit(next, selection, undo = null) {
    if (busy) return;
    const session = draft(), target = room;
    const additions = [];
    busy = true;
    updateUi();
    try {
      const csv = serializePlacements(session.id, session.baseCsv, next, entries);
      const previousIds = new Set(session.rows.map(row => row.item_id));
      const existing = new Map(target.children.filter(child => previousIds.has(child.userData.itemId))
        .map(child => [child.userData.itemId, child]));
      for (const row of next) {
        if (!existing.has(row.item_id)) {
          const asset = assetsByPath.get(row.asset_path);
          additions.push([row.item_id, await asset.buildAsset({ THREE })]);
        }
      }
      if (target !== room || session !== draft()) {
        for (const [,group] of additions) dispose(group);
        return;
      }
      if (undo) session.history.pop();
      else session.history.push({ rows: session.rows, csv: session.csv, selected: session.selected });
      for (const [id, group] of additions) { target.add(group); existing.set(id, group); }
      for (const pose of next) {
        placeFromRow(existing.get(pose.item_id), pose);
        existing.delete(pose.item_id);
      }
      for (const group of existing.values()) { target.remove(group); dispose(group); }
      session.rows = next;
      // Undoing to the previous set of rows also restores the original CSV formatting.
      session.csv = undo?.csv ?? csv;
      setRoomCsv(session.id, session.csv);
      onModelChanged();
      choose(selection);
    } catch (error) {
      for (const [, group] of additions) if (!group.parent) dispose(group);
      updateUi(error.message);
    } finally {
      busy = false;
      updateUi();
    }
  }

  function pick(event) {
    if (panel.hidden || busy || !room || !draft() || !start || start.id !== event.pointerId) return;
    const { x, y } = start;
    start = null;
    if (Math.hypot(x - event.clientX, y - event.clientY) > 5) return;
    const pose = aim(event);
    if (!action) {
      const ids = new Set(draft().rows.map(row => row.item_id));
      const targets = room.children.filter(child => ids.has(child.userData.itemId));
      let picked = ray.intersectObjects(targets)[0]?.object;
      while (picked && picked.parent !== room) picked = picked.parent;
      if (picked) choose(picked.userData.itemId);
      return;
    }
    const asset = assetForAction();
    if (!pose || !fits(asset, pose)) {
      updateUi('Keep the full footprint inside the room and enter a valid anchor height.');
      return;
    }
    const session = draft();
    if (action === 'move') {
      void edit(session.rows.map(row => row.item_id === session.selected ? { ...row, ...pose } : row), session.selected);
    } else {
      const id = newerId();
      void edit([...session.rows, { item_id: id, asset_path: asset.asset_path, ...pose }], id);
    }
  }

  el('place-furniture').onclick = () => {
    opened = true;
    if (roomId) void enterRoom(roomId);
    else updateUi('Choose the room where you want to place an asset.');
  };
  rooms.onchange = () => { if (rooms.value) void enterRoom(rooms.value); };
  el('finish-edit').onclick = () => { ++entering; opened = false; action = null; showMarker(); updateUi(); };
  el('add-item').onclick = () => begin('add');
  el('move-item').onclick = () => begin('move');
  el('duplicate-item').onclick = () => begin('duplicate');
  palette.onchange = () => choose(null);
  instances.onchange = () => choose(instances.value || null);
  height.onchange = () => {
    const row = selectedRow(), z = currentHeight();
    if (z === null) { updateUi('Enter the anchor height in millimetres.'); return; }
    if (row && action !== 'add' && z !== row.z_mm) {
      void edit(draft().rows.map(item => item === row ? { ...item, z_mm: z } : item), row.item_id);
    }
  };
  el('rotate-item').onclick = () => {
    const row = selectedRow(), yaw_deg = (row.yaw_deg + 15) % 360;
    const pose = { ...row, yaw_deg };
    if (!fits(assetsByPath.get(row.asset_path), pose)) {
      updateUi('Move this item away from the room edge before rotating.'); return;
    }
    void edit(draft().rows.map(item => item === row ? pose : item), row.item_id);
  };
  el('remove-item').onclick = () => {
    const next = draft().rows.filter(row => row.item_id !== draft().selected);
    void edit(next, next.at(-1)?.item_id);
  };
  el('undo-item').onclick = () => {
    const previous = draft().history.at(-1);
    void edit(previous.rows, previous.selected, previous);
  };
  function cancelPlacement() {
    if (!action || !draft() || busy) return;
    const trigger = el(action + '-item');
    start = null;
    choose(draft().selected);
    trigger.focus({ preventScroll: true });
  }
  el('cancel-placement').onclick = cancelPlacement;
  window.addEventListener('keydown', event => {
    if (event.key === 'Escape') cancelPlacement();
  });
  window.addEventListener('beforeunload', event => {
    if ([...sessions.values()].some(dirty)) { event.preventDefault(); event.returnValue = ''; }
  });

  function exportDraft() {
    const session = draft();
    const url = URL.createObjectURL(new Blob([session.csv], { type: 'text/csv;charset=utf-8' }));
    Object.assign(document.createElement('a'), { href: url, download: session.id + '-furniture.csv' }).click();
    setTimeout(() => URL.revokeObjectURL(url), 5000);
    updateUi('Exported the schedule for rooms/' + session.id + '/furniture.csv.');
  }
  el('export-layout').onclick = exportDraft;
  el('reload-layout').onclick = () => { void enterRoom(roomId, true); };
  el('save-layout').onclick = async () => {
    const session = draft();
    if (!writable) { exportDraft(); return; }
    const headers = { 'Content-Type': 'application/json' };
    if (storage === 'cloud') {
      const key = el('layout-key').value.trim();
      if (!key) {
        updateUi('Enter the owner editing key to save this room.');
        el('layout-key').focus();
        return;
      }
      headers.Authorization = 'Bearer ' + key;
    }
    busy = true;
    action = null;
    updateUi('Saving room layout…');
    try {
      const response = await fetch(endpoint(session.id), { method: 'POST', headers, redirect: 'error',
        body: JSON.stringify({ baseCsv: session.baseCsv, placements: session.rows }) });
      const body = await response.json();
      if (!response.ok) {
        session.conflict = response.status === 409;
        if (session.conflict) throw new Error('The saved layout changed. Export your draft or discard it to load the latest layout.');
        throw new Error(body.error || 'Could not save this layout.');
      }
      if (typeof body.csv !== 'string') throw new Error('The server did not confirm the saved schedule.');
      ++writeCount;
      session.baseCsv = session.csv = body.csv;
      session.conflict = false;
      setRoomCsv(session.id, body.csv);
      if (draft() === session) updateUi(storage === 'cloud'
        ? 'Saved to the shared house layout.' : 'Saved to rooms/' + session.id + '/furniture.csv.');
    } catch (error) {
      if (draft() === session) updateUi('Save failed. ' + error.message);
    } finally {
      busy = false;
      updateUi();
    }
  };

  return {
    refreshLayouts,
    detach() {
      scope = '';
      room = roomId = action = null;
      opened = false;
      clearMarker();
      updateUi();
    },
    attach(id, model, element) {
      scope = id;
      roomId = id.startsWith('room/') ? id.slice(5) : null;
      room = roomId && model.userData.placementRoomId === roomId ? model : null;
      if (element && element !== canvas) {
        canvas = element;
        canvas.addEventListener('pointermove', hover);
        canvas.addEventListener('pointerdown', event => {
          if (event.button === 0) start = { x: event.clientX, y: event.clientY, id: event.pointerId };
        });
        canvas.addEventListener('pointerup', pick);
        canvas.addEventListener('pointerleave', () => { if (action) showMarker(); });
      }
      updateUi();
    }
  };
}
