import type { Usage } from "@earendil-works/pi-ai";
import { readdir, readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import type { AccountCatalog } from "./account-catalog.ts";
import type { AttributionRecord, LocalUsageSummary, ProviderAccount } from "./domain.ts";
import { withFileLock, writeJsonAtomic } from "./persistence.ts";
import { PricingResolver } from "./pricing.ts";
import { ATTRIBUTION_ENTRY } from "./session-ledger.ts";

interface CommandResult { stdout: string; code: number }
type Exec = (command: string, args: string[]) => Promise<CommandResult>;
interface UsageRecord { date: string; accountKey?: string; providerId: string; modelId: string; usage: Usage }
interface FileCacheEntry { signature: string; records: UsageRecord[] }
interface LocalIndexFile { version: 1; files: Record<string, FileCacheEntry> }

async function jsonlFiles(root: string): Promise<string[]> {
	const result: string[] = [];
	async function walk(path: string): Promise<void> {
		let entries;
		try { entries = await readdir(path, { withFileTypes: true }); } catch { return; }
		await Promise.all(entries.map(async (entry) => {
			const child = join(path, entry.name);
			if (entry.isDirectory()) await walk(child);
			else if (entry.isFile() && entry.name.endsWith(".jsonl")) result.push(child);
		}));
	}
	await walk(root);
	return result;
}

function emptyUsage(input = 0, output = 0, cacheRead = 0, cacheWrite = 0): Usage {
	return {
		input, output, cacheRead, cacheWrite,
		totalTokens: input + output + cacheRead + cacheWrite,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	};
}

export class LocalUsageIndex {
	private readonly fileCache = new Map<string, FileCacheEntry>();
	private cacheLoaded = false;
	private cacheDirty = false;

	constructor(
		private readonly sessionRoot: string,
		private readonly catalog: AccountCatalog,
		private readonly pricing: PricingResolver,
		private readonly exec: Exec,
		private readonly nativeIdentityMatches: (agent: "claude" | "codex", account: ProviderAccount) => Promise<boolean>,
		private readonly localDate: () => string,
		private readonly cachePath?: string,
	) {}

	private async loadCache(): Promise<void> {
		if (this.cacheLoaded) return;
		this.cacheLoaded = true;
		if (!this.cachePath) return;
		try {
			const parsed = JSON.parse(await readFile(this.cachePath, "utf8")) as LocalIndexFile;
			if (parsed.version === 1) for (const [path, entry] of Object.entries(parsed.files)) this.fileCache.set(path, entry);
		} catch { /* A missing or corrupt derived cache can be rebuilt. */ }
	}

	private async saveCache(): Promise<void> {
		if (!this.cachePath || !this.cacheDirty) return;
		this.cacheDirty = false;
		await withFileLock(this.cachePath, async () => {
			let existing: LocalIndexFile = { version: 1, files: {} };
			try { existing = JSON.parse(await readFile(this.cachePath!, "utf8")) as LocalIndexFile; } catch { /* start clean */ }
			for (const [path, entry] of this.fileCache) existing.files[path] = entry;
			await writeJsonAtomic(this.cachePath!, existing);
		});
	}

	private parseRecords(entries: any[]): UsageRecord[] {
		const attribution = new Map<string, AttributionRecord>();
		for (const entry of entries) {
			if (entry.type === "custom" && entry.customType === ATTRIBUTION_ENTRY) attribution.set(entry.data?.targetEntryId, entry.data);
		}
		const records: UsageRecord[] = [];
		for (const entry of entries) {
			if (entry.type !== "message" || entry.message?.role !== "assistant" || !entry.message.usage) continue;
			const timestamp = entry.timestamp ?? (entry.message.timestamp ? new Date(entry.message.timestamp).toISOString() : "");
			records.push({
				date: String(timestamp).slice(0, 10),
				accountKey: attribution.get(entry.id)?.accountKey,
				providerId: entry.message.provider,
				modelId: entry.message.model,
				usage: entry.message.usage,
			});
		}
		return records;
	}

	private async records(path: string): Promise<UsageRecord[]> {
		try {
			const metadata = await stat(path);
			const signature = `${metadata.size}:${metadata.mtimeMs}`;
			const cached = this.fileCache.get(path);
			if (cached?.signature === signature) return cached.records;
			const entries = (await readFile(path, "utf8")).split("\n").filter(Boolean).map((line) => JSON.parse(line));
			const records = this.parseRecords(entries);
			this.fileCache.set(path, { signature, records });
			this.cacheDirty = true;
			return records;
		} catch { return []; }
	}

	async summarize(account: ProviderAccount): Promise<LocalUsageSummary> {
		await this.loadCache();
		const date = this.localDate();
		let tokens = 0;
		let estimated = 0;
		let hasUnpricedUsage = false;
		const models = new Set<string>();

		for (const path of await jsonlFiles(this.sessionRoot)) {
			for (const record of await this.records(path)) {
				if (record.date !== date) continue;
				const key = record.accountKey ?? this.catalog.resolveLegacy(record.providerId)?.accountKey;
				if (key !== account.accountKey) continue;
				tokens += record.usage.totalTokens;
				models.add(`${record.providerId}/${record.modelId}`);
				const estimate = this.pricing.estimate(record.providerId, record.modelId, record.usage);
				if (estimate) estimated += estimate.amount;
				else if (record.usage.totalTokens > 0) hasUnpricedUsage = true;
			}
		}
		await this.saveCache();

		const agent = account.providerId === "anthropic" ? "claude" : account.providerId === "openai-codex" ? "codex" : undefined;
		if (agent && (await this.nativeIdentityMatches(agent, account))) {
			try {
				const result = await this.exec("ccusage", ["daily", "--json", "--by-agent", "--since", date, "--until", date]);
				if (result.code === 0) {
					const report = JSON.parse(result.stdout);
					const native = report.daily?.flatMap((day: any) => day.agents ?? []).find((item: any) => item.agent === agent);
					for (const breakdown of native?.modelBreakdowns ?? []) {
						const usage = emptyUsage(breakdown.inputTokens ?? 0, breakdown.outputTokens ?? 0, breakdown.cacheReadTokens ?? 0, breakdown.cacheCreationTokens ?? 0);
						tokens += usage.totalTokens;
						models.add(`${account.providerId}/${breakdown.modelName}`);
						const estimate = this.pricing.estimate(account.providerId, breakdown.modelName, usage);
						if (estimate) estimated += estimate.amount;
						else if (usage.totalTokens > 0) hasUnpricedUsage = true;
					}
				}
			} catch { /* Local native usage is optional. */ }
		}
		return { tokens, estimated, hasUnpricedUsage, models: models.size };
	}
}
