/** Prompt-cache metrics for the main conversation requests. */

interface UsageLike {
	input: number;
	cacheRead: number;
	cacheWrite: number;
}

interface MessageEntryLike {
	type: "message";
	message: {
		role: string;
		usage?: UsageLike;
	};
}

export interface PromptCacheMetrics {
	/** Cache-read percentage for the most recent assistant request. */
	latestHitPercent: number;
	/** Cache-read percentage across all assistant requests in this session. */
	sessionHitPercent: number;
	/** Prompt tokens considered across the session, useful for tests/diagnostics. */
	sessionPromptTokens: number;
	/** Cache-read tokens considered across the session. */
	sessionCacheReadTokens: number;
}

function isFiniteNonNegative(value: unknown): value is number {
	return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

function usageFrom(entry: unknown): UsageLike | undefined {
	if (typeof entry !== "object" || entry === null) return undefined;
	const candidate = entry as Partial<MessageEntryLike>;
	if (candidate.type !== "message" || candidate.message?.role !== "assistant") return undefined;
	const usage = candidate.message.usage;
	if (!usage) return undefined;
	if (!isFiniteNonNegative(usage.input) || !isFiniteNonNegative(usage.cacheRead) || !isFiniteNonNegative(usage.cacheWrite)) {
		return undefined;
	}
	return usage;
}

/**
 * Calculate cache hit rates using the same denominator as pi's built-in footer:
 *
 *   cacheRead / (input + cacheRead + cacheWrite)
 *
 * Return `undefined` until the provider has reported cache activity at least
 * once. Providers without prompt-cache telemetry use zeroes for both cache
 * fields; showing `0%` for them would falsely look like a cache failure.
 *
 * Only assistant messages are included. Usage attached to tool results,
 * compactions, and branch summaries may come from nested or summary model calls
 * and does not measure the main conversation prompt.
 */
export function computePromptCacheMetrics(entries: readonly unknown[]): PromptCacheMetrics | undefined {
	let sessionPromptTokens = 0;
	let sessionCacheReadTokens = 0;
	let reportedCache = false;
	let latestPromptTokens = 0;
	let latestCacheReadTokens = 0;

	for (const entry of entries) {
		const usage = usageFrom(entry);
		if (!usage) continue;
		const promptTokens = usage.input + usage.cacheRead + usage.cacheWrite;
		if (promptTokens <= 0) continue;

		sessionPromptTokens += promptTokens;
		sessionCacheReadTokens += usage.cacheRead;
		reportedCache ||= usage.cacheRead + usage.cacheWrite > 0;
		latestPromptTokens = promptTokens;
		latestCacheReadTokens = usage.cacheRead;
	}

	if (!reportedCache || latestPromptTokens <= 0 || sessionPromptTokens <= 0) return undefined;
	return {
		latestHitPercent: (latestCacheReadTokens / latestPromptTokens) * 100,
		sessionHitPercent: (sessionCacheReadTokens / sessionPromptTokens) * 100,
		sessionPromptTokens,
		sessionCacheReadTokens,
	};
}
