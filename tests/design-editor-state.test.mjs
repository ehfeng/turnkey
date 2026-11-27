import assert from 'node:assert/strict';
import test from 'node:test';
import { createPlacementUndo, placementInstance, placementRow, versionLink } from '../preview/design-editor-state.mjs';

const chair = { id: 'a', roomId: 'room-a', assetRevision: 'asset-1', xMm: 350, yMm: -20, zMm: 0, yawDeg: 30 };
const lamp = { ...chair, id: 'b', roomId: 'room-b', assetRevision: 'asset-2' };

test('the plan editor round-trips the complete versioned pose', () => {
  assert.deepEqual(placementInstance(chair.roomId, placementRow(chair)), chair);
});

test('undo chooses the last eligible local operation across rooms and retains it if the coordinator rejects a race', async () => {
  const undo = createPlacementUndo();
  const movedChair = { ...chair, xMm: 400 }, movedLamp = { ...lamp, yawDeg: 90 };
  undo.record({ before: chair, after: movedChair });
  undo.record({ before: lamp, after: movedLamp });
  const current = [movedChair, { ...movedLamp, yMm: 25 }];
  assert.ok(undo.canUndo(current));
  const run = (change) => {
    assert.deepEqual(change, { before: movedChair, after: chair });
  };
  await assert.rejects(undo.undo(current, change => { run(change); throw new Error('stale'); }), /stale/);
  assert.ok(undo.canUndo(current));
  await undo.undo(current, run);
  assert.equal(undo.canUndo(current), false);
});

test('a version or branch opens independently of an invite and preserves the selected room', () => {
  const link = new URL(versionLink('https://test.example/?scope=room%2Fnorth&designBranch=main#room=secret', 'designVersion', 'v1'));
  assert.equal(link.hash, '');
  assert.equal(link.searchParams.get('scope'), 'room/north');
  assert.equal(link.searchParams.get('designVersion'), 'v1');
  assert.equal(link.searchParams.has('designBranch'), false);
});
