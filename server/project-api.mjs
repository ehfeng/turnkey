import { DesignError } from '../shared/design.mjs';
import { projectTools, roomContextTool, getProjectDocumentation, projectSchema } from './project-docs.mjs';

const fail = (status, code, message, details = {}) => { throw new DesignError(status, code, message, details); };
export const jsonResponse = (value, status = 200, headers = {}) => Response.json(value, { status, headers: { 'Cache-Control': 'no-store', ...headers } });

// The host supplies cryptographic token verification (issuer, signature,
// expiry/nbf). This adapter then enforces resource audience, project membership
// and scopes; it never decodes an unverified JWT or trusts request actor fields.
export function createBearerProjectAuthorizer({ verifyToken, projectId, resource, resourceMetadataUrl }) {
  if (typeof verifyToken !== 'function' || typeof projectId !== 'string' || !projectId || typeof resource !== 'string' || !resource) throw new TypeError('Bearer authorization requires token verification, project and resource.');
  const metadata = resourceMetadataUrl && new URL(resourceMetadataUrl);
  if (metadata && (metadata.protocol !== 'https:' || metadata.hash)) throw new TypeError('Resource metadata must use an HTTPS URL without a fragment.');
  const challenge = `Bearer${metadata ? ' resource_metadata="' + metadata.href + '"' : ''}`;
  function unauthorized() {
    const error = new DesignError(401, 'invalid_token', 'A valid bearer token for this project resource is required.');
    error.headers = { 'WWW-Authenticate': challenge };
    throw error;
  }
  return async (request, context) => {
    if (context.projectId !== projectId) fail(403, 'project_forbidden', 'This token verifier does not authorize that project.');
    const match = /^Bearer ([^\s,]+)$/i.exec(request.headers.get('Authorization') ?? '');
    if (!match) unauthorized();
    let claims;
    try { claims = await verifyToken(match[1]); } catch { unauthorized(); }
    if (!claims || typeof claims.sub !== 'string' || !claims.sub || !(typeof claims.aud === 'string' ? claims.aud === resource : Array.isArray(claims.aud) && claims.aud.includes(resource))) unauthorized();
    if (!Array.isArray(claims.projects) || !claims.projects.includes(projectId)) fail(403, 'project_forbidden', 'Token does not grant project membership.');
    const scopes = new Set(typeof claims.scope === 'string' ? claims.scope.split(/\s+/) : []);
    const requiredScope = context.action === 'write' ? 'turnkey:write' : 'turnkey:read';
    if (!scopes.has(requiredScope)) fail(403, 'insufficient_scope', 'Token lacks ' + requiredScope + '.', { requiredScope });
    return { actor: { id: claims.sub, ...(typeof claims.iss === 'string' ? { issuer: claims.iss } : {}) } };
  };
}

export function createProjectResourceMetadata({ resource, authorizationServers, resourceName = 'Turnkey project' }) {
  if (!Array.isArray(authorizationServers) || !authorizationServers.length) throw new TypeError('Do not advertise OAuth without a configured authorization server.');
  for (const url of [resource, ...authorizationServers]) {
    const parsed = new URL(url);
    if (parsed.protocol !== 'https:' || parsed.username || parsed.password || parsed.hash || parsed.search) throw new TypeError('OAuth resource and issuer URLs must use HTTPS without credentials, query or fragment.');
  }
  return { resource, authorization_servers: [...authorizationServers], resource_name: resourceName,
    scopes_supported: ['turnkey:read', 'turnkey:write'], bearer_methods_supported: ['header'] };
}

export const projectErrorHeaders = error => error?.status === 401 && typeof error.headers?.['WWW-Authenticate'] === 'string' ? { 'WWW-Authenticate': error.headers['WWW-Authenticate'] } : {};

export function projectError(error) {
  const known = Number.isInteger(error?.status) && error.status >= 400 && error.status <= 599;
  const code = known && typeof error.code === 'string' ? error.code : 'internal_error';
  return { status: known ? error.status : 500, error: { code, message: known ? error.message : 'The project operation failed.',
    details: known ? error.details ?? {} : {}, schemaVersion: 1,
    documentationTopic: /merge|conflict/.test(code) ? 'merges' : /head|branch|request_reused/.test(code) ? 'branches' : 'validation' } };
}

// Validate the supported JSON Schema vocabulary used by tool arguments. Domain
// values (including complete project state) are validated by the project store.
export function validateToolArguments(value, schema, path = '') {
  const invalid = message => fail(400, 'invalid_arguments', message, { path });
  if (schema.enum && !schema.enum.includes(value)) invalid('Expected one of: ' + schema.enum.join(', '));
  if (schema.type === 'object') {
    if (!value || typeof value !== 'object' || Array.isArray(value)) invalid('Expected an object.');
    for (const key of schema.required ?? []) if (!Object.hasOwn(value, key)) fail(400, 'invalid_arguments', 'Missing required field: ' + key, { path: path + '/' + key });
    for (const key of Object.keys(value)) {
      if (['__proto__', 'prototype', 'constructor'].includes(key)) invalid('Reserved property name.');
      const field = schema.properties?.[key];
      if (field) validateToolArguments(value[key], field, path + '/' + key);
      else if (schema.additionalProperties === false) fail(400, 'invalid_arguments', 'Unknown field: ' + key, { path: path + '/' + key });
      else if (schema.additionalProperties && typeof schema.additionalProperties === 'object') validateToolArguments(value[key], schema.additionalProperties, path + '/' + key);
    }
  } else if (schema.type === 'array') {
    if (!Array.isArray(value)) invalid('Expected an array.');
    if (schema.maxItems !== undefined && value.length > schema.maxItems) invalid('Too many items.');
    value.forEach((item, i) => validateToolArguments(item, schema.items ?? {}, path + '/' + i));
  } else if (schema.type === 'string') {
    if (typeof value !== 'string' || (schema.minLength && value.trim().length < schema.minLength) || (schema.maxLength && value.length > schema.maxLength)) invalid('Invalid string length or type.');
    if (/[\u0000-\u001f\u007f]/.test(value)) invalid('Control characters are not supported.');
  } else if (schema.type === 'integer' || schema.type === 'number') {
    if (!Number.isFinite(value) || (schema.type === 'integer' && !Number.isInteger(value)) || value < (schema.minimum ?? -Infinity) || value > (schema.maximum ?? Infinity)) invalid('Invalid numeric value.');
  } else if (schema.type === 'boolean' && typeof value !== 'boolean') invalid('Expected a boolean.');
}

export async function readJsonRequest(request, maxBytes = 2 * 1024 * 1024) {
  if (request.headers.get('content-type')?.split(';')[0].trim().toLowerCase() !== 'application/json') fail(415, 'unsupported_media_type', 'Send application/json.');
  if (Number(request.headers.get('content-length')) > maxBytes) fail(413, 'request_too_large', 'Request exceeds the size limit.');
  const chunks = []; let size = 0;
  if (request.body) for await (const chunk of request.body) {
    size += chunk.byteLength;
    if (size > maxBytes) fail(413, 'request_too_large', 'Request exceeds the size limit.');
    chunks.push(chunk);
  }
  try { return JSON.parse(await new Blob(chunks).text()); }
  catch { fail(400, 'invalid_json', 'Send one valid JSON object.'); }
}

export function createProjectService({ store, authorize, roomContext, capabilities = {}, tools: adapters = [], allowedOrigins = [] }) {
  if (!store || typeof store.projectId !== 'string') throw new TypeError('A project-bound store is required.');
  const descriptors = [...projectTools, ...(roomContext ? [roomContextTool] : []), ...adapters];
  const names = new Set();
  for (const descriptor of descriptors) {
    if (names.has(descriptor.name)) throw new TypeError('Duplicate project tool: ' + descriptor.name);
    names.add(descriptor.name);
  }
  const publicTools = () => descriptors.map(({ name, description, inputSchema, annotations }) => ({ name, description, inputSchema, annotations }));
  const documented = (value, definition) => ({ $schema: `/api/projects/${encodeURIComponent(store.projectId)}/schemas/project-v1.json#/$defs/${definition}`, ...value });
  async function authenticate(request, action = 'read', tool = 'discovery') {
    const origin = request.headers.get('Origin');
    if (origin && origin !== new URL(request.url).origin && !allowedOrigins.includes(origin)) fail(403, 'forbidden_origin', 'This origin is not authorized.');
    const identity = typeof authorize === 'function' && await authorize(request, { projectId: store.projectId, action, tool });
    if (!identity || typeof identity !== 'object' || Array.isArray(identity)) fail(401, 'unauthorized', 'Authenticate with project access.');
    if (action === 'write' && (identity.actor === undefined || identity.actor === null)) fail(403, 'actor_required', 'An authenticated actor is required for changes.');
    return { ...identity, request, projectId: store.projectId };
  }
  async function execute(name, args, request) {
    const descriptor = descriptors.find(tool => tool.name === name);
    // Authenticate even unknown tools so project discovery is never public.
    const context = await authenticate(request, descriptor?.mutates ? 'write' : 'read', name);
    if (!descriptor) fail(404, 'unsupported_tool', 'This project does not support that tool.');
    validateToolArguments(args, descriptor.inputSchema);
    if (args.projectId !== store.projectId) fail(404, 'project_not_found', 'Project was not found.');
    const { projectId: _project, ...input } = args;
    if (descriptor.mutates) input.actor = context.actor;
    switch (name) {
      case 'get_model_documentation': {
        const result = getProjectDocumentation({ projectId: store.projectId, topic: args.topic, capabilities, tools: descriptors });
        if (!result) fail(404, 'unknown_topic', 'Documentation topic was not found.');
        return result;
      }
      case 'get_project_revision': return documented(store.getRevision(input.revisionId, { includeState: true }), 'ProjectRevision');
      case 'list_project_history': return store.history(input);
      case 'list_branches': return { schemaVersion: 1, projectId: store.projectId, branches: store.listBranches() };
      case 'create_branch': return store.createBranch(input);
      case 'compare_revisions': return store.compare(input);
      case 'commit_changes': return store.commit(input);
      case 'prepare_merge': return documented(store.prepareMerge(input), 'MergePlan');
      case 'get_merge_plan': return documented(store.getMergePlan(input.planId), 'MergePlan');
      case 'resolve_merge_conflicts': return documented(store.resolveMerge(input), 'MergePlan');
      case 'commit_merge': return store.commitMerge(input);
      case 'revert_revision': return store.revert(input);
      case 'list_project_events': return store.events(input);
      case 'get_operation_receipt': return store.receipt(input.operationId);
      case 'get_room_context': return roomContext({ revision: store.getRevision(input.revisionId, { includeState: true }), roomId: input.roomId }, context);
      default: return descriptor.execute(input, context);
    }
  }
  return { projectId: store.projectId, authenticate, execute, listTools: publicTools, schema: projectSchema };
}

export const isProjectRoute = path => path === '/api/projects' || path.startsWith('/api/projects/');

export async function handleProjectRequest(request, service) {
  try {
    const url = new URL(request.url);
    let parts;
    try { parts = url.pathname.split('/').map(decodeURIComponent); }
    catch { fail(400, 'invalid_path', 'Invalid URL encoding.'); }
    if (parts[1] !== 'api' || parts[2] !== 'projects' || parts[3] !== service.projectId) {
      await service.authenticate(request);
      fail(404, 'project_not_found', 'Project was not found.');
    }
    const route = parts.slice(4);
    const query = Object.fromEntries(url.searchParams);
    if (query.limit !== undefined) query.limit = Number(query.limit);
    if (route[0] === 'events' && query.cursor !== undefined) query.cursor = Number(query.cursor);
    let tool; let pathArgs = {};
    const key = request.method + ' ' + route.join('/');
    if (key === 'GET ' || key === 'GET documentation') tool = 'get_model_documentation';
    else if (key === 'GET schemas/project-v1.json') { await service.authenticate(request); return jsonResponse(service.schema); }
    else if (key === 'GET branches') tool = 'list_branches';
    else if (key === 'POST branches') tool = 'create_branch';
    else if (key === 'GET history') tool = 'list_project_history';
    else if (key === 'GET diff') tool = 'compare_revisions';
    else if (key === 'GET events') tool = 'list_project_events';
    else if (key === 'POST commits') tool = 'commit_changes';
    else if (key === 'POST reverts') tool = 'revert_revision';
    else if (key === 'POST merge-plans') tool = 'prepare_merge';
    else if (request.method === 'GET' && route.length === 2 && route[0] === 'revisions') { tool = 'get_project_revision'; pathArgs.revisionId = route[1]; }
    else if (request.method === 'GET' && route.length === 2 && route[0] === 'operations') { tool = 'get_operation_receipt'; pathArgs.operationId = route[1]; }
    else if (request.method === 'GET' && route.length === 3 && route[0] === 'rooms' && route[2] === 'context') { tool = 'get_room_context'; pathArgs.roomId = route[1]; }
    else if (route[0] === 'merge-plans' && route[1]) {
      pathArgs.planId = route[1];
      if (request.method === 'GET' && route.length === 2) tool = 'get_merge_plan';
      else if (request.method === 'POST' && route.length === 3 && route[2] === 'resolutions') tool = 'resolve_merge_conflicts';
      else if (request.method === 'POST' && route.length === 3 && route[2] === 'commit') tool = 'commit_merge';
    }
    if (!tool) { await service.authenticate(request); fail(404, 'route_not_found', 'Project route was not found.'); }
    // Check access before parsing a potentially large write body.
    await service.authenticate(request, request.method === 'POST' ? 'write' : 'read', tool);
    const args = request.method === 'POST' ? await readJsonRequest(request) : query;
    if (!args || typeof args !== 'object' || Array.isArray(args)) fail(400, 'invalid_arguments', 'Expected an object.');
    if (args.projectId !== undefined && args.projectId !== service.projectId) fail(400, 'project_mismatch', 'Body project ID disagrees with URL.');
    for (const [key, value] of Object.entries(pathArgs)) if (args[key] !== undefined && args[key] !== value) fail(400, 'path_mismatch', 'Body disagrees with path field: ' + key);
    const result = await service.execute(tool, { ...args, ...pathArgs, projectId: service.projectId }, request);
    return jsonResponse(result);
  } catch (error) {
    const result = projectError(error);
    return jsonResponse({ error: result.error }, result.status, projectErrorHeaders(error));
  }
}
