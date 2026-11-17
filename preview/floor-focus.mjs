// Presentation only: the selected floor stays at its authored elevation.
// Other floors move apart and fade, then release their temporary materials.
const HOVER_OPACITY = 0.14;
const DURATION = 0.68;
const SEPARATION = 0.7; // additional metres per floor during the transition

export function createFloorFocus({ THREE, root, invalidate, reducedMotion = false }) {
  const white = new THREE.Color(0xffffff);
  const hoverGlow = new THREE.Color().setRGB(0.09, 0.11, 0.10);
  const levels = new Map();
  const floors = [];
  for (const group of root.children) {
    const id = group.userData.levelId;
    if (!id && !group.userData.unplaced) continue;
    const floor = { group, id, y: group.position.y, visible: group.visible, alpha: 1, offset: 0 };
    floors.push(floor);
    if (id) levels.set(id, floor);
  }
  const ordered = [...levels.values()].sort((a, b) =>
    (a.group.userData.elevationMm ?? a.y * 1000) - (b.group.userData.elevationMm ?? b.y * 1000));
  let focusedId = null, hoveredId = null, outline, elapsed = DURATION, disposed = false;

  function clearOutline() {
    if (!outline) return;
    outline.removeFromParent();
    outline.geometry.dispose();
    outline.material.dispose();
    outline = null;
  }

  function hover(id) {
    const floor = levels.get(id);
    const next = !disposed && !focusedId && elapsed >= DURATION && floor?.visible ? id : null;
    if (hoveredId === next) return;
    hoveredId = next;
    clearOutline();
    if (next) {
      for (const candidate of floors) {
        if (!candidate.group.visible) continue;
        const selected = candidate === floor;
        prepareMaterials(candidate);
        for (const [original, copy] of candidate.presentation.copies) {
          // Record pick opacity before ghosting so the hover target stays stable.
          copy.userData.floorHoverSourceOpacity = original.transparent ? original.opacity : 1;
          applyOpacity(original, copy, selected ? 1 : HOVER_OPACITY);
          if (copy.color) {
            copy.color.copy(original.color);
            if (selected) copy.color.lerp(white, 0.30).multiplyScalar(1.18);
          }
          if (copy.emissive) {
            copy.emissive.copy(original.emissive);
            if (selected) copy.emissive.add(hoverGlow);
          }
        }
      }
      // Outline the actual footprint (including its notches) when the level supplies a slab.
      const slab = floor.group.getObjectByName(next + '-slab');
      const ink = new THREE.LineBasicMaterial({ color: 0x13c0a4, depthTest: false, depthWrite: false, toneMapped: false });
      if (slab?.geometry) {
        outline = new THREE.LineSegments(new THREE.EdgesGeometry(slab.geometry), ink);
        slab.add(outline);
      } else {
        // A linework-only or imported floor can still show a footprint at its own elevation.
        const box = new THREE.Box3().setFromObject(floor.group).applyMatrix4(floor.group.matrixWorld.clone().invert());
        if (!box.isEmpty()) {
          const { min, max } = box;
          const points = [[min.x,min.z], [max.x,min.z], [max.x,max.z], [min.x,max.z]];
          const y = THREE.MathUtils.clamp(0, min.y, max.y);
          const geometry = new THREE.BufferGeometry().setFromPoints(points.map(([x,z]) => new THREE.Vector3(x, y, z)));
          outline = new THREE.LineLoop(geometry, ink);
          floor.group.add(outline);
        } else ink.dispose();
      }
      if (outline) {
        outline.name = 'hovered-floor-outline';
        outline.userData.floorFocusOverlay = true;
        outline.raycast = () => {};
        outline.renderOrder = 1000;
      }
    } else {
      for (const candidate of floors) releaseMaterials(candidate);
    }
    invalidate();
  }

  function prepareMaterials(floor) {
    if (floor.presentation) return;
    const presentation = { meshes: [], copies: new Map(), lights: [] };
    function copyOf(material) {
      if (!presentation.copies.has(material)) presentation.copies.set(material, material.clone());
      return presentation.copies.get(material);
    }
    floor.group.traverse(object => {
      if (object.isLight) presentation.lights.push([object, object.intensity]);
      if (!object.material || object.userData.floorFocusOverlay) return;
      const original = object.material;
      const assigned = Array.isArray(original) ? original.map(copyOf) : copyOf(original);
      object.material = assigned;
      presentation.meshes.push([object, original, assigned]);
    });
    floor.presentation = presentation;
  }

  function applyOpacity(original, copy, factor) {
    const transparent = original.transparent || factor < 1;
    if (copy.transparent !== transparent) {
      copy.transparent = transparent;
      copy.needsUpdate = true;
    }
    copy.opacity = original.opacity * factor;
    copy.depthWrite = factor < 1 ? false : original.depthWrite;
  }

  function releaseMaterials(floor) {
    const presentation = floor.presentation;
    if (!presentation) return;
    for (const [mesh, original, assigned] of presentation.meshes) {
      // A retiring cutaway controller may already have put back the authored material.
      if (mesh.material === assigned) mesh.material = original;
    }
    for (const [light, intensity] of presentation.lights) light.intensity = intensity;
    for (const copy of presentation.copies.values()) copy.dispose();
    floor.presentation = null;
  }

  function present(floor) {
    floor.group.visible = floor.visible && floor.alpha > 0;
    // Keep the authored transforms even for hidden floors once the movement has finished.
    floor.group.position.y = floor.y + (floor.group.visible ? floor.offset : 0);
    if (!floor.group.visible || floor.alpha >= 1) {
      releaseMaterials(floor);
      return;
    }
    prepareMaterials(floor);
    for (const [original, copy] of floor.presentation.copies) applyOpacity(original, copy, floor.alpha);
    for (const [light, intensity] of floor.presentation.lights) light.intensity = intensity * floor.alpha;
  }

  function update(deltaSeconds) {
    if (disposed || elapsed >= DURATION) return false;
    const skip = typeof reducedMotion === 'function' ? reducedMotion() : reducedMotion;
    elapsed = skip ? DURATION : Math.min(DURATION, elapsed + Math.max(0, deltaSeconds));
    const t = elapsed / DURATION;
    const travel = t * t * (3 - 2 * t);
    // Floors fade early on departure and regain their detail as they settle back in.
    const fadeOut = 1 - (1 - t) ** 5;
    const fadeIn = travel * travel;
    for (const floor of floors) {
      floor.alpha = THREE.MathUtils.lerp(floor.fromAlpha, floor.toAlpha, floor.toAlpha < floor.fromAlpha ? fadeOut : fadeIn);
      floor.offset = THREE.MathUtils.lerp(floor.fromOffset, floor.toOffset, travel);
      present(floor);
    }
    return elapsed < DURATION;
  }

  function focus(id, { immediate = false, fromHover = hoveredId } = {}) {
    if (disposed || (id != null && !levels.has(id))) return;
    if (id === focusedId) {
      if (immediate && elapsed < DURATION) { update(DURATION); invalidate(); }
      return;
    }
    hover(null);
    focusedId = id;
    const selected = levels.get(id);
    for (const floor of floors) {
      floor.fromAlpha = fromHover && floor.id !== fromHover ? HOVER_OPACITY : floor.alpha;
      floor.fromOffset = floor.offset;
      floor.toAlpha = !selected || selected === floor ? 1 : 0;
      floor.toOffset = selected && floor.id ? (ordered.indexOf(floor) - ordered.indexOf(selected)) * SEPARATION : 0;
    }
    elapsed = 0;
    update(immediate ? DURATION : 0); // apply reduced-motion preferences immediately
    invalidate();
  }

  function dispose() {
    disposed = true;
    hoveredId = null;
    clearOutline();
    for (const floor of floors) {
      releaseMaterials(floor);
      floor.group.visible = floor.visible;
      floor.group.position.y = floor.y;
    }
  }

  return { hover, focus, update, dispose,
    get transitioning() { return !disposed && elapsed < DURATION; },
    get focusedId() { return focusedId; },
    get hoveredId() { return hoveredId; },
  };
}
