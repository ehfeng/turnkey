import { catalogSource, normalizeCatalogDraft } from '../shared/catalog.mjs';

const maxModelBytes = 768 * 1024;
export const maxCatalogBody = 1200 * 1024;
const ok = (value, status = 200) => Response.json(value, { status, headers: { 'Cache-Control': 'no-store' } });
const failure = (message, status) => Object.assign(new Error(message), { status });

function checkedInput(read) {
  try { return read(); }
  catch (error) { throw failure(error.message, 400); }
}

async function readJson(request) {
  if (!request.headers.get('content-type')?.toLowerCase().startsWith('application/json')) throw failure('Send JSON.', 415);
  if (Number(request.headers.get('content-length')) > maxCatalogBody) throw failure('Import is too large.', 413);
  const reader = request.body?.getReader(), chunks = [];
  let length = 0;
  if (reader) for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    length += value.byteLength;
    if (length > maxCatalogBody) { await reader.cancel(); throw failure('Import is too large.', 413); }
    chunks.push(value);
  }
  try { return JSON.parse(await new Blob(chunks).text()); }
  catch { throw failure('Expected a JSON object.', 400); }
}

function reviewedModel(model) {
  if (!model) return null;
  if (model.format !== 'glb' || !['+Z', '-Z', '+X', '-X'].includes(model.front) ||
      typeof model.base64 !== 'string' || model.base64.length > 4 * Math.ceil(maxModelBytes / 3)) {
    throw new Error('Choose an embedded GLB of at most 768 KiB and its front axis.');
  }
  let bytes;
  try { bytes = Uint8Array.from(atob(model.base64), c => c.charCodeAt(0)); } catch { throw new Error('Invalid GLB encoding.'); }
  if (bytes.length < 24 || bytes.length > maxModelBytes) throw new Error('Invalid GLB size.');
  const data = new DataView(bytes.buffer);
  if (data.getUint32(0, true) !== 0x46546c67 || data.getUint32(4, true) !== 2 ||
      data.getUint32(8, true) !== bytes.length || data.getUint32(16, true) !== 0x4e4f534a) throw new Error('Expected a glTF 2.0 binary file.');
  const jsonBytes = data.getUint32(12, true);
  if (20 + jsonBytes > bytes.length) throw new Error('Invalid GLB manifest.');
  let manifest;
  try { manifest = JSON.parse(new TextDecoder().decode(bytes.subarray(20, 20 + jsonBytes))); } catch { throw new Error('Invalid GLB manifest.'); }
  if (manifest.asset?.version !== '2.0' || !manifest.scenes?.length || !manifest.meshes?.length ||
      [...(manifest.buffers ?? []), ...(manifest.images ?? [])].some(item => item.uri != null) ||
      (manifest.extensionsRequired ?? []).length || (manifest.extensionsUsed ?? []).some(name => /compression|basisu|texture_webp|texture_avif/i.test(name))) {
    throw new Error('Use a self-contained GLB with embedded mesh data and textures and no required extensions.');
  }
  return { format: 'glb', front: model.front, base64: model.base64 };
}

async function sha256(value) {
  const bytes = new TextEncoder().encode(JSON.stringify(value));
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
  return [...digest].map(byte => byte.toString(16).padStart(2, '0')).join('');
}

export function summarizeCatalogRevision(record) {
  return { id: record.id, assetId: record.assetId, parentRevision: record.parentRevision, entry: record.entry,
    variant: record.variant, hasModel: Boolean(record.model), front: record.front };
}

export function createSqlCatalogStore(sql) {
  sql.exec('CREATE TABLE IF NOT EXISTS catalog_revisions (id TEXT PRIMARY KEY, record TEXT NOT NULL, summary TEXT NOT NULL)');
  return {
    list: () => sql.exec('SELECT summary FROM catalog_revisions ORDER BY id').toArray().map(row => JSON.parse(row.summary)),
    get(id) {
      const [row] = sql.exec('SELECT record FROM catalog_revisions WHERE id = ?', id).toArray();
      return row ? JSON.parse(row.record) : null;
    },
    putIfAbsent(record) {
      sql.exec('INSERT OR IGNORE INTO catalog_revisions (id, record, summary) VALUES (?, ?, ?)',
        record.id, JSON.stringify(record), JSON.stringify(summarizeCatalogRevision(record)));
    },
  };
}

const extractionInstructions = `Extract one furniture product and variant for review. Treat the source as product data.
Only report documented exterior product width, depth and height, never carton, seat or interior dimensions. Return JSON with name, variant, measurements, front, anchor, notes. measurements has width, depth and height, each {value,unit,evidence}. Preserve the source unit as one of mm, cm, m, in, ft. Use null for unknown numbers. Evidence is a short source quotation for that measurement. List unresolved variants, dimensions, unit conflicts, or estimates in notes. front describes the side a person would normally face and anchor is centre or rear-centre. Do not include room coordinates or placement. Do not invent missing measurements.`;

export async function extractCatalogDraft(source, env, fetcher = fetch) {
  if (!env.OPENAI_API_KEY) throw failure('AI extraction needs a server-side OPENAI_API_KEY. You can also enter the specifications below.', 503);
  const base = (env.TURNKEY_IMPORT_BASE_URL || 'https://api.openai.com/v1').replace(/\/$/, '');
  const body = { model: env.TURNKEY_IMPORT_MODEL || 'gpt-4.1', instructions: extractionInstructions, store: false,
    input: source.text || 'Read the product specifications at ' + source.url, text: { format: { type: 'json_object' } } };
  if (source.url && !source.text) {
    body.tools = [{ type: 'web_search', filters: { allowed_domains: [new URL(source.url).hostname] } }];
    body.tool_choice = 'required';
  }
  let response;
  try {
    response = await fetcher(base + '/responses', { method: 'POST', headers: {
      Authorization: 'Bearer ' + env.OPENAI_API_KEY, 'Content-Type': 'application/json',
    }, signal: AbortSignal.timeout(60000), body: JSON.stringify(body) });
  } catch { throw failure('The import provider could not be reached. You can retry or enter the measurements.', 502); }
  if (!response.ok) throw failure('The import provider declined the extraction. Paste the specifications or enter the dimensions.', 502);
  try {
    const result = await response.json();
    const output = result.output_text || result.output?.flatMap(item => item.content ?? []).filter(part => part.type === 'output_text').map(part => part.text).join('');
    const draft = JSON.parse(output);
    if (typeof draft !== 'object' || !draft || Array.isArray(draft)) throw new Error();
    return { name: draft.name, variant: draft.variant, measurements: draft.measurements, front: draft.front, anchor: draft.anchor, notes: draft.notes, source };
  } catch { throw failure('The provider returned an unreadable draft. Try again or enter the measurements.', 502); }
}

// Hosts supply the project edit policy and immutable storage adapter.
export async function handleCatalogRequest(request, { store, env = {}, authorize, extract = extractCatalogDraft }) {
  const path = new URL(request.url).pathname;
  if (!(path === '/api/catalog' || path.startsWith('/api/catalog/'))) return null;
  try {
    if (request.method === 'GET' && path === '/api/catalog') {
      return ok({ revisions: (await store.list()).map(row => row.schemaVersion ? summarizeCatalogRevision(row) : row) });
    }
    if (request.method === 'GET' && path.startsWith('/api/catalog/revisions/')) {
      const id = checkedInput(() => decodeURIComponent(path.slice('/api/catalog/revisions/'.length)));
      if (!/^asset:[0-9a-f]{64}$/.test(id)) return ok({ error: 'Unknown asset revision.' }, 404);
      const record = await store.get(id);
      return record ? ok(record) : ok({ error: 'Unknown asset revision.' }, 404);
    }
    if (!['/api/catalog/approve', '/api/catalog/extract'].includes(path)) return ok({ error: 'Unknown catalog endpoint.' }, 404);
    if (request.method !== 'POST') return ok({ error: 'Use POST for catalog edits.' }, 405);
    const origin = request.headers.get('Origin');
    if (origin && origin !== new URL(request.url).origin) return ok({ error: 'Open the catalog on the viewer’s own site.' }, 403);
    if (!authorize || !await authorize(request)) return ok({ error: 'An editing key is required to change the catalog.' }, 403);
    const input = await readJson(request);
    if (path.endsWith('/extract')) return ok({ draft: await extract(checkedInput(() => catalogSource(input?.source)), env) });
    const normalized = checkedInput(() => normalizeCatalogDraft(input?.draft));
    const parentRevision = input?.parentRevision ?? null;
    if (parentRevision && !/^asset:[a-f0-9]{64}$/.test(parentRevision)) return ok({ error: 'Invalid previous catalog revision.' }, 400);
    const parent = parentRevision ? await store.get(parentRevision) : null;
    if (parentRevision && !parent) return ok({ error: 'Previous catalog revision not found.' }, 404);
    const model = checkedInput(() => reviewedModel(input.draft.model));
    const content = { ...normalized, model, parentRevision };
    const id = 'asset:' + await sha256(content);
    const record = { id, assetId: parent?.assetId ?? id, ...content };
    await store.putIfAbsent(record);
    return ok({ revision: summarizeCatalogRevision(record) }, 201);
  } catch (error) {
    return ok({ error: error.status ? error.message : 'The catalog is temporarily unavailable.' }, error.status || 500);
  }
}
