import { DesignError, normalizeDesignSnapshot, requiredDesignString } from './design.mjs';
export { DesignError as ProjectError };
export const PROJECT_SCHEMA_VERSION = 1;
export const projectError = (status, code, message, details = {}) => new DesignError(status, code, message, { schemaVersion: 1, documentationTopic: 'project-history', ...details });
export const required = (value, field) => requiredDesignString(value, field, 1024);

// Canonical JSON is also the idempotency representation. Reject values JSON would
// silently discard, and keys that are unsafe to merge into ordinary objects.
export function canonical(value) {
  function visit(v, depth) {
    if (depth > 64) throw projectError(400, 'invalid_state', 'JSON nesting exceeds 64 levels.');
    if (v === null || typeof v === 'string' || typeof v === 'boolean') return v;
    if (typeof v === 'number' && Number.isFinite(v)) return v;
    if (Array.isArray(v)) return v.map(item => visit(item, depth + 1));
    if (v && typeof v === 'object' && [Object.prototype, null].includes(Object.getPrototypeOf(v))) {
      const out = {};
      for (const key of Object.keys(v).sort()) {
        if (['__proto__', 'prototype', 'constructor'].includes(key)) throw projectError(400, 'invalid_state', 'Unsafe JSON field: ' + key);
        out[key] = visit(v[key], depth + 1);
      }
      return out;
    }
    throw projectError(400, 'invalid_state', 'Expected finite JSON values.');
  }
  return JSON.stringify(visit(value, 0));
}
export const copy = value => JSON.parse(canonical(value));
export const equal = (a, b) => canonical(a) === canonical(b);
export function normalizeProjectState(value, { completeness = 'complete' } = {}) {
  const state = copy(value);
  if (!state || Array.isArray(state) || typeof state !== 'object') throw projectError(400, 'invalid_state', 'Expected a project state object.');
  required(state.repository?.commit, 'repository commit');
  if (!/^[a-f0-9]{40,64}$/.test(state.repository.commit)) throw projectError(400, 'invalid_state', 'Repository commit must be a full immutable Git object ID.');
  if (state.design != null) state.design = normalizeDesignSnapshot(state.design);
  if (completeness === 'complete') {
    if (!state.design || !state.viewer || typeof state.viewer !== 'object' || Array.isArray(state.viewer) || !state.boards || typeof state.boards !== 'object' || Array.isArray(state.boards)) throw projectError(400, 'incomplete_state', 'Complete project state requires design, boards, and viewer components.');
  } else if (completeness !== 'source-only') throw projectError(400, 'invalid_state', 'Unknown completeness classification.');
  // ID collections merge by identity. Duplicates must never collapse in a merge.
  function ids(v, path) {
    if (Array.isArray(v)) {
      const seen = new Set();
      for (const row of v) {
        if (row && typeof row === 'object' && !Array.isArray(row) && 'id' in row) {
          required(row.id, path + ' record ID');
          if (seen.has(row.id)) throw projectError(400, 'duplicate_id', 'Duplicate record ID at ' + path, { id: row.id, path });
          seen.add(row.id);
        }
        ids(row, path + '[]');
      }
    } else if (v && typeof v === 'object') for (const [key, child] of Object.entries(v)) ids(child, path + '/' + key);
  }
  ids(state, '');
  return state;
}
