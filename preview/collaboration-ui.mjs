import { COLLABORATION_PROTOCOL_VERSION } from '../shared/collaboration-protocol.mjs';
import { createCollaboration } from './collaboration-transport.mjs';
import { cursorInSpace, cursorPosition } from './cursor-motion.mjs';

// The invitation secret stays in the URL fragment, so it is not sent with page requests.
export function setupCollaboration({ stunUrl, getView, applyView, setSteering, finishCameraMotion, getCursorSpace, getWorldCursor, projectWorld, getDesignSession }) {
  const panel = document.querySelector('#collaboration');
  const form = panel.querySelector('form');
  const name = panel.querySelector('#collab-name');
  const icon = panel.querySelector('#collab-icon');
  const status = panel.querySelector('#collab-status');
  const members = panel.querySelector('#collab-members');
  const steering = panel.querySelector('#collab-steering');
  const invite = panel.querySelector('#collab-invite');
  const copy = panel.querySelector('#collab-copy');
  const leave = panel.querySelector('#collab-leave');
  const scene = document.querySelector('#scene');
  const layer = document.querySelector('#collab-cursors');
  let session, state, credentials, pendingView, applyingView = false, gesture = false, actionCount = 0, acquireWaiters = [], connected = false, lastView, lastAppliedView, generation = 0, releasedEpoch = null, viewWaiters = [];
  const server = new URL(import.meta.env.VITE_COLLAB_SERVER || location.origin);
  const stun = import.meta.env.VITE_COLLAB_STUN_URL ?? stunUrl;
  const iceServers = stun ? [{ urls: stun }] : [];
  const signalingUrl = new URL('/api/rooms/ws', server); signalingUrl.protocol = server.protocol === 'https:' ? 'wss:' : 'ws:';
  const designLabel = document.createElement('label');
  const editDesign = document.createElement('input');
  editDesign.type = 'checkbox'; editDesign.id = 'collab-edit-design';
  designLabel.append(editDesign, ' Edit furniture together');
  designLabel.hidden = true;
  form.insertBefore(designLabel, form.querySelector('button'));
  const localDrafts = document.createElement('details');
  localDrafts.hidden = true;
  const recoveryTitle = document.createElement('summary'); recoveryTitle.textContent = 'Recover a local draft';
  const recovered = document.createElement('select'); recovered.setAttribute('aria-label', 'Local draft');
  const recover = document.createElement('button'); recover.type = 'button'; recover.textContent = 'Open a personal copy';
  localDrafts.append(recoveryTitle, recovered, recover);
  panel.querySelector('.collab-panel').append(localDrafts);
  async function listLocalDrafts() {
    design = await getDesignSession?.();
    const drafts = design?.recoverableDrafts() ?? [];
    localDrafts.hidden = liveDesign || !drafts.length;
    recovered.replaceChildren(...drafts.map(draft => new Option(
      (draft.shared ? 'Shared' : 'Personal') + ' · ' + draft.branch + ' · ' + draft.edits + ' edits · ' + new Date(draft.updatedAt).toLocaleString(), draft.source
    )));
  }
  recover.onclick = () => {
    try {
      design.recoverAsPersonal(recovered.value);
      status.textContent = 'Opened a personal recovery copy. You can save it on a new branch.';
    } catch (error) { status.textContent = error.message; }
  };
  panel.addEventListener('toggle', () => { if (panel.open) listLocalDrafts().catch(() => {}); });
  const cursors = new Map();
  let design, liveDesign;
  let cursorFrame = null;
  let lastCursorSent = -Infinity;
  let cursorTimer = null;
  let lastPointer = null;
  const fragment = new URLSearchParams(location.hash.slice(1));
  const incoming = fragment.has('room') && fragment.has('token')
    ? { room: fragment.get('room'), token: fragment.get('token') } : null;
  if (incoming && fragment.has('sessionId')) incoming.design = {
    projectId: fragment.get('projectId'), sessionId: fragment.get('sessionId'),
    branch: fragment.get('branch'), head: fragment.get('head')
  };
  const submit = panel.querySelector('#collab-submit');
  submit.textContent = incoming?.design ? 'Join shared design' : incoming ? 'Join review' : 'Start review';
  editDesign.onchange = () => { submit.textContent = editDesign.checked ? 'Start shared design' : 'Start review'; };
  function updateInvite(descriptor) {
    if (!credentials) return;
    const url = new URL(location.href);
    const parts = new URLSearchParams({ room: credentials.room, token: credentials.token });
    if (descriptor) {
      url.searchParams.delete('designVersion');
      url.searchParams.set('designBranch', descriptor.branch);
      for (const key of ['projectId','sessionId','branch','head']) parts.set(key, descriptor[key] ?? '');
    }
    url.hash = parts.toString(); invite.value = url.href;
  }
  if (incoming) panel.open = true;

  function reset() {
    finishCameraMotion();
    activePointers.clear();
    clearPendingPointer();
    cancelAnimationFrame(cursorFrame); cursorFrame = null;
    generation++;
    if (applyingView && lastAppliedView) void applyView(lastAppliedView, () => true);
    pendingView = undefined;
    connected = false; gesture = false; lastView = undefined; releasedEpoch = null; resolveWaiters(false);
    if (liveDesign) design?.disconnect();
    liveDesign = false;
    const old = session; session = undefined; old?.stop(); state = undefined; credentials = undefined;
    scene.classList.remove('remote-steering');
    cursors.clear(); layer.replaceChildren(); members.textContent = '';
    steering.textContent = '';
    form.hidden = false; invite.hidden = copy.hidden = leave.hidden = true;
    form.querySelector('button').disabled = false;
    setSteering(true);
    listLocalDrafts().catch(() => {});
  }
  function displayState(next) {
    const previous = state;
    state = next;
    if (liveDesign) {
      design.membership(next);
      if (next.design) updateInvite(next.design);
    }
    if (!next.peerId) {
      connected = false;
      activePointers.clear(); gesture = false;
      clearPendingPointer();
      finishCameraMotion();
    }
    const peers = next.peerId && !next.peers.some(p => p.id === next.peerId) ? [...next.peers, { id: next.peerId, name: name.value.trim(), icon: icon.value }] : next.peers;
    const holder = peers?.find(p => p.id === next.lease?.peerId);
    const mine = next.lease?.peerId === next.peerId;
    steering.textContent = next.peerId && holder ? holder.name + ' steering' : '';
    scene.classList.toggle('remote-steering', Boolean(next.peerId && next.lease && !mine));
    members.textContent = (peers ?? []).map(p => `${p.icon || '●'} ${p.name}${p.id === next.peerId ? ' (you)' : ''}`).join(' · ');
    if (liveDesign && next.peerId) status.textContent = 'Editing the shared furniture draft.';
    else if (next.peerId) status.textContent = mine ? 'You are steering the shared view.' : holder ? `${holder.name} is steering the shared view.` : 'View is free. Drag or use the controls to steer.';
    setSteering(liveDesign || Boolean(next.peerId) && (!next.lease || mine));
    if (mine && previous?.lease?.epoch !== next.lease.epoch) finishCameraMotion();
    if (mine && next.lease.epoch !== releasedEpoch) { releasedEpoch = null; resolveWaiters(true); }
    else if ((next.lease && !mine) || !next.peerId) resolveWaiters(false);
    if (mine && !gesture && !actionCount) releaseIfIdle();
    const present = new Set((peers ?? []).map(p => p.id));
    for (const [id, cursor] of cursors) {
      if (present.has(id)) cursor.element.classList.toggle('steering', id === next.lease?.peerId);
      else { cursor.element.remove(); cursors.delete(id); }
    }
  }
  function displayCursor(cursor, from) {
    const peer = state?.peers?.find(p => p.id === from);
    if (!peer || !cursor) return;
    let entry = cursors.get(from);
    if (!cursor.visible) {
      entry?.element.remove();
      cursors.delete(from);
      return;
    }
    if (!cursorInSpace(cursor, getCursorSpace())) return;
    if (!entry) {
      const element = document.createElement('span');
      element.className = 'collab-cursor';
      element.classList.toggle('steering', from === state.lease?.peerId);
      element.textContent = `${peer.icon || '●'} ${peer.name || 'Guest'}`;
      element.hidden = true;
      layer.append(element);
      entry = { element, cursor };
      cursors.set(from, entry);
    }
    entry.cursor = cursor;
    scheduleCursorFrame();
  }
  async function receiveView(view, from) {
    lastView = view;
    pendingView = { view, animate: Boolean(connected && from && state?.lease?.peerId === from) };
    if (applyingView) return;
    applyingView = true;
    try {
      while (pendingView) {
        const next = pendingView; pendingView = undefined;
        const current = generation;
        await applyView(next.view, () => current === generation, { animate: next.animate });
        if (current === generation) lastAppliedView = next.view;
      }
      if (state) setSteering(!state.lease || state.lease.peerId === state.peerId);
    } catch (error) { status.textContent = `Could not follow view: ${error.message}`; }
    finally { applyingView = false; for (const resolve of viewWaiters.splice(0)) resolve(); }
  }
  async function start(event) {
    event.preventDefault();
    lastAppliedView = getView();
    const displayName = name.value.trim();
    if (!displayName) { name.focus(); return; }
    if (session) { const old = session; session = undefined; old.stop(); }
    form.querySelector('button').disabled = true;
    status.textContent = 'Connecting…';
    try {
      credentials = incoming;
      design = await getDesignSession?.();
      if (incoming?.design && !design) throw new Error('The project design must be available to join this session.');
      liveDesign = Boolean(incoming?.design || (!incoming && design && editDesign.checked));
      const draft = liveDesign ? design.getState() : null;
      if (liveDesign && draft.projectId !== (incoming?.design?.projectId ?? draft.projectId)) throw new Error('Open the project identified by the invitation.');
      if (!credentials) {
        const headers = liveDesign ? design.getHeaders() : new Headers();
        headers.set('Content-Type', 'application/json');
        const response = await fetch(new URL('/api/rooms', server), { method: 'POST', headers, body: JSON.stringify({
          view: getView(), protocolVersion: COLLABORATION_PROTOCOL_VERSION, revision: __VIEWER_REVISION__,
          ...(liveDesign ? { design: { projectId: draft.projectId, branch: draft.branch, head: draft.head } } : {})
        }) });
        if (liveDesign && response.status === 401) throw new Error('Enter the owner editing key to start a shared design.');
        if (!response.ok) throw new Error(`Could not start a review (${response.status}).`);
        credentials = await response.json();
      }
      if (liveDesign && !credentials.design) throw new Error('This collaboration service needs a design-enabled room.');
      session = createCollaboration({ ...credentials, revision: __VIEWER_REVISION__, name: displayName, icon: icon.value, signalingUrl: signalingUrl.href, iceServers,
        onState: displayState, onSnapshot: (view, from) => { if (!liveDesign) return receiveView(view, from); },
        onDesign: (data, from) => design?.receive(data, from), onPreview: (instance, from) => design?.receivePreview(instance, from),
        onCursor: displayCursor, onStatus: result => {
          if (result.status === 'connected') {
            connected = true; lastView ??= getView(); form.hidden = true; invite.hidden = copy.hidden = leave.hidden = false;
            form.querySelector('button').disabled = false;
          } else if (result.status === 'error') {
            const message = result.message || 'Connection failed';
            if (result.fatal) { reset(); form.querySelector('button').disabled = false; }
            status.textContent = message;
          } else if (result.status !== 'disconnected') status.textContent = result.message || result.status;
        } });
      if (liveDesign) localDrafts.hidden = true;
      if (liveDesign) design.connect({
        ...credentials, send: (to, data) => session.sendDesign(to, data), sendPreview: instance => session.sendDesignPreview(instance),
        declareHead: (head, branch) => session.declareHead(head, branch)
      }, !incoming);
      leave.hidden = false;
      session.start(); updateInvite(credentials.design);

    } catch (error) { reset(); status.textContent = error.message || String(error); }
    finally { if (!session) form.querySelector('button').disabled = false; }
  }
  form.addEventListener('submit', start);
  leave.addEventListener('click', () => { reset(); status.textContent = 'You left the review.'; });
  copy.addEventListener('click', async () => { try { await navigator.clipboard.writeText(invite.value); status.textContent = 'Invitation link copied.'; } catch { invite.select(); status.textContent = 'Select and copy the invitation link.'; } });
  function clearPendingPointer() {
    clearTimeout(cursorTimer);
    cursorTimer = null;
    lastPointer = null;
    lastCursorSent = -Infinity;
  }
  function sendPointer() {
    cursorTimer = null;
    const pointer = lastPointer;
    if (!pointer || !state?.peerId) return;
    const rect = scene.getBoundingClientRect();
    const space = getCursorSpace();
    if (!cursorInSpace(pointer, space) || !rect.width || !rect.height) return;
    lastCursorSent = performance.now();
    session.sendCursor({
      x: (pointer.clientX - rect.left) / rect.width, y: (pointer.clientY - rect.top) / rect.height,
      world: getWorldCursor(pointer), visible: true, space,
    });
  }
  function schedulePointer() {
    if (!lastPointer || cursorTimer !== null || !state?.peerId || !state.peers.length) return;
    // OrbitControls handles drag movement on document, after the scene listener.
    // Even the leading sample must use the pose after the input event finishes.
    const wait = Math.max(0, 40 - (performance.now() - lastCursorSent));
    cursorTimer = setTimeout(sendPointer, wait);
  }
  scene.addEventListener('pointermove', event => {
    if (!state?.peerId || !state.peers.length) return;
    lastPointer = { clientX: event.clientX, clientY: event.clientY, space: getCursorSpace() };
    schedulePointer();
  });
  function hidePointer() {
    clearPendingPointer();
    if (state?.peerId) session.sendCursor({ visible: false });
  }
  scene.addEventListener('pointerleave', hidePointer);
  scene.addEventListener('pointercancel', hidePointer);
  document.addEventListener('visibilitychange', () => { if (document.hidden) hidePointer(); });
  window.addEventListener('pagehide', () => session?.stop());
  function scheduleCursorFrame() {
    if (cursorFrame !== null) return;
    cursorFrame = requestAnimationFrame(() => { cursorFrame = null; renderCursors(); });
  }
  function renderCursors() {
    if (!cursors.size) return;
    const width = layer.clientWidth, height = layer.clientHeight;
    const space = getCursorSpace();
    for (const [id, { element, cursor }] of cursors) {
      if (!cursorInSpace(cursor, space)) {
        element.remove();
        cursors.delete(id);
        continue;
      }
      const point = cursorPosition(cursor, projectWorld);
      element.hidden = !point || point.x < 0 || point.x > 1 || point.y < 0 || point.y > 1;
      if (!element.hidden) element.style.transform = `translate3d(${point.x * width + 4}px, ${point.y * height + 4}px, 0)`;
    }
  }
  function resolveWaiters(value) { for (const resolve of acquireWaiters.splice(0)) resolve(value); }
  async function acquire() {
    while (applyingView) await new Promise(resolve => viewWaiters.push(resolve));
    if (!session || liveDesign) return Promise.resolve(true);
    if (!connected || !state?.peerId || (state.lease && state.lease.peerId !== state.peerId)) return Promise.resolve(false);
    if (state.lease?.peerId === state.peerId && state.lease.epoch !== releasedEpoch) return Promise.resolve(true);
    return new Promise(resolve => {
      let timer;
      const done = value => { clearTimeout(timer); resolve(value); };
      const first = acquireWaiters.length === 0;
      acquireWaiters.push(done);
      timer = setTimeout(() => { acquireWaiters = acquireWaiters.filter(item => item !== done); done(false); }, 3000);
      if (first && !session.requestControl()) { acquireWaiters = acquireWaiters.filter(item => item !== done); done(false); }
    });
  }
  function releaseIfIdle() { if (!gesture && !actionCount && session && state?.peerId && state.lease?.peerId === state.peerId && state.lease.epoch !== releasedEpoch) { lastView = getView(); session.sendSnapshot(lastView); releasedEpoch = state.lease.epoch; session.releaseControl(); } }
  // Intercept the first input until the server grants control; a losing simultaneous
  // requester never moves locally. Replay the gesture only while the pointer is down.
  const activePointers = new Map();
  window.addEventListener('pointermove', event => {
    const down = activePointers.get(event.pointerId);
    if (down) { down.clientX = event.clientX; down.clientY = event.clientY; }
  }, { capture: true, passive: true });
  scene.addEventListener('pointerdown', event => {
    if (!session || liveDesign || !event.isTrusted || event.target.closest?.('button')) return;
    event.stopImmediatePropagation(); event.preventDefault();
    gesture = true;
    const target = event.target; target.focus?.({ preventScroll: true });
    const init = { bubbles: true, cancelable: true, pointerId: event.pointerId, pointerType: event.pointerType,
      isPrimary: event.isPrimary, button: event.button, buttons: event.buttons, clientX: event.clientX, clientY: event.clientY,
      ctrlKey: event.ctrlKey, shiftKey: event.shiftKey, altKey: event.altKey, metaKey: event.metaKey };
    activePointers.set(event.pointerId, init);
    acquire().then(granted => {
      if (activePointers.get(event.pointerId) !== init) return;
      if (granted) target.dispatchEvent(new PointerEvent('pointerdown', init));
      else { activePointers.delete(event.pointerId); gesture = activePointers.size > 0; releaseIfIdle(); }
    });
  }, true);
  const endGesture = event => { activePointers.delete(event.pointerId); gesture = activePointers.size > 0; releaseIfIdle(); };
  window.addEventListener('pointerup', endGesture);
  window.addEventListener('pointercancel', endGesture);
  window.addEventListener('blur', () => { activePointers.clear(); gesture = false; releaseIfIdle(); });
  scene.addEventListener('lostpointercapture', endGesture);
  scene.addEventListener('wheel', event => {
    if (!session || liveDesign || !event.isTrusted) return;
    event.stopImmediatePropagation(); event.preventDefault();
    const target = event.target;
    const init = { bubbles: true, cancelable: true, deltaX: event.deltaX, deltaY: event.deltaY, deltaMode: event.deltaMode,
      clientX: event.clientX, clientY: event.clientY, ctrlKey: event.ctrlKey, shiftKey: event.shiftKey };
    actionCount++;
    acquire().then(granted => { if (granted) { target.dispatchEvent(new WheelEvent('wheel', init)); session?.sendSnapshot(getView()); } })
      .finally(() => { actionCount--; releaseIfIdle(); });
  }, { capture: true, passive: false });
  scene.addEventListener('keydown', event => {
    if (!session || liveDesign || !event.isTrusted || !['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'].includes(event.key)) return;
    event.stopImmediatePropagation(); event.preventDefault();
    const target = event.target;
    const init = { bubbles: true, cancelable: true, key: event.key, code: event.code, ctrlKey: event.ctrlKey, shiftKey: event.shiftKey };
    actionCount++;
    acquire().then(granted => { if (granted) { target.dispatchEvent(new KeyboardEvent('keydown', init)); session?.sendSnapshot(getView()); } })
      .finally(() => { actionCount--; releaseIfIdle(); });
  }, true);
  new ResizeObserver(renderCursors).observe(scene);
  return {
    viewerReady() {
      listLocalDrafts().catch(() => {});
      if (!session) form.querySelector('button').disabled = false;
      if (!incoming && getDesignSession) Promise.resolve(getDesignSession()).then(controller => { designLabel.hidden = !controller; }).catch(() => {});
    },
    async runAction(action, restore) {
      actionCount++;
      try {
        if (!await acquire()) { if (lastView) await applyView(lastView); else restore?.(); return; }
        await action();
        if (session && state?.peerId && state.lease?.peerId === state.peerId) { lastView = getView(); session.sendSnapshot(lastView); }
      } finally { actionCount--; releaseIfIdle(); }
    },
    publish() {
      if (!session || !state?.peerId || state.lease?.peerId !== state.peerId || state.lease.epoch === releasedEpoch) return;
      // Zoom and keyboard pan can change the surface under a stationary pointer.
      schedulePointer();
      if (!actionCount) { lastView = getView(); session.sendSnapshot(lastView); }
    },
    render: renderCursors,
  };
}
