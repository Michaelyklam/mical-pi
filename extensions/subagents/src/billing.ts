import { combineCostDisclosures, type CostDisclosure } from "../../shared/billing.ts";

/**
 * Subagent cost disclosure. Backends emit a combined `costUsd` plus optional
 * `reportedCostUsd`/`estimatedCostUsd`; the footer event keeps reported and
 * estimated separate so a reported charge is never diluted by an estimate.
 */
export type SubagentCostView = CostDisclosure;

/**
 * Sum per-subagent costs. Reported and estimated amounts stay separate; a
 * snapshot that predates the split (only `costUsd`) is treated as estimated
 * because that is what backends calculated locally before reported charges
 * were tracked. A reported zero remains a reported zero.
 */
export function combineSubagentCosts(
	usages: readonly SubagentCostView[],
): SubagentCostView {
	return combineCostDisclosures(usages);
}
