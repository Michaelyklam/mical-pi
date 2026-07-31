import type { AssistantMessage } from "@earendil-works/pi-ai";
import { getAgentDir, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { createHash } from "node:crypto";
import { homedir } from "node:os";
import { join } from "node:path";
import { AccountCatalog } from "./account-catalog.ts";
import { AccountDiscovery, nativeIdentityMatches, openAIIdentity } from "./account-discovery.ts";
import { AnthropicUsageAdapter } from "./adapters/anthropic.ts";
import { CodexUsageAdapter } from "./adapters/codex.ts";
import type { AccountObservation, AttributionRecord, ProviderAccount } from "./domain.ts";
import { LocalUsageIndex } from "./local-usage.ts";
import { JsonAccountCatalogStore, JsonSnapshotStore, withFileLock } from "./persistence.ts";
import { PricingResolver } from "./pricing.ts";
import { ATTRIBUTION_ENTRY, SessionLedger } from "./session-ledger.ts";
import { showAccountWizard } from "./ui/account-wizard.ts";
import { renderFooterLines } from "./ui/footer.ts";
import { type DashboardEntry, showUsageDashboard } from "./ui/usage-dashboard.ts";
import { UsageMonitor } from "./usage-monitor.ts";

const GIT_TTL_MS = 5_000;
const CACHE_HOME = process.env.XDG_CACHE_HOME || join(homedir(), ".cache");
const ACCOUNT_FILE = join(getAgentDir(), "usage-footer", "accounts.json");
const SNAPSHOT_FILE = join(CACHE_HOME, "mical-pi", "usage-footer", "snapshots.json");
const LOCAL_INDEX_FILE = join(CACHE_HOME, "mical-pi", "usage-footer", "local-index.json");
const SESSION_ROOT = join(getAgentDir(), "sessions");

interface GitChanges { insertions: number; deletions: number }
const safeName = (value: string) => createHash("sha256").update(value).digest("hex").slice(0, 20);
const localDate = () => {
	const date = new Date();
	return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
};

function parseShortstat(out: string): GitChanges {
	return {
		insertions: Number(/(\d+) insertions?/.exec(out)?.[1] ?? 0),
		deletions: Number(/(\d+) deletions?/.exec(out)?.[1] ?? 0),
	};
}

export default function usageFooter(pi: ExtensionAPI) {
	const catalog = new AccountCatalog(new JsonAccountCatalogStore(ACCOUNT_FILE));
	const anthropic = new AnthropicUsageAdapter();
	const codex = new CodexUsageAdapter();
	let discovery: AccountDiscovery;
	let monitor: UsageMonitor | undefined;
	let localUsage: LocalUsageIndex | undefined;
	let currentAccount: ProviderAccount | undefined;
	let enabled = false;
	let requestRender: (() => void) | undefined;
	let git: GitChanges | undefined;
	let gitTimer: NodeJS.Timeout | undefined;
	const snapshotStore = new JsonSnapshotStore(SNAPSHOT_FILE);

	const pricing = (ctx: ExtensionContext) => new PricingResolver(ctx.modelRegistry.getAll());
	const ledger = (ctx: ExtensionContext) => new SessionLedger(pricing(ctx), (provider) => catalog.resolveLegacy(provider)?.accountKey);

	async function refreshGit(ctx: ExtensionContext): Promise<void> {
		try {
			const [unstaged, staged] = await Promise.all([
				pi.exec("git", ["diff", "--shortstat"], { cwd: ctx.cwd, timeout: 3000 }),
				pi.exec("git", ["diff", "--cached", "--shortstat"], { cwd: ctx.cwd, timeout: 3000 }),
			]);
			if (unstaged.code !== 0 && staged.code !== 0) git = undefined;
			else {
				const a = parseShortstat(unstaged.stdout || "");
				const b = parseShortstat(staged.stdout || "");
				git = { insertions: a.insertions + b.insertions, deletions: a.deletions + b.deletions };
			}
		} catch { git = undefined; }
		requestRender?.();
	}

	async function resolveRotation(
		observation: AccountObservation,
		credentialFingerprint: string | undefined,
		ctx: ExtensionContext,
	): Promise<AccountObservation> {
		if (!observation.needsRotationDecision || !credentialFingerprint || !ctx.hasUI) return observation;
		const existing = catalog.list().filter((account) => account.providerId === observation.providerId && account.label && account.accountKey !== observation.accountKey);
		const choice = await ctx.ui.select(
			`New credentials detected for ${observation.providerId}`,
			[...existing.map((account) => `Existing: ${account.label}`), "Create a new account"],
		);
		const selected = existing.find((account) => choice === `Existing: ${account.label}`);
		if (!selected) return observation;
		await catalog.attachCredential(selected.accountKey, credentialFingerprint);
		return { ...selected, active: true, needsLabel: false, needsRotationDecision: false };
	}

	async function observeProvider(providerId: string, ctx: ExtensionContext, promptForLabel: boolean): Promise<ProviderAccount | undefined> {
		const found = await discovery.discover(providerId, AbortSignal.timeout(5_000)).catch(() => undefined);
		if (!found) {
			const fallback = catalog.resolveLegacy(providerId) ?? catalog.list().find((account) => account.providerId === providerId);
			if (fallback) await catalog.activate(fallback.accountKey);
			return fallback ? catalog.get(fallback.accountKey) : undefined;
		}
		let observation = await catalog.observe(found);
		observation = await resolveRotation(observation, found.credentialFingerprint, ctx);
		if (!catalog.resolveLegacy(providerId)) await catalog.mapLegacyProvider(providerId, observation.accountKey);
		if (promptForLabel && observation.needsLabel && ctx.mode === "tui") {
			const labels = await showAccountWizard(ctx, [observation]);
			for (const row of labels ?? []) if (row.label) await catalog.label({ accountKey: row.accountKey, label: row.label });
		}
		return catalog.get(observation.accountKey) ?? observation;
	}

	async function discoverAll(ctx: ExtensionContext, showWizard: boolean): Promise<void> {
		await catalog.load();
		if (showWizard) await catalog.markAllInactive();
		const observations: AccountObservation[] = [];
		for (const providerId of discovery.providerIds()) {
			const found = await discovery.discover(providerId, AbortSignal.timeout(5_000)).catch(() => undefined);
			if (!found) continue;
			let observation = await catalog.observe(found);
			observation = await resolveRotation(observation, found.credentialFingerprint, ctx);
			observations.push(observation);
			if (!catalog.resolveLegacy(providerId)) await catalog.mapLegacyProvider(providerId, observation.accountKey);
		}
		if (showWizard && ctx.mode === "tui") {
			const labels = await showAccountWizard(ctx, observations.filter((account) => account.needsLabel && !account.needsRotationDecision));
			for (const row of labels ?? []) if (row.label) await catalog.label({ accountKey: row.accountKey, label: row.label });
		}
	}

	function installFooter(ctx: ExtensionContext): void {
		ctx.ui.setFooter((tui, theme, footerData) => {
			requestRender = () => tui.requestRender();
			const unsubscribe = footerData.onBranchChange(() => void refreshGit(ctx));
			return {
				dispose() { unsubscribe(); requestRender = undefined; },
				invalidate() {},
				render(width: number) {
					const model = ctx.model;
					const account = currentAccount;
					if (!model || !account || !monitor) return [theme.fg("dim", "Usage footer loading…")];
					const cost = ledger(ctx).summarize(ctx.sessionManager.getEntries() as any[], account);
					return renderFooterLines({
						providerId: String(model.provider),
						modelId: model.id,
						accountLabel: account.label ?? account.suggestedLabel ?? account.providerId,
						contextTokens: ctx.getContextUsage()?.tokens ?? undefined,
						branch: footerData.getGitBranch(),
						git,
						cost,
						usage: monitor.get(account.accountKey),
					}, width, theme);
				},
			};
		});
		enabled = true;
	}

	function appendAttribution(ctx: ExtensionContext, targetEntryId: string, kind: AttributionRecord["kind"], modelId?: string): void {
		if (!currentAccount) return;
		pi.appendEntry<AttributionRecord>(ATTRIBUTION_ENTRY, {
			targetEntryId,
			accountKey: currentAccount.accountKey,
			providerId: currentAccount.providerId,
			modelId: modelId ?? ctx.model?.id,
			kind,
			recordedAt: Date.now(),
		});
	}

	function dashboardEntry(ctx: ExtensionContext, account: ProviderAccount): DashboardEntry {
		return {
			account,
			usage: monitor?.get(account.accountKey) ?? { status: "unavailable" as const, windows: [] },
			cost: ledger(ctx).summarize(ctx.sessionManager.getEntries() as any[], account),
		};
	}

	function dashboardEntries(ctx: ExtensionContext): DashboardEntry[] {
		return catalog.list().map((account) => dashboardEntry(ctx, account));
	}

	pi.on("session_start", async (event, ctx) => {
		discovery = new AccountDiscovery(ctx.modelRegistry, anthropic);
		if (ctx.mode === "tui") await discoverAll(ctx, event.reason === "startup");
		else await catalog.load();
		const model = ctx.model;
		if (model) currentAccount = await observeProvider(String(model.provider), ctx, false);
		localUsage = new LocalUsageIndex(
			SESSION_ROOT,
			catalog,
			pricing(ctx),
			async (command, args) => {
				const result = await pi.exec(command, args, { timeout: 20_000 });
				return { stdout: result.stdout, code: result.code };
			},
			nativeIdentityMatches,
			localDate,
			LOCAL_INDEX_FILE,
		);
		monitor = new UsageMonitor({
			load: (key) => snapshotStore.load(key),
			save: (key, snapshot) => snapshotStore.save(key, snapshot),
			local: (account) => localUsage!.summarize(account),
			fetch: async (account, signal, options) => withFileLock(`${SNAPSHOT_FILE}.${safeName(account.accountKey)}.refresh`, async () => {
				const cached = await snapshotStore.load(account.accountKey);
				if (!options?.force && cached && Date.now() - cached.fetchedAt < 60_000) return cached;
				const auth = await ctx.modelRegistry.getProviderAuth(account.providerId);
				const token = auth?.auth.apiKey;
				if (!token) return undefined;
				const combined = AbortSignal.any([signal ?? new AbortController().signal, AbortSignal.timeout(20_000)]);
				if (account.providerId === "anthropic") return anthropic.usage(token, combined);
				if (account.providerId === "openai-codex") {
					const identity = openAIIdentity(token);
					if (!identity.stableIdentity) return undefined;
					return (await codex.fetch({ accessToken: token, accountId: identity.stableIdentity, planType: identity.planType, localDate: localDate(), signal: combined })).usage;
				}
				return undefined;
			}),
		});
		monitor.start(() => catalog.list(), () => requestRender?.());
		if (currentAccount) void monitor.refresh(currentAccount).finally(() => requestRender?.());
		if (ctx.mode === "tui") {
			installFooter(ctx);
			void refreshGit(ctx);
			gitTimer = setInterval(() => void refreshGit(ctx), GIT_TTL_MS);
			gitTimer.unref?.();
		}
	});

	pi.on("model_select", async (event, ctx) => {
		currentAccount = await observeProvider(String(event.model.provider), ctx, true);
		if (currentAccount && monitor) await monitor.refresh(currentAccount);
		requestRender?.();
	});

	pi.on("turn_end", (event, ctx) => {
		if (event.message.role !== "assistant") return;
		const entries = ctx.sessionManager.getEntries();
		const message = event.message as AssistantMessage;
		const entry = [...entries].reverse().find((candidate: any) =>
			candidate.type === "message" && candidate.message?.role === "assistant" &&
			candidate.message.timestamp === message.timestamp &&
			candidate.message.provider === message.provider &&
			candidate.message.model === message.model,
		) as any;
		if (entry?.id) appendAttribution(ctx, entry.id, "assistant", message.model);
		requestRender?.();
	});

	pi.on("session_compact", (event, ctx) => {
		if (event.compactionEntry.usage) appendAttribution(ctx, event.compactionEntry.id, "compaction");
	});
	pi.on("session_tree", (event, ctx) => {
		if (event.summaryEntry?.usage) appendAttribution(ctx, event.summaryEntry.id, "branch_summary");
	});
	pi.on("agent_settled", () => {
		if (currentAccount && monitor) void monitor.refresh(currentAccount).finally(() => requestRender?.());
	});
	pi.on("session_shutdown", () => {
		monitor?.stop();
		if (gitTimer) clearInterval(gitTimer);
		gitTimer = undefined;
	});

	pi.registerCommand("statusline", {
		description: "Toggle the account-aware usage footer",
		handler: async (_args, ctx) => {
			if (enabled) { ctx.ui.setFooter(undefined); enabled = false; }
			else installFooter(ctx);
		},
	});

	pi.registerCommand("account-label", {
		description: "Rename the active Provider Account",
		handler: async (args, ctx) => {
			if (!currentAccount) return ctx.ui.notify("No active Provider Account", "error");
			const label = args.trim() || await ctx.ui.input("Account label", currentAccount.label ?? currentAccount.suggestedLabel ?? "");
			if (!label) return;
			try { await catalog.label({ accountKey: currentAccount.accountKey, label }); currentAccount = catalog.get(currentAccount.accountKey); requestRender?.(); }
			catch (error) { ctx.ui.notify(error instanceof Error ? error.message : String(error), "error"); }
		},
	});

	pi.registerCommand("usage", {
		description: "Open the Provider Account usage dashboard",
		handler: async (_args, ctx) => {
			while (true) {
				const action = await showUsageDashboard(ctx, dashboardEntries(ctx), currentAccount?.accountKey, {
					loadLocal: async (entry) => localUsage?.summarize(entry.account),
					refresh: async (entry) => {
						await monitor?.refresh(entry.account, { force: true });
						const account = catalog.get(entry.account.accountKey) ?? entry.account;
						const updated = dashboardEntry(ctx, account);
						return { ...updated, usage: { ...updated.usage, local: entry.usage.local } };
					},
				});
				if (action.type === "close") return;
				const account = catalog.get(action.accountKey);
				if (!account) continue;
				if (action.type === "rename") {
					const label = await ctx.ui.input("Account label", account.label ?? account.suggestedLabel ?? "");
					if (label) {
						await catalog.label({ accountKey: account.accountKey, label }).catch((error) => ctx.ui.notify(String(error), "error"));
						if (currentAccount?.accountKey === account.accountKey) currentAccount = catalog.get(account.accountKey);
					}
				} else if (action.type === "archive") await catalog.archive(account.accountKey, !account.archived);
				else if (action.type === "use") {
					if (!account.active) { ctx.ui.setEditorText(`/login ${account.providerId}`); ctx.ui.notify("Submit the prefilled login command, then select a model", "info"); return; }
					const models = ctx.modelRegistry.getAvailable().filter((model) => model.provider === account.providerId);
					const selected = await ctx.ui.select("Use model", models.map((model) => model.id));
					const model = models.find((candidate) => candidate.id === selected);
					if (model) await pi.setModel(model);
				}
			}
		},
	});
}
