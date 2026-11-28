import { DesignError } from '../shared/design.mjs';
import { canonical } from '../shared/project.mjs';
import { validateProjectBoards } from '../shared/project-board.mjs';

const str={type:'string',minLength:1,maxLength:1024};
const read={revisionId:{...str,description:'Exact project revision to read.'}};
const write={branch:str,expectedHeadRevisionId:str,operationId:{...str,description:'Retry identical requests using this same ID.'}};
const schema=(fields,required=Object.keys(fields))=>({type:'object',properties:{projectId:str,...fields},required:['projectId',...required],additionalProperties:false});
const pinIdentity=pin=>canonical(Object.fromEntries(['assetId','imageUrl','sourceUrl','role','projectRevisionId','prompt','inputImageIds'].map(key=>[key,pin[key]??null])));
const blank=()=>({floorPlans:[],pins:[],memberships:[],assets:[]});
const fail=(message)=>{throw new DesignError(400,'invalid_pin',message);};

// Semantic operations build state from the named immutable base, so retries derive
// exactly the same commit request even after the live branch has advanced.
export function projectBoardTools(store) {
  const tools=[];
  const add=(name,description,inputSchema,mutates,execute)=>tools.push({name,description,inputSchema,mutates,execute,
    annotations:{readOnlyHint:!mutates,destructiveHint:mutates,idempotentHint:true,openWorldHint:false}});
  const boards=id=>store.getRevision(id).state.boards??blank();
  const save=(tool,input,change)=>{
    const base=store.getRevision(input.expectedHeadRevisionId),state=structuredClone(base.state);
    state.boards??=blank();
    const result=change(state.boards);
    validateProjectBoards(state.boards);
    const receipt=store.commit({branch:input.branch,expectedHeadRevisionId:input.expectedHeadRevisionId,operationId:input.operationId,actor:input.actor,
      message:'Update room references',state,semanticOperation:{tool,input}});
    return {...receipt,...result};
  };
  add('list_boards','List mapped rooms and room reference boards at an exact revision.',schema(read),false,input=>{
    const state=boards(input.revisionId),rooms=new Map();
    for(const plan of state.floorPlans??[])for(const room of plan.rooms)rooms.set(room.id,{id:room.id,name:room.name,floorPlanId:plan.id});
    for(const member of state.memberships??[])if(!rooms.has(member.roomId))rooms.set(member.roomId,{id:member.roomId,name:member.roomId});
    return {revisionId:input.revisionId,boards:[{id:'inbox',name:'Inbox'},...rooms.values()]};
  });
  add('search_pins','Search room references by title, notes or source URL. Returns a bounded page in saved manual order.',schema({...read,roomId:str,query:{type:'string'},status:{type:'string',enum:['Idea','Shortlist','Chosen']},offset:{type:'integer',minimum:0},limit:{type:'integer',minimum:1,maximum:100}},['revisionId','roomId']),false,input=>{
    const b=boards(input.revisionId),pins=new Map((b.pins??[]).map(p=>[p.id,p])),q=(input.query??'').toLowerCase();
    let rows=(b.memberships??[]).filter(m=>m.roomId===input.roomId&&(!input.status||m.status===input.status)).sort((a,b)=>a.rank-b.rank||a.id.localeCompare(b.id)).map(m=>({pin:pins.get(m.pinId),membership:m}));
    if(input.roomId==='inbox')rows=[...pins.values()].filter(p=>!(b.memberships??[]).some(m=>m.pinId===p.id)).map(pin=>({pin}));
    rows=rows.filter(r=>r.pin&&[r.pin.title,r.pin.notes,r.pin.sourceUrl].some(v=>String(v??'').toLowerCase().includes(q)));
    const start=input.offset??0,end=start+(input.limit??50);
    return {revisionId:input.revisionId,items:rows.slice(start,end),nextOffset:end<rows.length?end:null};
  });
  add('get_pin','Read an image reference with its roles, provenance and room-specific memberships.',schema({...read,pinId:str}),false,input=>{
    const b=boards(input.revisionId),pin=b.pins?.find(p=>p.id===input.pinId);if(!pin)throw new DesignError(404,'not_found','Pin was not found.');
    return {revisionId:input.revisionId,pin,memberships:b.memberships?.filter(m=>m.pinId===pin.id)??[]};
  });
  add('save_pins','Save up to 20 image or product references to an explicit room board. Supply previously uploaded asset IDs; preserve source URLs. Each item returns created, existing, or invalid. Different photos from one product page remain distinct.',schema({...write,roomId:str,items:{type:'array',maxItems:20,items:{type:'object'}}}),true,input=>save('save_pins',input,b=>{
    if(!input.items.length)fail('Supply at least one reference.');
    b.pins??=[];b.memberships??=[];const results=[];
    for(const [i,item] of input.items.entries()){
      if(!item || typeof item!=='object' || Array.isArray(item)){results.push({index:i,status:'invalid',error:'Expected a reference object.'});continue;}
      const identity=pinIdentity(item);
      const existing=b.pins.find(p=>pinIdentity(p)===identity);
      // Validate supplied provenance even when an identical image is already saved.
      try{validateProjectBoards({...b,pins:[...b.pins,{...item,id:'candidate:'+input.operationId+':'+i}]});}catch(error){results.push({index:i,status:'invalid',error:error.message});continue;}
      if(existing&&(input.roomId==='inbox'||b.memberships.some(m=>m.roomId===input.roomId&&m.pinId===existing.id))){results.push({index:i,pinId:existing.id,status:'existing'});continue;}
      const pin=existing??{...item,id:'pin:'+input.operationId+':'+i,savedBy:input.actor,createdInOperationId:input.operationId};
      const membership={id:'membership:'+input.operationId+':'+i,roomId:input.roomId,pinId:pin.id,status:'Idea',rank:Math.max(-1,...b.memberships.filter(m=>m.roomId===input.roomId).map(m=>m.rank))+1};
      const candidate={...b,pins:existing?b.pins:[...b.pins,pin],memberships:input.roomId==='inbox'?b.memberships:[...b.memberships,membership]};
      try{validateProjectBoards(candidate);}catch(error){results.push({index:i,status:'invalid',error:error.message});continue;}
      b.pins=candidate.pins;b.memberships=candidate.memberships;results.push({index:i,pinId:pin.id,status:'created'});
    }
    return {roomId:input.roomId,results};
  }));
  add('set_pin_status','Set one room membership to Idea, Shortlist or Chosen without changing its other rooms.',schema({...write,roomId:str,pinId:str,status:{type:'string',enum:['Idea','Shortlist','Chosen']}}),true,input=>save('set_pin_status',input,b=>{
    const m=b.memberships?.find(m=>m.roomId===input.roomId&&m.pinId===input.pinId);if(!m)fail('Pin is not in that room.');m.status=input.status;return {pinId:input.pinId,roomId:input.roomId};
  }));
  add('assign_pin_room','Attach an existing pin to another room; keep all existing memberships.',schema({...write,roomId:str,pinId:str}),true,input=>save('assign_pin_room',input,b=>{
    if(input.roomId==='inbox')fail('Inbox contains unassigned pins; it is not a room membership.');
    if(!b.pins?.some(p=>p.id===input.pinId))fail('Unknown pin.');b.memberships??=[];
    if(!b.memberships.some(m=>m.roomId===input.roomId&&m.pinId===input.pinId))b.memberships.push({id:'membership:'+input.operationId,roomId:input.roomId,pinId:input.pinId,status:'Idea',rank:Math.max(-1,...b.memberships.filter(m=>m.roomId===input.roomId).map(m=>m.rank))+1});
    return {pinId:input.pinId,roomId:input.roomId};
  }));
  return tools;
}
