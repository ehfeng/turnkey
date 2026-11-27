// The persisted furniture schema uses project room coordinates in millimetres and plan yaw in degrees.
export class DesignError extends Error {
  constructor(status, code, message, details = {}) {
    super(message);
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

export function requiredDesignString(value, field, maxLength = 256) {
  if (typeof value !== 'string' || !value.trim() || value.length > maxLength || /[\u0000-\u001f\u007f]/.test(value)) {
    throw new DesignError(400, 'invalid_design', 'Invalid ' + field + '.');
  }
  return value;
}

export function normalizeDesignSnapshot(value) {
  if (value?.schemaVersion !== 1 || !Array.isArray(value.instances)) {
    throw new DesignError(400, 'invalid_design', 'Expected a version 1 design with furniture instances.');
  }
  const geometryRevision = requiredDesignString(value.geometryRevision, 'geometry revision', 1024);
  const ids = new Set();
  const instances = value.instances.map(row => {
    const id = requiredDesignString(row?.id, 'instance ID');
    if (ids.has(id)) throw new DesignError(400, 'duplicate_instance', 'Duplicate furniture instance: ' + id);
    ids.add(id);
    const instance = {
      id,
      roomId: requiredDesignString(row.roomId, 'room ID'),
      assetRevision: requiredDesignString(row.assetRevision, 'asset revision', 1024),
    };
    for (const field of ['xMm', 'yMm', 'zMm', 'yawDeg']) {
      if (!Number.isFinite(row[field])) throw new DesignError(400, 'invalid_design', 'Invalid ' + field + ' for ' + id + '.');
      instance[field] = row[field];
    }
    return instance;
  });
  return { schemaVersion: 1, geometryRevision, instances };
}
