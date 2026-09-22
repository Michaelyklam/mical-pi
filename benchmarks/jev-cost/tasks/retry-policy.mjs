const prompt = `Fix retryDecision(input) in retry.mjs and its local helper policy.mjs.
Input has status (null for transport failure, otherwise integer HTTP status),
attempt (1-based attempt that just failed), maxAttempts (>=1), baseMs, capMs,
remainingMs (nonnegative integer budget), and optional retryAfterMs (nonnegative
integer or null). Retry only null, 408, 429, and 500..599, and only if
attempt < maxAttempts. For retryable responses compute exponential delay
min(capMs, baseMs * 2 ** (attempt - 1)). Only for 429 or 503, a non-null
retryAfterMs is a lower bound on delay, even if it exceeds capMs. Retry if final
delay <= remainingMs (equality allowed). Return {retry:true, delayMs:delay} or
{retry:false, delayMs:null}. Numeric inputs are small enough for exact finite
arithmetic; baseMs and capMs are nonnegative integers. Do not mutate input.
No jitter, sleeping, network, wall clock, or external dependencies.`;

export default {
  id: 'retry-policy', category: 'retry-policy', difficulty: 'medium',
  entry: 'retry.mjs', exportName: 'retryDecision', prompt,
  files: {
    'retry.mjs': `import { isRetryable, delayFor } from './policy.mjs';
export function retryDecision(input) {
  if (!isRetryable(input.status) || input.attempt > input.maxAttempts) return {retry: false, delayMs: null};
  const delay = delayFor(input);
  return delay < input.remainingMs ? {retry: true, delayMs: delay} : {retry: false, delayMs: null};
}
`,
    'policy.mjs': `export const isRetryable = status => status === null || status >= 500;
export function delayFor(input) {
  return Math.min(input.capMs, input.baseMs * input.attempt, input.retryAfterMs ?? Infinity);
}
`,
  },
  cases: [
    { args: [{ status: 500, attempt: 3, maxAttempts: 5, baseMs: 100, capMs: 1000, remainingMs: 400 }], expected: { retry: true, delayMs: 400 } },
    { args: [{ status: null, attempt: 2, maxAttempts: 2, baseMs: 10, capMs: 100, remainingMs: 1000 }], expected: { retry: false, delayMs: null } },
    { args: [{ status: 429, attempt: 1, maxAttempts: 3, baseMs: 50, capMs: 100, remainingMs: 400, retryAfterMs: 300 }], expected: { retry: true, delayMs: 300 } },
    { args: [{ status: 503, attempt: 1, maxAttempts: 3, baseMs: 50, capMs: 100, remainingMs: 299, retryAfterMs: 300 }], expected: { retry: false, delayMs: null } },
    { args: [{ status: 408, attempt: 1, maxAttempts: 2, baseMs: 0, capMs: 0, remainingMs: 0 }], expected: { retry: true, delayMs: 0 } },
    { args: [{ status: 400, attempt: 1, maxAttempts: 5, baseMs: 1, capMs: 10, remainingMs: 100 }], expected: { retry: false, delayMs: null } },
    { args: [{ status: 600, attempt: 1, maxAttempts: 5, baseMs: 1, capMs: 10, remainingMs: 100 }], expected: { retry: false, delayMs: null } },
    { args: [{ status: 502, attempt: 5, maxAttempts: 6, baseMs: 100, capMs: 250, remainingMs: 250, retryAfterMs: 900 }], expected: { retry: true, delayMs: 250 } },
    { args: [{ status: 503, attempt: 2, maxAttempts: 3, baseMs: 100, capMs: 1000, remainingMs: 500, retryAfterMs: 0 }], expected: { retry: true, delayMs: 200 } },
    { args: [{ status: null, attempt: 1, maxAttempts: 2, baseMs: 10, capMs: 50, remainingMs: 10, retryAfterMs: null }], expected: { retry: true, delayMs: 10 } },
  ],
  referenceFiles: {
    'retry.mjs': `import { isRetryable, delayFor } from './policy.mjs';
export function retryDecision(input) {
  if (!isRetryable(input.status) || input.attempt >= input.maxAttempts) return {retry: false, delayMs: null};
  const delay = delayFor(input);
  return delay <= input.remainingMs ? {retry: true, delayMs: delay} : {retry: false, delayMs: null};
}
`,
    'policy.mjs': `export const isRetryable = status => status === null || status === 408 || status === 429 || (status >= 500 && status <= 599);
export function delayFor(input) {
  const backoff = Math.min(input.capMs, input.baseMs * 2 ** (input.attempt - 1));
  return (input.status === 429 || input.status === 503) && input.retryAfterMs != null
    ? Math.max(backoff, input.retryAfterMs) : backoff;
}
`,
  },
};
