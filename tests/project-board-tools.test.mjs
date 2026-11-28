import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { createProjectStore } from '../server/project-store.mjs';
import { nodeDesignStorage } from '../server/design-plugin.mjs';
import { projectBoardTools } from '../server/project-board-tools.mjs';
import { validateProjectBoards } from '../shared/project-board.mjs';

test('semantic room saves preserve pinned model, distinguish images, replay receipts and room statuses',()=>{
  const db=new DatabaseSync(':memory:');
  try {
    const store=createProjectStore({...nodeDesignStorage(db),projectId:'fixture',validateState:s=>validateProjectBoards(s.boards)});
    const state={repository:{commit:'a'.repeat(40)},viewer:{package:'test'},design:{schemaVersion:1,geometryRevision:'a'.repeat(40),instances:[]},boards:{assets:[],pins:[],memberships:[],floorPlans:[]}};
    store.importHistory({operationId:'import',actor:'owner',branches:[{name:'main',headRevisionId:'base'}],revisions:[{id:'base',parentRevisionIds:[],createdAt:'2026-01-01T00:00:00Z',actor:null,completeness:'complete',state}]});
    const tool=name=>projectBoardTools(store).find(t=>t.name===name).execute;
    const input={branch:'main',expectedHeadRevisionId:'base',operationId:'save',actor:'owner',roomId:'study',items:[{title:'Lamp',role:'inspiration',sourceUrl:'https://example.com/lamp'},{title:'invalid',role:'inspiration',sourceUrl:'javascript:alert(1)'}]};
    const first=tool('save_pins')(input);assert.deepEqual(first.results.map(x=>x.status),['created','invalid']);
    assert.deepEqual(tool('save_pins')(input),first);assert.deepEqual(store.getRevision(first.headRevisionId).state.design,state.design);
    const assigned=tool('assign_pin_room')({branch:'main',expectedHeadRevisionId:first.headRevisionId,operationId:'assign',actor:'owner',roomId:'hall',pinId:first.results[0].pinId});
    const selected=tool('set_pin_status')({branch:'main',expectedHeadRevisionId:assigned.headRevisionId,operationId:'select',actor:'owner',roomId:'hall',pinId:first.results[0].pinId,status:'Chosen'});
    const memberships=tool('get_pin')({revisionId:selected.headRevisionId,pinId:first.results[0].pinId}).memberships;
    assert.deepEqual(memberships.map(m=>m.status),['Idea','Chosen']);
    assert.equal(tool('search_pins')({revisionId:selected.headRevisionId,roomId:'hall',query:'lamp'}).items.length,1);
  } finally {db.close();}
});

test('different image URLs and render provenance stay separate; semantic retry IDs bind original arguments',()=>{
  const db=new DatabaseSync(':memory:');
  try {
    const store=createProjectStore({...nodeDesignStorage(db),projectId:'fixture',validateState:s=>validateProjectBoards(s.boards)});
    const state={repository:{commit:'a'.repeat(40)},viewer:{package:'test'},design:{schemaVersion:1,geometryRevision:'a'.repeat(40),instances:[]},boards:{assets:[],pins:[],memberships:[],floorPlans:[]}};
    store.importHistory({operationId:'import',actor:'owner',branches:[{name:'main',headRevisionId:'base'}],revisions:[{id:'base',parentRevisionIds:[],createdAt:'2026-01-01T00:00:00Z',actor:null,completeness:'complete',state}]});
    const tool=name=>projectBoardTools(store).find(t=>t.name===name).execute;
    const shared={title:'Lamp',role:'inspiration',sourceUrl:'https://example.com/lamp'};
    const input={branch:'main',expectedHeadRevisionId:'base',operationId:'photos',actor:'owner',roomId:'study',items:[{...shared,imageUrl:'https://example.com/front.png'},{...shared,imageUrl:'https://example.com/back.png'}]};
    const result=tool('save_pins')(input);assert.deepEqual(result.results.map(r=>r.status),['created','created']);assert.notEqual(result.results[0].pinId,result.results[1].pinId);
    assert.deepEqual(tool('save_pins')(input),result);
    const next={...input,expectedHeadRevisionId:result.headRevisionId,operationId:'duplicate',items:[input.items[0]]};
    const repeat=tool('save_pins')(next);assert.equal(repeat.results[0].status,'existing');
    assert.throws(()=>tool('save_pins')({...next,items:[input.items[1]]}),e=>e.code==='operation_reused');
    assert.throws(()=>tool('assign_pin_room')({branch:'main',expectedHeadRevisionId:repeat.headRevisionId,operationId:'inbox',actor:'owner',roomId:'inbox',pinId:result.results[0].pinId}),/Inbox/);
    const saved=store.getRevision(result.headRevisionId).state.boards.pins[0];assert.equal(saved.savedBy,'owner');assert.equal(saved.createdInOperationId,'photos');
    const invalid={...next,expectedHeadRevisionId:repeat.headRevisionId,operationId:'invalid-retry',items:[{title:'bad',role:'bad'}]};
    const bad=tool('save_pins')(invalid);assert.equal(bad.results[0].status,'invalid');
    assert.throws(()=>tool('save_pins')({...invalid,items:[{title:'different bad',role:'bad'}]}),e=>e.code==='operation_reused');
  } finally {db.close();}
});
