import test from 'node:test';
import assert from 'node:assert/strict';
import {createProjectAssetService,describeProjectImage} from '../server/project-assets.mjs';
const bytes=Uint8Array.from(Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4z8DwHwAFAAH/iZk9HQAAAABJRU5ErkJggg==','base64'));
test('stored asset digest and PNG dimensions come from bytes, unauthorized reads never hit storage',async()=>{
  const asset=await describeProjectImage(bytes);assert.equal(asset.width,1);assert.equal(asset.height,1);
  const data=new Map();let reads=0;
  const serve=createProjectAssetService({projectId:'fixture',authorize:r=>r.headers.get('Authorization')==='Bearer test',backend:{put:(a,b)=>data.set(a.storageKey,{body:b,mimeType:a.mimeType}),get:k=>{reads++;return data.get(k)}}});
  const base='https://example.com/api/projects/fixture/assets';
  assert.equal((await serve(new Request(base+'/'+asset.sha256))).status,403);assert.equal(reads,0);
  const response=await serve(new Request(base,{method:'POST',headers:{Authorization:'Bearer test'},body:bytes}));assert.equal(response.status,201);
  const result=await serve(new Request(base+'/'+asset.sha256,{headers:{Authorization:'Bearer test'}}));assert.equal(result.status,200);assert.deepEqual(new Uint8Array(await result.arrayBuffer()),bytes);
});

test('truncated PNG and tampered chunk contents fail before storing',async()=>{
  await assert.rejects(()=>describeProjectImage(bytes.slice(0,24)),/incomplete|truncated/);
  const bad=bytes.slice();bad[20]^=1;await assert.rejects(()=>describeProjectImage(bad),/checksum/);
});
