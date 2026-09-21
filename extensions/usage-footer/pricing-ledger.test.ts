import assert from "node:assert/strict";
import { test } from "node:test";
import type { Model, Usage } from "@earendil-works/pi-ai";
import { PricingResolver } from "./pricing.ts";
import { SessionLedger } from "./session-ledger.ts";

function usage(input: number, output: number, cacheRead = 0, cacheWrite = 0): Usage {
	return {
		input,
		output,
		cacheRead,
		cacheWrite,
		totalTokens: input + output + cacheRead + cacheWrite,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	};
}

function model(provider: string, id: string, cost: Model<any>["cost"]): Model<any> {
	return {
		provider,
		id,
		name: id,
		api: "openai-responses",
		baseUrl: "https://example.test",
		reasoning: true,
		input: ["text"],
		cost,
		contextWindow: 1_000_000,
		maxTokens: 100_000,
	};
}

test("Pricing uses live direct rates and exact canonical router inheritance", () => {
	const resolver = new PricingResolver([
		model("openai-codex", "gpt-5.6-terra", { input: 2.5, output: 15, cacheRead: 0.25, cacheWrite: 3.125 }),
		model("verkada", "bedrock_mantle/gpt-5.6-terra", { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }),
	]);
	const estimate = resolver.estimate("verkada", "bedrock_mantle/gpt-5.6-terra", usage(1_000_000, 100_000));
	assert.equal(estimate?.amount, 4);
	assert.match(estimate?.pricingSource ?? "", /canonical gpt-5\.6-terra/);
});

test("Pricing refuses fuzzy or conflicting canonical prices and applies request-wide tiers", () => {
	const tiered = { input: 1, output: 2, cacheRead: 0.1, cacheWrite: 1, tiers: [{ inputTokensAbove: 100, input: 3, output: 6, cacheRead: 0.3, cacheWrite: 3 }] };
	const resolver = new PricingResolver([
		model("one", "gpt-exact", tiered),
		model("two", "gpt-conflict", { input: 1, output: 2, cacheRead: 0, cacheWrite: 0 }),
		model("three", "gpt-conflict", { input: 2, output: 4, cacheRead: 0, cacheWrite: 0 }),
	]);
	assert.equal(resolver.estimate("one", "gpt-exact", usage(101, 10))?.amount, (101 * 3 + 10 * 6) / 1_000_000);
	assert.equal(resolver.estimate("router", "prefix/gpt-conflict", usage(100, 10)), undefined);
	assert.equal(resolver.estimate("router", "prefix/gpt-exa", usage(100, 10)), undefined);
});

test("Session Ledger scopes all incurred branches to the selected account and excludes unattributed tools", () => {
	const resolver = new PricingResolver([
		model("openai-codex", "gpt", { input: 1, output: 2, cacheRead: 0, cacheWrite: 0 }),
		model("anthropic", "claude", { input: 3, output: 4, cacheRead: 0, cacheWrite: 0 }),
	]);
	const entries = [
		{ type: "message", id: "a", message: { role: "assistant", provider: "openai-codex", model: "gpt", usage: usage(1_000_000, 0) } },
		{ type: "message", id: "b", parentId: "old-branch", message: { role: "assistant", provider: "openai-codex", model: "gpt", usage: usage(0, 1_000_000) } },
		{ type: "message", id: "c", message: { role: "assistant", provider: "anthropic", model: "claude", usage: usage(1_000_000, 0) } },
		{ type: "message", id: "tool", message: { role: "toolResult", usage: usage(1_000_000, 0) } },
		{ type: "custom", id: "map-a", customType: "usage-footer-attribution", data: { targetEntryId: "a", accountKey: "codex:personal", providerId: "openai-codex", modelId: "gpt", kind: "assistant", recordedAt: 1 } },
		{ type: "custom", id: "map-b", customType: "usage-footer-attribution", data: { targetEntryId: "b", accountKey: "codex:personal", providerId: "openai-codex", modelId: "gpt", kind: "assistant", recordedAt: 2 } },
	];
	const ledger = new SessionLedger(resolver, () => undefined);
	const result = ledger.summarize(entries, { accountKey: "codex:personal", providerId: "openai-codex" });
	assert.equal(result.estimated, 3);
	assert.equal(result.attributedEntries, 2);
	assert.equal(result.excludedEntries, 1);
});

test("Session Ledger keeps provider-reported charges separate and suppresses the estimate for that entry", () => {
	const resolver = new PricingResolver([model("openrouter", "openai/gpt", { input: 1, output: 0, cacheRead: 0, cacheWrite: 0 })]);
	const reportedUsage = { ...usage(1_000_000, 0), reportedCost: { amount: 0.42, currency: "USD", source: "openrouter" } };
	const entries = [
		{ type: "message", id: "a", message: { role: "assistant", provider: "openrouter", model: "openai/gpt", responseId: "gen-1", usage: reportedUsage } },
		{ type: "message", id: "b", message: { role: "assistant", provider: "openrouter", model: "openai/gpt", usage: usage(500_000, 0) } },
	];
	const result = new SessionLedger(resolver, (provider) => provider === "openrouter" ? "openrouter:main" : undefined).summarize(entries, { accountKey: "openrouter:main", providerId: "openrouter" });
	// Entry a is reported (estimate 1.0 ignored); entry b has no report, so it estimates to 0.5.
	assert.equal(result.reported, 0.42);
	assert.equal(result.estimated, 0.5);
	assert.equal(result.hasReportedUsage, true);
	assert.equal(result.hasEstimatedUsage, true);
	assert.equal(result.reportedEntries, 1);
	assert.deepEqual(result.reportedRequestIds, ["gen-1"]);
	assert.deepEqual(result.reportedSources, ["openrouter"]);
});

test("Session Ledger treats a provider-reported zero as authoritative, not missing", () => {
	const resolver = new PricingResolver([model("openrouter", "openai/gpt", { input: 1, output: 0, cacheRead: 0, cacheWrite: 0 })]);
	const entries = [
		{ type: "message", id: "free", message: { role: "assistant", provider: "openrouter", model: "openai/gpt", responseId: "gen-free", usage: { ...usage(1_000_000, 0), reportedCost: { amount: 0, currency: "USD", source: "openrouter" } } } },
	];
	const result = new SessionLedger(resolver, (provider) => provider === "openrouter" ? "openrouter:main" : undefined).summarize(entries, { accountKey: "openrouter:main", providerId: "openrouter" });
	assert.equal(result.reported, 0);
	assert.equal(result.estimated, 0);
	assert.equal(result.hasReportedUsage, true);
	assert.equal(result.hasEstimatedUsage, false);
});

test("Session Ledger falls back to an estimate when no reported charge exists (resumed/legacy entries)", () => {
	const resolver = new PricingResolver([model("openrouter", "openai/gpt", { input: 1, output: 0, cacheRead: 0, cacheWrite: 0 })]);
	const entries = [
		{ type: "message", id: "legacy", message: { role: "assistant", provider: "openrouter", model: "openai/gpt", usage: usage(250_000, 0) } },
	];
	const result = new SessionLedger(resolver, (provider) => provider === "openrouter" ? "openrouter:main" : undefined).summarize(entries, { accountKey: "openrouter:main", providerId: "openrouter" });
	assert.equal(result.reported, 0);
	assert.equal(result.hasReportedUsage, false);
	assert.equal(result.estimated, 0.25);
	assert.equal(result.estimatedEntries, 1);
});

test("Session Ledger accounts a split compaction from its per-call components", () => {
	const resolver = new PricingResolver([model("openrouter", "openai/gpt", { input: 1, output: 0, cacheRead: 0, cacheWrite: 0 })]);
	// A split compaction merges two summarization calls; the first was billed by
	// the provider, the second is only locally priced.
	const merged = {
		...usage(1_500_000, 0),
		billingComponents: [
			{ ...usage(1_000_000, 0), reportedCost: { amount: 0.42, currency: "USD", source: "openrouter" } },
			usage(500_000, 0),
		],
	};
	const entries = [
		{ type: "compaction", id: "compact", usage: merged },
		{ type: "custom", id: "map", customType: "usage-footer-attribution", data: { targetEntryId: "compact", accountKey: "openrouter:main", providerId: "openrouter", modelId: "openai/gpt", kind: "compaction", recordedAt: 2 } },
	];
	const result = new SessionLedger(resolver, () => undefined).summarize(entries, { accountKey: "openrouter:main", providerId: "openrouter" });
	assert.equal(result.reported, 0.42);
	assert.equal(result.estimated, 0.5);
	assert.equal(result.reportedEntries, 1);
	assert.equal(result.estimatedEntries, 1);
	assert.equal(result.attributedEntries, 1);
});

test("Session Ledger attributes compactions and maps legacy provider-only entries", () => {
	const resolver = new PricingResolver([model("openai-codex", "gpt", { input: 1, output: 2, cacheRead: 0, cacheWrite: 0 })]);
	const entries = [
		{ type: "message", id: "legacy", message: { role: "assistant", provider: "openai-codex", model: "gpt", usage: usage(1_000_000, 0) } },
		{ type: "compaction", id: "compact", usage: usage(0, 1_000_000) },
		{ type: "custom", id: "map", customType: "usage-footer-attribution", data: { targetEntryId: "compact", accountKey: "codex:personal", providerId: "openai-codex", modelId: "gpt", kind: "compaction", recordedAt: 2 } },
	];
	const ledger = new SessionLedger(resolver, (provider) => provider === "openai-codex" ? "codex:personal" : undefined);
	const result = ledger.summarize(entries, { accountKey: "codex:personal", providerId: "openai-codex" });
	assert.equal(result.estimated, 3);
	assert.equal(result.attributedEntries, 2);
});
