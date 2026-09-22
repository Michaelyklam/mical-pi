import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import tasks from './tasks/index.mjs';
import { Ledger } from './ledger.mjs';
import { grade } from './grade.mjs';
import {
  TARGET_IDS, ARMS, buildNotes, buildFilterState, buildCodingPrompt,
  lexicalSelect, buildJevQuestions, parseCandidate, runContextArm, main,
} from './context.mjs';

// No real generate/decide functions are imported or invoked by these tests.
function freeze(value) {
  if (value && typeof value === 'object') {
    Object.values(value).forEach(freeze);
    Object.freeze(value);
  }
  return value;
}
const target = tasks.find(task => task.id === 'retry-policy');
const hidden = 'HIDDEN_VERIFICATION_SENTINEL_8e7c';
function assertNoHidden(value) {
  const text = JSON.stringify(value);
  assert.ok(!text.includes(hidden));
  if (value && typeof value === 'object') {
    for (const [key, child] of Object.entries(value)) {
      assert.ok(!['cases', 'referenceFiles', 'expected'].includes(key), `Leaked ${key}`);
      assertNoHidden(child);
    }
  }
}
function sandbox(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'jev-context-test-'));
  const ledger = new Ledger(path.join(root, 'budget.json'), 50);
  t.after(() => {
    ledger.close();
    fs.rmSync(root, { recursive: true, force: true });
  });
  return { root, ledger };
}
function charge(ledger, label, dollars) {
  const id = ledger.reserve(label, dollars + 0.01, 'offline-test-only');
  ledger.settle(id, dollars);
}
const usage = { input: 100, output: 20, totalTokens: 120, cacheRead: 0, cacheWrite: 0 };
function fakeDependencies(task) {
  const calls = [];
  return {
    calls,
    generate: async request => {
      calls.push({ kind: 'generate', model: request.model });
      assertNoHidden({ prompt: request.prompt, systemPrompt: request.systemPrompt });
      assert.equal(request.maxTurns, 1);
      assert.deepEqual(request.toolSchemas, []);
      for (const key of ['executeTool', 'getTools', 'transformContext']) assert.equal(request[key], undefined);
      charge(request.ledger, request.label, request.model === 'luna' ? 0.02 : 0.1);
      return {
        answer: request.model === 'luna' ? 'Relevant synthetic observation: preserve the task-specific behavior.' : JSON.stringify({ files: task.referenceFiles }),
        stopReason: 'stop', messages: [], usage, accountedUsd: request.model === 'luna' ? 0.02 : 0.1,
      };
    },
    decide: async request => {
      calls.push({ kind: 'decide' });
      assertNoHidden({ state: request.state, questions: request.questions });
      charge(request.ledger, request.label, 0.001);
      return {
        answers: Object.fromEntries(request.state.observations.map(note => [note.id, {
          type: 'noul', noul: note.prompt === task.prompt ? 0.9 : 0.1,
        }])),
        usage: { input_tokens: 200, output_tokens: 30, cost: 0.001 }, durationMs: 1,
      };
    },
    grade,
  };
}
function artifactFile(root, task = target, arm = 'raw') {
  return path.join(root, 'runs', `context-${task.id}-${arm}.json`);
}

test('imports and help are offline, with no ledger or model runtime needed', () => {
  const url = new URL('./context.mjs', import.meta.url).href;
  const child = spawnSync(process.execPath, ['--input-type=module', '--eval', `
    globalThis.fetch = () => { throw Error('Network forbidden in import test'); };
    const { main, ARMS } = await import(${JSON.stringify(url)});
    if (ARMS.length !== 5) throw Error('Wrong arm count');
    await main(['--help']);
  `], { env: {}, encoding: 'utf8', timeout: 5000 });
  assert.equal(child.status, 0, child.stderr);
  assert.match(child.stdout, /Synthetic extra-context pilot/);
  assert.match(child.stdout, /Shared \$50 locked ledger/);
});

test('CLI rejects invalid options before loading providers or opening a ledger', async () => {
  await assert.rejects(main(['run', 'not-a-task']), /Usage/);
  await assert.rejects(main(['run', target.id, 'unknown']), /Usage/);
  await assert.rejects(main(['run', target.id, 'raw', 'extra']), /Usage/);
});

test('builders expose only original spec/source and exactly eight synthetic notes', () => {
  const fixtures = freeze(tasks.map(task => ({
    ...structuredClone(task),
    cases: [{ args: [hidden], expected: hidden }],
    referenceFiles: { 'secret.mjs': hidden },
  })));
  const before = JSON.stringify(fixtures);
  for (const id of TARGET_IDS) {
    const task = fixtures.find(item => item.id === id);
    const notes = buildNotes(task, fixtures);
    assert.equal(notes.length, 8);
    assert.equal(new Set(notes.map(note => note.id)).size, 8);
    assert.equal(notes.filter(note => note.prompt === task.prompt).length, 1);
    for (let i = 0; i < fixtures.length; i++) {
      assert.equal(notes[i].prompt, fixtures[i].prompt);
      assert.deepEqual(notes[i].files, fixtures[i].files);
      assert.match(notes[i].label, /SYNTHETIC NOTE/);
      assert.deepEqual(Object.keys(notes[i]).sort(), ['files', 'id', 'label', 'prompt']);
    }
    assertNoHidden(buildFilterState(task, notes));
    assertNoHidden(buildJevQuestions(notes));
    const raw = buildCodingPrompt(task, notes);
    const baseline = buildCodingPrompt(task);
    const summarized = buildCodingPrompt(task, [], 'A synthetic summary');
    for (const prompt of [raw, baseline, summarized]) {
      assert.ok(prompt.includes(task.prompt));
      assert.ok(prompt.includes(JSON.stringify(task.files, null, 2)));
      assert.ok(!prompt.includes(hidden));
    }
    const prefix = raw.split('SYNTHETIC RETRIEVED OBSERVATIONS')[0];
    assert.equal(baseline.split('SYNTHETIC RETRIEVED OBSERVATIONS')[0], prefix);
    assert.equal(summarized.split('SYNTHETIC RETRIEVED OBSERVATIONS')[0], prefix);
    assert.throws(() => buildCodingPrompt(task, notes, 'also summary'), /not both/);
  }
  assert.equal(JSON.stringify(fixtures), before);
});

test('builders never read hidden properties and returned file maps do not alias inputs', () => {
  const fixtures = tasks.map(task => ({
    id: task.id, prompt: task.prompt, files: task.files, entry: task.entry, exportName: task.exportName,
    get cases() { throw Error('cases accessed'); },
    get referenceFiles() { throw Error('reference accessed'); },
  }));
  const task = fixtures.find(item => item.id === target.id);
  const notes = buildNotes(task, fixtures);
  const state = buildFilterState(task, notes);
  assertNoHidden(state);
  lexicalSelect(task, notes);
  buildCodingPrompt(task, notes);
  const original = task.files[task.entry];
  state.originalRequest.files[task.entry] = 'changed';
  notes.find(note => note.prompt === task.prompt).files[task.entry] = 'changed';
  assert.equal(task.files[task.entry], original);
  assert.throws(() => buildNotes(task, fixtures.slice(1)), /eight unique/);
  assert.throws(() => buildNotes(task, fixtures.map(() => task)), /eight unique/);
});

test('lexical selector uses text, picks stable top-1, and preserves inputs', () => {
  for (const id of TARGET_IDS) {
    const task = tasks.find(item => item.id === id);
    const notes = freeze(buildNotes(task));
    const before = JSON.stringify(notes);
    const selected = lexicalSelect(task, notes);
    assert.equal(selected.notes.length, 1);
    assert.equal(selected.notes[0].prompt, task.prompt);
    assert.equal(selected.scores.find(score => score.id === selected.notes[0].id).score, 1);
    assert.deepEqual(lexicalSelect(task, notes), selected);
    assert.equal(JSON.stringify(notes), before);
    // Renaming identifiers must not influence relevance.
    assert.equal(lexicalSelect(task, notes.map((note, i) => ({ ...note, id: `random-${i}` }))).notes[0].prompt, task.prompt);
  }
  const query = { prompt: 'alpha beta', files: {} };
  const note = { label: 'SYNTHETIC NOTE', prompt: 'alpha beta', files: {} };
  assert.equal(lexicalSelect(query, [{ ...note, id: 'z' }, { ...note, id: 'a' }]).notes[0].id, 'z');
  assert.deepEqual(lexicalSelect(query, [{ ...note, prompt: 'unrelated', id: 'none' }]).notes, []);
  assert.deepEqual(lexicalSelect(query, []).notes, []);
});

test('Jev questions have explicit yes/no criteria and bounded note ids', () => {
  const notes = buildNotes(target);
  const questions = buildJevQuestions(notes);
  assert.deepEqual(Object.keys(questions), notes.map(note => note.id));
  for (const [id, question] of Object.entries(questions)) {
    assert.equal(question.type, 'noul');
    assert.ok(question.instructions.includes(id));
    assert.match(question.criteria.true, /^Yes/);
    assert.match(question.criteria.false, /^No/);
    assertNoHidden(question);
  }
});

test('candidate parser accepts only a complete, exact allowed file map', () => {
  const files = { 'a.mjs': 'export const a = "{} ```";\n', 'nested/b.mjs': 'export default 1;' };
  const json = JSON.stringify({ files });
  for (const answer of [json, ` \n${json}\n `, '```json\n' + json + '\n```', '```\n' + json + '\n```']) {
    assert.deepEqual(parseCandidate(answer, files), files);
  }
  const bad = [
    null, '', '{}', '[]', 'null', '{"files":null}', '{"files":[]}',
    JSON.stringify({ files, extra: true }),
    JSON.stringify({ files: { 'a.mjs': 'only one' } }),
    JSON.stringify({ files: { ...files, '../escape.mjs': 'no' } }),
    JSON.stringify({ files: { ...files, '/tmp/absolute.mjs': 'no' } }),
    JSON.stringify({ files: { ...files, 'a.mjs': 12 } }),
    JSON.stringify({ files: { ...files, 'a.mjs': 'x'.repeat(40001) } }),
    'x'.repeat(200001), `Here is the answer: ${json}`, `${json}\n{}`, `\`\`\`js\n${json}\n\`\`\``,
    '{"files":{"__proto__":"not allowed"}}',
  ];
  for (const answer of bad) assert.throws(() => parseCandidate(answer, files));
  assert.deepEqual(files, { 'a.mjs': 'export const a = "{} ```";\n', 'nested/b.mjs': 'export default 1;' });
});

for (const id of TARGET_IDS) {
  test(`${id}: all five arms are offline, grade, account, preserve inputs, and resume`, async t => {
    const env = sandbox(t);
    const task = freeze(structuredClone(tasks.find(item => item.id === id)));
    const before = JSON.stringify(task);
    const deps = fakeDependencies(task);
    for (const arm of ARMS) {
      const result = await runContextArm({ ...env, ...deps, task, arm });
      assert.equal(result.status, 'completed');
      assert.equal(result.grade.passed, true);
      assert.equal(result.grade.totalCases, task.cases.length);
      assert.equal(result.input.observations.length, 8);
      assert.ok(result.generationRequest.prompt.includes(task.prompt));
      assert.ok(result.generationRequest.prompt.includes(JSON.stringify(task.files, null, 2)));
      assertNoHidden(result.input);
      assertNoHidden(result.generationRequest);
      assert.ok(result.filter.durationMs >= 0);
      assert.ok(result.durationMs >= result.filter.durationMs);
      const expectedCost = arm === 'jev' ? 0.101 : arm === 'luna-summary' ? 0.12 : 0.1;
      assert.ok(Math.abs(result.accountedUsd - expectedCost) < 1e-10);
      assert.ok(Math.abs(result.generationAccountedUsd - 0.1) < 1e-10);
      assert.equal(result.filter.selectedIds.length, arm === 'raw' ? 8 : ['deterministic', 'jev'].includes(arm) ? 1 : 0);
      if (arm === 'jev') assert.equal(result.filter.tokens.input, 200);
      if (arm === 'luna-summary') {
        assert.equal(result.filter.tokens.input, 100);
        assert.equal(result.filter.summary, result.filter.response.answer);
      }
      if (['raw', 'no-notes', 'deterministic'].includes(arm)) assert.equal(result.filter.tokens.total, 0);
      const saved = JSON.parse(fs.readFileSync(artifactFile(env.root, task, arm), 'utf8'));
      assert.deepEqual(saved, result);
      assert.equal(fs.statSync(artifactFile(env.root, task, arm)).mode & 0o777, 0o600);
      const callCount = deps.calls.length;
      assert.deepEqual(await runContextArm({ ...env, ...deps, task, arm }), result);
      assert.equal(deps.calls.length, callCount, 'Completed artifacts must not call providers');
    }
    assert.equal(deps.calls.filter(call => call.kind === 'decide').length, 1);
    assert.equal(deps.calls.filter(call => call.model === 'luna').length, 1);
    assert.equal(deps.calls.filter(call => call.model === 'astra').length, 5);
    assert.equal(JSON.stringify(task), before);
  });
}

test('malformed completed candidate is a graded failure and resumes without retry', async t => {
  const env = sandbox(t);
  const deps = fakeDependencies(target);
  let calls = 0;
  deps.generate = async request => {
    calls++;
    charge(request.ledger, request.label, 0.1);
    return { answer: '{"files":{"../escape":"bad"}}', stopReason: 'stop', usage };
  };
  const result = await runContextArm({ ...env, ...deps, task: target, arm: 'raw' });
  assert.equal(result.status, 'completed');
  assert.equal(result.grade.passed, false);
  assert.match(result.parseError, /exactly match/);
  await runContextArm({ ...env, ...deps, task: target, arm: 'raw' });
  assert.equal(calls, 1);
});

test('failed and stale artifacts do not resume; previous costs remain visible', async t => {
  const env = sandbox(t);
  const deps = fakeDependencies(target);
  const request = { ...env, ...deps, task: target, arm: 'raw' };
  await assert.rejects(runContextArm({ ...request, generate: async options => {
    charge(options.ledger, options.label, 0.04);
    return { answer: '', stopReason: 'length', usage };
  } }), /completed text/);
  const failed = JSON.parse(fs.readFileSync(artifactFile(env.root), 'utf8'));
  assert.equal(failed.status, 'failed');
  assert.equal(failed.accountedUsd, 0.04);
  const result = await runContextArm(request);
  assert.equal(result.status, 'completed');
  assert.equal(result.attempts[0].status, 'failed');
  assert.ok(Math.abs(result.cumulativeAccountedUsd - 0.14) < 1e-10);
  const changed = { ...target, prompt: target.prompt + '\nKeep the same behavior.' };
  const updated = await runContextArm({ ...request, task: changed });
  assert.notEqual(updated.fingerprint, result.fingerprint);
  assert.equal(updated.attempts.length, 2);
});

test('interrupted running artifacts rerun and include settled orphan costs', async t => {
  const env = sandbox(t);
  const deps = fakeDependencies(target);
  const request = { ...env, ...deps, task: target, arm: 'raw' };
  const result = await runContextArm(request);
  const interrupted = { ...result, status: 'running' };
  delete interrupted.grade;
  delete interrupted.accountedUsd;
  fs.writeFileSync(artifactFile(env.root), JSON.stringify(interrupted));
  charge(env.ledger, 'context-retry-policy-raw-code', 0.03);
  const count = deps.calls.length;
  const resumed = await runContextArm(request);
  assert.equal(deps.calls.length, count + 1);
  assert.equal(resumed.status, 'completed');
  assert.ok(Math.abs(resumed.cumulativeAccountedUsd - 0.23) < 1e-10);
});

test('unsettled reservations fail closed and shared ledger lock remains exclusive', async t => {
  const env = sandbox(t);
  assert.throws(() => new Ledger(path.join(env.root, 'budget.json'), 50), /EEXIST/);
  env.ledger.reserve('unknown-spend', 0.2, 'offline-test');
  const deps = fakeDependencies(target);
  await assert.rejects(runContextArm({ ...env, ...deps, task: target, arm: 'raw' }), /Reconcile pending/);
  assert.equal(deps.calls.length, 0);
});

test('Jev validates numeric probabilities, accounts failures, and does not call Astra', async t => {
  const env = sandbox(t);
  const deps = fakeDependencies(target);
  await assert.rejects(runContextArm({ ...env, ...deps, task: target, arm: 'jev', decide: async request => {
    charge(request.ledger, request.label, 0.001);
    return { answers: { 'note-1': { type: 'noul', noul: '0.9' } } };
  } }), /Invalid Jev/);
  assert.equal(deps.calls.length, 0);
  const saved = JSON.parse(fs.readFileSync(artifactFile(env.root, target, 'jev'), 'utf8'));
  assert.equal(saved.status, 'failed');
  assert.equal(saved.filter.accountedUsd, 0.001);
  assert.equal(saved.filter.tokens, null);
});

test('Jev threshold includes exactly 0.5 and can retain no notes', async t => {
  const env = sandbox(t);
  const deps = fakeDependencies(target);
  const notes = buildNotes(target);
  const request = { ...env, ...deps, task: target, arm: 'jev', decide: async () => ({
    answers: Object.fromEntries(notes.map((note, i) => [note.id, { type: 'noul', noul: i === 0 ? 0.5 : 0.499 }])),
  }) };
  const result = await runContextArm(request);
  assert.deepEqual(result.filter.selectedIds, [notes[0].id]);
  fs.rmSync(artifactFile(env.root, target, 'jev'));
  const empty = await runContextArm({ ...request, decide: async () => ({
    answers: Object.fromEntries(notes.map(note => [note.id, { type: 'noul', noul: 0 }])),
  }) });
  assert.deepEqual(empty.filter.selectedIds, []);
});

test('failed paid filters record unknown tokens, and oversized summaries stop before Astra', async t => {
  const env = sandbox(t);
  const deps = fakeDependencies(target);
  const request = { ...env, ...deps, task: target, arm: 'luna-summary' };
  await assert.rejects(runContextArm({ ...request, generate: async options => {
    charge(options.ledger, options.label, 0.02);
    throw Error('Offline filter failure');
  } }), /Offline filter failure/);
  const failed = JSON.parse(fs.readFileSync(artifactFile(env.root, target, 'luna-summary'), 'utf8'));
  assert.equal(failed.filter.tokens, null);
  assert.equal(failed.filter.accountedUsd, 0.02);
  let calls = 0;
  await assert.rejects(runContextArm({ ...request, generate: async options => {
    calls++;
    assert.equal(options.model, 'luna');
    charge(options.ledger, options.label, 0.02);
    return { answer: 'x'.repeat(2001), stopReason: 'stop', usage };
  } }), /2000-character/);
  assert.equal(calls, 1);
});

test('context and Jev byte caps reject oversized payloads before any injected provider call', async t => {
  const env = sandbox(t);
  const huge = { ...target, prompt: target.prompt + 'x'.repeat(100001) };
  for (const arm of ['raw', 'jev', 'luna-summary']) {
    const deps = fakeDependencies(huge);
    await assert.rejects(runContextArm({ ...env, ...deps, task: huge, arm }), /byte pilot cap/);
    assert.equal(deps.calls.length, 0);
  }
  assert.equal(env.ledger.committed(), 0);
});
