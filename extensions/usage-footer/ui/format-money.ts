import type { LocalUsageSummary } from "../domain.ts";

export function formatLocalCost(local: LocalUsageSummary): string {
	const parts: string[] = [];
	if (local.hasReportedUsage) parts.push(`${formatUsd(local.reported ?? 0)} reported`);
	if (local.estimated === 0 && local.hasUnpricedUsage) parts.push("est n/a");
	else if (local.estimated > 0 || local.hasEstimatedUsage || !local.hasReportedUsage) {
		parts.push(`~${formatUsd(local.estimated)} est${local.hasUnpricedUsage ? " (partial)" : ""}`);
	}
	return parts.join(" + ");
}

/** Keep nonzero sub-cent charges distinguishable from a reported free request. */
export function formatUsd(amount: number): string {
	if (amount > 0 && amount < 0.000001) return "<$0.000001";
	if (amount > 0 && amount < 0.01) return `$${amount.toFixed(6).replace(/0+$/, "")}`;
	return `$${amount.toFixed(2)}`;
}
