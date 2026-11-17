// Use the original geometry for removals so their silhouettes, openings and placements
// match Existing. Never recolor a material shared by a retained item.
export function highlightDemolition(THREE, root) {
  const overrides = new Map();
  const originals = [];
  function removalMaterial(source) {
    if (!overrides.has(source)) {
      const material = new THREE.MeshStandardMaterial({
        color: '#d43c32', roughness: 0.82, side: source.side,
        transparent: source.transparent, opacity: Math.max(0.45, source.opacity),
        depthWrite: source.depthWrite, polygonOffset: source.polygonOffset,
        polygonOffsetFactor: source.polygonOffsetFactor, polygonOffsetUnits: source.polygonOffsetUnits,
      });
      material.userData.demolitionHighlight = true;
      overrides.set(source, material);
    }
    return overrides.get(source);
  }
  function visit(object, parentPhase) {
    const phase = object.userData.phase ?? parentPhase;
    if (phase === 'demolition' && object.isMesh && object.material) {
      originals.push([object, object.material]);
      object.material = Array.isArray(object.material)
        ? object.material.map(removalMaterial) : removalMaterial(object.material);
    }
    for (const child of object.children) visit(child, phase);
  }
  visit(root);
  if (originals.length) {
    const priorDispose = root.userData.onDispose;
    root.userData.onDispose = () => {
      for (const [object, material] of originals) object.material = material;
      for (const override of overrides.values()) override.dispose();
      priorDispose?.();
    };
  }
  return root;
}
