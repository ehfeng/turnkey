import test from 'node:test';
import assert from 'node:assert/strict';
import { createProjectService, handleProjectRequest, validateToolArguments, createBearerProjectAuthorizer, createProjectResourceMetadata } from '../server/project-api.mjs';
import { projectTools, workflowExamples } from '../server/project-docs.mjs';
import { DesignError } from '../shared/design.mjs';

const origin = 'https://example.test';
function fixture(options = {}) {
  const calls = []; const grants = [];
  const store = { projectId: 'synthetic-cabin', listBranches: () => [{ name: 'main', headRevisionId: 'r1' }] };
  for (const name of ['getRevision', 'history', 'createBranch', 'compare', 'commit', 'prepareMerge', 'getMergePlan', 'resolveMerge', 'commitMerge', 'revert', 'events']) {
    store[name] = (...args) => { calls.push({ name, args }); return { method: name, args }; };
  }
  const authorize = (request, context) => {
    grants.push(context);
    if (request.headers.get('Authorization') !== 'Bearer reader' && request.headers.get('Authorization') !== 'Bearer editor') return null;
    if (context.action === 'write' && request.headers.get('Authorization') !== 'Bearer editor') throw new DesignError(403, 'forbidden', 'Read-only member.');
    return { actor: 'verified-user' };
  };
  return { calls, grants, store, service: createProjectService({ store, authorize, ...options }) };
}
function req(path, body, token = 'editor', extra = {}) {
  return new Request(origin + '/api/projects/synthetic-cabin/' + path, { method: body === undefined ? 'GET' : 'POST', headers: { Authorization: 'Bearer ' + token, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }), ...extra }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
}

test('all project reads and writes deny access without authenticated membership', async () => {
  const { service, calls } = fixture();
  for (const path of ['branches', 'revisions/r1', 'history?head=r1', 'diff?from=r1&to=r2', 'events', 'documentation', 'schemas/project-v1.json', 'merge-plans/p1']) {
    assert.equal((await handleProjectRequest(req(path, undefined, 'absent'), service)).status, 401, path);
  }
  assert.equal((await handleProjectRequest(req('commits', { state: {} }, 'absent'), service)).status, 401);
  assert.deepEqual(calls, []);
  const unconfigured = createProjectService({ store: { projectId: 'synthetic-cabin' } });
  assert.equal((await handleProjectRequest(req('branches'), unconfigured)).status, 401);
});

test('routes invoke shared services with exact path IDs and trusted actors', async () => {
  const { service, calls } = fixture();
  const operations = [
    ['branches', { name: 'alternative', fromRevisionId: 'r1', operationId: 'op1' }, 'createBranch'],
    ['commits', { branch: 'main', expectedHeadRevisionId: 'r1', operationId: 'op2', state: { boards: {} } }, 'commit'],
    ['merge-plans', { sourceBranch: 'alternative', targetBranch: 'main', expectedSourceHeadRevisionId: 'r2', expectedTargetHeadRevisionId: 'r1', operationId: 'op3' }, 'prepareMerge'],
    ['merge-plans/p1/resolutions', { operationId: 'op4', resolutions: { conflict1: { choice: 'value', value: null } } }, 'resolveMerge'],
    ['merge-plans/p2/commit', { operationId: 'op5' }, 'commitMerge'],
    ['reverts', { branch: 'main', expectedHeadRevisionId: 'r3', revisionId: 'r1', operationId: 'op6' }, 'revert'],
  ];
  for (const [path, body, method] of operations) {
    const response = await handleProjectRequest(req(path, body), service);
    assert.equal(response.status, 200, JSON.stringify(await response.json()));
    assert.equal(calls.at(-1).name, method);
    assert.equal(calls.at(-1).args[0].actor, 'verified-user');
    if (path.startsWith('merge-plans/')) assert.equal(calls.at(-1).args[0].planId, path.split('/')[1]);
  }
  const readRevision = await handleProjectRequest(req('revisions/r1'), service);
  assert.equal(readRevision.status, 200);
  assert.equal((await readRevision.json()).$schema, '/api/projects/synthetic-cabin/schemas/project-v1.json#/$defs/ProjectRevision');
  assert.deepEqual(calls.at(-1), { name: 'getRevision', args: ['r1', { includeState: true }] });
  assert.equal((await handleProjectRequest(req('history?head=r1&limit=12&cursor=c1'), service)).status, 200);
  assert.deepEqual(calls.at(-1).args[0], { head: 'r1', limit: 12, cursor: 'c1' });
});

test('actor spoofing, path mismatch and read-only writes cannot reach store', async () => {
  const { service, calls } = fixture();
  const body = { name: 'option', fromRevisionId: 'r1', operationId: 'op' };
  assert.equal((await handleProjectRequest(req('branches', { ...body, actor: 'owner' }), service)).status, 400);
  assert.equal((await handleProjectRequest(req('branches', body, 'reader'), service)).status, 403);
  assert.equal((await handleProjectRequest(req('branches', { ...body, projectId: 'other' }), service)).status, 400);
  assert.equal((await handleProjectRequest(req('merge-plans/p1/commit', { operationId: 'op', planId: 'p2' }), service)).status, 400);
  assert.equal((await handleProjectRequest(req('branches', body, 'editor', { Origin: 'https://malicious.example' }), service)).status, 403);
  assert.deepEqual(calls, []);
});

test('validation returns machine-readable field errors and safe internal errors', async () => {
  const { service, store } = fixture();
  const response = await handleProjectRequest(req('commits', { branch: 'main', operationId: 'op', state: {} }), service);
  assert.equal(response.status, 400);
  const { error } = await response.json();
  assert.equal(error.details.path, '/expectedHeadRevisionId');
  assert.equal(error.schemaVersion, 1);
  store.getRevision = () => { throw new Error('database password and internal paths'); };
  const failed = await handleProjectRequest(req('revisions/r1'), service);
  assert.equal(failed.status, 500);
  assert.doesNotMatch(await failed.text(), /password|internal paths/);
  store.commit = () => { throw new DesignError(409, 'branch_conflict', 'Branch moved.', { currentHeadRevisionId: 'r2' }); };
  const conflict = await handleProjectRequest(req('commits', { branch: 'main', expectedHeadRevisionId: 'r1', operationId: 'op', state: {} }), service);
  assert.equal(conflict.status, 409);
  assert.equal((await conflict.json()).error.details.currentHeadRevisionId, 'r2');
});

test('documentation examples validate against actual tool schemas and unsupported adapters stay undiscoverable', async () => {
  const { service } = fixture();
  for (const example of workflowExamples('synthetic-cabin').filter(e => e.tool)) validateToolArguments(example.arguments, projectTools.find(tool => tool.name === example.tool).inputSchema);
  const response = await handleProjectRequest(req('documentation'), service);
  const doc = await response.json();
  assert.equal(doc.schemaUrl, '/api/projects/synthetic-cabin/schemas/project-v1.json');
  assert.ok(doc.topics.includes('merges'));
  assert.ok(!service.listTools().some(tool => tool.name === 'add_window' || tool.name === 'get_room_context'));
  assert.equal((await handleProjectRequest(req('schemas/project-v1.json'), service)).status, 200);
});

test('optional room context receives exact revision and authenticated context', async () => {
  let received;
  const { service } = fixture({ roomContext: (args, context) => { received = { args, context }; return { revisionId: args.revision.args[0], roomId: args.roomId }; } });
  const response = await handleProjectRequest(req('rooms/studio/context?revisionId=r7'), service);
  assert.deepEqual(await response.json(), { revisionId: 'r7', roomId: 'studio' });
  assert.equal(received.context.actor, 'verified-user');
});

test('semantic HTTP adapter tools use discovered schema and same authorization boundary', async () => {
  let invocation;
  const { service } = fixture({ tools: [{ name: 'attach_reference', description: 'Attach a reference', mutates: true, inputSchema: { type: 'object', required: ['projectId', 'roomId'], properties: { projectId: { type: 'string' }, roomId: { type: 'string' } }, additionalProperties: false }, execute(input, context) { invocation = { input, context }; return { roomId: input.roomId }; } }] });
  assert.equal((await handleProjectRequest(req('tools/attach_reference', { roomId: 'studio' }, 'reader'), service)).status, 403);
  const response = await handleProjectRequest(req('tools/attach_reference', { roomId: 'studio' }), service);
  assert.deepEqual(await response.json(), { roomId: 'studio' });
  assert.equal(invocation.input.actor, 'verified-user');
  assert.equal(invocation.context.actor, 'verified-user');
  assert.equal((await handleProjectRequest(req('tools/not_installed', {}), service)).status, 404);
});

test('JSON media, size, and primitive guards reject unsafe writes', async () => {
  const { service, calls } = fixture();
  const path = origin + '/api/projects/synthetic-cabin/commits';
  for (const [body, contentType, expected] of [['{}', 'text/plain', 415], ['[1]', 'application/json', 400], ['null', 'application/json', 400], ['{', 'application/json', 400], [JSON.stringify({ data: 'x'.repeat(2 * 1024 * 1024) }), 'application/json', 413]]) {
    const response = await handleProjectRequest(new Request(path, { method: 'POST', body, headers: { Authorization: 'Bearer editor', 'Content-Type': contentType } }), service);
    assert.equal(response.status, expected);
  }
  assert.deepEqual(calls, []);
});

test('bearer authorizer requires verified subject, resource audience, project membership and operation scope', async () => {
  const resource = 'https://example.test/api/mcp';
  const claims = { sub: 'agent-user', iss: 'https://issuer.example', aud: resource, projects: ['synthetic-cabin'], scope: 'turnkey:read' };
  const authorize = createBearerProjectAuthorizer({ projectId: 'synthetic-cabin', resource,
    resourceMetadataUrl: 'https://example.test/.well-known/oauth-protected-resource',
    verifyToken: async token => { if (token !== 'verified') throw Error('Signature invalid'); return claims; } });
  const { service, calls } = fixture({ authorize });
  const read = () => handleProjectRequest(req('branches', undefined, 'verified'), service);
  assert.equal((await read()).status, 200);
  const body = { name: 'option', fromRevisionId: 'r1', operationId: 'op' };
  assert.equal((await handleProjectRequest(req('branches', body, 'verified'), service)).status, 403);
  assert.deepEqual(calls, []);
  claims.scope = 'turnkey:read turnkey:write';
  assert.equal((await handleProjectRequest(req('branches', body, 'verified'), service)).status, 200);
  assert.deepEqual(calls.at(-1).args[0].actor, { id: 'agent-user', issuer: 'https://issuer.example' });
  claims.projects = ['another-house']; assert.equal((await read()).status, 403);
  claims.projects = ['synthetic-cabin']; claims.aud = 'https://another-service.example';
  const wrongAudience = await read(); assert.equal(wrongAudience.status, 401);
  assert.match(wrongAudience.headers.get('WWW-Authenticate'), /resource_metadata=/);
  claims.aud = resource; claims.scope = 'turnkey:write'; assert.equal((await read()).status, 403);
  assert.equal((await handleProjectRequest(req('branches', undefined, 'unverified'), service)).status, 401);
  assert.throws(() => createProjectResourceMetadata({ resource, authorizationServers: [] }), /configured/);
  assert.throws(() => createProjectResourceMetadata({ resource, authorizationServers: ['http://issuer.example'] }), /HTTPS/);
  assert.deepEqual(createProjectResourceMetadata({ resource, authorizationServers: ['https://issuer.example'] }).scopes_supported, ['turnkey:read', 'turnkey:write']);
});

test('conditional board snapshots authorize every read and avoid resolving state for 304',async()=>{
  const {service,store,calls,grants}=fixture();
  store.getRevision=(id,options)=>{calls.push({name:'getRevision',args:[id,options]});return {id,state:{boards:{pins:[{id:'pin-'+id}]}}};};
  const first=await handleProjectRequest(req('board-snapshot?branch=main',undefined,'reader'),service);
  assert.equal(first.status,200);const etag=first.headers.get('ETag');assert.ok(etag);
  assert.equal(first.headers.get('Cache-Control'),'private, no-cache');assert.equal(first.headers.get('Vary'),'Authorization, Cookie');
  assert.deepEqual(await first.json(),{projectId:'synthetic-cabin',branch:'main',revisionId:'r1',boards:{pins:[{id:'pin-r1'}]}});
  calls.length=0;
  const unchanged=await handleProjectRequest(req('board-snapshot?branch=main',undefined,'reader',{'If-None-Match':etag}),service);
  assert.equal(unchanged.status,304);assert.equal(await unchanged.text(),'');assert.equal(unchanged.headers.get('ETag'),etag);
  assert.deepEqual(calls,[{name:'getRevision',args:['r1',{includeState:false}]}]);
  const denied=await handleProjectRequest(req('board-snapshot?branch=main',undefined,'absent',{'If-None-Match':etag}),service);assert.equal(denied.status,401);
  assert.equal(grants.at(-1).action,'read');assert.equal(grants.at(-1).tool,'get_board_snapshot');
  assert.equal((await handleProjectRequest(req('board-snapshot?branch=main',undefined,'reader',{'If-None-Match':'"other", W/'+etag}),service)).status,304);
});

test('snapshot selectors are explicit, branch resolution happens once, and exact revisions stay pinned',async()=>{
  const {service,store}=fixture();let reads=0,head='r1';
  store.listBranches=()=>{reads++;const result=[{name:'main',headRevisionId:head}];head='r2';return result;};
  store.getRevision=id=>{if(id==='missing')throw new DesignError(404,'not_found','Missing revision');return{id,state:{boards:id==='source'?null:{pins:[{id}]}}};};
  const response=await handleProjectRequest(req('board-snapshot?branch=main'),service);assert.equal(reads,1);assert.equal((await response.json()).revisionId,'r1');
  const next=await handleProjectRequest(req('board-snapshot?branch=main',undefined,'reader',{'If-None-Match':response.headers.get('ETag')}),service);assert.equal(next.status,200);assert.equal((await next.json()).revisionId,'r2');
  const historical=await handleProjectRequest(req('board-snapshot?revisionId=r1'),service);assert.deepEqual(await historical.json(),{projectId:'synthetic-cabin',branch:null,revisionId:'r1',boards:{pins:[{id:'r1'}]}});
  assert.notEqual(historical.headers.get('ETag'),response.headers.get('ETag'));assert.equal(reads,2);
  const unknownBoards=await handleProjectRequest(req('board-snapshot?revisionId=source'),service);assert.equal((await unknownBoards.json()).boards,null);
  for(const query of ['', '?branch=main&revisionId=r1','?branch=','?branch=main&branch=main','?revisionId=r1&unexpected=value'])assert.equal((await handleProjectRequest(req('board-snapshot'+query),service)).status,400,query);
  assert.equal((await handleProjectRequest(req('board-snapshot?branch=missing'),service)).status,404);
  assert.equal((await handleProjectRequest(req('board-snapshot?revisionId=missing',undefined,'reader',{'If-None-Match':'*'}),service)).status,404);
});
