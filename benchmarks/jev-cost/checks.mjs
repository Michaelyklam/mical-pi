// Small ordinary validation suite, written separately from hidden grading cases.
// Not exposed to the generators or Jev. These are deliberately not a full specification.
import { evaluate } from './grade.mjs';
import { isDeepStrictEqual } from 'node:util';
export const checks={
 'normalize-tags':[
  {args:[[]],expected:[]},
  {args:[['Hello World',' hello_world ',null]],expected:['hello-world']},
  {args:[['--','_a_','A']],expected:['a']},
 ],
 'parse-query':[
  {args:[''],expected:[]},
  {args:['a=one&a=two&b='],expected:[['a',['one','two']],['b',['']]]},
  {args:['?greeting=hello+there'],expected:[['greeting',['hello there']]]},
 ],
 'merge-intervals':[
  {args:[[]],expected:[]},
  {args:[[[2,5],[5,8]]],expected:[[2,8]]},
  {args:[[[9,3],[4,4]]],expected:[[3,9]]},
 ],
 'event-scheduler':[
  {args:[[]],expected:[]},
  {args:[[{type:'schedule',id:'q',at:4,value:'v'},{type:'advance',to:4}]],expected:[{id:'q',at:4,value:'v'}]},
  {args:[[{type:'schedule',id:'q',at:4,value:'v'},{type:'cancel',id:'q'},{type:'advance',to:5}]],expected:[]},
 ],
 'retry-policy':[
  {args:[{status:400,attempt:1,maxAttempts:3,baseMs:10,capMs:50,remainingMs:100}],expected:{retry:false,delayMs:null}},
  {args:[{status:500,attempt:1,maxAttempts:3,baseMs:10,capMs:50,remainingMs:100}],expected:{retry:true,delayMs:10}},
  {args:[{status:429,attempt:1,maxAttempts:3,baseMs:10,capMs:50,remainingMs:20,retryAfterMs:20}],expected:{retry:true,delayMs:20}},
 ],
 'merge-patch':[
  {args:[{a:1},{b:2}],expected:{a:1,b:2}},
  {args:[{a:1},{a:null}],expected:{}},
  {args:[[1,2],[3]],expected:[3]},
 ],
 'lease-state':[
  {args:[[]],expected:{results:[],lease:null}},
  {args:[[{type:'acquire',at:0,owner:'x',ttl:3}]],expected:{results:[1],lease:{owner:'x',token:1,expiresAt:3}}},
  {args:[[{type:'acquire',at:0,owner:'x',ttl:3},{type:'release',at:1,owner:'x',token:99}]],expected:{results:[1,false],lease:{owner:'x',token:1,expiresAt:3}}},
 ],
 'dependency-order':[
  {args:[[]],expected:[]},
  {args:[[{id:'b',deps:['a']},{id:'a',deps:[]}]],expected:['a','b']},
  {args:[[{id:'a',deps:['missing']}]],expected:null},
 ],
};
export function ordinaryCheck(task,files){
 const cases=checks[task.id];const actual=evaluate(task,files,cases.map(c=>c.args));
 return cases.every((c,i)=>actual[i]?.ok&&isDeepStrictEqual(actual[i].value,c.expected));
}
