/**
 * Shared workflow run model + formatting helpers, used by the tool renderers
 * (index.ts) and the /workflows dashboard (dashboard.ts).
 */

import * as os from "node:os";
import {
  truncateHead,
  type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { combineCostDisclosures, estimateFromUsage, readReportedCost, summarizeSessionEntries, type CostDisclosure, type CostEntryLike } from "../shared/billing.ts";
import { formatContextUtilization } from "../shared/context-utilization.ts";
import { safeStringify } from "./serialization.ts";

export type Theme = ExtensionContext["ui"]["theme"];

export const RESULT_JSON_MAX_BYTES = 24 * 1024;
export const RESULT_JSON_MAX_LINES = 600;

export interface AgentUsage {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  /** Best-available total: reported where available, otherwise estimated. */
  cost: number;
  /** Provider-reported portion of cost, when the child provider reports a charge. */
  reportedCost: number;
  /** Locally estimated portion of cost for usage with no reported charge. */
  estimatedCost: number;
  /** True when at least one provider-reported charge was seen, even a reported zero. */
  hasReportedCost: boolean;
  /** True when at least one entry fell back to a local estimate. */
  hasEstimatedCost: boolean;
  /** Latest compaction-aware conversation occupancy, not cumulative billing. */
  contextTokens?: number;
  turns: number;
}

export function emptyUsage(): AgentUsage {
  return {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    cost: 0,
    reportedCost: 0,
    estimatedCost: 0,
    hasReportedCost: false,
    hasEstimatedCost: false,
    turns: 0,
  };
}

/** Coerce an unknown counter to a finite, non-negative number. */
function count(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? value
    : 0;
}

/**
 * Rebuild an `AgentUsage` from persisted JSON. Runs written before the
 * reported/estimated split stored only `.cost`, calculated from Pi's local
 * pricing; those are surfaced as estimates so the number is not hidden by
 * absent flags. Missing or malformed counters degrade to zero.
 */
export function normalizeAgentUsage(value: unknown): AgentUsage {
  const usage = emptyUsage();
  if (!value || typeof value !== "object") return usage;
  const raw = value as Record<string, unknown>;
  usage.input = count(raw.input);
  usage.output = count(raw.output);
  usage.cacheRead = count(raw.cacheRead);
  usage.cacheWrite = count(raw.cacheWrite);
  usage.turns = count(raw.turns);
  usage.reportedCost = count(raw.reportedCost);
  usage.estimatedCost = count(raw.estimatedCost);
  usage.hasReportedCost = raw.hasReportedCost === true;
  usage.hasEstimatedCost = raw.hasEstimatedCost === true;
  usage.cost = count(raw.cost);
  if (typeof raw.contextTokens === "number" && Number.isFinite(raw.contextTokens) && raw.contextTokens >= 0) {
    usage.contextTokens = raw.contextTokens;
  }
  const split = usage.reportedCost + usage.estimatedCost;
  if (split === 0 && usage.cost > 0) {
    usage.estimatedCost = usage.cost;
    usage.hasEstimatedCost = true;
  } else if (split > 0) {
    usage.cost = split;
  }
  return usage;
}

/**
 * Fold one assistant message's usage into a workflow agent total. A
 * provider-reported charge takes precedence over the local estimate for the
 * same message; a reported zero stays reported and suppresses the estimate.
 */
export function accumulateAgentUsage(
  usage: AgentUsage,
  messageUsage: unknown,
  requestId?: string,
): void {
  const reported = readReportedCost(messageUsage, requestId);
  if (reported && reported.currency === "USD") {
    usage.reportedCost += reported.amount;
    usage.hasReportedCost = true;
  } else {
    const estimate = estimateFromUsage(messageUsage);
    if (estimate !== undefined) {
      usage.estimatedCost += estimate;
      usage.hasEstimatedCost = true;
    }
  }
  usage.cost = usage.reportedCost + usage.estimatedCost;
}

/**
 * Replace the monetary portion of `usage` with transcript totals. Tokens,
 * turns, and context occupancy stay whatever the caller accumulated from live
 * context; money is cumulative over the whole transcript, so compaction cannot
 * erase charges already incurred and compaction summaries still count.
 */
export function applySessionCost(
  usage: AgentUsage,
  entries: readonly CostEntryLike[],
): void {
  const totals = summarizeSessionEntries(entries);
  usage.reportedCost = totals.reported;
  usage.estimatedCost = totals.estimated;
  usage.cost = totals.total;
  usage.hasReportedCost = totals.hasReportedUsage;
  usage.hasEstimatedCost = totals.hasEstimatedUsage;
}

export type AgentState = "running" | "done" | "error";
export type WorkflowStatus = "running" | "completed" | "failed" | "aborted";

export type TranscriptRole =
  "user" | "assistant" | "thinking" | "tool" | "toolResult";

export interface TranscriptEntry {
  role: TranscriptRole;
  text: string;
  /** Tool name for tool calls/results. */
  name?: string;
  /** Stable tool-call identifier used to pair calls, results, and timings. */
  toolCallId?: string;
  isError?: boolean;
  /** Original message timestamp, when provided by the model/session. */
  timestamp?: number;
  /** Tool execution lifecycle timestamps, measured by the child session. */
  startedAt?: number;
  finishedAt?: number;
  durationMs?: number;
}

export interface AgentRecord {
  index: number;
  label: string;
  phase?: string;
  state: AgentState;
  model?: string;
  /** Context capacity of the active model used for this agent. */
  contextWindow?: number;
  startedAt: number;
  finishedAt?: number;
  error?: string;
  preview: string;
  usage: AgentUsage;
  /** Normalized, serializable subagent conversation shown by /workflows. */
  transcript: TranscriptEntry[];
}

export interface WorkflowDetails {
  runId: string;
  /** Pi session that launched this run. */
  sessionId?: string;
  name?: string;
  description?: string;
  background: boolean;
  status: WorkflowStatus;
  startedAt: number;
  finishedAt?: number;
  phases: { title: string; detail?: string }[];
  currentPhase?: string;
  agents: AgentRecord[];
  result?: unknown;
  resultArtifact?: string;
  transcriptArtifact?: string;
  error?: string;
}

/** Colored square state indicator (no emojis/glyphs). */
export const SQUARE = "■";

export function stateSquare(state: AgentState, theme: Theme): string {
  if (state === "done") return theme.fg("success", SQUARE);
  if (state === "error") return theme.fg("error", SQUARE);
  return theme.fg("warning", SQUARE);
}

export function statusSquare(status: WorkflowStatus, theme: Theme): string {
  if (status === "completed") return theme.fg("success", SQUARE);
  if (status === "running") return theme.fg("warning", SQUARE);
  return theme.fg("error", SQUARE);
}

export function statusWord(status: WorkflowStatus): string {
  return status === "completed" ? "done" : status;
}

export function statusColor(
  status: WorkflowStatus,
): "success" | "warning" | "error" {
  if (status === "completed") return "success";
  if (status === "running") return "warning";
  return "error";
}

export function shortenHome(p: string): string {
  const home = os.homedir();
  return p.startsWith(home) ? `~${p.slice(home.length)}` : p;
}

export function formatTokens(count: number): string {
  if (count < 1000) return count.toString();
  if (count < 10000) return `${(count / 1000).toFixed(1)}k`;
  if (count < 1000000) return `${Math.round(count / 1000)}k`;
  return `${(count / 1000000).toFixed(1)}M`;
}

export function formatUsage(usage: AgentUsage, model?: string): string {
  const parts: string[] = [];
  if (usage.turns)
    parts.push(`${usage.turns} turn${usage.turns > 1 ? "s" : ""}`);
  if (usage.input) parts.push(`${formatTokens(usage.input)} in`);
  if (usage.output) parts.push(`${formatTokens(usage.output)} out`);
  parts.push(...formatCost(usage));
  if (model) parts.push(model);
  return parts.join(" · ");
}

/** Keep provider-reported and estimated workflow costs visually distinct. */
function formatCost(usage: AgentUsage): string[] {
  const reported = count(usage.reportedCost);
  const estimated = count(usage.estimatedCost);
  if (usage.hasReportedCost && usage.hasEstimatedCost)
    return [`$${reported.toFixed(4)} reported`, `~$${estimated.toFixed(4)} est`];
  if (usage.hasReportedCost) return [`$${reported.toFixed(4)}`];
  if (usage.hasEstimatedCost) return [`~$${estimated.toFixed(4)}`];
  return [];
}

/** Current per-agent context-window utilization, e.g. "7%/372k". */
export function agentContext(agent: AgentRecord): string {
  return formatContextUtilization({
    tokens: agent.usage.contextTokens,
    contextWindow: agent.contextWindow,
  });
}

export function formatElapsed(startedAt: number, finishedAt?: number): string {
  const totalSeconds = Math.max(
    0,
    Math.round(((finishedAt ?? Date.now()) - startedAt) / 1000),
  );
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return minutes > 0
    ? `${minutes}m${seconds.toString().padStart(2, "0")}s`
    : `${seconds}s`;
}

/** Project an `AgentUsage` onto the shared reported/estimated disclosure. */
export function usageDisclosure(usage: AgentUsage): CostDisclosure {
  const split = usage.hasReportedCost || usage.hasEstimatedCost;
  return {
    ...(split ? { costUsd: usage.reportedCost + usage.estimatedCost } : {}),
    ...(usage.hasReportedCost ? { reportedCostUsd: usage.reportedCost } : {}),
    ...(usage.hasEstimatedCost ? { estimatedCostUsd: usage.estimatedCost } : {}),
  };
}

/**
 * Cumulative workflow cost disclosure across every run tracked in a session.
 * Callers pass the live run map; the result is what the workflow-cost event
 * reports so listeners can sum it with subagent costs without double counting.
 */
export function workflowRunsCost(
  runs: Iterable<Pick<WorkflowDetails, "agents">>,
): CostDisclosure {
  const disclosures: CostDisclosure[] = [];
  for (const run of runs) {
    disclosures.push(usageDisclosure(aggregateUsage(run.agents)));
  }
  return combineCostDisclosures(disclosures);
}

export function aggregateUsage(agents: AgentRecord[]): AgentUsage {
  const total = emptyUsage();
  for (const agent of agents) {
    const usage = normalizeAgentUsage(agent.usage);
    total.input += usage.input;
    total.output += usage.output;
    total.cacheRead += usage.cacheRead;
    total.cacheWrite += usage.cacheWrite;
    total.reportedCost += usage.reportedCost;
    total.estimatedCost += usage.estimatedCost;
    total.hasReportedCost ||= usage.hasReportedCost;
    total.hasEstimatedCost ||= usage.hasEstimatedCost;
    total.turns += usage.turns;
  }
  total.cost = total.reportedCost + total.estimatedCost;
  return total;
}

export function countStates(details: WorkflowDetails) {
  let done = 0;
  let failed = 0;
  let running = 0;
  for (const agent of details.agents) {
    if (agent.state === "done") done++;
    else if (agent.state === "error") failed++;
    else running++;
  }
  return { done, failed, running };
}

export interface PhaseGroup {
  title: string;
  agents: AgentRecord[];
}

/**
 * Group agents by phase in declared phase order. With `includeEmpty`, phases
 * that have no agents yet are still listed (used by the dashboard sidebar).
 */
export function phaseGroups(
  details: WorkflowDetails,
  includeEmpty = false,
): PhaseGroup[] {
  const byPhase = new Map<string, AgentRecord[]>();
  for (const agent of details.agents) {
    const key = agent.phase ?? "(unphased)";
    const list = byPhase.get(key) ?? [];
    list.push(agent);
    byPhase.set(key, list);
  }
  const groups: PhaseGroup[] = [];
  for (const phase of details.phases) {
    const agents = byPhase.get(phase.title);
    if (agents || includeEmpty)
      groups.push({ title: phase.title, agents: agents ?? [] });
    byPhase.delete(phase.title);
  }
  for (const [title, agents] of byPhase) groups.push({ title, agents });
  return groups;
}

export function resultJson(value: unknown): string {
  const text =
    typeof value === "string"
      ? value
      : safeStringify(value, {
          maxBytes: RESULT_JSON_MAX_BYTES * 2,
          maxDepth: 16,
          maxNodes: 10_000,
        });
  const truncation = truncateHead(text ?? "", {
    maxLines: RESULT_JSON_MAX_LINES,
    maxBytes: RESULT_JSON_MAX_BYTES,
  });
  return truncation.truncated
    ? `${truncation.content}\n…[result truncated; bounded result artifact in result.json]`
    : truncation.content;
}
