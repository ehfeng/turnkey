import { canonical, copy, projectError } from './project.mjs';
const absent = Symbol('absent');
const same = (a,b) => a === absent || b === absent ? a === b : canonical(a) === canonical(b);
const object = v => v && v !== absent && typeof v === 'object' && !Array.isArray(v);
const idList = v => Array.isArray(v) && v.every(x => object(x) && typeof x.id === 'string');
const pointer = parts => '/' + parts.map(x => x.replaceAll('~','~0').replaceAll('/','~1')).join('/');

export function mergeProjectStates(base, target, source, resolutions = {}) {
  const conflicts = [], used = new Set();
  function merge(b,t,s,path) {
    if (same(t,s)) return t;
    if (same(b,t)) return s;
    if (same(b,s)) return t;
    if (object(b) && object(t) && object(s)) {
      const result = {};
      for (const key of [...new Set([...Object.keys(b),...Object.keys(t),...Object.keys(s)])].sort()) {
        const child = merge(Object.hasOwn(b,key)?b[key]:absent,Object.hasOwn(t,key)?t[key]:absent,Object.hasOwn(s,key)?s[key]:absent,[...path,key]);
        if (child !== absent) result[key] = child;
      }
      return result;
    }
    if (idList(b) && idList(t) && idList(s)) {
      const maps = [b,t,s].map(rows => new Map(rows.map(row => [row.id,row])));
      const order = [...new Set([...t.map(x=>x.id), ...s.map(x=>x.id)])];
      return order.map(id => merge(...maps.map(m => m.has(id)?m.get(id):absent),[...path,'@'+id])).filter(v=>v!==absent);
    }
    const id = pointer(path), resolution = Object.hasOwn(resolutions,id) ? resolutions[id] : null;
    if (resolution) {
      used.add(id);
      if (resolution.choice === 'base') return b;
      if (resolution.choice === 'target') return t;
      if (resolution.choice === 'source') return s;
      if (resolution.choice === 'value' && Object.hasOwn(resolution,'value')) return copy(resolution.value);
      if (resolution.choice === 'delete') return absent;
      throw projectError(400,'invalid_resolution','Choose base, target, source, value, or delete.',{path:id});
    }
    conflicts.push({id,path:id,entityId:[...path].reverse().find(x=>x.startsWith('@'))?.slice(1)??null,
      kind:b===absent?'add/add':t===absent||s===absent?'edit/delete':'value',
      base:b===absent?null:copy(b),target:t===absent?null:copy(t),source:s===absent?null:copy(s),
      present:{base:b!==absent,target:t!==absent,source:s!==absent},choices:['base','target','source','value','delete']});
    return t;
  }
  const candidate = merge(base,target,source,[]);
  for (const id of Object.keys(resolutions)) if (!used.has(id)) throw projectError(400,'unknown_conflict','Resolution does not identify a conflict.',{path:id});
  return {candidate,conflicts};
}

export function diffProjectStates(before,after) {
  const changes = [];
  function visit(a,b,path) {
    if (same(a,b)) return;
    if (object(a)&&object(b)) {
      for(const key of [...new Set([...Object.keys(a),...Object.keys(b)])].sort()) visit(Object.hasOwn(a,key)?a[key]:absent,Object.hasOwn(b,key)?b[key]:absent,[...path,key]);
    } else if (idList(a)&&idList(b)) {
      const am=new Map(a.map(x=>[x.id,x])),bm=new Map(b.map(x=>[x.id,x]));
      for(const id of [...new Set([...am.keys(),...bm.keys()])].sort()) visit(am.has(id)?am.get(id):absent,bm.has(id)?bm.get(id):absent,[...path,'@'+id]);
    } else changes.push({path:pointer(path),before:a===absent?null:copy(a),after:b===absent?null:copy(b),present:{before:a!==absent,after:b!==absent}});
  }
  visit(before,after,[]); return changes;
}
