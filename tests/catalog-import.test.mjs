import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { bundledAssetRevision, classifyAssetRevision } from '../shared/catalog.mjs';
import { extractCatalogDraft, handleCatalogRequest } from '../server/catalog.mjs';
import { createFileCatalogStore } from '../server/catalog-local.mjs';
import { buildCatalogAsset } from '../preview/catalog-runtime.mjs';
import * as THREE from 'three';

const endpoint = 'https://fixture.test/api/catalog';
const draft = { source: { text: 'Library stool in white oak. Dimensions 18 inch W × 44 cm D × 620 mm H.' },
  name: 'Library stool', variant: 'White oak', front: 'Seat front', anchor: 'rear-centre', notes: '',
  measurements: {
    width: { value: 18, unit: 'in', evidence: '18 inch W' }, depth: { value: 44, unit: 'cm', evidence: '44 cm D' },
    height: { value: 620, unit: 'mm', evidence: '620 mm H' },
  } };
const post = (path, value, headers) => new Request(endpoint + path, {
  method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(value),
});

test('bundled asset identities refer to an exact geometry and path', () => {
  const path = 'assets/fixture-stool/model/build.mjs';
  const id = bundledAssetRevision('bundle:seed%2', path);
  assert.deepEqual(classifyAssetRevision(id, 'bundle:seed%2'), { kind: 'bundled', assetPath: path });
  assert.equal(classifyAssetRevision(id, 'other'), null);
  assert.equal(classifyAssetRevision('asset:fake', 'other'), null);
});

test('review yields immutable retained revisions, fresh stores replay the original dimensions', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'turnkey-catalog-'));
  t.after(() => rm(directory, { force: true, recursive: true }));
  const handlers = { store: createFileCatalogStore(directory), authorize: () => true };
  const approve = d => handleCatalogRequest(post('/approve', d), handlers).then(async res => {
    const body = await res.json(); assert.equal(res.status, 201, body.error); return body.revision;
  });
  const [original, retry] = await Promise.all([approve({ draft }), approve({ draft })]);
  assert.equal(retry.id, original.id);
  const corrected = structuredClone(draft);
  corrected.measurements.width = { value: 480, unit: 'mm', evidence: 'Measured after delivery' };
  const next = await approve({ draft: corrected, parentRevision: original.id });
  assert.notEqual(next.id, original.id);
  assert.equal(next.assetId, original.assetId);
  const store = createFileCatalogStore(directory);
  assert.equal(store.getSync(original.id).entry.size_x_mm, 457.2);
  assert.equal((await store.get(next.id)).entry.size_x_mm, 480);
  const summary = await (await handleCatalogRequest(new Request(endpoint), { store })).json();
  assert.equal(summary.revisions.length, 2);
  const record = await (await handleCatalogRequest(new Request(endpoint + '/revisions/' + original.id), { store })).json();
  assert.equal(record.entry.offset_y_mm, 220);
  assert.equal(record.model, null);
  const one = await buildCatalogAsset(THREE, record), two = await buildCatalogAsset(THREE, record);
  one.rotation.y = Math.PI;
  assert.equal(two.rotation.y, 0);
  const box = new THREE.Box3().setFromObject(two);
  assert.ok(Math.abs(box.max.x - .2286) < 1e-6);
  assert.ok(Math.abs(box.min.z + .44) < 1e-6);
  assert.ok(Math.abs(box.max.z) < 1e-6);
  const denied = await handleCatalogRequest(post('/approve', { draft }), { store, authorize: () => false });
  assert.equal(denied.status, 403);
  assert.equal((await handleCatalogRequest(post('/approve', { draft }, { Origin: 'https://elsewhere.test' }), handlers)).status, 403);
  const invalid = { ...draft, measurements: {} };
  assert.equal((await handleCatalogRequest(post('/approve', { draft: invalid }), handlers)).status, 400);
  assert.equal((await handleCatalogRequest(post('/approve', { draft: { ...draft, model: { format: 'glb', front: '+Z', base64: 'AA==' } } }), handlers)).status, 400);
});

test('AI adapter preserves evidence and never writes a catalog revision during extraction', async () => {
  let body, credentials, url;
  const fake = async (u, options) => {
    url = u; body = JSON.parse(options.body); credentials = options.headers.Authorization;
    return Response.json({ output: [{ content: [{ type: 'output_text', text: JSON.stringify(draft) }] }] });
  };
  const env = { OPENAI_API_KEY: 'fixture-only', TURNKEY_IMPORT_BASE_URL: 'https://model.test/v1', TURNKEY_IMPORT_MODEL: 'test-model' };
  const result = await extractCatalogDraft(draft.source, env, fake);
  assert.equal(url, 'https://model.test/v1/responses');
  assert.equal(credentials, 'Bearer fixture-only');
  assert.equal(body.input, draft.source.text);
  assert.equal(body.store, false);
  assert.equal(result.measurements.width.evidence, draft.measurements.width.evidence);
  const source = { url: 'https://fixture.test/stool', text: '' };
  await extractCatalogDraft(source, env, fake);
  assert.deepEqual(body.tools[0].filters.allowed_domains, ['fixture.test']);
  const res = await handleCatalogRequest(post('/extract', { source }), { store: {}, authorize: () => true });
  assert.equal(res.status, 503);
});

test('a retained binary model reopens in its approved front, size and anchor frame', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'turnkey-glb-'));
  t.after(() => rm(directory, { force: true, recursive: true }));
  const positions = new Float32Array([0, 0, 0, 2, 0, 0, 0, 1, 3]);
  const gltf = { asset: { version: '2.0' }, scene: 0, scenes: [{ nodes: [0] }], nodes: [{ mesh: 0 }],
    meshes: [{ primitives: [{ attributes: { POSITION: 0 } }] }], accessors: [{ bufferView: 0, componentType: 5126, count: 3,
      type: 'VEC3', min: [0, 0, 0], max: [2, 1, 3] }], buffers: [{ byteLength: positions.byteLength }],
    bufferViews: [{ buffer: 0, byteLength: positions.byteLength }] };
  const json = JSON.stringify(gltf), padded = Buffer.from(json.padEnd(Math.ceil(json.length / 4) * 4, ' '));
  const glb = Buffer.alloc(12 + 8 + padded.length + 8 + positions.byteLength);
  glb.writeUInt32LE(0x46546c67, 0); glb.writeUInt32LE(2, 4); glb.writeUInt32LE(glb.length, 8);
  glb.writeUInt32LE(padded.length, 12); glb.writeUInt32LE(0x4e4f534a, 16); padded.copy(glb, 20);
  glb.writeUInt32LE(positions.byteLength, 20 + padded.length); glb.writeUInt32LE(0x004e4942, 24 + padded.length);
  Buffer.from(positions.buffer).copy(glb, 28 + padded.length);
  const store = createFileCatalogStore(directory);
  const model = { format: 'glb', front: '+X', base64: glb.toString('base64') };
  const res = await handleCatalogRequest(post('/approve', { draft: { ...draft, model } }), { store, authorize: () => true });
  assert.equal(res.status, 201);
  const record = await store.get((await res.json()).revision.id);
  assert.deepEqual(record.model, model);
  const geometry = await buildCatalogAsset(THREE, record);
  const bounds = new THREE.Box3().setFromObject(geometry, true);
  const close = (actual, expected) => assert.ok(Math.abs(actual - expected) < 1e-6, actual + ' vs ' + expected);
  close(bounds.min.y, 0); close(bounds.max.y, 0.62);
  close(bounds.min.x, -0.2286); close(bounds.max.x, 0.2286);
  close(bounds.min.z, -0.44); close(bounds.max.z, 0);
});
