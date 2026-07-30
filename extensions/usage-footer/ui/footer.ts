import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import type { AccountUsageView, AllowanceWindow, SessionCostSummary } from "../domain.ts";

export interface FooterViewModel {
	providerId: string;
	modelId: string;
	accountLabel: string;
	contextTokens?: number;
	branch?: string | null;
	git?: { insertions: number; deletions: number };
	cost: Pick<SessionCostSummary, "reported" | "estimated" | "hasEstimatedUsage" | "hasUnpricedUsage">;
	usage: AccountUsageView;
}

interface ThemeLike { fg(role: string, text: string): string }

const tokens = (count: number): string => count >= 1_000_000 ? `${(count / 1_000_000).toFixed(1)}M` : count >= 1_000 ? `${(count / 1_000).toFixed(1)}k` : String(count);
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
	const fullIdentity = theme.fg("accent", `Model: ${view.providerId}/${view.modelId} · ${view.accountLabel}`);
	const context = theme.fg("dim", `Ctx: ${view.contextTokens === undefined ? "?" : tokens(view.contextTokens)}`);
	const branch = view.branch ? theme.fg("syntaxKeyword", `⎇ ${view.branch}`) : "";
	const diff = view.git && (view.git.insertions || view.git.deletions) ? theme.fg("warning", `(+${view.git.insertions},-${view.git.deletions})`) : "";
	let line1 = joined([fullIdentity, context, branch, diff], theme);
	for (const reduced of [[fullIdentity, context, branch], [fullIdentity, context], [fullIdentity]]) {
		if (visibleWidth(line1) <= width) break;
		line1 = joined(reduced, theme);
	}
	if (visibleWidth(line1) > width) {
		const suffix = ` · ${view.accountLabel}`;
		const prefix = `${view.providerId}/`;
		const modelWidth = Math.max(1, width - visibleWidth(prefix) - visibleWidth(suffix));
		const compactModel = modelWidth <= 1 ? "…" : truncateToWidth(view.modelId, modelWidth, "…");
		line1 = theme.fg("accent", `${prefix}${compactModel}${suffix}`);
	}
	line1 = truncateToWidth(line1, width, "…");

	const cost = costText(view.cost, theme);
	let usage = usageText(view.usage, theme);
	let line2 = joined([cost, usage], theme);
	if (visibleWidth(line2) > width) line2 = usage;
	if (visibleWidth(line2) > width) {
		usage = usageText(view.usage, theme, true);
		line2 = usage;
	}
	line2 = truncateToWidth(line2, width, "…");
	return [line1, line2];
}
