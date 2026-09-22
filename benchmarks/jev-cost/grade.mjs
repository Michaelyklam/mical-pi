import { spawnSync } from 'node:child_process';
import { isDeepStrictEqual } from 'node:util';
import { randomUUID } from 'node:crypto';
// The security boundary is a rootless-user Docker container with no network,
// no host mounts, read-only rootfs, dropped capabilities and bounded resources.
// The VM is merely a fixture module loader, not a security boundary.
const worker = `
import vm from 'node:vm';
import {readFileSync} from 'node:fs';
import {posix} from 'node:path';
const input=JSON.parse(readFileSync(0,'utf8'));
const context=vm.createContext(Object.create(null),{codeGeneration:{strings:false,wasm:false}});
const mods=new Map();
function get(name){
 if(!Object.hasOwn(input.files,name)) throw Error('Unknown module');
 if(!mods.has(name)) mods.set(name,new vm.SourceTextModule(input.files[name],{context,identifier:name}));
 return mods.get(name);
}
const m=get(input.entry);
await m.link((specifier,ref)=>{
 if(!specifier.startsWith('./')&&!specifier.startsWith('../')) throw Error('Only fixture imports allowed');
 return get(posix.normalize(posix.join(posix.dirname(ref.identifier),specifier)));
});
await m.evaluate({timeout:300});
context.fn=m.namespace[input.exportName];
const results=[];
for(const args of input.args){
 try{
  context.argsJson=JSON.stringify(args);
  const value=vm.runInContext(\
   '(()=>{const args=JSON.parse(argsJson); const freeze=x=>{if(x&&typeof x==="object"){Object.values(x).forEach(freeze);Object.freeze(x);}return x;};freeze(args);return JSON.stringify(fn(...args));})()',context,{timeout:300});
  results.push({ok:true,value:JSON.parse(value)});
 }catch{results.push({ok:false});}
}
process.stdout.write(JSON.stringify(results));
`;
export function evaluate(task, files, args) {
  const name='jev-grade-'+randomUUID();
  // Use a locally present official Node image. No implicit pulls or app images.
  const p=spawnSync('/usr/bin/docker',['run','--rm','--pull=never','--name',name,'--network=none','--read-only','--user=65534:65534','--cap-drop=ALL','--security-opt=no-new-privileges','--memory=128m','--memory-swap=128m','--cpus=1','--pids-limit=32','-i','--entrypoint=node','node@sha256:c610fcdfb1d5b4740dd70c284ed3cb16bb857e0f7166196e36a5501df7a3aa32','--experimental-vm-modules','--max-old-space-size=64','--input-type=module','--eval',worker],{
    env:{PATH:'/usr/bin:/bin'},input:JSON.stringify({files,entry:task.entry,exportName:task.exportName,args}),encoding:'utf8',timeout:10000,maxBuffer:1024*1024,killSignal:'SIGKILL',cwd:'/tmp',
  });
  // A killed Docker client does not guarantee its container was stopped.
  if(p.error||p.signal)spawnSync('/usr/bin/docker',['rm','-f',name],{env:{PATH:'/usr/bin:/bin'},timeout:5000,stdio:'ignore'});
  if([125,126,127].includes(p.status)||p.error?.code==='ENOENT')throw new Error('Grading infrastructure failed: Docker unavailable or container launch refused');
  if(p.status!==0)return args.map(()=>({ok:false,reason:p.error?.code==='ETIMEDOUT'?'timeout':'candidate-error'}));
  try{return JSON.parse(p.stdout);}catch{return args.map(()=>({ok:false}));}
}
export function grade(task, files) {
 const actual=evaluate(task,files,task.cases.flatMap(c=>[c.args,c.args]));
 const checks=task.cases.map((c,i)=>actual[2*i]?.ok&&actual[2*i+1]?.ok&&isDeepStrictEqual(actual[2*i].value,c.expected)&&isDeepStrictEqual(actual[2*i+1].value,c.expected));
 return {passed:checks.every(Boolean),passedCases:checks.filter(Boolean).length,totalCases:checks.length};
}
