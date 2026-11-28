import { canonical, copy, equal, normalizeProjectState, projectError, required } from '../shared/project.mjs';
import { diffProjectStates, mergeProjectStates } from '../shared/project-merge.mjs';

// Both node:sqlite and Durable Object SQLite supply synchronous transactions.
// The caller authenticates every request. Actors below are trusted server values,
// never identities taken directly from an HTTP/MCP payload.
export function createProjectStore({sql,transaction,projectId,validateState,makeId=()=>crypto.randomUUID(),now=()=>new Date().toISOString()}) {
  required(projectId,'project ID');
  const rows=(q,...args)=>Array.from(sql.exec(q,...args));
  const first=(q,...args)=>rows(q,...args)[0];
  sql.exec('CREATE TABLE IF NOT EXISTS project_components (project TEXT NOT NULL,id TEXT NOT NULL,kind TEXT NOT NULL,content TEXT NOT NULL,PRIMARY KEY(project,id),UNIQUE(project,kind,content))');
  sql.exec('CREATE TABLE IF NOT EXISTS project_revisions (ordinal INTEGER PRIMARY KEY,project TEXT NOT NULL,id TEXT NOT NULL,document TEXT NOT NULL,UNIQUE(project,id))');
  sql.exec('CREATE TABLE IF NOT EXISTS project_branches (project TEXT NOT NULL,name TEXT NOT NULL,head TEXT NOT NULL,PRIMARY KEY(project,name))');
  sql.exec('CREATE TABLE IF NOT EXISTS project_operations (project TEXT NOT NULL,id TEXT NOT NULL,request TEXT NOT NULL,result TEXT NOT NULL,PRIMARY KEY(project,id))');
  sql.exec('CREATE TABLE IF NOT EXISTS project_merge_plans (project TEXT NOT NULL,id TEXT NOT NULL,document TEXT NOT NULL,PRIMARY KEY(project,id))');
  sql.exec('CREATE TABLE IF NOT EXISTS project_events (ordinal INTEGER PRIMARY KEY,project TEXT NOT NULL,id TEXT NOT NULL,document TEXT NOT NULL,UNIQUE(project,id))');
  const missing=what=>projectError(404,'not_found',what+' was not found.');
  const head=name=>first('SELECT head FROM project_branches WHERE project=? AND name=?',projectId,name)?.head;
  function getRevision(id,{includeState=true}={}) {
    required(id,'revision ID');
    const row=first('SELECT document FROM project_revisions WHERE project=? AND id=?',projectId,id);
    if(!row) throw missing('Project revision');
    const rev=JSON.parse(row.document);
    if(includeState) {
      rev.state={};
      for(const [kind,componentId] of Object.entries(rev.components)) {
        const c=first('SELECT content FROM project_components WHERE project=? AND id=?',projectId,componentId);
        if(!c) throw projectError(500,'missing_component','A retained revision references a missing component.',{revisionId:id,componentId});
        rev.state[kind]=JSON.parse(c.content);
      }
    }
    return rev;
  }
  function storeComponents(state) {
    return Object.fromEntries(Object.entries(state).map(([kind,value])=>{
      const content=canonical(value), prior=first('SELECT id FROM project_components WHERE project=? AND kind=? AND content=?',projectId,kind,content);
      const id=prior?.id??makeId();
      if(!prior) sql.exec('INSERT INTO project_components VALUES (?,?,?,?)',projectId,id,kind,content);
      return [kind,id];
    }));
  }
  function assertComplete(revision) {
    if(revision.completeness!=='complete') throw projectError(409,'incomplete_revision','This imported revision lacks recorded application state; complete its migration before editing or merging.',{revisionId:revision.id});
  }
  function checkHead(branch,expected) {
    required(branch,'branch'); required(expected,'expected head');
    const current=head(branch);
    if(current!==expected) throw projectError(409,'branch_conflict','The branch moved or is unavailable.',{branch,currentHeadRevisionId:current??null,expectedHeadRevisionId:expected});
  }
  function validate(state,parent,context={}) {
    if(parent && !validateState && (!equal(state.repository,parent.repository)||state.design.geometryRevision!==parent.design.geometryRevision)) {
      throw projectError(409,'geometry_validation_required','Repository or geometry changes require project validation.');
    }
    if(!validateState) return;
    let result;
    try { result=validateState(copy(state),parent?copy(parent):null,context); }
    catch(error) { if(error.status && error.code) throw error; throw projectError(400,'validation_failed',error.message || 'Project validation failed.'); }
    if(result?.then) throw projectError(500,'async_validator','Project validators must finish before the synchronous publication transaction.');
    if(result===false||result?.valid===false) throw projectError(400,'validation_failed','Project validation failed.',{errors:result?.errors??[]});
  }
  function emit(type,operationId,actor,branch,previousRevisionId,revisionId,extra={}) {
    const event={id:makeId(),schemaVersion:1,type,createdAt:now(),projectId,operationId,actor,branch,previousRevisionId,revisionId,...extra};
    sql.exec('INSERT INTO project_events(project,id,document) VALUES(?,?,?)',projectId,event.id,canonical(event));
  }
  function revisionFields(input) {
    const message=input.message??'', affectedObjectIds=input.affectedObjectIds??[];
    if(typeof message!=='string'||!Array.isArray(affectedObjectIds)||new Set(affectedObjectIds).size!==affectedObjectIds.length) throw projectError(400,'invalid_revision','Revision message must be text and affectedObjectIds must be a unique ID list.');
    affectedObjectIds.forEach(id=>required(id,'affected object ID'));
    return {message,affectedObjectIds};
  }
  function operation(kind,input,fn) {
    const op=copy(input); required(op.operationId,'operation ID');
    if(op.projectId!==undefined&&op.projectId!==projectId) throw projectError(400,'project_mismatch','Operation project disagrees with the bound store.');
    if(op.actor===undefined||op.actor===null) throw projectError(401,'actor_required','A trusted actor is required for new operations.');
    const request=canonical({kind,input:op});
    return transaction(()=>{
      const prior=first('SELECT request,result FROM project_operations WHERE project=? AND id=?',projectId,op.operationId);
      if(prior) {
        if(prior.request!==request) throw projectError(409,'operation_reused','This operation ID identifies a different request or actor.');
        return JSON.parse(prior.result);
      }
      const result=fn(op);
      sql.exec('INSERT INTO project_operations VALUES(?,?,?,?)',projectId,op.operationId,request,canonical(result));
      return copy(result);
    });
  }
  function publish(input,state,parents,type='project.revision_committed',extra={}) {
    state=normalizeProjectState(state);
    const parent=getRevision(parents[0]); assertComplete(parent);
    validate(state,parent.state,{kind:type,parentRevisionIds:parents,...extra});
    const id=makeId();
    const rev={schemaVersion:1,id,projectId,parentRevisionIds:parents,createdAt:now(),actor:input.actor,...revisionFields(input),operationId:input.operationId,completeness:'complete',components:storeComponents(state),...extra};
    sql.exec('INSERT INTO project_revisions(project,id,document) VALUES(?,?,?)',projectId,id,canonical(rev));
    sql.exec('UPDATE project_branches SET head=? WHERE project=? AND name=? AND head=?',id,projectId,input.branch,parents[0]);
    emit(type,input.operationId,input.actor,input.branch,parents[0],id,{affectedObjectIds:rev.affectedObjectIds});
    return {projectId,branch:input.branch,headRevisionId:id,revisionId:id};
  }
  function listBranches() {return rows('SELECT name,head AS headRevisionId FROM project_branches WHERE project=? ORDER BY name',projectId).map(row=>({...row}));}
  function createBranch(input) {
    return operation('create_branch',input,op=>{
      required(op.name,'branch name'); getRevision(op.fromRevisionId);
      if(head(op.name)) throw projectError(409,'branch_exists','This branch already exists.');
      sql.exec('INSERT INTO project_branches VALUES(?,?,?)',projectId,op.name,op.fromRevisionId);
      emit('branch.created',op.operationId,op.actor,op.name,null,op.fromRevisionId);
      return {projectId,branch:op.name,headRevisionId:op.fromRevisionId};
    });
  }
  function commit(input) {return operation('commit',input,op=>{
    checkHead(op.branch,op.expectedHeadRevisionId);
    return publish(op,op.state,[op.expectedHeadRevisionId]);
  });}
  function ancestors(id) {
    const seen=new Map(),queue=[id];
    while(queue.length) {const next=queue.pop();if(seen.has(next)) continue;const rev=getRevision(next,{includeState:false});seen.set(next,rev);queue.push(...rev.parentRevisionIds);}
    return seen;
  }
  function commonBase(a,b) {
    const aa=ancestors(a),bb=ancestors(b),common=[...aa.keys()].filter(id=>bb.has(id));
    const older=new Set();
    for(const id of common) for(const parent of aa.get(id).parentRevisionIds) for(const ancestor of ancestors(parent).keys()) older.add(ancestor);
    const bases=common.filter(id=>!older.has(id));
    if(bases.length!==1) throw projectError(409,'ambiguous_merge_base','A merge needs one unambiguous common ancestor.',{baseRevisionIds:bases});
    return bases[0];
  }
  function compare({from,to}) {return {fromRevisionId:from,toRevisionId:to,changes:diffProjectStates(getRevision(from).state,getRevision(to).state)};}
  function getMergePlan(id) {
    const row=first('SELECT document FROM project_merge_plans WHERE project=? AND id=?',projectId,required(id,'merge plan ID'));
    if(!row) throw missing('Merge plan');return JSON.parse(row.document);
  }
  function savePlan(op,details,resolutions={},previousPlanId=null) {
    const base=getRevision(details.baseRevisionId),target=getRevision(details.targetHeadRevisionId),source=getRevision(details.sourceHeadRevisionId);
    for(const rev of [base,target,source]) assertComplete(rev);
    const merged=mergeProjectStates(base.state,target.state,source.state,resolutions);
    let validation={valid:false,errors:[]};
    if(!merged.conflicts.length) {
      try {merged.candidate=normalizeProjectState(merged.candidate);validate(merged.candidate,target.state,{kind:'merge-preview',sourceRevisionId:source.id,baseRevisionId:base.id});validation={valid:true,errors:[]};}
      catch(error) {validation={valid:false,errors:[{code:error.code??'validation_failed',message:error.message,details:error.details??{}}]};}
    }
    const plan={schemaVersion:1,id:makeId(),projectId,createdAt:now(),actor:op.actor,operationId:op.operationId,previousPlanId,...details,
      resolutions,...merged,validation,diff:diffProjectStates(target.state,merged.candidate),preview:{status:'not-generated',revisionIds:[target.id,source.id]}};
    sql.exec('INSERT INTO project_merge_plans VALUES(?,?,?)',projectId,plan.id,canonical(plan));
    return plan;
  }
  function prepareMerge(input) {return operation('prepare_merge',input,op=>{
    if(op.sourceBranch===op.targetBranch) throw projectError(400,'same_branch','Choose two different branches.');
    checkHead(op.sourceBranch,op.expectedSourceHeadRevisionId);checkHead(op.targetBranch,op.expectedTargetHeadRevisionId);
    return savePlan(op,{sourceBranch:op.sourceBranch,targetBranch:op.targetBranch,sourceHeadRevisionId:op.expectedSourceHeadRevisionId,targetHeadRevisionId:op.expectedTargetHeadRevisionId,
      baseRevisionId:commonBase(op.expectedSourceHeadRevisionId,op.expectedTargetHeadRevisionId)});
  });}
  function resolveMerge(input) {return operation('resolve_merge',input,op=>{
    const plan=getMergePlan(op.planId);
    if(!op.resolutions||Array.isArray(op.resolutions)||typeof op.resolutions!=='object') throw projectError(400,'invalid_resolution','Provide a conflict-ID to resolution map.');
    // Deliberately permit resolving a stale plan: drafts survive, publication still guards both heads.
    return savePlan(op,{sourceBranch:plan.sourceBranch,targetBranch:plan.targetBranch,sourceHeadRevisionId:plan.sourceHeadRevisionId,targetHeadRevisionId:plan.targetHeadRevisionId,baseRevisionId:plan.baseRevisionId},
      {...plan.resolutions,...op.resolutions},plan.id);
  });}
  function commitMerge(input) {return operation('commit_merge',input,op=>{
    const plan=getMergePlan(op.planId);
    checkHead(plan.sourceBranch,plan.sourceHeadRevisionId);checkHead(plan.targetBranch,plan.targetHeadRevisionId);
    if(plan.conflicts.length||!plan.validation.valid) throw projectError(409,'merge_blocked','Resolve conflicts and validation failures before publishing.',{planId:plan.id,conflicts:plan.conflicts,validation:plan.validation});
    return publish({...op,branch:plan.targetBranch},plan.candidate,[plan.targetHeadRevisionId,plan.sourceHeadRevisionId],'project.merged',{mergePlanId:plan.id,resolutions:plan.resolutions});
  });}
  function revert(input) {return operation('revert',input,op=>{
    checkHead(op.branch,op.expectedHeadRevisionId);const desired=getRevision(op.revisionId);assertComplete(desired);
    return publish(op,desired.state,[op.expectedHeadRevisionId],'project.reverted',{restoredRevisionId:desired.id});
  });}
  function history({head:revisionId,cursor=null,limit=50}) {
    required(revisionId,'history head');
    if(!Number.isSafeInteger(limit)||limit<1||limit>200) throw projectError(400,'invalid_limit','History limit must be 1–200.');
    let offset=0;
    if(cursor!==null) {
      try {const c=JSON.parse(cursor);if(c.head!==revisionId||!Number.isSafeInteger(c.offset)||c.offset<0) throw Error();offset=c.offset;}
      catch {throw projectError(400,'invalid_cursor','Cursor must belong to this history head.');}
    }
    const reachable=ancestors(revisionId);
    const ordered=rows('SELECT id FROM project_revisions WHERE project=? ORDER BY ordinal DESC',projectId).map(x=>x.id).filter(id=>reachable.has(id));
    return {headRevisionId:revisionId,revisions:ordered.slice(offset,offset+limit).map(id=>reachable.get(id)),nextCursor:offset+limit<ordered.length?JSON.stringify({head:revisionId,offset:offset+limit}):null};
  }
  function events({cursor=0,limit=100}={}) {
    if(!Number.isSafeInteger(cursor)||cursor<0||!Number.isSafeInteger(limit)||limit<1||limit>200) throw projectError(400,'invalid_cursor','Invalid event cursor or limit.');
    const list=rows('SELECT ordinal,document FROM project_events WHERE project=? AND ordinal>? ORDER BY ordinal LIMIT ?',projectId,cursor,limit);
    return {events:list.map(x=>({...JSON.parse(x.document),cursor:x.ordinal})),nextCursor:list.at(-1)?.ordinal??cursor};
  }
  function importHistory(input) {return operation('import_history',input,op=>{
    if(!Array.isArray(op.revisions)||!Array.isArray(op.branches)) throw projectError(400,'invalid_import','Import revisions and branches are required.');
    const pending=new Map();
    for(const raw of op.revisions) {
      required(raw.id,'import revision ID');
      if(raw.projectId!==undefined&&raw.projectId!==projectId) throw projectError(400,'project_mismatch','Imported revision belongs to another project.');
      if(pending.has(raw.id)) throw projectError(400,'duplicate_revision','Duplicate imported revision ID.');
      if(!Array.isArray(raw.parentRevisionIds)||new Set(raw.parentRevisionIds).size!==raw.parentRevisionIds.length) throw projectError(400,'invalid_parents','Revision parents must be unique IDs.');
      raw.parentRevisionIds.forEach(id=>required(id,'parent revision ID'));
      if(!Number.isFinite(Date.parse(raw.createdAt))) throw projectError(400,'invalid_date','Imported revision needs its recorded timestamp.');
      if(raw.actor===undefined) throw projectError(400,'invalid_actor','Use explicit null for unknown historical actors.');
      const completeness=raw.completeness??'source-only';
      const state=normalizeProjectState(raw.state,{completeness});
      pending.set(raw.id,{raw,state,completeness});
    }
    const ordered=[],done=new Set(),visiting=new Set();
    function visit(id) {
      if(done.has(id))return;
      if(visiting.has(id))throw projectError(400,'cyclic_history','Imported history contains a cycle.',{revisionId:id});
      const entry=pending.get(id);
      if(!entry){getRevision(id,{includeState:false});return;}
      visiting.add(id);entry.raw.parentRevisionIds.forEach(visit);visiting.delete(id);done.add(id);ordered.push(entry);
    }
    for(const id of pending.keys())visit(id);
    let imported=0;
    for(const {raw,state,completeness} of ordered) {
      const metadata={schemaVersion:1,id:raw.id,projectId,parentRevisionIds:raw.parentRevisionIds,createdAt:raw.createdAt,actor:raw.actor,...revisionFields(raw),operationId:raw.operationId??null,completeness,...(raw.source!==undefined?{source:raw.source}:{})};
      const existing=first('SELECT id FROM project_revisions WHERE project=? AND id=?',projectId,raw.id);
      if(existing) {
        const old=getRevision(raw.id),{state:oldState,components,...oldMetadata}=old;
        if(!equal(oldMetadata,metadata)||!equal(oldState,state))throw projectError(409,'import_collision','An imported ID already identifies different data.',{revisionId:raw.id});
        continue;
      }
      // Imports preserve historical validation status. They do not assert that an
      // old accepted design passes today's geometry/permit rules.
      const document={...metadata,components:storeComponents(state)};
      sql.exec('INSERT INTO project_revisions(project,id,document) VALUES(?,?,?)',projectId,raw.id,canonical(document));imported++;
    }
    for(const branch of op.branches) {
      required(branch.name,'branch name');getRevision(branch.headRevisionId,{includeState:false});
      const old=head(branch.name);
      if(old&&old!==branch.headRevisionId)throw projectError(409,'branch_conflict','Import cannot overwrite an existing branch.',{branch:branch.name,currentHeadRevisionId:old});
      if(!old)sql.exec('INSERT INTO project_branches VALUES(?,?,?)',projectId,branch.name,branch.headRevisionId);
    }
    emit('project.history_imported',op.operationId,op.actor,null,null,null,{importedRevisions:imported});
    return {projectId,importedRevisions:imported,branches:listBranches()};
  });}
  function receipt(operationId) {
    const row=first('SELECT result FROM project_operations WHERE project=? AND id=?',projectId,required(operationId,'operation ID'));
    if(!row) throw missing('Operation receipt'); return JSON.parse(row.result);
  }
  return {projectId,getRevision,listBranches,createBranch,commit,history,compare,prepareMerge,getMergePlan,resolveMerge,commitMerge,revert,events,importHistory,receipt};
}
