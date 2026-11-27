import { mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { createDesignStore } from './design-store.mjs';
import { isLocalDesignEditor } from './local-editor-access.mjs';
import { handleDesignRequest, isDesignRoute } from './design-api.mjs';

export function nodeDesignStorage(db) {
  return {
    sql: { exec: (query, ...args) => db.prepare(query).all(...args) },
    transaction(fn) {
      db.exec('BEGIN IMMEDIATE');
      try {
        const result = fn();
        db.exec('COMMIT');
        return result;
      } catch (error) {
        db.exec('ROLLBACK');
        throw error;
      }
    },
  };
}

export function designServicePlugin({ projectRoot, projectId, seedSnapshot, validateSnapshot,
  capabilities = { writable: true, authRequired: false }, databasePath = join(projectRoot, '.turnkey', 'designs.sqlite') }) {
  function attach(server) {
    let db, opening;
    async function openStore() {
      const { DatabaseSync } = await import('node:sqlite');
      if (databasePath !== ':memory:') mkdirSync(dirname(databasePath), { recursive: true });
      db = new DatabaseSync(databasePath);
      try {
        const storage = nodeDesignStorage(db);
        // A project may need to read its bundled manifest before the initial migration.
        const hasHistory = storage.sql.exec("SELECT name FROM sqlite_master WHERE type='table' AND name='design_branches'").length &&
          storage.sql.exec('SELECT head FROM design_branches WHERE project=? AND name=?', projectId, 'main').length;
        const initial = !hasHistory && typeof seedSnapshot === 'function' ? await seedSnapshot() : seedSnapshot;
        return createDesignStore({ ...storage, projectId, seedSnapshot: initial, validateSnapshot });
      } catch (error) {
        db.close();
        db = undefined;
        throw error;
      }
    }
    server.httpServer?.once('close', () => { db?.close(); });
    server.middlewares.use(async (req, res, next) => {
      if (!isDesignRoute((req.url || '').split('?')[0])) return next();
      try {
        const url = new URL(req.url, (req.socket.encrypted ? 'https://' : 'http://') + req.headers.host);
        const init = { method: req.method, headers: req.headers };
        if (req.method !== 'GET' && req.method !== 'HEAD') Object.assign(init, { body: req, duplex: 'half' });
        opening ??= openStore().catch(error => { opening = undefined; throw error; });
        const writable = capabilities.writable !== false && isLocalDesignEditor(req);
        const response = await handleDesignRequest(new Request(url, init), {
          store: await opening, capabilities: { ...capabilities, writable }, authorizeSave: () => writable,
        });
        res.writeHead(response.status, Object.fromEntries(response.headers));
        res.end(Buffer.from(await response.arrayBuffer()));
      } catch (error) { next(error); }
    });
  }
  return { name: 'turnkey-designs', configureServer: attach, configurePreviewServer: attach };
}
