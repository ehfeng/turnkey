const catalogEndpoint = '/api/catalog';
const importedRecords = new Map();

export async function catalogRequest(path = '', options = {}) {
  const response = await fetch(catalogEndpoint + path, { cache: 'no-store', ...options });
  let body;
  try { body = await response.json(); } catch { throw new Error('The project catalog is unavailable.'); }
  if (!response.ok) throw new Error(body.error ?? 'The catalog request failed.');
  return body;
}

export async function getCatalogRecord(id) {
  if (!importedRecords.has(id)) {
    const request = catalogRequest('/revisions/' + encodeURIComponent(id)).catch(error => { importedRecords.delete(id); throw error; });
    importedRecords.set(id, request);
  }
  return importedRecords.get(id);
}

function proxy(THREE, entry) {
  const root = new THREE.Group();
  const mesh = new THREE.Mesh(new THREE.BoxGeometry(entry.size_x_mm / 1000, entry.size_z_mm / 1000, entry.size_y_mm / 1000),
    new THREE.MeshStandardMaterial({ color: 0x9baea7, roughness: 0.8 }));
  mesh.position.set(entry.offset_x_mm / 1000, entry.size_z_mm / 2000, -entry.offset_y_mm / 1000);
  root.add(mesh);
  root.userData.proxy = true;
  return root;
}

export async function buildCatalogAsset(THREE, record) {
  if (!record.model) return proxy(THREE, record.entry);
  const { GLTFLoader } = await import('three/addons/loaders/GLTFLoader.js');
  const bytes = Uint8Array.from(atob(record.model.base64), char => char.charCodeAt(0));
  const { scene } = await new GLTFLoader().parseAsync(bytes.buffer, '');
  const oriented = new THREE.Group();
  oriented.add(scene);
  oriented.rotation.y = ({ '+Z': Math.PI, '-Z': 0, '+X': Math.PI / 2, '-X': -Math.PI / 2 })[record.model.front];
  const bounds = new THREE.Box3().setFromObject(oriented, true);
  const size = bounds.getSize(new THREE.Vector3());
  if (![size.x, size.y, size.z].every(value => Number.isFinite(value) && value > 0)) throw new Error('The supplied model has no measurable volume.');
  const center = bounds.getCenter(new THREE.Vector3());
  oriented.position.set(-center.x, -bounds.min.y, -center.z);
  const { entry } = record;
  const scaled = new THREE.Group();
  scaled.scale.set(entry.size_x_mm / (size.x * 1000), entry.size_z_mm / (size.y * 1000), entry.size_y_mm / (size.z * 1000));
  scaled.position.set(entry.offset_x_mm / 1000, 0, -entry.offset_y_mm / 1000);
  scaled.add(oriented);
  const root = new THREE.Group();
  root.add(scaled);
  return root;
}

export async function importedPlacementAssets() {
  const { revisions } = await catalogRequest();
  return revisions.map(revision => ({
    id: revision.id, assetRevision: revision.id, asset_path: revision.id, entry: revision.entry,
    buildAsset: async ({ THREE }) => revision.hasModel ? buildCatalogAsset(THREE, await getCatalogRecord(revision.id)) : proxy(THREE, revision.entry),
  }));
}
