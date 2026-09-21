import type { Usage } from "@earendil-works/pi-ai";
import { billingComponents, readReportedCost } from "../shared/billing.ts";
import type { AccountKey, AttributionRecord, SessionCostSummary } from "./domain.ts";
import { PricingResolver } from "./pricing.ts";

export const ATTRIBUTION_ENTRY = "usage-footer-attribution";

type EntryLike = {
	type: string;
	id: string;
	customType?: string;
	data?: unknown;
	usage?: Usage;
	responseId?: string;
	message?: { role?: string; provider?: string; model?: string; usage?: Usage; responseId?: string };
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

		let reported = 0;
		let estimated = 0;
		let attributedEntries = 0;
		let excludedEntries = 0;
		let hasReportedUsage = false;
		let hasEstimatedUsage = false;
		let hasUnpricedUsage = false;
		let reportedEntries = 0;
		let estimatedEntries = 0;
		const pricingSources = new Set<string>();
		const reportedSources = new Set<string>();
		const reportedRequestIds = new Set<string>();

		for (const entry of entries) {
			let usage: Usage | undefined;
			let providerId: string | undefined;
			let modelId: string | undefined;
			let requestId: string | undefined;
			const attribution = attributions.get(entry.id);
			if (entry.type === "message" && entry.message?.role === "assistant") {
				usage = entry.message.usage;
				providerId = entry.message.provider;
				modelId = entry.message.model;
				requestId = entry.message.responseId;
			} else if (entry.type === "compaction" || entry.type === "branch_summary") {
				usage = entry.usage;
				providerId = attribution?.providerId;
				modelId = attribution?.modelId;
				requestId = entry.responseId;
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
			// Provider-reported charges take precedence; a reported zero stays zero
			// and is never replaced by an estimate.
			const accountUsage = (observationUsage: Usage, observationRequestId: string | undefined): void => {
				const observation = readReportedCost(observationUsage, observationRequestId);
				if (observation && observation.currency === "USD") {
					reported += observation.amount;
					hasReportedUsage = true;
					reportedEntries++;
					reportedSources.add(observation.source);
					if (observation.requestId) reportedRequestIds.add(observation.requestId);
					return;
				}
				if (observationUsage.totalTokens > 0) hasEstimatedUsage = true;
				estimatedEntries++;
				const estimate = this.pricing.estimate(providerId, modelId, observationUsage);
				if (estimate) {
					estimated += estimate.amount;
					pricingSources.add(estimate.pricingSource);
				}
				else if (observationUsage.totalTokens > 0) hasUnpricedUsage = true;
			};
			// A split compaction merges two summarization calls into one usage;
			// account each call on its own so a reported call is not replaced by
			// the combined estimate. The merged estimate is never used as a whole.
			const parts = billingComponents(usage);
			if (parts) {
				for (const part of parts) accountUsage(part as Usage, undefined);
			} else {
				accountUsage(usage, requestId);
			}
		}

		return {
			reported,
			estimated,
			hasReportedUsage,
			hasEstimatedUsage,
			hasUnpricedUsage,
			reportedEntries,
			estimatedEntries,
			attributedEntries,
			excludedEntries,
			pricingSources: [...pricingSources],
			reportedSources: [...reportedSources],
			reportedRequestIds: [...reportedRequestIds],
		};
	}
}
