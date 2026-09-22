import assert from 'node:assert/strict';
import { test } from 'node:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { SessionManager } from '@earendil-works/pi-coding-agent';
import { patchSource, patchPackage, installRoots, MARKER, PRIOR_MARKERS } from './patch-pi-coding-agent-compaction-lifecycle.mjs';

const dist = dirname(fileURLToPath(import.meta.resolve('@earendil-works/pi-coding-agent')));
const original = readFileSync(join(dist, 'core/agent-session.js'), 'utf8');
const patched = patchSource(original);
const fixture = join(dist, `core/.compaction-lifecycle-test-${process.pid}.mjs`);
let AgentSession;
try {
  writeFileSync(fixture, patched);
  ({ AgentSession } = await import(pathToFileURL(fixture).href));
} finally {
  // A failed import must not leave generated modules inside the installed package.
  if (existsSync(fixture)) unlinkSync(fixture);
}

function deferred() {
  let resolve;
  const promise = new Promise(r => resolve = r);
  return { promise, resolve };
}
function session() {
  const sm = SessionManager.inMemory();
  sm.appendMessage({ role: 'user', content: 'Earlier work. '.repeat(2000), timestamp: 1 });
  sm.appendMessage({ role: 'assistant', content: [{ type: 'text', text: 'Progress, not a final answer.' }], stopReason: 'stop', timestamp: 2 });
  sm.appendMessage({ role: 'user', content: 'Finish the task. '.repeat(2000), timestamp: 3 });
  const s = Object.create(AgentSession.prototype);
  const events = [];
  Object.assign(s, {
    _isAgentRunActive: false, _eventListeners: [e => events.push(e)],
    agent: { state: { model: { id: 'scripted', contextWindow: 272000 }, messages: sm.buildSessionContext().messages }, abort() {}, hasQueuedMessages: () => false },
    sessionManager: sm,
    settingsManager: { getCompactionSettings: () => ({ enabled: true, keepRecentTokens: 100, reserveTokens: 16384 }) },
    _extensionRunner: { hasHandlers: () => false, emit: async () => undefined },
    _getSummarizationRequestAuth: async model => ({ model }),
    abortRetry() {},
    _runDefaultCompaction: async prep => ({ summary: 'Summary', firstKeptEntryId: prep.firstKeptEntryId, tokensBefore: prep.tokensBefore }),
    _pendingCustomMessages: [],
  });
  return { s, sm, events };
}

test('source patch parses and is idempotent; unknown source fails', () => {
  assert.ok(patched.includes(MARKER));
  assert.equal(patchSource(patched), patched);
  assert.throws(() => patchSource('export class Other {}'), /Unsupported/);
  const runner = readFileSync(join(dist, 'core/extensions/runner.js'), 'utf8');
  assert.ok(patchSource(runner).includes('requestCompactionFn'));
});

test('overlapping manual calls share one promise, conflicting calls fail busy', async () => {
  const { s, sm } = session();
  const started = deferred(), finish = deferred(); let count = 0;
  s._runDefaultCompaction = async prep => { count++; started.resolve(); await finish.promise; return { summary: 'One summary', firstKeptEntryId: prep.firstKeptEntryId, tokensBefore: prep.tokensBefore }; };
  const a = s.compact('same'); await started.promise;
  const b = s.compact('same');
  assert.equal(a, b);
  await assert.rejects(s.compact('different'), /already in progress/);
  assert.equal(await s._runAutoCompaction('threshold', false), false);
  finish.resolve(); await Promise.all([a, b]);
  assert.equal(count, 1);
  assert.equal(sm.getBranch().filter(e => e.type === 'compaction').length, 1);
  assert.equal(s.isCompacting, false);
});

test('between-turn request keeps the run active and emits no completion until real end', async () => {
  const { s, events } = session();
  s._isAgentRunActive = true;
  s.abort = async () => assert.fail('Requested compaction must not abort the run');
  let completed = 0;
  s.requestCompaction({ onComplete: () => completed++ });
  s.requestCompaction({ onComplete: () => completed++ });
  const next = await s._compactBeforeNextAssistantResponse({ messages: s.messages });
  assert.equal(completed, 2);
  assert.equal(s.isStreaming, true);
  assert.equal(next.messages[0].role, 'compactionSummary');
  assert.equal(events.filter(e => e.type === 'agent_settled').length, 0);
  await s._emitAgentSettled();
  assert.equal(events.filter(e => e.type === 'agent_settled').length, 1);
});

test('observer exception cannot turn committed success into failure', async () => {
  const { s, sm, events } = session();
  s._eventListeners.push(e => { if (e.type === 'compaction_end' && e.result) throw new Error('Observer failed'); });
  await assert.doesNotReject(s.compact());
  assert.equal(sm.getBranch().filter(e => e.type === 'compaction').length, 1);
  assert.equal(events.filter(e => e.type === 'compaction_end').length, 1, 'no second failure end event after commit');
});

test('public settled must not fire if an extension listener starts another run', async () => {
  const { s, events } = session();
  s._extensionRunner.emit = async e => { if (e.type === 'agent_settled') s._isAgentRunActive = true; };
  await s._emitAgentSettled();
  assert.equal(events.filter(e => e.type === 'agent_settled').length, 0, 'published settled while streaming');
});

test('a queued request whose run ends early settles without model work and without an orphan lock', async () => {
  const { s, events } = session();
  s._isAgentRunActive = true;
  let outcome;
  s._runDefaultCompaction = async () => assert.fail('settling a queued request must not summarize');
  s.requestCompaction({ onComplete: () => outcome = 'complete', onError: e => outcome = e.message });
  await s._emitAgentSettled(); // the run ended before the between-turn safe point
  assert.match(outcome, /run ended before compaction/i);
  assert.equal(s.isCompacting, false, 'no orphan lock');
  assert.equal(s._requestedCompaction, undefined);
  assert.equal(events.filter(e => e.type === 'agent_settled').length, 1, 'settlement is not lost');
});

test('post-commit notification trouble cannot hold the operation or turn committed success into failure', async () => {
  const { s, sm, events } = session();
  const hookStarted = deferred(), releaseHook = deferred();
  const emitted = [];
  s._extensionRunner = {
    hasHandlers: type => type === 'session_compact',
    emit: async event => { emitted.push(event.type); if (event.type === 'session_compact') { hookStarted.resolve(); await releaseHook.promise; } },
  };
  let callback;
  s._isAgentRunActive = true;
  s.requestCompaction({ timeoutMs: 20, onComplete: () => callback = 'complete', onError: e => callback = e.message });
  const next = await s._compactBeforeNextAssistantResponse({ messages: s.messages });
  await hookStarted.promise;
  assert.equal(callback, 'complete', 'the request completes at the commit, not at the notification');
  assert.equal(s.isCompacting, false, 'a stalled post-commit listener cannot keep the operation compacting');
  assert.equal(next.messages[0].role, 'compactionSummary');
  await new Promise(r => setTimeout(r, 60)); // well past the 20 ms deadline
  assert.equal(callback, 'complete', 'the deadline cannot fire after completion');
  assert.equal(s.isCompacting, false);
  s.abortCompaction(); // cancellation after commit is a no-op
  assert.equal(callback, 'complete');
  assert.equal(sm.getBranch().filter(e => e.type === 'compaction').length, 1, 'committed success is preserved');
  assert.equal(events.filter(e => e.type === 'compaction_end').length, 1);
  assert.equal(events.filter(e => e.type === 'compaction_end')[0].aborted, false);
  releaseHook.resolve(); await new Promise(r => setImmediate(r));
  assert.deepEqual(emitted, ['session_compact']);
  assert.equal(callback, 'complete');
});

test('deadline releases the operation and late results cannot replace history', async () => {
  const { s, sm, events } = session();
  const finish = deferred();
  s._runDefaultCompaction = async prep => { await finish.promise; return { summary: 'Late result', firstKeptEntryId: prep.firstKeptEntryId, tokensBefore: prep.tokensBefore }; };
  const before = s.messages;
  await assert.rejects(s._compactSession('manual', false, undefined, { withinRun: true, timeoutMs: 20 }), /timed out/);
  assert.equal(s.isCompacting, false);
  assert.equal(s.messages, before);
  finish.resolve(); await new Promise(r => setImmediate(r));
  assert.equal(sm.getBranch().filter(e => e.type === 'compaction').length, 0);
  assert.equal(events.filter(e => e.type === 'compaction_end').length, 1);
});

test('late completion cannot clear a newer operation or commit its old result', async () => {
  const { s, sm } = session();
  const oldFinish = deferred(), newStarted = deferred(), newFinish = deferred(); let calls = 0;
  s._runDefaultCompaction = async prep => {
    const old = calls++ === 0;
    if (!old) newStarted.resolve();
    await (old ? oldFinish.promise : newFinish.promise);
    return { summary: old ? 'stale' : 'current', firstKeptEntryId: prep.firstKeptEntryId, tokensBefore: prep.tokensBefore };
  };
  await assert.rejects(s._compactSession('manual', false, undefined, { withinRun: true, timeoutMs: 20 }), /timed out/);
  const current = s.compact(); await newStarted.promise;
  oldFinish.resolve(); await new Promise(r => setImmediate(r));
  assert.equal(s.isCompacting, true, 'late cleanup must not release the new operation');
  newFinish.resolve(); await current;
  assert.deepEqual(sm.getBranch().filter(e => e.type === 'compaction').map(e => e.summary), ['current']);
});

test('changing conversation history while summarizing preserves the new history and rejects the old snapshot', async () => {
  const { s, sm } = session(); const started = deferred(), finish = deferred();
  s._runDefaultCompaction = async prep => {
    started.resolve(); await finish.promise;
    return { summary: 'outdated', firstKeptEntryId: prep.firstKeptEntryId, tokensBefore: prep.tokensBefore };
  };
  const pending = s.compact(); await started.promise;
  sm.appendMessage({ role: 'user', content: 'A new requirement.', timestamp: Date.now() });
  finish.resolve(); await assert.rejects(pending, /history changed/);
  assert.equal(sm.getBranch().filter(e => e.type === 'compaction').length, 0);
  assert.equal(sm.getLeafEntry().message.content, 'A new requirement.');
});

test('a hook failure keeps its cause and stays distinct from an explicit cancellation', async () => {
  const { s, events } = session();
  s._extensionRunner = { hasHandlers: t => t === 'session_before_compact', emit: async e => e.type === 'session_before_compact' ? { cancel: true, error: new Error('Provider credits exhausted') } : undefined };
  await assert.rejects(s._compactSession('manual', false, undefined, { withinRun: true }), /credits exhausted/);
  assert.equal(events.filter(e => e.type === 'compaction_end')[0].aborted, false, 'a failure is not a cancellation');

  const { s: s2, events: events2 } = session();
  s2._extensionRunner = { hasHandlers: t => t === 'session_before_compact', emit: async e => e.type === 'session_before_compact' ? { cancel: true } : undefined };
  await assert.rejects(s2._compactSession('manual', false, undefined, { withinRun: true }), /Compaction cancelled/);
  assert.equal(events2.filter(e => e.type === 'compaction_end')[0].aborted, true, 'explicit cancellation stays distinct');
});

test('callback errors do not change committed success into a failure or prevent other callbacks', async () => {
  const { s } = session(); s._isAgentRunActive = true;
  let notified = 0, callbackErrors = 0;
  s._extensionRunner.emitError = () => callbackErrors++;
  s.requestCompaction({ onComplete() { throw new Error('Broken UI callback'); }, onError() { assert.fail('Success was changed into failure'); } });
  s.requestCompaction({ onComplete() { notified++; } });
  await s._compactBeforeNextAssistantResponse({ messages: s.messages });
  assert.equal(notified, 1); assert.equal(callbackErrors, 1);
});

test('cancellation of a pending request never starts the summarizer', async () => {
  const { s } = session(); s._isAgentRunActive = true;
  let failed = 0;
  s._runDefaultCompaction = async () => assert.fail('Cancelled request ran');
  s.requestCompaction({ onError: e => { assert.match(e.message, /cancelled/); failed++; } });
  s.abortCompaction();
  assert.equal(failed, 1);
  assert.equal(s.isCompacting, false);
  assert.equal(s._requestedCompaction, undefined);
});

test('native between-turn compaction also respects cancellation before returning to the model', async () => {
  const { s } = session(); const controller = new AbortController();
  const started = deferred(), finish = deferred();
  s.agent.signal = controller.signal; s.agent.state.tools = []; s.agent.state.model.contextWindow = 1000;
  s._runDefaultCompaction = async prep => { started.resolve(); await finish.promise; return { summary: 'Late', firstKeptEntryId: prep.firstKeptEntryId, tokensBefore: prep.tokensBefore }; };
  s._installAgentNextTurnRefresh();
  const next = s.agent.prepareNextTurnWithContext({ context: { messages: s.messages } });
  await started.promise; controller.abort(); s.abortCompaction();
  await assert.rejects(next, { name: 'AbortError' });
  finish.resolve();
});

test('manual abort does not publish settlement until compaction ends, or repeat it later', async () => {
  const { s, events } = session(); const started = deferred(), finish = deferred();
  s._isAgentRunActive = true;
  s.agent.abort = () => { queueMicrotask(() => s._emitAgentSettled()); };
  s._runDefaultCompaction = async prep => { started.resolve(); await finish.promise; return { summary: 'Manual', firstKeptEntryId: prep.firstKeptEntryId, tokensBefore: prep.tokensBefore }; };
  const compact = s.compact(); await started.promise;
  assert.equal(events.filter(e => e.type === 'agent_settled').length, 0);
  finish.resolve(); await compact;
  assert.equal(events.filter(e => e.type === 'agent_settled').length, 1);
  s.agent.abort = () => {};
  await assert.rejects(s.compact(), /Nothing to compact/);
  assert.equal(events.filter(e => e.type === 'agent_settled').length, 1);
});

test('task abort cancels an in-flight request even when the summarizer ignores its signal', async () => {
  const { s, sm } = session(); const controller = new AbortController();
  s.agent.signal = controller.signal;
  s._isAgentRunActive = true;
  const started = deferred(), finish = deferred(); let failure;
  s._runDefaultCompaction = async prep => { started.resolve(); await finish.promise; return { summary: 'Cancelled', firstKeptEntryId: prep.firstKeptEntryId, tokensBefore: prep.tokensBefore }; };
  s.requestCompaction({ onError: error => failure = error });
  const next = s._compactBeforeNextAssistantResponse({ messages: s.messages });
  await started.promise; controller.abort(); await assert.rejects(next, { name: 'AbortError' });
  assert.equal(failure.name, 'AbortError');
  finish.resolve(); await new Promise(r => setImmediate(r));
  assert.equal(sm.getBranch().filter(e => e.type === 'compaction').length, 0);
});

// ---------------------------------------------------------------- installer

/** A prior-revision install: same inline edits, old marker (genuine V1 files when the installed copy still is one). */
function priorRevision(source) {
  const genuine = PRIOR_MARKERS.find(m => source.includes(m));
  if (genuine) return source;
  return patchSource(source).replace(`// ${MARKER}`, `// ${PRIOR_MARKERS[0]}`);
}

function installRoot() {
  const root = mkdtempSync(join(tmpdir(), 'patch-upgrade-'));
  writeFileSync(join(root, 'package.json'), JSON.stringify({ version: '0.84.4' }));
  mkdirSync(join(root, 'dist/core/extensions'), { recursive: true });
  mkdirSync(join(root, 'dist/bundle'), { recursive: true });
  return root;
}

test('throwing settled subscriber cannot reject a committed compaction', async () => {
 const {s, sm, events} = session();
 s._settleOwed = {};
 s._eventListeners.push(e => { if (e.type === 'agent_settled') throw new Error('Settled observer failed'); });
 await assert.doesNotReject(s.compact());
 assert.equal(sm.getBranch().filter(e => e.type === 'compaction').length, 1);
 assert.equal(events.filter(e => e.type === 'compaction_end').length, 1);
});

test('reentrant settlement cannot publish before the original async handlers finish or publish twice', async () => {
 const {s, events} = session();
 const started = deferred(), finish = deferred(); let count = 0;
 s._extensionRunner.emit = async e => { if (e.type === 'agent_settled') { count++; started.resolve(); await finish.promise; } };
 const first = s._emitAgentSettled();
 await started.promise;
 await s._emitAgentSettled();
 const premature = events.filter(e => e.type === 'agent_settled').length;
 finish.resolve(); await first;
 assert.equal(count, 1);
 assert.equal(premature, 0, 'public settlement bypassed a still-running extension handler');
 assert.equal(events.filter(e => e.type === 'agent_settled').length, 1);
});

test('throwing start subscriber cannot orphan a compaction operation', async () => {
 const {s} = session();
 s._eventListeners.push(e => { if (e.type === 'compaction_start') throw new Error('Start observer failed'); });
 try { await assert.doesNotReject(s._compactSession('manual', false, undefined, {timeoutMs: 20})); assert.equal(s.isCompacting, false); }
 finally { clearTimeout(s._compactionOperation?.timer); s.abortCompaction(); }
});

test('a prior-revision install upgrades in place on SDK and bundle; the current revision is idempotent', () => {
  const root = installRoot();
  try {
    const found = [];
    const walk = dir => { for (const e of readdirSync(dir, { withFileTypes: true })) { const f = join(dir, e.name); if (e.isDirectory()) walk(f); else if (e.name.endsWith('.js')) { const s = readFileSync(f, 'utf8'); if (s.includes('_compactBeforeNextAssistantResponse') || (s.includes('compactFn') && s.includes('createContext'))) found.push(f); } } };
    walk(join(dist, 'bundle'));
    const bundle = found[0];
    assert.ok(bundle, 'a real CLI bundle copy must exercise the bundle walker');
    const targets = {
      'dist/core/agent-session.js': priorRevision(readFileSync(join(dist, 'core/agent-session.js'), 'utf8')),
      'dist/core/extensions/runner.js': priorRevision(readFileSync(join(dist, 'core/extensions/runner.js'), 'utf8')),
      [`dist/bundle/${bundle.split('/').pop()}`]: priorRevision(readFileSync(bundle, 'utf8')),
    };
    for (const [rel, source] of Object.entries(targets)) writeFileSync(join(root, rel), source);
    assert.equal(patchPackage(root).patched, 3, 'stale prior-revision files must be rewritten, not silently skipped');
    for (const rel of Object.keys(targets)) {
      const source = readFileSync(join(root, rel), 'utf8');
      assert.ok(source.includes(MARKER));
      assert.ok(!PRIOR_MARKERS.some(m => source.includes(m)), `${rel}: prior marker must be gone`);
      const drains = source.split('if (this._requestedCompaction) { const signal').length - 1;
      assert.equal(drains, source.includes('_compactBeforeNextAssistantResponse') ? 1 : 0, `${rel}: exactly one inline request-drain block per session class`);
      assert.equal((source.match(/this\.requestCompactionFn =/g) ?? []).length, source.includes('compactFn') ? 1 : 0, `${rel}: the prior bindCore assignment must not survive upgrades`);
    }
    const stable = Object.fromEntries(Object.keys(targets).map(rel => [rel, readFileSync(join(root, rel), 'utf8')]));
    assert.equal(patchPackage(root).patched, 0, 'the current revision is idempotent');
    for (const rel of Object.keys(targets)) assert.equal(readFileSync(join(root, rel), 'utf8'), stable[rel]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('unknown versions and shapes fail clearly without partially rewriting a package', () => {
  const root = mkdtempSync(join(tmpdir(), 'patch-unknown-'));
  try {
    writeFileSync(join(root, 'package.json'), JSON.stringify({ version: '0.9.9' }));
    mkdirSync(join(root, 'dist/core/extensions'), { recursive: true });
    writeFileSync(join(root, 'dist/core/agent-session.js'), 'export class AgentSession {}');
    writeFileSync(join(root, 'dist/core/extensions/runner.js'), 'export class ExtensionRunner {}');
    assert.throws(() => patchPackage(root), /Unsupported Pi 0\.9\.9/);

    writeFileSync(join(root, 'package.json'), JSON.stringify({ version: '0.84.4' }));
    const good = readFileSync(join(dist, 'core/agent-session.js'), 'utf8');
    writeFileSync(join(root, 'dist/core/agent-session.js'), good);
    writeFileSync(join(root, 'dist/core/extensions/runner.js'), 'export class Other {}');
    assert.throws(() => patchPackage(root), /Unsupported/);
    assert.equal(readFileSync(join(root, 'dist/core/agent-session.js'), 'utf8'), good, 'no partial rewrite when one target fails validation');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('installRoots honors PI_AI_PATCH_ROOTS like the neighboring patches, and --root targets one package', () => {
  const roots = installRoots([], { PI_AI_PATCH_ROOTS: '/extra/a:/extra/b' });
  assert.ok(roots.includes('/extra/a/@earendil-works/pi-coding-agent') && roots.includes('/extra/b/@earendil-works/pi-coding-agent'), 'extras are node_modules roots, package appended');
  assert.ok(roots.some(r => r.endsWith('node_modules/@earendil-works/pi-coding-agent')));
  assert.deepEqual(installRoots(['--root', '/only'], { PI_AI_PATCH_ROOTS: '/extra/a' }), [resolve('/only')]);
  assert.ok(!installRoots([], {}).includes('/extra/a/@earendil-works/pi-coding-agent'));
});

test('extra roots have the same node_modules-root meaning as sibling patches', () => {
  const roots = installRoots([], { PI_AI_PATCH_ROOTS: '/tmp/extra-node-modules' });
  assert.ok(roots.includes('/tmp/extra-node-modules/@earendil-works/pi-coding-agent'));
});

test('a pristine minimal source at the required shape patches cleanly and stays idempotent', () => {
  const pristineSession = `
export class AgentSession {
  async _compactBeforeNextAssistantResponse(context) {
    const model = this.model;
    return context;
  }
  _installAgentNextTurnRefresh() {
    this.agent.prepareNextTurnWithContext = async (turn, signal) => {
      const context = await this._compactBeforeNextAssistantResponse(turn.context);
      return { context };
    };
  }
  _bindExtensionCore() {
    return { compact: (instructions) => this.compactFn(instructions) };
  }
  async prompt(text, options) {
    if (this._compactionAbortController) { throw new Error('busy'); }
    return text;
  }
  compact(customInstructions) {
    prepareCompaction([], {});
    return estimateMessagesTokens([]);
  }
  async _runAutoCompaction(reason, willRetry) { return false; }
  abortCompaction() {}
  async abort() {}
  get isCompacting() { return !!this._compactionAbortController; }
  async _emitAgentSettled() {}
}`;
  const pristineRunner = `
export class ExtensionRunner {
  bindCore(session, actions) { this.compactFn = actions.compact; }
  createContext() {
    const runner = this;
    return { compact: (instructions) => runner.compactFn(instructions) };
  }
}`;
  for (const source of [pristineSession, pristineRunner]) {
    const result = patchSource(source);
    assert.ok(result.includes(MARKER));
    assert.equal(patchSource(result), result);
  }
  assert.ok(patchSource(pristineSession).includes('this.isCompacting && !this.isStreaming'), 'the prompt guard is rewritten');
  assert.ok(patchSource(pristineSession).includes('requestCompaction(options = {})'));
  assert.ok(patchSource(pristineRunner).includes('requestCompactionFn'));
});
