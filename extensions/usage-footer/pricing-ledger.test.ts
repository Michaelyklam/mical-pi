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
