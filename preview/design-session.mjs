// A replica contains one immutable base and the completed gestures since its last save.
// The signaling service elects a coordinator. Only that peer assigns sequence numbers.
const poseFields = ['id', 'roomId', 'assetRevision', 'xMm', 'yMm', 'zMm', 'yawDeg'];
const uid = () => crypto.randomUUID();
const copy = value => structuredClone(value);
const errorMessage = reason => reason instanceof Error ? reason.message : String(reason);
const equalPose = (left, right) => left == null || right == null ? left == null && right == null :
  poseFields.every(field => left[field] === right[field]);

const remoteError = error => ({ message: errorMessage(error), status: error.status, code: error.code, currentHead: error.currentHead });

function applyChange(snapshot, change) {
  const { before, after } = change ?? {};
  const target = before?.id ?? after?.id;
  if (!target || (after && before && before.id !== after.id)) throw new Error('Invalid furniture edit.');
  if (after && (!['id', 'roomId', 'assetRevision'].every(key => typeof after[key] === 'string' && after[key].length > 0) ||
      !['xMm', 'yMm', 'zMm', 'yawDeg'].every(key => Number.isFinite(after[key])))) throw new Error('Invalid furniture placement.');
  const index = snapshot.instances.findIndex(instance => instance.id === target);
  if (!equalPose(snapshot.instances[index], before)) throw new Error('Another editor changed this item. Review its latest placement.');
  const instances = snapshot.instances.slice();
  if (after == null) instances.splice(index, 1);
  else if (index < 0) instances.push(after);
  else instances[index] = after;
  return { ...snapshot, instances };
}

function replay(record) {
  if (record.base?.schemaVersion !== 1 || !Array.isArray(record.base.instances) ||
      !Number.isSafeInteger(record.baseSequence) || record.baseSequence < 0) throw new Error('Invalid draft baseline.');
  let snapshot = record.base, sequence = record.baseSequence;
  for (const edit of record.edits) {
    if (edit.sequence !== ++sequence || typeof edit.id !== 'string') throw new Error('Incomplete draft journal.');
    snapshot = applyChange(snapshot, edit.change);
  }
  return snapshot;
}
const end = record => record.baseSequence + record.edits.length;
const newRecord = (sessionId, branch, head, base, baseSequence = 0) => ({ sessionId, branch, head, base, baseSequence, edits: [] });

export function createDesignSession({ projectId, branch, head, snapshot, getHeaders = () => ({}), fetchImpl = fetch,
  storage, tabStorage, validateChange, historical = false } = {}) {
  if (!projectId || !head || !snapshot) throw new Error('Open a saved design first.');
  try { storage ??= globalThis.localStorage; tabStorage ??= globalThis.sessionStorage; } catch { /* Private browsing can disable storage. */ }
  const prefix = 'turnkey/design/' + encodeURIComponent(projectId) + '/';
  let tabId;
  try {
    tabId = tabStorage?.getItem(prefix + 'tab') || uid();
    tabStorage?.setItem(prefix + 'tab', tabId);
  } catch { tabId = uid(); }
  const soloKey = prefix + 'solo/' + tabId + '/' + encodeURIComponent(historical ? 'version/' + head : 'branch/' + branch);
  const listeners = new Set(), previews = new Set(), pending = new Map();
  let key = soloKey;
  let record = newRecord(uid(), branch, head, copy(snapshot));
  let working = record.base, link = null, members = null, term = null, generation = 0;
  let reports = new Map(), recoveryState = null, ready = true, saving = false, problem = '', storageProblem = '';
  let syncTimer;
  let soloRecord;
  const me = () => members?.peerId;
  const coordinator = () => members?.design?.coordinatorId;
  const isCoordinator = () => Boolean(me() && me() === coordinator());
  const peers = () => members?.peers.map(member => member.id) ?? [];
  function read(key) {
    try {
      const text = storage?.getItem(key);
      if (text) { const value = JSON.parse(text); replay(value); return value; }
    } catch { storageProblem = 'The local draft copy could not be read.'; }
  }
  function persist() {
    try { record.updatedAt = Date.now(); storage?.setItem(key, JSON.stringify(record)); }
    catch { storageProblem = 'Local draft recovery is unavailable in this browser.'; }
  }
  const prior = read(key);
  if (!historical && prior?.branch === branch && (prior.head === head || prior.edits.length || prior.pendingSave)) { record = prior; working = replay(prior); }
  function state() {
    return { projectId, branch: record.branch, head: record.head, sessionId: record.sessionId,
      snapshot: working, sequence: end(record), dirty: record.edits.length > 0, ready, saving,
      error: problem || storageProblem, collaborating: Boolean(link), peerId: me() ?? null, coordinatorId: coordinator() ?? null };
  }
  const notify = () => { const current = state(); for (const listener of listeners) listener(current); };
  const install = next => { const nextSnapshot = replay(next); record = copy(next); working = nextSnapshot; persist(); };
  function headers() {
    const result = new Headers(getHeaders() ?? {});
    if (link) {
      result.set('Authorization', 'Bearer ' + link.token);
      result.set('X-Turnkey-Room', link.room);
      result.set('X-Turnkey-Session', link.design.sessionId);
    }
    return result;
  }
  async function request(path, body, allowMissing = false) {
    const h = headers();
    if (body) h.set('Content-Type', 'application/json');
    const response = await fetchImpl('/api/designs/' + path, {
      method: body ? 'POST' : 'GET', headers: h, cache: 'no-store', redirect: 'error',
      ...(body ? { body: JSON.stringify(body) } : {}), signal: AbortSignal.timeout(15000)
    });
    if (allowMissing && response.status === 404) return null;
    let data;
    try { data = await response.json(); } catch { /* Preserve the HTTP status below. */ }
    if (!response.ok) throw Object.assign(new Error(data?.message || data?.error || 'Design service returned ' + response.status), { status: response.status, code: data?.code, currentHead: data?.currentHead });
    return data;
  }
  const send = (to, content) => link?.send(to, { ...content, sessionId: record.sessionId, term });
  const broadcast = content => { for (const id of peers()) send(id, content); };
  function settle(id, error, value) {
    const waiter = pending.get(id);
    if (!waiter) return;
    clearTimeout(waiter.timer); pending.delete(id);
    if (error) waiter.reject(typeof error === 'string' ? new Error(error) : Object.assign(new Error(error.message), error));
    else waiter.resolve(value);
  }
  function clearWaiters(message) { for (const id of pending.keys()) settle(id, message); }
  function settleApplied() { for (const edit of record.edits) settle(edit.id, null, edit); }
  function append(edit) {
    const next = applyChange(working, edit.change);
    if (validateChange) validateChange(edit.change, next);
    working = next;
    record.edits = [...record.edits, copy(edit)];
    persist(); settle(edit.id, null, edit); notify();
  }
  function coordinateEdit(id, change) {
    const existing = record.edits.find(edit => edit.id === id);
    if (existing) return existing;
    const edit = { id, sequence: end(record) + 1, change };
    append(edit);
    broadcast({ kind: 'accepted', head: record.head, edit });
    return edit;
  }
  function adoptSave(result, base, requestId = record.pendingSave?.requestId) {
    if (!result?.head || !Number.isSafeInteger(result.sequence)) throw new Error('The design service returned an invalid save receipt.');
    const edits = record.edits.filter(edit => edit.sequence > result.sequence);
    install({ ...newRecord(record.sessionId, result.branch, result.head, base, result.sequence), edits });
    problem = '';
    if (requestId) settle(requestId, null, result);
  }
  async function performSave({ branch: dest = record.branch, fork = false } = {}, requestId = uid()) {
    if (saving) throw new Error('A save is already in progress.');
    if (!ready) throw new Error('Wait for the shared draft to synchronize.');
    const existing = record.pendingSave;
    // A lost HTTP response must be retried with the same idempotency key and contents.
    const body = existing || { sessionId: record.sessionId, branch: dest ?? record.branch, expectedHead: record.head,
      fork: Boolean(fork), requestId, sequence: end(record), snapshot: copy(working) };
    const token = generation;
    saving = true; problem = ''; record.pendingSave = body; persist(); notify();
    broadcast({ kind: 'saving', body });
    try {
      let result;
      try { result = await request('save', body); }
      catch (error) {
        if (error.status >= 400 && error.status < 500 && error.status !== 408) throw error;
        // The transaction can succeed even when its HTTP acknowledgment is lost.
        result = await request('receipts/' + encodeURIComponent(body.sessionId) + '/' + encodeURIComponent(body.requestId), undefined, true).catch(() => null);
        if (!result) throw error;
      }
      if (token !== generation) throw new Error('Session changed during the save. Reconnect to see the saved version.');
      adoptSave(result, body.snapshot);
      link?.declareHead(result.head, result.branch);
      broadcast({ kind: 'saved', requestId: body.requestId, previousHead: body.expectedHead, result, base: body.snapshot });
      return result;
    } catch (error) {
      if (token === generation) {
        if (error.status >= 400 && error.status < 500 && error.status !== 408) { delete record.pendingSave; persist(); }
        problem = errorMessage(error);
        broadcast({ kind: 'save-failed', error: problem, clearPending: !record.pendingSave });
      }
      throw error;
    } finally { if (token === generation) { saving = false; notify(); } }
  }
  function remoteRequest(kind, fields) {
    if (!ready || !coordinator()) return Promise.reject(new Error('Wait for the shared draft to synchronize.'));
    const id = uid();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        settle(id, 'The coordinator did not confirm this action. Check the synchronized layout before trying again.');
        if (link && !isCoordinator()) sync();
      }, 22000);
      pending.set(id, { resolve, reject, timer });
      if (!send(coordinator(), { kind, id, head: record.head, ...fields })) settle(id, 'The coordinator is unavailable.');
    });
  }
  function sync() {
    if (!link || !me() || isCoordinator()) return;
    ready = false; notify();
    send(coordinator(), { kind: 'sync' });
    clearTimeout(syncTimer); syncTimer = setTimeout(sync, 3500);
  }
  async function recoverCoordinator(token, descriptor) {
    const receipt = await request('sessions/' + encodeURIComponent(descriptor.sessionId), undefined, true);
    if (token !== generation) return;
    const authoritativeHead = receipt?.head ?? descriptor.head;
    const commit = await request('commits/' + encodeURIComponent(authoritativeHead));
    if (token !== generation) return;
    recoveryState = { head: authoritativeHead, branch: receipt?.branch ?? descriptor.branch, sequence: receipt?.sequence ?? 0, base: commit.snapshot, receipt };
    completeRecovery();
  }
  function completeRecovery() {
    if (!isCoordinator() || !recoveryState || ready || peers().some(id => !reports.has(id))) return;
    const { head, branch, sequence, base, receipt } = recoveryState;
    // Reconcile a committed save with edits that surviving replicas saw after its boundary.
    const baseline = newRecord(record.sessionId, branch, head, base, sequence);
    const candidates = [record, ...reports.values()].filter(Boolean).map(replica => {
      if (replica.sessionId !== record.sessionId || replica.baseSequence > sequence) return null;
      const edits = replica.edits.filter(edit => edit.sequence > sequence);
      if (edits.length && replica.head !== head && (!receipt || end(replica) < sequence)) return null;
      const state = { ...baseline, edits };
      // Preserve an ambiguous commit retry across coordinator handoff.
      if (replica.pendingSave?.expectedHead === head && replica.pendingSave.sessionId === record.sessionId) state.pendingSave = replica.pendingSave;
      replay(state); return state;
    }).filter(Boolean).sort((a, b) => end(b) - end(a) || Number(!!b.pendingSave) - Number(!!a.pendingSave));
    const longest = candidates[0] || baseline;
    for (const candidate of candidates)
      if (!candidate.edits.every((edit, index) => edit.id === longest.edits[index]?.id)) throw new Error('The surviving local drafts disagree. Shared editing is paused.');
    install(longest); ready = true; saving = false; problem = '';
    link.declareHead(record.head, record.branch);
    broadcast({ kind: 'draft', record, receipt }); settleApplied();
    if (receipt?.requestId) settle(receipt.requestId, null, receipt);
    notify();
    if (record.pendingSave) performSave().catch(() => { /* Manual save failures are presented in the draft. */ });
  }
  function failRecovery(error) { ready = false; problem = errorMessage(error); notify(); }
  function membership(next) {
    if (!link) return;
    const previous = members;
    members = next;
    if (!me() || !next.design) {
      if (previous?.peerId || term !== null) {
        generation++; term = null; ready = false; saving = false; clearTimeout(syncTimer);
        clearWaiters('Connection interrupted. Check the shared layout after reconnecting.'); notify();
      }
      return;
    }
    const descriptor = next.design;
    if (descriptor.sessionId !== link.design.sessionId || descriptor.projectId !== projectId) { failRecovery('This session belongs to a different design.'); return; }
    if (term === descriptor.term && previous?.peerId === me()) {
      if (!ready && isCoordinator()) {
        for (const id of peers()) if (!reports.has(id)) send(id, { kind: 'report-request' });
        try { completeRecovery(); } catch (error) { failRecovery(error); }
      }
      return;
    }
    const token = ++generation;
    clearTimeout(syncTimer);
    term = descriptor.term; ready = false; saving = false; problem = '';
    recoveryState = null; reports = new Map(); notify();
    if (isCoordinator()) {
      broadcast({ kind: 'report-request' });
      recoverCoordinator(token, descriptor).catch(error => { if (token === generation) failRecovery(error); });
    } else {
      send(coordinator(), { kind: 'report', record });
      sync();
    }
  }
  function receive(message, from) {
    if (!message || !link || message.sessionId !== record.sessionId || message.term !== term || !peers().includes(from)) return;
    const leader = from === coordinator();
    try {
      switch (message.kind) {
        case 'report-request': if (leader) send(from, { kind: 'report', record }); break;
        case 'report':
          if (isCoordinator() && !ready) { reports.set(from, message.record); completeRecovery(); }
          break;
        case 'sync':
          if (isCoordinator()) send(from, ready ? { kind: 'draft', record } : { kind: 'report-request' });
          break;
        case 'draft':
          if (!leader || message.record?.sessionId !== record.sessionId) return;
          if (ready && end(message.record) < end(record) && record.head === message.record.head) return;
          install(message.record); ready = true; saving = Boolean(record.pendingSave); problem = ''; clearTimeout(syncTimer); settleApplied();
          if (message.receipt?.requestId) settle(message.receipt.requestId, null, message.receipt);
          notify();
          break;
        case 'edit':
          if (!isCoordinator() || !ready) return;
          if (typeof message.id !== 'string' || message.head !== record.head) throw new Error('This edit used an earlier HEAD. Review the current layout.');
          coordinateEdit(message.id, message.change); break;
        case 'accepted':
          if (!leader || !ready) return;
          if (message.head !== record.head || message.edit.sequence > end(record) + 1) { sync(); return; }
          if (message.edit.sequence <= end(record)) { settle(message.edit.id, null, message.edit); return; }
          append(message.edit); break;
        case 'save-request':
          if (!isCoordinator() || !ready) return;
          if (message.head !== record.head) throw new Error('The design HEAD changed. Check the latest layout.');
          performSave(message.options, message.id).then(result => send(from, { kind: 'result', id: message.id, result }),
            error => send(from, { kind: 'result', id: message.id, error: remoteError(error) }));
          break;
        case 'saving':
          if (leader && message.body?.expectedHead === record.head && message.body.sessionId === record.sessionId) {
            record.pendingSave = message.body; saving = true; problem = ''; persist(); notify();
          }
          break;
        case 'save-failed':
          if (leader) {
            if (message.clearPending) { delete record.pendingSave; persist(); }
            saving = false; problem = message.error; notify();
          }
          break;
        case 'saved':
          if (!leader) return;
          if (message.result.head === record.head || message.result.sequence < record.baseSequence) return;
          if (message.previousHead !== record.head) { sync(); return; }
          adoptSave(message.result, message.base, message.requestId); saving = false; notify(); break;
        case 'result':
          if (leader) {
            settle(message.id, message.error, message.result);
            if (message.result?.head && record.head !== message.result.head) sync();
          }
          break;
      }
    } catch (error) {
      if (isCoordinator() && message.id) send(from, { kind: 'result', id: message.id, error: remoteError(error) });
      else if (!isCoordinator() && leader) { problem = errorMessage(error); sync(); }
      else failRecovery(error);
    }
  }
  return {
    getState: state, getHeaders: headers,
    recoverableDrafts() {
      const drafts = [];
      try {
        for (let i = 0; i < (storage?.length ?? 0); i++) {
          const source = storage.key(i);
          if (source === key || !(source?.startsWith(prefix + 'solo/') || source?.startsWith(prefix + 'session/'))) continue;
          const saved = read(source);
          if (saved && (saved.edits.length || saved.pendingSave)) drafts.push({
            source, branch: saved.branch, head: saved.head, edits: saved.edits.length,
            shared: source.startsWith(prefix + 'session/'), updatedAt: saved.updatedAt ?? 0
          });
        }
      } catch { /* Browser storage may be disabled. */ }
      return drafts.sort((a, b) => b.updatedAt - a.updatedAt);
    },
    recoverAsPersonal(source) {
      if (historical) throw new Error('Open a branch to recover a local draft.');
      if (link || saving || record.edits.length || record.pendingSave) throw new Error('Save or leave your current draft before opening a recovery copy.');
      if (!(source?.startsWith(prefix + 'solo/') || source?.startsWith(prefix + 'session/'))) throw new Error('Choose a local draft for this project.');
      const saved = read(source);
      if (!saved) throw new Error('The local draft is unavailable.');
      const next = newRecord(uid(), saved.branch, saved.head, saved.base);
      next.edits = saved.edits.map((edit, index) => ({ ...edit, sequence: index + 1 }));
      // Start a separate working copy. Keep the source journal for the prior session.
      install(next); problem = ''; notify();
    },
    subscribe(listener) { listeners.add(listener); listener(state()); return () => listeners.delete(listener); },
    onPreview(listener) { previews.add(listener); return () => previews.delete(listener); },
    preview(instance) { if (ready && link) link.sendPreview(instance); },
    receivePreview(instance, from) { if (link) for (const callback of previews) callback(instance, from); },
    apply(change) {
      try {
        if (!ready) throw new Error('Wait for the shared draft to synchronize.');
        if (link && !isCoordinator()) return remoteRequest('edit', { change });
        return Promise.resolve(coordinateEdit(uid(), copy(change)));
      } catch (error) { return Promise.reject(error); }
    },
    save(options = {}) {
      if (link && !isCoordinator()) return remoteRequest('save-request', { options });
      return performSave(options);
    },
    checkout({ head, branch, snapshot }) {
      if (link || saving || record.edits.length || record.pendingSave) throw new Error('Save or discard the current draft before switching versions.');
      install(newRecord(uid(), branch, head, copy(snapshot))); problem = ''; notify();
    },
    discard() {
      if (link || saving || record.pendingSave) throw new Error('Only a settled personal draft can be discarded.');
      install(newRecord(record.sessionId, record.branch, record.head, record.base, record.baseSequence)); problem = ''; notify();
    },
    connect(connection, creating = false) {
      if (link || saving || record.pendingSave) throw new Error('Finish the current session or save first.');
      if (connection.design.projectId !== projectId) throw new Error('This invitation opens a different project.');
      soloRecord = copy(record); link = connection;
      key = prefix + 'session/' + connection.design.sessionId + '/' + tabId;
      let cached = read(key);
      if (!cached && !creating) {
        // A returning editor may be opening the same invitation in a fresh tab.
        const sessionKeys = prefix + 'session/' + connection.design.sessionId + '/';
        try {
          for (let i = 0; i < (storage?.length ?? 0); i++) {
            const source = storage.key(i);
            if (!source?.startsWith(sessionKeys)) continue;
            const candidate = read(source);
            if (candidate && (!cached || end(candidate) > end(cached) ||
                end(candidate) === end(cached) && candidate.updatedAt > cached.updatedAt)) cached = candidate;
          }
        } catch { /* A fresh peer can still synchronize from the coordinator. */ }
      }
      if (cached?.sessionId === connection.design.sessionId) install(cached);
      else if (creating) install({ ...record, sessionId: connection.design.sessionId, baseSequence: 0, edits: record.edits.map((edit, i) => ({ ...edit, sequence: i + 1 })) });
      else install(newRecord(connection.design.sessionId, connection.design.branch, connection.design.head, record.base));
      ready = false; notify();
    },
    membership, receive,
    disconnect() {
      if (!link) return;
      ++generation; clearTimeout(syncTimer); clearWaiters('You left the shared draft.');
      link = members = term = recoveryState = null; key = soloKey;
      ready = true; saving = false; problem = '';
      install(soloRecord); soloRecord = null; notify();
    }
  };
}
