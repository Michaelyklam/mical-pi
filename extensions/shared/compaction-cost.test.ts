import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { normalizeContext, type Model } from "@earendil-works/pi-ai";
import { stream } from "@earendil-works/pi-ai/api/openai-completions";
import { accumulateCost, emptyCostTotals, summarizeSessionEntries } from "./billing.ts";

/**
 * End-to-end regression for the maintained pi-coding-agent patch: a split
 * compaction makes two summarization calls and merges them with `combineUsage`,
 * which used to drop everything except tokens and `cost`. Once the pi-ai patch
 * preserves an OpenRouter charge on `usage.reportedCost`, that merge silently
 * lost it and the reported part was reclassified as an estimate.
 *
 * The test drives the real installed `compact` through a fake stream, so the
 * assertion covers the patched `combineUsage` rather than a hand-built usage.
 * Both fake calls run through the patched pi-ai parser, so the reported charges
 * are produced the same way they are in production. No network, no paid calls.
 *
 * Requires `npm run postinstall` (or both patch scripts) against the
 * repo-local copies.
 */

const PI_AI_MARKER = "PI_REPORTED_COST_PATCH";
const COMPACTION_MARKER = "PI_BILLING_COMPONENTS_PATCH";
const piAiModule = fileURLToPath(
	new URL("../../node_modules/@earendil-works/pi-ai/dist/api/openai-completions.js", import.meta.url),
);
const compactionModule = fileURLToPath(
	new URL("../../node_modules/@earendil-works/pi-coding-agent/dist/core/compaction/compaction.js", import.meta.url),
);
const { compact } = (await import(compactionModule)) as {
	compact: (preparation: unknown, model: unknown, ...rest: unknown[]) => Promise<{ usage: Record<string, unknown> }>;
};

function sseBody(usage: string): string {
	return [
		`data: {"id":"gen-split","object":"chat.completion.chunk","model":"openrouter/auto","choices":[{"index":0,"delta":{"content":"summary"}}]}`,
		"",
		`data: {"id":"gen-split","object":"chat.completion.chunk","model":"openrouter/auto","choices":[{"index":0,"delta":{},"finish_reason":"stop"}],"usage":${usage}}`,
		"",
		"data: [DONE]",
		"",
	].join("\n");
}

const model: Model<"openai-completions"> = {
	provider: "openrouter",
	id: "openrouter/auto",
	name: "auto",
	api: "openai-completions",
	baseUrl: "https://openrouter.ai/api/v1",
	reasoning: false,
	input: ["text"],
	cost: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 100_000,
	maxTokens: 1_000,
};

type AssistantMessage = {
	content: { type: string; text: string }[];
	usage: Record<string, unknown>;
	stopReason: string;
};

/** Pi's local estimate carried on a real streamed message. */
function costTotal(message: { usage: Record<string, unknown> }): number {
	return (message.usage.cost as { total: number }).total;
}

/** Produce a real assistant message through the patched pi-ai parser. */
async function summarizeCall(usageJson: string): Promise<AssistantMessage> {
	const body = sseBody(usageJson);
	const fetchImpl = async () => new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } });
	const context = normalizeContext({ messages: [{ role: "user", content: "hi", timestamp: 1 }], tools: [] });
	let message: AssistantMessage | undefined;
	for await (const event of stream(model, context, { apiKey: "test", fetch: fetchImpl })) {
		if (event.type === "done") message = event.message as unknown as AssistantMessage;
		if (event.type === "error") throw new Error(`stream error: ${event.error}`);
	}
	assert.ok(message, "stream produced no final message");
	return message;
}

/** Run a real split compaction whose two summarization calls use the given usages. */
async function splitCompaction(historyUsage: string, turnUsage: string) {
	const history = await summarizeCall(historyUsage);
	const turn = await summarizeCall(turnUsage);
	const calls = [history, turn];
	let next = 0;
	const streamFn = async () => ({ result: async () => calls[next++] });
	const preparation = {
		firstKeptEntryId: "kept-1",
		messagesToSummarize: [{ role: "user", content: [{ type: "text", text: "old history" }], timestamp: 1 }],
		turnPrefixMessages: [{ role: "user", content: [{ type: "text", text: "turn prefix" }], timestamp: 2 }],
		isSplitTurn: true,
		tokensBefore: 0,
		fileOps: { read: new Set<string>(), written: new Set<string>(), edited: new Set<string>() },
		settings: { enabled: true, reserveTokens: 16_384, keepRecentTokens: 20_000 },
	};
	const result = await compact(
		preparation,
		model,
		"test",
		undefined,
		undefined,
		undefined,
		"off",
		streamFn,
		undefined,
		undefined,
		undefined,
		"session-1",
	);
	return { history, turn, usage: result.usage };
}

function compactionEntry(usage: unknown) {
	return [{ type: "compaction", id: "compaction-1", responseId: "compaction-1", usage }];
}

test("patched combineUsage keeps both summarized calls on billingComponents", async () => {
	for (const file of [piAiModule, compactionModule]) {
		const marker = file === piAiModule ? PI_AI_MARKER : COMPACTION_MARKER;
		assert.ok(readFileSync(file, "utf8").includes(marker), `${file} is not patched; run: npm run postinstall`);
	}
	const { history, turn, usage } = await splitCompaction(
		'{"prompt_tokens":1000,"completion_tokens":100,"total_tokens":1100,"cost":0.25}',
		'{"prompt_tokens":500,"completion_tokens":50,"total_tokens":550,"cost":0.10}',
	);
	const components = usage.billingComponents as { cost: { total: number } }[];
	assert.equal(components.length, 2, "both summarization calls must survive the merge");
	assert.equal(components[0].cost.total, costTotal(history));
	assert.equal(components[1].cost.total, costTotal(turn));
});

test("a split compaction with two reported calls keeps both reported, not the merged estimate", async () => {
	const { usage } = await splitCompaction(
		'{"prompt_tokens":1000,"completion_tokens":100,"total_tokens":1100,"cost":0.25}',
		'{"prompt_tokens":500,"completion_tokens":50,"total_tokens":550,"cost":0.10}',
	);
	const totals = emptyCostTotals();
	accumulateCost(totals, usage, "compaction-1");
	assert.equal(totals.reported, 0.35);
	assert.equal(totals.estimated, 0, "neither reported call may be re-estimated");
	assert.equal(totals.hasReportedUsage, true);
	assert.equal(totals.hasEstimatedUsage, false);
});

test("a split compaction with one reported call keeps reported and estimated portions exact", async () => {
	const { turn, usage } = await splitCompaction(
		'{"prompt_tokens":1000,"completion_tokens":100,"total_tokens":1100,"cost":0.25}',
		'{"prompt_tokens":500,"completion_tokens":50,"total_tokens":550}',
	);
	const totals = emptyCostTotals();
	accumulateCost(totals, usage, "compaction-1");
	// Only the un-reported call is estimated, at its own price, not the merge.
	assert.equal(totals.reported, 0.25);
	assert.equal(totals.estimated, costTotal(turn));
	assert.notEqual(totals.estimated, (usage.cost as { total: number }).total);
	assert.equal(totals.hasReportedUsage, true);
	assert.equal(totals.hasEstimatedUsage, true);
});

test("the session ledger totals a split compaction from its components", async () => {
	const { turn, usage } = await splitCompaction(
		'{"prompt_tokens":1000,"completion_tokens":100,"total_tokens":1100,"cost":0.25}',
		'{"prompt_tokens":500,"completion_tokens":50,"total_tokens":550}',
	);
	const totals = summarizeSessionEntries(compactionEntry(usage));
	assert.equal(totals.reported, 0.25);
	assert.equal(totals.estimated, costTotal(turn));
	assert.equal(totals.reportedEntries, 1);
	assert.equal(totals.estimatedEntries, 1);
});

test("dropping billingComponents reintroduces the bug the patch prevents", async () => {
	const { usage } = await splitCompaction(
		'{"prompt_tokens":1000,"completion_tokens":100,"total_tokens":1100,"cost":0.25}',
		'{"prompt_tokens":500,"completion_tokens":50,"total_tokens":550,"cost":0.10}',
	);
	// Simulates the unpatched `combineUsage`, which returned only tokens/cost.
	const merged = { ...usage, billingComponents: undefined };
	const totals = emptyCostTotals();
	accumulateCost(totals, merged, "compaction-1");
	assert.equal(totals.reported, 0, "without the patch the reported charges vanish");
	assert.equal(totals.estimated, (usage.cost as { total: number }).total);
});
