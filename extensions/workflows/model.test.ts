import assert from "node:assert/strict";
import { test } from "node:test";
import {
  accumulateAgentUsage,
  aggregateUsage,
  applySessionCost,
  emptyUsage,
  formatUsage,
  normalizeAgentUsage,
  usageDisclosure,
  workflowRunsCost,
  type AgentRecord,
} from "./model.ts";

const round2 = (value: number) => Math.round(value * 100) / 100;

function usageWithEstimate(total: number) {
  return { cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total } };
}

function reported(amount: number, requestId?: string) {
  return {
    amount,
    currency: "USD",
    source: "openrouter",
    ...(requestId ? { requestId } : {}),
  };
}

function agent(usage: Partial<ReturnType<typeof emptyUsage>>): AgentRecord {
  return {
    id: "a",
    state: "done",
    prompt: "",
    usage: { ...emptyUsage(), ...usage },
  } as unknown as AgentRecord;
}

test("workflow usage prefers a provider-reported charge and suppresses the estimate", () => {
  const usage = emptyUsage();
  accumulateAgentUsage(
    usage,
    { ...usageWithEstimate(1), reportedCost: reported(0.25) },
    "gen-1",
  );
  assert.equal(usage.reportedCost, 0.25);
  assert.equal(usage.estimatedCost, 0);
  assert.equal(usage.cost, 0.25);
  assert.equal(usage.hasReportedCost, true);
  assert.equal(usage.hasEstimatedCost, false);
});

test("workflow usage honors a reported zero and falls back to estimates when absent", () => {
  const free = emptyUsage();
  accumulateAgentUsage(free, {
    ...usageWithEstimate(1),
    reportedCost: reported(0),
  });
  assert.equal(free.reportedCost, 0);
  assert.equal(free.estimatedCost, 0);
  assert.equal(free.hasReportedCost, true);

  const fallback = emptyUsage();
  accumulateAgentUsage(fallback, usageWithEstimate(0.6));
  assert.equal(fallback.reportedCost, 0);
  assert.equal(fallback.estimatedCost, 0.6);
  assert.equal(fallback.hasEstimatedCost, true);
});

test("workflow aggregates keep reported and estimated separate", () => {
  const totals = aggregateUsage([
    agent({ reportedCost: 0.3, hasReportedCost: true, cost: 0.3 }),
    agent({ estimatedCost: 0.2, hasEstimatedCost: true, cost: 0.2 }),
  ]);
  assert.equal(round2(totals.reportedCost), 0.3);
  assert.equal(round2(totals.estimatedCost), 0.2);
  assert.equal(round2(totals.cost), 0.5);

  assert.match(formatUsage(totals), /reported/);
  assert.match(formatUsage(totals), /est/);
  assert.match(
    formatUsage(agent({ estimatedCost: 0.4, hasEstimatedCost: true, cost: 0.4 }).usage),
    /~\$0\.4000/,
  );
});

test("legacy stored usage with only .cost is surfaced as an estimate, not hidden", () => {
  const legacy = normalizeAgentUsage({ input: 10, output: 4, cost: 0.42, turns: 2 });
  assert.equal(legacy.estimatedCost, 0.42);
  assert.equal(legacy.hasEstimatedCost, true);
  assert.equal(legacy.reportedCost, 0);
  assert.equal(legacy.hasReportedCost, false);
  assert.equal(legacy.cost, 0.42);
  assert.equal(legacy.input, 10);
  assert.equal(legacy.turns, 2);
  // The number a legacy run stored is now visible instead of silently dropped.
  assert.match(formatUsage(legacy), /~\$0\.4200/);
});

test("normalizeAgentUsage keeps a reported zero and recomputes a mixed split", () => {
  const free = normalizeAgentUsage({ reportedCost: 0, hasReportedCost: true, cost: 0 });
  assert.equal(free.hasReportedCost, true);
  assert.equal(free.hasEstimatedCost, false);
  assert.equal(free.cost, 0);

  const mixed = normalizeAgentUsage({
    reportedCost: 0.3,
    hasReportedCost: true,
    estimatedCost: 0.2,
    hasEstimatedCost: true,
    cost: 99,
  });
  assert.equal(round2(mixed.reportedCost), 0.3);
  assert.equal(round2(mixed.estimatedCost), 0.2);
  assert.equal(round2(mixed.cost), 0.5);
});

test("normalizeAgentUsage degrades malformed counters to zero", () => {
  const usage = normalizeAgentUsage({
    input: "lots",
    output: Number.NaN,
    cacheRead: -5,
    cost: Number.POSITIVE_INFINITY,
    turns: -3,
    contextTokens: -1,
  });
  assert.deepEqual(usage, emptyUsage());
  assert.deepEqual(normalizeAgentUsage(undefined), emptyUsage());
});

test("aggregateUsage normalizes legacy records so their cost is not dropped", () => {
  const totals = aggregateUsage([agent({ cost: 0.1 }), agent({ cost: 0.2 })]);
  assert.equal(round2(totals.estimatedCost), 0.3);
  assert.equal(totals.hasEstimatedCost, true);
  assert.equal(totals.reportedCost, 0);
  assert.match(formatUsage(totals), /~\$0\.3000/);
});

test("applySessionCost counts charges compaction removed from live context", () => {
  const usage = { ...emptyUsage(), input: 100, turns: 1 };
  applySessionCost(usage, [
    // Still in the live context.
    {
      type: "message",
      message: {
        role: "assistant",
        responseId: "gen-a",
        usage: { ...usageWithEstimate(9), reportedCost: reported(0.4, "gen-a") },
      },
    },
    // Compacted away: absent from session.messages but still in the transcript.
    {
      type: "message",
      message: {
        role: "assistant",
        responseId: "gen-b",
        usage: { ...usageWithEstimate(9), reportedCost: reported(0.25, "gen-b") },
      },
    },
    // The compaction request itself: its charge lives only in the entry.
    { type: "compaction", usage: usageWithEstimate(0.05) },
    { type: "branch_summary", usage: usageWithEstimate(0.02) },
  ]);
  assert.equal(round2(usage.reportedCost), 0.65);
  assert.equal(round2(usage.estimatedCost), 0.07);
  assert.equal(round2(usage.cost), 0.72);
  assert.equal(usage.hasReportedCost, true);
  assert.equal(usage.hasEstimatedCost, true);
  // Context telemetry is untouched by the monetary fold.
  assert.equal(usage.input, 100);
  assert.equal(usage.turns, 1);
});

test("workflowRunsCost is cumulative across runs and keeps the split", () => {
  const disclosure = workflowRunsCost([
    { agents: [agent({ reportedCost: 0.4, hasReportedCost: true, cost: 0.4 })] },
    {
      agents: [
        agent({ estimatedCost: 0.15, hasEstimatedCost: true, cost: 0.15 }),
        // Legacy run: only a combined total, which is a local estimate.
        agent({ cost: 0.05 }),
      ],
    },
  ]);
  assert.equal(round2(disclosure.costUsd ?? -1), 0.6);
  assert.equal(disclosure.reportedCostUsd, 0.4);
  assert.equal(round2(disclosure.estimatedCostUsd ?? -1), 0.2);

  // A run with no monetary usage at all discloses nothing.
  assert.deepEqual(workflowRunsCost([{ agents: [agent({})] }]), {
    costUsd: undefined,
    reportedCostUsd: undefined,
    estimatedCostUsd: undefined,
  });
});

test("usageDisclosure omits buckets it has no evidence for", () => {
  assert.deepEqual(usageDisclosure(emptyUsage()), {});
  assert.deepEqual(
    usageDisclosure({ ...emptyUsage(), reportedCost: 0, hasReportedCost: true }),
    { costUsd: 0, reportedCostUsd: 0 },
  );
});
