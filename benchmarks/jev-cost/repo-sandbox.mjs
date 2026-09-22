import { spawn } from 'node:child_process';
import { randomUUID, createHash } from 'node:crypto';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Import is inert. Run `node benchmarks/jev-cost/repo-sandbox.mjs setup` once.
// status is the command's integer exit code, or null on timeout/signal.
// Input errors are TypeErrors; Docker/setup/protocol errors are SandboxInfrastructureErrors.
// stdout/stderr retain runner summaries (each capped at 1 MiB). Use an explicit
// --test-reporter=tap for stable Node counts; reject absent/zero summaries.
// protectedFilesUnchanged checks final content, not transient edits restored by
// the candidate. It is false on timeout. This is not proof that tests were run.
export const IMAGE = 'jev-repo-sandbox:offline-v1';
const SCRATCH = '/tmp/jev-repo-sandbox-build';
const ALPINE = 'node@sha256:c610fcdfb1d5b4740dd70c284ed3cb16bb857e0f7166196e36a5501df7a3aa32';
const LIMIT = 1024 * 1024;
const ROOTS = {
  'mical-pi': '/home/michael/coding/mical-pi/node_modules',
  foosheq: '/home/michael/coding/personal-website/apps/foosheq/node_modules',
};
const SEEDS = {
  'mical-pi': ['tsx', 'effect', 'acorn', '@earendil-works/pi-coding-agent'],
  foosheq: ['vitest', 'vite', 'react', 'react-dom'],
};
export class SandboxInfrastructureError extends Error {
  constructor(message, options) { super(message, options); this.name = 'SandboxInfrastructureError'; }
}

// This function is also embedded in the image. Validate before making any files.
function validate({ repo, files, command, timeoutMs = 60000, protectedPaths = [] }) {
  if (!['mical-pi', 'foosheq'].includes(repo)) throw new TypeError('Unknown repo');
  if (!files || typeof files !== 'object' || Array.isArray(files)) throw new TypeError('files must be a record');
  let bytes = 0;
  for (const [name, content] of Object.entries(files)) {
    const parts = name.split('/');
    if (!name || name.includes('\\') || name.includes('\0') || /^[A-Za-z]:/.test(name)
      || parts.some(p => !p || p === '.' || p === '..' || p === 'node_modules' || p === '.git')) {
      throw new TypeError(`Unsafe file path: ${name}`);
    }
    if (typeof content !== 'string') throw new TypeError('File contents must be strings');
    bytes += Buffer.byteLength(name) + Buffer.byteLength(content);
  }
  if (!Array.isArray(protectedPaths) || protectedPaths.some(name => typeof name !== 'string' || !Object.hasOwn(files, name))) {
    throw new TypeError('protectedPaths must name supplied files');
  }
  if (bytes > 32 * 1024 * 1024 || Object.keys(files).length > 10000) throw new TypeError('Files exceed input limit');
  if (!Array.isArray(command) || !command.length || command.some(x => typeof x !== 'string' || !x || x.includes('\0'))
    || Buffer.byteLength(JSON.stringify(command)) > 1024 * 1024) throw new TypeError('command must be a nonempty argv array');
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 600000) throw new TypeError('timeoutMs must be 1..600000');
}

async function bootstrap() {
  const emit = event => process.stdout.write(JSON.stringify(event) + '\n');
  try {
    let input = '';
    process.stdin.setEncoding('utf8');
    for await (const chunk of process.stdin) {
      input += chunk;
      if (Buffer.byteLength(input) > 256 * 1024 * 1024) throw new Error('Input too large');
    }
    const request = JSON.parse(input);
    validate(request);
    for (const [name, content] of Object.entries(request.files)) {
      await fs.mkdir(path.dirname('/work/' + name), { recursive: true });
      await fs.writeFile('/work/' + name, content, { flag: 'wx', mode: 0o600 });
    }
    for (const name of ['vitest', 'vite', 'vite-temp']) await fs.mkdir('/tmp/' + name, { recursive: true });
    await fs.symlink(`/deps/${request.repo}/node_modules`, '/work/node_modules');
    const hashProtected = async () => Promise.all((request.protectedPaths ?? []).map(async name => {
      try {
        const filename = '/work/' + name;
        if (!(await fs.lstat(filename)).isFile()) return null;
        return createHash('sha256').update(await fs.readFile(filename)).digest('hex');
      } catch { return null; }
    }));
    const before = await hashProtected();
    const child = spawn(request.command[0], request.command.slice(1), {
      cwd: '/work', env: { PATH: '/work/node_modules/.bin:/usr/local/bin:/usr/bin:/bin', TZ: 'UTC' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    for (const stream of ['stdout', 'stderr']) {
      let size = 0;
      child[stream].on('data', chunk => {
        const kept = chunk.subarray(0, Math.max(0, 1048576 - size));
        size += kept.length;
        if (kept.length) emit({ stream, data: kept.toString('base64') });
      });
    }
    child.on('error', error => emit({ error: `Command could not start: ${error.message}` }));
    child.on('close', async (status, signal) => {
      const after = await hashProtected();
      const protectedFilesUnchanged = before.every((hash, index) => hash !== null && hash === after[index]);
      emit({ status, signal, protectedFilesUnchanged });
      process.stdout.end(() => process.exit(0));
    });
  } catch (error) { emit({ error: error.message }); process.exitCode = 1; }
}

function docker(args, { input, timeout = 30000, onLine } = {}) {
  return new Promise((resolve, reject) => {
    // No shell and no candidate-controlled Docker arguments or environment.
    const child = spawn('docker', args, { stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '', stderr = '', pending = '', overflow = false;
    const timer = setTimeout(() => { child.kill('SIGKILL'); }, timeout);
    child.stdout.on('data', chunk => {
      if (onLine) {
        pending += chunk.toString('utf8');
        let end;
        while ((end = pending.indexOf('\n')) !== -1) {
          onLine(pending.slice(0, end)); pending = pending.slice(end + 1);
        }
        if (pending.length > 2 * LIMIT) { overflow = true; child.kill('SIGKILL'); }
      } else if (stdout.length < 4 * LIMIT) stdout += chunk.toString('utf8');
    });
    child.stderr.on('data', chunk => { if (stderr.length < LIMIT) stderr += chunk.toString('utf8'); });
    child.stdin.on('error', () => {}); // EPIPE is diagnosed by Docker's exit status.
    child.on('error', error => { clearTimeout(timer); reject(new SandboxInfrastructureError(`Docker unavailable: ${error.message}`)); });
    child.on('close', (code, signal) => {
      clearTimeout(timer);
      if (signal || overflow) reject(new SandboxInfrastructureError(`Docker command interrupted (${signal ?? 'output overflow'})`));
      else resolve({ code, stdout, stderr });
    });
    child.stdin.end(input);
  });
}
async function checked(args, options) {
  const result = await docker(args, options);
  if (result.code !== 0) throw new SandboxInfrastructureError(`docker ${args[0]} failed: ${result.stderr.trim()}`);
  return result.stdout;
}

export async function execute({ repo, files, command, timeoutMs = 60000, protectedPaths = [] }) {
  validate({ repo, files, command, timeoutMs, protectedPaths });
  const started = performance.now();
  const image = JSON.parse(await checked(['image', 'inspect', IMAGE]))[0];
  if (image.Config.Labels?.['jev.repo-sandbox'] !== '1') throw new SandboxInfrastructureError('Run repo-sandbox.mjs setup first');
  const name = 'jev-repo-' + randomUUID();
  const output = { stdout: [], stderr: [] };
  const sizes = { stdout: 0, stderr: 0 };
  let result, protocolError, timedOut = false, timer, removal;
  const remove = () => removal ??= checked(['rm', '--force', name]);
  try {
    await checked(['create', '--name', name, '--pull', 'never', '--network', 'none', '--read-only',
      '--user', '65534:65534', '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges',
      '--pids-limit', '128', '--memory', '1g', '--memory-swap', '1g', '--cpus', '2',
      '--ulimit', 'nofile=1024:1024', '--log-driver', 'none', '--ipc', 'private',
      '--tmpfs', '/work:rw,nosuid,nodev,size=512m,uid=65534,gid=65534,mode=0700',
      '--tmpfs', '/tmp:rw,nosuid,nodev,noexec,size=64m,uid=65534,gid=65534,mode=0700',
      '--workdir', '/work', '--interactive', '--entrypoint', '/usr/local/bin/node', image.Id, '--disable-sigusr1', '/bootstrap.mjs']);
    timer = setTimeout(() => { timedOut = true; void remove().catch(() => {}); }, Math.max(1, timeoutMs - (performance.now() - started)));
    const run = await docker(['start', '--attach', '--interactive', name], {
      input: JSON.stringify({ repo, files, command, timeoutMs, protectedPaths }), timeout: timeoutMs + 35000,
      onLine(line) {
        try {
          const event = JSON.parse(line);
          if (event.error) protocolError = String(event.error);
          else if (event.stream === 'stdout' || event.stream === 'stderr') {
            const data = Buffer.from(event.data, 'base64').subarray(0, LIMIT - sizes[event.stream]);
            if (data.length) output[event.stream].push(data);
            sizes[event.stream] += data.length;
          } else if (event.status === null || Number.isInteger(event.status)) result = event;
          else protocolError = 'Invalid bootstrap event';
        } catch { protocolError = 'Invalid bootstrap output'; }
      },
    });
    if (!timedOut && (run.code !== 0 || protocolError || !result)) {
      throw new SandboxInfrastructureError(protocolError || run.stderr || 'Sandbox exited without a command result (possibly OOM)');
    }
  } finally {
    clearTimeout(timer);
    // Force removal also kills detached descendants after successful commands.
    await remove();
  }
  const stdout = boundedText(output.stdout);
  return {
    status: timedOut ? null : result.status,
    stdout, stderr: boundedText(output.stderr),
    testSummary: summarizeTests(stdout),
    timedOut, durationMs: Math.round(performance.now() - started),
    protectedFilesUnchanged: !timedOut && result.protectedFilesUnchanged === true,
  };
}

// Convenience only: summaries are command output, not trusted attestations.
// null means no recognized complete summary (including truncated output).
function summarizeTests(stdout) {
  const clean = stdout.replace(/\x1b\[[0-9;]*m/g, '');
  const nodeCount = name => clean.match(new RegExp(`^(?:#|ℹ) ${name} (\\d+)\\s*$`, 'm'));
  const counts = ['tests', 'pass', 'fail', 'skipped', 'cancelled'].map(nodeCount);
  if (counts.every(Boolean)) {
    const [tests, passed, failed, skipped, cancelled] = counts.map(match => Number(match[1]));
    return { tests, passed, failed, skipped, cancelled };
  }
  const vitest = clean.match(/^\s*Tests\s+([^\n]+)$/m)?.[1];
  if (!vitest) return null;
  const count = name => Number(vitest.match(new RegExp(`(\\d+) ${name}`))?.[1] ?? 0);
  const passed = count('passed'), failed = count('failed'), skipped = count('skipped') + count('todo');
  return { tests: passed + failed + skipped, passed, failed, skipped, cancelled: 0 };
}

function boundedText(chunks) {
  const text = Buffer.concat(chunks).toString('utf8');
  // Invalid UTF-8 expands to replacement characters; cap the returned text too.
  return Buffer.byteLength(text) <= LIMIT ? text : Buffer.from(text).subarray(0, LIMIT - 3).toString('utf8');
}

const inside = (root, target) => target === root || target.startsWith(root + path.sep);

// Only installed package data is copied. Symlinks are dereferenced only within
// the authorized node_modules tree; external links and special files fail closed.
async function snapshot(root, seeds, destination) {
  root = await fs.realpath(root);
  const packages = new Map();
  const omittedOptional = [];
  let bytes = 0;
  async function copy(source, target, ancestors = new Set()) {
    const real = await fs.realpath(source);
    if (!inside(root, real)) throw new Error(`Dependency symlink escapes node_modules: ${source} -> ${real}`);
    const stat = await fs.stat(real);
    if (stat.isDirectory()) {
      if (ancestors.has(real)) throw new Error(`Dependency symlink cycle: ${source}`);
      await fs.mkdir(target, { recursive: true, mode: 0o755 });
      for (const name of await fs.readdir(real)) {
        if (name === 'node_modules' || name === '.git' || name === '.npmrc' || name === '.env' || name.startsWith('.env.')) continue;
        await copy(path.join(real, name), path.join(target, name), new Set([...ancestors, real]));
      }
    } else if (stat.isFile()) {
      bytes += stat.size;
      if (bytes > 850 * 1024 * 1024) throw new Error('Dependency snapshot exceeds 850 MiB');
      await fs.copyFile(real, target);
      await fs.chmod(target, stat.mode & 0o111 ? 0o755 : 0o644);
    } else throw new Error(`Special dependency file: ${source}`);
  }
  async function locate(name, from) {
    if (!/^(?:@[\w.-]+\/)?[\w.-]+$/.test(name)) throw new Error(`Invalid dependency name: ${name}`);
    let cursor = from;
    while (inside(root, cursor)) {
      const candidate = path.join(cursor, cursor === root ? '' : 'node_modules', name);
      try { await fs.access(path.join(candidate, 'package.json')); return candidate; } catch {}
      cursor = path.dirname(cursor);
    }
    throw new Error(`Missing installed dependency ${name} required from ${from}`);
  }
  async function linkPackage(source, link) {
    const real = await fs.realpath(source);
    if (!inside(root, real)) throw new Error(`Package escapes authorized node_modules: ${source} -> ${real}`);
    let record = packages.get(real);
    if (!record) {
      const pkg = JSON.parse(await fs.readFile(path.join(real, 'package.json'), 'utf8'));
      const id = createHash('sha256').update(path.relative(root, real)).digest('hex').slice(0, 20);
      const target = path.join(destination, 'store', id);
      record = { name: pkg.name, version: pkg.version, source: path.relative(root, real), target, pkg };
      packages.set(real, record);
      await copy(real, target);
      const deps = { ...pkg.peerDependencies, ...pkg.dependencies, ...pkg.optionalDependencies };
      for (const name of Object.keys(deps)) {
        let found;
        try { found = await locate(name, real); }
        catch (error) {
          if (pkg.optionalDependencies?.[name] || (pkg.peerDependencies?.[name] && !pkg.dependencies?.[name])) {
            omittedOptional.push(`${pkg.name}: ${name}`); continue;
          }
          throw error;
        }
        await linkPackage(found, path.join(target, 'node_modules', name));
      }
    }
    await fs.mkdir(path.dirname(link), { recursive: true });
    try { await fs.symlink(path.relative(path.dirname(link), record.target), link); }
    catch (error) { if (error.code !== 'EEXIST') throw error; }
    // Local package executables are available without npm/npx or downloads.
    const bins = typeof record.pkg.bin === 'string' ? { [record.name.split('/').at(-1)]: record.pkg.bin } : record.pkg.bin ?? {};
    const modules = link.includes('/node_modules/@') ? path.dirname(path.dirname(link)) : path.dirname(link);
    for (const [name, executable] of Object.entries(bins)) {
      if (!/^[\w.-]+$/.test(name) || !inside(record.target, path.resolve(record.target, executable))) throw new Error('Unsafe package bin');
      const bin = path.join(modules, '.bin', name);
      await fs.mkdir(path.dirname(bin), { recursive: true });
      try { await fs.symlink(path.relative(path.dirname(bin), path.join(record.target, executable)), bin); }
      catch (error) { if (error.code !== 'EEXIST') throw error; }
    }
  }
  for (const name of seeds) await linkPackage(await locate(name, root), path.join(destination, 'node_modules', name));
  for (const name of ['vitest', 'vite', 'vite-temp']) {
    await fs.symlink('/tmp/' + name, path.join(destination, 'node_modules', '.' + name));
  }
  return { root, bytes, packages: [...packages.values()].map(({ name, version, source }) => ({ name, version, source })), omittedOptional };
}

export async function setup() {
  try { return await buildImage(); }
  catch (error) {
    if (error instanceof SandboxInfrastructureError) throw error;
    throw new SandboxInfrastructureError(`Offline setup failed: ${error.message}`, { cause: error });
  }
}

async function buildImage() {
  // Both authorized dependency trees include working musl native bindings.
  // Resolve the preexisting pinned Alpine digest locally; never pull/install.
  const base = JSON.parse(await checked(['image', 'inspect', ALPINE]))[0];
  const os = await checked(['run', '--rm', '--pull', 'never', '--network', 'none', '--read-only',
    '--user', '65534:65534', '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges',
    '--memory', '128m', '--pids-limit', '32', '--cpus', '2', base.Id,
    'node', '-p', 'JSON.stringify({node:process.version,glibc:process.report.getReport().header.glibcVersionRuntime})']);
  await fs.mkdir(SCRATCH, { recursive: true });
  const context = await fs.mkdtemp(path.join(SCRATCH, 'context-'));
  try {
    const provenance = { base: base.Id, baseReference: ALPINE, baseDigests: base.RepoDigests, runtime: JSON.parse(os), repos: {} };
    for (const [repo, root] of Object.entries(ROOTS)) {
      provenance.repos[repo] = await snapshot(root, SEEDS[repo], path.join(context, 'deps', repo));
    }
    await fs.writeFile(path.join(context, 'bootstrap.mjs'),
      `import {spawn} from 'node:child_process';\nimport {createHash} from 'node:crypto';\nimport * as fs from 'node:fs/promises';\nimport path from 'node:path';\n${validate.toString()}\n(${bootstrap.toString()})();\n`);
    await fs.writeFile(path.join(context, 'provenance.json'), JSON.stringify(provenance, null, 2));
    await fs.writeFile(path.join(context, 'Dockerfile'), `FROM ${base.Id}\nLABEL jev.repo-sandbox="1"\nCOPY deps /deps\nCOPY bootstrap.mjs provenance.json /\nUSER 65534:65534\nWORKDIR /work\nENTRYPOINT ["/usr/local/bin/node", "--disable-sigusr1", "/bootstrap.mjs"]\n`);
    await checked(['build', '--pull=false', '--network', 'none', '--tag', IMAGE, context], { timeout: 600000 });
    const image = JSON.parse(await checked(['image', 'inspect', IMAGE]))[0];
    const report = { image: IMAGE, id: image.Id, sizeBytes: image.Size, ...provenance };
    await fs.writeFile(path.join(SCRATCH, 'provenance.json'), JSON.stringify(report, null, 2));
    return report;
  } finally { await fs.rm(context, { recursive: true, force: true }); }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.argv[2] !== 'setup') { console.error('Usage: node repo-sandbox.mjs setup'); process.exitCode = 2; }
  else setup().then(report => console.log(JSON.stringify(report, null, 2))).catch(error => { console.error(error); process.exitCode = 1; });
}
