// Supply the actual product data alongside buildAsset to enable placement in the viewer.
// Example for a floor-standing chair (replace with the measured or reported values):
// export const catalogEntry = {
//   name: 'Oak chair', size_x_mm: 480, size_y_mm: 510, size_z_mm: 800,
//   anchor: 'footprint centre at finished floor',
// };
//
// Return a group in the asset's local frame: metres, Y up, local +X along the item's width (furniture.csv size_x),
// local -Z along its depth (size_y, the plan +Y direction), origin at the anchor point named in the README.
//
// Load supplied files relative to this module so the path works in every clone and in the static build:
//   const url = new URL('../chair.glb', import.meta.url).href;
//   const { GLTFLoader } = await import('three/addons/loaders/GLTFLoader.js');
//   const gltf = await new GLTFLoader().loadAsync(url);
export async function buildAsset({ THREE }) {
  const asset = new THREE.Group();
  return asset;
}
