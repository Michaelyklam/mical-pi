import type { AllowanceWindow, ProviderUsageSnapshot } from "../domain.ts";

interface UsageBucket {
	utilization?: number;
	resets_at?: string;
}
interface AnthropicUsage {
	five_hour?: UsageBucket | null;
	seven_day?: UsageBucket | null;
	spend?: {
		enabled?: boolean;
		percent?: number;
		used?: { amount_minor?: number; currency?: string; exponent?: number };
	};
}

export function normalizeAnthropicProfile(input: any): { stableIdentity: string; suggestedLabel?: string } {
	const accountId = String(input?.account?.uuid ?? "");
	const organizationId = String(input?.organization?.uuid ?? "");
	if (!accountId) throw new Error("Anthropic profile did not include an account identity");
	return {
		stableIdentity: organizationId ? `${organizationId}/${accountId}` : accountId,
		suggestedLabel: input?.organization?.name || input?.account?.display_name || undefined,
	};
}

function bucket(id: string, label: string, value: UsageBucket | null | undefined, kind: "primary" | "secondary") {
	if (!value || typeof value.utilization !== "number") return undefined;
	const resetsAt = value.resets_at ? Date.parse(value.resets_at) : undefined;
	return {
		id,
		label,
		usedPercent: value.utilization,
		resetsAt: Number.isFinite(resetsAt) ? resetsAt : undefined,
		windowMinutes: label === "5h" ? 300 : 10080,
		kind,
	} as const;
}

export function normalizeAnthropicUsage(input: AnthropicUsage, fetchedAt = Date.now()): ProviderUsageSnapshot {
	const windows: AllowanceWindow[] = [
		bucket("five-hour", "5h", input.five_hour, "primary"),
		bucket("seven-day", "7d", input.seven_day, "secondary"),
	].filter((value): value is NonNullable<typeof value> => Boolean(value));
	const spend = input.spend;
	if (windows.length === 0 && spend?.enabled && typeof spend.percent === "number") {
		windows.push({ id: "monthly-spend", label: "month", usedPercent: spend.percent, kind: "spend" });
	}
	const used = spend?.used;
	const accountSpend =
		used && typeof used.amount_minor === "number"
			? {
					amount: used.amount_minor / 10 ** (used.exponent ?? 2),
					currency: used.currency ?? "USD",
					source: "Anthropic account usage",
				}
			: undefined;
	return { fetchedAt, sourceLabel: "Anthropic account usage", windows, accountSpend };
}

const headers = (accessToken: string) => ({
	Authorization: `Bearer ${accessToken}`,
	"anthropic-beta": "oauth-2025-04-20",
	"user-agent": "mical-pi-usage-footer",
});

async function getJson(url: string, accessToken: string, signal?: AbortSignal): Promise<any> {
	const response = await fetch(url, { headers: headers(accessToken), signal });
	if (!response.ok) throw new Error(`Anthropic usage request failed (${response.status})`);
	return response.json();
}

export class AnthropicUsageAdapter {
	async profile(accessToken: string, signal?: AbortSignal) {
		return normalizeAnthropicProfile(await getJson("https://api.anthropic.com/api/oauth/profile", accessToken, signal));
	}

	async usage(accessToken: string, signal?: AbortSignal): Promise<ProviderUsageSnapshot> {
		return normalizeAnthropicUsage(await getJson("https://api.anthropic.com/api/oauth/usage", accessToken, signal));
	}
}
