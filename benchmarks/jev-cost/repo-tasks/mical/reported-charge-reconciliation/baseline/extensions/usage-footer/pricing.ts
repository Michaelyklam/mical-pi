import type { Model, ModelCost, ModelCostRates, Usage } from "@earendil-works/pi-ai";
import type { CostEstimate } from "./domain.ts";

function nonzero(cost: ModelCost): boolean {
	return cost.input !== 0 || cost.output !== 0 || cost.cacheRead !== 0 || cost.cacheWrite !== 0;
}

function canonicalId(modelId: string): string {
	return modelId.split("/").pop() ?? modelId;
}

function scheduleKey(cost: ModelCost): string {
	return JSON.stringify({
		input: cost.input,
		output: cost.output,
		cacheRead: cost.cacheRead,
		cacheWrite: cost.cacheWrite,
		tiers: [...(cost.tiers ?? [])].sort((a, b) => a.inputTokensAbove - b.inputTokensAbove),
	});
}

function ratesFor(cost: ModelCost, usage: Usage): ModelCostRates {
	const totalInput = usage.input + usage.cacheRead + usage.cacheWrite;
	const tier = [...(cost.tiers ?? [])]
		.filter((candidate) => totalInput > candidate.inputTokensAbove)
		.sort((a, b) => b.inputTokensAbove - a.inputTokensAbove)[0];
	return tier ?? cost;
}

export class PricingResolver {
	constructor(private readonly models: readonly Model<any>[]) {}

	estimate(providerId: string, modelId: string, usage: Usage): CostEstimate | undefined {
		const selected = this.models.find((model) => model.provider === providerId && model.id === modelId);
		let priced = selected && nonzero(selected.cost) ? selected : undefined;
		let pricingSource = priced ? `Pi registry ${providerId}/${modelId}` : undefined;
		if (!priced) {
			const canonical = canonicalId(modelId);
			const candidates = this.models.filter((model) => model.id === canonical && nonzero(model.cost));
			const schedules = new Set(candidates.map((model) => scheduleKey(model.cost)));
			if (candidates.length === 0 || schedules.size !== 1) return undefined;
			priced = candidates[0];
			pricingSource = `Pi registry canonical ${canonical}`;
		}
		const rates = ratesFor(priced.cost, usage);
		const amount =
			(usage.input * rates.input +
				usage.output * rates.output +
				usage.cacheRead * rates.cacheRead +
				usage.cacheWrite * rates.cacheWrite) /
			1_000_000;
		return { amount, pricingSource: pricingSource! };
	}
}
