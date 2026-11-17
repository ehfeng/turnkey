// Unversioned clients and persisted rooms use the original wire format (version 1).
// Bump this only when collaboration messages change incompatibly.
export const COLLABORATION_PROTOCOL_VERSION = 1;

export function supportsCollaborationProtocol(version = 1) {
  return version === COLLABORATION_PROTOCOL_VERSION;
}

export const INCOMPATIBLE_ROOM_MESSAGE =
  'The collaboration format has changed. Refresh the viewer and start a new review.';
