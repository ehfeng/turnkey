import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { createProjectStore } from '../server/project-store.mjs';
import { mergeProjectStates } from '../shared/project-merge.mjs';

const sha='a'.repeat(40), otherSha='b'.repeat(40);
const baseState=()=>({repository:{commit:sha},design:{schemaVersion:1,geometryRevision:sha,instances:[{id:'chair',roomId:'studio',assetRevision:'asset:oak',xMm:10,yMm:20,zMm:0,yawDeg:0}]},boards:{schemaVersion:1,floorPlans:[],pins:[],memberships:[]},viewer:{packageRevision:'fixture-1'}});
const actor={id:'owner'};
function fixture(options={}) {
  const db=new DatabaseSync(':memory:'); let sequence=0;
  const store=createProjectStore({projectId:'synthetic',sql:{exec:(q,...args)=>db.prepare(q).all(...args)},transaction(fn){db.exec('BEGIN IMMEDIATE');try {const result=fn();db.exec('COMMIT');return result;}catch(e){db.exec('ROLLBACK');throw e;}},makeId:()=>`generated-${++sequence}`,now:()=> '2026-01-01T00:00:00Z',...options});
  store.importHistory({operationId:'seed',actor,revisions:[{id:'root',parentRevisionIds:[],createdAt:'2025-12-01T00:00:00Z',actor:null,message:'Imported',state:baseState(),completeness:'complete',source:{legacyDesignId:'old'}}],branches:[{name:'main',headRevisionId:'root'}]});
  return {store,db};
}
function edit(store,branch,expected,id,change) {const state=store.getRevision(expected).state;change(state);return store.commit({branch,expectedHeadRevisionId:expected,operationId:id,actor,state,message:id}).headRevisionId;}
function branch(store,name){store.createBranch({name,fromRevisionId:'root',operationId:'branch-'+name,actor});}
function plan(store,s,t){return store.prepareMerge({sourceBranch:'option',targetBranch:'main',expectedSourceHeadRevisionId:s,expectedTargetHeadRevisionId:t,operationId:`plan-${s}-${t}`,actor});}

test('immutable components, exact retries and actor/payload reuse checks',()=>{
  const {store}=fixture();const original=store.getRevision('root');
  const input={branch:'main',expectedHeadRevisionId:'root',operationId:'move',actor,message:'Move chair',state:baseState()};input.state.design.instances[0].xMm=100;
  const result=store.commit(input);assert.deepEqual(store.commit(input),result);
  assert.equal(store.getRevision('root').state.design.instances[0].xMm,10);
  assert.equal(store.getRevision(result.revisionId).components.repository,original.components.repository);
  assert.notEqual(store.getRevision(result.revisionId).components.design,original.components.design);
  assert.throws(()=>store.commit({...input,actor:{id:'intruder'}}),e=>e.code==='operation_reused');
  input.state.design.instances[0].xMm=200;assert.throws(()=>store.commit(input),e=>e.code==='operation_reused');
  assert.equal(store.events().events.filter(x=>x.type==='project.revision_committed').length,1);
});
test('stale CAS and validator failures roll back every publication row',()=>{
  const {store,db}=fixture({validateState(state){if(state.design.instances[0].xMm<0)throw Error('Outside room');}});
  const one=edit(store,'main','root','one',s=>s.design.instances[0].xMm=50);
  const before=db.prepare('SELECT count(*) AS n FROM project_revisions').get().n;
  assert.throws(()=>edit(store,'main','root','stale',s=>s.design.instances[0].xMm=80),e=>e.code==='branch_conflict');
  assert.throws(()=>edit(store,'main',one,'invalid',s=>s.design.instances[0].xMm=-1),/Outside room/);
  assert.equal(db.prepare('SELECT count(*) AS n FROM project_revisions').get().n,before);
  assert.equal(store.events().events.length,2);
  assert.equal(db.prepare('SELECT count(*) AS n FROM project_operations').get().n,2);
});
test('three-way merge retains independent stable-ID changes and both parents',()=>{
  const {store}=fixture();branch(store,'option');
  const a=edit(store,'main','root','target',s=>s.boards.pins.push({id:'lamp',title:'Lamp'}));
  const b=edit(store,'option','root','source',s=>s.design.instances[0].yawDeg=90);
  const merge=plan(store,b,a);assert.equal(merge.conflicts.length,0);assert.equal(merge.validation.valid,true);
  const input={planId:merge.id,operationId:'merge',actor};const result=store.commitMerge(input);
  assert.deepEqual(store.commitMerge(input),result);
  const revision=store.getRevision(result.revisionId);assert.deepEqual(revision.parentRevisionIds,[a,b]);
  assert.equal(revision.state.boards.pins[0].id,'lamp');assert.equal(revision.state.design.instances[0].yawDeg,90);
  assert.equal(store.listBranches().find(x=>x.name==='option').headRevisionId,b);
});
test('edit/delete conflict resolutions create immutable plans',()=>{
  const {store}=fixture();branch(store,'option');
  const a=edit(store,'main','root','target',s=>s.design.instances[0].xMm=90);
  const b=edit(store,'option','root','source',s=>s.design.instances=[]);
  const merge=plan(store,b,a);assert.equal(merge.conflicts[0].kind,'edit/delete');assert.equal(merge.conflicts[0].entityId,'chair');
  assert.equal(merge.conflicts[0].present.source,false);
  assert.throws(()=>store.commitMerge({planId:merge.id,operationId:'blocked',actor}),e=>e.code==='merge_blocked');
  const resolved=store.resolveMerge({planId:merge.id,resolutions:{[merge.conflicts[0].id]:{choice:'source'}},operationId:'resolve',actor});
  assert.equal(store.getMergePlan(merge.id).conflicts.length,1);assert.equal(resolved.previousPlanId,merge.id);assert.equal(resolved.conflicts.length,0);
  assert.deepEqual(store.getRevision(store.commitMerge({planId:resolved.id,operationId:'merge',actor}).revisionId).state.design.instances,[]);
});
test('both merge heads are guarded and stale plans stay readable',()=>{
  for(const changedBranch of ['main','option']){
    const {store}=fixture();branch(store,'option');const merge=plan(store,'root','root');
    edit(store,changedBranch,'root','later',s=>s.boards.pins.push({id:'later'}));
    assert.throws(()=>store.commitMerge({planId:merge.id,operationId:'merge',actor}),e=>e.code==='branch_conflict');
    assert.equal(store.getMergePlan(merge.id).id,merge.id);
  }
});
test('same-field and add/add conflicts never use silent last-writer wins',()=>{
  const base={pins:[{id:'x',title:'old'}]},target={pins:[{id:'x',title:'ours'},{id:'new',title:'a'}]},source={pins:[{id:'new',title:'b'},{id:'x',title:'theirs'}]};
  const merge=mergeProjectStates(base,target,source);assert.equal(merge.conflicts.length,2);
  assert.deepEqual(new Set(merge.conflicts.map(x=>x.kind)),new Set(['value','add/add']));
  assert.throws(()=>mergeProjectStates(base,target,source,{'/missing':{choice:'target'}}),e=>e.code==='unknown_conflict');
});
test('repository/geometry change requires validator and invalid merge blocks',()=>{
  const {store}=fixture();assert.throws(()=>edit(store,'main','root','geometry',s=>{s.repository.commit=otherSha;s.design.geometryRevision=otherSha;}),e=>e.code==='geometry_validation_required');
  const validated=fixture({validateState(s,p,context){if(context.kind==='merge-preview')return {valid:false,errors:['Placement no longer fits']};}}).store;
  branch(validated,'option');const changed=edit(validated,'option','root','geometry',s=>{s.repository.commit=otherSha;s.design.geometryRevision=otherSha;});
  const merge=plan(validated,changed,'root');assert.equal(merge.validation.valid,false);assert.throws(()=>validated.commitMerge({planId:merge.id,operationId:'merge',actor}),e=>e.code==='merge_blocked');
});
test('revert records a new commit; history pagination stays pinned to head',()=>{
  const {store}=fixture();const a=edit(store,'main','root','one',s=>s.design.instances[0].xMm=77);
  const input={branch:'main',expectedHeadRevisionId:a,revisionId:'root',operationId:'restore',actor};const result=store.revert(input);assert.deepEqual(store.revert(input),result);
  const restored=store.getRevision(result.revisionId);assert.deepEqual(restored.state,baseState());assert.deepEqual(restored.parentRevisionIds,[a]);
  const first=store.history({head:result.revisionId,limit:1});const second=store.history({head:result.revisionId,cursor:first.nextCursor,limit:1});assert.equal(second.revisions[0].id,a);
  assert.throws(()=>store.history({head:'root',cursor:first.nextCursor}),e=>e.code==='invalid_cursor');
  assert.equal(store.compare({from:'root',to:result.revisionId}).changes.length,0);
});
test('import preserves source-only ancestry, null actors, and is repeatable',()=>{
  const {store}=fixture();const input={operationId:'import',actor,revisions:[{id:'git:child',parentRevisionIds:['git:parent'],createdAt:'2020-01-02',actor:null,state:{repository:{commit:otherSha}},source:{gitParents:['parent']}},{id:'git:parent',parentRevisionIds:[],createdAt:'2020-01-01',actor:null,state:{repository:{commit:sha}}}],branches:[{name:'archive',headRevisionId:'git:child'}]};
  assert.equal(store.importHistory(input).importedRevisions,2);assert.equal(store.importHistory(input).importedRevisions,2);
  assert.equal(store.importHistory({...input,operationId:'another-import'}).importedRevisions,0);
  assert.equal(store.getRevision('git:child').actor,null);assert.equal(store.getRevision('git:child').completeness,'source-only');
  assert.throws(()=>store.commit({branch:'archive',expectedHeadRevisionId:'git:child',state:baseState(),operationId:'bad-upgrade',actor}),e=>e.code==='incomplete_revision');
  assert.equal(store.history({head:'git:child'}).revisions.length,2);
});
test('import collision, missing parents, cycles and branch conflict are all atomic',()=>{
  for(const mode of ['collision','missing','cycle','branch']) {
    const {store,db}=fixture();const rev={id:'new',parentRevisionIds:[],createdAt:'2020-01-01',actor:null,state:{repository:{commit:sha}}};
    if(mode==='collision')rev.id='root';if(mode==='missing')rev.parentRevisionIds=['missing'];if(mode==='cycle')rev.parentRevisionIds=['new'];
    assert.throws(()=>store.importHistory({operationId:'bad',actor,revisions:[rev],branches:mode==='branch'?[{name:'main',headRevisionId:'new'}]:[]}));
    assert.equal(db.prepare('SELECT count(*) AS n FROM project_revisions').get().n,1);assert.equal(store.events().events.length,1);
  }
});
test('unsafe and non-JSON values cannot enter immutable state',()=>{
  const {store}=fixture();
  assert.throws(()=>edit(store,'main','root','nan',s=>s.design.instances[0].xMm=NaN),e=>e.code==='invalid_state');
  assert.throws(()=>edit(store,'main','root','duplicate',s=>s.boards.pins=[{id:'a'},{id:'a'}]),e=>e.code==='duplicate_id');
  assert.throws(()=>edit(store,'main','root','proto',s=>s.extra=JSON.parse('{"__proto__":{}}')),e=>e.code==='invalid_state');
});
test('criss-cross ancestry requires an explicit supported base; no arbitrary winner',()=>{
  const {store}=fixture();
  const revisions=[{id:'a',parentRevisionIds:['root']},{id:'b',parentRevisionIds:['root']},{id:'ab',parentRevisionIds:['a','b']},{id:'ba',parentRevisionIds:['b','a']}].map(r=>({...r,createdAt:'2020-01-01',actor:null,state:baseState(),completeness:'complete'}));
  store.importHistory({operationId:'cross',actor,revisions,branches:[{name:'cross-a',headRevisionId:'ab'},{name:'cross-b',headRevisionId:'ba'}]});
  assert.throws(()=>store.prepareMerge({sourceBranch:'cross-a',targetBranch:'cross-b',expectedSourceHeadRevisionId:'ab',expectedTargetHeadRevisionId:'ba',operationId:'plan-cross',actor}),e=>e.code==='ambiguous_merge_base'&&e.details.baseRevisionIds.length===2);
});
test('historical reads and caller mutation cannot rewrite retained state',()=>{
  const {store}=fixture();const read=store.getRevision('root');read.state.design.instances[0].xMm=9999;
  assert.equal(store.getRevision('root').state.design.instances[0].xMm,10);
  assert.deepEqual(store.receipt('seed').branches,[{name:'main',headRevisionId:'root'}]);
});
