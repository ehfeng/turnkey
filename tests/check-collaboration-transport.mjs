import assert from 'node:assert/strict';
import { test } from 'node:test';
import { COLLABORATION_PROTOCOL_VERSION } from '../shared/collaboration-protocol.mjs';
import { createCollaboration } from '../preview/collaboration-transport.mjs';

function setup(t, options = {}) {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval'] });
  const receiver = { cursors: [], views: [], design: [] };
  const channels = new Map();
  let socket, channel;
  class TestSocket {
    static OPEN = 1;
    readyState = TestSocket.OPEN;
    bufferedAmount = 0;
    sent = [];
    constructor() { socket = this; }
    send(data) { this.sent.push(JSON.parse(data)); }
    receive(message) { this.onmessage({ data: JSON.stringify(message) }); }
    close() { this.readyState = 3; }
  }
  class TestPeer {
    createDataChannel(label, config) {
      channel = {
        readyState: 'open', bufferedAmount: 0, sent: [],
        send(data) { this.sent.push(JSON.parse(data)); },
        receive(message) { this.onmessage({ data: JSON.stringify(message) }); },
        close() { this.readyState = 'closed'; }
      };
      channels.set(label, { channel, config });
      return channel;
    }
    async createOffer() { return { type: 'offer' }; }
    async setLocalDescription(description) { this.localDescription = description; }
    close() {}
  }
  const originalSocket = globalThis.WebSocket, originalPeer = globalThis.RTCPeerConnection;
  globalThis.WebSocket = TestSocket;
  globalThis.RTCPeerConnection = TestPeer;
  const session = createCollaboration({
    ...options, signalingUrl: 'wss://example.test/ws', room: 'example',
    onDesign: (data, from) => receiver.design.push({ data, from }),
    onCursor: cursor => receiver.cursors.push(cursor), onSnapshot: view => receiver.views.push(view)
  });
  session.start();
  socket.onopen();
  socket.receive({ type: 'joined', peerId: 'a', peers: [{ peerId: 'b' }] });
  t.after(() => {
    session.stop();
    globalThis.WebSocket = originalSocket;
    globalThis.RTCPeerConnection = originalPeer;
  });
  return { receiver, socket, channel, channels, session };
}

test('a lost final cursor converges, and a late RTC sample cannot undo a reliable hide', t => {
  const { session, channel, socket, receiver } = setup(t);
  session.sendCursor({ x: 0.4, y: 0.6, visible: true });
  t.mock.timers.tick(200);
  const resting = socket.sent.find(message => message.type === 'cursor');
  assert.deepEqual(resting, channel.sent[0]);
  socket.receive({ ...resting, from: 'b' });
  channel.receive(resting);
  session.sendCursor({ visible: false });
  const hidden = socket.sent.at(-1);
  assert.equal(hidden.cursor.visible, false);
  socket.receive({ ...hidden, from: 'b' });
  channel.receive(resting);
  assert.deepEqual(receiver.cursors, [resting.cursor, hidden.cursor]);
});

test('congested camera updates coalesce and the last pose precedes lease release', t => {
  const { session, socket, channel } = setup(t);
  socket.receive({ type: 'lease', lease: { peerId: 'a', epoch: 'gesture' } });
  socket.bufferedAmount = 1000000;
  channel.bufferedAmount = 1000000;
  for (let frame = 0; frame <= 40; frame++) session.sendSnapshot({ frame });
  t.mock.timers.tick(100);
  assert.equal(socket.sent.filter(message => message.type === 'view').length, 0);
  assert.deepEqual(channel.sent, []);
  session.releaseControl();
  assert.deepEqual(socket.sent.slice(-2).map(message => message.type), ['view', 'lease-release']);
  assert.equal(socket.sent.at(-2).view.frame, 40);
  t.mock.timers.tick(200);
  assert.equal(socket.sent.at(-1).type, 'lease-release');
});

test('a delayed camera sample cannot rewind a view or cross a steering handoff', t => {
  const { receiver, socket, channel } = setup(t);
  socket.receive({ type: 'lease', lease: { peerId: 'b', epoch: 'first' } });
  const sample = seq => ({ type: 'view', epoch: 'first', seq, from: 'b', view: { frame: seq } });
  channel.receive(sample(2));
  socket.receive(sample(1));
  socket.receive(sample(2));
  socket.receive({ type: 'lease', lease: null });
  channel.receive(sample(3));
  assert.deepEqual(receiver.views, [{ frame: 2 }]);
});

test('join advertises the protocol and receives cursors from an older viewer', t => {
  const { receiver, socket, channel } = setup(t);
  assert.equal(socket.sent[0].type, 'join');
  assert.equal(socket.sent[0].protocolVersion, COLLABORATION_PROTOCOL_VERSION);

  const move = { visible: true, x: 0.2, y: 0.7 };
  const hide = { visible: false };
  const message = cursor => ({ type: 'cursor', from: 'b', cursor });
  channel.receive(message(move));
  socket.receive(message(hide));
  const numbered = { ...move, seq: 0 };
  channel.receive(message(numbered));
  socket.receive(message(hide));
  assert.deepEqual(receiver.cursors, [move, hide, numbered]);
});

test('design messages use a separately ordered peer channel and reassemble across the relay', t => {
  const { session, socket, channels, receiver } = setup(t, { design: { sessionId: 'session', head: 'root' } });
  const { channel, config } = channels.get('design');
  assert.deepEqual(config, { ordered: true });
  assert.deepEqual(socket.sent[0].design, { sessionId: 'session', head: 'root' });
  const short = { kind: 'accepted', sequence: 20 };
  assert.equal(session.sendDesign('b', short), true);
  channel.receive(channel.sent[0]);
  const long = { kind: 'draft', data: '家具'.repeat(14000) };
  channel.bufferedAmount = 100000;
  assert.equal(session.sendDesign('b', long), true);
  for (let i = 0; i < 10; i++) t.mock.timers.tick(10);
  const chunks = socket.sent.filter(message => message.type === 'relay');
  assert.ok(chunks.length > 2);
  for (const chunk of chunks.reverse()) {
    assert.ok(JSON.stringify(chunk.data).length < 16000);
    socket.receive({ ...chunk, from: 'b' });
  }
  assert.equal(receiver.design.length, 2);
  assert.deepEqual(receiver.design[0], { data: short, from: 'b' });
  assert.equal(receiver.design[1].from, 'b');
  assert.equal(receiver.design[1].data.data === long.data, true);
});
