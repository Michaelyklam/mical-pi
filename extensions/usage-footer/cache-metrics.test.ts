import assert from "node:assert/strict";
import { test } from "node:test";
import { computePromptCacheMetrics } from "./cache-metrics.ts";

function assistant(input: number, cacheRead = 0, cacheWrite = 0) {
	return {
		type: "message",
		message: {
			role: "assistant",
			usage: { input, cacheRead, cacheWrite },
		},
	};
}

test("returns undefined before the provider reports cache telemetry", () => {
	assert.equal(computePromptCacheMetrics([assistant(10_000)]), undefined);
});

test("calculates the latest request hit rate", () => {
	const metrics = computePromptCacheMetrics([
		assistant(10_000, 0, 2_000),
		assistant(1_000, 9_000, 0),
	]);
	assert.ok(metrics);
	assert.equal(metrics.latestHitPercent, 90);
});

test("calculates the session-wide hit rate", () => {
	const metrics = computePromptCacheMetrics([
		assistant(8_000, 0, 2_000),
		assistant(1_000, 9_000, 0),
	]);
	assert.ok(metrics);
	assert.equal(metrics.sessionPromptTokens, 20_000);
	assert.equal(metrics.sessionCacheReadTokens, 9_000);
	assert.equal(metrics.sessionHitPercent, 45);
});

test("shows a later total miss once the provider has reported cache activity", () => {
	const metrics = computePromptCacheMetrics([
		assistant(1_000, 9_000),
		assistant(12_000),
	]);
	assert.ok(metrics);
	assert.equal(metrics.latestHitPercent, 0);
	assert.equal(metrics.sessionHitPercent, (9_000 / 22_000) * 100);
});

test("includes cache writes in the prompt-token denominator", () => {
	const metrics = computePromptCacheMetrics([assistant(1_000, 7_000, 2_000)]);
	assert.ok(metrics);
	assert.equal(metrics.latestHitPercent, 70);
	assert.equal(metrics.sessionHitPercent, 70);
});

test("uses only assistant messages from the main conversation", () => {
	const metrics = computePromptCacheMetrics([
		assistant(1_000, 9_000),
		{ type: "message", message: { role: "toolResult", usage: { input: 10_000, cacheRead: 0, cacheWrite: 0 } } },
		{ type: "compaction", usage: { input: 10_000, cacheRead: 0, cacheWrite: 0 } },
	]);
	assert.ok(metrics);
	assert.equal(metrics.latestHitPercent, 90);
	assert.equal(metrics.sessionHitPercent, 90);
});

test("skips malformed usage rather than poisoning the counter", () => {
	const metrics = computePromptCacheMetrics([
		assistant(1_000, 9_000),
		assistant(Number.NaN, 0, 0),
		assistant(-1, 0, 0),
	]);
	assert.ok(metrics);
	assert.equal(metrics.latestHitPercent, 90);
});

test("uses the latest assistant request with positive prompt usage", () => {
	const metrics = computePromptCacheMetrics([
		assistant(1_000, 9_000),
		assistant(0, 0, 0),
	]);
	assert.ok(metrics);
	assert.equal(metrics.latestHitPercent, 90);
});
