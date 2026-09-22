import fs from 'node:fs';
import path from 'node:path';
import tasks from './tasks/index.mjs';
import { ordinaryCheck } from './checks.mjs';
import { grade } from './grade.mjs';
const root=process.env.JEV_BENCH_OUT??'/tmp/jev-cost-pilot';
const ledger=JSON.parse(fs.readFileSync(path.join(root,'budget.json'),'utf8'));
const runs=Object.fromEntries(fs.readdirSync(path.join(root,'runs')).filter(f=>f.endsWith('.json')).map(f=>[f.slice(0,-5),JSON.parse(fs.readFileSync(path.join(root,'runs',f),'utf8'))]));
const sum=a=>a.reduce((x,y)=>x+y,0);
const success=r=>!!r&&r.grade?.passed&&r.stopReason==='stop';
const cost=r=>r?.accountedUsd??0;
const parse=s=>{try{return JSON.parse(s.trim().replace(/^```(?:json)?\s*/, '').replace(/\s*```$/,''))}catch{return null}};
function aggregate(list){const solved=list.filter(success).length;const total=sum(list.map(cost));const times=list.map(r=>{const label=`${r.taskId}-${r.model}-${r.arm}-${r.attempt}`;return sum(ledger.entries.filter(e=>e.status==='settled'&&(e.label===label||e.label.startsWith(label+'-tools'))).map(e=>e.details?.durationMs??0));});return {runs:list.length,solved,totalUsd:total,usdPerRun:total/list.length,usdPerSuccess:solved?total/solved:null,meanModelRequestMs:list.length?sum(times)/list.length:null,input:sum(list.map(r=>r.usage?.input??0)),output:sum(list.map(r=>r.usage?.output??0)),cacheRead:sum(list.map(r=>r.usage?.cacheRead??0)),turns:sum(list.map(r=>r.turns??0))};}
const baseline={};for(const model of ['luna','astra'])baseline[model]=aggregate(tasks.flatMap(t=>[1,2].map(n=>runs[`${t.id}-${model}-full-${n}`])).filter(Boolean));
const routing={};
const lunaRoutes=parse(runs['routing-luna']?.answer??'');
for(const policy of ['luna-only','astra-only','fixed-rule','jev','luna-router']){
 let routingCost=0;const selected=[];const choices={};
 for(const t of tasks){
  let model=policy==='astra-only'?'astra':'luna';
  if(policy==='fixed-rule')model=Object.keys(t.files).length>1||/fencing|cycle/i.test(t.prompt)?'astra':'luna';
  if(policy==='jev'){const r=runs[t.id+'-routing'];if(!r)continue;model=r.choice;routingCost+=2*cost(r);}
  if(policy==='luna-router'){if(!['luna','astra'].includes(lunaRoutes?.[t.id]))continue;model=lunaRoutes[t.id];}
  choices[t.id]=model;for(const n of [1,2]){const r=runs[`${t.id}-${model}-full-${n}`];if(r)selected.push(r);}
 }
 if(policy==='luna-router')routingCost=2*cost(runs['routing-luna']);
 const a=aggregate(selected);routing[policy]={...a,choices,routingUsd:routingCost,totalUsd:a.totalUsd+routingCost,usdPerSuccess:a.solved?(a.totalUsd+routingCost)/a.solved:null};
}
const variants={};for(const arm of ['full','fixed-local-tools','discovery','jev-initial-tools','jev-turn-tools','mask-old'])variants[arm]=aggregate(['retry-policy','lease-state','dependency-order'].map(id=>runs[`${id}-astra-${arm}-1`]).filter(Boolean));
const verifiers={};
for(const kind of ['luna','known-broken','reference']){
 let total=0,tp=0,tn=0,fp=0,fn=0,ordinaryTp=0,ordinaryTn=0,ordinaryFp=0,ordinaryFn=0;
 for(const t of tasks){const r=runs[t.id+'-verify-'+kind];if(!r)continue;total++;const bad=!r.grade.passed;const flag=r.escalate;if(flag&&bad)tp++;else if(flag)fp++;else if(bad)fn++;else tn++;
  const files=kind==='luna'?runs[`${t.id}-luna-full-1`].files:kind==='reference'?t.referenceFiles:t.files;
  const ordinaryFlag=!ordinaryCheck(t,files);if(ordinaryFlag&&bad)ordinaryTp++;else if(ordinaryFlag)ordinaryFp++;else if(bad)ordinaryFn++;else ordinaryTn++;
 }
 verifiers[kind]={total,jev:{tp,tn,fp,fn},ordinary:{tp:ordinaryTp,tn:ordinaryTn,fp:ordinaryFp,fn:ordinaryFn}};
}
const cascade={};for(const policy of ['none','ordinary','jev','ordinary-or-jev']){
 let dollars=0,solved=0,escalations=0,count=0;
 for(const t of tasks){const l=runs[`${t.id}-luna-full-1`],a=runs[`${t.id}-astra-full-1`],v=runs[t.id+'-verify-luna'];if(!l||!a||!v)continue;
  const escalate=policy==='ordinary'?!ordinaryCheck(t,l.files):policy==='jev'?v.escalate:policy==='ordinary-or-jev'?(!ordinaryCheck(t,l.files)||v.escalate):false;
  dollars+=cost(l)+(['jev','ordinary-or-jev'].includes(policy)?cost(v):0)+(escalate?cost(a):0);count++;if(escalate)escalations++;if(success(escalate?a:l))solved++;
 }cascade[policy]={count,solved,escalations,totalUsd:dollars,usdPerSuccess:solved?dollars/solved:null};
}
const screen={};const bulk=runs['bulk-screen-blinded'];
if(bulk){
 for(const strategy of ['review-all','ordinary','jev','luna','astra']){
  const answer=strategy==='jev'?Object.fromEntries(Object.entries(bulk.answers).map(([k,a])=>[k,a.noul>=0.35])):parse(runs['bulk-screen-blinded-'+strategy]?.answer??'');
  let tp=0,tn=0,fp=0,fn=0,invalid=0,solved=0,repairCost=0,flagged=0;
  const classifierCost=strategy==='jev'?cost(bulk):['luna','astra'].includes(strategy)?cost(runs['bulk-screen-blinded-'+strategy]):0;
  for(const t of tasks)for(const kind of ['bad','good']){
   const id=bulk.itemIds[t.id+'-'+kind];const bad=kind==='bad';const files=bad?t.files:t.referenceFiles;
   const value=strategy==='review-all'?true:strategy==='ordinary'?!ordinaryCheck(t,files):answer?.[id];
   if(typeof value!=='boolean')invalid++;
   const flag=typeof value==='boolean'?value:true; // Fail closed: missing verdict incurs review.
   if(flag&&bad)tp++;else if(flag)fp++;else if(bad)fn++;else tn++;
   if(flag){flagged++;const repair=runs[`${t.id}${bad?'':'-already-correct'}-astra-full-1`];if(!repair){invalid++;continue}repairCost+=cost(repair);if(success(repair))solved++;}
   else if(!bad)solved++;
  }
  screen[strategy]={tp,tn,fp,fn,invalid,flagged,solved,total:16,classifierUsd:classifierCost,repairUsd:repairCost,totalUsd:classifierCost+repairCost};
 }
}
const actual=ledger.entries.filter(e=>e.status==='settled'&&e.billing==='openrouter-actual');
const equivalent=ledger.entries.filter(e=>e.status==='settled'&&e.billing==='codex-api-equivalent');
const pending=ledger.entries.filter(e=>e.status!=='settled');
const accounting={actualUsd:sum(actual.map(e=>e.charged)),apiEquivalentUsd:sum(equivalent.map(e=>e.charged)),pendingUsd:sum(pending.map(e=>e.reserved)),pending:pending.map(({label,reserved,billing})=>({label,reserved,billing})),cap:50,requests:actual.length+equivalent.length};
accounting.committedUsd=accounting.actualUsd+accounting.apiEquivalentUsd+accounting.pendingUsd;
const context=Object.fromEntries(Object.entries(runs).filter(([name])=>name.startsWith('context-')));
const report={generatedAt:new Date().toISOString(),accounting,baseline,routing,variants,verifiers,cascade,screen,context};
fs.writeFileSync(path.join(root,'summary.json'),JSON.stringify(report,null,2));
console.log(JSON.stringify({accounting,baseline,variants,screen},null,2));
