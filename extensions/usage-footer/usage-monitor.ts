import type { AccountKey, AccountUsageView, LocalUsageSummary, ProviderAccount, ProviderUsageSnapshot } from "./domain.ts";

const REFRESH_MS = 60_000;
const STALE_MS = 30 * 60_000;

export interface UsageMonitorDependencies {
	now?: () => number;
	fetch(account: ProviderAccount, signal?: AbortSignal, options?: { force?: boolean }): Promise<ProviderUsageSnapshot | undefined>;
	local(account: ProviderAccount): Promise<LocalUsageSummary>;
	load(accountKey: AccountKey): Promise<ProviderUsageSnapshot | undefined>;
	save(accountKey: AccountKey, snapshot: ProviderUsageSnapshot): Promise<void>;
}

function sanitizedError(error: unknown): string {
	const text = error instanceof Error ? error.message : String(error);
	return text
		.replace(/(token|key|authorization|secret)=\S+/gi, "$1=[redacted]")
		.replace(/Bearer\s+\S+/gi, "Bearer [redacted]")
		.slice(0, 300);
}

function windowsValid(snapshot: ProviderUsageSnapshot, now: number): boolean {
	if (snapshot.windows.length === 0) return false;
	return snapshot.windows.some((window) => window.resetsAt === undefined || window.resetsAt > now);
}

export class UsageMonitor {
	private readonly now: () => number;
	private readonly views = new Map<AccountKey, AccountUsageView>();
	private readonly controllers = new Map<AccountKey, AbortController>();
	private timer?: NodeJS.Timeout;

	constructor(private readonly dependencies: UsageMonitorDependencies) {
		this.now = dependencies.now ?? Date.now;
	}

	get(accountKey: AccountKey): AccountUsageView {
		return this.views.get(accountKey) ?? { status: "loading", windows: [] };
	}

	async refresh(account: ProviderAccount, options: { force?: boolean } = {}): Promise<void> {
		const now = this.now();
		let previous = await this.dependencies.load(account.accountKey);
		if (!previous) {
			const current = this.views.get(account.accountKey);
			if (current?.fetchedAt && current.sourceLabel) {
				previous = {
					fetchedAt: current.fetchedAt,
					sourceLabel: current.sourceLabel,
					windows: current.windows,
					accountTodayTokens: current.accountTodayTokens,
				};
			}
		}
		if (!options.force && previous && now - previous.fetchedAt < REFRESH_MS && windowsValid(previous, now)) {
			this.views.set(account.accountKey, { status: "live", ...previous });
			return;
		}

		this.controllers.get(account.accountKey)?.abort();
		const controller = new AbortController();
		this.controllers.set(account.accountKey, controller);
		try {
			const snapshot = await this.dependencies.fetch(account, controller.signal, options);
			if (!snapshot) {
				await this.useLocal(account);
				return;
			}
			await this.dependencies.save(account.accountKey, snapshot);
			this.views.set(account.accountKey, { status: "live", ...snapshot });
		} catch (error) {
			const message = sanitizedError(error);
			if (previous && now - previous.fetchedAt <= STALE_MS && windowsValid(previous, now)) {
				this.views.set(account.accountKey, { status: "stale", ...previous, lastError: message });
			} else {
				await this.useLocal(account, message);
			}
		} finally {
			if (this.controllers.get(account.accountKey) === controller) this.controllers.delete(account.accountKey);
		}
	}

	private async useLocal(account: ProviderAccount, lastError?: string): Promise<void> {
		try {
			const local = await this.dependencies.local(account);
			this.views.set(account.accountKey, { status: "local", windows: [], local, lastError });
		} catch (error) {
			this.views.set(account.accountKey, { status: "unavailable", windows: [], lastError: lastError ?? sanitizedError(error) });
		}
	}

	start(accounts: () => readonly ProviderAccount[], onChange: () => void): void {
		if (this.timer) return;
		this.timer = setInterval(() => {
			for (const account of accounts().filter((item) => item.active && !item.archived)) {
				void this.refresh(account).finally(onChange);
			}
		}, REFRESH_MS);
		this.timer.unref?.();
	}

	stop(): void {
		if (this.timer) clearInterval(this.timer);
		this.timer = undefined;
		for (const controller of this.controllers.values()) controller.abort();
		this.controllers.clear();
	}
}
