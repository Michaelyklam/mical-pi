import test from 'node:test';
import assert from 'node:assert/strict';
import { getCodexModel, runAgent } from './codex.mjs';

const model = {
  id: 'gpt-5.6-luna', provider: 'openai-codex', api: 'openai-codex-responses',
  baseUrl: 'https://chatgpt.com/backend-api/codex', maxTokens: 128000,
};
const tool = (name) => ({ name, description: name, parameters: {
  type: 'object', properties: { value: { type: 'string' } }, required: ['value'], additionalProperties: false,
} });
const call = (name = 'lookup', args = { value: 'x' }) => ({ type: 'toolCall', id: `call-${name}`, name, arguments: args });
const usage = {
  input: 10, output: 4, cacheRead: 6, cacheWrite: 2, totalTokens: 22, reasoning: 3,
  cost: { input: 0.1, output: 0.2, cacheRead: 0.03, cacheWrite: 0.04, total: 0.37 },
};
const assistant = (content = [{ type: 'text', text: 'done' }], stopReason = 'stop') => ({
  role: 'assistant', api: model.api, provider: model.provider, model: model.id,
  content, usage: structuredClone(usage), stopReason, timestamp: Date.now(),
});
function setup(complete = async () => assistant()) {
  const requests = [];
  const runtime = {
    getModel(provider, id) { return provider === model.provider && id === model.id ? model : undefined; },
    isUsingOAuth(provider) { return provider === model.provider; },
    async completeSimple(selected, context, options) {
      requests.push({ selected, context: structuredClone(context), options });
      return complete(selected, context, options);
    },
  };
  return { runtime, requests, options: { modelId: model.id, model, runtime, systemPrompt: 'System', prompt: 'Question' } };
}

test('local model accessor refuses other providers, IDs, and endpoints', async () => {
  const { runtime } = setup();
  assert.equal(await getCodexModel(model.id, runtime), model);
  await assert.rejects(getCodexModel('openrouter/gpt-5.6-luna', runtime));
  await assert.rejects(getCodexModel('gpt-6-astra', runtime));
  for (const changed of [{ provider: 'openrouter' }, { baseUrl: 'https://openrouter.ai/api/v1' }]) {
    await assert.rejects(getCodexModel(model.id, { getModel: () => ({ ...model, ...changed }) }));
  }
});

test('OAuth-only guard refuses before making a completion', async () => {
  const { options, runtime, requests } = setup();
  runtime.isUsingOAuth = () => false;
  await assert.rejects(runAgent(options), (error) => error.result.stopReason === 'error');
  assert.equal(requests.length, 0);
});

test('hooks surround completion; full model output allowance is reserved without a false cap', async () => {
  const events = [];
  const { options, requests } = setup(async () => { events.push('complete'); return assistant(); });
  const result = await runAgent({ ...options, sessionId: 'offline',
    onBeforeCall({ model: selected, context, maxOutputTokens }) {
      events.push('before');
      assert.equal(selected, model);
      assert.equal(maxOutputTokens, 128000);
      assert.equal(context.messages[0].content, 'Question');
    },
    onAfterCall({ message, durationMs }) {
      events.push('after');
      assert.equal(message.stopReason, 'stop');
      assert.ok(durationMs >= 0);
    },
  });
  assert.deepEqual(events, ['before', 'complete', 'after']);
  assert.equal(result.answer, 'done');
  assert.equal(result.turns, 1);
  assert.equal(result.stopReason, 'stop');
  assert.equal(result.usage.cacheRead, 6);
  assert.equal(result.usage.reasoning, 3);
  assert.equal(result.usage.cost.total, 0.37);
  assert.match(result.usage.costBasis, /API equivalent, not actual charge/);
  const sent = requests[0].options;
  assert.equal(sent.maxRetries, 0);
  assert.equal(sent.transport, 'sse');
  assert.equal(sent.reasoning, 'medium');
  assert.equal(sent.sessionId, 'offline');
  assert.ok(sent.timeoutMs > 0 && sent.timeoutMs <= 120000);
  assert.ok(sent.signal instanceof AbortSignal);
  assert.equal('maxTokens' in sent, false);
});

test('turn cap counts model calls and preserves valid tool results', async () => {
  const { options, requests } = setup(async () => assistant([call()], 'toolUse'));
  const result = await runAgent({ ...options, maxTurns: 2, tools: [tool('lookup')], executeTool: async () => 'found' });
  assert.equal(result.stopReason, 'maxTurns');
  assert.equal(result.answer, '');
  assert.equal(requests.length, 2);
  assert.equal(result.turns, 2);
  assert.equal(result.usage.output, 8);
  const results = result.messages.filter((message) => message.role === 'toolResult');
  assert.equal(results.length, 2);
  assert.equal(results[0].toolCallId, 'call-lookup');
  assert.equal(results[0].toolName, 'lookup');
  assert.deepEqual(results[0].content, [{ type: 'text', text: 'found' }]);
  assert.equal(results[0].isError, false);
  assert.equal(typeof results[0].timestamp, 'number');
});

test('tool errors and invalid/unadvertised calls become error results, not successful executions', async () => {
  let turn = 0;
  let executions = 0;
  const { options, requests } = setup(async () => ++turn === 1
    ? assistant([call(), call('missing'), call('lookup', {})], 'toolUse') : assistant());
  const result = await runAgent({ ...options, tools: [tool('lookup')], executeTool() {
    executions++;
    throw new Error('private detail');
  } });
  assert.equal(executions, 1);
  const errors = requests[1].context.messages.filter((message) => message.role === 'toolResult');
  assert.equal(errors.length, 3);
  assert.ok(errors.every((message) => message.isError));
  assert.equal(JSON.stringify(result).includes('private detail'), false);
  assert.equal(result.stopReason, 'stop');
});

test('getTools adds tools next turn; transforms cannot mutate persisted history', async () => {
  let turn = 0;
  const available = [tool('discover')];
  const { options, requests } = setup(async () => {
    turn++;
    return turn < 3 ? assistant([call(turn === 1 ? 'discover' : 'added')], 'toolUse') : assistant();
  });
  const executed = [];
  const result = await runAgent({ ...options,
    getTools: () => available,
    executeTool(name) {
      executed.push(name);
      if (name === 'discover') available.push(tool('added'));
      return 'large original tool result';
    },
    transformContext(context) {
      for (const message of context.messages) {
        if (message.role === 'toolResult') message.content[0].text = 'short';
      }
      return context;
    },
  });
  assert.deepEqual(executed, ['discover', 'added']);
  assert.deepEqual(requests[0].context.tools.map((item) => item.name), ['discover']);
  assert.deepEqual(requests[1].context.tools.map((item) => item.name), ['discover', 'added']);
  assert.equal(requests[1].context.messages[2].content[0].text, 'short');
  assert.equal(result.messages[2].content[0].text, 'large original tool result');
  assert.equal(result.messages.length, 6);
});

test('reservation rejection prevents completion and after hook', async () => {
  const { options, requests } = setup();
  let after = 0;
  await assert.rejects(runAgent({ ...options,
    onBeforeCall() { throw new Error('budget exceeded'); }, onAfterCall() { after++; },
  }), (error) => error.result.turns === 0 && error.result.stopReason === 'error');
  assert.equal(requests.length, 0);
  assert.equal(after, 0);
});

test('thrown completion errors call after hook with explicit unknown usage and no exception secrets', async () => {
  const { options, requests } = setup(async () => { throw new Error('secret credential'); });
  const after = [];
  const result = await runAgent({ ...options, onAfterCall: (event) => after.push(event) });
  assert.equal(result.stopReason, 'error');
  assert.equal(result.answer, '');
  assert.equal(after.length, 1);
  assert.equal(after[0].message.stopReason, 'error');
  assert.equal(after[0].message.usageUnknown, true);
  assert.equal(result.usage.usageUnknown, true);
  assert.equal(requests.length, 1);
  assert.equal(JSON.stringify(result).includes('secret credential'), false);
});

for (const reason of ['error', 'aborted', 'length', 'deferred']) {
  test(`provider ${reason} is not a successful answer and still calls after hook`, async () => {
    const { options } = setup(async () => assistant([{ type: 'text', text: 'partial' }], reason));
    let after = 0;
    const result = await runAgent({ ...options, onAfterCall() { after++; } });
    assert.equal(result.stopReason, reason === 'deferred' ? 'error' : reason);
    assert.equal(result.answer, '');
    assert.equal(after, 1);
    assert.equal(result.usage.output, 4);
  });
}

test('timeout aborts a non-cooperative completion and calls accounting hook', async () => {
  const { options, requests } = setup(() => new Promise(() => {}));
  let after = 0;
  const result = await runAgent({ ...options, timeoutMs: 40, onAfterCall({ message }) {
    after++;
    assert.equal(message.stopReason, 'aborted');
    assert.equal(message.usageUnknown, true);
  } });
  assert.equal(result.stopReason, 'timeout');
  assert.equal(result.turns, 1);
  assert.equal(after, 1);
  assert.equal(requests[0].options.signal.aborted, true);
});

test('tool timeout prevents further model calls', async () => {
  const { options, requests } = setup(async () => assistant([call()], 'toolUse'));
  const result = await runAgent({ ...options, tools: [tool('lookup')], timeoutMs: 40,
    executeTool: () => new Promise(() => {}),
  });
  assert.equal(result.stopReason, 'timeout');
  assert.equal(result.messages.at(-1).isError, true);
  assert.equal(requests.length, 1);
});

test('accounting hook failure rejects with partial usage instead of succeeding', async () => {
  const { options, requests } = setup();
  await assert.rejects(runAgent({ ...options, onAfterCall() { throw new Error('ledger failed'); } }),
    (error) => error.result.stopReason === 'error' && error.result.usage.output === 4);
  assert.equal(requests.length, 1);
});
