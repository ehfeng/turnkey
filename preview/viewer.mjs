import project from 'virtual:turnkey-project';
import { renovationView, writeRenovationView } from './renovation-views.mjs';
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { furnitureEditor } from './furniture-editor.mjs';
import { loadCatalog, selectDesignGeometry } from './active-geometry.mjs';
import { openDesign } from './open-design.mjs';
import { enableFloorPicking } from './floor-picking.mjs';
import { createFloorFocus } from './floor-focus.mjs';
import { createPreviewGallery } from './gallery.mjs';
import { createRemoteCameraMotion } from './remote-camera.mjs';
import { setupCollaboration } from './collaboration-ui.mjs';
import { createWallPanel } from './wall-panel.mjs';
import { createWallTransparency } from './wall-transparency.mjs';
import { createRenderScheduler } from './render-scheduler.mjs';
import { disposeRendererResources } from '../lib/renderer-resources.mjs';

const viewport = document.querySelector('#scene');
const fullscreenTarget = document.querySelector('#viewport');
const fullscreenButton = document.querySelector('#fullscreen');
const scopeSelect = document.querySelector('#scope');
const fitButton = document.querySelector('#fit');
const backToHouse = document.querySelector('#back-to-house');
const floorHint = document.querySelector('#floor-pick-hint');
const optionSelect = document.querySelector('#option');
const optionLabel = document.querySelector('#option-label');
const acceptedRender = document.querySelector('#accepted-render');
const hasDrawings = typeof project.drawings?.buildLevel === 'function' && typeof project.drawings?.buildPreview === 'function';
const showBefore = document.querySelector('#show-before');
const showRemovals = document.querySelector('#show-removals');
const removalsLabel = document.querySelector('#removals-label');
const openDrawings = document.querySelector('#open-drawings');
const drawingPhase = document.querySelector('#drawing-phase');
const phaseLabel = document.querySelector('#drawing-phase-label');
const backToDesign = document.querySelector('#back-to-design');
let renovation = { condition: 'design', drawing: null, compare: null };
const conditionLegend = document.querySelector('#condition-legend');
const viewSelect = document.querySelector('#view');
const assemblySelect = document.querySelector('#assembly');
const assemblyLabel = document.querySelector('#assembly-label');
const wallCutaway = document.querySelector('#wall-cutaway');
const fixtureLights = document.querySelector('#fixture-lights');
const warningList = document.querySelector('#warnings');
const showNotes = document.querySelector('#show-notes');
const notice = document.querySelector('#notice');
const navigation = document.querySelector('#navigation');
function previewPreference() {
  const value = new URL(location.href).searchParams.get('previews');
  return ['on', 'view', 'all'].includes(value) ? value : null;
}
const gallery = createPreviewGallery(document, {
  preference: previewPreference(),
  onToggle(open, preference) {
    const url = new URL(location.href);
    if (open) url.searchParams.set('previews', preference || 'on'); else url.searchParams.delete('previews');
    history.replaceState(history.state, '', url);
    const display = document.querySelector('#display');
    if (open) display.open = false;
    else if (!display.open) document.querySelector('#display > summary').focus();
  },
});
acceptedRender.addEventListener('click', event => {
  // Modified clicks keep the original image URL for opening in another tab.
  if (event.button === 0 && !event.altKey && !event.ctrlKey && !event.metaKey && !event.shiftKey
      && gallery.showImage(acceptedRender.href)) event.preventDefault();
});
const scene = new THREE.Scene();
const perspectiveCamera = new THREE.PerspectiveCamera(40, 1, 0.01, 1000);
const planCamera = new THREE.OrthographicCamera(-10, 10, 10, -10, 0.01, 1000);
let camera = perspectiveCamera;
const initialDirection = new THREE.Vector3(1, 0.8, 1).normalize();
const centerInView = new THREE.Vector3();

let catalog;
let renderer;
let controls;
let model;
let bounds;
let requestNumber = 0;
let frameHooks = [];
let lastFrame = 0;
let wallTransparency;
let wallPanel;
let floorFocus, floorPicker, floorFrameTime;
let editing = false;
let animated = false;
let modelKey;
let layoutWarning, acceptedPhoto;
let hasMultipleLevels = false;
let defaultPlanScope = 'house';
function scopeFromUrl(params) {
  return params.get('scope') ?? (params.get('view') === 'plan' ? defaultPlanScope : 'house');
}
let displayedScope;
let cameraFrame;
let viewingDrawing = false;
let modelCamera;

function fitReviewView(frame) {
  fitView();
  if (viewingDrawing || !modelCamera) return;
  const saved = modelCamera;
  modelCamera = null;
  if (saved.frame !== frame) return;
  camera.position.copy(saved.position);
  controls.target.copy(saved.target);
  camera.zoom = saved.zoom;
  if (camera.isOrthographicCamera && saved.halfHeight !== null) {
    const aspect = Math.max(viewport.clientWidth, 1) / Math.max(viewport.clientHeight, 1);
    camera.top = saved.halfHeight; camera.bottom = -camera.top;
    camera.right = camera.top * aspect; camera.left = -camera.right;
  }
  camera.updateProjectionMatrix();
  controls.update();
  updateClipping();
}
let applyingRemote = false;
let collaboration;
let canSteer = true;
const remoteCamera = createRemoteCameraMotion();
const floorCache = new Map();
const frames = createRenderScheduler({ render: renderFrame });
function invalidate() {
  if (renderer && model) frames.request();
}

let editor, designSession, sharedDesignWritable = false, designBootstrapError;
const editorOptions = {
  openRoom: (id, refresh) => collaboration.runAction(async () => {
    if (refresh) { modelKey = undefined; clearFloorCache(); }
    const url = new URL(location.href);
    url.searchParams.set('scope', 'room/' + id);
    url.searchParams.delete('floor');
    url.searchParams.set('view', 'plan');
    writeRenovationView(url.searchParams);
    if (url.searchParams.get('option') === 'existing-measured') url.searchParams.delete('option');
    history.pushState(null, '', url);
    await showScope();
  }),
  scene,
  getCamera: () => camera,
  dispose: releaseModel,
  onOpenChange(open) {
    editing = open;
    floorPicker?.clear();
    wallPanel?.setEditing(open);
    updateFloorNavigation();
  },
  onModelChanged() {
    // New instances may add fixture lights and frame hooks to the current room.
    frameHooks = [];
    animated = false;
    model?.traverse(object => {
      if (typeof object.userData.onFrame === 'function') frameHooks.push(object);
      if (object.userData.animate) animated = true;
    });
    if (model) bounds = new THREE.Box3().setFromObject(model).getBoundingSphere(new THREE.Sphere());
    updateClipping();
    applyFixtureLights();
  },
  invalidate
};

function getDesignHeaders() {
  const key = document.getElementById('layout-key').value.trim();
  return key ? { Authorization: 'Bearer ' + key } : {};
}

// Keep decoded images across scope/option changes; GPU textures remain model-owned and disposable.
THREE.Cache.enabled = true;
const previousProgress = THREE.DefaultLoadingManager.onProgress;
THREE.DefaultLoadingManager.onProgress = (...args) => {
  previousProgress?.(...args);
  invalidate();
};

function showNotice(title, detail = '') {
  document.querySelector('#notice-title').textContent = title;
  document.querySelector('#notice-detail').textContent = detail;
  notice.hidden = false;
}

function resize() {
  if (!renderer) return;
  const width = Math.max(viewport.clientWidth, 1);
  const height = Math.max(viewport.clientHeight, 1);
  renderer.setSize(width, height, false);
  perspectiveCamera.aspect = width / height;
  perspectiveCamera.updateProjectionMatrix();
  if (camera.isOrthographicCamera && model) {
    const halfHeight = (camera.top - camera.bottom) / 2;
    camera.left = -halfHeight * width / height; camera.right = halfHeight * width / height;
    camera.updateProjectionMatrix();
  }
  invalidate();
}

function initializeRenderer() {
  if (renderer) return;
  renderer = new THREE.WebGLRenderer({ antialias: true });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  renderer.setClearColor(0xedf0e9);
  // Renderer convention (see AGENTS.md): sRGB output, no tone mapping, physically based light units, no shadows.
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.NoToneMapping;
  const canvas = renderer.domElement;
  canvas.tabIndex = 0;
  canvas.setAttribute('aria-label', '3D design. Drag to orbit. Drag with the middle mouse button or use arrow keys to pan.');
  viewport.prepend(canvas);
  floorPicker = enableFloorPicking(canvas, {
    getHouse: () => canPickFloor() ? model : null,
    getCamera: () => camera,
    onHover: showFloorHover,
    onFloor: id => changeFloorFocus(id),
  });
  wallPanel = createWallPanel({
    getWallRoom: project.getWallRoom,
    canvas, viewport, getCamera: () => camera, canNavigate: () => canSteer && !canPickFloor() && !floorFocus?.transitioning,
    openRoom: roomId => changeScope('room/' + roomId), invalidate,
  });
  controls = new OrbitControls(camera, canvas);
  controls.mouseButtons.MIDDLE = THREE.MOUSE.PAN;
  controls.listenToKeyEvents(canvas);
  controls.enabled = canSteer;
  controls.addEventListener('change', () => { floorPicker.clear(); updateClipping(); invalidate(); if (!applyingRemote) collaboration?.publish(); });
  canvas.addEventListener('webglcontextrestored', () => {
    disposeRendererResources(renderer);
    clearFloorCache();
    modelKey = undefined;
    showScope();
  });

  // Base lighting belongs to the viewer. Builders add only lights that stand for real fixtures.
  const base = new THREE.Group();
  base.name = 'viewer-lighting';
  base.add(new THREE.HemisphereLight(0xffffff, 0x9b9b90, 1.8));
  const sunlight = new THREE.DirectionalLight(0xfff7e9, 2.2);
  sunlight.position.set(4, 8, 6);
  base.add(sunlight);
  scene.add(base);
  resize();
}

function updateClipping() {
  if (!bounds) return;
  const radius = Math.max(bounds.radius, 0.01);
  const depth = -camera.worldToLocal(centerInView.copy(bounds.center)).z;
  camera.near = Math.max(radius / 10000, depth - 1.2 * radius);
  camera.far = Math.max(camera.near + radius, depth + 1.2 * radius);
  camera.updateProjectionMatrix();
}

function applyWallCutaway() {
  const isPlan = viewSelect.value === 'plan';
  wallCutaway.disabled = isPlan || !canSteer;
  if (!model || floorFocus?.transitioning) return;
  if (floorFocus?.hoveredId) floorPicker.clear();
  if (isPlan || wallCutaway.checked) {
    wallTransparency ??= createWallTransparency(focusedGroup() ?? model);
  } else {
    wallTransparency?.dispose();
    wallTransparency = undefined;
  }
  invalidate();
}

function fitView() {
  if (!bounds || !controls) return;
  applyWallCutaway();
  const isPlan = viewSelect.value === 'plan';
  camera = isPlan ? planCamera : perspectiveCamera;
  controls.object = camera;
  const aspect = Math.max(viewport.clientWidth, 1) / Math.max(viewport.clientHeight, 1);
  const radius = Math.max(bounds.radius, 0.01);
  const verticalHalfAngle = THREE.MathUtils.degToRad(perspectiveCamera.fov) / 2;
  const horizontalHalfAngle = Math.atan(Math.tan(verticalHalfAngle) * aspect);
  const distance = 1.1 * radius / Math.sin(Math.min(verticalHalfAngle, horizontalHalfAngle));

  controls.target.copy(bounds.center);
  camera.up.set(0, isPlan ? 0 : 1, isPlan ? -1 : 0);
  if (isPlan) {
    const size = new THREE.Box3().setFromObject(model).getSize(new THREE.Vector3());
    const halfHeight = Math.max(size.z / 2, size.x / (2 * aspect)) * 1.12;
    camera.left = -halfHeight * aspect; camera.right = halfHeight * aspect;
    camera.top = halfHeight; camera.bottom = -halfHeight; camera.zoom = 1;
    camera.position.copy(bounds.center).add(new THREE.Vector3(0, radius * 3, 0.00001));
    camera.updateProjectionMatrix();
  } else {
    camera.aspect = aspect;
    camera.position.copy(bounds.center).addScaledVector(initialDirection, distance);
  }
  controls.enableRotate = !isPlan;
  controls.mouseButtons.LEFT = isPlan ? THREE.MOUSE.PAN : THREE.MOUSE.ROTATE;
  controls.touches.ONE = isPlan ? THREE.TOUCH.PAN : THREE.TOUCH.ROTATE;
  renderer.domElement.setAttribute('aria-label', isPlan ? 'Floor plan, south up. Drag or use arrow keys to pan.' : '3D design. Drag to orbit. Drag with the middle mouse button or use arrow keys to pan.');
  controls.minDistance = radius / 1000;
  controls.maxDistance = distance * 100;
  controls.update();
  updateClipping();
  invalidate();
}

function showWarnings(messages) {
  warningList.replaceChildren(...messages.map((text) => Object.assign(document.createElement('li'), { textContent: text })));
  applyNotesVisibility();
}

function applyNotesVisibility() {
  const count = warningList.childElementCount;
  document.querySelector('#note-count').textContent = String(count);
  showNotes.disabled = count === 0;
  warningList.hidden = !showNotes.checked || count === 0;
}

function collectWarnings(group) {
  const messages = [];
  group.traverse((object) => { if (Array.isArray(object.userData.warnings)) messages.push(...object.userData.warnings); });
  return [...new Set(messages)];
}

function showReviewWarnings(group, warning) {
  const messages = collectWarnings(group);
  if (warning) messages.push(warning);
  layoutWarning = warning;
  showWarnings(messages);
}

function applyFixtureLights() {
  model?.traverse((object) => { if (object.isLight) object.visible = fixtureLights.checked; });
  invalidate();
}

function stepRemoteCamera(time) {
  if (!controls || !remoteCamera.active) return false;
  const aspect = Math.max(viewport.clientWidth, 1) / Math.max(viewport.clientHeight, 1);
  const previous = applyingRemote;
  applyingRemote = true;
  try { return remoteCamera.step(camera, controls, aspect, time); }
  finally { applyingRemote = previous; }
}

function renderFrame(time) {
  if (!renderer || !model) return;
  const delta = lastFrame ? (time - lastFrame) / 1000 : 0;
  lastFrame = time;
  const cameraMoving = stepRemoteCamera(time);
  // Model hooks and viewer-owned wall transitions run before the displayed frame.
  for (const object of frameHooks) object.userData.onFrame({ camera, renderer, scene, delta, object, invalidate });
  const fading = !floorFocus?.hoveredId && wallTransparency?.update({ camera, target: controls.target, delta: delta > 0.1 ? 1 / 60 : delta, plan: viewSelect.value === 'plan' });
  const wasMoving = floorFocus?.transitioning;
  // The renderer sleeps when idle. Start the transition clock with its first
  // displayed frame, and keep intermediate frames visible on slower devices.
  const floorDelta = floorFrameTime == null ? 0 : Math.min((time - floorFrameTime) / 1000, 0.08);
  const floorMoving = wasMoving && floorFocus.update(floorDelta);
  floorFrameTime = floorMoving ? time : undefined;
  if (wasMoving && !floorMoving) {
    applyWallCutaway();
    updateFloorNavigation();
  }
  renderer.render(scene, camera);
  wallPanel.update();
  collaboration?.render();
  if (animated || fading || cameraMoving || floorMoving) invalidate();
}

function updateConditionLegend(condition, drawing) {
  const captions = {
    existing: drawing ? 'Existing conditions · draft plan' : 'Before renovation',
    demolition: drawing ? 'Red dashes mark planned removals · draft plan' : 'Red marks planned removals',
    proposed: 'Blue marks new work · draft plan',
  };
  const caption = captions[condition] ?? '';
  conditionLegend.textContent = caption;
  conditionLegend.hidden = !caption;
  if (condition === 'demolition') conditionLegend.dataset.color = 'red';
  else if (condition === 'proposed' && drawing) conditionLegend.dataset.color = 'blue';
  else delete conditionLegend.dataset.color;
}

async function updateOptions(scopeId, request) {
  if (renovation.condition === 'existing') {
    acceptedPhoto = null;
    optionSelect.replaceChildren();
    optionSelect.hidden = optionLabel.hidden = acceptedRender.hidden = true;
    return '';
  }
  const design = renovation.condition === 'design';
  const options = (await catalog.optionsFor(scopeId)).filter(option => design || option.id !== 'existing-measured');
  const target = await catalog.acceptedTargetFor?.(scopeId);
  if (request !== requestNumber) return;
  const requested = new URL(location.href).searchParams.get('option');
  const fallback = target?.option_id ?? '';
  const comparison = target?.sole_design ? [] : [new Option(target && design ? 'Previous design (comparison)' : 'Default', '')];
  optionSelect.replaceChildren(...comparison, ...options.map(({ id, label }) => new Option(label, id)));
  optionSelect.hidden = optionLabel.hidden = target?.sole_design ? options.length <= 1 : options.length === 0;
  optionSelect.value = target?.sole_design ? fallback : requested === '' ? '' : options.some((o) => o.id === requested) ? requested : fallback;
  acceptedPhoto = design && target?.renderUrl && optionSelect.value === target.option_id ? target : null;
  acceptedRender.hidden = !acceptedPhoto;
  if (acceptedPhoto) {
    acceptedRender.href = acceptedPhoto.renderUrl;
    acceptedRender.textContent = project.acceptedRenderLabel ?? 'Accepted render';
  }
  return optionSelect.value;
}

function releaseModel(group) {
  const resources = new Set();
  group.traverse((object) => {
    object.userData.onDispose?.();
    if (object.geometry) resources.add(object.geometry);
    const materials = Array.isArray(object.material) ? object.material : [object.material];
    for (const material of materials) {
      if (!material) continue;
      resources.add(material);
      for (const value of Object.values(material)) {
        if (value?.isTexture && value.userData.disposeWithModel !== false) resources.add(value);
      }
    }
  });
  for (const resource of resources) resource.dispose();
}

function clearFloorCache() {
  for (const { group } of floorCache.values()) releaseModel(group);
  floorCache.clear();
}

function clearView({ nextScope } = {}) {
  floorPicker?.clear();
  wallTransparency?.dispose();
  wallTransparency = undefined;
  floorFocus?.dispose();
  floorFocus = undefined;
  backToHouse.hidden = floorHint.hidden = true;
  wallPanel?.setModel(null);
  editor.detach();
  frames.cancel();
  remoteCamera.clear();
  if (renderer) {
    renderer.domElement.hidden = true;
  }
  if (model) {
    scene.remove(model);
    if (nextScope?.startsWith('level/') && displayedScope?.startsWith('level/') && nextScope !== displayedScope && modelKey) {
      // Keep only one option per floor, and at most two inactive floors. No inactive hooks run.
      if (floorCache.has(displayedScope)) releaseModel(floorCache.get(displayedScope).group);
      floorCache.set(displayedScope, { key: modelKey, group: model });
    } else releaseModel(model);
    model = undefined;
  }
  if (!nextScope?.startsWith('level/')) clearFloorCache();
  bounds = undefined;
  modelKey = undefined;
  collaboration?.render();
  displayedScope = undefined;
  frameHooks = [];
  animated = false;
  showWarnings([]);
  fitButton.disabled = true;
  navigation.hidden = true;
}

async function showScope() {
  const request = ++requestNumber;
  const url = new URL(location.href);
  const params = url.searchParams;
  const route = scopeFromUrl(params);
  const isAsset = route.startsWith('asset/');
  renovation = renovationView(params, hasDrawings);
  if (isAsset) renovation = { condition: 'design', drawing: null, compare: null };
  if (params.has('condition') || params.has('drawings') || params.has('compare')) {
    const original = url.href;
    if (renovation.drawing && params.has('condition') && params.has('assembly') && !params.has('sheetLayout')) {
      params.set('sheetLayout', params.get('assembly'));
    }
    if (params.get('condition') === 'proposed' && params.get('option') === 'existing-measured') params.delete('option');
    writeRenovationView(params, renovation);
    if (url.href !== original) history.replaceState(history.state, '', url);
  }
  const { condition, drawing } = renovation;
  const floorDrawing = drawing && route === 'house' && catalog.scopes.some(scope => scope.id === 'level/' + params.get('floor'));
  const id = floorDrawing ? 'level/' + params.get('floor') : route;
  updateReviewControls(isAsset);
  const previousCutaway = wallCutaway.checked;
  wallCutaway.checked = params.get('cutaway') !== 'off';
  viewSelect.value = drawing || params.get('view') === 'plan' ? 'plan' : 'perspective';
  viewSelect.hidden = Boolean(drawing);
  viewSelect.disabled = !canSteer || Boolean(drawing);
  assemblySelect.value = drawing && id === 'house'
    ? (params.get('sheetLayout') === 'stacked' ? 'stacked' : 'compare')
    : (params.get('assembly') === 'compare' ? 'compare' : 'stacked');
  assemblySelect.hidden = assemblyLabel.hidden = !hasMultipleLevels || id !== 'house';
  const scope = catalog.scopes.find((entry) => entry.id === id);
  const existing = condition === 'existing';
  const assembly = id === 'house' ? assemblySelect.value : '';
  const view = viewSelect.value;
  const key = JSON.stringify([id, existing ? '' : params.get('option'), assembly, condition, drawing]);
  const frame = JSON.stringify([id, assembly, view, Boolean(drawing)]);
  if (drawing && cameraFrame && !viewingDrawing && controls && model) {
    modelCamera = { frame: cameraFrame, position: camera.position.clone(), target: controls.target.clone(),
      zoom: camera.zoom, halfHeight: camera.isOrthographicCamera ? camera.top : null };
  }
  viewingDrawing = Boolean(drawing);
  const keepCamera = cameraFrame === frame;
  let layouts;
  if (model && modelKey === key) {
    applyFloorSelection(params.get('floor'), view === 'plan');
    if (keepCamera) {
      if (previousCutaway !== wallCutaway.checked) applyWallCutaway();
    } else fitReviewView(frame);
    cameraFrame = frame;
    updateFloorNavigation();
    if (isAsset || existing) return;
    layouts = await editor.refreshLayouts();
    if (request !== requestNumber) return;
    if (!layouts.changed) {
      if (layoutWarning !== layouts.warning) showReviewWarnings(model, layouts.warning);
      return;
    }
  }
  gallery.clear(id);
  acceptedRender.hidden = true;
  acceptedRender.removeAttribute('href');
  clearView({ nextScope: id });
  conditionLegend.hidden = true;
  scopeSelect.value = id;
  document.querySelector('#current-scope').textContent = scope?.label ?? 'Unknown scope';
  document.title = scope ? `${scope.label} · Renovation preview` : 'Renovation preview';
  if (!scope) {
    showNotice('Scope not found', `Choose an available scope to continue. The requested scope was “${id}”.`);
    return;
  }
  showNotice(`Loading ${scope.label}…`);
  try {
    layouts ??= isAsset || existing ? {} : await editor.refreshLayouts();
    if (request !== requestNumber) return;
    if (layouts.changed) clearFloorCache();
    const option = await updateOptions(id, request);
    if (request !== requestNumber) return;
    void gallery.load(() => catalog.previewsFor(id, { option, condition }));
    const cached = floorCache.get(id);
    if (cached) floorCache.delete(id);
    if (cached && cached.key !== key) releaseModel(cached.group);
    // Take the destination first: in A → B → C → A, A must not be evicted as C leaves the scene.
    while (floorCache.size > 2) {
      const oldest = floorCache.keys().next().value;
      releaseModel(floorCache.get(oldest).group);
      floorCache.delete(oldest);
    }
    const group = cached?.key === key ? cached.group : await catalog.build(id, THREE, {
      option, assembly: assemblySelect.value, condition,
      view: drawing || condition === 'design' ? view : 'perspective',
    });
    if (request !== requestNumber) {
      if (group !== model) releaseModel(group);
      return;
    }
    model = group;
    showReviewWarnings(group, layouts.warning);
    const box = new THREE.Box3().setFromObject(group);
    if (box.isEmpty()) {
      showNotice('No model geometry yet', 'Add geometry to a level or room builder to see it here. The repository README has the starter steps.');
      return;
    }
    initializeRenderer();
    bounds = box.getBoundingSphere(new THREE.Sphere());
    scene.add(group);
    group.traverse(object => object.userData.onActivate?.());
    group.traverse((object) => {
      if (typeof object.userData.onFrame === 'function') frameHooks.push(object);
      if (object.userData.animate) animated = true;
    });
    wallPanel.setModel(renovation.condition === 'design' ? group : null, renovation.condition === 'design' ? id : '', option);
    applyFixtureLights();
    displayedScope = id;
    if (id === 'house' && group.children.filter(child => child.userData.levelId).length > 1) {
      floorFocus = createFloorFocus({ THREE, root: group, invalidate,
        reducedMotion: () => Boolean(window.matchMedia?.('(prefers-reduced-motion: reduce)').matches) });
    }
    if (keepCamera) {
      applyWallCutaway();
      updateClipping();
    } else fitReviewView(frame);
    cameraFrame = frame;
    updateConditionLegend(condition, drawing);
    renderer.domElement.hidden = false;
    notice.hidden = true;
    navigation.hidden = false;
    fitButton.disabled = false;
    collaboration?.viewerReady?.();
    lastFrame = 0;
    modelKey = key;
    editor.attach(renovation.condition === 'design' && option !== 'existing-measured' ? id : '', group, renderer.domElement);
    applyFloorSelection(params.get('floor'), true);
    updateFloorNavigation();
    invalidate();
  } catch (error) {
    if (request !== requestNumber) return;
    clearView();
    showNotice('Could not display this model', error.message ?? String(error));
  }
}

function canPickFloor() {
  return floorFocus && viewSelect.value === 'perspective' && !floorFocus.focusedId &&
    !floorFocus.transitioning && canSteer && !editing;
}

function floorName(id) {
  return id.replace(/-/g, ' ').replace(/^./, first => first.toUpperCase());
}

function focusedGroup() {
  const id = floorFocus?.focusedId;
  return id ? model.children.find(group => group.userData.levelId === id) : null;
}

function showFloorHover(id, event) {
  floorFocus?.hover(id);
  floorHint.textContent = id ? floorName(id) : 'Select a floor';
  floorHint.dataset.active = String(Boolean(id));
  if (id && event) {
    const box = viewport.getBoundingClientRect();
    const x = Math.max(0, Math.min(box.width - floorHint.offsetWidth - 20, event.clientX - box.left + 4));
    const y = Math.max(0, Math.min(box.height - floorHint.offsetHeight - 20, event.clientY - box.top + 8));
    floorHint.style.transform = 'translate(' + x + 'px, ' + y + 'px)';
  } else floorHint.style.transform = '';
  if (id) renderer.domElement.dataset.floorHover = id;
  else if (renderer) delete renderer.domElement.dataset.floorHover;
}

function updateFloorNavigation() {
  const plan = viewSelect.value === 'plan';
  let hint = plan ? 'Drag to pan · Scroll to zoom · South up' : 'Drag to orbit · Middle- or right-drag to pan · Scroll to zoom';
  if (floorFocus && !floorFocus.focusedId && !plan) hint += ' · Click a floor to isolate it';
  else if (renovation.condition === 'design' && (floorFocus?.focusedId || displayedScope?.startsWith('level/') || (displayedScope === 'house' && plan))) {
    hint += ' · Click a room name for wall references';
  }
  navigation.textContent = hint;
  floorHint.hidden = !canPickFloor();
  backToHouse.hidden = plan || !(floorFocus?.focusedId || displayedScope?.startsWith('level/'));
  backToHouse.disabled = !canSteer;
}

function applyFloorSelection(id, immediate = false) {
  if (!floorFocus) return false;
  const selected = viewSelect.value === 'perspective' && model.children.some(child => child.userData.levelId === id) ? id : null;
  if (selected === floorFocus.focusedId && !(immediate && floorFocus.transitioning)) return false;
  const fromHover = floorFocus.hoveredId;
  floorPicker.clear();
  // The cutaway controller caches world-space wall planes. Rebuild its index
  // only after the floor groups have reached their new positions.
  wallTransparency?.dispose();
  wallTransparency = undefined;
  floorFrameTime = undefined;
  floorFocus.focus(selected, { immediate, fromHover });
  assemblySelect.hidden = assemblyLabel.hidden = !hasMultipleLevels || Boolean(selected);
  const scope = selected ? 'level/' + selected : 'house';
  const group = focusedGroup() ?? model;
  acceptedRender.hidden = !acceptedPhoto || Boolean(selected && !group.getObjectByName(acceptedPhoto.room_id));
  const option = optionSelect.value, condition = renovation.condition;
  wallPanel.setModel(condition === 'design' ? group : null, scope, option);
  editor.attach(condition === 'design' && option !== 'existing-measured' ? scope : '', group, renderer.domElement);
  const label = selected ? floorName(selected) : 'Whole house';
  document.querySelector('#current-scope').textContent = label;
  document.title = label + ' · Renovation preview';
  gallery.clear(scope);
  void gallery.load(() => catalog.previewsFor(scope, { option, condition }));
  if (!floorFocus.transitioning) applyWallCutaway();
  updateFloorNavigation();
  invalidate();
  return true;
}

function changeFloorFocus(id) {
  return collaboration.runAction(() => {
    if (!floorFocus || viewSelect.value !== 'perspective') return;
    const url = new URL(location.href);
    if (id) url.searchParams.set('floor', id); else url.searchParams.delete('floor');
    history.pushState(null, '', url);
    applyFloorSelection(id);
  });
}

backToHouse.addEventListener('click', () => {
  if (floorFocus?.focusedId) changeFloorFocus(null);
  else changeScope('house');
});

function changeScope(scopeId) {
  return collaboration.runAction(async () => {
    const url = new URL(location.href); url.searchParams.set('scope', scopeId);
    url.searchParams.delete('floor');
    history.pushState(null, '', url); await showScope();
  });
}
scopeSelect.addEventListener('change', () => { changeScope(scopeSelect.value); });
optionSelect.addEventListener('change', () => {
  const value = optionSelect.value;
  collaboration.runAction(async () => {
    const url = new URL(location.href); url.searchParams.set('option', value);
    history.pushState(null, '', url); await showScope();
  });
});
wallCutaway.addEventListener('change', () => {
  const value = wallCutaway.checked;
  collaboration.runAction(() => {
    const url = new URL(location.href);
    if (value) url.searchParams.delete('cutaway'); else url.searchParams.set('cutaway', 'off');
    history.pushState(null, '', url); applyWallCutaway();
  });
});
fixtureLights.addEventListener('change', applyFixtureLights);
function updateReviewControls(isAsset) {
  const { drawing, compare } = renovation;
  showBefore.hidden = isAsset || Boolean(project.designHistoryUrl) || Boolean(drawing) || compare === 'before';
  openDrawings.hidden = isAsset || !hasDrawings || Boolean(drawing);
  phaseLabel.hidden = !drawing;
  if (drawing) drawingPhase.value = drawing;
  removalsLabel.hidden = isAsset || Boolean(drawing);
  showRemovals.checked = compare === 'removals';
  backToDesign.hidden = !drawing && !compare;
  for (const control of [showBefore, openDrawings, drawingPhase, showRemovals, backToDesign]) control.disabled = !canSteer;
}

function changeReview(next, scope) {
  if (!catalog || !canSteer) return;
  return collaboration.runAction(async () => {
    const url = new URL(location.href);
    if (scope && scope !== (floorFocus?.focusedId ? 'level/' + floorFocus.focusedId : scopeSelect.value)) {
      url.searchParams.set('scope', scope);
      url.searchParams.delete('floor');
    } else {
      url.searchParams.set('scope', scopeFromUrl(url.searchParams));
    }
    const galleryOpen = Boolean(previewPreference());
    writeRenovationView(url.searchParams, next);
    url.searchParams.delete('history');
    url.searchParams.delete('historyScope');
    url.searchParams.delete('previews');
    history.pushState(null, '', url);
    if (galleryOpen) gallery.restore(null);
    await showScope();
  });
}

showBefore.addEventListener('click', async () => {
  document.querySelector('#display').open = false;
  await changeReview({ compare: 'before' });
  if (!backToDesign.hidden) backToDesign.focus();
});
showRemovals.addEventListener('change', () => {
  document.querySelector('#display').open = false;
  document.querySelector('#display > summary').focus();
  void changeReview(showRemovals.checked ? { compare: 'removals' } : {});
});
openDrawings.addEventListener('click', async () => {
  await changeReview({ drawing: 'proposed' });
  if (!phaseLabel.hidden) drawingPhase.focus();
});
drawingPhase.addEventListener('change', () => changeReview({ drawing: drawingPhase.value }));
backToDesign.addEventListener('click', async () => {
  const fromDrawings = Boolean(renovation.drawing);
  await changeReview({});
  if (fromDrawings && !openDrawings.hidden) openDrawings.focus();
  else scopeSelect.focus();
});
document.addEventListener('turnkey:before-renovation', event => {
  if (!catalog || !canSteer) return;
  const scope = event.detail?.scope;
  if (scope && !catalog.scopes.some(entry => entry.id === scope)) return;
  event.preventDefault();
  void changeReview({ compare: 'before' }, scope);
});
showNotes.addEventListener('change', applyNotesVisibility);
viewSelect.addEventListener('change', () => {
  const value = viewSelect.value;
  collaboration.runAction(async () => {
    const url = new URL(location.href); url.searchParams.set('scope', scopeSelect.value);
    url.searchParams.set('view', value);
    if (value === 'plan') url.searchParams.delete('floor');
    history.pushState(null, '', url);
    floorPicker?.clear();
    await showScope();
  });
});
assemblySelect.addEventListener('change', () => {
  const value = assemblySelect.value;
  collaboration.runAction(async () => {
    const url = new URL(location.href); url.searchParams.set(renovation.drawing ? 'sheetLayout' : 'assembly', value);
    history.pushState(null, '', url); await showScope();
  });
});
fitButton.addEventListener('click', () => collaboration.runAction(() => fitView()));
function syncFullscreenButton() {
  const active = document.fullscreenElement === fullscreenTarget;
  fullscreenButton.hidden = !document.fullscreenEnabled;
  fullscreenButton.setAttribute('aria-label', active ? 'Exit full screen' : 'Enter full screen');
  fullscreenButton.title = active ? 'Exit full screen (Esc)' : 'Enter full screen';
  fullscreenButton.setAttribute('aria-pressed', String(active));
}
fullscreenButton.addEventListener('click', async () => {
  try {
    if (document.fullscreenElement === fullscreenTarget) await document.exitFullscreen();
    else await fullscreenTarget.requestFullscreen();
  } catch (error) {
    console.warn('Could not change full screen mode:', error);
    fullscreenButton.title = 'Full screen unavailable. Click to try again.';
  }
});
document.addEventListener('fullscreenchange', syncFullscreenButton);
syncFullscreenButton();
// Shared view uses URL-backed design choices plus a camera pose in world metres.
const raycaster = new THREE.Raycaster();
try {
  const saved = project.sharedDesigns && await openDesign(new URL(location.href).searchParams);
  if (saved) {
    const [{ createDesignSession }, { designEditor }] = await Promise.all([
      import('./design-session.mjs'), import('./design-editor.mjs'),
    ]);
    sharedDesignWritable = saved.writable;
    designSession = createDesignSession({ ...saved, getHeaders: getDesignHeaders });
    await selectDesignGeometry(designSession.getState().snapshot.geometryRevision);
    editor = designEditor({ ...editorOptions, session: designSession, writable: saved.writable,
      authRequired: saved.authRequired, historical: saved.historical,
      getHeaders: getDesignHeaders, onSnapshotChange: clearFloorCache });
  } else {
    editor = furnitureEditor(editorOptions);
  }
} catch (error) {
  designBootstrapError = error;
}
collaboration = setupCollaboration({
  getDesignSession: () => sharedDesignWritable && !new URL(location.href).searchParams.has('designVersion')
    ? designSession : undefined,
  stunUrl: project.stunUrl?.(location.hostname),
  getView() {
    const params = new URL(location.href).searchParams;
    return { scope: scopeFromUrl(params), floor: renovation.drawing ? params.get('floor') : floorFocus?.focusedId ?? null,
      option: params.get('option'),
      view: viewSelect.value, assembly: assemblySelect.value, condition: renovation.condition,
      modelView: params.get('view') === 'plan' ? 'plan' : 'perspective', modelAssembly: params.get('assembly') ?? 'stacked',
      drawing: renovation.drawing, compare: renovation.compare,
      cutaway: wallCutaway.checked, position: camera.position.toArray(), target: controls?.target.toArray(),
      zoom: camera.zoom, planHeight: planCamera.top - planCamera.bottom };
  },
  async applyView(view, isCurrent = () => true, { animate = false } = {}) {
    if (!view || !catalog || !catalog.scopes.some(scope => scope.id === view.scope)) return;
    applyingRemote = true;
    try {
      const url = new URL(location.href);
      url.searchParams.set('scope', view.scope);
      if (view.scope === 'house' && (view.view !== 'plan' || view.drawing) && typeof view.floor === 'string') url.searchParams.set('floor', view.floor);
      else url.searchParams.delete('floor');
      if (view.option == null) url.searchParams.delete('option'); else url.searchParams.set('option', view.option);
      const isAsset = view.scope.startsWith('asset/');
      for (const key of ['view', 'assembly']) if (typeof view[key] === 'string') url.searchParams.set(key, view[key]);
      if (view.modelView && view.drawing) url.searchParams.set('view', view.modelView);
      const legacy = new URLSearchParams({ view: view.view, condition: view.condition });
      const next = 'drawing' in view || 'compare' in view ? view : renovationView(legacy, hasDrawings);
      writeRenovationView(url.searchParams, isAsset ? {} : next);
      if (!isAsset && next.drawing) {
        url.searchParams.set('sheetLayout', view.assembly === 'stacked' ? 'stacked' : 'compare');
        url.searchParams.set('assembly', view.modelAssembly === 'compare' ? 'compare' : 'stacked');
      }
      if (view.cutaway === false) url.searchParams.set('cutaway', 'off'); else url.searchParams.delete('cutaway');
      const previous = new URL(location.href);
      const sameDesign = ['scope', 'floor', 'option', 'view', 'assembly', 'condition', 'drawings', 'compare', 'sheetLayout', 'cutaway'].every(key => previous.searchParams.get(key) === url.searchParams.get(key));
      if (!sameDesign) {
        remoteCamera.clear();
        history.replaceState(null, '', url);
        await showScope();
      }
      else {
        scopeSelect.value = view.scope;
        if (view.option != null) optionSelect.value = view.option;
        viewSelect.value = view.view; assemblySelect.value = view.assembly;
        wallCutaway.checked = view.cutaway !== false;
      }
      if (!isCurrent()) return;
      if (!controls || !Array.isArray(view.position) || !Array.isArray(view.target) ||
          view.position.length !== 3 || view.target.length !== 3 ||
          ![...view.position, ...view.target].every(Number.isFinite)) return;
      remoteCamera.set(view, performance.now());
      if (!animate || !sameDesign || window.matchMedia?.('(prefers-reduced-motion: reduce)').matches) {
        stepRemoteCamera(Infinity);
      }
      invalidate();
    } finally { applyingRemote = false; }
  },
  finishCameraMotion() { stepRemoteCamera(Infinity); },
  setSteering(enabled) {
    canSteer = enabled;
    if (!enabled) floorPicker?.clear();
    updateFloorNavigation();
    if (controls) controls.enabled = enabled;
    updateReviewControls(scopeSelect.value?.startsWith('asset/'));
    for (const element of [scopeSelect, optionSelect, viewSelect, assemblySelect, wallCutaway, fitButton]) element.disabled = !enabled;
    if (enabled && model) {
      fitButton.disabled = false;
      wallCutaway.disabled = viewSelect.value === 'plan';
      viewSelect.disabled = Boolean(renovation.drawing);
    }
  },
  getCursorSpace() { return floorFocus?.focusedId ? modelKey + '/' + floorFocus.focusedId : modelKey; },
  getWorldCursor(event) {
    if (!model || !renderer || floorFocus?.transitioning) return null;
    const rect = renderer.domElement.getBoundingClientRect();
    raycaster.setFromCamera(new THREE.Vector2((event.clientX - rect.left) / rect.width * 2 - 1, -(event.clientY - rect.top) / rect.height * 2 + 1), camera);
    const hit = raycaster.intersectObject(focusedGroup() ?? model, true).find(item => item.object.visible);
    return hit ? hit.point.toArray() : null;
  },
  projectWorld(world) {
    if (!Array.isArray(world) || world.length !== 3 || !world.every(Number.isFinite)) return null;
    const point = new THREE.Vector3().fromArray(world).project(camera);
    return point.z >= -1 && point.z <= 1 ? { x: (point.x + 1) / 2, y: (1 - point.y) / 2 } : null;
  },
});
// For scripted matched screenshots: set window.__preview.camera / controls, then call controls.update().
window.__preview = { scene, invalidate, get camera() { return camera; }, get controls() { return controls; }, get model() { return model; } };
window.addEventListener('popstate', () => {
  gallery.restore(previewPreference());
  if (catalog) collaboration.runAction(() => showScope());
});
new ResizeObserver(resize).observe(viewport);

try {
  if (designBootstrapError) throw designBootstrapError;
  catalog = await loadCatalog();
  gallery.setLibrary(catalog.allPreviews());
  const floors = catalog.scopes.filter(({ id }) => id.startsWith('level/'));
  hasMultipleLevels = floors.length > 1;
  defaultPlanScope = floors.find(({ id }) => id === project.defaultPlanScope)?.id ?? floors[0]?.id ?? 'house';
  const menu = [];
  const groups = new Map();
  for (const { id, label, menuGroup } of catalog.scopes) {
    const option = new Option(label, id);
    if (!menuGroup) {
      menu.push(option);
      continue;
    }
    if (!groups.has(menuGroup)) {
      const group = document.createElement('optgroup');
      group.label = menuGroup;
      groups.set(menuGroup, group);
      menu.push(group);
    }
    groups.get(menuGroup).append(option);
  }
  scopeSelect.replaceChildren(...menu);
  scopeSelect.disabled = false;
  await showScope();
} catch (error) {
  showNotice('Could not load the design catalog', error.message ?? String(error));
}
