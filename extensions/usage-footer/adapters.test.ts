import assert from "node:assert/strict";
import { test } from "node:test";
import { normalizeAnthropicProfile, normalizeAnthropicUsage } from "./adapters/anthropic.ts";
import { normalizeCodexAccount, normalizeCodexUsage } from "./adapters/codex.ts";

const now = Date.parse("2026-07-30T12:00:00Z");

test("Anthropic normalizes identity, primary windows, and provider spend", () => {
	const profile = normalizeAnthropicProfile({
		account: { uuid: "account-1", display_name: "Michael" },
		organization: { uuid: "org-1", name: "Verkada Eng" },
	});
	assert.deepEqual(profile, { stableIdentity: "org-1/account-1", suggestedLabel: "Verkada Eng" });
	const result = normalizeAnthropicUsage({
		five_hour: { utilization: 43, resets_at: "2026-07-30T14:00:00Z" },
		seven_day: { utilization: 18, resets_at: "2026-08-03T00:00:00Z" },
		spend: { enabled: true, percent: 10, used: { amount_minor: 1234, currency: "USD", exponent: 2 } },
	}, now);
	assert.deepEqual(result.windows.map((window) => [window.label, window.usedPercent]), [["5h", 43], ["7d", 18]]);
	assert.equal(result.accountSpend?.amount, 12.34);
});

test("Anthropic uses monthly spend as Usage when rolling windows are absent", () => {
	const result = normalizeAnthropicUsage({
		five_hour: null,
		seven_day: null,
		spend: { enabled: true, percent: 100, used: { amount_minor: 150006, currency: "USD", exponent: 2 } },
	}, now);
	assert.deepEqual(result.windows.map((window) => [window.label, window.usedPercent, window.kind]), [["month", 100, "spend"]]);
});

test("Codex chooses the main account windows and account-wide daily tokens", () => {
	const account = normalizeCodexAccount({ account: { type: "chatgpt", email: "person@example.com", planType: "pro" } }, "account-id");
	assert.equal(account.stableIdentity, "account-id");
	assert.equal(account.suggestedLabel, "person");
	const result = normalizeCodexUsage({
		rateLimits: {
			limitId: "codex",
			primary: { usedPercent: 4, windowDurationMins: 10080, resetsAt: 1785913834 },
			secondary: { usedPercent: 20, windowDurationMins: 300, resetsAt: 1785450000 },
		},
		rateLimitsByLimitId: {
			codex_model: { limitId: "codex_model", limitName: "Model", primary: { usedPercent: 50, windowDurationMins: 10080, resetsAt: 1 } },
		},
	}, { dailyUsageBuckets: [{ startDate: "2026-07-30", tokens: 90077 }] }, "2026-07-30", now);
	assert.deepEqual(result.windows.slice(0, 2).map((window) => [window.label, window.usedPercent]), [["7d", 4], ["5h", 20]]);
	assert.equal(result.accountTodayTokens, 90077);
	assert.equal((result.diagnostics?.modelWindows as unknown[]).length, 1);
});
