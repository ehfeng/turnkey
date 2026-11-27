import { DesignError, normalizeDesignSnapshot, requiredDesignString } from '../shared/design.mjs';

const metadata = 'id, parent_id AS parentId, branch, created_at AS createdAt';
const receiptColumns = 'id AS head, branch, sequence';
const missing = what => new DesignError(404, 'not_found', what + ' was not found.');

// Both adapters supply a synchronous transaction and SQL queries with positional bindings.
// The migration getter runs once, under the same write lock as the initial branch creation.
export function createDesignStore({ sql, transaction, projectId, seedSnapshot, validateSnapshot, capabilities = {}, makeId = () => crypto.randomUUID(), now = () => new Date().toISOString() }) {
  requiredDesignString(projectId, 'project ID');
  const rows = (query, ...args) => {
    const cursor = sql.exec(query, ...args);
    return typeof cursor.toArray === 'function' ? cursor.toArray() : Array.from(cursor);
  };
  const first = (query, ...args) => rows(query, ...args)[0];
  sql.exec(`CREATE TABLE IF NOT EXISTS design_commits (
    ordinal INTEGER PRIMARY KEY, project TEXT NOT NULL, id TEXT NOT NULL,
    parent_id TEXT, branch TEXT NOT NULL, created_at TEXT NOT NULL, snapshot TEXT NOT NULL,
    session_id TEXT, request_id TEXT, sequence INTEGER, fork INTEGER NOT NULL DEFAULT 0,
    UNIQUE(project, id), UNIQUE(project, session_id, request_id))`);
  sql.exec(`CREATE TABLE IF NOT EXISTS design_branches (
    project TEXT NOT NULL, name TEXT NOT NULL, head TEXT NOT NULL, PRIMARY KEY(project, name))`);
  sql.exec('CREATE INDEX IF NOT EXISTS design_session_history ON design_commits(project, session_id, ordinal)');
  const branchHead = branch => first('SELECT head FROM design_branches WHERE project=? AND name=?', projectId, branch)?.head;

  function validate(snapshot, parent) {
    if (!validateSnapshot) return;
    try {
      const result = validateSnapshot(snapshot, parent);
      if (result?.then) throw new TypeError('validateSnapshot must be synchronous.');
    } catch (error) {
      if (error instanceof DesignError) throw error;
      throw new DesignError(400, 'invalid_snapshot', error.message || 'The project rejected the design.');
    }
  }
  function seed() {
    if (branchHead('main')) return;
    transaction(() => {
      if (branchHead('main')) return;
      const value = typeof seedSnapshot === 'function' ? seedSnapshot() : seedSnapshot;
      const snapshot = normalizeDesignSnapshot(value);
      validate(snapshot, null);
      const id = makeId();
      sql.exec('INSERT INTO design_commits(project,id,branch,created_at,snapshot) VALUES(?,?,?,?,?)',
        projectId, id, 'main', now(), JSON.stringify(snapshot));
      sql.exec('INSERT INTO design_branches(project,name,head) VALUES(?,?,?)', projectId, 'main', id);
    });
  }
  const branches = () => rows('SELECT name, head FROM design_branches WHERE project=? ORDER BY name', projectId);
  function commit(id) {
    seed();
    const row = first('SELECT ' + metadata + ', snapshot FROM design_commits WHERE project=? AND id=?', projectId, id);
    if (!row) throw missing('Design version');
    return { ...row, snapshot: JSON.parse(row.snapshot) };
  }
  const lastSave = sessionId => first('SELECT ' + receiptColumns + ', request_id AS requestId FROM design_commits WHERE project=? AND session_id=? ORDER BY ordinal DESC LIMIT 1', projectId, sessionId);

  function save(input) {
    const sessionId = requiredDesignString(input?.sessionId, 'session ID');
    const requestId = requiredDesignString(input.requestId, 'request ID');
    const expectedHead = requiredDesignString(input.expectedHead, 'expected HEAD');
    const branch = requiredDesignString(input.branch, 'branch name');
    const { sequence, fork } = input;
    if (typeof fork !== 'boolean' || !Number.isSafeInteger(sequence) || sequence < 0) {
      throw new DesignError(400, 'invalid_save', 'A save requires a branch mode and a nonnegative edit sequence.');
    }
    const snapshot = normalizeDesignSnapshot(input.snapshot);
    const serialized = JSON.stringify(snapshot);
    seed();
    return transaction(() => {
      const previous = first('SELECT ' + receiptColumns + ', parent_id, snapshot, fork FROM design_commits WHERE project=? AND session_id=? AND request_id=?',
        projectId, sessionId, requestId);
      if (previous) {
        if (previous.parent_id !== expectedHead || previous.branch !== branch || previous.sequence !== sequence ||
          Boolean(previous.fork) !== fork || previous.snapshot !== serialized) {
          throw new DesignError(409, 'request_reused', 'This save request ID already identifies another save.');
        }
        return { head: previous.head, branch, sequence };
      }
      const currentHead = branchHead(branch) ?? null;
      if (fork ? currentHead !== null : currentHead !== expectedHead) {
        throw new DesignError(409, 'branch_conflict', fork ? 'This branch already exists.' : 'The branch moved since this session opened.', { currentHead });
      }
      const latest = lastSave(sessionId);
      if (latest && latest.head !== expectedHead) {
        throw new DesignError(409, 'session_conflict', 'The session has already saved a newer version.', { currentHead: latest.head });
      }
      if (latest && sequence < latest.sequence) {
        throw new DesignError(409, 'stale_sequence', 'A newer edit sequence has already been saved.');
      }
      const parent = commit(expectedHead);
      if (parent.snapshot.geometryRevision !== snapshot.geometryRevision) {
        throw new DesignError(400, 'geometry_changed', 'Furniture saves must retain the parent geometry revision.');
      }
      validate(snapshot, parent.snapshot);
      const head = makeId();
      sql.exec(`INSERT INTO design_commits(project,id,parent_id,branch,created_at,snapshot,session_id,request_id,sequence,fork)
        VALUES(?,?,?,?,?,?,?,?,?,?)`, projectId, head, expectedHead, branch, now(), serialized, sessionId, requestId, sequence, Number(fork));
      if (fork) sql.exec('INSERT INTO design_branches(project,name,head) VALUES(?,?,?)', projectId, branch, head);
      else sql.exec('UPDATE design_branches SET head=? WHERE project=? AND name=?', head, projectId, branch);
      return { head, branch, sequence };
    });
  }
  return {
    projectId, seed, commit, save,
    index() {
      seed();
      const list = branches();
      return { ...(typeof capabilities === 'function' ? capabilities() : capabilities), projectId, branch: 'main', head: list.find(ref => ref.name === 'main').head, branches: list };
    },
    history() {
      seed();
      return { branches: branches(), commits: rows('SELECT ' + metadata + ' FROM design_commits WHERE project=? ORDER BY ordinal DESC', projectId) };
    },
    receipt(sessionId, requestId) {
      const row = first('SELECT ' + receiptColumns + ' FROM design_commits WHERE project=? AND session_id=? AND request_id=?', projectId, sessionId, requestId);
      if (!row) throw missing('Save receipt');
      return { ...row };
    },
    session(sessionId) {
      const row = lastSave(sessionId);
      if (!row) throw missing('Session save');
      return { ...row };
    },
  };
}
