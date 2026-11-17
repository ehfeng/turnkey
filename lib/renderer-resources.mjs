// Resources such as a prefiltered reflection map belong to the renderer, not to
// the current model. Pending requests share work; failures may be retried.
const resourcesByRenderer = new WeakMap();

export function getRendererResource(renderer, key, create) {
  let resources = resourcesByRenderer.get(renderer);
  if (!resources) resourcesByRenderer.set(renderer, resources = new Map());
  if (resources.has(key)) return resources.get(key).promise;
  const entry = { disposed: false, resource: null };
  entry.promise = Promise.resolve().then(create).then(resource => {
    if (entry.disposed) {
      resource.dispose();
      throw new Error(`Renderer resource ${key} was disposed while loading.`);
    }
    entry.resource = resource;
    if (resource.texture) resource.texture.userData.disposeWithModel = false;
    return resource;
  }).catch(error => {
    if (resources.get(key) === entry) resources.delete(key);
    throw error;
  });
  resources.set(key, entry);
  return entry.promise;
}

// Call before discarding a renderer or rebuilding models after context restore.
// A pending factory may finish later; its result is disposed instead of cached.
export function disposeRendererResources(renderer) {
  const resources = resourcesByRenderer.get(renderer);
  if (!resources) return;
  resourcesByRenderer.delete(renderer);
  for (const entry of resources.values()) {
    entry.disposed = true;
    entry.resource?.dispose();
  }
}
