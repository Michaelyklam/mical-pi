import type { Usage } from "@earendil-works/pi-ai";
import type { AccountKey, AttributionRecord, SessionCostSummary } from "./domain.ts";
import { PricingResolver } from "./pricing.ts";

export const ATTRIBUTION_ENTRY = "usage-footer-attribution";

type EntryLike = {
	type: string;
	id: string;
	customType?: string;
	data?: unknown;
	usage?: Usage;
	message?: { role?: string; provider?: string; model?: string; usage?: Usage };
};

export class SessionLedger {
	constructor(
		private readonly pricing: PricingResolver,
		private readonly resolveLegacy: (providerId: string) => AccountKey | undefined,
	) {}

	summarize(
		entries: readonly EntryLike[],
		account: { accountKey: AccountKey; providerId: string },
	): SessionCostSummary {
		const attributions = new Map<string, AttributionRecord>();
		for (const entry of entries) {
			if (entry.type === "custom" && entry.customType === ATTRIBUTION_ENTRY && entry.data) {
				const record = entry.data as AttributionRecord;
				if (record.targetEntryId && record.accountKey) attributions.set(record.targetEntryId, record);
			}
		}

		let estimated = 0;
		let attributedEntries = 0;
		let excludedEntries = 0;
		let hasEstimatedUsage = false;
		let hasUnpricedUsage = false;
		const pricingSources = new Set<string>();

		for (const entry of entries) {
			let usage: Usage | undefined;
			let providerId: string | undefined;
			let modelId: string | undefined;
			const attribution = attributions.get(entry.id);
			if (entry.type === "message" && entry.message?.role === "assistant") {
				usage = entry.message.usage;
				providerId = entry.message.provider;
				modelId = entry.message.model;
			} else if (entry.type === "compaction" || entry.type === "branch_summary") {
				usage = entry.usage;
				providerId = attribution?.providerId;
				modelId = attribution?.modelId;
			} else if (entry.type === "message" && entry.message?.role === "toolResult" && entry.message.usage) {
				excludedEntries++;
				continue;
			} else {
				continue;
			}
			if (!usage || !providerId || !modelId) {
				if (usage) excludedEntries++;
				continue;
			}
			const key = attribution?.accountKey ?? this.resolveLegacy(providerId);
			if (!key) {
				if (providerId === account.providerId) excludedEntries++;
				continue;
			}
			if (key !== account.accountKey) continue;
			attributedEntries++;
			hasEstimatedUsage = hasEstimatedUsage || usage.totalTokens > 0;
			const estimate = this.pricing.estimate(providerId, modelId, usage);
			if (estimate) {
				estimated += estimate.amount;
				pricingSources.add(estimate.pricingSource);
			}
			else if (usage.totalTokens > 0) hasUnpricedUsage = true;
		}

		return {
			reported: 0,
			estimated,
			hasEstimatedUsage,
			hasUnpricedUsage,
			attributedEntries,
			excludedEntries,
			pricingSources: [...pricingSources],
		};
	}
}
