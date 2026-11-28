import { DesignError } from './design.mjs';

const fail = (path, message) => { throw new DesignError(400, 'invalid_board', message, { path, documentationTopic: 'floor_plans' }); };
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const text = (value, path) => { if (typeof value !== 'string' || !value.trim() || value.length > 2048) fail(path, 'Expected a nonempty string.'); };
function index(rows, path) {
  if (!Array.isArray(rows)) fail(path, 'Expected an array.');
  const result = new Map();
  for (const [i, row] of rows.entries()) {
    if (!object(row)) fail(`${path}/${i}`, 'Expected a record.');
    text(row.id, `${path}/${i}/id`);
    if (result.has(row.id)) fail(path, 'IDs must be unique.');
    result.set(row.id, row);
  }
  return result;
}
const cross = (a, b, c) => (b[0]-a[0])*(c[1]-a[1])-(b[1]-a[1])*(c[0]-a[0]);
const onSegment = (a, b, p) => cross(a,b,p) === 0 && p[0] >= Math.min(a[0],b[0]) && p[0] <= Math.max(a[0],b[0]) && p[1] >= Math.min(a[1],b[1]) && p[1] <= Math.max(a[1],b[1]);
function intersects(a,b,c,d) {
  const abC=cross(a,b,c), abD=cross(a,b,d), cdA=cross(c,d,a), cdB=cross(c,d,b);
  return (abC*abD < 0 && cdA*cdB < 0) || onSegment(a,b,c) || onSegment(a,b,d) || onSegment(c,d,a) || onSegment(c,d,b);
}
export function validateRoomPolygon(polygon, path = '/polygon') {
  if (!Array.isArray(polygon) || polygon.length < 3 || polygon.length > 1000) fail(path, 'Use 3–1000 distinct vertices.');
  const unique = new Set();
  for (const p of polygon) {
    if (!Array.isArray(p) || p.length !== 2 || p.some(n => !Number.isFinite(n) || n < 0 || n > 1)) fail(path, 'Coordinates must be finite [x,y] pairs between zero and one.');
    const key=JSON.stringify(p);
    if (unique.has(key)) fail(path, 'Do not repeat a vertex, including the closing vertex.');
    unique.add(key);
  }
  let area=0;
  for (let i=0;i<polygon.length;i++) {
    const a=polygon[i], b=polygon[(i+1)%polygon.length];
    area += a[0]*b[1]-a[1]*b[0];
    for (let j=i+1;j<polygon.length;j++) {
      if (j === i+1 || (i===0 && j===polygon.length-1)) continue;
      if (intersects(a,b,polygon[j],polygon[(j+1)%polygon.length])) fail(path, 'Room polygons cannot intersect themselves.');
    }
  }
  if (Math.abs(area)<1e-12) fail(path,'Room polygon must have nonzero area.');
  return polygon;
}

// Server-side validation is shared by HTTP, MCP, imports, merges and website saves.
// Physical dimensions remain in the repository adapter; these are clickable regions.
export function validateProjectBoards(value) {
  if (!object(value)) fail('/boards','Expected board state.');
  const assets=index(value.assets??[], '/boards/assets');
  const plans=index(value.floorPlans??[], '/boards/floorPlans');
  const pins=index(value.pins??[], '/boards/pins');
  const memberships=index(value.memberships??[], '/boards/memberships');
  const rooms=new Set();
  for (const asset of assets.values()) {
    text(asset.storageKey,'/assets/storageKey');
    if (!/^[a-f0-9]{64}$/.test(asset.sha256)) fail('/assets/sha256','Expected a SHA-256 digest.');
    text(asset.mimeType,'/assets/mimeType');
  }
  for (const plan of plans.values()) {
    const asset=assets.get(plan.assetId);
    if (!asset || asset.mimeType !== 'image/png') fail('/floorPlans/assetId','Floor plans require a stored PNG asset.');
    if (![plan.width,plan.height].every(n=>Number.isSafeInteger(n)&&n>0)) fail('/floorPlans','PNG dimensions must be positive integers.');
    if (asset.width !== plan.width || asset.height !== plan.height) fail('/floorPlans','Dimensions must match the verified PNG asset.');
    const regions=index(plan.rooms,'/floorPlans/rooms');
    if (!regions.size) fail('/floorPlans/rooms','Map at least one room.');
    for (const room of regions.values()) {
      if (rooms.has(room.id)) fail('/floorPlans/rooms','A room ID must identify one mapped region.');
      rooms.add(room.id); text(room.name,'/rooms/name'); validateRoomPolygon(room.polygon);
    }
  }
  const roles=new Set(['current_photo','model_render','inspiration','generated_concept']);
  for (const pin of pins.values()) {
    text(pin.title,'/pins/title');
    if (!roles.has(pin.role)) fail('/pins/role','Choose current_photo, model_render, inspiration or generated_concept.');
    if (pin.assetId && !assets.has(pin.assetId)) fail('/pins/assetId','Unknown image asset.');
    if (!pin.assetId && !pin.imageUrl && !pin.sourceUrl) fail('/pins','Supply an image or source URL.');
    for(const field of ['sourceUrl','imageUrl']) if (pin[field]) {
      let url; try { url=new URL(pin[field]); } catch { fail('/pins/'+field,'Expected an HTTPS or HTTP URL.'); }
      if (!['https:','http:'].includes(url.protocol)) fail('/pins/'+field,'Expected an HTTPS or HTTP URL.');
    }
    if (pin.role === 'model_render') text(pin.projectRevisionId,'/pins/projectRevisionId');
    if (pin.role === 'generated_concept') {
      text(pin.prompt,'/pins/prompt');
      if (!Array.isArray(pin.inputImageIds) || new Set(pin.inputImageIds).size!==pin.inputImageIds.length || pin.inputImageIds.some(id=>id===pin.id||!pins.has(id))) fail('/pins/inputImageIds','Identify the source image pins.');
    }
  }
  const pairs=new Set();
  for (const member of memberships.values()) {
    if (!pins.has(member.pinId)) fail('/memberships/pinId','Unknown pin.');
    // Existing repository room IDs may precede PNG mapping. The project adapter validates their ownership.
    text(member.roomId,'/memberships/roomId');
    if(member.roomId==='inbox')fail('/memberships/roomId','Inbox is the set of unassigned pins, not a room.');
    const key=JSON.stringify([member.roomId,member.pinId]);
    if (pairs.has(key)) fail('/memberships','A pin belongs to each room at most once.');
    pairs.add(key);
    if (!['Idea','Shortlist','Chosen'].includes(member.status)) fail('/memberships/status','Choose Idea, Shortlist or Chosen.');
    if (!Number.isFinite(member.rank)) fail('/memberships/rank','Expected a finite sort rank.');
  }
  return value;
}
