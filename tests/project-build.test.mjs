import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { promisify } from 'node:util';

const cli = fileURLToPath(new URL('../bin/turnkey.mjs', import.meta.url));
test('build a second project in isolation with only its own room', async t => {
  const project = await mkdtemp(join(tmpdir(), 'turnkey-second-project-'));
  t.after(() => rm(project, { force: true, recursive: true }));
  const model = join(project, 'rooms', 'sunroom', 'model');
  await mkdir(model, { recursive: true });
  await writeFile(join(model, 'build.mjs'), `export const levelId = ''; export function buildRoom({ THREE }) { const group = new THREE.Group(); group.name = 'fixture-sunroom'; return group; }`);
  await promisify(execFile)(process.execPath, [cli, 'validate', '--project', project]);
  await promisify(execFile)(process.execPath, [cli, 'build', '--project', project]);
  const html = await readFile(join(project, 'dist', 'index.html'), 'utf8');
  assert.match(html, /<canvas|id="scene"/);
  const output = join(project, 'dist', 'bundle');
  const js = await Promise.all((await readdir(output)).filter(file => file.endsWith('.js')).map(file => readFile(join(output, file), 'utf8')));
  assert.ok(js.some(source => source.includes('fixture-sunroom')), 'fixture model is reachable from the production catalog');
});
