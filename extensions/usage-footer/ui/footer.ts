import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import type { HostTelemetrySnapshot } from "../../host-telemetry/monitor.ts";
import type { AccountUsageView, AllowanceWindow, SessionCostSummary } from "../domain.ts";

export interface FooterViewModel {
	accountLabel: string;
	statuses?: readonly string[];
	/** Subagent/workflow activity rendered on a dedicated row. */
	agentStatuses?: readonly string[];
	/** Dispatcher-owned child cost, rendered with agent activity. */
	subagentCostUsd?: number;
	contextTokens?: number;
	contextWindowTokens?: number;
	branch?: string | null;
	git?: { insertions: number; deletions: number };
	host?: HostTelemetrySnapshot;
	cost: Pick<SessionCostSummary, "reported" | "estimated" | "hasEstimatedUsage" | "hasUnpricedUsage">;
	usage: AccountUsageView;
}

interface ThemeLike { fg(role: string, text: string): string; bold?: (text: string) => string }

const compact = (count: number, divisor: number, suffix: string): string => `${(count / divisor).toFixed(1).replace(/\.0$/, "")}${suffix}`;
const tokens = (count: number): string => count >= 1_000_000 ? compact(count, 1_000_000, "M") : count >= 1_000 ? compact(count, 1_000, "k") : String(count);
const money = (amount: number): string => `$${amount.toFixed(2)}`;

/** Time until the window resets, e.g. "3d 4h", "2h 15m", "40m". Falls back to the window label when no reset time is known. */
export function resetLabel(window: AllowanceWindow, now: number): string {
	if (window.resetsAt === undefined || !Number.isFinite(window.resetsAt)) return window.label;
	const remainingMinutes = Math.ceil((window.resetsAt - now) / 60_000);
	if (remainingMinutes <= 0) return "resetting";
	const days = Math.floor(remainingMinutes / 1440);
	const hours = Math.floor((remainingMinutes % 1440) / 60);
	const minutes = remainingMinutes % 60;
	if (days > 0) return hours > 0 ? `${days}d ${hours}h` : `${days}d`;
	if (hours > 0) return minutes > 0 ? `${hours}h ${minutes}m` : `${hours}h`;
	return `${minutes}m`;
}

function progress(window: AllowanceWindow, theme: ThemeLike, now: number): string {
	const filled = Math.max(0, Math.min(5, Math.round(window.usedPercent / 20)));
	const bar = `${"█".repeat(filled)}${"░".repeat(5 - filled)}`;
	const role = window.usedPercent >= 90 ? "error" : window.usedPercent >= 70 ? "warning" : "success";
	return theme.fg(role, `${resetLabel(window, now)} ${bar} ${Math.round(window.usedPercent)}%`);
}

function usageText(usage: AccountUsageView, theme: ThemeLike, now: number, oneWindow = false): string {
	if (usage.status === "local" && usage.local) {
		const estimate = usage.local.hasUnpricedUsage && usage.local.estimated === 0 ? "est n/a" : `${money(usage.local.estimated)} est`;
		return `Usage (local today): ${tokens(usage.local.tokens)} tok · ~${estimate}`;
	}
	if (usage.status === "loading") return theme.fg("dim", "Usage: loading…");
	if (usage.status === "unavailable") return theme.fg("dim", "Usage: unavailable");
	let windows = usage.windows;
	if (oneWindow && windows.length > 1) windows = [[...windows].sort((a, b) => b.usedPercent - a.usedPercent)[0]!];
	const content = windows.map((window) => progress(window, theme, now)).join(theme.fg("dim", " · "));
	const stale = usage.status === "stale" ? theme.fg("dim", " (stale)") : "";
	return content ? `Usage: ${content}${stale}` : theme.fg("dim", "Usage: unavailable");
}

function costText(cost: FooterViewModel["cost"], theme: ThemeLike): string {
	const parts: string[] = [];
	if (cost.reported > 0) parts.push(`Cost: ${money(cost.reported)}`);
	if (cost.estimated > 0) parts.push(theme.fg("dim", `Est: ~${money(cost.estimated)}`));
	else if (cost.hasEstimatedUsage && cost.hasUnpricedUsage) parts.push(theme.fg("dim", "Est: n/a"));
	return parts.join(theme.fg("dim", " + "));
}

function joined(parts: string[], theme: ThemeLike): string {
	return parts.filter(Boolean).join(theme.fg("dim", " | "));
}

export function renderFooterLines(view: FooterViewModel, width: number, theme: ThemeLike, now: number = Date.now()): string[] {
	const accountIdentity = theme.fg("accent", view.accountLabel);
	const statuses = view.statuses?.join(theme.fg("dim", " · ")) ?? "";
	const agentStatuses = view.agentStatuses?.join(theme.fg("dim", " · ")) ?? "";
	const cost = costText(view.cost, theme);
	const subagentCost = view.subagentCostUsd === undefined
		? ""
		: theme.fg("dim", `[${money(view.subagentCostUsd)}]`);
	const usage = usageText(view.usage, theme, now);
	const compactUsage = usageText(view.usage, theme, now, true);

	let line1 = joined([accountIdentity, statuses, cost, usage], theme);
	const reductions = [
		[accountIdentity, statuses, usage],
		[accountIdentity, statuses, compactUsage],
		[accountIdentity, statuses],
		[accountIdentity],
	];
	for (const reduced of reductions) {
		if (visibleWidth(line1) <= width) break;
		line1 = joined(reduced, theme);
	}
	if (visibleWidth(line1) > width) {
		line1 = theme.fg("accent", truncateToWidth(view.accountLabel, width, "…"));
	}
	line1 = truncateToWidth(line1, width, "…");

	const contextUsed = view.contextTokens === undefined ? "?" : tokens(view.contextTokens);
	const contextTotal = view.contextWindowTokens === undefined ? "?" : tokens(view.contextWindowTokens);
	const context = theme.fg("dim", `Ctx: ${contextUsed}/${contextTotal}`);
	const branch = view.branch ? theme.fg("syntaxKeyword", `⎇ ${view.branch}`) : "";
	const diff = view.git && (view.git.insertions || view.git.deletions) ? theme.fg("warning", `(+${view.git.insertions},-${view.git.deletions})`) : "";
	const percent = (label: string, value: number | undefined) => value === undefined ? "" : theme.fg("dim", `${label}: ${Math.round(value)}%`);
	const activeAgents = (count: number) => `\x1b[1;92m${count}\x1b[22;39m`;
	const agents = view.host?.agentActivity
		? `Agents: ${activeAgents(view.host.agentActivity.active)}/${theme.fg("dim", String(view.host.agentActivity.idle))}`
		: view.host ? theme.fg("dim", `Agents: ${view.host.agents}`) : "";
	const hostFields = view.host ? [
		agents,
		percent("CPU", view.host.cpuPercent),
		percent("RAM", view.host.ramPercent),
		percent("GPU", view.host.gpuPercent),
	] : [];
	const metadata = [context, branch, diff, ...hostFields].filter(Boolean);
	while (metadata.length > 1 && visibleWidth(joined(metadata, theme)) > width) metadata.pop();
	const line2 = truncateToWidth(joined(metadata, theme), width, "…");

	const agentLine = truncateToWidth([agentStatuses, subagentCost].filter(Boolean).join(" "), width, "…");
	return agentLine ? [line1, agentLine, line2] : [line1, line2];
}
