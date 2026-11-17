import assert from 'node:assert/strict';
import { test } from 'node:test';
import * as THREE from 'three';
import { enableFloorPicking } from '../preview/floor-picking.mjs';

function fixture() {
  function target() {
    const callbacks = new Map();
    return {
      addEventListener(name, callback) { callbacks.set(name, callback); },
      removeEventListener(name) { callbacks.delete(name); },
      fire(name, event) { callbacks.get(name)?.(event); },
    };
  }
  const view = target(), doc = target(), canvas = target();
  let frame;
  Object.assign(view, {
    requestAnimationFrame(callback) { frame = callback; return 1; },
    cancelAnimationFrame() { frame = undefined; },
  });
  doc.defaultView = view;
  canvas.ownerDocument = doc;
  canvas.getBoundingClientRect = () => ({ left: 0, right: 100, top: 0, bottom: 100, width: 100, height: 100 });

  const model = new THREE.Group();
  const camera = new THREE.OrthographicCamera(-1, 1, 1, -1, .1, 20);
  camera.position.z = 5;
  function floor(id, z) {
    const group = new THREE.Group();
    group.userData.levelId = id;
    const face = new THREE.Mesh(new THREE.PlaneGeometry(1.2, 1.2), new THREE.MeshBasicMaterial());
    group.position.z = z;
    group.add(face); model.add(group);
    return face;
  }
  const lower = floor('lower', 0), upper = floor('upper', 1);
  let enabled = true;
  const hover = [], picks = [];
  const picker = enableFloorPicking(canvas, {
    getHouse: () => enabled ? model : null, getCamera: () => camera,
    onHover: (id, event) => hover.push([id, event?.clientX]), onFloor: id => picks.push(id),
  });
  function send(name, props = {}) {
    doc.fire(name, { target: canvas, pointerId: 1, pointerType: 'mouse', isPrimary: true,
      isTrusted: true, clientX: 50, clientY: 50, button: 0, buttons: name === 'pointerdown' ? 1 : 0, ...props });
  }
  return { canvas, view, lower, upper, hover, picks, picker, send, disable() { enabled = false; }, tick() {
    const next = frame; frame = undefined; next?.();
  } };
}

test('hover coalesces movement, respects occlusion and clears outside the canvas or when picking is disabled', () => {
  const { send, hover, tick, upper, disable, picker } = fixture();
  send('pointermove'); send('pointermove', { clientX: 52 }); tick();
  assert.deepEqual(hover, [['upper', 52]]);
  upper.material.transparent = true;
  upper.material.opacity = .025;
  send('pointermove'); tick();
  assert.equal(hover.at(-1)[0], 'lower', 'a cutaway wall must not block the floor behind it');
  send('pointermove', { clientX: 1 }); tick();
  assert.equal(hover.at(-1)[0], null);
  send('pointermove'); disable(); tick();
  assert.equal(hover.length, 3, 'a queued hover cannot restore the old highlight after a scope change');
  picker.dispose();
});

test('hover ghosting keeps translucent floors pickable at their original opacity', () => {
  const { send, hover, tick, upper } = fixture();
  upper.material.transparent = true;
  upper.material.opacity = 0.02;
  upper.material.userData.floorHoverSourceOpacity = 0.15;
  send('pointermove'); tick();
  assert.equal(hover.at(-1)[0], 'upper');
  upper.material.userData.floorHoverSourceOpacity = 0.025;
  send('pointermove'); tick();
  assert.equal(hover.at(-1)[0], 'lower');
});

test('a click preserves hover until selection, while starting an orbit clears it', () => {
  const { send, hover, tick, picks } = fixture();
  send('pointermove'); tick();
  send('pointerdown');
  send('pointermove', { buttons: 1, clientX: 51 }); tick();
  send('pointerup');
  assert.deepEqual(picks, ['upper']);
  assert.deepEqual(hover, [['upper', 50]]);
  send('pointerdown');
  send('pointermove', { buttons: 1, clientX: 65 }); tick();
  assert.equal(hover.at(-1)[0], null);
  send('pointerup');
  assert.deepEqual(picks, ['upper']);
});

test('focusing the canvas after a toolbar control keeps the tap; leaving the window cancels it', () => {
  const { canvas, view, send, picks } = fixture();
  send('pointerdown');
  view.fire('blur', { target: canvas });
  send('pointerup');
  send('pointerdown');
  view.fire('blur', { target: view });
  send('pointerup');
  assert.deepEqual(picks, ['upper']);
});

test('a primary tap selects the visible floor; orbit, pinch, cancelled and replayed gestures do not', () => {
  const { send, picks, picker } = fixture();
  send('pointerdown'); send('pointerup');
  send('pointerdown', { pointerType: 'touch' }); send('pointerup', { pointerType: 'touch' });
  assert.deepEqual(picks, ['upper', 'upper']);

  send('pointerdown'); send('pointermove', { buttons: 1, clientX: 65 }); send('pointerup');
  send('pointerdown', { pointerType: 'touch' });
  send('pointerdown', { pointerType: 'touch', pointerId: 2, isPrimary: false });
  send('pointerup', { pointerId: 2 }); send('pointerup');
  send('pointerdown', { ctrlKey: true }); send('pointerup');
  send('pointerdown', { button: 2 }); send('pointerup', { button: 2 });
  send('pointerdown'); send('pointercancel'); send('pointerup');
  send('pointerdown', { isTrusted: false }); send('pointerup');
  send('pointerdown'); picker.clear(); send('pointerup');
  assert.equal(picks.length, 2);

  send('pointerdown'); send('pointerdown', { isTrusted: false }); send('pointerup');
  assert.equal(picks.length, 3, 'the steering lease replay must leave the original physical tap intact');
  picker.dispose(); send('pointerdown'); send('pointerup');
  assert.equal(picks.length, 3);
});

test('only visible model surfaces can select their parent floor', () => {
  const { send, picks, lower, upper } = fixture();
  upper.visible = false;
  send('pointerdown'); send('pointerup');
  assert.equal(picks.at(-1), 'lower');
  lower.parent.visible = false;
  send('pointerdown'); send('pointerup');
  assert.deepEqual(picks, ['lower']);
});
