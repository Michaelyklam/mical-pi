import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import { createHash } from 'node:crypto';
import { calculateCost } from '@earendil-works/pi-ai';
import { Ledger } from './ledger.mjs';
import { decide } from './jev.mjs';
import { grade, evaluate } from './grade.mjs';
import tasks from './tasks/index.mjs';

// Offline only. Extract orchestration with injected dependencies rather than
// importing bench.mjs or initializing any model runtime. Docker tests use the
// production grader and its local image (--pull=never); allow its 10s deadline.
const benchSource = fs.readFileSync(new URL('./bench.mjs', import.meta.url), 'utf8');

function temporaryLedger(t, cap = 1) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jev-safety-'));
  const file = path.join(dir, 'ledger.json');
  const ledger = new Ledger(file, cap);
  t.after(() => { ledger.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  return { ledger, file };
}

for (const task of tasks) {
  test(`grader distinguishes reference and baseline: ${task.id}`, () => {
    assert.equal(grade(task, task.referenceFiles).passed, true,
      `${task.id} reference failed: check Docker daemon/image/resources before resuming paid trials`);
    assert.equal(grade(task, task.files).passed, false);
  });
}

test('VM escape reaches only the container, not a unique host-only file', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jev-host-isolation-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const markerPath = path.join(dir, 'host-marker.txt');
  const marker = `harmless host marker ${path.basename(dir)}`;
  fs.writeFileSync(markerPath, marker);
  assert.equal(fs.readFileSync(markerPath, 'utf8'), marker);
  // Deliberately escape the VM, but read only this test's own absolute path.
  // A failed container launch must FAIL this test, never count as isolation.
  const source = `
    let result = { escaped: false };
    try { await import('node:fs'); }
    catch (error) {
      const workerProcess = error.constructor.constructor('return process')();
      const fs = workerProcess.getBuiltinModule('node:fs');
      result = { escaped: true, uid: workerProcess.getuid() };
      try { result.marker = fs.readFileSync(${JSON.stringify(markerPath)}, 'utf8'); }
      catch (readError) { result.readError = readError.code; }
    }
    export function probe() { return result; }
  `;
  const [result] = evaluate({ entry: 'probe.mjs', exportName: 'probe' }, { 'probe.mjs': source }, [[]]);
  assert.equal(result?.ok, true, 'Probe did not run: diagnose grader/Docker infrastructure');
  assert.deepEqual(result.value, { escaped: true, uid: 65534, readError: 'ENOENT' });
  assert.equal(fs.readFileSync(markerPath, 'utf8'), marker, 'Host marker must remain unchanged');
});

test('Docker infrastructure failures throw rather than become incorrect answers', () => {
  // Inject a launch failure without stopping Docker or running a model.
  const source = fs.readFileSync(new URL('./grade.mjs', import.meta.url), 'utf8');
  const start = source.indexOf('export function evaluate(');
  const end = source.indexOf('\nexport function grade(', start);
  assert.ok(start >= 0 && end > start);
  let calls = 0;
  const fakeEvaluate = vm.runInNewContext(`(${source.slice(start, end).replace('export ', '')})`, {
    randomUUID: () => 'offline-probe', worker: '',
    spawnSync: () => { calls++; return { status: 125, stdout: '', stderr: 'Cannot connect to the Docker daemon' }; },
  });
  assert.throws(()=>fakeEvaluate({ entry: 'probe.mjs', exportName: 'probe' }, {}, [[]]), /Grading infrastructure failed/);
  assert.equal(calls, 1);
});

test('pending reservations survive reopening and prevent overspend', (t) => {
  const { ledger, file } = temporaryLedger(t);
  ledger.reserve('unknown request outcome', 0.8, 'openrouter-actual');
  ledger.close();
  const reopened = new Ledger(file, 1);
  try {
    assert.equal(reopened.committed(), 0.8);
    assert.throws(() => reopened.reserve('next', 0.3, 'openrouter-actual'), /Budget stop/);
  } finally { reopened.close(); }
});

test('invalid settlement costs leave reservations pending', (t) => {
  const { ledger } = temporaryLedger(t);
  const id = ledger.reserve('request', 0.2, 'openrouter-actual');
  for (const charged of [undefined, null, NaN, Infinity, -1, '0.01']) {
    assert.throws(() => ledger.settle(id, charged));
    assert.equal(ledger.committed(), 0.2);
    assert.equal(ledger.data.entries[0].status, 'pending');
  }
});

test('an over-reservation response records actual spend and throws', (t) => {
  const { ledger } = temporaryLedger(t);
  const id = ledger.reserve('request', 0.1, 'openrouter-actual');
  assert.throws(() => ledger.settle(id, 0.3), /exceeded reservation/);
  assert.equal(ledger.committed(), 0.3);
});

function fakeResponse(noul) {
  return { ok: true, status: 200, json: async () => ({
    model: 'typesafe/jev-1.13', answers: { violation: { type: 'noul', noul } },
    usage: { cost: 0.0001, input_tokens: 100, output_tokens: 5 },
  }) };
}
const question = { violation: { type: 'noul', instructions: 'Does this violate the spec?' } };

test('Jev valid numeric probabilities settle actual cost using a fake transport', async (t) => {
  const { ledger } = temporaryLedger(t);
  let calls = 0;
  const result = await decide({ ledger, label: 'offline', state: {}, questions: question,
    apiKey: 'offline-test-key', fetchImpl: async (_, options) => {
      calls++;
      assert.ok(options.signal instanceof AbortSignal);
      return fakeResponse(0.5);
    },
  });
  assert.equal(calls, 1);
  assert.equal(result.answers.violation.noul, 0.5);
  assert.equal(ledger.committed(), 0.0001);
});

for (const value of [null, false, '0.75', undefined, NaN, Infinity, -0.1, 1.1]) {
  test(`Jev rejects an invalid noul value: ${String(value)}`, async (t) => {
    const { ledger } = temporaryLedger(t);
    await assert.rejects(decide({ ledger, label: 'offline', state: {}, questions: question,
      apiKey: 'offline-test-key', fetchImpl: async () => fakeResponse(value),
    }), /Invalid Jev probability/);
  });
}

test('Jev transport failure retains worst-case reservation without retries', async (t) => {
  const { ledger } = temporaryLedger(t);
  let calls = 0;
  await assert.rejects(decide({ ledger, label: 'offline', state: {}, questions: question,
    apiKey: 'offline-test-key', fetchImpl: async () => { calls++; throw Error('offline failure'); },
  }), /offline failure/);
  assert.equal(calls, 1);
  assert.equal(ledger.committed(), 0.01);
});

test('screening resume runs missing controls even when the Jev result exists', async () => {
  // Compile only this local orchestration function with offline dependencies.
  // No bench imports, real generation, ledger access, or CLI dispatch.
  const start = benchSource.indexOf('async function screening(ledger)');
  const end = benchSource.indexOf('\nconst command=', start);
  assert.ok(start >= 0 && end > start, 'Update function extraction if bench layout changes');
  const generated = [];
  const saved = new Map([['bulk-screen-blinded', { answers: {} }]]);
  const screening = vm.runInNewContext(`(${benchSource.slice(start, end).trim()})`, {
    tasks: [], load: (name) => saved.get(name), save: (name, value) => saved.set(name, value),
    generate: async ({ model }) => { generated.push(model); return {}; },
    jev: async () => { throw Error('Existing Jev result must not be rerun'); },
    sumCost: () => 0,
  });
  await screening({ data: { entries: [] } });
  assert.deepEqual(generated, ['luna', 'astra']);
  await screening({ data: { entries: [] } });
  assert.deepEqual(generated, ['luna', 'astra'], 'Completed controls must not be regenerated');
  saved.delete('bulk-screen-blinded-astra');
  await screening({ data: { entries: [] } });
  assert.deepEqual(generated, ['luna', 'astra', 'astra'], 'Resume only the missing control');
});

test('bulk screening payload uses opaque IDs and never exposes truth labels', async () => {
  const start=benchSource.indexOf('async function screening(ledger)');
  const end=benchSource.indexOf('\nconst command=',start);
  const states=[];
  const screening=vm.runInNewContext(`(${benchSource.slice(start,end).trim()})`,{
    createHash,tasks,ROOT:'/tmp/offline',path,load:()=>null,save:()=>{},sumCost:()=>0,
    noul:instructions=>({type:'noul',instructions}),
    jev:async(_ledger,_label,state)=>{states.push(state);return {answers:{},durationMs:0}},
    generate:async({prompt})=>{states.push(JSON.parse(prompt));return {}},
    codeRun:async()=>{},
  });
  await screening({data:{entries:[]}});
  assert.equal(states.length,3);
  for(const state of states){
    assert.equal(state.length,16);
    for(const item of state){
      assert.match(item.id,/^item-[a-f0-9]{12}$/);
      assert.deepEqual(Object.keys(item).sort(),['files','id','spec']);
    }
    assert.equal(new Set(state.map(s=>s.id)).size,16);
  }
});

function reserveFor(model, context = { prompt: 'x'.repeat(4000) }) {
  const start = benchSource.indexOf('onBeforeCall({');
  const end = benchSource.indexOf('onAfterCall({', start);
  assert.ok(start >= 0 && end > start, 'Update extraction if reservation is refactored');
  const reservations = [];
  const hook = vm.runInNewContext(`let reservation; ({${benchSource.slice(start, end)}}).onBeforeCall`, {
    Buffer, maxContextBytes:100000, label: 'offline-reservation', ledger: {
      reserve: (...args) => { reservations.push(args); return 'offline-id'; },
    },
  });
  hook({ model, context, maxOutputTokens: 128000 });
  assert.equal(reservations.length, 1);
  assert.equal(reservations[0][2], 'codex-api-equivalent');
  return reservations[0][1];
}

const baseCost = { input: 1, output: 1, cacheRead: 0.1, cacheWrite: 1 };
test('reservation includes a reachable higher-priced model tier', () => {
  const model = { cost: { ...baseCost,
    tiers: [{ inputTokensAbove: 100, input: 2, output: 3, cacheRead: 0.2, cacheWrite: 2 }],
  } };
  const usage = { input: 1000, output: 128000, cacheRead: 0, cacheWrite: 0, cost: {} };
  const reserved = reserveFor(model);
  const charged = calculateCost(model, usage).total;
  assert.ok(reserved >= charged, `Reserved ${reserved}, but reachable API-equivalent cost is ${charged}`);
});

test('unreachable 272k tier does not inflate reservations under the context byte cap', () => {
  const context = { prompt: 'x'.repeat(90000) };
  const withTier = { cost: { ...baseCost,
    tiers: [{ inputTokensAbove: 272000, input: 2, output: 3, cacheRead: 0.2, cacheWrite: 2 }],
  } };
  assert.equal(reserveFor(withTier, context), reserveFor({ cost: baseCost }, context));
});

test('reservation covers the highest reachable cache rate', () => {
  const model = { cost: { ...baseCost, cacheRead: 5, cacheWrite: 4 } };
  const context = { prompt: 'x'.repeat(4000) };
  const inputBound = Buffer.byteLength(JSON.stringify(context)) + 8192;
  assert.equal(reserveFor(model, context), (inputBound * 5 + 128000) / 1e6);
});

test('context byte cap rejects oversized requests before reserving', () => {
  assert.throws(() => reserveFor({ cost: baseCost }, { prompt: 'x'.repeat(100001) }),
    /Pilot context byte cap reached/);
});
