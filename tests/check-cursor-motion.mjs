import assert from 'node:assert/strict';
import test from 'node:test';
import { cursorInSpace, cursorPosition } from '../preview/cursor-motion.mjs';

const project = ([x, y]) => ({ x, y });

test('fast reversals display the latest received position without a trailing offset', () => {
  for (const x of [0.1, 0.8, 0.2, 0.9]) {
    assert.deepEqual(cursorPosition({ x, y: 0.5 }, project), { x, y: 0.5 });
  }
});

test('camera movement reprojects a stationary world pointer without adding follow lag', () => {
  const cursor = { x: 0.8, y: 0.3, world: [0.2, 0.5, 2] };
  assert.deepEqual(cursorPosition(cursor, project), { x: 0.2, y: 0.5 });
  const rotated = ([x, y]) => ({ x: 1 - x, y });
  assert.deepEqual(cursorPosition(cursor, rotated), { x: 0.8, y: 0.5 });
  assert.equal(cursorPosition(cursor, () => null), null, 'a world point behind the viewer stays hidden');
});

test('delayed anchors from a previous model or a loading scene are discarded', () => {
  const cursor = { x: 0.1, y: 0.2, space: 'lower:proposed' };
  assert.equal(cursorInSpace(cursor, undefined), false);
  assert.equal(cursorInSpace(cursor, 'lower:existing'), false);
  assert.equal(cursorInSpace(cursor, 'lower:proposed'), true);
});
