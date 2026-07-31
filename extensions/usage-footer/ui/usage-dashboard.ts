import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { Key, matchesKey, truncateToWidth } from "@earendil-works/pi-tui";
import type { AccountUsageView, LocalUsageSummary, ProviderAccount, SessionCostSummary } from "../domain.ts";
import { frameMenu } from "./frame.ts";

export interface DashboardEntry {
	account: ProviderAccount;
	usage: AccountUsageView;
	cost: SessionCostSummary;
}

export type DashboardAction = { type: "refresh" | "rename" | "use" | "archive"; accountKey: string } | { type: "close" };

export class DashboardModel {
	readonly entries: DashboardEntry[];
	private index = 0;
	constructor(entries: DashboardEntry[], activeKey: string | undefined, private readonly onAction: (action: DashboardAction) => void) {
		this.entries = [...entries].sort((a, b) => {
			if (a.account.accountKey === activeKey) return -1;
			if (b.account.accountKey === activeKey) return 1;
			return (a.account.label ?? a.account.providerId).localeCompare(b.account.label ?? b.account.providerId);
		});
	}
	get selected(): DashboardEntry { return this.entries[this.index]!; }
	move(delta: number): void { this.index = Math.max(0, Math.min(this.entries.length - 1, this.index + delta)); }
	replace(accountKey: string, entry: DashboardEntry): void {
		const index = this.entries.findIndex((candidate) => candidate.account.accountKey === accountKey);
		if (index >= 0) this.entries[index] = entry;
	}
	activate(type: "refresh" | "rename" | "use" | "archive"): void { this.onAction({ type, accountKey: this.selected.account.accountKey }); }
	close(): void { this.onAction({ type: "close" }); }
}

interface ThemeLike { fg(role: string, text: string): string; bold(text: string): string }
const formatTokens = (value: number) => value >= 1_000_000 ? `${(value / 1_000_000).toFixed(1)}M` : value >= 1_000 ? `${(value / 1_000).toFixed(1)}k` : String(value);
const money = (value: number) => `$${value.toFixed(2)}`;

function resetText(resetsAt: number | undefined, now = Date.now()): string {
	if (!resetsAt) return "reset unknown";
	const remaining = Math.max(0, resetsAt - now);
	const hours = Math.floor(remaining / 3_600_000);
	const minutes = Math.floor((remaining % 3_600_000) / 60_000);
	const relative = hours ? `${hours}h ${minutes}m` : `${minutes}m`;
	return `resets in ${relative} (${new Date(resetsAt).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })})`;
}

function bar(percent: number): string {
	const filled = Math.max(0, Math.min(5, Math.round(percent / 20)));
	return `${"█".repeat(filled)}${"░".repeat(5 - filled)}`;
}

function detailLines(entry: DashboardEntry, theme: ThemeLike): string[] {
	const { account, usage, cost } = entry;
	const lines = [
		theme.fg("accent", theme.bold(account.label ?? account.suggestedLabel ?? account.providerId)),
		`${account.providerId}${account.active ? " · active" : " · inactive"}`,
		`Source: ${usage.sourceLabel ?? (usage.status === "local" ? "local transcripts" : "unavailable")}`,
		usage.fetchedAt ? `Refreshed ${Math.max(0, Math.floor((Date.now() - usage.fetchedAt) / 1000))}s ago${usage.status === "stale" ? " · stale" : ""}` : "",
		"",
		theme.bold("Allowance windows"),
	];
	const diagnosticWindows = Array.isArray(usage.diagnostics?.modelWindows) ? usage.diagnostics.modelWindows as any[] : [];
	const allWindows = [...usage.windows, ...diagnosticWindows];
	if (allWindows.length === 0) lines.push("—");
	for (const window of allWindows) {
		lines.push(`${window.label.padEnd(7)} ${bar(window.usedPercent)} ${Math.round(window.usedPercent)}%`);
		lines.push(theme.fg("dim", `        ${resetText(window.resetsAt)}`));
	}
	lines.push("", theme.bold("Current session"));
	lines.push(`Reported cost: ${cost.reported > 0 ? money(cost.reported) : "—"}`);
	const sessionEstimate = cost.estimated > 0 ? `~${money(cost.estimated)}${cost.hasUnpricedUsage ? " · partial" : ""}` : cost.hasUnpricedUsage ? "n/a" : "—";
	lines.push(`Estimated cost: ${sessionEstimate}`);
	lines.push(`Pricing: ${cost.pricingSources.length ? cost.pricingSources.join(", ") : "—"}${cost.hasUnpricedUsage ? " · some tokens unpriced" : ""}`);
	lines.push("", theme.bold(usage.accountTodayTokens !== undefined ? "Account today" : "Local today"));
	if (usage.accountTodayTokens !== undefined) lines.push(`${formatTokens(usage.accountTodayTokens)} tokens · provider reported`);
	else if (usage.local) lines.push(`${formatTokens(usage.local.tokens)} tokens · ~${money(usage.local.estimated)} estimated${usage.local.hasUnpricedUsage ? " · partial" : ""}`);
	else lines.push("—");
	if (usage.accountSpend) lines.push(`Account spend: ${money(usage.accountSpend.amount)} ${usage.accountSpend.currency} · provider reported`);
	lines.push("", theme.bold("Attribution"), `${cost.attributedEntries} attributed · ${cost.excludedEntries} excluded`);
	lines.push(`Last error: ${usage.lastError ?? "none"}`);
	return lines.filter((line, index, all) => line !== "" || all[index - 1] !== "");
}

interface DashboardLoaders {
	loadLocal?(entry: DashboardEntry): Promise<LocalUsageSummary | undefined>;
	refresh?(entry: DashboardEntry): Promise<DashboardEntry>;
}

export async function showUsageDashboard(
	ctx: ExtensionCommandContext,
	entries: DashboardEntry[],
	activeKey?: string,
	loaders: DashboardLoaders = {},
): Promise<DashboardAction> {
	if (entries.length === 0) {
		ctx.ui.notify("No Provider Accounts discovered", "info");
		return { type: "close" };
	}
	const overlay = (process.stdout.columns ?? 100) >= 70;
	return ctx.ui.custom<DashboardAction>((tui, theme, _keybindings, done) => {
		const refreshing = new Set<string>();
		const model = new DashboardModel(entries, activeKey, (action) => {
			if (action.type !== "refresh" || !loaders.refresh) return done(action);
			if (refreshing.has(action.accountKey)) return;
			const entry = model.entries.find((candidate) => candidate.account.accountKey === action.accountKey);
			if (!entry) return;
			refreshing.add(action.accountKey);
			tui.requestRender();
			void loaders.refresh(entry)
				.then((updated) => model.replace(action.accountKey, updated))
				.catch(() => undefined)
				.finally(() => { refreshing.delete(action.accountKey); tui.requestRender(); });
		});
		if (loaders.loadLocal) queueMicrotask(() => {
			for (const entry of model.entries) void loaders.loadLocal!(entry).then((local) => {
				if (!local) return;
				const current = model.entries.find((candidate) => candidate.account.accountKey === entry.account.accountKey);
				if (current) model.replace(entry.account.accountKey, { ...current, usage: { ...current.usage, local } });
				tui.requestRender();
			}).catch(() => undefined);
		});
		return {
			invalidate() {},
			handleInput(data: string) {
				if (matchesKey(data, Key.up)) model.move(-1);
				else if (matchesKey(data, Key.down)) model.move(1);
				else if (data === "r") model.activate("refresh");
				else if (data === "e") model.activate("rename");
				else if (data === "u") model.activate("use");
				else if (data === "a") model.activate("archive");
				else if (matchesKey(data, Key.escape) || matchesKey(data, Key.ctrl("c"))) model.close();
				tui.requestRender();
			},
			render(width: number) {
				const innerWidth = Math.max(1, width - 2);
				const isRefreshing = refreshing.has(model.selected.account.accountKey);
				const title = theme.fg("accent", theme.bold(`Usage${isRefreshing ? " · refreshing…" : ""}`));
				const help = theme.fg("dim", "↑↓ account  r refresh  e rename  u use  a archive  esc close");
				const detail = detailLines(model.selected, theme);
				if (innerWidth < 80) {
					const content = [title, "", ...detail, "", truncateToWidth(help, innerWidth)].map((line) => truncateToWidth(line, innerWidth));
					return frameMenu(content, width, theme);
				}
				const leftWidth = Math.min(30, Math.floor(innerWidth * 0.35));
				const rightWidth = innerWidth - leftWidth - 3;
				const left = model.entries.map((entry) => {
					const selected = entry.account.accountKey === model.selected.account.accountKey;
					const name = entry.account.label ?? entry.account.suggestedLabel ?? entry.account.providerId;
					const status = refreshing.has(entry.account.accountKey) ? "Refreshing…" : entry.account.archived ? "Archived" : entry.account.active ? entry.usage.status === "local" ? "Local" : entry.usage.status === "stale" ? "Stale" : "Live" : "Inactive";
					return `${selected ? ">" : " "} ${name} ${status}`;
				});
				const rows = Math.max(left.length, detail.length);
				const body: string[] = [];
				for (let i = 0; i < rows; i++) body.push(`${truncateToWidth(left[i] ?? "", leftWidth).padEnd(leftWidth)} │ ${truncateToWidth(detail[i] ?? "", rightWidth)}`);
				return frameMenu([title, "", ...body, "", truncateToWidth(help, innerWidth)], width, theme);
			},
		};
	}, overlay ? { overlay: true, overlayOptions: { width: "80%", minWidth: 68, maxHeight: "85%", anchor: "center" } } : undefined);
}
