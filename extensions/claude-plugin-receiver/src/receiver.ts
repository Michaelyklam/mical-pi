import { createHash } from "node:crypto";
import { mkdir, realpath, rename, rm } from "node:fs/promises";
import * as path from "node:path";
import { materializeGit, parseMarketplaceSource, remoteHead } from "./git.ts";
import {
	materializeSkills,
	readMarketplace,
	readPluginManifest,
	selectedSkillDirectories,
} from "./manifests.ts";
import { ReceiverStore, safeSegment } from "./store.ts";
import type {
	GitSource,
	InstallPreview,
	LoadedResources,
	MarketplaceManifest,
	MarketplacePluginEntry,
	MarketplaceRecord,
	PluginRecord,
	PluginSource,
	ReceiverState,
	SyncResult,
	UpdateReceipt,
} from "./types.ts";

export class PluginReceiver {
	readonly store: ReceiverStore;
	readonly allowLocalSources: boolean;

	constructor(root: string, options?: { allowLocalSources?: boolean }) {
		this.store = new ReceiverStore(root);
		this.allowLocalSources = options?.allowLocalSources ?? false;
	}

	async loadedResources(): Promise<LoadedResources> {
		const state = await this.store.read();
		const skillPaths: string[] = [];
		const versions: Array<{ pluginId: string; version: string }> = [];
		for (const plugin of Object.values(state.plugins).sort((a, b) => a.id.localeCompare(b.id))) {
			if (!plugin.current) continue;
			versions.push({ pluginId: plugin.id, version: plugin.current.version });
			for (const skill of plugin.current.skills) skillPaths.push(skill.cachePath);
		}
		return { skillPaths, versions };
	}

	async addMarketplace(rawSource: string): Promise<MarketplaceRecord> {
		return this.store.withLock("startup-update", () =>
			this.addMarketplaceUnlocked(rawSource),
		);
	}

	private async addMarketplaceUnlocked(rawSource: string): Promise<MarketplaceRecord> {
		const source = parseMarketplaceSource(rawSource, { allowLocal: this.allowLocalSources });
		const sha = await remoteHead(source);
		const temporary = path.join(this.store.root, "tmp", `marketplace-${process.pid}-${Date.now()}`);
		await materializeGit({ source, sha, destination: temporary });
		try {
			const manifest = await readMarketplace(temporary);
			const existing = (await this.store.read()).marketplaces[manifest.name];
			if (existing && (existing.source.url !== source.url || existing.source.ref !== source.ref)) {
				throw new Error(`Marketplace "${manifest.name}" is already registered from ${existing.source.url}.`);
			}
			const checkoutPath = path.join(
				this.store.root,
				"marketplaces",
				safeSegment(manifest.name),
				"checkouts",
				sha,
			);
			await publishImmutable(temporary, checkoutPath);
			const record: MarketplaceRecord = {
				name: manifest.name,
				source,
				checkoutPath,
				currentSha: sha,
				lastAttemptAt: now(),
				lastSuccessfulCheckAt: now(),
			};
			await this.store.update((state) => ({
				...state,
				marketplaces: { ...state.marketplaces, [record.name]: record },
			}));
			return record;
		} finally {
			await rm(temporary, { recursive: true, force: true }).catch(() => undefined);
		}
	}

	async preview(pluginId: string): Promise<InstallPreview> {
		const { name, marketplace: marketplaceName } = parsePluginId(pluginId);
		return this.store.withLock("startup-update", async () => {
			await this.refreshMarketplace(marketplaceName);
			const state = await this.store.read();
			const marketplace = state.marketplaces[marketplaceName];
			if (!marketplace) throw new Error(`Unknown marketplace "${marketplaceName}".`);
			const catalog = await readMarketplace(marketplace.checkoutPath);
			const entry = catalog.plugins.find((candidate) => candidate.name === name);
			if (!entry) throw new Error(`Plugin "${name}" is not in marketplace "${marketplaceName}".`);
			const source = await this.resolvePluginSource(marketplace, catalog, entry);
			try {
				const manifest = await readPluginManifest(source.pluginRoot);
				if (manifest && entry.strict !== false && manifest.name !== entry.name) {
					throw new Error(`Plugin manifest name "${manifest.name}" does not match marketplace entry "${entry.name}".`);
				}
				const version = manifest?.version ?? entry.version ?? source.sha;
				const skills = await selectedSkillDirectories({
					pluginRoot: source.pluginRoot,
					marketplaceRoot: marketplace.checkoutPath,
					entry,
					manifest,
				});
				const selected = skills.map(({ name: skillName, sourcePath }) => ({ name: skillName, sourcePath }));
				return {
					id: `${name}@${marketplaceName}`,
					version,
					sourceSha: source.sha,
					marketplaceSha: marketplace.currentSha,
					selectionDigest: selectionDigest(entry, manifest, selected),
					skills: selected,
				};
			} finally {
				if (source.temporaryRoot) await rm(source.temporaryRoot, { recursive: true, force: true }).catch(() => undefined);
			}
		});
	}

	async install(
		pluginId: string,
		expected?: Pick<InstallPreview, "version" | "sourceSha" | "marketplaceSha" | "selectionDigest">,
	): Promise<PluginRecord> {
		const { name, marketplace } = parsePluginId(pluginId);
		const id = `${name}@${marketplace}`;
		return this.store.withLock("startup-update", async () => {
			const state = await this.store.read();
			if (!state.marketplaces[marketplace]) throw new Error(`Unknown marketplace "${marketplace}".`);
			const existed = state.plugins[id] !== undefined;
			await this.store.update((current) => ({
				...current,
				plugins: {
					...current.plugins,
					[id]: current.plugins[id] ?? { id, marketplace, name, paused: false },
				},
			}));
			try {
				const result = await this.syncPlugin(id, { refreshMarketplace: true, expected });
				if (!result.current) throw new Error(`Plugin "${id}" did not install.`);
				return result;
			} catch (error) {
				if (!existed) {
					await this.store.update((current) => {
						const plugins = { ...current.plugins };
						delete plugins[id];
						return { ...current, plugins };
					});
				}
				throw error;
			}
		});
	}

	async removeMarketplace(name: string): Promise<boolean> {
		return this.store.withLock("startup-update", async () => {
			let removed: MarketplaceRecord | undefined;
			await this.store.update((state) => {
				if (Object.values(state.plugins).some((plugin) => plugin.marketplace === name)) {
					throw new Error(`Marketplace "${name}" still has installed plugins. Remove them first.`);
				}
				removed = state.marketplaces[name];
				if (!removed) return state;
				const marketplaces = { ...state.marketplaces };
				delete marketplaces[name];
				return { ...state, marketplaces };
			});
			if (removed) {
				const marketplaceRoot = path.dirname(path.dirname(removed.checkoutPath));
				await rm(marketplaceRoot, { recursive: true, force: true }).catch(() => undefined);
			}
			return removed !== undefined;
		});
	}

	async rollback(pluginId: string): Promise<PluginRecord> {
		return this.store.withLock("startup-update", async () => {
			const { name, marketplace } = parsePluginId(pluginId);
			const id = `${name}@${marketplace}`;
			const plugin = (await this.store.read()).plugins[id];
			if (!plugin?.current || !plugin.previous) {
				throw new Error(`Plugin "${id}" has no previous version to roll back to.`);
			}
			const rolledBackAt = now();
			const receipt = changes(
				plugin,
				plugin.previous.version,
				plugin.previous.sourceSha,
				plugin.previous.skills,
				rolledBackAt,
			);
			const updated: PluginRecord = {
				...plugin,
				current: plugin.previous,
				previous: plugin.current,
				pendingChangelog: receipt,
				changelogShownVersion: undefined,
				changelogClaim: undefined,
				lastUpdateAt: rolledBackAt,
				lastError: undefined,
			};
			await this.savePlugin(updated);
			return updated;
		});
	}

	async remove(pluginId: string): Promise<boolean> {
		return this.store.withLock("startup-update", async () => {
			const { name, marketplace } = parsePluginId(pluginId);
			const id = `${name}@${marketplace}`;
			let removed: PluginRecord | undefined;
			await this.store.update((state) => {
				removed = state.plugins[id];
				if (!removed) return state;
				const plugins = { ...state.plugins };
				delete plugins[id];
				return { ...state, plugins };
			});
			// Keep immutable cache trees after removal. The current runtime may still
			// have selected one of them; a later time-based GC can collect orphans.
			return removed !== undefined;
		});
	}

	async setPaused(pluginId: string, paused: boolean): Promise<PluginRecord> {
		return this.store.withLock("startup-update", async () => {
			const { name, marketplace } = parsePluginId(pluginId);
			const id = `${name}@${marketplace}`;
			let updated: PluginRecord | undefined;
			await this.store.update((state) => {
				const current = state.plugins[id];
				if (!current) throw new Error(`Unknown plugin "${id}".`);
				updated = { ...current, paused };
				return { ...state, plugins: { ...state.plugins, [id]: updated } };
			});
			return updated!;
		});
	}

	async refreshCatalogs(): Promise<{ checked: number; failed: ReadonlyArray<{ name: string; error: string }> }> {
		return this.store.withLock("startup-update", async () => {
			const names = Object.keys((await this.store.read()).marketplaces);
			const failed: Array<{ name: string; error: string }> = [];
			for (const name of names) {
				try { await this.refreshMarketplace(name); }
				catch (error) { failed.push({ name, error: message(error) }); }
			}
			return { checked: names.length, failed };
		});
	}

	async syncAll(signal?: AbortSignal): Promise<SyncResult> {
		if (offline()) return { checked: 0, updated: [], failed: [] };
		const result = await this.store.tryWithLock("startup-update", async () => {
			const initial = await this.store.read();
			const ids = Object.values(initial.plugins).filter((plugin) => !plugin.paused).map((plugin) => plugin.id);
			const marketplaces = [...new Set(ids.map((id) => initial.plugins[id]?.marketplace).filter(Boolean) as string[])];
			const marketplaceFailures = new Map<string, string>();
			for (const name of marketplaces) {
				if (signal?.aborted) throw new Error("Plugin update cancelled.");
				try { await this.refreshMarketplace(name, signal); }
				catch (error) {
					if (signal?.aborted) throw error;
					marketplaceFailures.set(name, message(error));
				}
			}
			const updated: PluginRecord[] = [];
			const failed: Array<{ id: string; error: string }> = [];
			for (const id of ids) {
				if (signal?.aborted) throw new Error("Plugin update cancelled.");
				const plugin = (await this.store.read()).plugins[id];
				const marketplaceFailure = plugin ? marketplaceFailures.get(plugin.marketplace) : undefined;
				if (marketplaceFailure) {
					failed.push({ id, error: marketplaceFailure });
					await this.recordPluginError(id, marketplaceFailure);
					continue;
				}
				try {
					const before = plugin?.current?.version;
					const next = await this.syncPlugin(id, { refreshMarketplace: false, signal });
					if (next.current?.version !== before) updated.push(next);
				} catch (error) {
					if (signal?.aborted) throw error;
					const detail = message(error);
					failed.push({ id, error: detail });
					await this.recordPluginError(id, detail);
				}
			}
			return { checked: ids.length, updated, failed };
		});
		return result ?? { checked: 0, updated: [], failed: [] };
	}

	async syncOne(pluginId: string): Promise<PluginRecord> {
		if (offline()) throw new Error("Plugin updates are disabled by PI_OFFLINE.");
		const { name, marketplace } = parsePluginId(pluginId);
		return this.store.withLock("startup-update", () =>
			this.syncPlugin(`${name}@${marketplace}`, { refreshMarketplace: true }),
		);
	}

	async claimPendingChangelogs(
		loaded: LoadedResources,
		owner: string,
	): Promise<ReadonlyArray<{ plugin: PluginRecord; receipt: UpdateReceipt }>> {
		const claimed: Array<{ plugin: PluginRecord; receipt: UpdateReceipt }> = [];
		const loadedVersions = new Map(loaded.versions.map((item) => [item.pluginId, item.version]));
		await this.store.update((state) => {
			const plugins = { ...state.plugins };
			for (const plugin of Object.values(state.plugins)) {
				const receipt = plugin.pendingChangelog;
				if (!receipt || loadedVersions.get(plugin.id) !== receipt.toVersion) continue;
				if (plugin.changelogShownVersion === receipt.toVersion) continue;
				const existing = plugin.changelogClaim;
				const stale = !existing || Date.now() - Date.parse(existing.claimedAt) > 5 * 60_000;
				if (!stale && existing.owner !== owner) continue;
				const next = {
					...plugin,
					changelogClaim: { version: receipt.toVersion, owner, claimedAt: now() },
				};
				plugins[plugin.id] = next;
				claimed.push({ plugin: next, receipt });
			}
			return { ...state, plugins };
		});
		return claimed;
	}

	async acknowledgeChangelog(pluginId: string, version: string, owner: string): Promise<void> {
		await this.store.update((state) => {
			const plugin = state.plugins[pluginId];
			if (!plugin || plugin.current?.version !== version || plugin.changelogClaim?.owner !== owner) return state;
			return {
				...state,
				plugins: {
					...state.plugins,
					[pluginId]: {
						...plugin,
						changelogShownVersion: version,
						changelogClaim: undefined,
					},
				},
			};
		});
	}

	async state(): Promise<ReceiverState> { return this.store.read(); }

	private async refreshMarketplace(name: string, signal?: AbortSignal): Promise<MarketplaceRecord> {
		const state = await this.store.read();
		const current = state.marketplaces[name];
		if (!current) throw new Error(`Unknown marketplace "${name}".`);
		const attempt = now();
		try {
			const sha = await remoteHead(current.source, undefined, signal);
			let checkoutPath = current.checkoutPath;
			if (sha !== current.currentSha) {
				const temporary = path.join(this.store.root, "tmp", `marketplace-refresh-${process.pid}-${Date.now()}`);
				await materializeGit({ source: current.source, sha, destination: temporary, signal });
				try {
					await readMarketplace(temporary);
					checkoutPath = path.join(
						this.store.root,
						"marketplaces",
						safeSegment(name),
						"checkouts",
						sha,
					);
					await publishImmutable(temporary, checkoutPath);
				} finally {
					await rm(temporary, { recursive: true, force: true }).catch(() => undefined);
				}
			}
			const updated = {
				...current,
				checkoutPath,
				currentSha: sha,
				lastAttemptAt: attempt,
				lastSuccessfulCheckAt: now(),
				lastError: undefined,
			};
			await this.store.update((latest) => ({
				...latest,
				marketplaces: { ...latest.marketplaces, [name]: updated },
			}));
			return updated;
		} catch (error) {
			if (signal?.aborted) throw error;
			const detail = message(error);
			await this.store.update((latest) => ({
				...latest,
				marketplaces: { ...latest.marketplaces, [name]: { ...current, lastAttemptAt: attempt, lastError: detail } },
			}));
			throw error;
		}
	}

	private async syncPlugin(
		id: string,
		options: {
			refreshMarketplace: boolean;
			expected?: Pick<InstallPreview, "version" | "sourceSha" | "marketplaceSha" | "selectionDigest">;
			signal?: AbortSignal;
		},
	): Promise<PluginRecord> {
		if (options.refreshMarketplace) {
			const current = (await this.store.read()).plugins[id];
			if (!current) throw new Error(`Unknown plugin "${id}".`);
			await this.refreshMarketplace(current.marketplace, options.signal);
		}
		const state = await this.store.read();
		const subscription = state.plugins[id];
		if (!subscription) throw new Error(`Unknown plugin "${id}".`);
		const marketplace = state.marketplaces[subscription.marketplace];
		if (!marketplace) throw new Error(`Unknown marketplace "${subscription.marketplace}".`);
		const catalog = await readMarketplace(marketplace.checkoutPath);
		const entry = catalog.plugins.find((candidate) => candidate.name === subscription.name);
		if (!entry) throw new Error(`Plugin "${subscription.name}" is not in marketplace "${catalog.name}".`);
		const attempt = now();
		const source = await this.resolvePluginSource(
			marketplace,
			catalog,
			entry,
			options.signal,
		);
		try {
			const manifest = await readPluginManifest(source.pluginRoot);
			if (manifest && entry.strict !== false && manifest.name !== entry.name) {
				throw new Error(`Plugin manifest name "${manifest.name}" does not match marketplace entry "${entry.name}".`);
			}
			const version = manifest?.version ?? entry.version ?? source.sha;
			if (!version.trim()) throw new Error(`Plugin "${id}" resolved an empty version.`);
			if (!options.expected && subscription.current?.version === version) {
				const unchanged = { ...subscription, lastAttemptAt: attempt, lastSuccessfulCheckAt: now(), lastError: undefined };
				await this.savePlugin(unchanged);
				return unchanged;
			}
			const selected = await selectedSkillDirectories({
				pluginRoot: source.pluginRoot,
				marketplaceRoot: marketplace.checkoutPath,
				entry,
				manifest,
			});
			const selection = selected.map(({ name, sourcePath }) => ({ name, sourcePath }));
			if (options.expected && (
				options.expected.version !== version ||
				options.expected.sourceSha !== source.sha ||
				options.expected.marketplaceSha !== marketplace.currentSha ||
				options.expected.selectionDigest !== selectionDigest(entry, manifest, selection)
			)) {
				throw new Error(`Plugin "${id}" changed after confirmation. Review and install it again.`);
			}
			if (subscription.current?.version === version) {
				const unchanged = { ...subscription, lastAttemptAt: attempt, lastSuccessfulCheckAt: now(), lastError: undefined };
				await this.savePlugin(unchanged);
				return unchanged;
			}
			if (options.signal?.aborted) throw new Error("Plugin update cancelled.");
			// Every promotion gets a fresh immutable directory, even when a plugin is
			// removed/reinstalled at the same version while another Pi process still
			// has the prior cache path loaded.
			const versionKey = [
				safeSegment(version),
				source.sha.slice(0, 12),
				`${Date.now()}-${Math.random().toString(16).slice(2, 10)}`,
			].join("-");
			const cachePath = path.join(this.store.root, "cache", safeSegment(subscription.marketplace), safeSegment(subscription.name), versionKey);
			const skills = await materializeSkills({
				pluginRoot: source.pluginRoot,
				cachePath,
				skills: selected,
				signal: options.signal,
			});
			if (options.signal?.aborted) throw new Error("Plugin update cancelled.");
			const installedAt = now();
			const receipt = changes(subscription, version, source.sha, skills, installedAt);
			const updated: PluginRecord = {
				...subscription,
				previous: subscription.current,
				current: { version, sourceSha: source.sha, cachePath, installedAt, skills },
				pendingChangelog: receipt,
				changelogClaim: undefined,
				lastAttemptAt: attempt,
				lastSuccessfulCheckAt: installedAt,
				lastUpdateAt: installedAt,
				lastError: undefined,
			};
			await this.savePlugin(updated);
			return updated;
		} finally {
			if (source.temporaryRoot) await rm(source.temporaryRoot, { recursive: true, force: true }).catch(() => undefined);
		}
	}

	private async resolvePluginSource(
		marketplace: MarketplaceRecord,
		catalog: MarketplaceManifest,
		entry: MarketplacePluginEntry,
		signal?: AbortSignal,
	): Promise<{ pluginRoot: string; sha: string; temporaryRoot?: string }> {
		if (typeof entry.source === "string") {
			if (!entry.source.startsWith("./") && !catalog.metadata?.pluginRoot) {
				throw new Error(`Relative plugin source must start with ./ : ${entry.source}`);
			}
			const pluginRootBase = catalog.metadata?.pluginRoot
				? resolveRelative(marketplace.checkoutPath, catalog.metadata.pluginRoot)
				: marketplace.checkoutPath;
			const pluginRoot = resolveRelative(pluginRootBase, entry.source);
			await containedDirectory(marketplace.checkoutPath, pluginRoot);
			return { pluginRoot, sha: marketplace.currentSha };
		}
		const resolved = gitPluginSource(entry.source, this.allowLocalSources);
		const sha = await remoteHead(resolved.source, resolved.sha, signal);
		const temporaryRoot = path.join(this.store.root, "tmp", `plugin-${process.pid}-${Date.now()}-${hash(entry.name).slice(0, 8)}`);
		try {
			await materializeGit({ source: resolved.source, sha, destination: temporaryRoot, signal });
			const pluginRoot = resolved.subdir ? resolveRelative(temporaryRoot, resolved.subdir) : temporaryRoot;
			await containedDirectory(temporaryRoot, pluginRoot);
			return { pluginRoot, sha, temporaryRoot };
		} catch (error) {
			await rm(temporaryRoot, { recursive: true, force: true }).catch(() => undefined);
			throw error;
		}
	}

	private async savePlugin(plugin: PluginRecord): Promise<void> {
		await this.store.update((state) => {
			const latest = state.plugins[plugin.id];
			const sameVersion = latest?.current?.version === plugin.current?.version;
			const merged = sameVersion && latest
				? {
					...plugin,
					paused: latest.paused,
					changelogShownVersion: latest.changelogShownVersion,
					changelogClaim: latest.changelogClaim,
				}
				: plugin;
			return { ...state, plugins: { ...state.plugins, [plugin.id]: merged } };
		});
	}

	private async recordPluginError(id: string, detail: string): Promise<void> {
		await this.store.update((state) => {
			const plugin = state.plugins[id];
			if (!plugin) return state;
			return { ...state, plugins: { ...state.plugins, [id]: { ...plugin, lastAttemptAt: now(), lastError: detail } } };
		});
	}
}

function gitPluginSource(source: Exclude<PluginSource, string>, allowLocal: boolean): {
	source: GitSource;
	sha?: string;
	subdir?: string;
} {
	if (source.source === "github") {
		return {
			source: { ...parseMarketplaceSource(source.repo, { allowLocal }), ref: source.ref },
			sha: source.sha,
		};
	}
	if (source.source === "url") {
		return { source: { ...parseMarketplaceSource(source.url, { allowLocal }), ref: source.ref }, sha: source.sha };
	}
	return {
		source: { ...parseMarketplaceSource(source.url, { allowLocal }), ref: source.ref },
		sha: source.sha,
		subdir: source.path,
	};
}

function parsePluginId(value: string): { name: string; marketplace: string } {
	const match = value.trim().match(/^([a-z0-9][a-z0-9-]{0,63})@([a-z0-9][a-z0-9-]{0,63})$/);
	if (!match) throw new Error("Plugin id must be name@marketplace.");
	return { name: match[1]!, marketplace: match[2]! };
}

function resolveRelative(root: string, value: string): string {
	if (path.isAbsolute(value)) throw new Error(`Absolute plugin path is not allowed: ${value}`);
	const resolved = path.resolve(root, value);
	const relative = path.relative(path.resolve(root), resolved);
	if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
		throw new Error(`Plugin path escapes marketplace root: ${value}`);
	}
	return resolved;
}

async function containedDirectory(root: string, candidate: string): Promise<void> {
	const [realRoot, realCandidate] = await Promise.all([realpath(root), realpath(candidate)]);
	const relative = path.relative(realRoot, realCandidate);
	if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
		throw new Error(`Plugin source escapes marketplace root: ${candidate}`);
	}
}

function changes(
	previous: PluginRecord,
	toVersion: string,
	toSha: string,
	nextSkills: ReadonlyArray<{ name: string; digest: string }>,
	createdAt: string,
): UpdateReceipt {
	const old = new Map(previous.current?.skills.map((skill) => [skill.name, skill.digest]) ?? []);
	const next = new Map(nextSkills.map((skill) => [skill.name, skill.digest]));
	return {
		fromVersion: previous.current?.version,
		toVersion,
		fromSha: previous.current?.sourceSha,
		toSha,
		createdAt,
		added: [...next.keys()].filter((name) => !old.has(name)).sort(),
		removed: [...old.keys()].filter((name) => !next.has(name)).sort(),
		modified: [...next.keys()].filter((name) => old.has(name) && old.get(name) !== next.get(name)).sort(),
	};
}

function selectionDigest(
	entry: MarketplacePluginEntry,
	manifest: unknown,
	skills: ReadonlyArray<{ name: string; sourcePath: string }>,
): string {
	return hash(stableJson({ entry, manifest, skills }));
}

function stableJson(value: unknown): string {
	if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
	if (value && typeof value === "object") {
		return `{${Object.entries(value as Record<string, unknown>)
			.sort(([left], [right]) => left.localeCompare(right))
			.map(([key, item]) => `${JSON.stringify(key)}:${stableJson(item)}`)
			.join(",")}}`;
	}
	return JSON.stringify(value) ?? "null";
}

async function publishImmutable(stage: string, destination: string): Promise<void> {
	await mkdir(path.dirname(destination), { recursive: true, mode: 0o700 });
	try {
		await rename(stage, destination);
	} catch (error) {
		if (!["EEXIST", "ENOTEMPTY"].includes((error as NodeJS.ErrnoException).code ?? "")) throw error;
		// Another process already published this exact commit.
		await rm(stage, { recursive: true, force: true });
	}
}

function hash(value: string): string { return createHash("sha256").update(value).digest("hex"); }
function now(): string { return new Date().toISOString(); }
function offline(): boolean { return ["1", "true", "yes"].includes((process.env.PI_OFFLINE ?? "").toLowerCase()); }
function message(error: unknown): string { return (error instanceof Error ? error.message : String(error)).slice(0, 4096); }
