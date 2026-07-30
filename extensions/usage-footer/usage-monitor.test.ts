import assert from "node:assert/strict";
import { test } from "node:test";
import type { ProviderAccount, ProviderUsageSnapshot } from "./domain.ts";
import { UsageMonitor } from "./usage-monitor.ts";

const account: ProviderAccount = {
	accountKey: "openai-codex:personal",
	providerId: "openai-codex",
	authType: "oauth",
	credentialFingerprints: [],
	label: "personal",
	archived: false,
	active: true,
	firstSeenAt: 0,
	lastSeenAt: 0,
};

function snapshot(at: number): ProviderUsageSnapshot {
	return { fetchedAt: at, sourceLabel: "provider", windows: [{ id: "w", label: "5h", usedPercent: 43, resetsAt: at + 3_600_000, kind: "primary" }] };
}

test("Usage Monitor reuses fresh shared data and refreshes after 60 seconds", async () => {
	let now = 1_000_000;
	let calls = 0;
	const cache = new Map([[account.accountKey, snapshot(now)]]);
	const monitor = new UsageMonitor({
		now: () => now,
		fetch: async () => { calls++; return snapshot(now); },
		local: async () => ({ tokens: 10, estimated: 1, hasUnpricedUsage: false, models: 1 }),
		load: async (key) => cache.get(key),
		save: async (key, value) => { cache.set(key, value); },
	});
	await monitor.refresh(account);
	assert.equal(calls, 0);
	assert.equal(monitor.get(account.accountKey).status, "live");
	await monitor.refresh(account, { force: true });
	assert.equal(calls, 1);
	now += 60_001;
	await monitor.refresh(account);
	assert.equal(calls, 2);
});

test("Usage Monitor marks failed global data stale then falls back locally after 30 minutes", async () => {
	let now = 1_000_000;
	const old = snapshot(now);
	old.windows[0]!.resetsAt = now + 10_000_000;
	const monitor = new UsageMonitor({
		now: () => now,
		fetch: async () => { throw new Error("offline token=secret"); },
		local: async () => ({ tokens: 99, estimated: 2, hasUnpricedUsage: false, models: 1 }),
		load: async () => old,
		save: async () => {},
	});
	now += 61_000;
	await monitor.refresh(account, { force: true });
	assert.equal(monitor.get(account.accountKey).status, "stale");
	assert.doesNotMatch(monitor.get(account.accountKey).lastError ?? "", /secret/);
	now += 30 * 60_000;
	await monitor.refresh(account, { force: true });
	const fallback = monitor.get(account.accountKey);
	assert.equal(fallback.status, "local");
	assert.equal(fallback.local?.tokens, 99);
});

test("Usage Monitor invalidates a provider window after reset", async () => {
	let now = 1_000_000;
	const expired = snapshot(now - 120_000);
	expired.windows[0]!.resetsAt = now - 1;
	const monitor = new UsageMonitor({
		now: () => now,
		fetch: async () => { throw new Error("offline"); },
		local: async () => ({ tokens: 7, estimated: 0, hasUnpricedUsage: true, models: 1 }),
		load: async () => expired,
		save: async () => {},
	});
	await monitor.refresh(account, { force: true });
	assert.equal(monitor.get(account.accountKey).status, "local");
});
