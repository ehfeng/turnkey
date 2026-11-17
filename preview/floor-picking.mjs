import * as THREE from 'three';

/** Point at a floor in the assembled house. Keyboard users can open any level from Scope. */
export function enableFloorPicking(canvas, { getHouse, getCamera, onHover, onFloor }) {
  const doc = canvas.ownerDocument;
  const view = doc.defaultView;
  const ray = new THREE.Raycaster();
  ray.params.Line.threshold = 0.06; // metres of tolerance around model edges
  const pointer = new THREE.Vector2();
  const hits = [];
  let tap, hoverEvent, frame, hovered;

  function floorAt(house, event) {
    const rect = canvas.getBoundingClientRect();
    const { clientX: x, clientY: y } = event;
    if (!rect.width || !rect.height || x < rect.left || x > rect.right || y < rect.top || y > rect.bottom) return null;
    pointer.set(2 * (x - rect.left) / rect.width - 1, 1 - 2 * (y - rect.top) / rect.height);
    const camera = getCamera();
    camera.updateWorldMatrix(true, false);
    house.updateWorldMatrix(true, true);
    ray.setFromCamera(pointer, camera);
    hits.length = 0;
    ray.intersectObject(house, true, hits);

    for (const { object, face } of hits) {
      const material = Array.isArray(object.material) ? object.material[face?.materialIndex] : object.material;
      if (!object.visible || !material?.visible) continue;
      const opacity = material.userData.floorHoverSourceOpacity ?? (material.transparent ? material.opacity : 1);
      if (opacity <= 0.03) continue;
      let floor = object;
      while (floor.parent && floor.parent !== house && floor.parent.visible) floor = floor.parent;
      if (floor.parent === house && floor.userData.levelId) return floor.userData.levelId;
    }
    return null;
  }

  function clearHover() {
    if (frame !== undefined) view.cancelAnimationFrame(frame);
    frame = hoverEvent = undefined;
    if (hovered) onHover?.(null);
    hovered = null;
  }
  function clear() {
    tap = null;
    hits.length = 0;
    clearHover();
  }
  function updateHover() {
    frame = undefined;
    const house = getHouse();
    const id = house ? floorAt(house, hoverEvent) : null;
    if (id || hovered) onHover?.(id, hoverEvent);
    hovered = id;
    hoverEvent = undefined;
  }
  const modified = event => event.ctrlKey || event.metaKey || event.altKey || event.shiftKey;
  const dragged = event => Math.hypot(event.clientX - tap.x, event.clientY - tap.y) > 5;

  // Collaboration can hold then replay pointerdown to obtain a steering lease.
  // Track only the physical gesture, allow OrbitControls and lease cleanup to run,
  // and select the floor through the shared navigation action.
  function down(event) {
    if (!event.isTrusted) return;
    const house = getHouse();
    if (!house || event.target !== canvas || !event.isPrimary || event.button !== 0 || modified(event)) {
      clear();
      return;
    }
    // Keep the current hover through a click so isolation can continue its fade.
    tap = { id: event.pointerId, x: event.clientX, y: event.clientY, house };
  }
  function move(event) {
    if (tap?.id === event.pointerId) {
      if (event.buttons === 1 && !dragged(event) && !modified(event) && event.target === canvas) return;
      tap = null;
    }
    if (!onHover || event.target !== canvas || event.buttons || event.pointerType === 'touch' ||
        !event.isPrimary || modified(event) || !getHouse()) {
      clearHover();
      return;
    }
    hoverEvent = event;
    if (frame === undefined) frame = view.requestAnimationFrame(updateHover);
  }
  function up(event) {
    if (!tap || event.pointerId !== tap.id) return;
    const house = tap.house;
    const valid = event.target === canvas && event.button === 0 && !modified(event) && !dragged(event) && house === getHouse();
    tap = null;
    if (valid) {
      const id = floorAt(house, event);
      if (id) onFloor(id);
    }
  }

  const listeners = [
    [doc, 'pointerdown', down], [doc, 'pointermove', move], [doc, 'pointerup', up],
    [doc, 'pointercancel', clear], [doc, 'wheel', clear], [view, 'blur', event => { if (event.target === view) clear(); }],
    [canvas, 'pointerleave', clearHover],
  ];
  for (const [target, type, listener] of listeners) target.addEventListener(type, listener, { capture: true, passive: true });
  return {
    clear,
    dispose() {
      for (const [target, type, listener] of listeners) target.removeEventListener(type, listener, true);
      clear();
    },
  };
}
