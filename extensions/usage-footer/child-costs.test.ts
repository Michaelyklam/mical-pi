import assert from "node:assert/strict";
import { test } from "node:test";
import { ChildCostTracker } from "./child-costs.ts";

test("child cost events retain separate sources and replace cumulative snapshots", () => {
	const tracker = new ChildCostTracker();
	tracker.update("subagents", { costUsd: 0.7, reportedCostUsd: 0.5, estimatedCostUsd: 0.2 });
	tracker.update("workflows", { costUsd: 1, reportedCostUsd: 1 });
	assert.deepEqual(tracker.total, { costUsd: 1.7, reportedCostUsd: 1.5, estimatedCostUsd: 0.2 });
	tracker.update("workflows", { costUsd: 2, reportedCostUsd: 2 });
	assert.deepEqual(tracker.total, { costUsd: 2.7, reportedCostUsd: 2.5, estimatedCostUsd: 0.2 });
	tracker.update("workflows", {});
	assert.deepEqual(tracker.total, { costUsd: 0.7, reportedCostUsd: 0.5, estimatedCostUsd: 0.2 });
	tracker.clear();
	assert.equal(tracker.total.costUsd, undefined);
});

test("legacy child cost is estimated, reported zero is retained, invalid numbers are ignored", () => {
	const tracker = new ChildCostTracker();
	tracker.update("subagents", { costUsd: 0.4 });
	tracker.update("workflows", { costUsd: 0, reportedCostUsd: 0 });
	assert.deepEqual({ ...tracker.total }, { costUsd: 0.4, reportedCostUsd: 0, estimatedCostUsd: 0.4 });
	tracker.update("subagents", { costUsd: NaN, estimatedCostUsd: -5 });
	assert.deepEqual({ ...tracker.total }, { costUsd: 0, reportedCostUsd: 0, estimatedCostUsd: undefined });
	tracker.update("workflows", null);
	assert.equal(tracker.total.costUsd, undefined);
});
