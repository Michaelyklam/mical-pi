import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Model, Usage } from "@earendil-works/pi-ai";
import { AccountCatalog, type AccountCatalogState } from "./account-catalog.ts";
import { LocalUsageIndex } from "./local-usage.ts";
import { PricingResolver } from "./pricing.ts";

const usage: Usage = { input: 1_000_000, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 1_000_000, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
const model = { provider: "verkada", id: "router/gpt", name: "gpt", api: "openai-responses", baseUrl: "x", reasoning: true, input: ["text"], cost: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0 }, contextWindow: 1, maxTokens: 1 } as Model<any>;

const account = { accountKey: "verkada:work", providerId: "verkada", authType: "api_key" as const, credentialFingerprints: [], label: "work", archived: false, active: true, firstSeenAt: 0, lastSeenAt: 0 };

function assistant(id: string, timestamp: string, recorded: Usage = usage) {
	return { type: "message", id, timestamp, message: { role: "assistant", provider: "verkada", model: "router/gpt", usage: recorded } };
}

/** A pi usage object carrying a provider-reported charge, as the patch writes it. */
function withReport(amount: number, currency = "USD"): Usage {
	return { ...usage, reportedCost: { amount, currency, source: "openrouter" } } as Usage;
}

async function setup(entries: unknown[]) {
	const root = await mkdtemp(join(tmpdir(), "usage-footer-local-"));
	const state: AccountCatalogState = { version: 1, accounts: { [account.accountKey]: account }, legacyMappings: { verkada: account.accountKey } };
	const catalog = new AccountCatalog({ load: async () => state, save: async () => {} });
	await catalog.load();
	await writeFile(join(root, "session.jsonl"), entries.map((entry) => JSON.stringify(entry)).join("\n"));
	return { root, catalog };
}

function indexFor(root: string, catalog: AccountCatalog, cachePath?: string) {
	return new LocalUsageIndex(root, catalog, new PricingResolver([model]), async () => ({ stdout: "{}", code: 0 }), async () => false, () => "2026-07-30", cachePath);
}

test("Local Usage scans provider-attributed Pi history and excludes other accounts", async () => {
	const { root, catalog } = await setup([
		assistant("a", "2026-07-30T10:00:00Z"),
		assistant("b", "2026-07-29T10:00:00Z"),
	]);
	try {
		const cachePath = join(root, "cache", "local-index.json");
		const summary = await indexFor(root, catalog, cachePath).summarize(account);
		assert.deepEqual(summary, {
			tokens: 1_000_000,
			estimated: 1,
			reported: 0,
			hasReportedUsage: false,
			hasEstimatedUsage: true,
			hasUnpricedUsage: false,
			models: 1,
		});
		const cache = JSON.parse(await readFile(cachePath, "utf8"));
		assert.equal(cache.version, 1);
		assert.equal(Object.values(cache.files).length, 1);
	} finally { await rm(root, { recursive: true, force: true }); }
});

test("Local Usage counts a reported charge instead of the estimate, without double counting", async () => {
	const { root, catalog } = await setup([
		assistant("a", "2026-07-30T10:00:00Z", withReport(0.5)),
		// A reported zero is a real, free request, not "unknown".
		assistant("b", "2026-07-30T11:00:00Z", withReport(0)),
		// Only this record has no report, so only this one is estimated.
		assistant("c", "2026-07-30T12:00:00Z"),
	]);
	try {
		const summary = await indexFor(root, catalog).summarize(account);
		assert.deepEqual(summary, {
			tokens: 3_000_000,
			estimated: 1,
			reported: 0.5,
			hasReportedUsage: true,
			hasEstimatedUsage: true,
			hasUnpricedUsage: false,
			models: 1,
		});
	} finally { await rm(root, { recursive: true, force: true }); }
});

test("Local Usage falls back to the estimate for a non-USD report", async () => {
	const { root, catalog } = await setup([assistant("a", "2026-07-30T10:00:00Z", withReport(9, "EUR"))]);
	try {
		const summary = await indexFor(root, catalog).summarize(account);
		assert.equal(summary.reported, 0);
		assert.equal(summary.hasReportedUsage, false);
		assert.equal(summary.estimated, 1);
		assert.equal(summary.hasEstimatedUsage, true);
	} finally { await rm(root, { recursive: true, force: true }); }
});
