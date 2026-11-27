import { COLLABORATION_PROTOCOL_VERSION } from '../shared/collaboration-protocol.mjs';

// Camera views and steering leases are coordinated by the signaling service.
// Live views and cursors use peer channels where available; views are also persisted over WebSocket.
const VIEW_INTERVAL_MS = 1000 / 30;
const CURSOR_SETTLE_MS = 180;
// Limit queued movement on slow links. Control, final pose, and hide messages stay reliable.
const BUFFER_LIMIT = 8192;

export function createCollaboration({ room, token, revision, design, protocolVersion = COLLABORATION_PROTOCOL_VERSION, name = '', icon = '', signalingUrl, iceServers = [], onState = () => {}, onSnapshot = () => {}, onCursor = () => {}, onDesign = () => {}, onPreview = () => {}, onStatus = () => {} }) {
  let socket = null;
  let stopped = true;
  let retryTimer = null;
  let renewTimer = null;
  let attempts = 0;
  let sequence = 0;
  let pendingView = null;
  let viewTimer = null;
  let lastViewSentAt = -Infinity;
  let cursorSequence = 0;
  let cursorTimer = null;
  const cursorSequences = new Map();
  let lastEpoch = null;
  let lastSequence = -1;
  let state = { peerId: null, role: null, peers: [], lease: null };
  const connections = new Map();
  // Split large late-join snapshots for both WebRTC and the bounded relay.
  const assemblies = new Map(), queues = new Map();
  function dropQueue(id) {
    const queue = queues.get(id);
    if (queue) clearTimeout(queue.timer);
    queues.delete(id);
  }
  function pump(id, queue) {
    queue.timer = null;
    if (socket?.readyState !== WebSocket.OPEN || !state.peers.some(peer => peer.id === id)) { dropQueue(id); return; }
    // Yield between chunks so a large catch-up cannot overflow a receiving socket.
    for (let count = 0; count < 4 && queue.parts.length; count++) {
      const part = queue.parts[0], channel = connections.get(id)?.reliable;
      if (!sendToPeer(channel, JSON.stringify(part))) {
        if (socket.bufferedAmount > BUFFER_LIMIT * 4 || !send({ type: 'relay', to: id, data: part })) break;
      }
      queue.parts.shift();
    }
    if (queue.parts.length) queue.timer = setTimeout(() => pump(id, queue), 8);
    else queues.delete(id);
  }
  const chunkChars = 2000;
  const maxDesignChars = 4 * 1024 * 1024;
  function acceptDesign(data, from) {
    if (!design || !state.peers.some(peer => peer.id === from)) return;
    if (data?.type === 'design-preview') { onPreview(data.instance, from); return; }
    if (data?.type === 'design-message') { onDesign(data.message, from); return; }
    if (data?.type !== 'design-chunk' || typeof data.id !== 'string' || data.id.length > 64 ||
        !Number.isInteger(data.total) || data.total < 1 || data.total > Math.ceil(maxDesignChars / chunkChars) ||
        !Number.isInteger(data.index) || data.index < 0 || data.index >= data.total ||
        typeof data.text !== 'string' || data.text.length > chunkChars) return;
    const key = from + '/' + data.id;
    let assembly = assemblies.get(key);
    if (!assembly) {
      if (assemblies.size >= 20) assemblies.delete(assemblies.keys().next().value);
      assemblies.set(key, assembly = { chunks: new Map(), total: data.total });
    }
    if (data.total !== assembly.total) return;
    assembly.chunks.set(data.index, data.text);
    if (assembly.chunks.size === assembly.total) {
      assemblies.delete(key);
      const encoded = Array.from({ length: assembly.total }, (_, i) => assembly.chunks.get(i)).join('');
      try { onDesign(JSON.parse(encoded), from); } catch { /* Ignore an invalid transfer. */ }
    }
  }
  const publish = () => onState({ ...state, peers: state.peers.map(peer => ({ ...peer })) });
  const status = (value, message, fatal = false) => onStatus({ status: value, fatal, ...(message ? { message } : {}) });
  const send = message => {
    if (socket?.readyState !== WebSocket.OPEN) return false;
    socket.send(JSON.stringify(message));
    return true;
  };
  function sendToPeer(channel, encoded) {
    if (channel?.readyState !== 'open' || channel.bufferedAmount > BUFFER_LIMIT) return false;
    try { channel.send(encoded); return true; }
    catch { return false; }
  }
  function clearViewQueue() {
    clearTimeout(viewTimer);
    viewTimer = null;
    pendingView = null;
    lastViewSentAt = -Infinity;
  }
  function flushView(force = false) {
    clearTimeout(viewTimer);
    viewTimer = null;
    if (!pendingView) return;
    const { message } = pendingView;
    if (!pendingView.sentToPeers) {
      const encoded = JSON.stringify(message);
      for (const { channel } of connections.values()) sendToPeer(channel, encoded);
      pendingView.sentToPeers = true;
    }
    lastViewSentAt = performance.now();
    if (force || socket?.bufferedAmount <= BUFFER_LIMIT) {
      send(message);
      pendingView = null;
    } else {
      viewTimer = setTimeout(flushView, VIEW_INTERVAL_MS);
    }
  }
  function clearMotion() {
    clearViewQueue();
    clearTimeout(cursorTimer);
    cursorTimer = null;
    cursorSequences.clear();
    for (const id of queues.keys()) dropQueue(id);
    assemblies.clear();
  }
  function acceptCursor(cursor, from) {
    if (typeof cursor?.visible !== 'boolean' || !state.peers.some(peer => peer.id === from)) return;
    const previousSequence = cursorSequences.get(from);
    if (cursor.seq === undefined) {
      // Early viewers sent unnumbered positions and pointer-leave events.
      if (previousSequence !== undefined) return;
    } else {
      if (!Number.isSafeInteger(cursor.seq) || cursor.seq <= (previousSequence ?? -1)) return;
      cursorSequences.set(from, cursor.seq);
    }
    onCursor(cursor, from);
  }
  const normalize = peer => ({ id: peer.peerId, name: peer.name || '', icon: peer.icon || '', role: peer.role });
  const closePeer = id => {
    const entry = connections.get(id);
    if (!entry) return;
    connections.delete(id);
    entry.channel?.close();
    entry.reliable?.close();
    for (const key of assemblies.keys()) if (key.startsWith(id + '/')) assemblies.delete(key);
    entry.pc.close();
  };
  const closePeers = () => { for (const id of [...connections.keys()]) closePeer(id); };
  const attachChannel = (id, entry, channel, label = channel.label) => {
    if (label === 'design') entry.reliable = channel;
    else entry.channel = channel;
    channel.onmessage = event => {
      try {
        const message = JSON.parse(event.data);
        if (connections.get(id) !== entry) return;
        if (label === 'design' || message.type === 'design-preview') acceptDesign(message, id);
        else if (message.type === 'cursor') acceptCursor(message.cursor, id);
        else if (message.type === 'view') acceptView(message, id);
      } catch { /* Ignore malformed peer traffic. */ }
    };
  };
  const connectPeer = async (id, initiate) => {
    if (!id || id === state.peerId || connections.has(id) || typeof RTCPeerConnection === 'undefined') return;
    let pc;
    try { pc = new RTCPeerConnection({ iceServers }); } catch { return; }
    const entry = { pc, channel: null, candidates: [] };
    connections.set(id, entry);
    pc.onicecandidate = event => { if (event.candidate) send({ type: 'signal', to: id, data: { candidate: event.candidate } }); };
    pc.ondatachannel = event => attachChannel(id, entry, event.channel);
    pc.onconnectionstatechange = () => {
      if (pc.connectionState === 'failed' || pc.connectionState === 'closed') closePeer(id);
    };
    if (initiate) {
      try {
        if (design) attachChannel(id, entry, pc.createDataChannel('design', { ordered: true }), 'design');
        attachChannel(id, entry, pc.createDataChannel('cursor', { ordered: false, maxRetransmits: 0 }));
        await pc.setLocalDescription(await pc.createOffer());
        send({ type: 'signal', to: id, data: { description: pc.localDescription } });
      } catch { closePeer(id); }
    }
  };
  const handleSignal = async (from, data) => {
    if (!from || !data) return;
    if (!connections.has(from)) await connectPeer(from, false);
    const entry = connections.get(from);
    if (!entry) return;
    try {
      if (data.description) {
        await entry.pc.setRemoteDescription(data.description);
        for (const candidate of entry.candidates.splice(0)) await entry.pc.addIceCandidate(candidate);
        if (data.description.type === 'offer') {
          await entry.pc.setLocalDescription(await entry.pc.createAnswer());
          send({ type: 'signal', to: from, data: { description: entry.pc.localDescription } });
        }
      } else if (data.candidate) {
        if (entry.pc.remoteDescription) await entry.pc.addIceCandidate(data.candidate);
        else entry.candidates.push(data.candidate);
      }
    } catch { closePeer(from); }
  };
  const acceptView = (message, from) => {
    if (!state.lease || state.lease.peerId !== from || state.lease.epoch !== message.epoch || !Number.isSafeInteger(message.seq) || message.seq < 0) return;
    if (lastEpoch !== message.epoch) { lastEpoch = message.epoch; lastSequence = -1; }
    if (message.seq <= lastSequence) return;
    lastSequence = message.seq;
    onSnapshot(message.view, from);
  };
  const handle = message => {
    switch (message.type) {
      case 'joined':
        attempts = 0;
        state = { peerId: message.peerId, role: message.role, peers: (message.peers || []).map(normalize), lease: message.lease || null, design: message.design };
        lastEpoch = message.viewEpoch || null;
        lastSequence = Number.isSafeInteger(message.viewSeq) ? message.viewSeq : -1;
        sequence = 0;
        publish();
        if (message.view != null) onSnapshot(message.view, message.viewFrom || null);
        status('connected');
        for (const peer of state.peers) connectPeer(peer.id, state.peerId < peer.id);
        break;
      case 'peer-joined': {
        const peer = normalize(message.peer);
        if (message.design) state.design = message.design;
        state.peers = [...state.peers.filter(item => item.id !== peer.id), peer];
        publish();
        connectPeer(peer.id, state.peerId < peer.id);
        break;
      }
      case 'peer-left':
        if (message.design) state.design = message.design;
        if (design) onPreview(null, message.peerId);
        cursorSequences.delete(message.peerId);
        dropQueue(message.peerId);
        closePeer(message.peerId);
        state.peers = state.peers.filter(peer => peer.id !== message.peerId);
        publish();
        break;
      case 'design-state': state.design = message.design; publish(); break;
      case 'relay': acceptDesign(message.data, message.from); break;
      case 'signal': handleSignal(message.from, message.data); break;
      case 'lease':
        if (state.lease?.epoch !== message.lease?.epoch) { clearViewQueue(); sequence = 0; lastEpoch = null; lastSequence = -1; }
        state.lease = message.lease || null; publish(); break;
      case 'view': acceptView(message, message.from); break;
      case 'cursor':
        acceptCursor(message.cursor, message.from);
        break;
      case 'error':
        if (message.code === 'invalid-invite' || message.code === 'room-full' || message.code === 'revision-mismatch') {
          stopped = true; clearInterval(renewTimer); renewTimer = null;
          socket?.close();
        }
        status('error', message.message || message.code, stopped); break;
    }
  };
  const open = () => {
    if (stopped) return;
    status(attempts ? 'reconnecting' : 'connecting');
    const url = signalingUrl || `${location.protocol === 'https:' ? 'wss:' : 'ws:'}//${location.host}/api/rooms/ws`;
    const endpoint = new URL(url);
    endpoint.searchParams.set('room', room);
    try { socket = new WebSocket(endpoint); } catch (error) { status('error', error.message); scheduleReconnect(); return; }
    const current = socket;
    current.onopen = () => { if (current === socket && !stopped) send({ type: 'join', room, token, revision, protocolVersion, name, icon, ...(design ? { design } : {}) }); };
    current.onmessage = event => { if (current !== socket || stopped) return; try { handle(JSON.parse(event.data)); } catch { /* Ignore malformed messages. */ } };
    current.onerror = () => { if (current === socket && !stopped) status('error', 'Connection interrupted'); };
    current.onclose = () => {
      if (current !== socket) return;
      clearMotion();
      closePeers();
      state = { peerId: null, role: null, peers: [], lease: null };
      publish();
      if (!stopped) scheduleReconnect();
    };
  };
  function scheduleReconnect() {
    if (stopped || retryTimer) return;
    status('reconnecting');
    const delay = Math.min(1000 * 2 ** attempts++, 15000);
    retryTimer = setTimeout(() => { retryTimer = null; open(); }, delay);
  }
  return {
    start() {
      if (!stopped) return;
      stopped = false;
      renewTimer = setInterval(() => {
        if (state.lease?.peerId === state.peerId && state.peerId) send({ type: 'lease-renew' });
      }, 5000);
      open();
    },
    stop() {
      stopped = true;
      clearTimeout(retryTimer); retryTimer = null;
      clearInterval(renewTimer); renewTimer = null;
      if (state.lease?.peerId === state.peerId && state.peerId) {
        flushView(true);
        send({ type: 'lease-release' });
      }
      const current = socket; socket = null;
      current?.close();
      clearMotion();
      closePeers();
      state = { peerId: null, role: null, peers: [], lease: null };
      publish(); status('disconnected');
    },
    sendSnapshot(view) {
      if (!state.peerId || state.lease?.peerId !== state.peerId) return false;
      const message = { type: 'view', view, seq: sequence++, epoch: state.lease.epoch };
      pendingView = { message, sentToPeers: false };
      const wait = VIEW_INTERVAL_MS - (performance.now() - lastViewSentAt);
      if (wait <= 0) flushView();
      else if (viewTimer === null) viewTimer = setTimeout(flushView, wait);
      return true;
    },
    sendCursor(cursor) {
      clearTimeout(cursorTimer);
      cursorTimer = null;
      if (!state.peerId || !state.peers.length) return;
      const message = { type: 'cursor', cursor: { ...cursor, seq: cursorSequence++ } };
      const encoded = JSON.stringify(message);
      let needsRelay = false;
      for (const peer of state.peers) {
        if (!sendToPeer(connections.get(peer.id)?.channel, encoded)) needsRelay = true;
      }
      if (!cursor.visible || (needsRelay && socket?.bufferedAmount <= BUFFER_LIMIT)) {
        send(message);
      } else {
        // One reliable copy after the pointer stops covers a dropped final peer packet.
        cursorTimer = setTimeout(() => { cursorTimer = null; send(message); }, CURSOR_SETTLE_MS);
      }
    },
    sendDesign(to, message) {
      if (!design || !state.peerId || !state.peers.some(peer => peer.id === to)) return false;
      const encoded = JSON.stringify(message);
      if (encoded.length > maxDesignChars) return false;
      const queue = queues.get(to) ?? { parts: [], timer: null };
      if (queue.parts.length > 4 * Math.ceil(maxDesignChars / chunkChars)) return false;
      queues.set(to, queue);
      if (encoded.length <= chunkChars) queue.parts.push({ type: 'design-message', message });
      else {
        const id = crypto.randomUUID(), total = Math.ceil(encoded.length / chunkChars);
        for (let i = 0; i < total; i++) queue.parts.push({
          type: 'design-chunk', id, index: i, total, text: encoded.slice(i * chunkChars, (i + 1) * chunkChars)
        });
      }
      if (queue.timer === null) pump(to, queue);
      return true;
    },
    sendDesignPreview(instance) {
      if (!design || !state.peerId) return;
      const data = { type: 'design-preview', instance };
      for (const peer of state.peers) {
        if (!sendToPeer(connections.get(peer.id)?.channel, JSON.stringify(data))) send({ type: 'relay', to: peer.id, data });
      }
    },
    declareHead(head, branch) {
      if (!design) return;
      Object.assign(design, { head, branch });
      send({ type: 'design-head', head, branch });
    },
    requestControl() { return send({ type: 'lease-request' }); },
    releaseControl() {
      flushView(true);
      return send({ type: 'lease-release' });
    },
  };
}
