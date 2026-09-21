import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import type { Context, Model } from "@earendil-works/pi-ai";
import { stream } from "@earendil-works/pi-ai/api/openai-completions";
import { emptyCostTotals, accumulateCost, readReportedCost, REPORTED_COST_FIELD } from "./billing.ts";

/**
 * End-to-end regression for the maintained pi-ai patch: an OpenRouter usage
 * chunk carries `usage.cost`, and the patched parser must preserve it as
 * `usage.reportedCost` without disturbing Pi's local estimate. Uses a fake
 * fetch, so no network and no paid inference.
 *
 * Requires `npm run postinstall` (or the patch script) to have run against the
 * repo-local pi-ai copy.
 */

const patchedModule = fileURLToPath(
	new URL("../../node_modules/@earendil-works/pi-ai/dist/api/openai-completions.js", import.meta.url),
);
const MARKER = "PI_REPORTED_COST_PATCH";

function sseBody(usage: string): string {
	return [
		`data: {"id":"gen-test","object":"chat.completion.chunk","model":"openrouter/auto","choices":[{"index":0,"delta":{"content":"hi"}}]}`,
		"",
		`data: {"id":"gen-test","object":"chat.completion.chunk","model":"openrouter/auto","choices":[{"index":0,"delta":{},"finish_reason":"stop"}],"usage":${usage}}`,
		"",
		"data: [DONE]",
		"",
	].join("\n");
}

function model(provider = "openrouter"): Model<"openai-completions"> {
	const openrouter = provider === "openrouter";
	return {
		provider,
		id: openrouter ? "openrouter/auto" : "gpt-4o-mini",
		name: openrouter ? "auto" : "gpt-4o-mini",
		api: "openai-completions",
		baseUrl: openrouter ? "https://openrouter.ai/api/v1" : "https://api.openai.com/v1",
		reasoning: false,
		input: ["text"],
		cost: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 100_000,
		maxTokens: 1_000,
	};
}

async function streamUsage(usageJson: string, provider = "openrouter") {
	const body = sseBody(usageJson);
	const fetchImpl = async () =>
		new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } });
	const context: Context = { messages: [{ role: "user", content: "hi", timestamp: 1 }], tools: [] };
	let message;
	for await (const event of stream(model(provider), context, { apiKey: "test", fetch: fetchImpl })) {
		if (event.type === "done") message = event.message;
		if (event.type === "error") throw new Error(`stream error: ${event.error}`);
	}
	assert.ok(message, "stream produced no final message");
	return message;
}

test("patched pi-ai preserves the OpenRouter charge while keeping the estimate", async () => {
	const source = readFileSync(patchedModule, "utf8");
	assert.ok(
		source.includes(MARKER),
		`repo-local pi-ai is not patched (${patchedModule}); run: npm run postinstall`,
	);
	const message = await streamUsage(
		'{"prompt_tokens":100,"completion_tokens":10,"total_tokens":110,"cost":0.0123,"cost_details":{"upstream_inference_cost":0.01}}',
	);
	// Pi's own estimate is untouched...
	assert.ok(message.usage.cost.total > 0);
	// ...and the provider charge is preserved with provenance and request id.
	const reported = readReportedCost(message.usage, message.responseId);
	assert.deepEqual(reported, {
		amount: 0.0123,
		currency: "USD",
		source: "openrouter",
		upstreamInferenceCost: 0.01,
		requestId: "gen-test",
	});
});

test("a real OpenRouter usage chunk is never reduced to the local estimate by billing", async () => {
	const message = await streamUsage(
		'{"prompt_tokens":100,"completion_tokens":10,"total_tokens":110,"cost":0.5}',
	);
	const totals = emptyCostTotals();
	accumulateCost(totals, message.usage, message.responseId);
	assert.equal(totals.reported, 0.5);
	assert.equal(totals.estimated, 0, "estimate must not be added alongside a reported charge");
	assert.equal(totals.hasReportedUsage, true);
	assert.deepEqual(totals.reportedRequestIds, ["gen-test"]);
});

test("a missing OpenRouter charge falls back to the estimate rather than inventing one", async () => {
	const message = await streamUsage('{"prompt_tokens":100,"completion_tokens":10,"total_tokens":110}');
	assert.equal((message.usage as unknown as Record<string, unknown>)[REPORTED_COST_FIELD], undefined);
	const totals = emptyCostTotals();
	accumulateCost(totals, message.usage, message.responseId);
	assert.equal(totals.reported, 0);
	assert.equal(totals.hasReportedUsage, false);
	assert.ok(totals.estimated > 0);
});

test("a raw upstream reported zero survives the parser and stays authoritative", async () => {
	const message = await streamUsage(
		'{"prompt_tokens":100,"completion_tokens":10,"total_tokens":110,"cost":0}',
	);
	const reported = readReportedCost(message.usage, message.responseId);
	assert.equal(reported?.amount, 0);
	assert.equal(reported?.source, "openrouter");
	const totals = emptyCostTotals();
	accumulateCost(totals, message.usage, message.responseId);
	assert.equal(totals.reported, 0);
	assert.equal(totals.estimated, 0, "a reported zero must suppress the local estimate");
	assert.equal(totals.hasReportedUsage, true);
});

test("a non-OpenRouter provider never gets a reported charge", async () => {
	const message = await streamUsage(
		'{"prompt_tokens":100,"completion_tokens":10,"total_tokens":110,"cost":0.5}',
		"openai",
	);
	assert.equal((message.usage as unknown as Record<string, unknown>)[REPORTED_COST_FIELD], undefined);
	const totals = emptyCostTotals();
	accumulateCost(totals, message.usage, message.responseId);
	assert.equal(totals.reported, 0);
	assert.equal(totals.hasReportedUsage, false);
	assert.ok(totals.estimated > 0);
});

test("a negative upstream charge is rejected instead of becoming a credit", async () => {
	const message = await streamUsage(
		'{"prompt_tokens":100,"completion_tokens":10,"total_tokens":110,"cost":-1}',
	);
	assert.equal((message.usage as unknown as Record<string, unknown>)[REPORTED_COST_FIELD], undefined);
	assert.equal(readReportedCost({ reportedCost: { amount: -1, currency: "USD", source: "openrouter" } }), undefined);
	const totals = emptyCostTotals();
	accumulateCost(totals, message.usage, message.responseId);
	assert.equal(totals.reported, 0);
	assert.equal(totals.hasReportedUsage, false);
	assert.ok(totals.estimated > 0);
});
