import { createWallInspector } from './wall-inspector.mjs';

const el = id => document.getElementById(id);
const ns = 'http://www.w3.org/2000/svg';
const mm = n => Number(n.toFixed(1));
const span = w => Math.hypot(w.endMm[0] - w.startMm[0], w.endMm[1] - w.startMm[1]);

/** A copy describes the inside face even when there is no fixture point. */
export function formatWallReference(room, wall, point, option, revision) {
  const lines = [
    `${room.levelId} / ${room.id} / ${wall.id}${wall.alias ? ' (wall ' + wall.alias + ')' : ''} · ${wall.featureId}`,
    `Inside face, room-local mm: start XY (${wall.startMm.map(mm).join(', ')}), end XY (${wall.endMm.map(mm).join(', ')}).`,
  ];
  if (point) lines.push(`Point: ${mm(point.alongMm)} mm from the left facing the wall, ${mm(point.heightMm)} mm above finished floor. Room XYZ (mm): (${[point.xMm, point.yMm, point.heightMm].map(mm).join(', ')}).`);
  lines.push(`Design option: ${option || 'default'} · model ${revision.slice(0, 12)}`);
  return lines.join('\n');
}

export function createWallPanel({ getWallRoom, canvas, viewport, getCamera, openRoom, canNavigate, invalidate }) {
  const panel = el('wall-panel'), toggle = el('toggle-wall-references'), close = el('close-wall-panel');
  const choice = el('wall-choice'), detail = el('wall-detail'), intro = el('wall-intro');
  const elevation = el('wall-elevation'), along = el('wall-along'), height = el('wall-height');
  const reading = el('wall-reading'), copy = el('copy-wall-reference'), clear = el('clear-wall-point');
  const status = el('wall-status'), fallback = el('wall-copy-fallback');
  let room, wall, point, option, lastRoomId, editing = false, showLabels = true, marker;
  const inspector = createWallInspector({
    canvas, viewport, getCamera,
    isInteractive: () => !editing && canNavigate(),
    onRoom: id => { if (!editing && canNavigate()) { showLabels = true; openRoom(id); } },
    onWall: selectWall,
    onPoint: picked => displayPoint(picked),
    onMiss: reason => {
      inspector.setPoint(null);
      displayPoint(null);
      status.textContent = reason === 'plan' ? 'Use the elevation or enter a height in Plan view.'
        : reason === 'opening' ? 'That point is in an opening. Choose a solid part of the wall.'
        : 'Choose a point on the selected wall or its elevation.';
    },
  });

  function svgElement(tag, attributes) {
    const node = document.createElementNS(ns, tag);
    for (const [key, value] of Object.entries(attributes)) node.setAttribute(key, value);
    return node;
  }

  function drawElevation() {
    const length = span(wall);
    elevation.setAttribute('viewBox', `0 0 ${length} ${wall.heightMm}`);
    elevation.setAttribute('aria-label', `${wall.id}, looking at the wall from inside the room; openings are hatched`);
    // A nested SVG pattern keeps the hatching legible on both short and long walls.
    const defs = svgElement('defs', {});
    const size = Math.max(length / 34, wall.heightMm / 20);
    const pattern = svgElement('pattern', { id: 'wall-opening-hatch', patternUnits: 'userSpaceOnUse', width: size, height: size });
    pattern.append(svgElement('path', { d: `M0 ${size} L${size} 0`, stroke: '#89998d', 'stroke-width': size / 10 }));
    defs.append(pattern);
    const face = svgElement('rect', { x: 0, y: 0, width: length, height: wall.heightMm, class: 'elevation-face' });
    const holes = wall.openings.map(o => svgElement('rect', { x: o.fromMm, y: wall.heightMm - o.topMm,
      width: o.toMm - o.fromMm, height: o.topMm - o.bottomMm, fill: 'url(#wall-opening-hatch)', class: 'elevation-opening' }));
    marker = svgElement('circle', { r: Math.max(length / 55, wall.heightMm / 24), class: 'elevation-point', visibility: 'hidden' });
    elevation.replaceChildren(defs, face, ...holes, marker);
  }

  function displayPoint(next, { updateFields = true } = {}) {
    point = next;
    fallback.hidden = true;
    status.textContent = '';
    if (updateFields) {
      along.value = point ? mm(point.alongMm) : '';
      height.value = point ? mm(point.heightMm) : '';
    }
    if (!wall) return;
    marker.setAttribute('visibility', point ? 'visible' : 'hidden');
    if (point) {
      marker.setAttribute('cx', point.alongMm);
      marker.setAttribute('cy', wall.heightMm - point.heightMm);
    }
    reading.textContent = point ? `Room XYZ · ${[point.xMm, point.yMm, point.heightMm].map(mm).join(', ')} mm`
      : `Model face · ${mm(span(wall))} mm wide × ${mm(wall.heightMm)} mm high`;
    copy.textContent = point ? 'Copy point reference' : 'Copy wall reference';
    copy.disabled = false;
    clear.hidden = !point;
    invalidate();
  }

  function selectWall(id) {
    wall = room?.walls.find(item => item.id === id);
    choice.value = wall?.id ?? '';
    inspector.selectWall(wall?.id ?? null);
    intro.hidden = Boolean(wall);
    detail.hidden = !wall;
    if (wall) {
      along.max = span(wall); height.max = wall.heightMm;
      drawElevation();
    }
    displayPoint(null);
    invalidate();
  }

  function refresh() {
    const available = Boolean(room) && !editing;
    toggle.hidden = !available;
    panel.hidden = !available || !showLabels;
    toggle.setAttribute('aria-expanded', String(!panel.hidden));
    inspector.setRoom(panel.hidden ? null : room);
    selectWall(null);
    invalidate();
  }

  function applyPoint(x, z, typed = false) {
    if (typed && along.value === '' && height.value === '' && !along.validity.badInput && !height.validity.badInput) {
      inspector.setPoint(null); displayPoint(null); return;
    }
    const picked = Number.isFinite(x) && Number.isFinite(z) ? inspector.setPoint(x, z) : inspector.setPoint(null);
    displayPoint(picked, { updateFields: !typed });
    if (picked) return;
    if (Number.isFinite(x) && Number.isFinite(z)) {
      status.textContent = 'Outside the modeled face or inside an opening. Choose a solid part of the wall.';
    } else if (along.value || height.value) {
      status.textContent = 'Enter both distances to mark a point.';
    }
    // An unfinished or invalid edit must never copy the previous point.
    copy.disabled = true;
    clear.hidden = false;
  }

  function fromFields() {
    applyPoint(along.valueAsNumber, height.valueAsNumber, true);
  }
  along.addEventListener('input', fromFields);
  height.addEventListener('input', fromFields);
  elevation.addEventListener('click', event => {
    if (!wall) return;
    const matrix = elevation.getScreenCTM();
    if (!matrix) return;
    const p = new DOMPoint(event.clientX, event.clientY).matrixTransform(matrix.inverse());
    applyPoint(Math.round(p.x), Math.round(wall.heightMm - p.y));
  });
  choice.addEventListener('change', () => selectWall(choice.value));
  clear.addEventListener('click', () => { inspector.setPoint(null); displayPoint(null); });
  toggle.addEventListener('click', () => { showLabels = !showLabels; refresh(); });
  close.addEventListener('click', () => { showLabels = false; refresh(); toggle.focus(); });
  copy.addEventListener('click', async () => {
    if (!room || !wall || copy.disabled) return;
    const reference = formatWallReference(room, wall, point, option, __VIEWER_REVISION__);
    const selected = wall, selectedPoint = point;
    try {
      await navigator.clipboard.writeText(reference);
      if (wall === selected && point === selectedPoint) status.textContent = 'Reference copied.';
    } catch {
      if (wall !== selected || point !== selectedPoint) return;
      fallback.value = reference; fallback.hidden = false; fallback.select();
      status.textContent = 'Select and copy the reference below.';
    }
  });

  return {
    setModel(model, scope = '', designOption = '') {
      inspector.setModel(model);
      room = model && scope.startsWith('room/') ? getWallRoom?.(scope.slice(5), model.userData.wallRecesses) : null;
      option = model?.userData.designOption ?? designOption;
      if (model && room?.id !== lastRoomId) showLabels = true;
      if (model) lastRoomId = room?.id;
      if (room) {
        el('wall-room-name').textContent = room.name;
        choice.replaceChildren(new Option('Choose a wall…', ''), ...room.walls.map(w => new Option(
          w.alias ? `${w.id} · Wall ${w.alias}` : w.id, w.id)));
        choice.hidden = !room.walls.length;
        intro.textContent = room.walls.length ? 'Select a wall number to reference its finish or mark a fixture location.'
          : 'No wall faces are modeled for this space.';
      }
      refresh();
    },
    setEditing(value) { if (editing !== value) { editing = value; refresh(); } },
    update: inspector.update,
  };
}
