import assert from 'node:assert/strict';
import { test } from 'node:test';
import { PricingResolver } from '../extensions/usage-footer/pricing.ts';
import * as module from '../extensions/usage-footer/session-ledger.ts';
const account = {accountKey:'p:one', providerId:'p'};
const usage = {input:1_000_000,output:0,cacheRead:0,cacheWrite:0,totalTokens:1_000_000,cost:{total:999,input:999,output:0,cacheRead:0,cacheWrite:0}};
const models = [{provider:'p',id:'m',cost:{input:2,output:4,cacheRead:1,cacheWrite:3}}];
const message = (id:string, model='m') => ({type:'message',id,message:{role:'assistant',provider:'p',model,usage}});
const charge = (targetEntryId:string, amount=7, extra={}) => ({type:'custom',id:`report-${targetEntryId}`,customType:'usage-footer-reported-cost',data:{targetEntryId,amount,accountKey:account.accountKey,providerId:'p',currency:'USD',source:'billing',recordedAt:1,...extra}});
const attribution = (id:string, kind:string) => ({type:'custom',id:`attr-${id}`,customType:'usage-footer-attribution',data:{targetEntryId:id,accountKey:account.accountKey,providerId:'p',modelId:'m',kind,recordedAt:1}});
function summarize(entries:any[], legacy=true) {return new module.SessionLedger(new PricingResolver(models as any),()=>legacy?account.accountKey:undefined).summarize(entries,account);}
function frozen<T>(x:T):T {if(x && typeof x==='object'){Object.freeze(x);for(const v of Object.values(x))frozen(v);}return x;}

test('mixed reported, canonical estimated and unpriced requests stay separate and immutable',()=>{
 const entries=frozen([charge('a'),message('a'),message('b','router/m'),message('c','unknown'),charge('orphan',100)]);
 const result=summarize(entries);
 assert.equal(module.REPORTED_COST_ENTRY,'usage-footer-reported-cost');
 assert.equal(result.reported,7);assert.equal(result.estimated,2);
 assert.equal(result.hasEstimatedUsage,true);assert.equal(result.hasUnpricedUsage,true);
 assert.equal(result.attributedEntries,3);assert.equal(result.excludedEntries,0);
 assert.deepEqual(result.pricingSources,['Pi registry canonical m']);
});
test('zero charges suppress both pricing and unavailable flags, not inferred Usage.cost',()=>{
 const result=summarize([message('a','unknown'),charge('a',0)]);
 assert.deepEqual(result,{reported:0,estimated:0,hasEstimatedUsage:false,hasUnpricedUsage:false,attributedEntries:1,excludedEntries:0,pricingSources:[]});
 const legacy=summarize([message('b')]);assert.equal(legacy.reported,0);assert.equal(legacy.estimated,2);
});
test('revision order uses timestamp then array position; invalid and foreign revisions cannot shadow',()=>{
 const entries=[message('a'),charge('a',8,{recordedAt:30}),charge('a',9,{recordedAt:30}),charge('a',99,{recordedAt:29}),charge('a',40,{recordedAt:99,accountKey:'p:other'}),charge('a',50,{recordedAt:100,providerId:'q'}),charge('a',-1,{recordedAt:101})];
 assert.equal(summarize(entries).reported,9);assert.equal(summarize(entries).estimated,0);
});
test('malformed persistent records are ignored independently, including hostile types',()=>{
 const invalid:any[]=[null,[],true,4,'bad',{},...['targetEntryId','accountKey','providerId','source'].flatMap(k=>[{...charge('a').data,[k]:''},{...charge('a').data,[k]:7}]),...[NaN,Infinity,-1,'1',null].map(amount=>({...charge('a').data,amount})),...[NaN,Infinity,-1,'1',null].map(recordedAt=>({...charge('a').data,recordedAt})),{...charge('a').data,currency:'EUR'}];
 for(const data of invalid){const r=summarize([message('a'),{...charge('a'),data}]);assert.equal(r.reported,0);assert.equal(r.estimated,2);}
 assert.equal(summarize([message('a'),{...charge('a'),type:'message'}]).estimated,2);
});
test('compactions and abandoned branch summaries reconcile, tools and unattributed requests do not',()=>{
 const r=summarize([message('a'),charge('a',100),{type:'message',id:'tool',message:{role:'toolResult',usage}},charge('tool',100),{type:'compaction',id:'c',usage},attribution('c','compaction'),charge('c',3),{type:'branch_summary',id:'b',parentId:'abandoned',usage},attribution('b','branch_summary'),charge('b',4),{type:'compaction',id:'excluded',usage},charge('excluded',100)],false);
 assert.equal(r.reported,7);assert.equal(r.estimated,0);assert.equal(r.attributedEntries,2);assert.equal(r.excludedEntries,3);
});
test('matching account text alone cannot move a charge across providers',()=>{
 const foreign={...message('a'),message:{...message('a').message,provider:'q'}};
 const r=summarize([foreign,charge('a',8)]);assert.equal(r.reported,0);assert.equal(r.estimated,2);
 const noUsage={type:'message',id:'a',message:{role:'assistant',provider:'p',model:'m'}};
 assert.equal(summarize([noUsage,charge('a')]).reported,0);
});
test('multiple reported requests and estimated tiers aggregate without caching previous summaries',()=>{
 const resolver=new PricingResolver([{provider:'p',id:'m',cost:{input:1,output:2,cacheRead:0,cacheWrite:0,tiers:[{inputTokensAbove:10,input:4,output:8,cacheRead:0,cacheWrite:0}]}}] as any);
 const ledger=new module.SessionLedger(resolver,()=>account.accountKey);
 const entries=[message('a'),message('b'),message('c'),charge('a',1.25),charge('b',2.75)];
 assert.equal(ledger.summarize(entries,account).estimated,4);assert.equal(ledger.summarize(entries,account).reported,4);
 assert.equal(ledger.summarize([...entries,charge('c',0)],account).estimated,0);
 assert.equal(ledger.summarize(entries,{accountKey:'p:other',providerId:'p'}).reported,0);
});
