import assert from 'node:assert/strict';
import test from 'node:test';
import { renovationView, writeRenovationView } from '../preview/renovation-views.mjs';

test('legacy 3D comparisons retain their physical meaning and proposed opens Design', () => {
  for (const [condition, compare] of [['existing', 'before'], ['demolition', 'removals'], ['proposed', null]]) {
    const result = renovationView(new URLSearchParams({ condition }));
    assert.equal(result.compare, compare);
    assert.equal(result.drawing, null);
  }
});

test('legacy plan links open phase drawings on projects that supply them', () => {
  for (const condition of ['existing', 'demolition', 'proposed']) {
    const params = new URLSearchParams({ view: 'plan', condition });
    assert.equal(renovationView(params).drawing, condition);
    assert.equal(renovationView(params, false).drawing, null);
  }
});

test('switching between drawings, comparisons and Design retains the underlying location and option', () => {
  const params = new URLSearchParams({ scope: 'room/study', option: 'desk', condition: 'existing', assembly: 'stacked' });
  writeRenovationView(params, { drawing: 'demolition' });
  assert.deepEqual(renovationView(params), { drawing: 'demolition', compare: null, condition: 'demolition' });
  writeRenovationView(params, { compare: 'before' });
  assert.deepEqual(renovationView(params), { drawing: null, compare: 'before', condition: 'existing' });
  writeRenovationView(params);
  assert.deepEqual(Object.fromEntries(params), { scope: 'room/study', option: 'desk', assembly: 'stacked' });
});
