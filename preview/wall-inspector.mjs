import * as THREE from 'three';
import { planToScene } from '../lib/frame.mjs';

function wallAxes(wall) {
  const dx = wall.endMm[0] - wall.startMm[0];
  const dy = wall.endMm[1] - wall.startMm[1];
  const length = Math.hypot(dx, dy);
  return { length, ux: dx / length, uy: dy / length };
}

const tenthMm = value => Math.round(value * 10) / 10;

function invalidPoint(wall, alongMm, heightMm) {
  const { length } = wallAxes(wall);
  if (!Number.isFinite(alongMm) || !Number.isFinite(heightMm) || !length || alongMm < 0 || heightMm < 0
    || alongMm > length + 1e-7 || heightMm > wall.heightMm + 1e-7) return 'outside';
  if (wall.openings.some(o => alongMm >= o.fromMm && alongMm <= o.toMm && heightMm >= o.bottomMm && heightMm <= o.topMm)) return 'opening';
  return null;
}

/** Room-local design mm. Both keyboard entry and a camera ray use this same finite wall face. */
export function wallPointAt(wall, alongMm, heightMm) {
  if (invalidPoint(wall, alongMm, heightMm)) return null;
  alongMm = tenthMm(alongMm);
  heightMm = tenthMm(heightMm);
  if (invalidPoint(wall, alongMm, heightMm)) return null;
  const { ux, uy } = wallAxes(wall);
  return { wallId: wall.id, alongMm, heightMm,
    xMm: tenthMm(wall.startMm[0] + alongMm * ux), yMm: tenthMm(wall.startMm[1] + alongMm * uy) };
}

function scenePoint(wall, alongMm, heightMm) {
  const { ux, uy } = wallAxes(wall);
  return new THREE.Vector3(...planToScene(wall.startMm[0] + alongMm * ux, wall.startMm[1] + alongMm * uy, heightMm));
}

const svgNS = 'http://www.w3.org/2000/svg';

export function createWallInspector({ canvas, viewport, getCamera, isInteractive = () => true, onRoom, onWall, onPoint, onMiss }) {
  const overlay = document.createElement('div');
  overlay.className = 'wall-overlay';
  const outlineLayer = document.createElementNS(svgNS, 'svg');
  outlineLayer.classList.add('wall-outline-layer');
  outlineLayer.setAttribute('aria-hidden', 'true');
  const outline = document.createElementNS(svgNS, 'path');
  outline.classList.add('wall-face-outline');
  outline.setAttribute('fill-rule', 'evenodd');
  const leaders = document.createElementNS(svgNS, 'path');
  leaders.classList.add('wall-badge-leaders');
  outlineLayer.append(outline, leaders);
  const marker = document.createElement('span');
  marker.className = 'wall-point-marker';
  marker.setAttribute('aria-hidden', 'true');
  marker.hidden = true;
  overlay.append(outlineLayer, marker);
  const roomHint = document.createElement('span');
  roomHint.className = 'room-name-hint';
  roomHint.setAttribute('aria-hidden', 'true');
  roomHint.hidden = true;
  viewport.append(overlay, roomHint);

  const raycaster = new THREE.Raycaster();
  const pointer = new THREE.Vector2();
  const projected = new THREE.Vector3();
  const localRay = new THREE.Ray(), inverse = new THREE.Matrix4();
  const previousCamera = new THREE.Matrix4(), previousProjection = new THREE.Matrix4(), previousModel = new THREE.Matrix4();
  let previousWidth, previousHeight, previousActive;
  let model, room, wall, point, pointerDown, hoverHit;
  let labels = [], badges = [], contours = [];

  function screenPoint(vector, width, height) {
    projected.copy(vector).applyMatrix4(model.matrixWorld).project(getCamera());
    if (projected.z < -1 || projected.z > 1) return null;
    return { x: (projected.x + 1) * width / 2, y: (1 - projected.y) * height / 2 };
  }

  // A close-up can put a corner behind the camera. Clip the polygon before projection so the remaining face and its openings still align.
  function contourPath(contour, width, height, camera) {
    let vertices = contour.map(p => p.clone().applyMatrix4(model.matrixWorld).applyMatrix4(camera.matrixWorldInverse));
    for (const [z, sign] of [[-camera.near, -1], [-camera.far, 1]]) {
      const clipped = [];
      for (let i = 0; i < vertices.length; i++) {
        const a = vertices[i], b = vertices[(i + 1) % vertices.length];
        const insideA = (a.z - z) * sign >= 0, insideB = (b.z - z) * sign >= 0;
        if (insideA) clipped.push(a);
        if (insideA !== insideB) clipped.push(a.clone().lerp(b, (z - a.z) / (b.z - a.z)));
      }
      vertices = clipped;
    }
    if (vertices.length < 3) return '';
    return 'M' + vertices.map(p => {
      p.applyMatrix4(camera.projectionMatrix);
      return `${(p.x + 1) * width / 2},${(1 - p.y) * height / 2}`;
    }).join(' L') + ' Z';
  }

  function position(element, position) {
    element.hidden = !position;
    if (position) element.style.transform = `translate3d(${position.x}px, ${position.y}px, 0) translate(-50%, -50%)`;
  }

  // Short returns can project to the same few pixels, particularly on phones.
  // Try the anchor first, then adjacent positions in fixed order. Leaders connect moved badges to their faces.
  function positionBadges(width, height) {
    const placed = [], lines = [];
    // CSS gives the badges one size. Read it before any writes for this frame.
    const badgeWidth = (badges.find(b => !b.element.hidden)?.element.offsetWidth || 36) + 3;
    const badgeHeight = (badges.find(b => !b.element.hidden)?.element.offsetHeight || 28) + 3;
    const directions = [[0,-1], [0,1], [-1,0], [1,0], [-1,-1], [1,-1], [-1,1], [1,1]];
    const clamp = THREE.MathUtils.clamp;
    for (const badge of badges) {
      const at = screenPoint(badge.anchor, width, height);
      if (!at || at.x < 0 || at.y < 0 || at.x > width || at.y > height) {
        position(badge.element, null);
        continue;
      }
      const candidate = (dx, dy) => ({
        x: clamp(at.x + dx * badgeWidth, badgeWidth / 2, width - badgeWidth / 2),
        y: clamp(at.y + dy * badgeHeight, badgeHeight / 2, height - badgeHeight / 2),
      });
      const fits = p => !placed.some(q => Math.abs(p.x - q.x) < badgeWidth && Math.abs(p.y - q.y) < badgeHeight);
      let chosen = candidate(0, 0);
      if (!fits(chosen)) {
        const alternatives = [1, 2, 3].flatMap(step => directions.map(([x,y]) => candidate(x * step, y * step)));
        chosen = alternatives.find(fits) ?? chosen;
      }
      if (Math.hypot(chosen.x - at.x, chosen.y - at.y) > 4) lines.push(`M${at.x},${at.y} L${chosen.x},${chosen.y}`);
      placed.push(chosen);
      position(badge.element, chosen);
    }
    leaders.setAttribute('d', lines.join(' '));
  }

  function update(force = false) {
    if (hoverHit && (!isInteractive() || !hoverHit.camera.equals(getCamera().matrixWorld)
      || !hoverHit.projection.equals(getCamera().projectionMatrix))) clearHover();
    if (!room || !model) return;
    const width = canvas.clientWidth, height = canvas.clientHeight;
    // This also runs in response to controls before the next WebGL paint.
    const camera = getCamera();
    camera.updateWorldMatrix(true, false);
    model.updateWorldMatrix(true, false);
    const active = isInteractive();
    if (!force && width === previousWidth && height === previousHeight && active === previousActive
      && previousCamera.equals(camera.matrixWorld) && previousProjection.equals(camera.projectionMatrix) && previousModel.equals(model.matrixWorld)) return;
    previousWidth = width; previousHeight = height; previousActive = active;
    previousCamera.copy(camera.matrixWorld); previousProjection.copy(camera.projectionMatrix); previousModel.copy(model.matrixWorld);
    positionBadges(width, height);
    for (const badge of badges) badge.element.disabled = !active;
    position(marker, point && screenPoint(point, width, height));
    outline.setAttribute('d', contours.map(contour => contourPath(contour, width, height, camera)).join(' '));
  }

  function selectWall(id) {
    wall = room?.walls.find(candidate => candidate.id === id);
    point = null;
    contours = [];
    if (wall) {
      const rectangle = (u0, u1, z0, z1) => [[u0,z0],[u1,z0],[u1,z1],[u0,z1]].map(([u,z]) => scenePoint(wall,u,z));
      const { length } = wallAxes(wall);
      contours = [rectangle(0, length, 0, wall.heightMm), ...wall.openings.map(o =>
        rectangle(o.fromMm, o.toMm, o.bottomMm, Math.min(o.topMm, wall.heightMm)))];
    }
    for (const badge of badges) badge.element.setAttribute('aria-pressed', String(badge.id === wall?.id));
    update(true);
  }

  function setPoint(alongMm, heightMm) {
    const result = wall && wallPointAt(wall, alongMm, heightMm);
    point = result ? scenePoint(wall, result.alongMm, result.heightMm) : null;
    update(true);
    return result ?? null;
  }

  function clearHover() {
    hoverHit = null;
    roomHint.hidden = true;
    delete canvas.dataset.wallCursor;
  }

  function setRoom(record) {
    clearHover();
    for (const badge of badges) badge.element.remove();
    badges = [];
    room = record;
    overlay.hidden = !room;
    if (room) for (const face of room.walls) {
      const element = document.createElement('button');
      element.type = 'button';
      element.className = 'wall-badge';
      element.dataset.wallId = face.id;
      element.textContent = face.label ?? face.id;
      const name = `${face.id}${face.alias ? ` · Wall ${face.alias}` : ''}`;
      element.setAttribute('aria-label', name);
      element.title = `${name} · ${face.featureId}`;
      element.addEventListener('click', () => {
        if (!isInteractive()) return;
        selectWall(face.id);
        onWall(face.id);
      });
      overlay.append(element);
      badges.push({ id: face.id, element, anchor: scenePoint(face, wallAxes(face).length / 2, face.heightMm * 0.78) });
    }
    selectWall(null);
  }

  function setModel(group) {
    setRoom(null);
    model = group;
    labels = [];
    pointerDown = null;
    model?.traverse(o => { if (o.isMesh && o.userData.wallRoomId) labels.push(o); });
  }

  function setRay(event) {
    const rect = canvas.getBoundingClientRect();
    if (!rect.width || !rect.height) return false;
    pointer.set((event.clientX - rect.left) / rect.width * 2 - 1, 1 - (event.clientY - rect.top) / rect.height * 2);
    raycaster.setFromCamera(pointer, getCamera());
    return true;
  }

  function visible(object) {
    for (let parent = object; parent; parent = parent.parent) if (!parent.visible) return false;
    return true;
  }

  function roomLabel() {
    return raycaster.intersectObjects(labels, false).find(hit => visible(hit.object));
  }

  function unobstructed(label) {
    // In the stacked house, a lower floor's label can share the same screen position as an upper slab.
    // Only candidate labels need a depth check.
    const far = raycaster.far;
    raycaster.far = label.distance - 0.001;
    const blocked = raycaster.intersectObject(model).some(({ object, face }) => {
      if (!object.isMesh || object.userData.reviewLabel || !visible(object)) return false;
      const material = Array.isArray(object.material) ? object.material[face.materialIndex] : object.material;
      return material?.visible && material.colorWrite && material.depthWrite && !material.wireframe && material.opacity >= 0.95;
    });
    raycaster.far = far;
    return !blocked;
  }

  function hoverRoom(event, label) {
    // Small movements over the same word use the last depth check. A move around a foreground obstruction checks again.
    if (label.object !== hoverHit?.object || Math.hypot(event.clientX - hoverHit.x, event.clientY - hoverHit.y) > 8) {
      hoverHit = { object: label.object, x: event.clientX, y: event.clientY, allowed: unobstructed(label),
        camera: getCamera().matrixWorld.clone(), projection: getCamera().projectionMatrix.clone() };
    }
    roomHint.hidden = !hoverHit.allowed;
    if (!hoverHit.allowed) { delete canvas.dataset.wallCursor; return; }
    canvas.dataset.wallCursor = 'room';
    const { wallRoomName, wallRoomId } = label.object.userData;
    roomHint.textContent = `Open ${wallRoomName ?? wallRoomId}`;
    // Pointer events originate on the canvas, which shares the hint's local origin.
    const x = event.offsetX, y = event.offsetY;
    const dx = x > canvas.clientWidth / 2 ? 'calc(-100% - 12px)' : '12px';
    const dy = y > canvas.clientHeight / 2 ? 'calc(-100% - 12px)' : '12px';
    roomHint.style.transform = `translate(${x}px, ${y}px) translate(${dx}, ${dy})`;
  }

  function pick(event) {
    if (!isInteractive() || !model || !setRay(event)) return;
    if (!room) {
      const hit = roomLabel();
      if (hit && unobstructed(hit)) onRoom(hit.object.userData.wallRoomId);
      return;
    }
    if (!wall) return;
    if (getCamera().isOrthographicCamera) { onMiss?.('plan'); return; }
    const { ux, uy } = wallAxes(wall);
    // Intersect in the author's room frame, independent of camera, model placement and house display offsets.
    localRay.copy(raycaster.ray).applyMatrix4(inverse.copy(model.matrixWorld).invert());
    const start = scenePoint(wall, 0, 0);
    const plane = new THREE.Plane().setFromNormalAndCoplanarPoint(new THREE.Vector3(uy, 0, ux), start);
    const hit = localRay.intersectPlane(plane, new THREE.Vector3());
    if (!hit) { onMiss?.('outside'); return; }
    const u = ((hit.x - start.x) * ux - (hit.z - start.z) * uy) * 1000;
    const h = hit.y * 1000;
    const reason = invalidPoint(wall, u, h) ?? invalidPoint(wall, Math.round(u), Math.round(h));
    if (reason) { onMiss?.(reason); return; }
    onPoint(setPoint(Math.round(u), Math.round(h)));
  }

  // OrbitControls also listens to the canvas. Keep drags (including ones that return to their start) and pinches out of picking.
  canvas.addEventListener('pointerdown', event => {
    clearHover();
    if (!isInteractive() || pointerDown || event.button !== 0 || !event.isPrimary) { pointerDown = null; return; }
    pointerDown = { id: event.pointerId, x: event.clientX, y: event.clientY };
  });
  canvas.addEventListener('pointermove', event => {
    if (pointerDown && Math.hypot(event.clientX - pointerDown.x, event.clientY - pointerDown.y) > 5) pointerDown = null;
    if (event.buttons || event.pointerType === 'touch' || !isInteractive()) { clearHover(); return; }
    const label = !room && labels.length && setRay(event) && roomLabel();
    if (label) { hoverRoom(event, label); return; }
    clearHover();
    if (wall) canvas.dataset.wallCursor = 'point';
  });
  canvas.addEventListener('pointerup', event => {
    const tap = pointerDown;
    pointerDown = null;
    if (tap?.id === event.pointerId && Math.hypot(event.clientX - tap.x, event.clientY - tap.y) <= 5) pick(event);
  });
  canvas.addEventListener('pointercancel', () => { pointerDown = null; clearHover(); });
  canvas.addEventListener('pointerleave', clearHover);
  canvas.addEventListener('wheel', clearHover, { passive: true });

  setModel(null);
  return { setModel, setRoom, selectWall, setPoint, update };
}
