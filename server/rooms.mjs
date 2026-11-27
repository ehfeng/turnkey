import {
  COLLABORATION_PROTOCOL_VERSION, supportsCollaborationProtocol, INCOMPATIBLE_ROOM_MESSAGE,
  validDesignBase, validDesignHead, newRoomDesign, acceptsDesignJoin, electDesignCoordinator, roomDesignFields,
} from '../shared/collaboration-protocol.mjs';
import { randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { WebSocketServer, WebSocket } from 'ws';

const MAX_MESSAGE = 64 * 1024;
const MAX_ROOM_PEERS = 12;
const MAX_ROOMS = 1000;
const LEASE_MS = 15000;
const IDLE_MS = 60 * 60 * 1000;
const id = (bytes = 18) => randomBytes(bytes).toString('base64url');
const isObject = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const bounded = value => {
  try { return JSON.stringify(value).length <= 16000; } catch { return false; }
};
function sameOrigin(req, allowedOrigin) {
  if (!req.headers.origin) return true;
  if (allowedOrigin && req.headers.origin === allowedOrigin) return true;
  try { return new URL(req.headers.origin).host === req.headers.host; } catch { return false; }
}
const matches = (a, b) => {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  const x = Buffer.from(a), y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
};

// One instance is shared by the HTTP and WebSocket handlers for a server.
export function createRoomService({ allowedOrigin = process.env.TURNKEY_ALLOWED_ORIGIN } = {}) {
  const rooms = new Map();
  const wss = new WebSocketServer({ noServer: true, maxPayload: MAX_MESSAGE });
  const send = (socket, message) => {
    if (socket.readyState !== WebSocket.OPEN) return;
    if (socket.bufferedAmount >= MAX_MESSAGE * 4) return socket.terminate();
    socket.send(JSON.stringify(message));
  };
  const broadcast = (room, message, except) => {
    for (const peer of room.peers.values()) if (peer.socket !== except) send(peer.socket, message);
  };
  const setLease = (room, lease) => {
    room.lease = lease;
    broadcast(room, { type: 'lease', lease });
  };
  const expireLease = room => {
    if (room.lease && room.lease.expiresAt <= Date.now()) setLease(room, null);
  };
  const publicPeer = peer => ({ peerId: peer.peerId, name: peer.name, icon: peer.icon, role: peer.role });
  const error = (socket, code, message) => send(socket, { type: 'error', code, message });
  const cleanup = setInterval(() => {
    const now = Date.now();
    for (const [key, room] of rooms) {
      expireLease(room);
      if (!room.peers.size && now - room.updatedAt > IDLE_MS) rooms.delete(key);
    }
  }, 1000);
  cleanup.unref();
  const heartbeat = setInterval(() => {
    for (const socket of wss.clients) {
      if (!socket.alive) { socket.terminate(); continue; }
      socket.alive = false;
      socket.ping();
    }
  }, 30000);
  heartbeat.unref();

  function handleHttp(req, res, next) {
    const path = new URL(req.url, 'http://localhost').pathname;
    if (path !== '/api/rooms') return next?.();
    if (req.headers.origin && sameOrigin(req, allowedOrigin)) { res.setHeader('Access-Control-Allow-Origin', req.headers.origin); res.setHeader('Vary', 'Origin'); }
    if (req.method === 'OPTIONS' && sameOrigin(req, allowedOrigin)) { res.writeHead(204, { 'Access-Control-Allow-Methods': 'POST, OPTIONS', 'Access-Control-Allow-Headers': 'Content-Type, Authorization' }); return res.end(); }
    if (req.method !== 'POST') { res.writeHead(405, { Allow: 'POST' }); return res.end(); }
    if (!sameOrigin(req, allowedOrigin)) { res.writeHead(403); return res.end(); }
    let body = '', tooLarge = false;
    req.on('data', chunk => { if (!tooLarge) { body += chunk; if (body.length > MAX_MESSAGE) { tooLarge = true; body = ''; } } });
    req.on('end', () => {
      if (tooLarge) { res.writeHead(413); return res.end(); }
      let input;
      try { input = body ? JSON.parse(body) : {}; } catch { res.writeHead(400); return res.end(); }
      if (!isObject(input) || (input.view != null && (!isObject(input.view) || !bounded(input.view)))) { res.writeHead(400); return res.end(); }
      if (input.design != null && !validDesignBase(input.design)) { res.writeHead(400); return res.end('A design session needs its project, branch and HEAD.'); }
      if (!supportsCollaborationProtocol(input.protocolVersion)) { res.writeHead(409); return res.end(INCOMPATIBLE_ROOM_MESSAGE); }
      if (rooms.size >= MAX_ROOMS) { res.writeHead(503); return res.end(); }
      const room = id(12), token = id(24);
      const design = input.design ? newRoomDesign(input.design, randomUUID()) : null;
      rooms.set(room, { token, design, protocolVersion: COLLABORATION_PROTOCOL_VERSION, revision: typeof input.revision === 'string' ? input.revision.slice(0, 80) : null, peers: new Map(), view: input.view ?? null, viewSeq: null, viewEpoch: null, viewFrom: null, lease: null, updatedAt: Date.now() });
      res.writeHead(201, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
      res.end(JSON.stringify({ room, token, ...roomDesignFields({ design }) }));
    });
  }
  function handleUpgrade(req, socket, head) {
    if (new URL(req.url, 'http://localhost').pathname !== '/api/rooms/ws') return false;
    if (!sameOrigin(req, allowedOrigin)) { socket.write('HTTP/1.1 403 Forbidden\r\n\r\n'); socket.destroy(); return true; }
    wss.handleUpgrade(req, socket, head, ws => wss.emit('connection', ws, req));
    return true;
  }
  wss.on('connection', socket => {
    socket.alive = true;
    socket.on('pong', () => { socket.alive = true; });
    let room, peer;
    const joinTimeout = setTimeout(() => socket.close(1008, 'Join required'), 10000);
    joinTimeout.unref();
    socket.on('error', () => {});
    socket.on('message', raw => {
      let message;
      try { message = JSON.parse(raw.toString()); } catch { return error(socket, 'invalid-message', 'Expected JSON'); }
      if (!isObject(message) || typeof message.type !== 'string') return error(socket, 'invalid-message', 'Expected a message type');
      if (!peer) {
        if (message.type !== 'join' || typeof message.room !== 'string') return error(socket, 'join-required', 'Join a room first');
        room = rooms.get(message.room);
        if (!room || !matches(room.token, message.token)) { error(socket, 'invalid-invite', 'Invalid room or invite'); return socket.close(1008, 'Invalid invite'); }
        if (!acceptsDesignJoin(room.design, message.design)) {
          error(socket, 'invalid-invite', 'This invitation must identify the design session and its HEAD.');
          return socket.close(1008, 'Invalid design invitation');
        }
        if (!supportsCollaborationProtocol(room.protocolVersion) || !supportsCollaborationProtocol(message.protocolVersion)) {
          error(socket, 'revision-mismatch', INCOMPATIBLE_ROOM_MESSAGE);
          return socket.close(1008, 'Incompatible protocol');
        }
        if (room.peers.size >= MAX_ROOM_PEERS) { error(socket, 'room-full', 'Room is full'); return socket.close(1008, 'Room full'); }
        const name = typeof message.name === 'string' ? message.name.trim().slice(0, 80) : '';
        const icon = typeof message.icon === 'string' ? message.icon.slice(0, 32) : '';
        peer = { socket, peerId: id(12), name: name || 'Guest', icon, role: room.peers.size ? 'guest' : 'host' };
        clearTimeout(joinTimeout);
        expireLease(room);
        const peers = [...room.peers.values()].map(publicPeer);
        room.peers.set(peer.peerId, peer);
        room.updatedAt = Date.now();
        electDesignCoordinator(room.design, [...room.peers.keys()]);
        send(socket, { type: 'joined', peerId: peer.peerId, role: peer.role, peers, view: room.view, viewSeq: room.viewSeq, viewEpoch: room.viewEpoch, viewFrom: room.viewFrom, lease: room.lease, ...roomDesignFields(room) });
        broadcast(room, { type: 'peer-joined', peer: publicPeer(peer), ...roomDesignFields(room) }, socket);
        return;
      }
      room.updatedAt = Date.now();
      expireLease(room);
      if (message.type === 'design-head') {
        if (room.design?.coordinatorId !== peer.peerId || !validDesignHead(message)) return error(socket, 'invalid-design-head', 'Only the current coordinator can declare a saved branch and HEAD.');
        Object.assign(room.design, { head: message.head, branch: message.branch });
        broadcast(room, { type: 'design-state', design: room.design });
      } else if (message.type === 'lease-request' || message.type === 'lease-renew') {
        if (message.type === 'lease-renew' && !room.lease) return;
        if (!room.lease || room.lease.peerId === peer.peerId) setLease(room, { peerId: peer.peerId, expiresAt: Date.now() + LEASE_MS, epoch: room.lease?.epoch ?? id(12) });
        else error(socket, 'lease-held', 'Another participant is steering');
      } else if (message.type === 'lease-release') {
        if (room.lease?.peerId === peer.peerId) setLease(room, null);
      } else if (message.type === 'view') {
        if (room.lease?.peerId !== peer.peerId) return error(socket, 'lease-required', 'Request the steering lease first');
        if (!Number.isSafeInteger(message.seq) || message.seq < 0 || message.epoch !== room.lease.epoch || (room.viewEpoch === message.epoch && message.seq <= room.viewSeq)) return error(socket, 'invalid-sequence', 'Invalid view sequence');
        if (!isObject(message.view) || !bounded(message.view)) return error(socket, 'invalid-view', 'Invalid view');
        room.view = message.view;
        room.viewSeq = message.seq; room.viewEpoch = message.epoch; room.viewFrom = peer.peerId;
        broadcast(room, { type: 'view', from: peer.peerId, view: room.view, seq: message.seq, epoch: message.epoch }, socket);
      } else if (message.type === 'cursor') {
        if (!isObject(message.cursor) || !bounded(message.cursor)) return error(socket, 'invalid-cursor', 'Invalid cursor');
        broadcast(room, { type: 'cursor', from: peer.peerId, cursor: message.cursor }, socket);
      } else if (message.type === 'signal' || message.type === 'relay') {
        if (!isObject(message.data) || !bounded(message.data)) return error(socket, 'invalid-data', 'Invalid data');
        const payload = { type: message.type, from: peer.peerId, data: message.data };
        if (typeof message.to === 'string') {
          const target = room.peers.get(message.to);
          if (target && target !== peer) send(target.socket, payload);
        } else if (message.type === 'relay') broadcast(room, payload, socket);
      } else error(socket, 'unknown-type', 'Unknown message type');
    });
    socket.on('close', () => {
      clearTimeout(joinTimeout);
      if (!peer) return;
      room.peers.delete(peer.peerId);
      room.updatedAt = Date.now();
      if (room.lease?.peerId === peer.peerId) setLease(room, null);
      electDesignCoordinator(room.design, [...room.peers.keys()]);
      broadcast(room, { type: 'peer-left', peerId: peer.peerId, ...roomDesignFields(room) });
    });
  });
  function close() { clearInterval(cleanup); clearInterval(heartbeat); for (const client of wss.clients) client.terminate(); wss.close(); }
  return { handleHttp, handleUpgrade, close };
}

export function roomServicePlugin(options) {
  function attach(server) {
    const service = createRoomService(options);
    server.middlewares.use(service.handleHttp);
    server.httpServer?.on('upgrade', service.handleUpgrade);
    server.httpServer?.on('close', service.close);
  }
  return { name: 'turnkey-rooms', configureServer: attach, configurePreviewServer: attach };
}
