import assert from 'node:assert/strict';
import { on, once } from 'node:events';
import { createServer } from 'node:http';
import { test } from 'node:test';
import { WebSocket } from 'ws';
import { createRoomService } from '../server/rooms.mjs';

test('a design room declares its HEAD and hands coordination to the oldest remaining editor', { timeout: 8000 }, async t => {
  const service = createRoomService();
  const server = createServer(service.handleHttp);
  server.on('upgrade', service.handleUpgrade);
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => { service.close(); server.close(); });
  const base = 'http://127.0.0.1:' + server.address().port;
  const create = design => fetch(base + '/api/rooms', {
    method: 'POST', body: JSON.stringify({ design }),
  });
  const invalid = await create({ projectId: 'home', branch: 'main' });
  assert.equal(invalid.status, 400);
  const response = await create({ projectId: 'home', branch: 'main', head: 'first' });
  assert.equal(response.status, 201);
  const invite = await response.json();
  assert.match(invite.design.sessionId, /^[\da-f-]{36}$/);
  assert.equal(invite.design.head, 'first');
  const join = async (credentials, design) => {
    const ws = new WebSocket(base.replace('http:', 'ws:') + '/api/rooms/ws');
    const messages = on(ws, 'message');
    const send = message => ws.send(JSON.stringify(message));
    async function next(type) {
      for (;;) {
        const { value: [data] } = await messages.next();
        const message = JSON.parse(data);
        if (message.type === type) return message;
      }
    }
    await once(ws, 'open');
    send({ type: 'join', token: credentials.token, room: credentials.room, design });
    return { ws, next, send };
  };

  const missingHead = await join(invite, { sessionId: invite.design.sessionId });
  assert.equal((await missingHead.next('error')).code, 'invalid-invite');
  const wrongSession = await join(invite, { ...invite.design, sessionId: 'another' });
  assert.equal((await wrongSession.next('error')).code, 'invalid-invite');
  const first = await join(invite, invite.design);
  const firstJoin = await first.next('joined');
  assert.equal(firstJoin.design.coordinatorId, firstJoin.peerId);
  assert.equal(firstJoin.design.term, 1);

  const second = await join(invite, invite.design);
  const secondJoin = await second.next('joined');
  second.send({ type: 'design-head', head: 'absent', branch: 'main' });
  assert.equal((await second.next('error')).code, 'invalid-design-head');
  first.send({ type: 'design-head', head: 'second', branch: 'kitchen' });
  const declared = (await second.next('design-state')).design;
  assert.equal(declared.head, 'second');
  assert.equal(declared.branch, 'kitchen');

  const third = await join(invite, invite.design);
  assert.deepEqual((await third.next('joined')).design, declared);
  first.ws.close();
  const nextCoordinator = (await third.next('peer-left')).design;
  assert.equal(nextCoordinator.coordinatorId, secondJoin.peerId);
  assert.equal(nextCoordinator.term, 2);
  assert.equal(nextCoordinator.head, 'second');
  second.send({ type: 'design-head', head: 'third', branch: 'kitchen' });
  assert.equal((await third.next('design-state')).design.head, 'third');

  const review = await (await create()).json();
  const reviewer = await join(review);
  assert.equal((await reviewer.next('joined')).design, undefined);
});
