import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID, createHash } from 'node:crypto';
import * as fs from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { execute } from './repo-sandbox.mjs';

const sandbox = (options = {}) => execute({ repo: 'mical-pi', files: {}, command: ['node', '-e', 'console.log("ok")'], ...options });

test('rejects traversal and reserved dependency/git writes without launching Docker', async () => {
  for (const name of ['/tmp/escape', '../escape', 'a/../../escape', 'a/../x', 'a//x', './x', 'C:/x', 'a\\x', 'a\0x', 'node_modules/x', 'a/node_modules/x', '.git/config']) {
    await assert.rejects(sandbox({ files: { [name]: '' } }), TypeError);
  }
  await assert.rejects(sandbox({ protectedPaths: ['absent'] }), TypeError);
  await assert.rejects(sandbox({ command: [] }), TypeError);
  await assert.rejects(sandbox({ timeoutMs: 0 }), TypeError);
});

// Integration is explicit. It never builds images or downloads dependencies.
// node --test benchmarks/jev-cost/repo-sandbox.test.mjs
// JEV_SANDBOX_TEST=1 node --test benchmarks/jev-cost/repo-sandbox.test.mjs
const integration = process.env.JEV_SANDBOX_TEST === '1' ? test : test.skip;

integration('isolates host files, credentials, network and root filesystem; fresh work per invocation', async () => {
  await fs.mkdir('/tmp/jev-repo-sandbox-build', { recursive: true });
  const marker = `/tmp/jev-repo-sandbox-build/host-marker-${randomUUID()}`;
  await fs.writeFile(marker, randomUUID());
  process.env.JEV_PRIVATE_CREDENTIAL = 'must-not-leak';
  try {
    const result = await sandbox({ command: ['node', '-e', `
      const fs = require('node:fs'); const assert = require('node:assert/strict');
      assert.equal(process.getuid(), 65534);
      assert.deepEqual(Object.keys(process.env).sort(), ['PATH', 'TZ']);
      for (const name of [${JSON.stringify(marker)}, '/var/run/docker.sock', '/home/michael/.aws/credentials']) assert.equal(fs.existsSync(name), false);
      assert.throws(() => fs.writeFileSync('/escape', 'bad'));
      assert.equal(fs.readFileSync('/proc/self/status','utf8').match(/CapEff:\\s+(\\w+)/)[1], '0000000000000000');
      assert.match(fs.readFileSync('/proc/self/status','utf8'), /NoNewPrivs:\\s+1/);
      assert.deepEqual(Object.keys(require('node:os').networkInterfaces()), ['lo']);
      fs.writeFileSync('/work/leftover', 'x'); console.log('isolated');
    `] });
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /isolated/);
    const fresh = await sandbox({ command: ['node', '-e', 'if(require("node:fs").existsSync("/work/leftover"))process.exit(1)'] });
    assert.equal(fresh.status, 0);
  } finally { delete process.env.JEV_PRIVATE_CREDENTIAL; await fs.rm(marker); }
});

integration('TypeScript, effect, acorn, pi SDK imports and TAP test counts', async () => {
  const result = await sandbox({
    files: { 'package.json': '{"type":"module"}', 'check.test.ts': `
      import {test} from 'node:test';
      import assert from 'node:assert/strict';
      import {Effect} from 'effect';
      import {parse} from 'acorn';
      import {createAgentSession} from '@earendil-works/pi-coding-agent';
      test('typescript deps', () => { const n: number = Effect.runSync(Effect.succeed(42)); assert.equal(n,42); assert.equal(parse('1',{ecmaVersion:2020}).type,'Program'); assert.equal(typeof createAgentSession, 'function'); });
    ` },
    command: ['node', '--import', 'tsx', '--test', 'check.test.ts'], protectedPaths: ['check.test.ts'],
  });
  assert.equal(result.status, 0, result.stderr + result.stdout);
  assert.match(result.stdout, /(?:#|ℹ) tests 1/);
  assert.match(result.stdout, /(?:#|ℹ) pass 1/);
  assert.deepEqual(result.testSummary, { tests: 1, passed: 1, failed: 0, skipped: 0, cancelled: 0 });
  assert.equal(result.protectedFilesUnchanged, true);
});

integration('foosheq vitest executes React/TS test and reports count', async () => {
  const result = await sandbox({ repo: 'foosheq', files: {
    'package.json': '{"type":"module"}',
    'vitest.config.ts': `import {defineConfig} from 'vitest/config'; export default defineConfig({cacheDir:'.test-cache',test:{environment:'node',pool:'forks',maxWorkers:1,fileParallelism:false}});`,
    'react.test.ts': `import {test,expect} from 'vitest'; import React from 'react'; test('react import',()=>{const n: number = 7; expect(React.createElement('div',null,n).type).toBe('div')});`,
  }, command: ['node', 'node_modules/vitest/vitest.mjs', 'run', '--config', 'vitest.config.ts', 'react.test.ts'], protectedPaths: ['react.test.ts', 'vitest.config.ts'] });
  assert.equal(result.status, 0, result.stderr + result.stdout);
  assert.match(result.stdout, /1 passed/);
  assert.deepEqual(result.testSummary, { tests: 1, passed: 1, failed: 0, skipped: 0, cancelled: 0 });
  assert.equal(result.protectedFilesUnchanged, true);
});

integration('bounds both streams and preserves nonzero command exit codes', async () => {
  const result = await sandbox({ command: ['node', '-e', 'process.stdout.write("x".repeat(3*1024*1024));process.stderr.write("y".repeat(3*1024*1024));process.exitCode=7'] });
  assert.equal(result.status, 7);
  assert.equal(Buffer.byteLength(result.stdout), 1024 * 1024);
  assert.equal(Buffer.byteLength(result.stderr), 1024 * 1024);
  assert.equal(result.testSummary, null);
  const invalid = await sandbox({ command: ['node', '-e', 'process.stdout.write(Buffer.alloc(2*1024*1024,255))'] });
  assert.ok(Buffer.byteLength(invalid.stdout) <= 1024 * 1024);
});

integration('timeout removes container and runaway descendants', async () => {
  const result = await sandbox({ timeoutMs: 3000, command: ['node', '-e', `require('node:child_process').spawn('node',['-e','setInterval(()=>{},1000)'],{detached:true,stdio:'ignore'}).unref(); console.log(require('node:os').hostname()); setInterval(()=>{},1000)`] });
  assert.equal(result.timedOut, true);
  assert.equal(result.status, null);
  assert.equal(result.protectedFilesUnchanged, false);
  assert.ok(result.durationMs < 15000);
  const containerId = result.stdout.trim();
  assert.match(containerId, /^[a-f0-9]{12}$/);
  assert.throws(() => execFileSync('docker', ['container', 'inspect', containerId], { stdio: 'pipe' }));
});

integration('parent hashes detect edits, deletions and replacements of protected tests', async () => {
  for (const code of [
    'fs.writeFileSync("test.ts","changed")',
    'fs.unlinkSync("test.ts")',
    'fs.unlinkSync("test.ts");fs.symlinkSync("other.ts","test.ts")',
  ]) {
    const result = await sandbox({ files: { 'test.ts': 'original', 'other.ts': 'original' }, protectedPaths: ['test.ts'], command: ['node', '-e', `const fs=require('node:fs');${code}`] });
    assert.equal(result.status, 0);
    assert.equal(result.protectedFilesUnchanged, false);
  }
});

integration('exit zero without tests has no test summary; local binaries resolve offline', async () => {
  const noTests = await sandbox();
  assert.equal(noTests.status, 0);
  assert.equal(noTests.testSummary, null);
  const bin = await sandbox({ command: ['tsx', '-e', 'const n: number = 42; console.log(n)'] });
  assert.equal(bin.status, 0, bin.stderr);
  assert.match(bin.stdout, /42/);
});

integration('stdin transport preserves multibyte file contents across chunks', async () => {
  const content = '测试🙂'.repeat(20000);
  const hash = createHash('sha256').update(content).digest('hex');
  const result = await sandbox({ files: { 'unicode.txt': content }, protectedPaths: ['unicode.txt'], command: ['node', '-e', `console.log(require('node:crypto').createHash('sha256').update(require('node:fs').readFileSync('unicode.txt')).digest('hex'))`] });
  assert.equal(result.status, 0);
  assert.equal(result.stdout.trim(), hash);
  assert.equal(result.protectedFilesUnchanged, true);
});

integration('bootstrap inspector cannot be activated by the candidate', async () => {
  const result = await sandbox({ command: ['node', '-e', `
    const assert = require('node:assert/strict');
    assert.match(require('node:fs').readFileSync('/proc/1/cmdline','utf8'), /--disable-sigusr1/);
    process.kill(1, 'SIGUSR1');
    setTimeout(async () => { try { await fetch('http://127.0.0.1:9229/json'); process.exitCode=1; } catch { console.log('inspector disabled'); } }, 100);
  `] });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /inspector disabled/);
});

integration('command launch errors are infrastructure errors, not code failures', async () => {
  await assert.rejects(sandbox({ command: ['jev-no-such-binary'] }), { name: 'SandboxInfrastructureError' });
});
