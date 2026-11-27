import { DesignError } from '../shared/design.mjs';

const endpoint = '/api/designs';
const maxBody = 1024 * 1024;
const json = (body, status = 200) => Response.json(body, { status, headers: { 'Cache-Control': 'no-store' } });

export function isDesignRoute(pathname) {
  return pathname === endpoint || pathname.startsWith(endpoint + '/');
}

async function readSave(request) {
  if (request.headers.get('content-type')?.split(';')[0].trim() !== 'application/json') {
    throw new DesignError(415, 'content_type', 'Send the save as application/json.');
  }
  const reader = request.body?.getReader();
  if (!reader) throw new DesignError(400, 'invalid_save', 'Missing save data.');
  const chunks = [];
  let length = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      length += value.byteLength;
      if (length > maxBody) {
        await reader.cancel();
        throw new DesignError(413, 'too_large', 'The design save exceeds 1 MiB.');
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  try { return JSON.parse(await new Blob(chunks).text()); }
  catch { throw new DesignError(400, 'invalid_json', 'Invalid JSON in design save.'); }
}

// Deployment adapters authenticate the editor before passing a write to this handler.
export async function handleDesignRequest(request, { store, capabilities, authorizeSave }) {
  try {
    const url = new URL(request.url);
    if (!isDesignRoute(url.pathname)) throw new DesignError(404, 'not_found', 'Unknown design route.');
    const suffix = url.pathname.slice(endpoint.length);
    let parts;
    try { parts = suffix ? suffix.slice(1).split('/').map(decodeURIComponent) : []; }
    catch { throw new DesignError(400, 'invalid_path', 'Invalid design path.'); }
    if (parts[0] === 'save' && parts.length === 1) {
      if (request.method !== 'POST') throw new DesignError(405, 'method', 'Use POST to save a design.');
      if (request.headers.has('Origin') && request.headers.get('Origin') !== url.origin) {
        throw new DesignError(403, 'origin', 'Open the design on the project’s own site.');
      }
      const input = await readSave(request);
      if (authorizeSave && !await authorizeSave(request, input)) {
        throw new DesignError(403, 'unauthorized', 'Edit access is required to save this design.');
      }
      return json(store.save(input));
    }
    if (request.method !== 'GET') throw new DesignError(405, 'method', 'Use GET to read a design.');
    if (parts.length === 0) return json({ ...store.index(), ...capabilities });
    if (parts[0] === 'history' && parts.length === 1) return json(store.history());
    if (parts[0] === 'commits' && parts.length === 2) return json(store.commit(parts[1]));
    if (parts[0] === 'receipts' && parts.length === 3) return json(store.receipt(parts[1], parts[2]));
    if (parts[0] === 'sessions' && parts.length === 2) return json(store.session(parts[1]));
    throw new DesignError(404, 'not_found', 'Unknown design route.');
  } catch (error) {
    if (!(error instanceof DesignError)) throw error;
    return json({ error: error.message, code: error.code, ...error.details }, error.status);
  }
}
