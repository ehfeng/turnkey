/** Level-local plan coordinates in millimetres to Three.js coordinates in metres. */
export function planToScene(xMm, yMm, zMm) {
  return [xMm / 1000, zMm / 1000, -yMm / 1000];
}

/** Plan yaw (degrees, counterclockwise from +X seen from above) to a rotation about scene +Y, in radians. */
export function planYawToScene(yawDeg) {
  return (Number(yawDeg) || 0) * Math.PI / 180;
}

/**
 * Move an object to a plan placement: `{ xMm, yMm, zMm, yawDeg }` (missing values are 0).
 * The object's own origin lands on the placement point and its local +X turns to the given yaw.
 */
export function applyPlacement(object, placement = {}) {
  const { xMm = 0, yMm = 0, zMm = 0, yawDeg = 0 } = placement ?? {};
  object.position.set(...planToScene(xMm, yMm, zMm));
  object.rotation.set(0, planYawToScene(yawDeg), 0);
  return object;
}
