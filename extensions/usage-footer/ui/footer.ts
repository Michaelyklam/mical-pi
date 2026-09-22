import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import type { HostTelemetrySnapshot } from "../../host-telemetry/monitor.ts";
import type { AccountUsageView, AllowanceWindow, SessionCostSummary } from "../domain.ts";
import { formatLocalCost, formatUsd as money } from "./format-money.ts";

export interface FooterViewModel {
	accountLabel: string;
	statuses?: readonly string[];
	/** Subagent/workflow activity rendered on a dedicated row. */
	agentStatuses?: readonly string[];
	/** Dispatcher-owned child cost, rendered with agent activity. */
	subagentCostUsd?: number;
	subagentReportedCostUsd?: number;
	subagentEstimatedCostUsd?: number;
	contextTokens?: number;
	contextWindowTokens?: number;
	branch?: string | null;
	repoName?: string;
	git?: { insertions: number; deletions: number };
	host?: HostTelemetrySnapshot;
	cost: Pick<SessionCostSummary, "reported" | "estimated" | "hasReportedUsage" | "hasEstimatedUsage" | "hasUnpricedUsage">;
	usage: AccountUsageView;
}

interface ThemeLike { fg(role: string, text: string): string; bold?: (text: string) => string }

const compact = (count: number, divisor: number, suffix: string): string => `${(count / divisor).toFixed(1).replace(/\.0$/, "")}${suffix}`;
const tokens = (count: number): string => count >= 1_000_000 ? compact(count, 1_000_000, "M") : count >= 1_000 ? compact(count, 1_000, "k") : String(count);

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

function usageText(usage: AccountUsageView, theme: ThemeLike, now: number): string {
	if (usage.status === "local" && usage.local) {
		return `Usage (local today): ${tokens(usage.local.tokens)} tok · ${formatLocalCost(usage.local)}`;
	}
	if (usage.status === "loading") return theme.fg("dim", "Usage: loading…");
	if (usage.status === "unavailable") return theme.fg("dim", "Usage: unavailable");
	const content = usage.windows.map((window) => progress(window, theme, now)).join(theme.fg("dim", " · "));
	const stale = usage.status === "stale" ? theme.fg("dim", " (stale)") : "";
	return content ? `Usage: ${content}${stale}` : theme.fg("dim", "Usage: unavailable");
}

function usageRows(usage: AccountUsageView, width: number, theme: ThemeLike, now: number): string[] {
	if ((usage.status !== "live" && usage.status !== "stale") || !usage.windows.length) {
		return [truncateToWidth(usageText(usage, theme, now), width, "…")];
	}
	const prefix = usage.status === "stale" ? "Usage (stale): " : "Usage: ";
	const rows: string[] = [];
	let row = "";
	for (const window of usage.windows) {
		const item = progress(window, theme, now);
		const candidate = row ? `${row}${theme.fg("dim", " · ")}${item}` : `${prefix}${item}`;
		if (row && visibleWidth(candidate) > width) {
			rows.push(truncateToWidth(row, width, "…"));
			row = `${prefix}${item}`;
		} else row = candidate;
	}
	if (row) rows.push(truncateToWidth(row, width, "…"));
	return rows;
}

function costText(cost: FooterViewModel["cost"], theme: ThemeLike): string {
	const parts: string[] = [];
	if (cost.hasReportedUsage || cost.reported > 0) parts.push(`Cost: ${money(cost.reported)}`);
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
	const childParts: string[] = [];
	if (view.subagentReportedCostUsd !== undefined) childParts.push(`Cost: ${money(view.subagentReportedCostUsd)}`);
	if (view.subagentEstimatedCostUsd !== undefined) childParts.push(`Est: ~${money(view.subagentEstimatedCostUsd)}`);
	if (!childParts.length && view.subagentCostUsd !== undefined) childParts.push(`Est: ~${money(view.subagentCostUsd)}`);
	const subagentCost = childParts.length ? theme.fg("dim", `[${childParts.join(" + ")}]`) : "";
	const usage = usageText(view.usage, theme, now);

	let line1 = joined([accountIdentity, statuses, cost, usage], theme);
	let extraUsageRows: string[] = [];
	if (visibleWidth(line1) > width) line1 = joined([accountIdentity, statuses, usage], theme);
	if (visibleWidth(line1) > width) {
		// Subscription windows must remain visible in split panes. Move usage
		// onto its own rows instead of dropping windows or the reset countdown.
		extraUsageRows = usageRows(view.usage, width, theme, now);
		line1 = joined([accountIdentity, statuses, cost], theme);
		if (visibleWidth(line1) > width) line1 = joined([accountIdentity, statuses], theme);
		if (visibleWidth(line1) > width) line1 = accountIdentity;
	}
	line1 = truncateToWidth(line1, width, "…");

	const contextUsed = view.contextTokens === undefined ? "?" : tokens(view.contextTokens);
	const contextTotal = view.contextWindowTokens === undefined ? "?" : tokens(view.contextWindowTokens);
	const context = theme.fg("dim", `Ctx: ${contextUsed}/${contextTotal}`);
	const gitLabel = [view.repoName, view.branch].filter(Boolean).join("/");
	const branch = gitLabel ? theme.fg("syntaxKeyword", `⎇ ${gitLabel}`) : "";
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
	return [line1, ...extraUsageRows, ...(agentLine ? [agentLine] : []), line2];
}
