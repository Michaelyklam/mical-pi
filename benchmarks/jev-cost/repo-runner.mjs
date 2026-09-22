import fs from 'node:fs';
import path from 'node:path';
import {createHash,randomUUID} from 'node:crypto';
import {pathToFileURL,fileURLToPath} from 'node:url';
import {execFileSync} from 'node:child_process';
import {Ledger} from './ledger.mjs';
import {generate} from './bench.mjs';
import {decide} from './jev.mjs';
const BASE=path.join(path.dirname(fileURLToPath(import.meta.url)),'repo-tasks');
const ROOT=process.env.JEV_BENCH_OUT??'/tmp/jev-cost-pilot';
const OUTPUT=path.join(ROOT,'repo-runs');
const CODE_SYSTEM=`Implement the requested change in this isolated repository snapshot. Inspect existing code and tests before editing. Preserve unrelated behavior. Use tools to navigate files, edit implementation, and run checks. Existing tests and package configuration are read-only; add new implementation files or new tests when needed. Commands execute in a fresh offline container each time: command-side file writes do NOT persist, use write_file or edit_file for changes. No git history, reference solution, or hidden tests are available. Never weaken tests, fake test output, access hidden graders, or bypass requirements. Finish with a brief summary of changes and checks. You have at most 24 model turns and 10 minutes.`;
const string={type:'string'};const obj=(properties,required=Object.keys(properties))=>({type:'object',properties,required,additionalProperties:false});
export const TOOLS=[
 {name:'list_files',description:'List repository paths, optionally containing a substring.',parameters:obj({query:string})},
 {name:'read_file',description:'Read numbered lines from a file. Maximum 180 lines or 12000 characters per call.',parameters:obj({path:string,offset:{type:'integer',minimum:1},limit:{type:'integer',minimum:1,maximum:180}})},
 {name:'search',description:'Literal case-insensitive content search, up to 25 matching lines. Optional path substring.',parameters:obj({query:string,path_filter:string})},
 {name:'edit_file',description:'Replace one unique exact substring in a writable implementation file. All other contents stay unchanged.',parameters:obj({path:string,old_text:string,new_text:string})},
 {name:'write_file',description:'Write full source for an existing implementation file or a new local source/test file. Existing tests and configs are protected.',parameters:obj({path:string,content:string})},
 {name:'run_tests',description:'Run the preconfigured visible regression suite in a fresh isolated offline container.',parameters:obj({})},
 {name:'run_command',description:'Run a diagnostic command as an argument array in a fresh isolated offline container. No shell expansion. Changes made by commands do not persist. No network, credentials, or production services.',parameters:obj({argv:{type:'array',items:string,minItems:1,maxItems:30}})},
];
export function safePath(p){return typeof p==='string'&&p.length>0&&!path.posix.isAbsolute(p)&&!p.includes('\\')&&!p.includes('\0')&&p.split('/').every(x=>x&&x!=='.'&&x!=='..'&&!['.git','node_modules'].includes(x));}
export function loadFiles(root){
 const result={};function walk(dir,prefix=''){if(!fs.existsSync(dir))return;for(const e of fs.readdirSync(dir,{withFileTypes:true})){const relative=prefix+e.name;if(!safePath(relative)||e.isSymbolicLink())throw Error('Unsafe fixture entry');if(e.isDirectory())walk(path.join(dir,e.name),relative+'/');else if(e.isFile()){const b=fs.readFileSync(path.join(dir,e.name));if(b.includes(0))throw Error('Binary fixture files are not allowed');result[relative]=b.toString('utf8');}}}walk(root);return result;
}
export function sensitiveMarkers(files){
 const issues=[];for(const [name,text] of Object.entries(files)){
  if(/(^|\/)(\.env(?:\..*)?|auth\.json|credentials(?:\.json)?|\.npmrc|id_rsa|id_ed25519)$/.test(name))issues.push(name+': sensitive filename');
  if(/-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----|\bsk-(?:or-v1-|proj-)?[A-Za-z0-9_-]{24,}|\bAKIA[A-Z0-9]{16}\b/.test(text))issues.push(name+': credential-shaped content');
  if(/\/(?:home|Users)\/[a-zA-Z][\w.-]+\//.test(text))issues.push(name+': personal absolute path');
 }
 return issues;
}
export function readTasks(){
 const list=[];if(!fs.existsSync(BASE))return list;
 for(const repo of fs.readdirSync(BASE))for(const id of fs.readdirSync(path.join(BASE,repo))){const dir=path.join(BASE,repo,id);const metaPath=path.join(dir,'task.json');if(!fs.existsSync(metaPath))continue;
  const meta=JSON.parse(fs.readFileSync(metaPath,'utf8'));const files=loadFiles(path.join(dir,'baseline'));const hiddenFiles=loadFiles(path.join(dir,'hidden'));if(meta.hiddenRoot&&!safePath(meta.hiddenRoot))throw Error('Invalid hidden root');const hidden=Object.fromEntries(Object.entries(hiddenFiles).map(([p,text])=>[meta.hiddenRoot?meta.hiddenRoot+'/'+p:p,text]));const reference=loadFiles(path.join(dir,'reference'));
  if(!['mical-pi','foosheq'].includes(meta.repo)||!['calibration','evaluation'].includes(meta.split)||!/^[a-z0-9-]+$/.test(meta.id))throw Error('Invalid task metadata');
  for(const command of [meta.visibleTestCommand,meta.hiddenTestCommand])if(!Array.isArray(command)||!command.length||command.some(a=>typeof a!=='string'))throw Error('Invalid task test command');
  const issues=sensitiveMarkers({...files,'TASK_PROMPT.txt':meta.prompt});if(issues.length)throw Error(`Privacy review needed for ${meta.id}: ${issues.join('; ')}`);
  for(const name of Object.keys(hidden))if(Object.hasOwn(files,name))throw Error('Hidden test overwrites visible file: '+name);
  if(!Object.keys(reference).length||!Object.keys(hidden).length)throw Error('Incomplete task '+meta.id);
  const fingerprint=createHash('sha256').update(JSON.stringify({meta,files,hidden,reference})).digest('hex');
  list.push({...meta,files,hidden,reference,fingerprint});
 }
 if(new Set(list.map(t=>t.id)).size!==list.length)throw Error('Duplicate task id');return list.sort((a,b)=>a.id.localeCompare(b.id));
}
const accounting=entries=>entries.reduce((s,e)=>s+(e.status==='settled'?e.charged:e.reserved),0);
function save(name,data){fs.mkdirSync(OUTPUT,{recursive:true});const target=path.join(OUTPUT,name+'.json');const tmp=target+'.'+randomUUID()+'.tmp';fs.writeFileSync(tmp,JSON.stringify(data,null,2),{mode:0o600});fs.renameSync(tmp,target);}
function load(name){const file=path.join(OUTPUT,name+'.json');return fs.existsSync(file)?JSON.parse(fs.readFileSync(file,'utf8')):null;}
export function protectedFile(name){return /(?:^|\/)(?:package(?:-lock)?\.json|tsconfig[^/]*\.json|vite\.config\.[^/]+|vitest\.config\.[^/]+)$|(?:\.test\.|\.spec\.)|(?:^|\/)(?:tests|test)\//.test(name);}
export function testSummary(result){
 // Only anchored stdout summaries count. stderr diagnostics cannot override them.
 const output=(result.stdout??'').replace(/\x1b\[[0-9;]*m/g,'');
 let tests=0,passedCount=0,failed=0,cancelled=0,skipped=0,todo=0,consistent=false;
 const starts=[...output.matchAll(/^# tests\s+(\d+)\s*$/gm)];
 if(starts.length){
  const last=starts.at(-1),block=output.slice(last.index);tests=Number(last[1]);
  const read=(key,required=false)=>{const m=[...block.matchAll(new RegExp('^# '+key+'\\s+(\\d+)\\s*$','gm'))];return m.length===1?Number(m[0][1]):m.length===0&&!required?0:NaN;};
  passedCount=read('pass',true);failed=read('fail',true);cancelled=read('cancelled');skipped=read('skipped');todo=read('todo');
  consistent=[passedCount,failed,cancelled,skipped,todo].every(Number.isSafeInteger)&&tests===passedCount+failed+cancelled+skipped+todo;
 }else{
  const matches=[...output.matchAll(/^\s*Tests\s+([^\n]*?)\((\d+)\)\s*$/gm)];
  if(matches.length===1){const m=matches[0];tests=Number(m[2]);const counts={passed:0,failed:0,cancelled:0,skipped:0,todo:0};const seen=new Set();consistent=true;
   for(const part of m[1].trim().split('|')){const c=/^\s*(\d+) (passed|failed|cancelled|skipped|todo)\s*$/.exec(part);if(!c||seen.has(c[2])){consistent=false;break;}seen.add(c[2]);counts[c[2]]=Number(c[1]);}
   ({passed:passedCount,failed,cancelled,skipped,todo}=counts);consistent=consistent&&tests===passedCount+failed+cancelled+skipped+todo;
  }
 }
 return {passed:result.status===0&&!result.timedOut&&result.protectedFilesUnchanged===true&&consistent&&tests>0&&passedCount>0&&failed===0&&cancelled===0,tests,passedCount,failed,cancelled,skipped,todo,consistent,status:result.status,timedOut:!!result.timedOut,protectedFilesUnchanged:result.protectedFilesUnchanged===true};
}
async function check(task,files,which,execute){
 const all=which==='hidden'?{...files,...task.hidden}:files;
 const result=await execute({repo:task.repo,files:all,command:which==='hidden'?task.hiddenTestCommand:task.visibleTestCommand,timeoutMs:90000,protectedPaths:Object.keys(all).filter(p=>protectedFile(p)||Object.hasOwn(task.hidden,p))});
 return {...testSummary(result),...result};
}
export async function validate(task,execute){
 const fixed={...task.files,...task.reference};
 const baselineVisible=await check(task,task.files,'visible',execute);
 const baselineHidden=await check(task,task.files,'hidden',execute);
 const referenceVisible=await check(task,fixed,'visible',execute);
 const referenceHidden=await check(task,fixed,'hidden',execute);
 const valid=baselineVisible.passed&&!baselineHidden.passed&&baselineHidden.status!==0&&baselineHidden.tests>0&&!baselineHidden.timedOut&&referenceVisible.passed&&referenceHidden.passed;
 const output={id:task.id,fingerprint:task.fingerprint,valid,baselineVisible,baselineHidden,referenceVisible,referenceHidden};save(task.id+'-validation',output);if(!valid)throw Error('Task failed local validation: '+task.id);return output;
}
export function toolExecutor(task,files,execute){
 const immutable=new Set(Object.keys(task.files).filter(protectedFile));
 function writable(p){if(!safePath(p)||immutable.has(p)||p.startsWith('.'))throw Error('Path is protected or invalid');}
 return async(name,args)=>{
  if(name==='list_files')return Object.keys(files).filter(p=>p.includes(args.query)).sort().join('\n').slice(0,18000);
  if(name==='read_file'){if(!Object.hasOwn(files,args.path))throw Error('Unknown path');const lines=files[args.path].split('\n');const output=[];let bytes=0,end=args.offset-1;for(let i=args.offset-1;i<Math.min(lines.length,args.offset-1+args.limit, args.offset+179);i++){const line=`${i+1}: ${lines[i]}`;if(output.length&&bytes+line.length>12000)break;output.push(line.slice(0,12000));bytes+=line.length;end=i+1;if(bytes>=12000)break;}return output.join('\n')+`\n[Shown through line ${end}; ${lines.length} total lines; next offset ${end+1}]`;}
  if(name==='search'){if(!args.query)throw Error('Search query required');const matches=[];for(const [p,text] of Object.entries(files)){if(!p.includes(args.path_filter))continue;for(const [i,line] of text.split('\n').entries())if(line.toLowerCase().includes(args.query.toLowerCase())){matches.push(`${p}:${i+1}: ${line}`);if(matches.length>=25)return matches.join('\n').slice(0,10000);}}return matches.join('\n').slice(0,10000)||'No matches';}
  if(name==='write_file'){writable(args.path);if(Buffer.byteLength(args.content)>120000)throw Error('File too large');files[args.path]=args.content;return 'Written';}
  if(name==='edit_file'){writable(args.path);const text=files[args.path];if(typeof text!=='string'||!args.old_text||text.split(args.old_text).length!==2)throw Error('Old text must match exactly once');const next=text.replace(args.old_text,()=>args.new_text);if(Buffer.byteLength(next)>120000)throw Error('File too large');files[args.path]=next;return 'Edited';}
  let result;if(name==='run_tests')result=await execute({repo:task.repo,files,command:task.visibleTestCommand,timeoutMs:60000,protectedPaths:[...immutable]});
  else if(name==='run_command')result=await execute({repo:task.repo,files,command:args.argv,timeoutMs:45000,protectedPaths:[...immutable]});
  else throw Error('Unknown tool');
  const text=`status=${result.status} timeout=${result.timedOut} protectedFilesUnchanged=${result.protectedFilesUnchanged}\n${result.stdout}\n${result.stderr}`;
  return text.length<=12000?text:text.slice(0,2000)+'\n[output middle omitted]\n'+text.slice(-10000);
 };
}
export async function runTask(task,model,ledger,execute){
 const name=task.id+'-'+model;const previous=load(name);
 if(previous?.status==='completed'&&previous.fingerprint===task.fingerprint)return previous;
 if(previous&&(previous.status!=='retry-authorized'||previous.fingerprint!==task.fingerprint))throw Error('Existing incomplete/different task attempt requires explicit review: '+name);
 const validation=load(task.id+'-validation');if(!validation?.valid||validation.fingerprint!==task.fingerprint)throw Error('Validate exact task first');
 const files=structuredClone(task.files);const before=ledger.data.entries.length;const started=Date.now();
 const attempts=previous?[...(previous.attempts??[]),{...previous,attempts:undefined}]:[];
 const artifact={id:task.id,repo:task.repo,split:task.split,model,fingerprint:task.fingerprint,status:'running',startedAt:new Date().toISOString(),attempts};save(name,artifact);
 try{
  artifact.generation=await generate({ledger,label:'repo-'+name,model,systemPrompt:CODE_SYSTEM,prompt:task.prompt+'\n\nRepository files:\n'+Object.keys(files).sort().join('\n')+'\n\nVisible test command (argv): '+JSON.stringify(task.visibleTestCommand),toolSchemas:TOOLS,executeTool:toolExecutor(task,files,execute),maxTurns:24,timeoutMs:600000,maxContextBytes:262144,reasoning:'medium'});
  artifact.files=files;
  artifact.visible=await check(task,files,'visible',execute);
  artifact.hidden=await check(task,files,'hidden',execute);
  artifact.verifiedSuccess=artifact.generation.stopReason==='stop'&&artifact.visible.passed&&artifact.hidden.passed&&artifact.visible.tests>=validation.referenceVisible.tests&&artifact.visible.passedCount>=validation.referenceVisible.passedCount&&artifact.hidden.tests>=validation.referenceHidden.tests&&artifact.hidden.passedCount>=validation.referenceHidden.passedCount;
  artifact.status='completed';
 }catch(error){artifact.status='interrupted';artifact.error=String(error.message).slice(0,400);if(error.result)artifact.partialResult=error.result;throw error;}
 finally{artifact.attemptAccountedUsd=accounting(ledger.data.entries.slice(before));artifact.accountedUsd=accounting(ledger.data.entries.filter(e=>e.label==='repo-'+name));artifact.attemptDurationMs=Date.now()-started;artifact.durationMs=(previous?.durationMs??0)+artifact.attemptDurationMs;artifact.totalTurns=(artifact.generation?.turns??artifact.partialResult?.turns??0)+attempts.reduce((n,a)=>n+(a.generation?.turns??a.partialResult?.turns??0),0);save(name,artifact);}
 console.log(JSON.stringify({task:task.id,split:task.split,model,success:artifact.verifiedSuccess,turns:artifact.generation.turns,cost:artifact.accountedUsd}));return artifact;
}
export function routingState(task,calibration){
 // No evaluation outcomes, hidden tests, references, human difficulty labels or
 // author notes are available to the router. Only deterministic baseline excerpts.
 const terms=[...new Set(task.prompt.toLowerCase().match(/[a-z]{5,}/g)??[])];
 const snippets=Object.entries(task.files).filter(([p])=>!protectedFile(p)&&/\.[cm]?[jt]sx?$/.test(p)).map(([p,text])=>({path:p,text,score:terms.filter(t=>(p+' '+text).toLowerCase().includes(t)).length})).sort((a,b)=>b.score-a.score||a.path.localeCompare(b.path)).slice(0,3).map(({path,text})=>({path,excerpt:text.slice(0,2200)}));
 return {task:{request:task.prompt,files:Object.keys(task.files).sort(),snippets},calibration:calibration.map(({request,luna,astra})=>({request,luna,astra})),budget:{turns:24,minutes:10,reasoning:'medium'},policy:'Choose the cheapest model likely to satisfy the entire request and preserve regression tests. Luna is much cheaper; Astra may solve harder tasks. Do not select a model merely because of project name.'};
}
async function route(task,calibration,ledger){
 const name=task.id+'-route',state=routingState(task,calibration),previous=load(name);
 if(previous){if(previous.status!=='completed'||previous.fingerprint!==task.fingerprint||JSON.stringify(previous.state)!==JSON.stringify(state))throw Error('Stale or incomplete routing checkpoint requires explicit review');return previous;}
 if(load(task.id+'-luna')||load(task.id+'-astra'))throw Error('Evaluation routing must precede seeing candidate outcomes');
 const before=ledger.data.entries.length;
 const out={id:task.id,fingerprint:task.fingerprint,state,status:'running',startedAt:new Date().toISOString()};save(name,out);
 try{
  const response=await decide({ledger,label:'repo-'+name,state,questions:{model:{type:'choice',instructions:'Select the least expensive model likely to fully solve this task within the stated limits, using calibration evidence where relevant.',criteria:{luna:'Use the cheaper Luna coding model',astra:'Use the stronger Astra coding model'}}},outDir:path.join(ROOT,'jev')});
  Object.assign(out,{response,choice:response.answers.model.choice,jevCost:accounting(ledger.data.entries.slice(before)),stage:'jev-completed'});save(name,out);
  const cheap=await generate({ledger,label:'repo-'+name+'-luna-router',model:'luna',systemPrompt:'Select the cheapest coding model likely to satisfy the complete task within the stated limits. Use the supplied calibration outcomes as evidence. Return only JSON {"model":"luna"} or {"model":"astra"}. Do not implement the task.',prompt:JSON.stringify(state),maxTurns:1,timeoutMs:90000});
  out.lunaRouter=cheap;out.stage='luna-returned';save(name,out);
  let cheapChoice;try{cheapChoice=JSON.parse(cheap.answer.trim().replace(/^```(?:json)?\s*/, '').replace(/\s*```$/,'')).model;}catch{}
  if(cheap.stopReason!=='stop'||!['luna','astra'].includes(cheapChoice))throw Error('Luna router returned invalid choice; no silent fallback');
  out.lunaRouter.choice=cheapChoice;out.deterministicChoice=/cancel|concurren|atomic|rollback|stale|reconnect|transaction/i.test(task.prompt)?'astra':'luna';out.status='completed';
 }catch(error){out.status='interrupted';out.error=String(error.message).slice(0,400);throw error;}
 finally{out.accountedUsd=accounting(ledger.data.entries.slice(before));out.finishedAt=new Date().toISOString();save(name,out);}
 return out;
}
export function authorizeInfrastructureRetry(task,model,reason,ledger){
 if(!['luna','astra'].includes(model)||typeof reason!=='string'||reason.length<20)throw Error('Explicit model and review reason required');
 const name=task.id+'-'+model,prior=load(name),last=prior?.partialResult?.messages?.at(-1);
 if(prior?.status!=='interrupted'||prior.fingerprint!==task.fingerprint||!last?.usageUnknown||!/upstream connect error|connection timeout|connection reset/i.test(last.errorMessage??''))throw Error('Only reviewed transport failures can be retried, never coding failures');
 if(prior.attempts?.length)throw Error('At most one explicitly reviewed transport restart');
 for(const e of ledger.data.entries)if(e.label==='repo-'+name&&e.status!=='settled'){e.reviewedAt=new Date().toISOString();e.reviewNote=reason+'; full reservation retained';}
 ledger.save();prior.status='retry-authorized';prior.retryReview={at:new Date().toISOString(),reason,method:'Fresh isolated restart after transport failure; all earlier charges/reservations retained'};save(name,prior);
}
export async function main(args=process.argv.slice(2)){
 const [command,split]=args;
 if(!['inventory','validate','freeze','run','route','authorize-retry'].includes(command))throw Error('Use inventory | validate [split] | freeze | run calibration|evaluation | route');
 const tasks=readTasks();if(!tasks.length)throw Error('No complete repository tasks');
 if(command==='inventory'){console.log(JSON.stringify(tasks.map(t=>({id:t.id,repo:t.repo,split:t.split,files:Object.keys(t.files).length,fingerprint:t.fingerprint})),null,2));return;}
 if(command==='freeze'){
  const manifest=tasks.map(t=>({id:t.id,repo:t.repo,split:t.split,fingerprint:t.fingerprint}));
  if(tasks.filter(t=>t.split==='calibration').length<2||tasks.filter(t=>t.split==='evaluation').length<2)throw Error('Need at least two tasks in each split');
  for(const t of tasks){const v=load(t.id+'-validation');if(!v?.valid||v.fingerprint!==t.fingerprint)throw Error('Validate all task fingerprints before freezing');}
  const previous=load('protocol');if(previous&&JSON.stringify(previous.tasks)!==JSON.stringify(manifest))throw Error('Frozen suite cannot be changed');
  const sandboxImage=execFileSync('/usr/bin/docker',['image','inspect','--format','{{.Id}}','jev-repo-sandbox:offline-v1'],{encoding:'utf8'}).trim();
  if(previous&&previous.sandboxImage!==sandboxImage)throw Error('Frozen sandbox image changed');
  if(!previous)save('protocol',{version:1,sandboxImage,frozenAt:new Date().toISOString(),tasks:manifest,maxTurns:24,timeoutMs:600000,reasoning:'medium',contextByteCap:262144,deterministicRule:'Astra for cancel/concurren/atomic/rollback/stale/reconnect/transaction in request; otherwise Luna',routing:'Jev and Luna selectors see calibration outcomes and baseline excerpts only. Route all held-out tasks before any held-out generation.',budget:'Shared original $50 ledger, including previous runs and uncertain reservations'});
  console.log('Task split, grading and routing protocol frozen');return;
 }
 const {execute}=await import('./repo-sandbox.mjs');
 if(command==='validate'){for(const t of tasks.filter(t=>!split||t.split===split))await validate(t,execute);return;}
 if(command==='run'&&!['calibration','evaluation'].includes(split))throw Error('Specify calibration or evaluation');
 const protocol=load('protocol');if(!protocol||JSON.stringify(protocol.tasks)!==JSON.stringify(tasks.map(t=>({id:t.id,repo:t.repo,split:t.split,fingerprint:t.fingerprint}))))throw Error('Freeze the validated suite before paid calls');
 const currentImage=execFileSync('/usr/bin/docker',['image','inspect','--format','{{.Id}}','jev-repo-sandbox:offline-v1'],{encoding:'utf8'}).trim();if(currentImage!==protocol.sandboxImage)throw Error('Frozen sandbox image changed');
 const ledger=new Ledger(path.join(ROOT,'budget.json'),50);
 try{
  if(command==='authorize-retry'){const task=tasks.find(t=>t.id===split);if(!task)throw Error('Unknown task');authorizeInfrastructureRetry(task,args[2],args[3],ledger);console.log('Transport restart explicitly authorized; prior costs remain reserved');return;}
  if(ledger.data.entries.some(e=>e.status!=='settled'&&!e.reviewedAt))throw Error('Unreviewed uncertain cost; stop');
  if(command==='run'&&split==='evaluation')for(const t of tasks.filter(t=>t.split==='evaluation')){const r=load(t.id+'-route');if(r?.status!=='completed'||r.fingerprint!==t.fingerprint)throw Error('Complete current routing for ALL held-out tasks before generation');}
  const calibration=(command==='route'||split==='evaluation')?tasks.filter(t=>t.split==='calibration').map(t=>{const luna=load(t.id+'-luna'),astra=load(t.id+'-astra');if([luna,astra].some(r=>r?.status!=='completed'||r.fingerprint!==t.fingerprint))throw Error('Complete current calibration first');const summary=(r,model)=>{const uncertainty=accounting(ledger.data.entries.filter(e=>e.label==='repo-'+t.id+'-'+model&&e.status!=='settled'));return {passed:r.verifiedSuccess,cost:r.accountedUsd,knownApiEquivalentUsd:r.accountedUsd-uncertainty,uncertainReserveUsd:uncertainty,transportRestarts:r.attempts?.length??0};};return {request:t.prompt,luna:summary(luna,'luna'),astra:summary(astra,'astra')};}):[];
  if(command==='run'&&split==='evaluation')for(const t of tasks.filter(t=>t.split==='evaluation'))if(JSON.stringify(load(t.id+'-route').state)!==JSON.stringify(routingState(t,calibration)))throw Error('Routing calibration checkpoint is stale');
  if(command==='route'){
   for(const t of tasks.filter(t=>t.split==='evaluation'))await route(t,calibration,ledger);
  }else for(const [i,t] of tasks.filter(t=>t.split===split).entries()){
   if(split==='evaluation'&&!load(t.id+'-route'))throw Error('Precompute held-out routing first');
   for(const model of i%2?['astra','luna']:['luna','astra'])await runTask(t,model,ledger,execute);
  }
 }finally{ledger.close();}
}
if(process.argv[1]&&import.meta.url===pathToFileURL(path.resolve(process.argv[1])).href)await main();
