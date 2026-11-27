import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { isLocalDesignEditor } from '../server/local-editor-access.mjs';
import { handleDesignRequest } from '../server/design-api.mjs';
import { designServicePlugin, nodeDesignStorage } from '../server/design-plugin.mjs';
import { createDesignStore } from '../server/design-store.mjs';

const chair = { id: 'chair-1', roomId: 'study', assetRevision: 'chair-r1', xMm: 10, yMm: 20, zMm: 0, yawDeg: 90 };
const original = { schemaVersion: 1, geometryRevision: 'plan-r1', instances: [chair] };
const placed = { ...original, instances: [{ ...chair, xMm: 50 }] };
const input = (head, overrides = {}) => ({
  sessionId: 'session-1', requestId: 'save-1', branch: 'main', expectedHead: head,
  sequence: 3, snapshot: placed, fork: false, ...overrides,
});

function setup(t) {
  const db = new DatabaseSync(':memory:');
  t.after(() => db.close());
  const settings = {
    ...nodeDesignStorage(db), projectId: 'synthetic-house', seedSnapshot: original,
    validateSnapshot: snapshot => {
      if (snapshot.instances.some(row => row.assetRevision !== 'chair-r1')) throw new Error('Unknown asset.');
    },
  };
  return { db, settings, store: createDesignStore(settings) };
}

test('saves and forks retain the exact revision and retry receipts, including after reopening the store', t => {
  const { settings, store } = setup(t);
  const { head } = store.index();
  const edits = input(head);
  const saved = store.save(edits);
  assert.equal(store.commit(saved.head).parentId, head);
  assert.deepEqual(store.commit(head).snapshot, original);
  assert.deepEqual(store.commit(saved.head).snapshot, placed);
  assert.deepEqual(store.session(edits.sessionId), { ...saved, requestId: edits.requestId });
  const alternative = store.save(input(head, { sessionId: 'other-session', fork: true, branch: 'study / option B' }));
  assert.equal(store.index().head, saved.head);
  assert.deepEqual(store.index().branches.map(ref => ref.head), [saved.head, alternative.head]);
  assert.equal(store.commit(alternative.head).parentId, head);
  assert.throws(() => store.save(input(head, { sessionId: 'third', fork: true, branch: alternative.branch })), { code: 'branch_conflict' });
  const reopened = createDesignStore({ ...settings, seedSnapshot: () => { throw new Error('Unexpected reseed'); } });
  assert.deepEqual(reopened.save(edits), saved);
  assert.deepEqual({ ...reopened.receipt(edits.sessionId, edits.requestId) }, saved);
  assert.equal(reopened.history().commits.length, 3);
});

test('branch and session concurrency checks retain branches and reject silently reused request IDs', t => {
  const { store } = setup(t);
  const { head } = store.index();
  const edits = input(head);
  const saved = store.save(edits);
  assert.throws(() => store.save({ ...edits, requestId: 'save-2', sessionId: 'session-2' }),
    error => error.code === 'branch_conflict' && error.details.currentHead === saved.head);
  assert.throws(() => store.save({ ...edits, sequence: 4 }), { code: 'request_reused' });
  assert.throws(() => store.save({ ...edits, requestId: 'save-2', fork: true, branch: 'early fork' }), { code: 'session_conflict' });
  assert.throws(() => store.save({ ...edits, expectedHead: saved.head, sequence: 2, requestId: 'stale' }), { code: 'stale_sequence' });
  const next = store.save({ ...edits, expectedHead: saved.head, sequence: 5, requestId: 'save-3', snapshot: original });
  assert.deepEqual(store.save(edits), saved);
  assert.equal(store.index().head, next.head);
  assert.equal(store.session(edits.sessionId).head, next.head);
});

test('validates imported assets, instance identity and poses and isolates projects sharing a database', t => {
  const { settings, store } = setup(t);
  const { head } = store.index();
  for (const snapshot of [
    { ...original, geometryRevision: 'another-plan' },
    { ...original, instances: [chair, chair] },
    { ...original, instances: [{ ...chair, xMm: NaN }] },
    { ...original, instances: [{ ...chair, assetRevision: 'new-asset' }] },
  ]) assert.throws(() => store.save(input(head, { snapshot })), { status: 400 });
  assert.equal(store.history().commits.length, 1);
  const other = createDesignStore({ ...settings, projectId: 'unrelated-house' });
  assert.notEqual(other.index().head, head);
  assert.throws(() => other.commit(head), { status: 404 });
  assert.throws(() => other.save(input(head, { fork: true, branch: 'fork' })), { status: 404 });
});

test('the SQL transaction rolls back the commit as well as the branch on storage failure', t => {
  const { db, store } = setup(t);
  const { head } = store.index();
  db.exec("CREATE TRIGGER fail_head BEFORE UPDATE ON design_branches BEGIN SELECT RAISE(ABORT, 'out of space'); END;");
  assert.throws(() => store.save(input(head)), /out of space/);
  assert.equal(store.history().commits.length, 1);
  assert.equal(store.index().head, head);
  assert.throws(() => store.session('session-1'), { status: 404 });
});

test('portable HTTP handler bounds saves, rejects cross-origin writes, exposes history and recovers lost ACKs', async t => {
  const { store } = setup(t);
  const base = 'https://design.example/api/designs';
  const call = (path, init) => handleDesignRequest(new Request(base + path, init), { store, capabilities: { writable: true } });
  const index = await (await call('')).json();
  assert.equal(index.writable, true);
  const edits = input(index.head);
  const send = (body, extraHeaders = {}) => call('/save', { method: 'POST', headers: { 'Content-Type': 'application/json', ...extraHeaders }, body });
  assert.equal((await send(JSON.stringify(edits), { Origin: 'https://elsewhere.example' })).status, 403);
  assert.equal((await send(' '.repeat(1024 * 1024 + 1))).status, 413);
  assert.equal((await send('{')).status, 400);
  const unauthorized = await handleDesignRequest(new Request(base + '/save', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(edits) }),
    { store, authorizeSave: async (_req, input) => input.sessionId === 'another-session' });
  assert.equal(unauthorized.status, 403);
  assert.equal((await call('/sessions/session-1')).status, 404);
  const receipt = await (await send(JSON.stringify(edits))).json();
  assert.deepEqual(await (await call('/receipts/session-1/save-1')).json(), receipt);
  assert.deepEqual(await (await call('/sessions/session-1')).json(), { ...receipt, requestId: edits.requestId });
  assert.equal((await (await call('/history')).json()).commits[0].id, receipt.head);
  assert.deepEqual((await (await call('/commits/' + receipt.head)).json()).snapshot, placed);
});

test('only local hosts and peers receive implicit local edit rights', () => {
  const allowed = (host, remoteAddress, origin) => isLocalDesignEditor({ headers: { host, origin }, socket: { remoteAddress } });
  assert.equal(allowed('localhost:5173', '127.0.0.1', 'http://localhost:5173'), true);
  assert.equal(allowed('[::1]:5173', '::1'), true);
  assert.equal(allowed('proxy.example', '127.0.0.1'), false);
  assert.equal(allowed('localhost', '192.0.2.1'), false);
  assert.equal(allowed('localhost', '127.0.0.1', 'http://elsewhere.example'), false);
});

test('local development and preview use the same SQLite versions across process restarts', async t => {
  const projectRoot = await mkdtemp(join(tmpdir(), 'turnkey-persist-'));
  t.after(() => rm(projectRoot, { recursive: true, force: true }));
  let seeds = 0;
  const plugin = designServicePlugin({ projectRoot, projectId: 'synthetic', seedSnapshot: async () => { seeds++; return original; } });
  async function open(mode) {
    let serve;
    const server = createServer((req, res) => serve(req, res, err => { res.writeHead(500); res.end(String(err)); }));
    plugin[mode]({ middlewares: { use: fn => { serve = fn; } }, httpServer: server });
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const api = 'http://127.0.0.1:' + server.address().port + '/api/designs';
    return { api, close: () => new Promise(resolve => server.close(resolve)) };
  }
  const first = await open('configureServer');
  let receipt;
  try {
    const index = await (await fetch(first.api)).json();
    const r = await fetch(first.api + '/save', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(input(index.head)) });
    assert.equal(r.status, 200);
    receipt = await r.json();
  } finally { await first.close(); }
  const second = await open('configurePreviewServer');
  try { assert.equal((await (await fetch(second.api)).json()).head, receipt.head); }
  finally { await second.close(); }
  assert.equal(seeds, 1);
});
