import assert from "node:assert/strict";
import { test } from "node:test";
import {
	accumulateCost,
	billingComponents,
	combineCostDisclosures,
	emptyCostTotals,
	estimateFromUsage,
	readReportedCost,
	summarizeSessionEntries,
} from "./billing.ts";

function usageWithEstimate(total: number) {
	return { cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total } };
}

test("readReportedCost reads the patched OpenRouter charge and keeps provenance", () => {
	const usage = {
		...usageWithEstimate(9),
		reportedCost: { amount: 0.0042, currency: "USD", source: "openrouter", upstreamInferenceCost: 0.004 },
	};
	const reported = readReportedCost(usage, "gen-abc");
	assert.deepEqual(reported, {
		amount: 0.0042,
		currency: "USD",
		source: "openrouter",
		upstreamInferenceCost: 0.004,
		requestId: "gen-abc",
	});
});

test("readReportedCost honors a reported zero and never invents a charge from usage.cost", () => {
	const free = { ...usageWithEstimate(0), reportedCost: { amount: 0, currency: "USD", source: "openrouter" } };
	assert.equal(readReportedCost(free)?.amount, 0);
	// A local estimate on usage.cost is not a provider report.
	assert.equal(readReportedCost(usageWithEstimate(3)), undefined);
	assert.equal(readReportedCost(undefined), undefined);
	assert.equal(readReportedCost({ reportedCost: { amount: "1.2" } }), undefined);
});

test("accumulateCost lets reported cost suppress the estimate, including reported zero", () => {
	const reported = emptyCostTotals();
	accumulateCost(
		reported,
		{ ...usageWithEstimate(5), reportedCost: { amount: 1.25, currency: "USD", source: "openrouter" } },
		"gen-1",
	);
	assert.equal(reported.reported, 1.25);
	assert.equal(reported.estimated, 0);
	assert.equal(reported.total, 1.25);
	assert.equal(reported.hasReportedUsage, true);
	assert.equal(reported.hasEstimatedUsage, false);
	assert.deepEqual(reported.reportedRequestIds, ["gen-1"]);
	assert.deepEqual(reported.reportedSources, ["openrouter"]);

	const free = emptyCostTotals();
	accumulateCost(free, { ...usageWithEstimate(5), reportedCost: { amount: 0, currency: "USD", source: "openrouter" } });
	assert.equal(free.reported, 0);
	assert.equal(free.estimated, 0);
	assert.equal(free.total, 0);
	assert.equal(free.hasReportedUsage, true);

	const fallback = emptyCostTotals();
	accumulateCost(fallback, usageWithEstimate(2.5));
	assert.equal(fallback.reported, 0);
	assert.equal(fallback.estimated, 2.5);
	assert.equal(fallback.hasReportedUsage, false);
	assert.equal(fallback.hasEstimatedUsage, true);
});

test("accumulateCost does not convert a non-USD report; it falls back to the estimate", () => {
	const totals = emptyCostTotals();
	accumulateCost(totals, { ...usageWithEstimate(4), reportedCost: { amount: 3, currency: "EUR", source: "router" } });
	assert.equal(totals.reported, 0);
	assert.equal(totals.estimated, 4);
	assert.equal(totals.hasReportedUsage, false);
});

test("accumulateCost accounts a merged usage per call instead of the merged estimate", () => {
	const totals = emptyCostTotals();
	accumulateCost(totals, {
		...usageWithEstimate(0.0003),
		billingComponents: [
			{ ...usageWithEstimate(0.25), reportedCost: { amount: 0.25, currency: "USD", source: "openrouter" } },
			usageWithEstimate(0.1),
		],
	});
	assert.equal(totals.reported, 0.25);
	assert.equal(totals.estimated, 0.1, "the merged estimate must not be used as a whole");
	assert.equal(totals.total, 0.35);
	assert.equal(totals.hasReportedUsage, true);
	assert.equal(totals.hasEstimatedUsage, true);
});

test("accumulateCost sums two reported calls in a merge without estimating either", () => {
	const totals = emptyCostTotals();
	accumulateCost(totals, {
		...usageWithEstimate(0.0003),
		billingComponents: [
			{ ...usageWithEstimate(0.25), reportedCost: { amount: 0.25, currency: "USD", source: "openrouter" } },
			{ ...usageWithEstimate(0.1), reportedCost: { amount: 0.1, currency: "USD", source: "openrouter" } },
		],
	});
	assert.equal(totals.reported, 0.35);
	assert.equal(totals.estimated, 0);
});

test("billingComponents flattens nested merges and ignores an empty list", () => {
	const leafA = { cost: { total: 1 } };
	const leafB = { cost: { total: 2 } };
	const inner = { cost: { total: 3 }, billingComponents: [leafA, leafB] };
	const outer = { cost: { total: 3 }, billingComponents: [inner] };
	assert.deepEqual(billingComponents(outer), [leafA, leafB]);
	assert.equal(billingComponents({ billingComponents: [] }), undefined);
	assert.equal(billingComponents({ cost: { total: 1 } }), undefined);
	assert.equal(billingComponents(undefined), undefined);
});

test("summarizeSessionEntries separates reported and estimated across mixed and resumed sessions", () => {
	const totals = summarizeSessionEntries([
		{
			type: "message",
			message: {
				role: "assistant",
				responseId: "gen-1",
				usage: { ...usageWithEstimate(0.5), reportedCost: { amount: 0.3, currency: "USD", source: "openrouter" } },
			},
		},
		// Legacy/resumed entry with no reported charge falls back to the estimate.
		{ type: "message", message: { role: "assistant", usage: usageWithEstimate(0.2) } },
		{ type: "compaction", usage: usageWithEstimate(0.1) },
		{ type: "message", message: { role: "toolResult", usage: usageWithEstimate(0.05) } },
		{ type: "message", message: { role: "user" } },
	]);
	assert.equal(Math.round(totals.reported * 100) / 100, 0.3);
	assert.equal(Math.round(totals.estimated * 100) / 100, 0.35);
	assert.equal(totals.hasReportedUsage, true);
	assert.equal(totals.hasEstimatedUsage, true);
	assert.equal(totals.reportedEntries, 1);
	assert.equal(totals.estimatedEntries, 3);
	assert.deepEqual(totals.reportedRequestIds, ["gen-1"]);
});

test("estimateFromUsage ignores missing or malformed estimates", () => {
	assert.equal(estimateFromUsage(usageWithEstimate(1.5)), 1.5);
	assert.equal(estimateFromUsage({}), undefined);
	assert.equal(estimateFromUsage({ cost: {} }), undefined);
	assert.equal(estimateFromUsage({ cost: { total: Number.NaN } }), undefined);
});

test("readReportedCost prefers an explicit request id, then one on the usage object", () => {
	const nested = {
		...usageWithEstimate(1),
		reportedCost: { amount: 0.5, currency: "USD", source: "openrouter", requestId: "gen-nested" },
	};
	assert.equal(readReportedCost(nested)?.requestId, "gen-nested");
	assert.equal(readReportedCost(nested, "gen-explicit")?.requestId, "gen-explicit");
	// An empty nested id is not an id.
	const blank = { reportedCost: { amount: 0.5, currency: "USD", source: "openrouter", requestId: "" } };
	const reported = readReportedCost(blank);
	assert.ok(reported);
	assert.equal("requestId" in reported, false);
});

test("readReportedCost rejects negative amounts instead of treating them as credits", () => {
	assert.equal(readReportedCost({ reportedCost: { amount: -1, currency: "USD", source: "openrouter" } }), undefined);
	const totals = emptyCostTotals();
	accumulateCost(totals, {
		...usageWithEstimate(2),
		reportedCost: { amount: -3, currency: "USD", source: "openrouter" },
	});
	assert.equal(totals.reported, 0);
	assert.equal(totals.hasReportedUsage, false);
	assert.equal(totals.estimated, 2);
});

test("summarizeSessionEntries keeps a request id nested on the usage object", () => {
	const totals = summarizeSessionEntries([
		{
			type: "compaction",
			usage: {
				...usageWithEstimate(0),
				reportedCost: { amount: 0.1, currency: "USD", source: "openrouter", requestId: "gen-nested" },
			},
		},
	]);
	assert.deepEqual(totals.reportedRequestIds, ["gen-nested"]);
});

test("combineCostDisclosures sums the split and treats a split-less total as estimated", () => {
	const totals = combineCostDisclosures([
		{ costUsd: 0.4, reportedCostUsd: 0.4, estimatedCostUsd: 0 },
		{ costUsd: 0.15, estimatedCostUsd: 0.15 },
		{ costUsd: 0.05 },
	]);
	assert.equal(Math.round((totals.costUsd ?? 0) * 100) / 100, 0.6);
	assert.equal(totals.reportedCostUsd, 0.4);
	assert.equal(Math.round((totals.estimatedCostUsd ?? 0) * 100) / 100, 0.2);
	assert.deepEqual(combineCostDisclosures([{}]), {
		costUsd: undefined,
		reportedCostUsd: undefined,
		estimatedCostUsd: undefined,
	});
});
