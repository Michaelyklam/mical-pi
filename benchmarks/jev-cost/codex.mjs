import { validateToolCall } from '@earendil-works/pi-ai';

const PROVIDER = 'openai-codex';
const MODEL_IDS = new Set(['gpt-6-astra', 'gpt-5.6-luna']);
let runtimePromise;

async function defaultRuntime() {
  // No AgentSession/ResourceLoader: no skills, extensions, or user context.
  runtimePromise ??= import('@earendil-works/pi-coding-agent').then(async ({ ModelRuntime }) => {
    const runtime = await ModelRuntime.create({ modelsPath: null, allowModelNetwork: false });
    // Astra is supplied by the authenticated Codex catalog, not the bundled
    // static registry. Metadata discovery makes no generation request.
    if ([...MODEL_IDS].some(id => !runtime.getModel(PROVIDER, id))) {
      await runtime.refresh({ providers: [PROVIDER], allowNetwork: true, force: true, signal: AbortSignal.timeout(15000) });
    }
    return runtime;
  });
  return runtimePromise;
}

function checkModel(model, modelId) {
  if (!MODEL_IDS.has(modelId)) throw new Error('Model is not authorized for this benchmark');
  if (!model || model.id !== modelId || model.provider !== PROVIDER ||
      model.api !== 'openai-codex-responses') {
    throw new Error('Authorized model is unavailable on openai-codex');
  }
  if (!Number.isSafeInteger(model.maxTokens) || model.maxTokens <= 0) {
    throw new Error('Model must declare its maximum output tokens for cost reservation');
  }
  const url = new URL(model.baseUrl);
  if (url.origin !== 'https://chatgpt.com' || url.username || url.password) {
    throw new Error('Only the ChatGPT Codex endpoint is authorized');
  }
  return model;
}

/** Catalog lookup (authenticated metadata refresh if absent); never substitutes a model/provider.
 * Optional runtime is a dependency-injection seam for offline tests.
 */
export async function getCodexModel(modelId, runtime) {
  if (!MODEL_IDS.has(modelId)) throw new Error('Model is not authorized for this benchmark');
  runtime ??= await defaultRuntime();
  return checkModel(runtime.getModel(PROVIDER, modelId), modelId);
}

function emptyUsage() {
  return {
    input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    costBasis: 'API equivalent, not actual charge',
  };
}

function addUsage(total, usage) {
  if (!usage) return;
  for (const key of ['input', 'output', 'cacheRead', 'cacheWrite', 'totalTokens', 'reasoning', 'cacheWrite1h']) {
    if (Number.isFinite(usage[key])) total[key] = (total[key] ?? 0) + usage[key];
  }
  for (const key of Object.keys(total.cost)) {
    if (Number.isFinite(usage.cost?.[key])) total.cost[key] += usage.cost[key];
  }
}

class DeadlineError extends Error {}

/**
 * Bounded, sequential tool loop. getTools({turn, messages}) supplies fresh pi-ai
 * schemas each turn. transformContext(context) receives a deep copy and returns
 * an outbound Context (or undefined to use that copy); history is never compacted.
 *
 * onBeforeCall may reject to veto a request. maxOutputTokens is model.maxTokens,
 * a WORST-CASE RESERVATION, not an enforced cap: Codex ignores maxTokens.
 * onAfterCall runs once per attempted completion, including errors/timeouts.
 * Synthetic error messages have usageUnknown=true; their zero usage is NOT
 * evidence of zero spend. Keep the reservation when actual usage is unknown.
 *
 * stopReason: stop, maxTurns, timeout, error, aborted, or length. Only stop is
 * successful; answer is empty otherwise. Setup/hook failures reject with a
 * partial result on error.result. Tool failures become isError tool results.
 * timeoutMs is a whole-run deadline, including tools/hooks. Aborting cannot
 * guarantee provider billing stops or cancel non-cooperative caller tools.
 * runtime/model are optional offline-test dependencies. No credentials returned.
 */
export async function runAgent({
  modelId, systemPrompt, prompt, tools = [], executeTool,
  getTools, onBeforeCall, onAfterCall, transformContext,
  maxTurns = 8, timeoutMs = 120000, reasoning = 'medium', sessionId,
  runtime, model,
}) {
  if (!Number.isSafeInteger(maxTurns) || maxTurns < 1) throw new Error('maxTurns must be a positive integer');
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0 || timeoutMs > 2147483647) throw new Error('Invalid timeoutMs');
  if (typeof prompt !== 'string' || typeof systemPrompt !== 'string') throw new Error('Prompts must be strings');
  const started = Date.now();
  const deadline = started + timeoutMs;
  const controller = new AbortController();
  const messages = [{ role: 'user', content: prompt, timestamp: started }];
  const usage = emptyUsage();
  let turns = 0;
  const result = (stopReason, answer = '') => ({ messages, answer, usage, turns, stopReason, durationMs: Date.now() - started });

  // Race even non-cooperative injected dependencies. Late results cannot advance
  // the loop. Accounting hook is still invoked if the completion times out.
  async function bounded(fn, allowExpired = false) {
    const remaining = deadline - Date.now();
    if (remaining <= 0 && !allowExpired) throw new DeadlineError('Agent deadline exceeded');
    let timer;
    try {
      return await Promise.race([
        Promise.resolve().then(fn),
        new Promise((_, reject) => {
          timer = setTimeout(() => {
            controller.abort();
            reject(new DeadlineError('Agent deadline exceeded'));
          }, Math.max(1, remaining));
        }),
      ]);
    } finally {
      clearTimeout(timer);
    }
  }

  function failedMessage(timeout = false) {
    return {
      role: 'assistant', api: model.api, provider: model.provider, model: model.id,
      content: [], usage: emptyUsage(), usageUnknown: true,
      stopReason: timeout ? 'aborted' : 'error',
      errorMessage: timeout ? 'Agent deadline exceeded; usage unknown' : 'Completion failed; usage unknown',
      timestamp: Date.now(),
    };
  }

  try {
    if (!MODEL_IDS.has(modelId)) throw new Error('Model is not authorized for this benchmark');
    runtime ??= await bounded(defaultRuntime);
    model = checkModel(model ?? await bounded(() => getCodexModel(modelId, runtime)), modelId);
    if (!runtime.isUsingOAuth(PROVIDER)) throw new Error('Current openai-codex OAuth credentials are required');

    for (let turn = 1; turn <= maxTurns; turn++) {
      const currentTools = structuredClone(getTools
        ? await bounded(() => getTools({ turn, messages: structuredClone(messages) }))
        : tools);
      if (!Array.isArray(currentTools)) throw new Error('getTools must return a tool schema array');
      let context = { systemPrompt, messages: structuredClone(messages), tools: currentTools };
      if (transformContext) context = await bounded(() => transformContext(context)) ?? context;
      if (!context || !Array.isArray(context.messages) || !Array.isArray(context.tools)) {
        throw new Error('transformContext must preserve a valid Context with tools');
      }
      // Keep the exact advertised schemas for validation, independent of hooks.
      const advertisedTools = structuredClone(context.tools);
      if (onBeforeCall) await bounded(() => onBeforeCall({ model, context: structuredClone(context), maxOutputTokens: model.maxTokens }));
      if (Date.now() >= deadline) throw new DeadlineError('Agent deadline exceeded');
      turns++;
      const callStarted = Date.now();
      let message;
      let timedOut = false;
      try {
        message = await bounded(() => runtime.completeSimple(model, context, {
          reasoning, sessionId, signal: controller.signal,
          timeoutMs: Math.max(1, deadline - Date.now()), maxRetries: 0, transport: 'sse',
        }));
        if (message?.role !== 'assistant' || !Array.isArray(message.content)) {
          message = failedMessage();
        }
      } catch (error) {
        timedOut = error instanceof DeadlineError;
        message = failedMessage(timedOut);
      }
      // Failed streams may report only partial (or zero) usage. Do not release
      // the worst-case reservation merely because those counters are present.
      if (['error', 'aborted'].includes(message.stopReason) || !message.usage) {
        message = { ...message, usageUnknown: true };
      }
      messages.push(structuredClone(message));
      addUsage(usage, message.usage);
      if (message.usageUnknown) usage.usageUnknown = true;
      if (onAfterCall) await bounded(() => onAfterCall({
        model, message: structuredClone(message), durationMs: Date.now() - callStarted,
      }), true);
      if (timedOut) return result('timeout');
      if (['error', 'aborted', 'length'].includes(message.stopReason)) return result(message.stopReason);
      if (!['stop', 'toolUse'].includes(message.stopReason)) return result('error');
      const calls = message.content.filter((part) => part.type === 'toolCall');
      if (!calls.length) {
        if (message.stopReason !== 'stop') return result('error');
        return result('stop', message.content.filter((part) => part.type === 'text').map((part) => part.text).join('\n'));
      }
      for (const call of calls) {
        let text;
        let isError = false;
        try {
          const args = validateToolCall(advertisedTools, call);
          if (typeof executeTool !== 'function') throw new Error('No tool executor configured');
          text = await bounded(() => executeTool(call.name, args));
          if (typeof text !== 'string') throw new Error('Tool executor must return a string');
        } catch (error) {
          isError = true;
          // Do not copy arbitrary exception objects, which may contain secrets.
          text = error instanceof DeadlineError ? 'Tool timed out' : 'Tool execution or argument validation failed';
          messages.push({ role: 'toolResult', toolCallId: call.id, toolName: call.name,
            content: [{ type: 'text', text }], isError, timestamp: Date.now() });
          if (error instanceof DeadlineError) throw error;
          continue;
        }
        messages.push({ role: 'toolResult', toolCallId: call.id, toolName: call.name,
          content: [{ type: 'text', text }], isError, timestamp: Date.now() });
      }
    }
    return result('maxTurns');
  } catch (error) {
    if (error instanceof DeadlineError) return result('timeout');
    // Do not include runtime/provider exception bodies or auth data.
    const failure = new Error('Codex agent setup or hook failed');
    failure.result = result('error');
    throw failure;
  } finally {
    controller.abort();
  }
}
