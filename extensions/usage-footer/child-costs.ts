import { combineCostDisclosures, type CostDisclosure } from "../shared/billing.ts";

/** Source events are cumulative snapshots, not deltas; replace rather than add. */
export class ChildCostTracker {
	private readonly sources = new Map<string, CostDisclosure>();
	update(source: string, data: unknown): void {
		const value = data as CostDisclosure | undefined;
		const valid = (amount: unknown): number | undefined => typeof amount === "number" && Number.isFinite(amount) && amount >= 0 ? amount : undefined;
		this.sources.set(source, {
			costUsd: valid(value?.costUsd),
			reportedCostUsd: valid(value?.reportedCostUsd),
			estimatedCostUsd: valid(value?.estimatedCostUsd),
		});
	}
	get total(): CostDisclosure { return combineCostDisclosures([...this.sources.values()]); }
	clear(): void { this.sources.clear(); }
}
