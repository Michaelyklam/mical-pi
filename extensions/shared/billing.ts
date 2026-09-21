/**
 * Monetary cost accounting shared by the usage footer, subagents, and
 * workflows.
 *
 * Pi's request parsers historically discarded provider-reported router charges
 * (for example OpenRouter's `usage.cost`) and kept only a locally calculated
 * estimate on `usage.cost`. A maintained patch to pi-ai
 * (`scripts/patch-pi-ai-openrouter-cost.mjs`) preserves the upstream charge on
 * `usage.reportedCost`. This module is the single reader and aggregator so all
 * three consumers agree on provenance.
 *
 * Provider-reported and estimated amounts are never merged. A reported zero is
 * authoritative (a genuinely free request) and must not be replaced by an
 * estimate; a missing reported charge falls back to the estimate.
 */

/** Field the pi-ai patch writes; see scripts/patch-pi-ai-openrouter-cost.mjs. */
export const REPORTED_COST_FIELD = "reportedCost";

/**
 * Field the pi-coding-agent patch writes on a combined usage; see
 * scripts/patch-pi-coding-agent-compaction-cost.mjs. A split compaction makes
 * two summarization calls and merges them into one usage, which would otherwise
 * drop the provider charges. Each call is preserved here so accounting can
 * still see the reported portion per call.
 */
export const BILLING_COMPONENTS_FIELD = "billingComponents";

/**
 * Event a subagent tracker emits with its cumulative `CostDisclosure` payload.
 * Kept here so producers and consumers share one spelling.
 */
export const SUBAGENT_COST_EVENT = "mical:subagent-cost";

/**
 * Event a workflow tracker emits with its cumulative `CostDisclosure` payload.
 * Distinct from `SUBAGENT_COST_EVENT` so a listener can sum both sources
 * without double counting.
 */
export const WORKFLOW_COST_EVENT = "mical:workflow-cost";

/**
 * A charge reported by the upstream company's own billing or usage system.
 * `amount` is the total charged to the provider account in `currency`.
 */
export interface ReportedCost {
	amount: number;
	currency: string;
	/** Stable provenance of the report, e.g. "openrouter". Not a display label. */
	source: string;
	/** Provider request/generation id when the provider exposes one. */
	requestId?: string;
	/** BYOK upstream inference cost when the provider reports it separately. */
	upstreamInferenceCost?: number;
}

/**
 * A combined cost plus its reported/estimated split. Shared by the
 * `mical:subagent-cost` event payload and workflow aggregates so consumers do
 * not re-derive provenance.
 */
export interface CostDisclosure {
	/** Best-available total: reported where available, otherwise estimated. */
	costUsd?: number;
	/** Provider-reported portion, when a provider reports a charge. */
	reportedCostUsd?: number;
	/** Locally estimated portion for usage with no reported charge. */
	estimatedCostUsd?: number;
}

export interface CostTotals {
	/** Sum of provider-reported charges in USD. */
	reported: number;
	/** Sum of locally estimated charges in USD, only for entries without a reported charge. */
	estimated: number;
	/** `reported + estimated`; the best available total. */
	total: number;
	/** True when at least one reported charge was observed, even if it was zero. */
	hasReportedUsage: boolean;
	/** True when at least one entry fell back to a local estimate. */
	hasEstimatedUsage: boolean;
	reportedEntries: number;
	estimatedEntries: number;
	/** Request ids paired with reported charges, when the provider exposed them. */
	reportedRequestIds: string[];
	/** Provenance tags of reported charges, e.g. ["openrouter"]. */
	reportedSources: string[];
}

export function emptyCostTotals(): CostTotals {
	return {
		reported: 0,
		estimated: 0,
		total: 0,
		hasReportedUsage: false,
		hasEstimatedUsage: false,
		reportedEntries: 0,
		estimatedEntries: 0,
		reportedRequestIds: [],
		reportedSources: [],
	};
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

function finiteNonNegative(value: unknown): value is number {
	return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

/**
 * Read the provider-reported charge from a usage object, never inventing one
 * from generic `usage.cost` (which is a local estimate) or balance deltas.
 * Returns undefined when the provider did not report a charge.
 */
export function readReportedCost(usage: unknown, requestId?: string): ReportedCost | undefined {
	if (!isRecord(usage)) return undefined;
	const raw = usage[REPORTED_COST_FIELD];
	if (!isRecord(raw)) return undefined;
	const amount = raw.amount;
	if (!finiteNonNegative(amount)) return undefined;
	const result: ReportedCost = {
		amount,
		currency: typeof raw.currency === "string" && raw.currency ? raw.currency : "USD",
		source: typeof raw.source === "string" && raw.source ? raw.source : "provider",
	};
	if (finiteNonNegative(raw.upstreamInferenceCost) && raw.upstreamInferenceCost !== 0) {
		result.upstreamInferenceCost = raw.upstreamInferenceCost;
	}
	if (requestId) result.requestId = requestId;
	// Nested summaries (a subagent folding another session's usage) may carry
	// the id on the usage object itself. An explicit argument still wins.
	else if (typeof raw.requestId === "string" && raw.requestId) {
		result.requestId = raw.requestId;
	}
	return result;
}

/** Read the locally calculated estimate Pi stored on `usage.cost.total`. */
export function estimateFromUsage(usage: unknown): number | undefined {
	if (!isRecord(usage)) return undefined;
	const cost = usage.cost;
	if (!isRecord(cost)) return undefined;
	const total = cost.total;
	return finiteNonNegative(total) ? total : undefined;
}

/**
 * Split a usage object into the individual calls it merges. A split compaction
 * combines two summarization calls into one usage; the pi-coding-agent patch
 * keeps each call on `usage.billingComponents`. Returns undefined when the usage
 * is not a merge, so callers can account it as a single observation. Nested
 * merges are flattened so no component is counted as a whole.
 */
export function billingComponents(usage: unknown): unknown[] | undefined {
	if (!isRecord(usage)) return undefined;
	const raw = usage[BILLING_COMPONENTS_FIELD];
	if (!Array.isArray(raw) || raw.length === 0) return undefined;
	const flat: unknown[] = [];
	for (const part of raw) {
		const nested = billingComponents(part);
		if (nested) flat.push(...nested);
		else flat.push(part);
	}
	return flat.length > 0 ? flat : undefined;
}

/**
 * Fold one usage observation into running totals. A USD reported charge takes
 * precedence over the estimate for the same observation; a reported zero still
 * counts as reported and suppresses the estimate. Non-USD reported charges
 * cannot join the USD total, so they fall back to the estimate rather than
 * being silently converted.
 */
export function accumulateCost(totals: CostTotals, usage: unknown, requestId?: string): void {
	// A merged usage (split compaction) must be accounted per underlying call.
	// Using the merged total would replace a reported sub-charge with the
	// combined local estimate and hide which part was actually billed.
	const parts = billingComponents(usage);
	if (parts) {
		for (const part of parts) accumulateCost(totals, part);
		return;
	}
	const reported = readReportedCost(usage, requestId);
	if (reported && reported.currency === "USD") {
		totals.reported += reported.amount;
		totals.hasReportedUsage = true;
		totals.reportedEntries += 1;
		if (reported.requestId && !totals.reportedRequestIds.includes(reported.requestId)) {
			totals.reportedRequestIds.push(reported.requestId);
		}
		if (!totals.reportedSources.includes(reported.source)) {
			totals.reportedSources.push(reported.source);
		}
		totals.total = totals.reported + totals.estimated;
		return;
	}
	const estimate = estimateFromUsage(usage);
	if (estimate !== undefined) {
		totals.estimated += estimate;
		totals.hasEstimatedUsage = true;
		totals.estimatedEntries += 1;
	}
	totals.total = totals.reported + totals.estimated;
}

export interface CostEntryLike {
	type?: string;
	usage?: unknown;
	responseId?: string;
	requestId?: string;
	message?: { role?: string; usage?: unknown; responseId?: string };
}

/**
 * Summarize the cost of a Pi session transcript. Mirrors the entry set Pi uses
 * for session stats: assistant messages, compaction/branch summaries, and tool
 * results. Provider-reported charges win per entry; everything else keeps Pi's
 * `usage.cost.total` estimate.
 */
export function summarizeSessionEntries(entries: readonly CostEntryLike[]): CostTotals {
	const totals = emptyCostTotals();
	for (const entry of entries) {
		if (entry.type === "message" && entry.message?.role === "assistant") {
			accumulateCost(totals, entry.message.usage, entry.message.responseId);
		} else if (entry.type === "compaction" || entry.type === "branch_summary") {
			accumulateCost(totals, entry.usage, entry.responseId ?? entry.requestId);
		} else if (entry.type === "message" && entry.message?.role === "toolResult" && entry.message.usage) {
			accumulateCost(totals, entry.message.usage);
		}
	}
	return totals;
}

function finiteNumber(value: number | undefined): value is number {
	return typeof value === "number" && Number.isFinite(value);
}

/**
 * Sum several reported/estimated splits without merging the two buckets. A
 * source that only knows a combined total (no split) came from local pricing,
 * so its total joins the estimated bucket instead of being dropped.
 */
export function combineCostDisclosures(
	items: Iterable<CostDisclosure>,
): CostDisclosure {
	let reported = 0;
	let estimated = 0;
	let hasReported = false;
	let hasEstimated = false;
	for (const item of items) {
		const itemReported = finiteNumber(item.reportedCostUsd) ? item.reportedCostUsd : undefined;
		const itemEstimated = finiteNumber(item.estimatedCostUsd) ? item.estimatedCostUsd : undefined;
		if (itemReported !== undefined) {
			reported += itemReported;
			hasReported = true;
		}
		if (itemEstimated !== undefined) {
			estimated += itemEstimated;
			hasEstimated = true;
		} else if (itemReported === undefined && finiteNumber(item.costUsd)) {
			estimated += item.costUsd;
			hasEstimated = true;
		}
	}
	if (!hasReported && !hasEstimated) {
		return { costUsd: undefined, reportedCostUsd: undefined, estimatedCostUsd: undefined };
	}
	return {
		costUsd: reported + estimated,
		reportedCostUsd: hasReported ? reported : undefined,
		estimatedCostUsd: hasEstimated ? estimated : undefined,
	};
}
