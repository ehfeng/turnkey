import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { roomServicePlugin } from '../server/rooms.mjs';
import { designServicePlugin } from '../server/design-plugin.mjs';
import { catalogServicePlugin, createFileCatalogStore } from '../server/catalog-local.mjs';

const appRoot = fileURLToPath(new URL('../', import.meta.url));

function projectRevision(root) {
  try { return execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8', stdio: ['ignore','pipe','ignore'] }).trim(); }
  catch { return 'unversioned'; }
}

// Present the shipped HTML at the project's root. All asset and builder paths
// in the resulting site belong to this project, even in sibling-checkout mode.
function applicationEntry(root) {
  const entry = join(root, 'index.html');
  const template = join(appRoot, 'index.html');
  return {
    name: 'turnkey-project-entry', enforce: 'pre',
    resolveId(id) { if (id === entry) return entry; },
    load(id) { if (id === entry) { this.addWatchFile(template); return readFileSync(template, 'utf8'); } },
    configureServer(server) {
      server.watcher.add(template);
      server.middlewares.use(async (req, res, next) => {
        const path = req.url?.split('?')[0];
        if (!['/', '/index.html'].includes(path)) return next();
        try {
          const html = await server.transformIndexHtml(req.url, readFileSync(template, 'utf8'));
          res.setHeader('Content-Type', 'text/html; charset=utf-8');
          res.setHeader('Cache-Control', 'no-cache');
          res.end(html);
        } catch (error) { next(error); }
      });
    },
  };
}

export async function createProjectConfig(projectRoot) {
  const root = realpathSync(resolve(projectRoot));
  const projectConfig = join(root, 'turnkey.project.mjs');
  const project = existsSync(projectConfig) ? (await import(pathToFileURL(projectConfig))).default : {};
  const projectViewer = join(root, 'project/viewer.mjs');
  const commit = projectRevision(root);
  const plugins = typeof project.plugins === 'function' ? await project.plugins() : [];
  const designPlugins = [];
  if (project.designStore) {
    const directory = join(root, '.turnkey', 'catalog');
    const options = typeof project.designStore === 'function'
      ? await project.designStore({ root, revision: commit, catalog: createFileCatalogStore(directory) })
      : project.designStore;
    designPlugins.push(designServicePlugin({ ...options, projectRoot: root }), catalogServicePlugin({ directory }));
  }
  return {
    root, configFile: false, base: './',
    resolve: {
      alias: {
        '/@turnkey': join(appRoot, 'preview'),
        'virtual:turnkey-project': existsSync(projectViewer) ? projectViewer : join(appRoot, 'preview/default-project.mjs'),
        'turnkey/frame': join(appRoot, 'lib/frame.mjs'),
        'turnkey/furniture': join(appRoot, 'lib/furniture.mjs'),
        'turnkey/renderer-resources': join(appRoot, 'lib/renderer-resources.mjs'),
      },
      dedupe: ['three'],
    },
    define: { __VIEWER_REVISION__: JSON.stringify(commit) },
    plugins: [applicationEntry(root), roomServicePlugin(project.rooms), ...designPlugins, ...plugins, {
      name: 'design-build-info',
      generateBundle() { this.emitFile({ type: 'asset', fileName: 'build-info.json', source: JSON.stringify({ commit }) + '\n' }); }
    }],
    optimizeDeps: { entries: [], include: ['three', 'three/addons/controls/OrbitControls.js'] },
    build: { outDir: 'dist', assetsDir: 'bundle', rollupOptions: { input: join(root, 'index.html') }, chunkSizeWarningLimit: 2000 },
    server: { host: 'localhost', fs: { allow: [root, appRoot], deny: ['.env', '.env.*', '*.{crt,pem}', '**/.git/**', '**/.turnkey/**'] }, watch: { ignored: ['**/releases/**', '**/dist/**', '**/.turnkey/**'] } },
  };
}
