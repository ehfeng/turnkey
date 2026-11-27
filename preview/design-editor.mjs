import { furnitureEditor } from './furniture-editor.mjs';
import { getPlacementRules, loadDesignAssets, selectDesignGeometry, setDesignSnapshot } from './active-geometry.mjs';
import { setupCatalogImport } from './catalog-ui.mjs';
import { createPlacementUndo, placementInstance, placementRow, versionLink } from './design-editor-state.mjs';

const el = id => document.getElementById(id);
const short = revision => revision?.slice(0, 10) ?? '';
const feedback = message => { el('design-feedback').textContent = message; };

function setupVersionControls({ session, writable, authRequired, historical, onFork, getHeaders }) {
  const form = el('design-fork'), toggle = el('open-design-fork'), name = el('design-branch-name');
  const details = el('layout-versions'), branches = el('design-branch'), versions = el('design-version');
  let history, historyTicket = 0, historyHead, shownProblem, pending = false;
  function fillVersions() {
    if (!history) return;
    const head = history.branches.find(branch => branch.name === branches.value)?.head;
    const byId = new Map(history.commits.map(commit => [commit.id, commit]));
    const lineage = [];
    for (let commit = byId.get(head); commit; commit = byId.get(commit.parentId)) {
      lineage.push(commit);
    }
    versions.replaceChildren(...lineage.map(commit => {
      const date = new Date(commit.createdAt);
      const label = [short(commit.id), Number.isNaN(date.getTime()) ? '' : date.toLocaleString()].filter(Boolean).join(' · ');
      return new Option(label, commit.id);
    }));
    el('open-design-branch').href = versionLink(location.href, 'designBranch', branches.value);
    el('open-design-version').hidden = !versions.value;
    if (versions.value) el('open-design-version').href = versionLink(location.href, 'designVersion', versions.value);
  }
  async function refreshHistory() {
    const ticket = ++historyTicket;
    try {
      const response = await fetch('./api/designs/history', { headers: await getHeaders(), cache: 'no-store' });
      if (!response.ok) throw new Error('Could not load saved layouts.');
      const next = await response.json();
      if (ticket !== historyTicket) return;
      const previous = branches.value;
      history = next;
      branches.replaceChildren(...history.branches.map(branch => new Option(branch.name, branch.name)));
      branches.value = history.branches.some(b => b.name === previous) ? previous : session.getState().branch;
      if (!branches.value && branches.length) branches.selectedIndex = 0;
      fillVersions();
    } catch (error) { if (ticket === historyTicket) feedback(error.message); }
  }
  branches.onchange = fillVersions;
  versions.onchange = () => { el('open-design-version').href = versionLink(location.href, 'designVersion', versions.value); };
  details.ontoggle = () => { if (details.open) void refreshHistory(); };
  toggle.onclick = () => {
    form.hidden = !form.hidden;
    toggle.setAttribute('aria-expanded', String(!form.hidden));
    if (!form.hidden) name.focus();
  };

  function update(state) {
    el('shared-design').hidden = false;
    el('layout-key-label').hidden = !authRequired || !writable || state.collaborating;
    const view = historical() ? 'Saved version' : state.branch;
    const status = !state.ready ? 'Connecting…' : state.saving ? 'Saving…' : state.dirty ? 'Unsaved changes' : 'Saved';
    const label = [view, 'HEAD ' + short(state.head), status].join(' · ');
    if (el('design-head').textContent !== label) el('design-head').textContent = label;
    el('design-head').title = state.head;
    el('commit-design').hidden = historical() || !writable;
    el('commit-design').disabled = !state.ready || pending || state.saving || !state.dirty;
    toggle.hidden = !writable;
    toggle.disabled = !state.ready || pending || state.saving;
    form.querySelector('button').disabled = toggle.disabled;
    if (state.error && state.error !== shownProblem) feedback(state.error.message ?? String(state.error));
    shownProblem = state.error;
    if (historyHead !== state.head) {
      historyHead = state.head;
      if (details.open) void refreshHistory();
    }
  }
  async function save(fork) {
    if (pending) return;
    const branch = name.value.trim();
    if (fork && !branch) { name.focus(); return; }
    pending = true;
    update(session.getState());
    try {
      if (authRequired && !session.getState().collaborating && !el('layout-key').value.trim()) {
        el('layout-key').focus();
        throw new Error('Enter the editing key to save this layout.');
      }
      await session.save(fork ? { fork: true, branch } : {});
      if (fork) {
        onFork(session.getState().branch);
        name.value = '';
        form.hidden = true;
        toggle.setAttribute('aria-expanded', 'false');
      }
      const state = session.getState();
      feedback('Saved ' + state.branch + ' at ' + short(state.head) + '.');
    } catch (error) {
      const conflict = error.code === 'branch_conflict' || (!error.code && error.status === 409);
      if (conflict) {
        form.hidden = false;
        toggle.setAttribute('aria-expanded', 'true');
      }
      feedback(error.message + (conflict ? ' Your shared draft is still open. Choose a new branch name to save it.' : ''));
    } finally {
      pending = false;
      update(session.getState());
    }
  }
  el('commit-design').onclick = () => void save(false);
  form.onsubmit = event => { event.preventDefault(); void save(true); };
  return { update };
}

export function designEditor(options) {
  const { session, writable = true, authRequired = false, onSnapshotChange } = options;
  const getHeaders = () => session.getHeaders();
  let historical = options.historical ?? new URL(location.href).searchParams.has('designVersion');
  const undo = createPlacementUndo(), rooms = new Map();
  let state = session.getState(), projected, assets, editor, projection = Promise.resolve();
  let selectedSession = state.sessionId, projectionError;
  const versions = setupVersionControls({ session, getHeaders, writable, authRequired, historical: () => historical,
    onFork(branch) {
      historical = false;
      // In a live session the invitation tracks its HEAD. Keep the personal
      // branch in the page URL so leaving returns to the correct personal draft.
      if (!session.getState().collaborating) {
        const url = new URL(location.href);
        url.searchParams.delete('designVersion');
        url.searchParams.set('designBranch', branch);
        window.history.replaceState(window.history.state, '', url);
      }
      editor.updateDesignControls();
    },
  });
  function updateRooms(snapshot) {
    for (const room of rooms.values()) room.rows = [];
    for (const instance of snapshot.instances) {
      let room = rooms.get(instance.roomId);
      if (!room) { room = { selected: null, rows: [] }; rooms.set(instance.roomId, room); }
      room.rows.push(placementRow(instance));
    }
    for (const room of rooms.values()) {
      if (!room.rows.some(row => row.item_id === room.selected)) room.selected = null;
    }
  }
  async function project(snapshot, reload = false) {
    if (!snapshot) return;
    const geometryChanged = projected?.geometryRevision !== snapshot.geometryRevision;
    if (geometryChanged) await selectDesignGeometry(snapshot.geometryRevision);
    const missing = snapshot.instances.some(item => !assets?.has(item.assetRevision));
    if (reload || geometryChanged || missing) {
      assets = await loadDesignAssets(snapshot.geometryRevision);
      for (const instance of snapshot.instances) {
        if (!assets.has(instance.assetRevision)) throw new Error('Unavailable furniture revision ' + instance.assetRevision + '.');
      }
      editor?.updateDesignAssets(assets);
    }
    // Set even an empty snapshot: deleting the last placement must suppress its bundled CSV row.
    setDesignSnapshot(snapshot, assets);
    updateRooms(snapshot);
    const first = !projected;
    projected = snapshot;
    if (!first) onSnapshotChange?.();
    await editor?.updateDesignModel();
  }
  const synchronize = (snapshot, reload = false) => {
    const next = projection.catch(() => {}).then(async () => {
      projectionError = undefined;
      try { await project(snapshot, reload); }
      catch (error) { projectionError = error; throw error; }
    });
    next.catch(error => feedback(error.message));
    projection = next;
    return next;
  };
  const shared = {
    room(id) {
      if (!id) return null;
      if (!rooms.has(id)) rooms.set(id, { selected: null, rows: [] });
      return rooms.get(id);
    },
    rules: getPlacementRules,
    get ready() { return Boolean(writable && state.ready && !historical && !projectionError && projected?.geometryRevision === state.snapshot?.geometryRevision); },
    get state() { return state; },
    get canUndo() { return undo.canUndo(state.snapshot?.instances ?? []); },
    async edit(roomId, beforeRow, afterRow) {
      const change = { before: placementInstance(roomId, beforeRow), after: placementInstance(roomId, afterRow) };
      await session.apply(change);
      undo.record(change);
      await projection;
    },
    async undo() {
      await undo.undo(state.snapshot.instances, change => session.apply(change));
      await projection;
    },
    preview: instance => session.preview(instance),
    onPreview: listener => session.onPreview(listener),
    refresh: () => (projectionError ? synchronize(state.snapshot, true) : projection).then(() => ({})),
    update() {
      versions.update(state);
      el('design-catalog-import').hidden = !writable || historical;
    },
  };
  editor = furnitureEditor({ ...options, shared });
  setupCatalogImport({ container: el('design-catalog-import'), getHeaders, onApproved: async id => {
    await synchronize(state.snapshot, true);
    editor.selectDesignAsset(id);
  } });
  let receivedSnapshot;
  session.subscribe(next => {
    if (selectedSession !== next.sessionId) { undo.clear(); selectedSession = next.sessionId; }
    state = next;
    // State changes can also announce a lease, a save, or new peers without changing the draft.
    if (receivedSnapshot !== state.snapshot) {
      receivedSnapshot = state.snapshot;
      synchronize(state.snapshot);
    }
    editor.updateDesignControls();
  });
  return editor;
}
