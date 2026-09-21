import assert from "node:assert/strict";
import { test } from "node:test";
import { normalizeDetails } from "./dashboard.ts";
import { aggregateUsage, formatUsage } from "./model.ts";

const round2 = (value: number) => Math.round(value * 100) / 100;

test("a resumed legacy run surfaces its stored .cost as an estimate", () => {
  const details = normalizeDetails("wf_legacy", {
    startedAt: 1,
    agents: [
      {
        index: 1,
        label: "old",
        state: "done",
        usage: { input: 100, output: 20, cost: 0.42, turns: 3 },
      },
    ],
  });
  assert.ok(details);
  const usage = details.agents[0].usage;
  assert.equal(usage.estimatedCost, 0.42);
  assert.equal(usage.hasEstimatedCost, true);
  assert.equal(usage.reportedCost, 0);
  assert.equal(usage.input, 100);
  assert.match(formatUsage(usage), /~\$0\.4200/);
  assert.match(formatUsage(aggregateUsage(details.agents)), /~\$0\.4200/);
});

test("a resumed run mixing legacy and split usage totals safely", () => {
  const details = normalizeDetails("wf_mixed", {
    startedAt: 1,
    agents: [
      { usage: { cost: 0.1 } },
      { usage: { reportedCost: 0.2, hasReportedCost: true, cost: 0.2 } },
      // Malformed counters from a partial write must not poison the total.
      { usage: { estimatedCost: "bad", input: null, turns: -2 } },
      {},
    ],
  });
  assert.ok(details);
  const totals = aggregateUsage(details.agents);
  assert.equal(round2(totals.reportedCost), 0.2);
  assert.equal(round2(totals.estimatedCost), 0.1);
  assert.equal(round2(totals.cost), 0.3);
  const formatted = formatUsage(totals);
  assert.match(formatted, /reported/);
  assert.match(formatted, /est/);
});

test("a run with no readable usage discloses no cost", () => {
  const details = normalizeDetails("wf_empty", { agents: [{}] });
  assert.ok(details);
  const totals = aggregateUsage(details.agents);
  assert.equal(totals.cost, 0);
  assert.equal(totals.hasReportedCost, false);
  assert.equal(totals.hasEstimatedCost, false);
  assert.equal(formatUsage(totals).includes("$"), false);
});
