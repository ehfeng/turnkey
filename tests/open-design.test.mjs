import assert from 'node:assert/strict';
import { test } from 'node:test';
import { openDesign } from '../preview/open-design.mjs';

const index = { projectId: 'sample', head: 'first', branch: 'main',
  branches: [{ name: 'main', head: 'first' }, { name: 'study', head: 'second' }] };
const response = path => path === './api/designs' ? Response.json(index)
  : Response.json({ id: path.split('/').at(-1), snapshot: { geometryRevision: 'geometry' } });

test('opening a branch selects its tip and an explicit version can fork from an older commit', async () => {
  const live = await openDesign(new URLSearchParams('designBranch=study'), response);
  assert.equal(live.head, 'second');
  assert.equal(live.historical, false);
  const old = await openDesign(new URLSearchParams('designBranch=study&designVersion=first'), response);
  assert.equal(old.head, 'first');
  assert.equal(old.branch, 'study');
  assert.equal(old.historical, true);
  await assert.rejects(openDesign(new URLSearchParams('designBranch=unknown'), response), /branch/);
});

test('static viewers open bundled projects while server errors and exact-version links stay explicit', async () => {
  const html = () => new Response('<html>', { headers: { 'content-type': 'text/html' } });
  assert.equal(await openDesign(new URLSearchParams(), html), null);
  await assert.rejects(openDesign(new URLSearchParams('designVersion=saved'), html), /shared design service/);
  await assert.rejects(openDesign(new URLSearchParams(), () => new Response(null, { status: 503 })), /could not be opened/);
});
