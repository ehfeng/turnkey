import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createDesignSession } from '../preview/design-session.mjs';

const chair = (id, roomId = 'study') => ({ id, roomId, assetRevision: 'oak', xMm: 0, yMm: 0, zMm: 0, yawDeg: 0 });
const base = { schemaVersion: 1, geometryRevision: 'survey', instances: [] };
const until = async predicate => {
  for (let i = 0; i < 100; i++) { if (predicate()) return; await new Promise(resolve => setTimeout(resolve, 2)); }
  assert.ok(predicate(), 'state converges');
};
const memory = () => { const data = new Map(); return { get length() { return data.size; }, key: i => [...data.keys()][i], getItem: id => data.get(id), setItem: (id, value) => data.set(id, value) }; };
function server() {
  const branches = new Map([['main', 'first']]), commits = new Map([['first', base]]);
  const receipts = new Map(), sessions = new Map();
  const api = {
    discardResponse: false, hold: null, dispatched: false,
    async fetch(url, options) {
      const path = url.split('/').slice(3);
      if (path[0] === 'save') {
        api.dispatched = true;
        if (api.hold) await api.hold;
        const body = JSON.parse(options.body);
        const key = body.sessionId + '/' + body.requestId;
        if (receipts.has(key)) return Response.json(receipts.get(key));
        if (body.fork ? branches.has(body.branch) : branches.get(body.branch) !== body.expectedHead)
          return Response.json({ error: 'The branch moved', code: 'branch_conflict' }, { status: 409 });
        const head = 'commit-' + commits.size;
        const saved = { head, branch: body.branch, sequence: body.sequence };
        receipts.set(key, saved); sessions.set(body.sessionId, { ...saved, requestId: body.requestId });
        commits.set(head, body.snapshot); branches.set(body.branch, head);
        if (api.discardResponse) { api.discardResponse = false; throw Error('Lost HTTP response'); }
        return Response.json(saved);
      }
      if (path[0] === 'commits' && commits.has(path[1])) return Response.json({ id: path[1], snapshot: commits.get(path[1]) });
      const value = path[0] === 'sessions' ? sessions.get(path[1]) : receipts.get(path.slice(1).join('/'));
      return value ? Response.json(value) : Response.json({}, { status: 404 });
    }, branches, commits
  };
  return api;
}
function replica(api, extra) {
  return createDesignSession({ projectId: 'house', branch: 'main', head: 'first', snapshot: base, fetchImpl: api.fetch, storage: memory(), tabStorage: memory(), ...extra });
}
function session(api) {
  const participants = new Map();
  const design = { sessionId: crypto.randomUUID(), branch: 'main', head: 'first', projectId: 'house', term: 0, coordinatorId: null };
  function announce() {
    for (const [peerId, peer] of participants) peer.membership({ peerId, peers: [...participants.keys()].filter(id => id !== peerId).map(id => ({ id })), design: { ...design } });
  }
  return {
    design, add(id) {
      const peer = replica(api);
      const creating = !design.term;
      if (creating) { design.coordinatorId = id; design.term++; }
      peer.connect({
        design: { ...design }, room: 'test-room', token: 'invite', sendPreview() {},
        send(to, data) {
          queueMicrotask(() => { if (participants.has(id)) participants.get(to)?.receive(structuredClone(data), id); });
          return participants.has(to);
        },
        declareHead(head, branch) { Object.assign(design, { head, branch }); queueMicrotask(announce); }
      }, creating);
      participants.set(id, peer); announce(); return peer;
    },
    remove(id) {
      participants.get(id).disconnect(); participants.delete(id);
      if (design.coordinatorId === id) { design.coordinatorId = participants.keys().next().value; design.term++; }
      announce();
    }, close() { for (const peer of participants.values()) peer.disconnect(); participants.clear(); }
  };
}

test('three editors share moves across rooms, join late, hand off, and save through a lost HTTP acknowledgment', async t => {
  const api = server(), room = session(api); t.after(() => room.close());
  const a = room.add('a'); await until(() => a.getState().ready);
  const b = room.add('b'); await until(() => b.getState().ready);
  await Promise.all([a.apply({ before: null, after: chair('armchair') }), b.apply({ before: null, after: chair('stool','kitchen') })]);
  const c = room.add('c'); await until(() => c.getState().ready);
  assert.deepEqual(c.getState().snapshot.instances, b.getState().snapshot.instances);
  const rotated = { ...chair('armchair'), yawDeg: 90 };
  await c.apply({ before: chair('armchair'), after: rotated });
  await assert.rejects(b.apply({ before: chair('armchair'), after: { ...chair('armchair'), xMm: 15 } }), /Another editor/);
  room.remove('a'); await until(() => b.getState().ready && c.getState().ready);
  assert.equal(b.getState().coordinatorId, 'b');
  api.discardResponse = true;
  const result = await c.save({ branch: 'study-option', fork: true });
  await until(() => c.getState().head === result.head && b.getState().head === result.head);
  assert.equal(result.sequence, 3); assert.equal(api.branches.get('main'), 'first');
  assert.equal(b.getState().dirty, false); assert.equal(c.getState().snapshot.instances.length, 2);
  assert.equal(room.design.head, result.head);
});

test('save captures one sequence boundary; subsequent edits survive in each local journal', async t => {
  const api = server(), room = session(api); t.after(() => room.close());
  const a = room.add('a'), b = room.add('b'); await until(() => a.getState().ready && b.getState().ready);
  await a.apply({ before: null, after: chair('one') });
  let release;
  api.hold = new Promise(resolve => { release = resolve; });
  const save = b.save(); await until(() => api.dispatched);
  await b.apply({ before: null, after: chair('two') });
  release();
  const result = await save;
  await until(() => b.getState().head === result.head);
  assert.equal(api.commits.get(result.head).instances.length, 1);
  for (const peer of [a,b]) { assert.equal(peer.getState().snapshot.instances.length, 2); assert.equal(peer.getState().dirty, true); }
});

test('stale branch preserves local edits for a fork; page refresh restores personal pending work', async () => {
  const api = server(), storage = memory(), tabStorage = memory(), alice = replica(api), bob = replica(api, { storage, tabStorage });
  await alice.apply({ before: null, after: chair('a') }); await alice.save();
  await bob.apply({ before: null, after: chair('b') });
  await assert.rejects(bob.save(), /branch moved/);
  const restored = replica(api, { storage, tabStorage });
  assert.deepEqual(restored.getState().snapshot.instances, [chair('b')]); assert.equal(restored.getState().head, 'first');
  const fork = await restored.save({ fork: true, branch: 'other' }); assert.equal(api.branches.get('other'), fork.head);
});

test('a participant can finish an already-requested save after the coordinator leaves in flight', async t => {
  const api = server(), room = session(api); t.after(() => room.close());
  const a = room.add('a'), b = room.add('b'); await until(() => a.getState().ready && b.getState().ready);
  await b.apply({ before: null, after: chair('one') });
  let release;
  api.hold = new Promise(resolve => { release = resolve; });
  const request = b.save(); await until(() => api.dispatched && b.getState().saving);
  await b.apply({ before: null, after: chair('two') });
  room.remove('a'); await until(() => b.getState().ready);
  release(); const result = await request;
  assert.equal(api.commits.size, 2); assert.equal(b.getState().head, result.head);
  assert.deepEqual(b.getState().snapshot.instances, [chair('one'), chair('two')]); assert.equal(b.getState().dirty, true);
});

test('remote editor receives typed branch conflicts and can fork without dropping the draft', async t => {
  const api = server(), room = session(api); t.after(() => room.close());
  const a = room.add('a'), b = room.add('b'); await until(() => a.getState().ready && b.getState().ready);
  await replica(api).save(); await b.apply({ before: null, after: chair('mine') });
  await assert.rejects(b.save(), error => error.code === 'branch_conflict' && error.status === 409);
  assert.deepEqual(b.getState().snapshot.instances, [chair('mine')]);
  assert.equal((await b.save({ fork: true, branch: 'alternative' })).branch, 'alternative');
});

test('explicit historical view bypasses personal edits and a new tab can recover the closed draft', async () => {
  const api = server(), storage = memory(), tabStorage = memory(), a = replica(api, { storage, tabStorage });
  await a.apply({ before: null, after: chair('recover-me') });
  const history = replica(api, { storage, tabStorage, historical: true });
  assert.equal(history.getState().dirty, false);
  const fresh = replica(api, { storage, tabStorage: memory() });
  const [source] = fresh.recoverableDrafts();
  fresh.recoverAsPersonal(source.source);
  assert.deepEqual(fresh.getState().snapshot.instances, [chair('recover-me')]);
  assert.notEqual(fresh.getState().sessionId, a.getState().sessionId);
  assert.equal((await fresh.save({ fork: true, branch: 'recovered' })).branch, 'recovered');
});
