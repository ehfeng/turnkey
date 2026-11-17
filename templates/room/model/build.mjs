import { applyPlacement } from 'turnkey/frame';
import { compareFurnitureSchedule } from 'turnkey/furniture';

// Set to the directory ID under house/levels/ to include this room in its floor. Leave '' until the level exists.
export const levelId = '';

// Where the room's own origin sits in the level, in level millimetres and plan yaw (degrees, counterclockwise).
// Leave this export out if the room is authored directly in level coordinates. Set it to null while the position
// in the level is unknown; the room still previews on its own.
export const placement = null;

// The default room is empty. Select this example in the viewer to see a model-owned shelf.
export const options = [{ id: 'example-shelf', label: 'Example shelf' }];

// Room-local mm. The anchor is the centre of the underside. Size follows plan X, Y, Z.
const exampleShelf = { x: 600, y: 400, z: 1000, size: [900, 300, 25], yaw: 90, phase: 'proposed' };

export function buildRoom({ THREE, option = '', furniture }) {
  const room = new THREE.Group();
  const expected = {};

  if (option === 'example-shelf') {
    const { x, y, z, size, yaw } = exampleShelf;
    const [width, depth, height] = size;
    const geometry = new THREE.BoxGeometry(width / 1000, height / 1000, depth / 1000);
    geometry.translate(0, height / 2000, 0); // Put the mesh origin on the underside.
    const shelf = new THREE.Mesh(geometry, new THREE.MeshStandardMaterial({ color: 0xb99570 }));
    shelf.name = 'example-shelf';
    shelf.userData.itemId = shelf.name;
    applyPlacement(shelf, { xMm: x, yMm: y, zMm: z, yawDeg: yaw });
    room.add(shelf);
    expected[shelf.name] = exampleShelf;
  }

  // The viewer and validator pass the rows resolved for this option.
  const mismatches = compareFurnitureSchedule(furniture, expected);
  room.userData.scheduleMismatches = mismatches;
  room.userData.warnings = [...mismatches];
  return room;
}

// Optional, while the level shell is not built: walls, floor or openings drawn from the room's own evidence.
// Shown in the room view and while the room has no level; hidden once the room is attached to its level.
// export function buildProvisionalShell({ THREE }) { return new THREE.Group(); }
