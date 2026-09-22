import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, copyFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { runWorkflowSandbox } from '../extensions/workflows/sandbox.ts';
import { RunController } from '../extensions/workflows/controller.ts';
const ok=(output:string)=>({ok:true,output});
const cancelled=(error='Agent was cancelled')=>({ok:false,output:'',error});
const tick=()=>new Promise(r=>setImmediate(r));
function run(source:string, onAgent:any=async(p:string)=>ok(p), signal=new AbortController().signal){return runWorkflowSandbox({source,args:null,cwd:process.cwd(),signal:AbortSignal.any([signal,AbortSignal.timeout(3000)]),onAgent,onPhase:()=>{}});}

test('lazy cancellation retires orphans, preserves frozen thenables and normalizes reasons', {timeout:5000},async()=>{
 let calls=0;
 const r=await run(`
 const a=agent('never'); const b=agent('ignored');
 const first=a.cancel('x'.repeat(1100));
 b.cancel();
 const c=agent('empty'); c.cancel('');
 const d=agent('invalid'); d.cancel({bad:true});
 return {first, again:a.cancel('different'), frozen:Object.isFrozen(a), one:await a, two:await a, empty:await c, invalid:await d};`,async()=>{calls++;return ok('unexpected');});
 assert.deepEqual(r,{first:true,again:false,frozen:true,one:cancelled('x'.repeat(1024)),two:cancelled('x'.repeat(1024)),empty:cancelled(),invalid:cancelled()});assert.equal(calls,0);
});
test('active cancellation aborts only its signal and resolves all consumers despite noncooperation', {timeout:5000},async()=>{
 let slowSignal:AbortSignal|undefined;let reason:unknown;let calls=0;
 const parent=new AbortController();
 const r=await run(`
 const a=agent('slow'); let finals=0;
 const p=a.then(x=>x); const q=a.finally(()=>finals++);
 await agent('barrier');
 const did=a.cancel('stop this request');
 const result=await Promise.all([p,q,a]);
 return {did,again:a.cancel(),result:result.map(x=>({...x})),finals,sibling:await agent('sibling')};`,async(p:string,_:unknown,s:AbortSignal)=>{
 calls++;
 if(p==='slow'){slowSignal=s;s.addEventListener('abort',()=>{reason=s.reason;});return new Promise(()=>{});}
 if(p==='barrier') assert.ok(slowSignal);
 assert.equal(s.aborted,false);return ok(p);
 },parent.signal);
 assert.deepEqual(r,{did:true,again:false,result:Array(3).fill(cancelled('stop this request')),finals:1,sibling:ok('sibling')});
 assert.equal(calls,3);assert.equal(slowSignal?.aborted,true);assert.equal(parent.signal.aborted,false);assert.ok(reason instanceof Error);assert.equal(reason.message,'stop this request');
});
test('late success and rejection cannot replace cancellation, and settled results win', {timeout:5000},async()=>{
 for(const rejectLate of [false,true]){
 let settle:any;let signal:AbortSignal|undefined;
 const r=await run(`
 const a=agent('late'); const p=a.catch(()=>({bad:true}));
 await agent('barrier'); a.cancel('cancelled first');
 const first=await p; await agent('release');
 const stable=await agent('stable');
 const h=agent('already'); const observed=await h;
 return {first,again:await a,stable,observed,cancel:h.cancel()};`,async(p:string,_:unknown,s:AbortSignal)=>{
 if(p==='late'){signal=s;return new Promise((resolve,reject)=>{settle=rejectLate?()=>reject(new Error('late')):()=>resolve(ok('late'));});}
 if(p==='release'){assert.equal(signal?.aborted,true);settle();await tick();}
 return ok(p);
 });
 assert.deepEqual(r,{first:cancelled('cancelled first'),again:cancelled('cancelled first'),stable:ok('stable'),observed:ok('already'),cancel:false});
 }
});
test('cancelled queued invocation releases RunController queue without aborting active sibling', {timeout:5000},async()=>{
 const controller=new RunController(undefined,1);let queued:AbortSignal|undefined;let executed:string[]=[];let release:any;
 try{
 const r=await run(`
 const a=agent('active'); const pa=a.then(x=>x);
 const q=agent('queued'); const pq=q.then(x=>x);
 await agent('barrier'); q.cancel('skip queue');
 await agent('release');
 return {active:await pa,queued:await pq,next:await agent('next')};`,async(p:string,_:unknown,s:AbortSignal)=>{
 if(p==='barrier'){assert.ok(queued);return ok(p);}
 if(p==='release'){assert.equal(queued?.aborted,true);release();return ok(p);}
 if(p==='queued')queued=s;
 return controller.schedule(async(signal)=>{executed.push(p);if(p==='active')await new Promise(r=>release=r);assert.equal(signal.aborted,false);return ok(p);},s);
 });
 assert.deepEqual(r,{active:ok('active'),queued:cancelled('skip queue'),next:ok('next')});assert.deepEqual(executed,['active','next']);assert.equal(controller.calls,3);assert.equal(await controller.settle(),true);
 }finally{controller.abort();}
});
test('synchronous callback failure becomes a result and does not poison siblings', {timeout:5000},async()=>{
 assert.deepEqual(await run(`return [await agent('bad'),await agent('good')];`,(p:string)=>{if(p==='bad')throw new Error('sync failure');return Promise.resolve(ok(p));}),[cancelled('sync failure'),ok('good')]);
});
test('ignored active cancellations retire in-flight tracking, normal orphan detection remains', {timeout:5000},async()=>{
 let aborted=false;
 assert.equal(await run(`const h=agent('slow');h.then(()=>{});await agent('barrier');h.cancel();return 12;`,async(p:string,_:unknown,s:AbortSignal)=>{if(p==='slow'){s.addEventListener('abort',()=>aborted=true);return new Promise(()=>{});}return ok(p);}),12);
 assert.equal(aborted,true);
 await assert.rejects(run(`agent('orphan');return 1;`),/unawaited agent/);
 await assert.rejects(run(`agent('pending').then(()=>{});return 1;`,()=>new Promise(()=>{})),/before .*settled/);
});
test('cancel does not refund the host request budget', {timeout:10000},async()=>{
 let count=0;
 await assert.rejects(run(`for(let i=0;i<129;i++){const h=agent(String(i));h.then(()=>{});h.cancel();}return await agent('end');`,async()=>{count++;return new Promise(()=>{});}),/budget/);
 assert.ok(count<=128);
});

// Exercise the real parent validator against an isolated synthetic IPC peer.
// This peer is not an agent and receives no provider credentials or permissions.
async function protocol(body:string,onAgent:any=async()=>ok('done')){
 const dir=await mkdtemp(join(tmpdir(),'jev-protocol-'));
 try{
 for(const file of ['sandbox.ts','serialization.ts'])await copyFile(new URL('../extensions/workflows/'+file,import.meta.url),join(dir,file));
 await writeFile(join(dir,'package.json'),'{"type":"module"}');
 await writeFile(join(dir,'sandbox-child.cjs'),`process.on('message',()=>{});process.once('message',init=>{const token=init.token;const send=x=>process.send({token,...x});${body}});`);
 const {runWorkflowSandbox:peer}=await import(pathToFileURL(join(dir,'sandbox.ts')).href);
 return await peer({source:'',args:null,cwd:dir,signal:AbortSignal.timeout(3000),onPhase:()=>{},onAgent});
 }finally{await rm(dir,{recursive:true,force:true});}
}
test('parent rejects malformed, unauthenticated and unknown cancellation messages', {timeout:10000},async()=>{
 for(const patch of [{id:0,reason:'x'},{id:1.5,reason:'x'},{id:999,reason:'x'},{id:1,reason:''},{id:1,reason:'x'.repeat(1025)},{id:1,reason:7},{id:1,reason:'x',token:'wrong'}]){
 await assert.rejects(protocol(`send({kind:'agent',payloadJson:JSON.stringify({id:1,prompt:'p',options:{}})});send(${JSON.stringify({kind:'cancelAgent',...patch})});`),/invalid.*(cancellation|IPC)/);
 }
});
test('parent handles duplicate and post-completion cancellation and suppresses late delivery', {timeout:5000},async()=>{
 let aborts=0;
 const r=await protocol(`
 send({kind:'agent',payloadJson:JSON.stringify({id:1,prompt:'slow',options:{}})});
 send({kind:'agent',payloadJson:JSON.stringify({id:2,prompt:'barrier',options:{}})});
 process.on('message',m=>{if(m.kind==='agentResult'){
 if(m.id===1)send({kind:'error',error:'canceled result leaked'});
 else if(m.id===2){
 send({kind:'cancelAgent',id:1,reason:'stop'});
 send({kind:'cancelAgent',id:1,reason:'again'});
 send({kind:'agent',payloadJson:JSON.stringify({id:3,prompt:'fast',options:{}})});
 }
 else {send({kind:'cancelAgent',id:2,reason:'too late'});send({kind:'result',resultJson:'42'});}
 }});`,async(p:string,_:unknown,s:AbortSignal)=>{if(p==='slow')return new Promise(resolve=>s.addEventListener('abort',()=>{aborts++;assert.equal(s.reason.message,'stop');resolve(ok('late'));}));await tick();return ok(p);});
 assert.equal(r,42);assert.equal(aborts,1);
});
