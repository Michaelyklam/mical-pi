/**
 * ccstatusline-footer — mirrors my Claude Code statusline (ccstatusline) in pi.
 *
 * Claude Code config being mirrored (~/.config/ccstatusline/settings.json):
 *   line 1: Model: <name> | Ctx: <tokens> | ⎇ <branch> | (+N,-M)
 *   line 2: Cost: $X      | Today: $A/$B  | Quota: $R/$1500
 *
 * Line 1 + Cost are rendered natively from pi session state (accurate + free).
 * The two money widgets come from the same external sources ccstatusline uses:
 *   - Today: $A/$B  -> ~/.local/bin/ccstatusline-today-vs-budget (ccusage + jq)
 *   - Quota: $R     -> ~/.cache/ccstatusline/usage.json (extraUsageLimit - extraUsageUsed)
 *
 * render() is synchronous, so everything slow is refreshed on background timers
 * that call tui.requestRender(). Any failing source is simply omitted — render
 * never throws.
 */

import type { AssistantMessage } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

/** "ansi" = byte-identical ccstatusline colors. "theme" = follow the pi theme. */
const COLOR_MODE: "ansi" | "theme" = "ansi";

/** Quota denominator shown after the slash (ccstatusline custom-text "/$1500"). */
const QUOTA_LIMIT_LABEL = "/$1500";

const GIT_TTL_MS = 5_000; // matches gitCacheTtlSeconds: 5
const TODAY_TTL_MS = 60_000; // ccusage is slow; 1 min is plenty
const QUOTA_READ_TTL_MS = 30_000; // re-read the cache file
const QUOTA_REFRESH_TTL_MS = 5 * 60_000; // have ccstatusline refresh the cache

const TODAY_SCRIPT = join(homedir(), ".local/bin/ccstatusline-today-vs-budget");
const USAGE_CACHE = join(homedir(), ".cache/ccstatusline/usage.json");

// ---------------------------------------------------------------------------
// Colors
// ---------------------------------------------------------------------------

// ccstatusline colorLevel 2 (256-color) values for the named colors in use.
const ANSI = {
	cyan: "\x1b[38;5;30m",
	brightBlack: "\x1b[38;5;59m",
	magenta: "\x1b[38;5;96m",
	yellow: "\x1b[38;5;178m",
	green: "\x1b[38;5;70m",
	reset: "\x1b[39m",
} as const;

type ColorName = "cyan" | "brightBlack" | "magenta" | "yellow" | "green";

// Fallback mapping onto pi theme roles when COLOR_MODE === "theme".
const THEME_ROLE: Record<ColorName, string> = {
	cyan: "accent",
	brightBlack: "dim",
	magenta: "syntaxKeyword",
	yellow: "warning",
	green: "success",
};

type ThemeLike = { fg(color: string, text: string): string };

function paint(theme: ThemeLike, color: ColorName, text: string): string {
	if (!text) return text;
	if (COLOR_MODE === "ansi") return `${ANSI[color]}${text}${ANSI.reset}`;
	try {
		return theme.fg(THEME_ROLE[color] as never, text);
	} catch {
		return text;
	}
}

// ---------------------------------------------------------------------------
// Formatting helpers (mirrors of ccstatusline's own)
// ---------------------------------------------------------------------------

/** Same algorithm as ccstatusline's formatTokens(). */
function formatTokens(count: number, decimals = 1): string {
	if (count >= 1e6 - 500 / 10 ** decimals) return `${(count / 1e6).toFixed(1)}M`;
	if (count >= 1000) return `${(count / 1000).toFixed(decimals)}k`;
	return String(count);
}

function money(n: number): string {
	return `$${n.toFixed(2)}`;
}

// ---------------------------------------------------------------------------
// Background data sources
// ---------------------------------------------------------------------------

interface GitChanges {
	insertions: number;
	deletions: number;
}

/** Mutable state shared between the timers and the synchronous render(). */
interface FooterState {
	git?: GitChanges;
	today?: string; // e.g. "$73.60/$59.60"
	quotaRemaining?: number; // dollars
}

const state: FooterState = {};

/** Parse `git diff --shortstat` output, as ccstatusline does. */
function parseShortstat(out: string): GitChanges {
	const ins = /(\d+) insertions?/.exec(out);
	const del = /(\d+) deletions?/.exec(out);
	return {
		insertions: ins?.[1] ? parseInt(ins[1], 10) : 0,
		deletions: del?.[1] ? parseInt(del[1], 10) : 0,
	};
}

async function refreshGit(pi: ExtensionAPI, cwd: string): Promise<void> {
	try {
		const [unstaged, staged] = await Promise.all([
			pi.exec("git", ["diff", "--shortstat"], { cwd, timeout: 3000 }),
			pi.exec("git", ["diff", "--cached", "--shortstat"], { cwd, timeout: 3000 }),
		]);
		if (unstaged.code !== 0 && staged.code !== 0) {
			state.git = undefined;
			return;
		}
		const a = parseShortstat(unstaged.stdout || "");
		const b = parseShortstat(staged.stdout || "");
		state.git = { insertions: a.insertions + b.insertions, deletions: a.deletions + b.deletions };
	} catch {
		state.git = undefined;
	}
}

async function refreshToday(pi: ExtensionAPI): Promise<void> {
	try {
		const res = await pi.exec(TODAY_SCRIPT, [], { timeout: 20_000 });
		const line = (res.stdout || "").trim().split("\n").pop()?.trim();
		// The script prints e.g. "Today: $73.60/$59.60" or just the values —
		// strip any leading label so we control the label ourselves.
		state.today = line ? line.replace(/^\s*Today:\s*/i, "") || undefined : undefined;
	} catch {
		state.today = undefined;
	}
}

function readQuotaCache(): void {
	try {
		const raw = JSON.parse(readFileSync(USAGE_CACHE, "utf8")) as {
			extraUsageLimit?: number;
			extraUsageUsed?: number;
		};
		if (typeof raw.extraUsageLimit === "number" && typeof raw.extraUsageUsed === "number") {
			state.quotaRemaining = Math.max(0, (raw.extraUsageLimit - raw.extraUsageUsed) / 100);
		}
	} catch {
		// Leave the previous value in place; a missing cache file is not fatal.
	}
}

/**
 * Ask ccstatusline to refresh ~/.cache/ccstatusline/usage.json for us.
 * It owns the keychain OAuth token, the /oauth/usage call and the lock file, so
 * we reuse it instead of reimplementing that. Output is discarded.
 */
async function refreshQuotaCache(pi: ExtensionAPI, cwd: string): Promise<void> {
	try {
		const payload = JSON.stringify({
			hook_event_name: "Status",
			session_id: "pi-footer",
			transcript_path: "/dev/null",
			cwd,
			model: { id: "claude-opus-4-5", display_name: "pi" },
			workspace: { current_dir: cwd, project_dir: cwd },
			version: "2.0.0",
		});
		// Feed the payload on stdin via a shell so we don't need stdin plumbing.
		await pi.exec("/bin/sh", ["-c", `printf %s ${shellQuote(payload)} | ccstatusline >/dev/null 2>&1`], {
			cwd,
			timeout: 20_000,
		});
	} catch {
		// ignore
	}
	readQuotaCache();
}

function shellQuote(s: string): string {
	return `'${s.replace(/'/g, `'\\''`)}'`;
}

// ---------------------------------------------------------------------------
// Native (pi-sourced) segments
// ---------------------------------------------------------------------------

function sessionCost(ctx: ExtensionContext): number {
	let cost = 0;
	for (const entry of ctx.sessionManager.getEntries()) {
		if (entry.type === "message" && entry.message.role === "assistant") {
			cost += (entry.message as AssistantMessage).usage.cost.total;
		} else if (entry.type === "message" && entry.message.role === "toolResult" && entry.message.usage) {
			cost += entry.message.usage.cost.total;
		} else if ((entry.type === "branch_summary" || entry.type === "compaction") && entry.usage) {
			cost += entry.usage.cost.total;
		}
	}
	return cost;
}

// ---------------------------------------------------------------------------
// Extension
// ---------------------------------------------------------------------------

export default function (pi: ExtensionAPI) {
	let enabled = false;

	function install(ctx: ExtensionContext): void {
		ctx.ui.setFooter((tui, theme, footerData) => {
			const rerender = () => tui.requestRender();
			const cwd = ctx.cwd;

			// Kick off the first fetches immediately, then on interval.
			readQuotaCache();
			void refreshGit(pi, cwd).then(rerender);
			void refreshToday(pi).then(rerender);
			void refreshQuotaCache(pi, cwd).then(rerender);

			const timers = [
				setInterval(() => void refreshGit(pi, cwd).then(rerender), GIT_TTL_MS),
				setInterval(() => void refreshToday(pi).then(rerender), TODAY_TTL_MS),
				setInterval(() => {
					readQuotaCache();
					rerender();
				}, QUOTA_READ_TTL_MS),
				setInterval(() => void refreshQuotaCache(pi, cwd).then(rerender), QUOTA_REFRESH_TTL_MS),
			];
			for (const t of timers) t.unref?.();

			const unsubBranch = footerData.onBranchChange(() => {
				void refreshGit(pi, cwd).then(rerender);
				rerender();
			});

			const sep = () => paint(theme, "brightBlack", " | ");

			function line1(): string {
				const parts: string[] = [];

				const model = ctx.model?.id;
				if (model) parts.push(paint(theme, "cyan", `Model: ${model}`));

				const usage = ctx.getContextUsage();
				const tokens = usage?.tokens;
				parts.push(
					paint(theme, "brightBlack", `Ctx: ${typeof tokens === "number" ? formatTokens(tokens) : "?"}`),
				);

				const branch = footerData.getGitBranch();
				if (branch) parts.push(paint(theme, "magenta", `⎇ ${branch}`));

				const git = state.git;
				if (git && (git.insertions || git.deletions)) {
					parts.push(paint(theme, "yellow", `(+${git.insertions},-${git.deletions})`));
				}

				return parts.join(sep());
			}

			function line2(): string {
				const parts: string[] = [];

				parts.push(paint(theme, "green", `Cost: ${money(sessionCost(ctx))}`));

				if (state.today) parts.push(paint(theme, "cyan", `Today: ${state.today}`));

				if (typeof state.quotaRemaining === "number") {
					parts.push(paint(theme, "green", `Quota: ${money(state.quotaRemaining)}${QUOTA_LIMIT_LABEL}`));
				}

				return parts.join(sep());
			}

			return {
				dispose() {
					for (const t of timers) clearInterval(t);
					unsubBranch();
				},
				invalidate() {},
				render(width: number): string[] {
					const fit = (s: string) =>
						visibleWidth(s) > width ? truncateToWidth(s, width, paint(theme, "brightBlack", "...")) : s;
					try {
						return [fit(line1()), fit(line2())];
					} catch {
						return [paint(theme, "brightBlack", "statusline unavailable")];
					}
				},
			};
		});
		enabled = true;
	}

	pi.on("session_start", async (_event, ctx) => {
		if (ctx.mode !== "tui") return;
		install(ctx);
	});

	pi.registerCommand("statusline", {
		description: "Toggle the ccstatusline-style footer",
		handler: async (_args, ctx) => {
			if (enabled) {
				ctx.ui.setFooter(undefined);
				enabled = false;
				ctx.ui.notify("Built-in pi footer restored", "info");
			} else {
				install(ctx);
				ctx.ui.notify("ccstatusline-style footer enabled", "info");
			}
		},
	});
}
