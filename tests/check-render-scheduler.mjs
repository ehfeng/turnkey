import assert from 'node:assert/strict';
import { createRenderScheduler } from '../preview/render-scheduler.mjs';

const queued = new Map();
let id = 0;
let renders = 0;
let requestFromRender = false;
const frames = createRenderScheduler({
  requestFrame(callback) { queued.set(++id, callback); return id; },
  cancelFrame(handle) { queued.delete(handle); },
  render(time) {
    assert.equal(time, 42);
    renders++;
    if (requestFromRender) frames.request();
  },
});
function tick() {
  const current = [...queued.values()];
  queued.clear();
  for (const callback of current) callback(42);
}
frames.request(); frames.request(); frames.request();
assert.equal(queued.size, 1, 'multiple changes share a frame');
tick();
assert.equal(renders, 1);
assert.equal(queued.size, 0, 'idle views do not redraw');
frames.request(); frames.cancel(); tick();
assert.equal(renders, 1, 'scope changes cancel obsolete frames');
requestFromRender = true;
frames.request(); tick();
assert.equal(queued.size, 1, 'hooks and animated models can request a subsequent frame');
requestFromRender = false;
tick();
assert.equal(queued.size, 0);
console.log('Render scheduling: coalescing, idle, cancellation and hook invalidation passed.');
