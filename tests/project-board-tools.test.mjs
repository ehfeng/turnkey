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
