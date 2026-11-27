import { mkdir, readFile, readdir, writeFile, link, unlink } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { Readable } from 'node:stream';
import { isLocalDesignEditor } from './local-editor-access.mjs';
import { handleCatalogRequest, summarizeCatalogRevision } from './catalog.mjs';

export function createFileCatalogStore(directory) {
  const path = id => join(directory, id.slice(6) + '.json');
  async function get(id) {
    if (!/^asset:[0-9a-f]{64}$/.test(id)) return null;
    try { return JSON.parse(await readFile(path(id), 'utf8')); }
    catch (error) { if (error.code === 'ENOENT') return null; throw error; }
  }
  return {
    get,
    getSync(id) {
      if (!/^asset:[0-9a-f]{64}$/.test(id)) return null;
      try { return JSON.parse(readFileSync(path(id), 'utf8')); }
      catch (error) { if (error.code === 'ENOENT') return null; throw error; }
    },
    async list() {
      let files;
      try { files = await readdir(directory); } catch (error) { if (error.code === 'ENOENT') return []; throw error; }
      return Promise.all(files.filter(name => /^[0-9a-f]{64}\.json$/.test(name)).map(async name =>
        summarizeCatalogRevision(await get('asset:' + name.slice(0, -5)))));
    },
    async putIfAbsent(record) {
      await mkdir(directory, { recursive: true });
      const temp = join(directory, randomUUID() + '.tmp');
      try {
        await writeFile(temp, JSON.stringify(record), { flag: 'wx' });
        try { await link(temp, path(record.id)); } catch (error) { if (error.code !== 'EEXIST') throw error; }
      } finally { await unlink(temp).catch(() => {}); }
    },
  };
}

export function catalogServicePlugin({ directory, env = process.env, authorize = () => true }) {
  const store = createFileCatalogStore(directory);
  function attach(server) {
    server.middlewares.use(async (req, res, next) => {
      if (!/^\/api\/catalog(?:[/?]|$)/.test(req.url || '')) return next();
      try {
        if (req.method === 'POST' && !isLocalDesignEditor(req)) {
          res.writeHead(403, { 'Content-Type': 'application/json' });
          return res.end(JSON.stringify({ error: 'Open the local project on localhost to edit its catalog.' }));
        }
        const request = new Request('http://' + req.headers.host + req.url, { method: req.method, headers: req.headers,
          ...(req.method === 'POST' ? { body: Readable.toWeb(req), duplex: 'half' } : {}) });
        const response = await handleCatalogRequest(request, { store, env, authorize });
        res.writeHead(response.status, Object.fromEntries(response.headers));
        res.end(Buffer.from(await response.arrayBuffer()));
      } catch (error) { next(error); }
    });
  }
  return { name: 'turnkey-catalog', configureServer: attach, configurePreviewServer: attach };
}
