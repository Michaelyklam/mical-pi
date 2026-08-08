import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import type { AccountUsageView, AllowanceWindow, SessionCostSummary } from "../domain.ts";

export interface FooterViewModel {
	modelId: string;
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
	cost: Pick<SessionCostSummary, "reported" | "estimated" | "hasEstimatedUsage" | "hasUnpricedUsage">;
	usage: AccountUsageView;
}

interface ThemeLike { fg(role: string, text: string): string }

const compact = (count: number, divisor: number, suffix: string): string => `${(count / divisor).toFixed(1).replace(/\.0$/, "")}${suffix}`;
const tokens = (count: number): string => count >= 1_000_000 ? compact(count, 1_000_000, "M") : count >= 1_000 ? compact(count, 1_000, "k") : String(count);
const money = (amount: number): string => `$${amount.toFixed(2)}`;

function progress(window: AllowanceWindow, theme: ThemeLike): string {
	const filled = Math.max(0, Math.min(5, Math.round(window.usedPercent / 20)));
	const bar = `${"█".repeat(filled)}${"░".repeat(5 - filled)}`;
	const role = window.usedPercent >= 90 ? "error" : window.usedPercent >= 70 ? "warning" : "success";
	return theme.fg(role, `${window.label} ${bar} ${Math.round(window.usedPercent)}%`);
}

function usageText(usage: AccountUsageView, theme: ThemeLike, oneWindow = false): string {
	if (usage.status === "local" && usage.local) {
		const estimate = usage.local.hasUnpricedUsage && usage.local.estimated === 0 ? "est n/a" : `${money(usage.local.estimated)} est`;
		return `Usage (local today): ${tokens(usage.local.tokens)} tok · ~${estimate}`;
	}
	if (usage.status === "loading") return theme.fg("dim", "Usage: loading…");
	if (usage.status === "unavailable") return theme.fg("dim", "Usage: unavailable");
	let windows = usage.windows;
	if (oneWindow && windows.length > 1) windows = [[...windows].sort((a, b) => b.usedPercent - a.usedPercent)[0]!];
	const content = windows.map((window) => progress(window, theme)).join(theme.fg("dim", " · "));
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

export function renderFooterLines(view: FooterViewModel, width: number, theme: ThemeLike): string[] {
	const fullIdentity = theme.fg("accent", `Model: ${view.modelId} · ${view.accountLabel}`);
	const statuses = view.statuses?.join(theme.fg("dim", " · ")) ?? "";
	const agentStatuses = view.agentStatuses?.join(theme.fg("dim", " · ")) ?? "";
	const cost = costText(view.cost, theme);
	const subagentCost = view.subagentCostUsd === undefined
		? ""
		: theme.fg("dim", `[Subagents: ${money(view.subagentCostUsd)}]`);
	const usage = usageText(view.usage, theme);
	const compactUsage = usageText(view.usage, theme, true);

	let line1 = joined([fullIdentity, statuses, cost, usage], theme);
	const reductions = [
		[fullIdentity, statuses, usage],
		[fullIdentity, statuses, compactUsage],
		[fullIdentity, statuses],
		[fullIdentity],
	];
	for (const reduced of reductions) {
		if (visibleWidth(line1) <= width) break;
		line1 = joined(reduced, theme);
	}
	if (visibleWidth(line1) > width) {
		const suffix = ` · ${view.accountLabel}`;
		const modelWidth = Math.max(1, width - visibleWidth(suffix));
		const compactModel = modelWidth <= 1 ? "…" : truncateToWidth(view.modelId, modelWidth, "…");
		line1 = theme.fg("accent", `${compactModel}${suffix}`);
	}
	line1 = truncateToWidth(line1, width, "…");

	const contextUsed = view.contextTokens === undefined ? "?" : tokens(view.contextTokens);
	const contextTotal = view.contextWindowTokens === undefined ? "?" : tokens(view.contextWindowTokens);
	const context = theme.fg("dim", `Ctx: ${contextUsed}/${contextTotal}`);
	const branch = view.branch ? theme.fg("syntaxKeyword", `⎇ ${view.branch}`) : "";
	const diff = view.git && (view.git.insertions || view.git.deletions) ? theme.fg("warning", `(+${view.git.insertions},-${view.git.deletions})`) : "";
	let line2 = joined([context, branch, diff], theme);
	for (const reduced of [[context, branch], [context]]) {
		if (visibleWidth(line2) <= width) break;
		line2 = joined(reduced, theme);
	}
	line2 = truncateToWidth(line2, width, "…");

	const agentLine = truncateToWidth(joined([agentStatuses, subagentCost], theme), width, "…");
	return agentLine ? [line1, agentLine, line2] : [line1, line2];
}
