// Unversioned clients and persisted rooms use the original wire format (version 1).
// Bump this only when collaboration messages change incompatibly.
export const COLLABORATION_PROTOCOL_VERSION = 1;

export function supportsCollaborationProtocol(version = 1) {
  return version === COLLABORATION_PROTOCOL_VERSION;
}

export const INCOMPATIBLE_ROOM_MESSAGE =
  'The collaboration format has changed. Refresh the viewer and start a new review.';

const validName = value => typeof value === 'string' && value.length > 0 &&
  value.length <= 256 && value === value.trim() && !/[\u0000-\u001f\u007f]/u.test(value);

export function validDesignHead({ head, branch } = {}) {
  return validName(head) && validName(branch);
}

export function validDesignBase(base) {
  return Boolean(base && validName(base.projectId) && validDesignHead(base));
}

export function newRoomDesign({ projectId, branch, head }, sessionId) {
  return { projectId, branch, head, sessionId, coordinatorId: null, term: 0 };
}

// A stale invitation can open the current HEAD. It still has to identify this session.
export function acceptsDesignJoin(design, announcement) {
  if (!design) return announcement == null;
  return announcement?.sessionId === design.sessionId && validName(announcement.head);
}

export function electDesignCoordinator(design, orderedPeerIds) {
  if (!design || orderedPeerIds.includes(design.coordinatorId)) return;
  const successor = orderedPeerIds[0] ?? null;
  if (successor !== design.coordinatorId) {
    design.coordinatorId = successor;
    design.term++;
  }
}

export function roomDesignFields(room) {
  return room.design ? { design: room.design } : {};
}
