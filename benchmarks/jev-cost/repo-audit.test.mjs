// Fail-closed audit regressions. No Docker, model runtime, credentials, or paid calls.
// Runner control flow is copied unchanged into scratch; only dependency imports
// and filesystem roots are replaced. Report runs against synthetic artifacts.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
const here = path.dirname(fileURLToPath(import.meta.url));
const scratch = '/tmp/jev-repo-author-mical';
const counts = (passed = 3, failed = 0, cancelled = 0, skipped = 0) => ({
  status: 0,
  stdout: `TAP version 13\n# tests ${passed + failed + cancelled + skipped}\n# pass ${passed}\n# fail ${failed}\n# cancelled ${cancelled}\n# skipped ${skipped}\n# todo 0\n`,
  stderr: '', timedOut: false, protectedFilesUnchanged: true,
});
const good = counts();
async function fixture(t) {
  await fs.mkdir(scratch, { recursive: true });
  const dir = await fs.mkdtemp(path.join(scratch, 'audit-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  return dir;
}
async function save(dir, name, value) {
  await fs.mkdir(path.join(dir, 'repo-runs'), { recursive: true });
  await fs.writeFile(path.join(dir, 'repo-runs', name + '.json'), JSON.stringify(value));
}
async function load(dir, name) {
  return JSON.parse(await fs.readFile(path.join(dir, 'repo-runs', name + '.json'), 'utf8'));
}
function charge(ledger, label, amount, pending = false) {
  ledger.data.entries.push({ label, status: pending ? 'pending' : 'settled', reserved: amount, charged: amount });
}
function dependencies() {
  const deps = {
    calls: [],
    Ledger: class { data = { entries: [] }; close() {} },
    execute: async () => good,
    generate: async options => {
      deps.calls.push('generate');
      if (deps.onGenerate) return deps.onGenerate(options);
      charge(options.ledger, options.label, 0.2);
      return { stopReason: 'stop', turns: 1, answer: '{"model":"luna"}', accountedUsd: 0.2 };
    },
    decide: async options => {
      deps.calls.push('decide');
      if (deps.onDecide) return deps.onDecide(options);
      charge(options.ledger, options.label, 0.01);
      return { answers: { model: { choice: 'luna' } } };
    },
  };
  return deps;
}
async function runner(t, dir, deps = dependencies()) {
  const key = 'jev-audit-' + path.basename(dir);
  globalThis[key] = deps;
  t.after(() => delete globalThis[key]);
  let text = await fs.readFile(path.join(here, 'repo-runner.mjs'), 'utf8');
  function replace(pattern, replacement) {
    assert.match(text, pattern, 'Audit dependency seam changed; refuse to import live dependencies');
    text = text.replace(pattern, replacement);
  }
  for (const name of ['Ledger', 'generate', 'decide']) {
    replace(new RegExp(`import \\{\\s*${name}\\s*\\} from '[^']+';`), `const {${name}}=globalThis[${JSON.stringify(key)}];`);
  }
  replace(/import \{\s*execFileSync\s*\} from 'node:child_process';/, "const execFileSync=()=> 'offline-audit-image';");
  replace(/const BASE=[^;]+;/, `const BASE=${JSON.stringify(path.join(dir, 'tasks'))};`);
  replace(/const ROOT=[^;]+;/, `const ROOT=${JSON.stringify(dir)};`);
  replace(/const \{execute\}=await import\('\.\/repo-sandbox\.mjs'\);/, `const {execute}=globalThis[${JSON.stringify(key)}];`);
  assert.doesNotMatch(text, /(?:from\s*|import\s*\()['"]\.\//, 'Unexpected unmocked local dependency');
  text += '\nexport {route as auditRoute};\n';
  const file = path.join(dir, 'runner.mjs');
  await fs.writeFile(file, text);
  return import(pathToFileURL(file).href);
}
function completed(task, cost = 2) {
  return { status: 'completed', fingerprint: task.fingerprint, verifiedSuccess: true,
    accountedUsd: cost, generation: { stopReason: 'stop', turns: 1 },
    visible: { passed: true }, hidden: { passed: true } };
}
function calibration(tasks) {
  return tasks.filter(t => t.split === 'calibration').map(t => ({ request: t.prompt,
    luna: { passed: true, cost: 2 }, astra: { passed: true, cost: 2 } }));
}
function completedRoute(task, state) {
  return { status: 'completed', fingerprint: task.fingerprint, state, choice: 'luna',
    deterministicChoice: 'luna', jevCost: 0.01,
    lunaRouter: { choice: 'luna', accountedUsd: 0.2 }, accountedUsd: 0.21 };
}
async function suite(t) {
  const dir = await fixture(t), deps = dependencies(), api = await runner(t, dir, deps);
  for (const [id, split] of [['a-cal', 'calibration'], ['b-cal', 'calibration'], ['c-eval', 'evaluation'], ['d-eval', 'evaluation']]) {
    const task = path.join(dir, 'tasks', 'repo', id);
    for (const folder of ['baseline', 'hidden', 'reference']) await fs.mkdir(path.join(task, folder), { recursive: true });
    await fs.writeFile(path.join(task, 'task.json'), JSON.stringify({ id, repo: 'mical-pi', split,
      prompt: 'Implement behavior', visibleTestCommand: ['node', '--test', 'visible.test.js'],
      hiddenTestCommand: ['node', '--test', 'hidden.test.js'] }));
    await fs.writeFile(path.join(task, 'baseline', 'a.js'), 'baseline');
    await fs.writeFile(path.join(task, 'reference', 'a.js'), 'reference');
    await fs.writeFile(path.join(task, 'hidden', 'hidden.test.js'), 'hidden');
  }
  const tasks = api.readTasks();
  for (const task of tasks) {
    await save(dir, task.id + '-validation', { valid: true, fingerprint: task.fingerprint,
      referenceVisible: { tests: 3, passedCount: 3 }, referenceHidden: { tests: 3, passedCount: 3 } });
    if (task.split === 'calibration') for (const model of ['luna', 'astra']) await save(dir, task.id + '-' + model, completed(task));
    else await save(dir, task.id + '-route', completedRoute(task, api.routingState(task, calibration(tasks))));
  }
  await api.main(['freeze']);
  return { dir, deps, api, tasks };
}

test('parser requires consistent stdout summaries and ignores diagnostic/stderr counters', async t => {
  const dir = await fixture(t), { testSummary } = await runner(t, dir);
  assert.equal(testSummary(good).passed, true);
  for (const result of [counts(1, 2), counts(1, 0, 2), counts(0, 0, 0, 3),
    { ...good, stdout: good.stdout.replace('# tests 3', '# tests 99') },
    { ...good, stdout: good.stdout.replace('# pass 3', '# pass 5') },
    { ...good, stdout: good.stdout.replace('# fail 0\n', '') },
    { ...good, stdout: 'diagnostic # tests 3\ndiagnostic # pass 3\ndiagnostic # fail 0' },
    { ...good, stdout: '', stderr: good.stdout },
    { ...good, status: 1 }, { ...good, timedOut: true }, { ...good, protectedFilesUnchanged: false }]) {
    assert.equal(testSummary(result).passed, false, JSON.stringify(result));
  }
  const parsed = testSummary({ ...good, stderr: '# tests 999\n# pass 999\n# fail 42' });
  assert.equal(parsed.passed, true);
  assert.equal(parsed.tests, 3);
  assert.equal(parsed.passedCount, 3);
  const diagnostic = testSummary({ ...good, stdout: good.stdout + 'diagnostic # tests 999\ndiagnostic # pass 999\n' });
  assert.equal(diagnostic.tests, 3);
  assert.equal(diagnostic.passedCount, 3);
  assert.equal(testSummary({ ...good, stdout: ' Tests  7 passed (7)\n' }).passed, true);
});

test('all evaluation routes must be completed and current before any generation', async t => {
  for (const variant of ['missing', 'running', 'interrupted', 'stale', 'stale-state']) await t.test(variant, async t => {
    const { dir, deps, api, tasks } = await suite(t);
    const task = tasks.find(t => t.id === 'd-eval');
    if (variant === 'missing') await fs.rm(path.join(dir, 'repo-runs', task.id + '-route.json'));
    else {
      const route = await load(dir, task.id + '-route');
      if (variant === 'stale') route.fingerprint = 'stale';
      else if (variant === 'stale-state') route.state.calibration[0].luna.passed = false;
      else route.status = variant;
      await save(dir, task.id + '-route', route);
    }
    await assert.rejects(api.main(['run', 'evaluation']));
    assert.deepEqual(deps.calls, [], 'No first-task generation before the whole suite is routed');
  });
});

test('calibration artifacts must be completed and current before either router is called', async t => {
  for (const variant of ['missing', 'running', 'interrupted', 'stale']) await t.test(variant, async t => {
    const { dir, deps, api, tasks } = await suite(t);
    for (const task of tasks.filter(t => t.split === 'evaluation')) await fs.rm(path.join(dir, 'repo-runs', task.id + '-route.json'));
    const task = tasks.find(t => t.id === 'b-cal');
    if (variant === 'missing') await fs.rm(path.join(dir, 'repo-runs', task.id + '-astra.json'));
    else {
      const run = completed(task);
      if (variant === 'stale') run.fingerprint = 'stale';
      else run.status = variant;
      await save(dir, task.id + '-astra', run);
    }
    await assert.rejects(api.main(['route']));
    assert.deepEqual(deps.calls, []);
  });
});

const routeTask = { id: 'eval', repo: 'mical-pi', fingerprint: 'current', prompt: 'Implement behavior', files: { 'a.ts': 'export {}' } };
const examples = [{ request: 'Calibration example', luna: { passed: true, cost: 2 }, astra: { passed: true, cost: 3 } }];
test('completed route cache requires matching fingerprint and calibration state', async t => {
  const dir = await fixture(t), deps = dependencies(), api = await runner(t, dir, deps);
  const cached = completedRoute(routeTask, api.routingState(routeTask, examples));
  await save(dir, 'eval-route', cached);
  assert.deepEqual(await api.auditRoute(routeTask, examples, new deps.Ledger()), cached);
  await assert.rejects(api.auditRoute({ ...routeTask, fingerprint: 'changed' }, examples, new deps.Ledger()));
  const changed = structuredClone(examples); changed[0].luna.passed = false;
  await assert.rejects(api.auditRoute(routeTask, changed, new deps.Ledger()));
  assert.deepEqual(deps.calls, [], 'A stale checkpoint must fail, not silently spend again');
});

test('route persists running status before requests and first-selector results before the second', async t => {
  const dir = await fixture(t), deps = dependencies();
  deps.onDecide = async options => {
    const record = await load(dir, 'eval-route');
    assert.equal(record.status, 'running');
    assert.equal(record.fingerprint, routeTask.fingerprint);
    charge(options.ledger, options.label, 0.01);
    return { answers: { model: { choice: 'luna' } } };
  };
  deps.onGenerate = async options => {
    const record = await load(dir, 'eval-route');
    assert.equal(record.status, 'running');
    assert.equal(record.jevCost, 0.01);
    assert.equal(record.response.answers.model.choice, 'luna');
    charge(options.ledger, options.label, 0.2);
    return { stopReason: 'stop', answer: '{"model":"astra"}', accountedUsd: 0.2 };
  };
  const api = await runner(t, dir, deps), ledger = new deps.Ledger();
  const result = await api.auditRoute(routeTask, examples, ledger);
  assert.equal(result.status, 'completed');
  assert.equal(result.lunaRouter.choice, 'astra');
  assert.equal(result.lunaRouter.accountedUsd, 0.2);
  assert.ok(Math.abs(result.accountedUsd - 0.21) < 1e-12);
  assert.deepEqual(await load(dir, 'eval-route'), result);
  assert.deepEqual(await api.auditRoute(routeTask, examples, ledger), result);
  assert.deepEqual(deps.calls, ['decide', 'generate']);
});

test('interrupted selectors persist costs and reject retry without another request', async t => {
  for (const stage of ['jev-unknown', 'luna-unknown', 'luna-invalid']) await t.test(stage, async t => {
    const dir = await fixture(t), deps = dependencies();
    if (stage === 'jev-unknown') deps.onDecide = async options => {
      charge(options.ledger, options.label, 0.01, true); throw Error('Unknown Jev usage');
    };
    else deps.onGenerate = async options => {
      charge(options.ledger, options.label, 0.2, stage === 'luna-unknown');
      if (stage === 'luna-unknown') throw Error('Unknown Luna usage');
      return { stopReason: 'stop', answer: 'invalid JSON', accountedUsd: 0.2 };
    };
    const api = await runner(t, dir, deps), ledger = new deps.Ledger();
    await assert.rejects(api.auditRoute(routeTask, examples, ledger));
    const record = await load(dir, 'eval-route');
    assert.equal(record.status, 'interrupted');
    assert.equal(record.fingerprint, routeTask.fingerprint);
    assert.ok(Math.abs(record.accountedUsd - (stage === 'jev-unknown' ? 0.01 : 0.21)) < 1e-12);
    if (stage !== 'jev-unknown') {
      assert.equal(record.jevCost, 0.01);
      assert.equal(record.response.answers.model.choice, 'luna');
    }
    if (stage === 'luna-invalid') {
      assert.equal(record.lunaRouter.accountedUsd, 0.2);
      assert.equal(record.lunaRouter.answer, 'invalid JSON');
    }
    const before = [...deps.calls];
    await assert.rejects(api.auditRoute(routeTask, examples, ledger));
    assert.deepEqual(deps.calls, before);
    assert.deepEqual(await load(dir, 'eval-route'), record);
  });
});

test('running route checkpoint from a killed process cannot be retried automatically', async t => {
  const dir = await fixture(t), deps = dependencies(), api = await runner(t, dir, deps);
  await save(dir, 'eval-route', { ...completedRoute(routeTask, api.routingState(routeTask, examples)), status: 'running' });
  await assert.rejects(api.auditRoute(routeTask, examples, new deps.Ledger()));
  assert.deepEqual(deps.calls, []);
});

test('verified success requires both visible test and visible pass counts to meet reference', async t => {
  for (const variant of ['fewer-tests', 'fewer-passes', 'matching', 'extra-tests']) await t.test(variant, async t => {
    const { dir, deps, api, tasks } = await suite(t);
    const task = tasks.find(t => t.id === 'c-eval');
    if (variant === 'fewer-tests') {
      // Same passing count, but the reference also completed a skipped test.
      // Isolate the total-count guard from the separate passing-count guard.
      const validation = await load(dir, task.id + '-validation');
      validation.referenceVisible = { tests: 4, passedCount: 3 };
      await save(dir, task.id + '-validation', validation);
    }
    const result = await api.runTask(task, 'luna', new deps.Ledger(), async ({ command }) => {
      if (command.includes('hidden.test.js')) return good;
      return variant === 'fewer-passes' ? counts(2, 0, 0, 1) : variant === 'extra-tests' ? counts(4) : good;
    });
    assert.equal(result.status, 'completed');
    assert.equal(result.visible.passed, true, 'The parser passes; reference-count gating decides success');
    assert.equal(result.hidden.passed, true);
    const expected = variant === 'matching' || variant === 'extra-tests';
    assert.equal(result.verifiedSuccess, expected);
    assert.equal((await load(dir, 'c-eval-luna')).verifiedSuccess, expected);
  });
});

async function reportFixture(t) {
  const dir = await fixture(t);
  const tasks = ['first', 'second'].map(id => ({ id, repo: 'mical-pi', split: 'evaluation', fingerprint: 'current-' + id }));
  await save(dir, 'protocol', { tasks, maxTurns: 24, timeoutMs: 600000, reasoning: 'medium' });
  for (const task of tasks) {
    for (const model of ['luna', 'astra']) await save(dir, task.id + '-' + model, completed(task));
    await save(dir, task.id + '-route', completedRoute(task, {}));
  }
  await fs.writeFile(path.join(dir, 'budget.json'), JSON.stringify({ entries: [] }));
  return { dir, tasks };
}
function report(dir) {
  return spawnSync(process.execPath, [path.join(here, 'repo-report.mjs')], {
    env: { ...process.env, JEV_BENCH_OUT: dir }, encoding: 'utf8', timeout: 10000,
  });
}
test('report rejects stale coding and routing artifacts', async t => {
  for (const kind of ['luna', 'astra', 'route']) await t.test(kind, async t => {
    const { dir } = await reportFixture(t);
    const record = await load(dir, 'second-' + kind); record.fingerprint = 'stale';
    await save(dir, 'second-' + kind, record);
    const result = report(dir);
    assert.notEqual(result.status, 0, 'Stale fingerprints must invalidate the report');
    assert.match(result.stderr, /fingerprint|stale|mismatch/i);
  });
});

test('incomplete held-out runs withhold all policies without dropping recorded cohort costs', async t => {
  for (const kind of ['interrupted', 'running', 'missing', 'route-interrupted', 'route-missing']) await t.test(kind, async t => {
    const { dir, tasks } = await reportFixture(t);
    await save(dir, 'first-luna', completed(tasks[0], 8));
    if (kind === 'missing' || kind === 'route-missing') {
      await fs.rm(path.join(dir, 'repo-runs', kind === 'missing' ? 'second-luna.json' : 'second-route.json'));
    } else {
      const name = kind === 'route-interrupted' ? 'second-route' : 'second-luna';
      const record = await load(dir, name);
      record.status = kind === 'running' ? 'running' : 'interrupted';
      record.verifiedSuccess = false;
      await save(dir, name, record);
    }
    const result = report(dir);
    assert.equal(result.status, 0, result.stderr);
    const summary = JSON.parse(result.stdout);
    assert.deepEqual(summary.policies, {}, 'Do not publish a surviving-task subset');
    assert.equal(summary.cohorts['evaluation-luna'].cost, kind === 'missing' ? 8 : 10);
    assert.equal(summary.cohorts['evaluation-astra'].cost, 4);
  });
});

test('complete current artifacts still produce full policy comparisons', async t => {
  const { dir } = await reportFixture(t), result = report(dir);
  assert.equal(result.status, 0, result.stderr);
  const summary = JSON.parse(result.stdout);
  assert.equal(Object.keys(summary.policies).length, 7);
  for (const policy of Object.values(summary.policies)) assert.equal(policy.count, 2);
  assert.equal(summary.policies['luna-only'].cost, 4);
  assert.ok(Math.abs(summary.policies.jev.cost - 4.02) < 1e-12);
  assert.ok(Math.abs(summary.policies['luna-router'].cost - 4.4) < 1e-12);
});
