import assert from "node:assert/strict";
import test from "node:test";
import { combineSubagentCosts } from "./src/billing.ts";

test("combineSubagentCosts keeps reported and estimated subagent costs separate", () => {
	const totals = combineSubagentCosts([
		{ costUsd: 0.4, reportedCostUsd: 0.4, estimatedCostUsd: 0 },
		{ costUsd: 0.15, estimatedCostUsd: 0.15 },
	]);
	assert.equal(totals.costUsd, 0.55);
	assert.equal(totals.reportedCostUsd, 0.4);
	assert.equal(totals.estimatedCostUsd, 0.15);
});

test("combineSubagentCosts treats a legacy combined cost as estimated and preserves a reported zero", () => {
	const legacy = combineSubagentCosts([{ costUsd: 0.2 }]);
	assert.equal(legacy.costUsd, 0.2);
	assert.equal(legacy.reportedCostUsd, undefined);
	assert.equal(legacy.estimatedCostUsd, 0.2);

	const free = combineSubagentCosts([{ costUsd: 0, reportedCostUsd: 0 }]);
	assert.equal(free.costUsd, 0);
	assert.equal(free.reportedCostUsd, 0);
	assert.equal(free.estimatedCostUsd, undefined);
});

test("combineSubagentCosts reports nothing when no subagent has a known cost", () => {
	const totals = combineSubagentCosts([{}, { tokens: 100 } as never]);
	assert.deepEqual(totals, { costUsd: undefined, reportedCostUsd: undefined, estimatedCostUsd: undefined });
});
