import * as THREE from 'three';

const FADED_OPACITY = 0.025;
const RESPONSE_SECONDS = 0.09;
const SAMPLE_POSITIONS = [0.05, 0.25, 0.5, 0.75, 0.95];
const VIEW_MARGIN = 0.08;

/** Camera policy belongs here; builders supply only wall IDs, room bounds/floors and ceilings. */
export function createWallTransparency(model) {
  model.updateWorldMatrix(true, true);
  const rooms = [], barriers = [], meshBarrier = new Map(), materials = [];
  const occluderSources = new Map();
  const occlusionMaterial = new THREE.MeshBasicMaterial({ side: THREE.DoubleSide });
  const cameraPosition = new THREE.Vector3(), direction = new THREE.Vector3();
  const projected = new THREE.Vector3(), nearest = new THREE.Vector3();
  const frustum = new THREE.Frustum(), projection = new THREE.Matrix4();
  const raycaster = new THREE.Raycaster();
  const lastView = new THREE.Matrix4(), lastProjection = new THREE.Matrix4();
  const lastTarget = new THREE.Vector3(Infinity, Infinity, Infinity);
  const obstructing = new Set();
  let lastPlan;
  let activeRoom;

  // IDs are scoped to their level, so repeated assets/rooms cannot fade another floor.
  const byOwner = new Map();
  function ownerOf(object) {
    for (let p = object; p; p = p.parent) if (p.userData.levelId) return p;
    return model;
  }
  function barrierFor(object) {
    const owner = ownerOf(object);
    if (!byOwner.has(owner)) byOwner.set(owner, new Map());
    const map = byOwner.get(owner);
    const key = object.userData.ceiling ? object : object.userData.wallId;
    if (!map.has(key)) {
      const barrier = { objects: [], meshes: [], occluders: [], faces: [], factor: 1, ceiling: !!object.userData.ceiling };
      map.set(key, barrier); barriers.push(barrier);
    }
    return map.get(key);
  }

  model.traverse((object) => {
    if (object.userData.wallId || object.userData.ceiling) {
      const barrier = barrierFor(object);
      barrier.objects.push(object);
      object.traverse((child) => {
        if (!child.material || !child.geometry || meshBarrier.has(child)) return;
        barrier.meshes.push(child); meshBarrier.set(child, barrier);
        // Attachments fade with their wall but must not make a back wall disappear (e.g. a deep cabinet).
        if (!object.userData.itemId && child.isMesh) {
          // A wall still blocks the view from its back, even when its authored finish only renders one side.
          // These raycast-only meshes share geometry, never enter the scene, and leave render materials intact.
          const occluder = new THREE.Mesh(child.geometry, occlusionMaterial);
          occluder.matrixAutoUpdate = false;
          occluder.matrixWorld.copy(child.matrixWorld);
          occluder.layers.mask = child.layers.mask;
          barrier.occluders.push(occluder);
          occluderSources.set(occluder, child);
        }
      });
      if (!object.userData.itemId) {
        const wallPlane = object.userData.wallPlane;
        if (wallPlane) {
          barrier.faces.push(new THREE.Plane().setFromNormalAndCoplanarPoint(
            new THREE.Vector3(...wallPlane.normal).normalize(), new THREE.Vector3(...wallPlane.point),
          ).applyMatrix4(object.matrixWorld));
        } else {
          const localBox = new THREE.Box3(), transform = new THREE.Matrix4();
          const inverse = object.matrixWorld.clone().invert();
          object.traverse((child) => {
            if (!child.geometry) return;
            child.geometry.computeBoundingBox();
            localBox.union(child.geometry.boundingBox.clone().applyMatrix4(transform.multiplyMatrices(inverse, child.matrixWorld)));
          });
          if (!localBox.isEmpty()) {
            const size = localBox.getSize(new THREE.Vector3()), center = localBox.getCenter(new THREE.Vector3());
            const normal = barrier.ceiling ? new THREE.Vector3(0, 1, 0)
              : size.x > size.z ? new THREE.Vector3(0, 0, 1) : new THREE.Vector3(1, 0, 0);
            barrier.faces.push(new THREE.Plane().setFromNormalAndCoplanarPoint(normal, center).applyMatrix4(object.matrixWorld));
          }
        }
      }
    }
    const region = object.userData.roomRegion;
    if (!region && !object.userData.roomSurface) return;
    const box = region
      ? new THREE.Box3(new THREE.Vector3(...region.min), new THREE.Vector3(...region.max)).applyMatrix4(object.matrixWorld)
      : new THREE.Box3().setFromObject(object);
    if (box.isEmpty()) return;
    // Traced floor surfaces have no inferred ceiling height. Sample the lower interior of their 1 m review walls.
    const floorY = box.min.y;
    if (!region) box.max.y = floorY + 1;
    const samples = [];
    const min = region?.min ?? box.min.toArray(), max = region?.max ?? box.max.toArray();
    for (const u of SAMPLE_POSITIONS) for (const v of SAMPLE_POSITIONS) {
      const x = THREE.MathUtils.lerp(min[0], max[0], u);
      const z = THREE.MathUtils.lerp(min[2], max[2], v);
      if (region?.footprint) {
        let inside = false;
        const polygon = region.footprint;
        for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
          const [xi, zi] = polygon[i], [xj, zj] = polygon[j];
          if ((zi > z) !== (zj > z) && x < (xj - xi) * (z - zi) / (zj - zi) + xi) inside = !inside;
        }
        if (!inside) continue;
      }
      if (!region) {
        // Respect concave room footprints instead of treating their bounding rectangle as floor.
        raycaster.set(new THREE.Vector3(x, floorY + 1, z), new THREE.Vector3(0, -1, 0));
        raycaster.far = 2;
        if (!raycaster.intersectObject(object, false).length) continue;
      }
      for (const height of [0.15, Math.min(1.1, (max[1] - min[1]) * 0.7)]) {
        const sample = new THREE.Vector3(x, min[1] + height, z);
        samples.push(region ? sample.applyMatrix4(object.matrixWorld) : sample);
      }
    }
    if (samples.length) rooms.push({ object, box, samples, center: box.getCenter(new THREE.Vector3()), visible: true });
  });
  for (const barrier of barriers) {
    barrier.box = new THREE.Box3();
    for (const object of barrier.objects) barrier.box.union(new THREE.Box3().setFromObject(object));
  }

  function visible(object) {
    for (let p = object; p; p = p.parent) if (!p.visible) return false;
    return true;
  }

  function score(room, camera, target) {
    if (!visible(room.object) || !frustum.intersectsBox(room.box)) return Infinity;
    projected.copy(room.center).project(camera);
    // Nearby rooms near the direction of interest win over a closet at the edge of the screen.
    const distance = room.box.distanceToPoint(cameraPosition);
    return distance * (1 + 0.2 * Math.min(2, Math.hypot(projected.x, projected.y)))
      + (target ? room.box.distanceToPoint(target) * 0.35 : 0);
  }

  function prepareMaterials(barrier) {
    if (barrier.materials) return;
    barrier.materials = [];
    const clones = new Map();
    for (const object of barrier.meshes) {
      const original = object.material;
      const clone = (material) => {
        if (!clones.has(material)) {
          const copy = material.clone();
          const state = { material: copy, opacity: material.opacity, transparent: material.transparent, depthWrite: material.depthWrite };
          clones.set(material, state); barrier.materials.push(state);
        }
        return clones.get(material).material;
      };
      object.material = Array.isArray(original) ? original.map(clone) : clone(original);
      materials.push({ object, original });
    }
  }

  function applyFactor(barrier, factor) {
    if (factor === 1 && !barrier.materials) return;
    prepareMaterials(barrier);
    for (const state of barrier.materials) {
      const material = state.material;
      const transparent = factor < 1 || state.transparent;
      if (material.transparent !== transparent) { material.transparent = transparent; material.needsUpdate = true; }
      // Keep removals legible when the camera cuts through their wall.
      const visibleFactor = material.userData.demolitionHighlight ? Math.max(0.36, factor) : factor;
      material.opacity = state.opacity * visibleFactor;
      material.depthWrite = factor < 1 ? false : state.depthWrite;
    }
  }

  return {
    get activeRoom() { return activeRoom?.object; },
    // Return true only while interpolation needs another frame; static views can stop rendering.
    update({ camera, target, delta = 0, plan = camera.isOrthographicCamera }) {
      camera.updateMatrixWorld();
      camera.getWorldPosition(cameraPosition);
      frustum.setFromProjectionMatrix(projection.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse));
      let visibilityChanged = false;
      for (const room of rooms) {
        const shown = visible(room.object);
        if (room.visible !== shown) visibilityChanged = true;
        room.visible = shown;
      }
      const moved = !lastView.equals(camera.matrixWorld) || !lastProjection.equals(camera.projectionMatrix)
        || (target && !lastTarget.equals(target)) || plan !== lastPlan || visibilityChanged;
      if (moved) {
        lastView.copy(camera.matrixWorld); lastProjection.copy(camera.projectionMatrix);
        if (target) lastTarget.copy(target);
        lastPlan = plan;
        obstructing.clear();
      }
      if (moved && !plan) {
        let best, bestScore = Infinity;
        for (const room of rooms) {
          const value = score(room, camera, target);
          if (value < bestScore) { best = room; bestScore = value; }
        }
        // Keep the current room across small movements around a shared corner.
        if (best && activeRoom && score(activeRoom, camera, target) <= bestScore * 1.12 + 0.15) best = activeRoom;
        activeRoom = best;
        // Clear sightlines into every room on screen. A single nearest room can leave the room
        // the user is actually inspecting behind an opaque wall, especially in a floor overview.
        for (const room of rooms) {
          if (!room.visible || !frustum.intersectsBox(room.box)) continue;
          for (const sample of room.samples) {
            nearest.copy(sample).project(camera);
            // Keep a small margin so a wall clears before a cropped room moves fully into view.
            if (Math.abs(nearest.x) > 1 + VIEW_MARGIN || Math.abs(nearest.y) > 1 + VIEW_MARGIN || Math.abs(nearest.z) > 1) continue;
            direction.copy(sample).sub(cameraPosition);
            raycaster.far = Math.max(0, direction.length() - 0.025);
            raycaster.set(cameraPosition, direction.normalize());
            for (const barrier of barriers) {
              if (obstructing.has(barrier) || !raycaster.ray.intersectsBox(barrier.box)) continue;
              // Cross the wall's plane as well as its geometry; furniture projecting into the interior is not a wall.
              if (!barrier.faces.some((plane) => plane.distanceToPoint(cameraPosition) * plane.distanceToPoint(sample) < 0)) continue;
              if (raycaster.intersectObjects(barrier.occluders, false).some((hit) => visible(occluderSources.get(hit.object)))) obstructing.add(barrier);
            }
          }
        }
      } else if (plan) activeRoom = undefined;
      const blend = delta > 0 ? 1 - Math.exp(-Math.min(delta, 0.1) / RESPONSE_SECONDS) : 1;
      let needsFrame = false;
      for (const barrier of barriers) {
        const desired = (plan && barrier.ceiling) ? 0 : obstructing.has(barrier) ? FADED_OPACITY : 1;
        let factor = plan ? desired : THREE.MathUtils.lerp(barrier.factor, desired, blend);
        if (Math.abs(factor - desired) < 0.002) factor = desired;
        if (factor !== barrier.factor) { barrier.factor = factor; applyFactor(barrier, factor); }
        if (factor !== desired) needsFrame = true;
      }
      return needsFrame;
    },
    dispose() {
      for (const { object, original } of materials) object.material = original;
      for (const barrier of barriers) for (const state of barrier.materials ?? []) state.material.dispose();
      occlusionMaterial.dispose();
    },
  };
}
