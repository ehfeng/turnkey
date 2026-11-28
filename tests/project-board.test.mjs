import test from 'node:test';
import assert from 'node:assert/strict';
import { validateRoomPolygon, validateProjectBoards } from '../shared/project-board.mjs';

test('normalized polygons reject crossing, repeated, nonfinite and zero-area vertices',()=>{
  assert.deepEqual(validateRoomPolygon([[0,0],[1,0],[1,1],[0,1]]),[[0,0],[1,0],[1,1],[0,1]]);
  for(const p of [[[0,0],[1,1],[0,1],[1,0]],[[0,0],[1,0],[0,0]],[[0,0],[.5,0],[1,0]],[[0,0],[Infinity,0],[0,1]]]) assert.throws(()=>validateRoomPolygon(p));
});
test('floor plans pin verified PNG dimensions; room memberships preserve shared pins',()=>{
  const state={assets:[{id:'png',mimeType:'image/png',sha256:'a'.repeat(64),storageKey:'images/a',width:100,height:80}],floorPlans:[{id:'floor',assetId:'png',width:100,height:80,rooms:[{id:'study',name:'Study',polygon:[[0,0],[1,0],[0,1]]}]}],pins:[{id:'lamp',title:'Lamp',role:'inspiration',sourceUrl:'https://example.com/lamp'}],memberships:[{id:'one',roomId:'study',pinId:'lamp',status:'Idea',rank:1},{id:'two',roomId:'hall',pinId:'lamp',status:'Chosen',rank:2}]};
  validateProjectBoards(state);
  const changed=structuredClone(state);changed.floorPlans[0].width=200;
  assert.throws(()=>validateProjectBoards(changed),/Dimensions/);
  changed.floorPlans[0].width=100;changed.memberships[1].roomId='study';
  assert.throws(()=>validateProjectBoards(changed),/at most once/);
  changed.memberships.pop();changed.pins[0].sourceUrl='javascript:alert(1)';
  assert.throws(()=>validateProjectBoards(changed),/HTTPS or HTTP/);
});
