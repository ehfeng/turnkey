// Set to the finished-floor elevation above the documented house datum, in mm.
export const elevationMm = null;

export function buildLevel({ THREE }) {
  const shell = new THREE.Group();
  // Add this level's shared geometry here. The viewer attaches rooms to this group.
  return shell;
}
