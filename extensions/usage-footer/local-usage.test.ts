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

test("Local Usage scans provider-attributed Pi history and excludes other accounts", async () => {
	const root = await mkdtemp(join(tmpdir(), "usage-footer-local-"));
	try {
		const account = { accountKey: "verkada:work", providerId: "verkada", authType: "api_key" as const, credentialFingerprints: [], label: "work", archived: false, active: true, firstSeenAt: 0, lastSeenAt: 0 };
		const state: AccountCatalogState = { version: 1, accounts: { [account.accountKey]: account }, legacyMappings: { verkada: account.accountKey } };
		const catalog = new AccountCatalog({ load: async () => state, save: async () => {} });
		await catalog.load();
		const entries = [
			{ type: "message", id: "a", timestamp: "2026-07-30T10:00:00Z", message: { role: "assistant", provider: "verkada", model: "router/gpt", usage } },
			{ type: "message", id: "b", timestamp: "2026-07-29T10:00:00Z", message: { role: "assistant", provider: "verkada", model: "router/gpt", usage } },
		];
		await writeFile(join(root, "session.jsonl"), entries.map((entry) => JSON.stringify(entry)).join("\n"));
		const cachePath = join(root, "cache", "local-index.json");
		const index = new LocalUsageIndex(root, catalog, new PricingResolver([model]), async () => ({ stdout: "{}", code: 0 }), async () => false, () => "2026-07-30", cachePath);
		const summary = await index.summarize(account);
		assert.deepEqual(summary, { tokens: 1_000_000, estimated: 1, hasUnpricedUsage: false, models: 1 });
		const cache = JSON.parse(await readFile(cachePath, "utf8"));
		assert.equal(cache.version, 1);
		assert.equal(Object.values(cache.files).length, 1);
	} finally { await rm(root, { recursive: true, force: true }); }
});
