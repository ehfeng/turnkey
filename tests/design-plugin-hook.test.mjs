import test from 'node:test';
import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import { EventEmitter } from 'node:events';
import { designServicePlugin } from '../server/design-plugin.mjs';

test('project hook shares storage and intercepts without seeding legacy head',async()=>{
 const server={httpServer:new EventEmitter(),middlewares:{use(handler){this.handler=handler;}}};
 const plugin=designServicePlugin({projectRoot:'/unused',projectId:'synthetic',databasePath:':memory:',
   seedSnapshot:{schemaVersion:1,geometryRevision:'a'.repeat(40),instances:[]},
   handlesRequest:path=>path==='/api/project-probe',
   beforeRequest({storage,writable,request}){
     assert.equal(writable,true);assert.equal(new URL(request.url).pathname,'/api/project-probe');
     assert.equal(storage.sql.exec('SELECT count(*) AS n FROM design_commits')[0].n,0);
     storage.transaction(()=>storage.sql.exec('CREATE TABLE project_probe(id TEXT)'));
     return Response.json({project:true});
   }});
 plugin.configureServer(server);
 try {
   const req=Readable.from([]);Object.assign(req,{url:'/api/project-probe',method:'GET',headers:{host:'localhost:3000'},socket:{remoteAddress:'127.0.0.1'}});
   const result=await new Promise((resolve,reject)=>{let status;server.middlewares.handler(req,{writeHead(code){status=code;},end(body){resolve({status,body:JSON.parse(body.toString())});}},reject);});
   assert.deepEqual(result,{status:200,body:{project:true}});
 } finally {server.httpServer.emit('close');}
});

test('an unhandled optional asset route continues through the host middleware',async()=>{
 const server={httpServer:new EventEmitter(),middlewares:{use(handler){this.handler=handler;}}};
 const plugin=designServicePlugin({projectRoot:'/unused',projectId:'synthetic',databasePath:':memory:',
   seedSnapshot:{schemaVersion:1,geometryRevision:'a'.repeat(40),instances:[]},
   handlesRequest:()=>true,beforeRequest:()=>null});
 plugin.configureServer(server);
 try {
   const req=Readable.from([]);Object.assign(req,{url:'/assets/unchanged.png',method:'GET',headers:{host:'localhost:3000'},socket:{remoteAddress:'127.0.0.1'}});
   let continued=false;
   await server.middlewares.handler(req,{writeHead(){assert.fail('An optional miss must not become a design API response');}},error=>{assert.ifError(error);continued=true;});
   assert.equal(continued,true);
 } finally {server.httpServer.emit('close');}
});
