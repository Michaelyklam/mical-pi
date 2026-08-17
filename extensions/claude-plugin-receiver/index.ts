import * as path from "node:path";
import type {
	ExtensionAPI,
	ExtensionCommandContext,
	ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { PluginReceiver } from "./src/receiver.ts";
import type { LoadedResources, UpdateReceipt } from "./src/types.ts";

interface ChangelogEntry {
	readonly pluginId: string;
	readonly receipt: UpdateReceipt;
}

const EMPTY_RESOURCES: LoadedResources = { skillPaths: [], versions: [] };

export default function (pi: ExtensionAPI) {
	const receiver = new PluginReceiver(path.join(getAgentDir(), "claude-plugins"));
	let loaded = EMPTY_RESOURCES;
	let sessionContext: ExtensionContext | undefined;
	let startupUpdate: Promise<void> | undefined;
	let startupAbort: AbortController | undefined;

	pi.on("session_start", async (event, ctx) => {
		sessionContext = ctx;
		try {
			// Freeze this session's resource generation before launching network
			// work. An update promoted later is activated only by reload/restart.
			loaded = await receiver.loadedResources();
		} catch (error) {
			if (ctx.hasUI) ctx.ui.notify(`Skill plugin state error: ${explain(error)}`, "error");
			loaded = EMPTY_RESOURCES;
		}
		if (ctx.mode === "tui") {
			try {
				await showPendingChangelogs(
					pi,
					receiver,
					loaded,
					ctx.sessionManager.getSessionId(),
					ctx,
				);
			} catch (error) {
				ctx.ui.notify(`Skill plugin changelog error: ${explain(error)}`, "warning");
			}
		}

		// Headless Pi children also load global extensions. Only the initial
		// interactive parent startup owns an update check; reload/new/fork do not.
		if (ctx.mode !== "tui" || event.reason !== "startup") return;
		startupAbort = new AbortController();
		startupUpdate = receiver.syncAll(startupAbort.signal).then((result) => {
			if (sessionContext !== ctx) return;
			if (result.updated.length > 0) {
				const names = result.updated.map((plugin) => `${plugin.id} ${plugin.current?.version ?? ""}`).join(", ");
				ctx.ui.notify(`Skill plugin updates ready: ${names}. Run /reload to activate.`, "info");
			}
			if (result.failed.length > 0) {
				ctx.ui.setStatus("skill-plugin-updates", `plugin update failed · /plugin-list`);
			} else {
				ctx.ui.setStatus("skill-plugin-updates", undefined);
			}
		}).catch((error) => {
			if (startupAbort?.signal.aborted) return;
			if (sessionContext === ctx) ctx.ui.setStatus("skill-plugin-updates", `plugin update failed · ${explain(error)}`);
		});
	});

	pi.on("resources_discover", () => ({ skillPaths: [...loaded.skillPaths] }));

	pi.on("session_shutdown", async () => {
		sessionContext?.ui.setStatus("skill-plugin-updates", undefined);
		sessionContext = undefined;
		startupAbort?.abort();
		startupAbort = undefined;
		const closing = startupUpdate;
		startupUpdate = undefined;
		if (closing) await closing;
	});

	pi.registerEntryRenderer<ChangelogEntry>("skill-plugin-changelog", (entry, _options, theme) => {
		const data = entry.data;
		if (!data) return new Text(theme.fg("warning", "Skill plugin changelog unavailable"), 0, 0);
		const receipt = data.receipt;
		const lines = [
			theme.fg("accent", theme.bold(`Skill plugin updated · ${data.pluginId}`)),
			theme.fg("muted", `${receipt.fromVersion ?? "new install"} → ${receipt.toVersion} · ${receipt.toSha.slice(0, 12)}`),
			...changeLines(receipt, theme),
		];
		return new Text(lines.join("\n"), 0, 0);
	});

	pi.registerCommand("marketplace", {
		description: "Manage Claude skill-plugin marketplaces: add, list, update",
		handler: async (args, ctx) => {
			const [action, ...rest] = words(args);
			try {
				switch (action) {
					case "add": {
						const source = rest.join(" ");
						if (!source) return usage(ctx, "/marketplace add <owner/repo|https://github.com/...>");
						ctx.ui.notify(`Adding marketplace ${source}…`, "info");
						const record = await receiver.addMarketplace(source);
						ctx.ui.notify(`Added marketplace ${record.name} at ${record.currentSha.slice(0, 12)}.`, "info");
						return;
					}
					case "list": {
						const state = await receiver.state();
						const records = Object.values(state.marketplaces);
						ctx.ui.notify(records.length ? records.map((item) => `${item.name} · ${item.currentSha.slice(0, 12)} · ${item.source.url}`).join("\n") : "No skill-plugin marketplaces.", "info");
						return;
					}
					case "remove": {
						const name = rest[0];
						if (!name) return usage(ctx, "/marketplace remove <name>");
						const removed = await receiver.removeMarketplace(name);
						ctx.ui.notify(removed ? `Removed marketplace ${name}.` : `Unknown marketplace ${name}.`, removed ? "info" : "warning");
						return;
					}
					case "update": {
						const catalogs = await receiver.refreshCatalogs();
						const result = await receiver.syncAll();
						const failures = catalogs.failed.length + result.failed.length;
						ctx.ui.notify(
							`Checked ${catalogs.checked} marketplaces and ${result.checked} plugins; staged ${result.updated.length}; failed ${failures}.`,
							failures ? "warning" : "info",
						);
						if (result.updated.length) {
							await ctx.waitForIdle();
							await reloadTerminal(ctx);
							return;
						}
						return;
					}
					default: return usage(ctx, "/marketplace add <source> | list | update | remove <name>");
				}
			} catch (error) { ctx.ui.notify(explain(error), "error"); }
		},
	});

	pi.registerCommand("plugin-install", {
		description: "Install and subscribe to a skills-only plugin: name@marketplace",
		handler: async (args, ctx) => {
			const id = args.trim();
			if (!id) return usage(ctx, "/plugin-install <name@marketplace>");
			try {
				ctx.ui.notify(`Inspecting ${id}…`, "info");
				const preview = await receiver.preview(id);
				if (ctx.mode !== "tui") {
					ctx.ui.notify("Plugin installation requires an interactive confirmation.", "error");
					return;
				}
				const loadedNames = new Set(
					(ctx.getSystemPromptOptions().skills ?? []).map((skill) => skill.name),
				);
				const collisions = preview.skills
					.map((skill) => skill.name)
					.filter((name) => loadedNames.has(name));
				const confirmed = await ctx.ui.confirm(
					`Install ${preview.id} ${preview.version}?`,
					[
						`${preview.skills.length} skills:\n${preview.skills.map((skill) => `• ${skill.name} (${skill.sourcePath})`).join("\n")}`,
						collisions.length
							? `Warning: existing skills have the same names and may take precedence: ${collisions.join(", ")}`
							: "No currently loaded skill-name collisions detected.",
						`Source commit: ${preview.sourceSha}`,
						"Installing subscribes this plugin to automatic checks on every Pi startup.",
					].join("\n\n"),
				);
				if (!confirmed) return;
				ctx.ui.notify(`Installing ${id}…`, "info");
				const plugin = await receiver.install(id, preview);
				ctx.ui.notify(`Installed ${plugin.id} ${plugin.current?.version}. Reloading…`, "info");
				await ctx.waitForIdle();
				await reloadTerminal(ctx);
				return;
			} catch (error) { ctx.ui.notify(explain(error), "error"); }
		},
	});

	pi.registerCommand("plugin-update", {
		description: "Update one installed skill plugin, or all when no id is supplied",
		handler: async (args, ctx) => {
			try {
				const id = args.trim();
				if (id) {
					const before = (await receiver.state()).plugins[id]?.current?.version;
					const plugin = await receiver.syncOne(id);
					const changed = plugin.current?.version !== before;
					ctx.ui.notify(changed ? `Staged ${id} ${plugin.current?.version}. Reloading…` : `${id} is current at ${plugin.current?.version}.`, "info");
					if (changed) {
						await ctx.waitForIdle();
						await reloadTerminal(ctx);
						return;
					}
					return;
				}
				const result = await receiver.syncAll();
				ctx.ui.notify(`Checked ${result.checked}; staged ${result.updated.length}; failed ${result.failed.length}.`, result.failed.length ? "warning" : "info");
				if (result.updated.length) {
					await ctx.waitForIdle();
					await reloadTerminal(ctx);
					return;
				}
			} catch (error) { ctx.ui.notify(explain(error), "error"); }
		},
	});

	pi.registerCommand("plugin-list", {
		description: "List installed skill plugins and update health",
		handler: async (_args, ctx) => {
			try {
				const state = await receiver.state();
				const plugins = Object.values(state.plugins);
				ctx.ui.notify(plugins.length ? plugins.map(formatPlugin).join("\n") : "No installed skill plugins.", plugins.some((plugin) => plugin.lastError) ? "warning" : "info");
			} catch (error) { ctx.ui.notify(explain(error), "error"); }
		},
	});

	pi.registerCommand("plugin-rollback", {
		description: "Roll back a skill plugin to its previously installed immutable version",
		handler: async (args, ctx) => {
			const id = args.trim();
			if (!id) return usage(ctx, "/plugin-rollback <name@marketplace>");
			try {
				const plugin = await receiver.rollback(id);
				ctx.ui.notify(`Rolled back ${id} to ${plugin.current?.version}. Reloading…`, "warning");
				await ctx.waitForIdle();
				await reloadTerminal(ctx);
				return;
			} catch (error) { ctx.ui.notify(explain(error), "error"); }
		},
	});

	pi.registerCommand("plugin-remove", {
		description: "Remove an installed skill plugin subscription",
		handler: async (args, ctx) => {
			const id = args.trim();
			if (!id) return usage(ctx, "/plugin-remove <name@marketplace>");
			try {
				if (!await receiver.remove(id)) return ctx.ui.notify(`Unknown plugin ${id}.`, "warning");
				ctx.ui.notify(`Removed ${id}. Reloading…`, "info");
				await ctx.waitForIdle();
				await reloadTerminal(ctx);
				return;
			} catch (error) { ctx.ui.notify(explain(error), "error"); }
		},
	});

	pi.registerCommand("plugin-pause", {
		description: "Pause or resume automatic updates for one skill plugin",
		handler: async (args, ctx) => {
			const [id, action] = words(args);
			if (!id || !["on", "off"].includes(action ?? "")) return usage(ctx, "/plugin-pause <name@marketplace> on|off");
			try {
				const plugin = await receiver.setPaused(id, action === "on");
				ctx.ui.notify(`${plugin.id} automatic updates ${plugin.paused ? "paused" : "resumed"}.`, plugin.paused ? "warning" : "info");
			} catch (error) { ctx.ui.notify(explain(error), "error"); }
		},
	});
}

async function showPendingChangelogs(
	pi: ExtensionAPI,
	receiver: PluginReceiver,
	loaded: LoadedResources,
	owner: string,
	ctx: ExtensionContext,
): Promise<void> {
	const existing = new Set(
		ctx.sessionManager.getEntries().flatMap((entry) => {
			if (entry.type !== "custom" || entry.customType !== "skill-plugin-changelog") return [];
			const data = entry.data as ChangelogEntry | undefined;
			return data ? [`${data.pluginId}@${data.receipt.toVersion}:${data.receipt.toSha}`] : [];
		}),
	);
	for (const { plugin, receipt } of await receiver.claimPendingChangelogs(loaded, owner)) {
		const identity = `${plugin.id}@${receipt.toVersion}:${receipt.toSha}`;
		if (!existing.has(identity)) {
			pi.appendEntry<ChangelogEntry>("skill-plugin-changelog", { pluginId: plugin.id, receipt });
			existing.add(identity);
		}
		await receiver.acknowledgeChangelog(plugin.id, receipt.toVersion, owner);
	}
}

function changeLines(receipt: UpdateReceipt, theme: ExtensionContext["ui"]["theme"]): string[] {
	const lines: string[] = [];
	if (receipt.added.length) lines.push(theme.fg("success", `+ ${receipt.added.join(", ")}`));
	if (receipt.modified.length) lines.push(theme.fg("warning", `~ ${receipt.modified.join(", ")}`));
	if (receipt.removed.length) lines.push(theme.fg("error", `- ${receipt.removed.join(", ")}`));
	if (!lines.length) lines.push(theme.fg("muted", "No selected skill file changes."));
	return lines;
}

function formatPlugin(plugin: Awaited<ReturnType<PluginReceiver["state"]>>["plugins"][string]): string {
	const version = plugin.current?.version ?? "not installed";
	const status = plugin.paused ? "paused" : plugin.lastError ? `error: ${plugin.lastError}` : "current";
	return `${plugin.id} · ${version} · ${status}`;
}
function words(value: string): string[] { return value.trim().split(/\s+/).filter(Boolean); }
function explain(error: unknown): string { return (error instanceof Error ? error.message : String(error)).slice(0, 4096); }
function usage(ctx: ExtensionCommandContext, text: string): void { ctx.ui.notify(`Usage: ${text}`, "warning"); }
async function reloadTerminal(ctx: ExtensionCommandContext): Promise<void> { await ctx.reload(); }
