// A commit owns the room frames, builders and bundled furniture for its geometry revision.
import project from 'virtual:turnkey-project';
import * as current from './designs.mjs';

let active = current;
let rules = project;
let selected = __VIEWER_REVISION__;
let pendingRevision;
let pending;

export function selectDesignGeometry(revision) {
  if (pending && pendingRevision === revision) return pending;
  if (!pending && revision === selected) return Promise.resolve();
  const request = revision === __VIEWER_REVISION__ ? Promise.resolve(current)
    : typeof project.loadDesignGeometry === 'function' ? project.loadDesignGeometry(revision)
    : Promise.reject(new Error('The geometry for this saved version is unavailable.'));
  pendingRevision = revision;
  const selection = Promise.resolve(request).then(module => {
    if (!module || typeof module.loadCatalog !== 'function' || typeof module.setDesignSnapshot !== 'function' ||
        typeof module.loadDesignAssets !== 'function') {
      throw new Error('The saved geometry could not be loaded.');
    }
    if (selection === pending) {
      active = module;
      rules = module === current ? project : module;
      selected = revision;
    }
  }).finally(() => {
    if (pending === selection) pending = undefined;
  });
  pending = selection;
  return selection;
}

export function getPlacementRules() { return rules; }
export function loadCatalog() { return active.loadCatalog(); }
export function loadDesignAssets(revision) { return active.loadDesignAssets(revision); }
export function setDesignSnapshot(snapshot, assets) {
  if (snapshot.geometryRevision !== selected) throw new Error('The draft belongs to a different geometry revision.');
  active.setDesignSnapshot(snapshot, assets);
}
