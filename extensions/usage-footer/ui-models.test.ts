import assert from "node:assert/strict";
import { test } from "node:test";
import type { ProviderAccount, SessionCostSummary } from "./domain.ts";
import { DashboardModel, detailLines } from "./ui/usage-dashboard.ts";
import { formatLocalCost, formatUsd } from "./ui/format-money.ts";
import { validateLabels } from "./ui/account-wizard.ts";
import { frameMenu } from "./ui/frame.ts";

function account(key: string, providerId: string, label: string, active = false): ProviderAccount {
	return { accountKey: key, providerId, label, authType: "oauth", credentialFingerprints: [], archived: false, active, firstSeenAt: 0, lastSeenAt: 0 };
}

function cost(overrides: Partial<SessionCostSummary> = {}): SessionCostSummary {
	return {
		reported: 0,
		estimated: 0,
		hasReportedUsage: false,
		hasEstimatedUsage: false,
		hasUnpricedUsage: false,
		reportedEntries: 0,
		estimatedEntries: 0,
		attributedEntries: 0,
		excludedEntries: 0,
		pricingSources: [],
		reportedSources: [],
		reportedRequestIds: [],
		...overrides,
	};
}

test("dashboard orders active account first and keeps browsing separate from model switching", () => {
	const calls: string[] = [];
	const model = new DashboardModel([
		{ account: account("b", "anthropic", "Work"), usage: { status: "live", windows: [] }, cost: cost() },
		{ account: account("a", "openai-codex", "Personal", true), usage: { status: "live", windows: [] }, cost: cost({ estimated: 1, hasEstimatedUsage: true, attributedEntries: 1, pricingSources: ["Pi registry"] }) },
	], "a", (action) => calls.push(action.type));
	assert.equal(model.selected.account.accountKey, "a");
	model.move(1);
	assert.equal(model.selected.account.accountKey, "b");
	assert.deepEqual(calls, []);
	model.replace("b", { account: account("b", "anthropic", "Renamed"), usage: { status: "stale", windows: [] }, cost: cost() });
	assert.equal(model.selected.account.label, "Renamed");
	model.activate("use");
	assert.deepEqual(calls, ["use"]);
});

test("dashboard distinguishes zero reported cost from absent charges and shows provenance", () => {
	const theme = { fg: (_role: string, text: string) => text, bold: (text: string) => text };
	const entry = { account: account("router", "openrouter", "API"), usage: { status: "live" as const, windows: [] }, cost: cost() };
	assert.match(detailLines(entry, theme).join("\n"), /Reported cost: —/);
	entry.cost = cost({ hasReportedUsage: true, reportedEntries: 1, reportedSources: ["openrouter"], reportedRequestIds: ["gen-test"] });
	const rendered = detailLines(entry, theme).join("\n");
	assert.match(rendered, /Reported cost: \$0\.00/);
	assert.match(rendered, /Reported by: openrouter · 1 charges · 1 request IDs/);
	assert.equal(formatUsd(0.000364), "$0.000364");
	assert.equal(formatUsd(0.0000001), "<$0.000001");
	assert.equal(formatUsd(0), "$0.00");
});

test("local-today cost preserves reported charges and estimates only missing observations", () => {
	const local = { tokens: 100, models: 1, estimated: 0, reported: 0.004, hasReportedUsage: true, hasUnpricedUsage: false };
	assert.equal(formatLocalCost(local), "$0.004 reported");
	assert.equal(formatLocalCost({ ...local, estimated: 0.003 }), "$0.004 reported + ~$0.003 est");
	assert.equal(formatLocalCost({ ...local, reported: 0 }), "$0.00 reported");
	assert.equal(formatLocalCost({ ...local, hasUnpricedUsage: true, hasEstimatedUsage: true }), "$0.004 reported + est n/a");
});

test("dashboard frame draws a full-width themed border", () => {
	const theme = { fg: (_role: string, text: string) => text, bold: (text: string) => text };
	assert.deepEqual(frameMenu(["Usage", "body"], 10, theme), [
		"┌────────┐",
		"│Usage   │",
		"│body    │",
		"└────────┘",
	]);
});

test("wizard validation requires gateway labels and provider-local uniqueness", () => {
	const rows = [
		{ accountKey: "one", providerId: "verkada", authType: "api_key" as const, label: "" },
		{ accountKey: "two", providerId: "verkada", authType: "api_key" as const, label: "gateway" },
	];
	assert.match(validateLabels(rows) ?? "", /required/i);
	rows[0]!.label = "gateway";
	assert.match(validateLabels(rows) ?? "", /unique/i);
	rows[0]!.label = "other";
	assert.equal(validateLabels(rows), undefined);
});
