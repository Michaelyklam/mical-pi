import type { Usage } from "@earendil-works/pi-ai";

export type AuthType = "oauth" | "api_key";
export type AccountKey = string;

export interface ProviderAccount {
	accountKey: AccountKey;
	providerId: string;
	authType: AuthType;
	stableIdentityHash?: string;
	credentialFingerprints: string[];
	label?: string;
	suggestedLabel?: string;
	archived: boolean;
	active: boolean;
	firstSeenAt: number;
	lastSeenAt: number;
}

export interface DiscoveredAccount {
	providerId: string;
	authType: AuthType;
	stableIdentity?: string;
	credentialFingerprint?: string;
	suggestedLabel?: string;
}

export interface AccountObservation extends ProviderAccount {
	needsLabel: boolean;
	needsRotationDecision: boolean;
}

export interface AllowanceWindow {
	id: string;
	label: string;
	usedPercent: number;
	windowMinutes?: number;
	resetsAt?: number;
	kind: "primary" | "secondary" | "model" | "spend";
}

export interface MoneyObservation {
	amount: number;
	currency: string;
	source: string;
}

export interface ProviderUsageSnapshot {
	fetchedAt: number;
	sourceLabel: string;
	windows: AllowanceWindow[];
	accountTodayTokens?: number;
	accountSpend?: MoneyObservation;
	diagnostics?: Record<string, unknown>;
}

export interface TokenBreakdown extends Usage {
	providerId: string;
	modelId: string;
	accountKey?: AccountKey;
}

export interface CostEstimate {
	amount: number;
	pricingSource: string;
}

export interface SessionCostSummary {
	reported: number;
	estimated: number;
	/** True when at least one provider-reported charge was seen, even a reported zero. */
	hasReportedUsage: boolean;
	hasEstimatedUsage: boolean;
	hasUnpricedUsage: boolean;
	reportedEntries: number;
	estimatedEntries: number;
	attributedEntries: number;
	excludedEntries: number;
	pricingSources: string[];
	/** Provenance of reported charges, e.g. ["openrouter"]. */
	reportedSources: string[];
	/** Provider request ids paired with reported charges, when exposed. */
	reportedRequestIds: string[];
}

export interface LocalUsageSummary {
	tokens: number;
	estimated: number;
	/** Provider-reported charges included in this local summary, in USD. */
	reported?: number;
	/** True when at least one record carried a provider-reported charge. */
	hasReportedUsage?: boolean;
	/** True when at least one record or native ccusage entry fell back to an estimate. */
	hasEstimatedUsage?: boolean;
	hasUnpricedUsage: boolean;
	models: number;
}

export type UsageStatus = "loading" | "live" | "stale" | "local" | "unavailable";

export interface AccountUsageView {
	status: UsageStatus;
	windows: AllowanceWindow[];
	accountTodayTokens?: number;
	accountSpend?: MoneyObservation;
	local?: LocalUsageSummary;
	fetchedAt?: number;
	sourceLabel?: string;
	lastError?: string;
	diagnostics?: Record<string, unknown>;
}

export interface AttributionRecord {
	targetEntryId: string;
	accountKey: AccountKey;
	providerId: string;
	modelId?: string;
	kind: "assistant" | "compaction" | "branch_summary";
	recordedAt: number;
}
