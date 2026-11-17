import assert from 'node:assert/strict';
import test from 'node:test';
import * as THREE from 'three';
import { createFloorFocus } from '../preview/floor-focus.mjs';
import { createWallTransparency } from '../preview/wall-transparency.mjs';

function fixture(reducedMotion) {
  const root = new THREE.Group();
  const material = new THREE.MeshStandardMaterial({ color: 0x756855, transparent: true, opacity: 0.6 });
  const geometry = new THREE.BoxGeometry(8, 0.15, 12);
  const floors = ['lower', 'main', 'upper'].map((id, i) => {
    const group = new THREE.Group();
    group.userData.levelId = id;
    group.userData.elevationMm = (i - 1) * 3000;
    group.position.y = group.userData.elevationMm / 1000;
    const slab = new THREE.Mesh(geometry, material);
    slab.name = id + '-slab';
    const room = new THREE.Group();
    const mesh = new THREE.Mesh(geometry, [material, material]);
    const light = new THREE.PointLight(0xffffff, 14);
    room.add(mesh, light);
    group.add(slab, room);
    root.add(group);
    return { id, group, slab, mesh, light };
  });
  let redraws = 0;
  const controller = createFloorFocus({ THREE, root, invalidate: () => redraws++, reducedMotion });
  return { root, material, floors, controller, redraws: () => redraws };
}

test('hover brightens the selected floor, ghosts its neighbors and preserves picking and original materials', () => {
  const { root, material, floors, controller, redraws } = fixture();
  const [lower, main, upper] = floors;
  const originalColors = [material.color.clone(), material.emissive.clone()];
  const originalArray = main.mesh.material;
  const originalBounds = new THREE.Box3().setFromObject(root);
  controller.hover('main');
  const highlighted = main.slab.material;
  assert(highlighted.color.r > material.color.r && highlighted.emissive.g > material.emissive.g);
  assert.equal(highlighted.opacity, material.opacity);
  assert.equal(controller.hoveredId, 'main');
  for (const neighbor of [lower, upper]) {
    const muted = neighbor.slab.material;
    assert(muted.opacity > 0 && muted.opacity < material.opacity / 4);
    assert.equal(muted.depthWrite, false);
    assert.equal(muted.userData.floorHoverSourceOpacity, material.opacity);
    assert(muted.color.equals(material.color));
  }
  assert.equal(main.mesh.material[0], highlighted, 'meshes on a floor share presentation material copies');
  assert.notEqual(lower.slab.material, highlighted);
  assert(material.color.equals(originalColors[0]) && material.emissive.equals(originalColors[1]));
  const outline = main.group.getObjectByName('hovered-floor-outline');
  assert(outline?.userData.floorFocusOverlay);
  assert(new THREE.Box3().setFromObject(root).equals(originalBounds));
  assert.deepEqual(new THREE.Raycaster().intersectObject(outline), []);
  const wakeups = redraws();
  controller.hover('main');
  assert.equal(redraws(), wakeups);
  assert.equal(controller.update(1 / 60), false);
  controller.hover('upper');
  assert.equal(main.slab.material, highlighted, 'switching floors reuses the current copies');
  assert(highlighted.color.equals(material.color) && highlighted.emissive.equals(material.emissive));
  assert(highlighted.opacity < material.opacity / 4);
  assert.equal(upper.slab.material.opacity, material.opacity);
  assert(upper.slab.material.color.r > material.color.r);
  assert.equal(outline.parent, null);
  let disposals = 0;
  highlighted.addEventListener('dispose', () => disposals++);
  controller.hover(null);
  assert.equal(disposals, 1);
  assert.equal(controller.hoveredId, null);
  assert.equal(main.mesh.material, originalArray);
  assert(floors.every(floor => floor.slab.material === material));
  controller.hover('lower');
  controller.dispose();
  assert(floors.every(floor => floor.slab.material === material));
  assert(material.color.equals(originalColors[0]) && material.emissive.equals(originalColors[1]));
});

test('hover preserves materials and visibility set by the wall cutaway', () => {
  const { root, material, floors, controller } = fixture();
  const [lower, main] = floors;
  main.slab.userData.ceiling = true;
  const cutaway = createWallTransparency(root);
  cutaway.update({ camera: new THREE.OrthographicCamera(), plan: true });
  const cutawayMaterial = main.slab.material;
  assert.notEqual(cutawayMaterial, material);
  assert.equal(cutawayMaterial.opacity, 0);
  controller.hover('lower');
  assert.equal(main.slab.material.opacity, 0, 'ghosting must retain cut-away surfaces');
  controller.hover('main');
  assert.equal(main.slab.material.opacity, 0, 'highlighting must retain cut-away surfaces');
  controller.hover(null);
  assert.equal(main.slab.material, cutawayMaterial);
  controller.hover('main');
  controller.focus('lower');
  assert.equal(controller.hoveredId, null);
  assert.equal(main.slab.material, cutawayMaterial, 'beginning isolation must clear hover copies');
  cutaway.dispose();
  controller.update(0.15);
  controller.dispose();
  assert.equal(main.slab.material, material);
  assert.equal(lower.slab.material, material);
});

test('floor focus separates and fades other levels, reverses mid-motion, and restores shared materials', () => {
  const { material, floors, controller } = fixture();
  const [lower, main, upper] = floors;
  const original = lower.mesh.material;
  controller.focus('main');
  assert(controller.transitioning);
  controller.update(0.18);
  assert(lower.group.position.y < -3);
  assert(upper.group.position.y > 3);
  assert.equal(main.group.position.y, 0);
  assert.equal(main.slab.material, material);
  assert.notEqual(lower.slab.material, upper.slab.material);
  assert.equal(lower.mesh.material[0], lower.slab.material);
  assert(lower.slab.material.opacity > 0 && lower.slab.material.opacity < material.opacity * 0.25,
    'departing floors should have lost most of their opacity by 180 ms');
  assert(upper.group.position.y - 3 < 0.2, 'vertical drift should still be subtle as the floor fades');
  assert(lower.light.intensity < main.light.intensity);
  let disposals = 0;
  lower.slab.material.addEventListener('dispose', () => disposals++);
  const offset = lower.group.position.y;
  const opacity = lower.slab.material.opacity;
  controller.focus(null);
  assert.equal(lower.group.position.y, offset);
  assert.equal(lower.slab.material.opacity, opacity);
  controller.update(0.1);
  assert(lower.group.position.y > offset);
  assert(lower.slab.material.opacity > opacity);
  assert.equal(controller.update(1), false);
  assert.equal(disposals, 1);
  assert.equal(lower.mesh.material, original);
  assert.equal(lower.slab.material, material);
  assert.equal(lower.light.intensity, 14);

  controller.focus('upper');
  controller.update(1);
  assert.deepEqual(floors.map(floor => floor.group.visible), [false, false, true]);
  assert.deepEqual(floors.map(floor => floor.group.position.y), [-3, 0, 3]);
  controller.focus(null);
  controller.update(0.16);
  assert(main.group.visible);
  assert(main.group.position.y < 0);
  assert(main.slab.material.opacity < material.opacity * 0.10, 'returning floors are faint early in their travel');
  controller.dispose();
  assert.equal(controller.update(1), false);
  assert.deepEqual(floors.map(floor => floor.group.visible), [true, true, true]);
  assert(floors.every(floor => floor.slab.material === material));
  assert.deepEqual(floors.map(floor => floor.group.position.y), [-3, 0, 3]);
});

test('selecting a hovered floor continues from the opacity already on screen', () => {
  const { controller, material, floors: [lower, main, upper] } = fixture();
  controller.hover('main');
  const hoverOpacity = upper.slab.material.opacity;
  // The viewer clears pointer feedback before rebuilding the wall cutaway controller.
  const fromHover = controller.hoveredId;
  controller.hover(null);
  controller.focus('main', { fromHover });
  assert.equal(upper.slab.material.opacity, hoverOpacity);
  assert.equal(lower.slab.material.opacity, hoverOpacity);
  assert.equal(main.slab.material, material);
  controller.update(0.1);
  assert(upper.slab.material.opacity < hoverOpacity / 2);
  controller.update(1);
  assert.deepEqual([lower, main, upper].map(floor => floor.group.visible), [false, true, false]);
});

test('reduced motion and immediate navigation settle without an intermediate frame', () => {
  for (const reduced of [false, true]) {
    const { controller, floors } = fixture(() => reduced);
    controller.focus('main', { immediate: !reduced });
    assert.equal(controller.focusedId, 'main');
    assert.equal(controller.transitioning, false);
    assert.equal(controller.update(0), false);
    assert.deepEqual(floors.map(floor => floor.group.visible), [false, true, false]);
    controller.focus(null, { immediate: !reduced });
    assert(floors.every(floor => floor.group.visible));
  }
});
