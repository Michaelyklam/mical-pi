import test from 'node:test';
import assert from 'node:assert/strict';
import {safePath,sensitiveMarkers,protectedFile,testSummary,toolExecutor,routingState} from './repo-runner.mjs';

test('repository paths reject traversal, dependency and git access',()=>{
 for(const p of ['../x','/etc/passwd','a/../b','a\\b','.git/config','node_modules/foo','a//b','a\0b'])assert.equal(safePath(p),false,p);
 for(const p of ['src/a.ts','extensions/foo/test.ts','README.md'])assert.equal(safePath(p),true,p);
});
test('privacy gate flags credential and personal-path shapes without printing values',()=>{
 assert.equal(sensitiveMarkers({'src/a.ts':'export const x=1'}).length,0);
 for(const files of [{'.env':'x=1'},{'x':'sk-or-v1-'+ 'a'.repeat(35)},{'x':'/home/person/private/file'},{'x':'-----BEGIN PRIVATE KEY-----'}])assert.ok(sensitiveMarkers(files).length);
});
test('existing tests and package configuration are immutable',async()=>{
 const task={repo:'mical-pi',files:{'src/a.ts':'export const x=1;','src/a.test.ts':'test source','package.json':'{}'},visibleTestCommand:['node','--test','src/a.test.ts']};const files=structuredClone(task.files);
 const call=toolExecutor(task,files,async()=>{throw Error('unused')});
 await assert.rejects(call('write_file',{path:'src/a.test.ts',content:'bypass'}));
 await assert.rejects(call('write_file',{path:'package.json',content:'bypass'}));
 await assert.rejects(call('write_file',{path:'../secret',content:'x'}));
 await call('edit_file',{path:'src/a.ts',old_text:'x=1',new_text:'x=2'});
 assert.equal(files['src/a.ts'],'export const x=2;');
 await assert.rejects(call('edit_file',{path:'src/a.ts',old_text:'not present',new_text:'x'}));
 await call('write_file',{path:'src/extra.test.ts',content:'new test'});
 assert.equal(files['src/extra.test.ts'],'new test');
 assert.ok(protectedFile('src/a.spec.ts'));
});
test('tools only expose the candidate snapshot, not hidden/reference data',async()=>{
 const task={repo:'foosheq',files:{'src/index.ts':'first\nneedle\nthird'},hidden:{'hidden.test.ts':'SECRET_HIDDEN'},reference:{'src/index.ts':'SECRET_REFERENCE'},visibleTestCommand:['node','--test']};const files=structuredClone(task.files);const seen=[];
 const call=toolExecutor(task,files,async(args)=>{seen.push(args);return {status:0,stdout:'ok',stderr:'',timedOut:false,protectedFilesUnchanged:true}});
 assert.equal(await call('list_files',{query:''}),'src/index.ts');
 assert.match(await call('search',{query:'needle',path_filter:''}),/src\/index.ts:2/);
 await assert.rejects(call('read_file',{path:'hidden.test.ts',offset:1,limit:10}));
 await call('run_tests',{});assert.deepEqual(seen[0].files,task.files);
 assert.doesNotMatch(JSON.stringify(seen),/SECRET_HIDDEN|SECRET_REFERENCE/);
});
test('grading rejects exit zero without tests, all skipped tests, timeouts or modified tests',()=>{
 const base={status:0,stdout:'TAP version 13\n# tests 3\n# pass 3\n# fail 0',stderr:'',timedOut:false,protectedFilesUnchanged:true};
 assert.equal(testSummary(base).passed,true);
 assert.equal(testSummary({...base,stdout:''}).passed,false);
 assert.equal(testSummary({...base,stdout:'# tests 3\n# pass 0\n# skipped 3'}).passed,false);
 assert.equal(testSummary({...base,status:1}).passed,false);
 assert.equal(testSummary({...base,timedOut:true}).passed,false);
 assert.equal(testSummary({...base,protectedFilesUnchanged:false}).passed,false);
 assert.equal(testSummary({...base,stdout:' Tests  7 passed (7)\n'}).passedCount,7);
});
test('router cannot see held-out grades, difficulty labels or reference sources',()=>{
 const task={prompt:'Implement useful behavior',files:{'src/core.ts':'export const useful=1;','src/core.test.ts':'visible'},hidden:{'h':'HIDDEN_MARKER'},reference:{'a':'REFERENCE_MARKER'},difficulty:'HARD_MARKER',notes:'NOTES_MARKER',grade:'GRADE_MARKER'};
 const state=routingState(task,[{request:'other task',luna:{passed:false,cost:1},astra:{passed:true,cost:2},hidden:'TRAINING_HIDDEN_MARKER'}]);
 const serialized=JSON.stringify(state);for(const marker of ['HIDDEN_MARKER','REFERENCE_MARKER','HARD_MARKER','NOTES_MARKER','GRADE_MARKER'])assert.ok(!serialized.includes(marker));
 assert.ok(serialized.includes('useful'));assert.equal(state.calibration[0].luna.passed,false);
});
