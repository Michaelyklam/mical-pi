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
	hasEstimatedUsage: boolean;
	hasUnpricedUsage: boolean;
	attributedEntries: number;
	excludedEntries: number;
	pricingSources: string[];
}

export interface LocalUsageSummary {
	tokens: number;
	estimated: number;
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
