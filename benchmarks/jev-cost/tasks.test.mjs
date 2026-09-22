import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, posix } from 'node:path';
import { pathToFileURL } from 'node:url';
import tasks, { tasks as namedTasks } from './tasks/index.mjs';

// This is a fixture self-check, not the production grader or a security sandbox.
// Only candidate files are materialized. Cases arrive over stdin after startup.
const worker = `
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
const { entry, exportName, cases } = JSON.parse(readFileSync(0, 'utf8'));
function freeze(value) {
  if (value && typeof value === 'object') {
    Object.values(value).forEach(freeze);
    Object.freeze(value);
  }
  return value;
}
const candidate = (await import(entry))[exportName];
assert.equal(typeof candidate, 'function');
const results = cases.map(({args, expected}, index) => {
  try {
    const input = freeze(structuredClone(args));
    const before = structuredClone(input);
    // Repeated calls also catch accidental module-level state across invocations.
    for (let repeat = 0; repeat < 2; repeat++) {
      const actual = candidate(...input);
      assert.deepStrictEqual(actual, expected);
      assert.deepStrictEqual(JSON.parse(JSON.stringify(actual)), actual);
      assert.deepStrictEqual(input, before);
    }
    return {index, passed: true};
  } catch (error) {
    return {index, passed: false, error: String(error)};
  }
});
process.stdout.write(JSON.stringify(results));
`;

function safePath(path) {
  return typeof path === 'string' && path.length > 0 && !path.includes('\\') &&
    !posix.isAbsolute(path) && path.split('/').every(part => part && part !== '.' && part !== '..');
}

async function execute(task, files, timeout = 3000) {
  const workspace = await mkdtemp(join(tmpdir(), 'jev-cost-fixture-'));
  try {
    for (const [path, source] of Object.entries(files)) {
      assert.ok(safePath(path), `Unsafe candidate path: ${path}`);
      const destination = join(workspace, path);
      await mkdir(dirname(destination), { recursive: true });
      await writeFile(destination, source, { flag: 'wx' });
    }
    assert.ok(safePath(task.entry));
    return spawnSync(process.execPath, ['--input-type=module', '--eval', worker], {
      cwd: workspace,
      env: {}, // Do not inherit credentials, NODE_OPTIONS, PATH, or other host state.
      shell: false,
      input: JSON.stringify({
        entry: pathToFileURL(join(workspace, task.entry)).href,
        exportName: task.exportName,
        cases: task.cases,
      }),
      encoding: 'utf8',
      timeout,
      killSignal: 'SIGKILL',
      maxBuffer: 1024 * 1024,
    });
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
}

function resultsOf(result) {
  assert.ifError(result.error);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.signal, null);
  return JSON.parse(result.stdout);
}

const knownFailure = {
  'normalize-tags': 1,
  'parse-query': 1,
  'merge-intervals': 1,
  'event-scheduler': 1,
  'retry-policy': 0,
  'merge-patch': 0,
  'lease-state': 1,
  'dependency-order': 1,
};

test('registry contract and complete independent file sets', () => {
  assert.equal(tasks, namedTasks);
  assert.equal(tasks.length, 8);
  assert.equal(new Set(tasks.map(task => task.id)).size, 8);
  assert.ok(tasks.filter(task => Object.keys(task.files).length >= 2).length >= 2);
  for (const task of tasks) {
    for (const key of ['id', 'category', 'difficulty', 'prompt', 'entry', 'exportName']) {
      assert.equal(typeof task[key], 'string', `${task.id}.${key}`);
      assert.ok(task[key].length > 0);
    }
    assert.ok(['easy', 'medium', 'hard'].includes(task.difficulty));
    assert.ok(Object.hasOwn(task.files, task.entry));
    assert.deepEqual(Object.keys(task.referenceFiles).sort(), Object.keys(task.files).sort());
    assert.ok(task.cases.length >= 5);
    assert.deepEqual(JSON.parse(JSON.stringify(task.cases)), task.cases);
    for (const item of task.cases) {
      assert.ok(Array.isArray(item.args));
      assert.ok(Object.hasOwn(item, 'expected'));
    }
    for (const files of [task.files, task.referenceFiles]) {
      for (const [path, source] of Object.entries(files)) {
        assert.ok(safePath(path));
        assert.equal(typeof source, 'string');
      }
    }
  }
});

for (const task of tasks) {
  test(`${task.id}: reference passes all behavioral cases`, async () => {
    const results = resultsOf(await execute(task, task.referenceFiles));
    assert.equal(results.length, task.cases.length);
    assert.deepEqual(results.filter(result => !result.passed), []);
  });
  test(`${task.id}: baseline fails known behavioral case`, async () => {
    // Syntax/import failures do not count as the intended baseline failure.
    const results = resultsOf(await execute(task, task.files));
    assert.equal(results.length, task.cases.length);
    assert.equal(results[knownFailure[task.id]].passed, false);
    assert.match(results[knownFailure[task.id]].error, /AssertionError/);
  });
}

test('subprocess times out on a nonterminating candidate', async () => {
  const fixture = { entry: 'main.mjs', exportName: 'run', cases: [{ args: [], expected: null }] };
  const result = await execute(fixture, { 'main.mjs': 'export function run() { while (true) {} }' }, 500);
  assert.equal(result.error?.code, 'ETIMEDOUT');
  assert.equal(result.signal, 'SIGKILL');
});

test('subprocess receives no inherited environment', async () => {
  const fixture = { entry: 'main.mjs', exportName: 'run', cases: [{ args: [], expected: [] }] };
  const results = resultsOf(await execute(fixture, {
    'main.mjs': 'export function run() { return Object.keys(process.env); }',
  }));
  assert.equal(results[0].passed, true);
});

test('behavioral checks reject input mutation', async () => {
  const fixture = { entry: 'main.mjs', exportName: 'run', cases: [{ args: [[1]], expected: [1, 2] }] };
  const results = resultsOf(await execute(fixture, {
    'main.mjs': 'export function run(items) { items.push(2); return items; }',
  }));
  assert.equal(results[0].passed, false);
});
