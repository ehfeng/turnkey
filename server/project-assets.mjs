import { DesignError } from '../shared/design.mjs';

const maxBytes = 32 * 1024 * 1024;
const png = [137,80,78,71,13,10,26,10];
const invalid = message => { throw new DesignError(400,'invalid_image',message); };
const crcTable = Uint32Array.from({length:256},(_,n)=>{for(let i=0;i<8;i++)n=(n&1)?0xedb88320^(n>>>1):n>>>1;return n>>>0;});
function crc(bytes) {let n=0xffffffff;for(const b of bytes)n=crcTable[(n^b)&255]^(n>>>8);return (n^0xffffffff)>>>0;}
async function validatePng(bytes) {
  const view=new DataView(bytes.buffer,bytes.byteOffset,bytes.byteLength);let offset=8,header,idat=false,end=false,closedData=false,palette=false;const data=[];
  while(offset+12<=bytes.length){
    const length=view.getUint32(offset),type=new TextDecoder().decode(bytes.slice(offset+4,offset+8)),next=offset+12+length;
    if(next>bytes.length || crc(bytes.subarray(offset+4,next-4))!==view.getUint32(next-4)) invalid('PNG has a truncated chunk or invalid checksum.');
    if(!/^[A-Za-z]{4}$/.test(type)||type[2]!==type[2].toUpperCase()) invalid('Invalid PNG chunk type.');
    if(type[0]===type[0].toUpperCase()&&!['IHDR','PLTE','IDAT','IEND'].includes(type)) invalid('Unsupported PNG critical chunk.');
    if(!header && type!=='IHDR') invalid('PNG must start with IHDR.');
    if(type==='IHDR') {
      if(header || length!==13) invalid('Invalid PNG header.');
      header={width:view.getUint32(offset+8),height:view.getUint32(offset+12),depth:bytes[offset+16],color:bytes[offset+17],interlace:bytes[offset+20]};
      const validDepth={0:[1,2,4,8,16],2:[8,16],3:[1,2,4,8],4:[8,16],6:[8,16]};
      if(!header.width||!header.height||header.width*header.height>100_000_000||!validDepth[header.color]?.includes(header.depth)||bytes[offset+18]!==0||bytes[offset+19]!==0||header.interlace>1) invalid('Invalid PNG header values.');
    } else if(type==='PLTE') {
      if(palette||idat||!length||length%3||length>768||[0,4].includes(header.color)||(header.color===3&&length/3>2**header.depth)) invalid('Invalid PNG palette.');
      palette=true;
    } else if(type==='IDAT') {if(header.color===3&&!palette)invalid('Indexed PNG requires a palette before image data.');if(closedData)invalid('PNG image data must be contiguous.');idat=true;data.push(bytes.slice(offset+8,next-4));}
    else {if(idat)closedData=true;if(type==='IEND'){if(length||!idat||next!==bytes.length)invalid('Invalid PNG end.');end=true;}}
    offset=next;if(end)break;
  }
  if(!end||offset!==bytes.length)invalid('PNG is incomplete.');
  const channels={0:1,2:3,3:1,4:2,6:4}[header.color],bpp=channels*header.depth;
  const passes=header.interlace?[[0,0,8,8],[4,0,8,8],[0,4,4,8],[2,0,4,4],[0,2,2,4],[1,0,2,2],[0,1,1,2]]:[[0,0,1,1]];
  const rows=[];let expected=0;
  for(const [x,y,dx,dy] of passes){const w=Math.max(0,Math.ceil((header.width-x)/dx)),h=Math.max(0,Math.ceil((header.height-y)/dy));if(w&&h){const size=1+Math.ceil(w*bpp/8);rows.push({size,count:h});expected+=size*h;}}
  if(expected>256*1024*1024)invalid('Decoded PNG exceeds the size limit.');
  let total=0,pass=0,row=0,column=0;
  try {
    const reader=new Blob(data).stream().pipeThrough(new DecompressionStream('deflate')).getReader();
    try {while(true){const {done,value}=await reader.read();if(done)break;total+=value.length;if(total>expected){await reader.cancel();invalid('PNG image data exceeds dimensions.');}for(const b of value){if(column===0&&b>4)invalid('Invalid PNG filter.');if(++column===rows[pass].size){column=0;if(++row===rows[pass].count){pass++;row=0;}}}}}finally{reader.releaseLock();}
  } catch(error){if(error instanceof DesignError)throw error;invalid('PNG compressed image data is invalid.');}
  if(total!==expected)invalid('PNG image data does not match dimensions.');
  return header;
}
export async function describeProjectImage(bytes) {
  if (!(bytes instanceof Uint8Array) || bytes.length < 24 || bytes.length > maxBytes) throw new DesignError(400,'invalid_image','Supply an image up to 32 MiB.');
  let mimeType, width, height;
  if (png.every((v,i)=>bytes[i]===v) && new TextDecoder().decode(bytes.slice(12,16))==='IHDR') {
    mimeType='image/png'; ({width,height}=await validatePng(bytes));
    if (!width || !height || width*height > 100_000_000) throw new DesignError(400,'invalid_image','PNG dimensions are invalid or too large.');
  } else if (bytes[0]===255 && bytes[1]===216 && bytes[2]===255 && bytes.at(-2)===255 && bytes.at(-1)===217) mimeType='image/jpeg';
  else if (new TextDecoder().decode(bytes.slice(0,4))==='RIFF' && new TextDecoder().decode(bytes.slice(8,12))==='WEBP' && new DataView(bytes.buffer,bytes.byteOffset,bytes.byteLength).getUint32(4,true)+8===bytes.length) mimeType='image/webp';
  else throw new DesignError(400,'invalid_image','Use PNG, JPEG or WebP; floor plans require PNG.');
  const sha256=Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',bytes)),n=>n.toString(16).padStart(2,'0')).join('');
  return {id:'image:'+sha256,sha256,storageKey:'images/'+sha256,mimeType,...(width?{width,height}:{})};
}

// Backends implement immutable put/get and MUST scope keys to this project. Authorization is required before accessing bytes.
export function createProjectAssetService({backend,authorize,projectId}) {
  if (!backend || typeof authorize !== 'function') throw new TypeError('Asset backend and authorization are required.');
  const prefix='/api/projects/'+encodeURIComponent(projectId)+'/assets';
  return async function(request) {
    const url=new URL(request.url);
    if (url.pathname!==prefix && !url.pathname.startsWith(prefix+'/')) return null;
    try {
      const grant=await authorize(request,{projectId,action:request.method==='GET'?'read':'write',tool:'project_assets'});
      if (!grant) throw new DesignError(403,'forbidden','Project access is required.');
      const origin=request.headers.get('Origin');
      if (origin && origin!==url.origin) throw new DesignError(403,'origin','Use the project origin.');
      if (url.pathname===prefix && request.method==='POST') {
        const reader=request.body?.getReader();if(!reader) throw new DesignError(400,'invalid_image','Missing image.');
        const chunks=[];let length=0;
        try { while(true) {const {done,value}=await reader.read();if(done)break;length+=value.length;if(length>maxBytes){await reader.cancel();throw new DesignError(413,'too_large','Image exceeds 32 MiB.');}chunks.push(value);} } finally {reader.releaseLock();}
        const bytes=new Uint8Array(length);let offset=0;for(const chunk of chunks){bytes.set(chunk,offset);offset+=chunk.length;}
        const asset=await describeProjectImage(bytes);await backend.put(asset,bytes);
        return Response.json(asset,{status:201,headers:{'Cache-Control':'no-store'}});
      }
      const id=url.pathname.slice(prefix.length+1);
      if (request.method!=='GET') throw new DesignError(405,'method','Use POST to upload or GET to read.');
      if(!/^[a-f0-9]{64}$/.test(id)) throw new DesignError(404,'not_found','Unknown image.');
      const value=await backend.get('images/'+id);
      if(!value) throw new DesignError(404,'not_found','Unknown image.');
      return new Response(value.body,{headers:{'Content-Type':value.mimeType,'Cache-Control':'private, max-age=3600','X-Content-Type-Options':'nosniff'}});
    } catch(error) {
      if(!(error instanceof DesignError)) throw error;
      return Response.json({code:error.code,error:error.message},{status:error.status,headers:{'Cache-Control':'no-store'}});
    }
  };
}
