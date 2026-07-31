import assert from "node:assert/strict";
import { test } from "node:test";
import type { ProviderAccount } from "./domain.ts";
import { DashboardModel } from "./ui/usage-dashboard.ts";
import { validateLabels } from "./ui/account-wizard.ts";
import { frameMenu } from "./ui/frame.ts";

function account(key: string, providerId: string, label: string, active = false): ProviderAccount {
	return { accountKey: key, providerId, label, authType: "oauth", credentialFingerprints: [], archived: false, active, firstSeenAt: 0, lastSeenAt: 0 };
}

test("dashboard orders active account first and keeps browsing separate from model switching", () => {
	const calls: string[] = [];
	const model = new DashboardModel([
		{ account: account("b", "anthropic", "Work"), usage: { status: "live", windows: [] }, cost: { reported: 0, estimated: 0, hasEstimatedUsage: false, hasUnpricedUsage: false, attributedEntries: 0, excludedEntries: 0, pricingSources: [] } },
		{ account: account("a", "openai-codex", "Personal", true), usage: { status: "live", windows: [] }, cost: { reported: 0, estimated: 1, hasEstimatedUsage: true, hasUnpricedUsage: false, attributedEntries: 1, excludedEntries: 0, pricingSources: ["Pi registry"] } },
	], "a", (action) => calls.push(action.type));
	assert.equal(model.selected.account.accountKey, "a");
	model.move(1);
	assert.equal(model.selected.account.accountKey, "b");
	assert.deepEqual(calls, []);
	model.replace("b", { account: account("b", "anthropic", "Renamed"), usage: { status: "stale", windows: [] }, cost: { reported: 0, estimated: 0, hasEstimatedUsage: false, hasUnpricedUsage: false, attributedEntries: 0, excludedEntries: 0, pricingSources: [] } });
	assert.equal(model.selected.account.label, "Renamed");
	model.activate("use");
	assert.deepEqual(calls, ["use"]);
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
