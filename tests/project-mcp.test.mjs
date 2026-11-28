import test from 'node:test';
import assert from 'node:assert/strict';
import { createProjectService, handleProjectRequest } from '../server/project-api.mjs';
import { handleProjectMcpRequest } from '../server/project-mcp.mjs';
import { DesignError } from '../shared/design.mjs';
import { DatabaseSync } from 'node:sqlite';
import { createProjectStore } from '../server/project-store.mjs';

function fixture() {
  const calls = [];
  const store = { projectId: 'cabin', listBranches: () => [{ name: 'main', headRevisionId: 'r1' }],
    commit: args => { calls.push(args); if (args.expectedHeadRevisionId !== 'r1') throw new DesignError(409, 'branch_conflict', 'Branch moved.', { currentHeadRevisionId: 'r1' }); return { projectId: 'cabin', branch: args.branch, headRevisionId: 'r2' }; } };
  const service = createProjectService({ store, authorize: (request, { action }) => {
    const token = request.headers.get('Authorization');
    if (!['Bearer reader', 'Bearer editor'].includes(token)) return null;
    if (action === 'write' && token !== 'Bearer editor') throw new DesignError(403, 'forbidden', 'Read-only member.');
    return { actor: 'user-from-auth' };
  } });
  return { service, calls };
}
function rpc(method, params = {}, extra = {}) {
  const { id = 'request-1', token = 'editor', headers = {} } = extra;
  return new Request('https://cabin.example/api/mcp', { method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', Authorization: 'Bearer ' + token, 'MCP-Protocol-Version': '2025-06-18', ...headers }, body: JSON.stringify({ jsonrpc: '2.0', ...(id === undefined || id === false ? {} : { id }), method, params }) });
}

test('real stateless MCP handshake, notifications, tool discovery and documentation', async () => {
  const { service } = fixture();
  const initialized = await handleProjectMcpRequest(rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test-agent', version: '1' } }), service);
  assert.equal(initialized.status, 200);
  const handshake = await initialized.json();
  assert.equal(handshake.result.protocolVersion, '2025-06-18');
  assert.deepEqual(handshake.result.capabilities, { tools: {} });
  assert.equal(initialized.headers.get('Mcp-Session-Id'), null);
  assert.equal((await handleProjectMcpRequest(rpc('notifications/initialized', {}, { id: false }), service)).status, 202);
  const list = await (await handleProjectMcpRequest(rpc('tools/list'), service)).json();
  const names = list.result.tools.map(tool => tool.name);
  for (const name of ['get_model_documentation', 'list_branches', 'get_project_revision', 'prepare_merge', 'resolve_merge_conflicts', 'commit_merge', 'revert_revision']) assert.ok(names.includes(name));
  assert.ok(!names.includes('import_history'));
  assert.ok(!names.includes('add_window'));
  const documentation = await (await handleProjectMcpRequest(rpc('tools/call', { name: 'get_model_documentation', arguments: { projectId: 'cabin', topic: 'coordinates' } }), service)).json();
  assert.equal(documentation.result.isError, false);
  assert.match(documentation.result.structuredContent.text, /millimeters/);
  assert.deepEqual(JSON.parse(documentation.result.content[0].text), documentation.result.structuredContent);
});

test('HTTP and MCP mutation calls share actor, arguments, result and conflicts', async () => {
  const { service, calls } = fixture();
  const args = { branch: 'main', expectedHeadRevisionId: 'r1', operationId: 'same-retry', state: { boards: {} } };
  const http = await handleProjectRequest(new Request('https://cabin.example/api/projects/cabin/commits', { method: 'POST', headers: { Authorization: 'Bearer editor', 'Content-Type': 'application/json' }, body: JSON.stringify(args) }), service);
  const mcp = await (await handleProjectMcpRequest(rpc('tools/call', { name: 'commit_changes', arguments: { projectId: 'cabin', ...args } }), service)).json();
  assert.deepEqual(await http.json(), mcp.result.structuredContent);
  assert.deepEqual(calls[0], calls[1]);
  assert.equal(calls[0].actor, 'user-from-auth');
  const stale = await (await handleProjectMcpRequest(rpc('tools/call', { name: 'commit_changes', arguments: { projectId: 'cabin', ...args, expectedHeadRevisionId: 'stale' } }), service)).json();
  assert.equal(stale.result.isError, true);
  assert.equal(stale.result.structuredContent.error.code, 'branch_conflict');
  assert.equal(stale.result.structuredContent.error.details.currentHeadRevisionId, 'r1');
});

test('MCP rejects unauthenticated discovery, read-only writes and foreign origins', async () => {
  const { service, calls } = fixture();
  assert.equal((await handleProjectMcpRequest(rpc('tools/list', {}, { token: 'none' }), service)).status, 401);
  assert.equal((await handleProjectMcpRequest(rpc('tools/list', {}, { headers: { Origin: 'https://evil.example' } }), service)).status, 403);
  assert.equal((await handleProjectMcpRequest(rpc('tools/call', { name: 'commit_changes', arguments: {} }, { token: 'reader' }), service)).status, 403);
  assert.deepEqual(calls, []);
});

test('protocol and HTTP negotiation are explicit; server stream and batches are unsupported', async () => {
  const { service } = fixture();
  const get = await handleProjectMcpRequest(new Request('https://cabin.example/api/mcp', { headers: { Authorization: 'Bearer editor' } }), service);
  assert.equal(get.status, 405);
  assert.equal(get.headers.get('Allow'), 'POST');
  assert.equal((await handleProjectMcpRequest(rpc('tools/list', {}, { headers: { Accept: 'application/json' } }), service)).status, 406);
  assert.equal((await handleProjectMcpRequest(rpc('tools/list', {}, { headers: { Accept: 'application/json, text/event-stream;q=0' } }), service)).status, 406);
  assert.equal((await handleProjectMcpRequest(rpc('tools/list', {}, { headers: { 'MCP-Protocol-Version': 'unsupported' } }), service)).status, 400);
  assert.equal((await handleProjectMcpRequest(rpc('tools/list', {}, { headers: { 'Content-Type': 'text/plain' } }), service)).status, 415);
  const batch = new Request('https://cabin.example/api/mcp', { method: 'POST', headers: rpc('ping').headers, body: JSON.stringify([{ jsonrpc: '2.0', id: 1, method: 'ping' }]) });
  assert.equal((await handleProjectMcpRequest(batch, service)).status, 400);
  const negotiated = await (await handleProjectMcpRequest(rpc('initialize', { protocolVersion: '2099-01-01', capabilities: {}, clientInfo: { name: 'future', version: '1' } }), service)).json();
  assert.equal(negotiated.result.protocolVersion, '2025-06-18');
});

test('notifications cannot execute writes and invalid envelopes get JSON-RPC errors', async () => {
  const { service, calls } = fixture();
  assert.equal((await handleProjectMcpRequest(rpc('tools/call', { name: 'commit_changes', arguments: {} }, { id: false }), service)).status, 202);
  assert.deepEqual(calls, []);
  const missing = await (await handleProjectMcpRequest(rpc('does/not/exist'), service)).json();
  assert.equal(missing.error.code, -32601);
  const params = await (await handleProjectMcpRequest(rpc('tools/call', []), service)).json();
  assert.equal(params.error.code, -32602);
  const invalid = new Request('https://cabin.example/api/mcp', { method: 'POST', headers: rpc('ping').headers, body: '{' });
  assert.equal((await (await handleProjectMcpRequest(invalid, service)).json()).error.code, -32700);
  const spoof = await (await handleProjectMcpRequest(rpc('tools/call', { name: 'commit_changes', arguments: { projectId: 'cabin', branch: 'main', expectedHeadRevisionId: 'r1', operationId: 'o1', actor: 'owner', state: {} } }), service)).json();
  assert.equal(spoof.result.isError, true);
  assert.equal(spoof.result.structuredContent.error.code, 'invalid_arguments');
});

test('agent discovers, branches, edits, resolves a real SQLite merge and retries publication', async () => {
  const db = new DatabaseSync(':memory:');
  try {
    let nextId = 0;
    const store = createProjectStore({ projectId: 'cabin', makeId: () => `generated-${++nextId}`,
      sql: { exec: (query, ...args) => db.prepare(query).all(...args) }, transaction(fn) { db.exec('BEGIN'); try { const result = fn(); db.exec('COMMIT'); return result; } catch (error) { db.exec('ROLLBACK'); throw error; } } });
    const sha = 'a'.repeat(40);
    const state = { repository: { commit: sha }, design: { schemaVersion: 1, geometryRevision: sha, instances: [] }, boards: { schemaVersion: 1, floorPlans: [], pins: [{ id: 'lamp', title: 'Original' }], memberships: [] }, viewer: { packageRevision: 'fixture-v1' } };
    store.importHistory({ operationId: 'seed', actor: 'importer', revisions: [{ id: 'root', parentRevisionIds: [], createdAt: '2026-01-01T00:00:00Z', actor: null, state, completeness: 'complete' }], branches: [{ name: 'main', headRevisionId: 'root' }] });
    const service = createProjectService({ store, authorize: () => ({ actor: 'trusted-owner' }) });
    const call = async (name, args = {}) => {
      const response = await handleProjectMcpRequest(rpc('tools/call', { name, arguments: { projectId: 'cabin', ...args } }), service);
      const envelope = await response.json();
      assert.equal(response.status, 200);
      assert.equal(envelope.result.isError, false, JSON.stringify(envelope));
      return envelope.result.structuredContent;
    };
    await call('get_model_documentation');
    await call('create_branch', { name: 'option', fromRevisionId: 'root', operationId: 'branch' });
    const main = structuredClone(state); main.boards.pins[0].title = 'Main lamp';
    const alternative = structuredClone(state); alternative.boards.pins[0].title = 'Alternative lamp';
    const target = await call('commit_changes', { branch: 'main', expectedHeadRevisionId: 'root', operationId: 'main-edit', state: main });
    const source = await call('commit_changes', { branch: 'option', expectedHeadRevisionId: 'root', operationId: 'option-edit', state: alternative });
    const plan = await call('prepare_merge', { sourceBranch: 'option', targetBranch: 'main', expectedSourceHeadRevisionId: source.headRevisionId, expectedTargetHeadRevisionId: target.headRevisionId, operationId: 'prepare' });
    assert.equal(plan.conflicts.length, 1);
    const resolved = await call('resolve_merge_conflicts', { planId: plan.id, resolutions: { [plan.conflicts[0].id]: { choice: 'source' } }, operationId: 'resolve' });
    assert.equal(resolved.validation.valid, true);
    const merged = await call('commit_merge', { planId: resolved.id, operationId: 'merge' });
    assert.deepEqual(await call('commit_merge', { planId: resolved.id, operationId: 'merge' }), merged);
    assert.deepEqual(await call('get_operation_receipt', { operationId: 'merge' }), merged);
    const revision = await call('get_project_revision', { revisionId: merged.headRevisionId });
    assert.deepEqual(revision.parentRevisionIds, [target.headRevisionId, source.headRevisionId]);
    assert.equal(revision.state.boards.pins[0].title, 'Alternative lamp');
    const events = await call('list_project_events', { cursor: 0, limit: 200 });
    assert.equal(events.events.filter(event => event.type === 'project.merged').length, 1);
    assert.ok(Number.isInteger(events.nextCursor));
  } finally { db.close(); }
});
