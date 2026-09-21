/**
 * self-compact — a standalone Pi extension that lets a long-running,
 * autonomous agent manage its own context window.
 *
 *   pi -e extensions/self-compact/index.ts \
 *      [--compact-soft-at 100000] [--compact-at 200000] [--compact-buffer 100000] [--compact-prompt "..."]
 *
 * - Mode: /self-compact-mode picks Control, Experimental, or Off with a picker (no model turn), and
 *   /self-compact-mode control|experimental|off does the same noninteractively. The choice is saved in the
 *   session as a self-compact-mode entry, so it survives reload and resume, follows /tree, and stays per
 *   session: two Pi sessions can run different arms side by side. New sessions default to Control, and
 *   --compact-experimental bootstraps a session to Experimental.
 * - Three thresholds (notice / warning / forced) capped at 90% of the active model window.
 *   This extension cancels Pi's automatic compaction, overflow recovery included, and replaces it
 *   with the note handoff below. The 90% cap is headroom for the note and the summarizer call, not
 *   a safety net against a turn that outgrows the window.
 * - Guidance reaches the model as a transient message on each LLM call while a phase is active
 *   (the `context` hook); it is never persisted into the model's context. Each threshold crossing shows the full
 *   guidance message once in the TUI. The transcript otherwise only shows the user's prompts and the returned note.
 * - `view_context()` returns used tokens, percent, level, and the thresholds as JSON, since the model cannot see the footer.
 * - At the forced threshold every tool except the enabled self-compaction tool and `view_context` is blocked in
 *   `tool_call` with an explicit reason (the active tool list is never narrowed: Pi would answer
 *   "Tool X not found" before the hook).
 * - `self_compact({ note_to_self })` saves the note, ends the run, compaction runs once the agent is idle with the
 *   replacement summary prompt (--compact-prompt > USER_PROMPT_COMPACTION_MESSAGE.md > built-in), and the note is
 *   returned verbatim as a handoff message (shown in full) that starts the next turn. When Pi would find nothing to
 *   compact (the session fits inside keepRecentTokens) the tool refuses instead of saving a note and locking.
 * - A/B test: /self-compact-mode selects exactly one variant. Control is `self_compact` (variant A);
 *   Experimental is `self_compact_experimental` (variant B). Both are registered at load (registration is not
 *   exposure) and share this one engine, hook set, and persisted state, differing only in the prompt the agent
 *   sees (see variants.ts). Only the selected variant is active, so only its description, snippet, guidelines,
 *   and guidance reach the model. Off removes both, restores Pi's automatic compaction, and stops the lock and
 *   reminders. A user switch is transactional: when Pi's --tools/--exclude-tools filters deny the target, the
 *   previous tool set is restored, the refusal is reported, and nothing is persisted. Startup recovery instead
 *   leaves the session passive when the saved mode is unreachable.
 * - Failure or cancellation keeps the note and the lock; retries, /self-compact-now, reload and /tree recovery.
 * - One-line replacement footer: model id on the left, the 20-cell context bar and phase on the right.
 *
 * Vendored from disler/self-compact-pi-agent (MIT), upstream SHA
 * 576fe4abda021849f5cde5b6f5796467ffa4bcbd, file apps/self-compact/extensions/self-compact/self-compact.ts.
 * See UPSTREAM.md for the full list of local changes. Summary:
 *   - Shipped defaults are fixed token counts (100k / 200k / 100k buffer) instead of percentages,
 *     so the notice/warning lines stay put across models (see defaults.ts).
 *   - Threshold clamping is per field, so partial flag overrides still resolve on small windows
 *     (see thresholds.ts).
 *   - Default prompt files are vendored under extensions/self-compact/prompts/ (see prompts.ts).
 *   - The footer bar is opt-in (--compact-footer) so extensions/usage-footer keeps the footer.
 *   - Per-session mode switching between the control and experimental variants (/self-compact-mode, variants.ts).
 * The upstream build was merged from the claude-fable-5-1 and gpt-6-astra implementations
 * (upstream path specs/self-compact-merge.html).
 */
import { randomUUID } from "node:crypto";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { generateSummary, hasCompactionMaterial, keepRecentTokens } from "./summary.ts";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import { Text, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { formatPct, renderContextBar } from "./context-bar.ts";
import {
	FORCED_PROMPT,
	BUILTIN_PROMPTS,
	loadPromptFile,
	NOTE_MAX_CHARS,
	promptSearchDirs,
	renderTemplate,
	resolveCompactionPrompt,
	type TemplateValues,
} from "./prompts.ts";
import {
	bootstrapMode,
	COMPACT_MODES,
	COMPACT_TOOL_NAMES,
	CONTROL_TOOL_NAME,
	EXPERIMENTAL_FLAG,
	EXPERIMENTAL_TOOL_NAME,
	experimentalGuidance,
	hasEnabledVariant,
	isCompactToolName,
	MODE_CHOICES,
	modeSummary,
	modeToolName,
	parseMode,
	primaryToolName,
	selectVariants,
	variantDefinition,
	VIEW_TOOL_NAME,
	type CompactMode,
	type CompactVariant,
	type GuidanceLevel,
	type VariantState,
} from "./variants.ts";
import {
	HANDOFF_TYPE,
	INFO_ENTRY_TYPE,
	MODE_ENTRY_TYPE,
	PHASE_ENTRY_TYPE,
	STATE_TYPE,
	emptyState,
	latestAssistantUsage,
	recoverMode,
	recoverState,
	type Handoff,
	type ModeEntry,
	type PersistedState,
} from "./state.ts";
import {
	DEFAULT_SPECS,
	LEVEL_ORDER,
	levelFor,
	resolveThresholds,
	SPEC_HELP,
	validateSpecs,
	type ResolvedThresholds,
	type SpecSource,
	type ThresholdSpecs,
	type UsageLevel,
} from "./thresholds.ts";

export const TOOL_NAME = CONTROL_TOOL_NAME;
export { CONTROL_TOOL_NAME, EXPERIMENTAL_TOOL_NAME, VIEW_TOOL_NAME };
export { HANDOFF_TYPE, STATE_TYPE };
const EXTENSION_DIR = dirname(fileURLToPath(import.meta.url));
const MAX_AUTO_RETRIES = 3;
const SUMMARY_ATTEMPTS = 2;
const GUIDANCE_TYPE = "self-compact-guidance";

/**
 * Static system-prompt line for the active variant. It names the enabled
 * self-compaction tool (the control tool wins when both are live), mentions
 * `view_context` only while that tool is active, and is omitted entirely when
 * neither variant is enabled. Cached per tool/view pair so the prompt-cache
 * prefix stays stable between calls.
 */
function systemPromptLine(tool: string, viewActive: boolean): string {
	const view = viewActive
		? `You cannot see your own context usage otherwise: call ${VIEW_TOOL_NAME} (no arguments) whenever you need the current numbers as JSON, for example after a compaction or before deciding to compact; do not poll it every turn. `
		: "";
	return `\n\nself-compact: when context usage crosses a threshold you receive a transient [self-compact · …] message with live numbers. ${view}Call ${tool} alone in a tool batch when you decide to compact, or when a [self-compact · …] message asks you to. After a compaction, your own saved note_to_self is returned to you verbatim as the next message (exactly the note text, nothing else); resume its NEXT ACTION without another user message and never restart work the note marks as done. If no work remains, report completion and stop.`;
}

interface UsageSnapshot {
	tokens: number | null;
	percent: number | null;
	cachedTokens: number;
	window: number;
}

interface Runtime {
	specs: ThresholdSpecs;
	sources: { softAt: SpecSource; at: SpecSource; buffer: SpecSource };
	compactPromptFlag?: string;
	configError?: string;
	resolveError?: string;
	thresholds?: ResolvedThresholds;
	searchDirs: string[];
	usage: UsageSnapshot;
	level: UsageLevel;
	state: PersistedState;
	/** Context epoch: bumps on every compaction and session start so per-epoch guidance re-arms. */
	epoch: number;
	announcedLevel: UsageLevel;
	compactionInFlight: boolean;
	footerEnabled: boolean;
	lastCompactionError?: string;
	retryTimer?: ReturnType<typeof setTimeout>;
	deliveryTimer?: ReturnType<typeof setTimeout>;
	/** Deferred session-start work (resume nudge or pending-note compaction); cancelled on shutdown / tree switch. */
	recoveryTimer?: ReturnType<typeof setTimeout>;
	requestRender?: () => void;
	alive: boolean;
	idleRequestEpoch: number;
	promptErrors: Set<string>;
	/** Self-compaction variants Pi currently has active (--tools / --exclude-tools own this). */
	variants: VariantState;
	/** Selected mode for this session: control, experimental, or off. Persisted as a mode entry. */
	mode: CompactMode;
	/** Where the current mode came from (picker/argument, CLI bootstrap, or the persisted entry). */
	modeSource: ModeEntry["source"];
	/** Set when the selected mode could not be activated (Pi's filters deny its tool). */
	modeBlocked?: string;
	/** Cached system-prompt suffix for the current variant; re-rendered only when the tool name changes. */
	systemPromptCache?: { tool: string; viewActive: boolean; text: string };
}

/** Prompt used by /self-compact-now and the idle nudge; `tool` is the enabled variant. */
function nowPrompt(tool: string, saved?: string): string {
	const base = `Compact now: write your note_to_self (max ${NOTE_MAX_CHARS} chars: goal, DONE with exact paths and commands, IN PROGRESS, key decisions, verified test results, exact NEXT ACTION last) and call ${tool} as your only tool call.`;
	if (!saved) return base;
	return `${base}\n\nA note is already saved from a previous attempt. Pass it to ${tool} verbatim instead of inventing a new one. Saved note, verbatim:\n\n${saved}\n\n---\nCall ${tool} now with exactly that note.`;
}

function guidanceMessage(text: string) {
	return { role: "custom" as const, customType: GUIDANCE_TYPE, content: text, display: false, timestamp: Date.now() };
}

function levelColor(level: UsageLevel): "dim" | "accent" | "warning" | "error" | "muted" {
	if (level === "notice") return "accent";
	if (level === "warning") return "warning";
	if (level === "forced") return "error";
	return level === "idle" ? "dim" : "muted";
}

function levelTag(level: UsageLevel): string {
	if (level === "notice") return "NOTICE";
	if (level === "warning") return "WARNING";
	if (level === "forced") return "FORCED";
	return level === "idle" ? "" : "n/a";
}

/** One short word for the handoff in flight; the lock is implied, so no extra LOCKED suffix. */
function handoffTag(status: Handoff["status"]): string {
	if (status === "failed") return "COMPACTION FAILED";
	if (status === "ready") return "COMPACTED";
	return "COMPACTING";
}

export default function selfCompact(pi: ExtensionAPI) {
	pi.registerFlag("compact-soft-at", { description: `Soft notice threshold (default ${DEFAULT_SPECS.softAt}). ${SPEC_HELP}`, type: "string" });
	pi.registerFlag("compact-at", { description: `Warning threshold: ask the agent to write its note and compact (default ${DEFAULT_SPECS.at}).`, type: "string" });
	pi.registerFlag("compact-buffer", { description: `Extra allowance above --compact-at before other tools are blocked (default ${DEFAULT_SPECS.buffer}; 0 = immediate).`, type: "string" });
	pi.registerFlag("compact-prompt", { description: "Literal text that replaces the compaction summary system prompt.", type: "string" });
	// LOCAL CHANGE: this package also ships extensions/usage-footer, which owns the Pi footer. The
	// self-compact bar is opt-in so it does not fight that extension; enable it with --compact-footer.
	pi.registerFlag("compact-footer", { description: "Replace the Pi footer with the self-compact context bar (default false; extensions/usage-footer owns the footer here).", type: "boolean", default: false });
	// A/B TEST: variant B (self_compact_experimental) is opt-in so variant A stays the default/control.
	pi.registerFlag(EXPERIMENTAL_FLAG, { description: `Also register the experimental ${EXPERIMENTAL_TOOL_NAME} tool (variant B) for A/B testing (default false). Combine with --exclude-tools ${CONTROL_TOOL_NAME} to run variant B alone.`, type: "boolean", default: false });

	const R: Runtime = {
		specs: { ...DEFAULT_SPECS },
		sources: { softAt: "default", at: "default", buffer: "default" },
		searchDirs: promptSearchDirs(process.cwd(), EXTENSION_DIR),
		usage: { tokens: null, percent: null, cachedTokens: 0, window: 0 },
		level: "unknown",
		state: emptyState(),
		epoch: 0,
		announcedLevel: "idle",
		compactionInFlight: false,
		footerEnabled: false,
		alive: true,
		idleRequestEpoch: -1,
		promptErrors: new Set(),
		variants: { control: true, experimental: false },
		mode: "control",
		modeSource: "flag",
	};

	const flag = (name: string): string | undefined => {
		const value = pi.getFlag(name);
		return typeof value === "string" && value.trim() !== "" ? value : undefined;
	};

	const flagOn = (name: string): boolean => {
		try {
			return pi.getFlag(name) === true;
		} catch {
			return false;
		}
	};

	/** CLI flag values are applied after extensions load, so settings are read at session start. */
	function loadSettings() {
		const softFlag = flag("compact-soft-at");
		const atFlag = flag("compact-at");
		const bufferFlag = flag("compact-buffer");
		R.specs = { softAt: softFlag ?? DEFAULT_SPECS.softAt, at: atFlag ?? DEFAULT_SPECS.at, buffer: bufferFlag ?? DEFAULT_SPECS.buffer };
		R.sources = { softAt: softFlag ? "flag" : "default", at: atFlag ? "flag" : "default", buffer: bufferFlag ? "flag" : "default" };
		R.compactPromptFlag = flag("compact-prompt");
		R.footerEnabled = pi.getFlag("compact-footer") === true;
		R.configError = undefined;
		try {
			for (const name of ["compact-soft-at", "compact-at", "compact-buffer", "compact-prompt"]) {
				const value = pi.getFlag(name);
				if (typeof value === "string" && !value.trim()) throw new Error(`--${name} must not be empty.`);
			}
			validateSpecs(R.specs, R.sources);
		} catch (error) {
			R.configError = error instanceof Error ? error.message : String(error);
			process.stderr.write(`[self-compact] REJECTED: ${R.configError}\n`);
		}
	}

	const inert = (): string | undefined => R.configError ?? R.resolveError;
	const enabled = (): boolean => hasEnabledVariant(R.variants);
	/** The tool name every extension-generated message uses; control wins when both variants are live. */
	const activeToolName = (): string => primaryToolName(R.variants) ?? CONTROL_TOOL_NAME;
	const handoff = (): Handoff | undefined => R.state.handoff;
	/** A handoff that still needs work; a completed ("done") handoff is history and must not disable guidance or locking. */
	const activeHandoff = (): Handoff | undefined => {
		const h = R.state.handoff;
		return h && h.status !== "done" ? h : undefined;
	};
	const locked = (): boolean => enabled() && R.state.locked;

	/**
	 * Read which self-compaction tools Pi has active. Pi owns tool selection:
	 * `--exclude-tools` / `--tools` remove extension tools from the active set,
	 * and the experimental tool is only registered when its flag is set.
	 * Called before Pi binds its runtime the call throws; keep the historical
	 * control-only default in that case.
	 */
	function resolveVariants() {
		try {
			R.variants = selectVariants(pi.getActiveTools());
		} catch {
			R.variants = { control: true, experimental: false };
		}
	}

	/** True when the read-only gauge tool is active; if Pi cannot answer, keep the sentence. */
	function viewToolActive(): boolean {
		try {
			return pi.getActiveTools().includes(VIEW_TOOL_NAME);
		} catch {
			return true;
		}
	}

	/** Tools Pi currently reports as active, or undefined before Pi binds its runtime. */
	function readActiveTools(): string[] | undefined {
		try {
			return pi.getActiveTools();
		} catch {
			return undefined;
		}
	}

	interface ModeOutcome {
		ok: boolean;
		/** The mode the extension is left in: the new one on success, the previous one on a refused switch. */
		mode: CompactMode;
		/** Set when the target variant could not be activated. */
		blockedTool?: string;
		reason: string;
	}

	/**
	 * Make `mode` the only active self-compaction variant and leave every unrelated tool
	 * active. Pi owns the hard filters: `setActiveTools` only accepts registered tools that
	 * `--tools` and `--exclude-tools` allow, so a denied variant never comes up.
	 *
	 * `rollback` decides what the active set becomes when the target does not come up:
	 * - "restore": put back exactly the set read before the attempt. A user switch is then
	 *   transactional, so a refused switch leaves the session running the mode it was running,
	 *   with every unrelated tool still active and nothing persisted.
	 * - "passive": trim both variants instead. Startup recovery needs this, because Pi activates
	 *   every registered extension tool while it builds the runtime, so the set read before the
	 *   attempt can already contain a variant this session never selected.
	 */
	function applyMode(mode: CompactMode, source: ModeEntry["source"], rollback: "restore" | "passive"): ModeOutcome {
		// Never strand a saved note: switching to `off` would drop the note waiting to be compacted.
		const pending = activeHandoff();
		if (mode === "off" && pending) return { ok: false, mode: R.mode, reason: `a note is saved and compaction is ${pending.status}` };
		const tool = modeToolName(mode);
		const before = readActiveTools();
		if (!before) return { ok: false, mode: R.mode, reason: "Pi has not bound its runtime yet" };
		const desired = before.filter((name) => !COMPACT_TOOL_NAMES.includes(name));
		if (tool) desired.push(tool);
		const unchanged = desired.length === before.length && desired.every((name) => before.includes(name));
		if (!unchanged) {
			try {
				pi.setActiveTools(desired);
			} catch (error) {
				return { ok: false, mode: R.mode, reason: error instanceof Error ? error.message : String(error) };
			}
		}
		resolveVariants();
		const active = mode === "off" ? !enabled() : tool !== undefined && isCompactToolName(tool, R.variants);
		if (!active) {
			// Pi filters the requested set, so the failed target is already gone. Restore the previous
			// set for a user switch; for startup recovery trim both variants, since the runtime build
			// may have activated a variant this session never selected.
			if (!unchanged) {
				pi.setActiveTools(rollback === "restore" ? before : before.filter((name) => !COMPACT_TOOL_NAMES.includes(name)));
			}
			resolveVariants();
			return { ok: false, mode: R.mode, blockedTool: tool, reason: tool ? `${tool} did not become active` : "no self-compaction tool is available" };
		}
		commitMode(mode, source);
		return { ok: true, mode, reason: "" };
	}

	/**
	 * Store the selection. The entry is the durable per-session choice: a user switch and a
	 * non-default flag bootstrap persist one, while the plain default and every recovery read stay
	 * silent, so a reload or a tree move never duplicates the entry.
	 */
	function commitMode(mode: CompactMode, source: ModeEntry["source"]) {
		const changed = R.mode !== mode;
		const previousLock = R.state.locked;
		R.mode = mode;
		R.modeSource = source;
		R.modeBlocked = undefined;
		R.announcedLevel = "idle";
		R.systemPromptCache = undefined;
		clearTimers();
		if (mode === "off") setLocked(false);
		if (source === "user" || (source === "flag" && mode !== "control")) {
			const entry: ModeEntry = { version: 1, mode, source, at: Date.now() };
			pi.appendEntry(MODE_ENTRY_TYPE, entry);
		}
		if (changed || previousLock !== R.state.locked) save();
	}

	/** One error message for a mode that could not be activated; a pending note changes the wording. */
	function reportModeFailure(ctx: ExtensionContext, requested: CompactMode, outcome: ModeOutcome) {
		const strandedNote = activeHandoff();
		const denied = outcome.blockedTool ? `; Pi's --tools/--exclude-tools filters deny ${outcome.blockedTool} in this session` : "";
		R.modeBlocked = `${outcome.reason}${denied}`;
		notify(
			ctx,
			strandedNote
				? `self-compact: the saved note (${strandedNote.note.length} chars) cannot be compacted (${outcome.reason}${denied}). The note is kept and no tool is locked; restart without that filter, or with --${EXPERIMENTAL_FLAG}, to compact it.`
				: `self-compact: the ${requested} mode cannot be activated (${outcome.reason}${denied}). The extension stays passive: native compaction keeps working and no tool is locked. /self-compact-mode picks another mode.`,
			"error",
		);
	}

	/** Always-visible feedback for a command the user typed (the be-quiet-in-TUI rule does not apply). */
	function feedback(ctx: ExtensionContext, message: string, type: "info" | "warning" | "error" = "info") {
		if (ctx.hasUI) ctx.ui.notify(message, type);
		else if (type !== "info") process.stderr.write(`[self-compact] ${message}\n`);
	}

	/** /self-compact-mode: refuse mid-handoff, apply, then report exactly what happened. */
	function switchMode(ctx: ExtensionContext, mode: CompactMode) {
		const pending = activeHandoff();
		if (pending) {
			feedback(
				ctx,
				`self-compact: cannot switch to ${mode} while a note is saved and compaction is ${pending.status}. The note is kept; wait for the handoff, or run /self-compact-now to retry. Nothing changed.`,
				"warning",
			);
			return;
		}
		const outcome = applyMode(mode, "user", "restore");
		if (!outcome.ok) {
			const denied = outcome.blockedTool ? `; Pi's --tools/--exclude-tools filters deny ${outcome.blockedTool} in this session` : "";
			// A user switch is transactional, so applyMode restored the previous tool set. Report the
			// state the session is really in instead of naming a mode that is no longer running.
			feedback(
				ctx,
				enabled()
					? `self-compact: cannot activate ${mode} (${outcome.reason}${denied}). Nothing changed: the session still runs ${outcome.mode} (${modeSummary(outcome.mode)}).`
					: `self-compact: cannot activate ${mode} (${outcome.reason}${denied}). Nothing changed: the extension stays passive, native compaction keeps working, and no tool is locked.`,
				"error",
			);
			return;
		}
		trackLevel(ctx);
		feedback(ctx, `self-compact: mode ${mode}, ${modeSummary(mode)}. Saved for this session only; other Pi sessions keep their own mode.`, "info");
	}

	// ---------------------------------------------------------------- helpers

	/** Info toasts stay out of the TUI (the footer, phase lines, and handoff line already show them); warnings and errors show everywhere. */
	function notify(ctx: ExtensionContext, message: string, type: "info" | "warning" | "error" = "info") {
		if (!ctx.hasUI) return;
		if (type === "info" && ctx.mode === "tui") return;
		ctx.ui.notify(message, type);
	}

	function save() {
		pi.appendEntry(STATE_TYPE, structuredClone(R.state));
	}

	/** Every deferred callback belongs to one session epoch; a new session, tree switch, or shutdown cancels them all. */
	function clearTimers() {
		for (const key of ["retryTimer", "deliveryTimer", "recoveryTimer"] as const) {
			if (R[key]) clearTimeout(R[key]);
			R[key] = undefined;
		}
	}

	/** Run `fn` after `delayMs` only if the session epoch is unchanged and the runtime is alive. */
	function deferInEpoch(key: "retryTimer" | "recoveryTimer", delayMs: number, fn: () => void) {
		if (R[key]) clearTimeout(R[key]);
		const epoch = R.epoch;
		R[key] = setTimeout(() => {
			R[key] = undefined;
			if (!R.alive || epoch !== R.epoch) return;
			fn();
		}, delayMs);
	}

	function setLocked(value: boolean) {
		if (R.state.locked === value) return;
		R.state.locked = value;
	}

	function resolve(ctx: ExtensionContext) {
		const result = resolveThresholds(R.specs, ctx.model?.contextWindow ?? 0, { sources: R.sources });
		if (result.ok) {
			R.thresholds = result.thresholds;
			R.resolveError = undefined;
			if (result.thresholds.notes.length > 0) notify(ctx, `self-compact: ${result.thresholds.notes.join(" ")}`, "warning");
		} else {
			R.thresholds = undefined;
			R.resolveError = result.error;
		}
	}

	function snapshotUsage(ctx: ExtensionContext): UsageSnapshot {
		const usage = ctx.getContextUsage();
		const window = usage?.contextWindow ?? ctx.model?.contextWindow ?? 0;
		const tokens = usage?.tokens ?? null;
		const percent = usage?.percent ?? (tokens !== null && window > 0 ? (tokens / window) * 100 : null);
		let cachedTokens = 0;
		if (tokens !== null) {
			const last = latestAssistantUsage(ctx.sessionManager.getBranch() as never[]);
			cachedTokens = Math.min(tokens, last?.cacheRead ?? 0);
		}
		return { tokens, percent, cachedTokens, window };
	}

	function templateValues(): TemplateValues {
		const t = R.thresholds;
		const u = R.usage;
		const tokens = u.tokens ?? 0;
		return {
			used_tokens: tokens.toLocaleString("en-US"),
			context_tokens: tokens.toLocaleString("en-US"),
			context_percent: u.percent?.toFixed(1) ?? "unknown",
			remaining_tokens: Math.max(0, u.window - tokens).toLocaleString("en-US"),
			used_percent: formatPct(u.percent, 1),
			cached_tokens: u.cachedTokens.toLocaleString("en-US"),
			context_window: u.window.toLocaleString("en-US"),
			soft_tokens: (t?.softTokens ?? 0).toLocaleString("en-US"),
			soft_percent: formatPct(t?.softPct ?? null, 1),
			warning_tokens: (t?.warnTokens ?? 0).toLocaleString("en-US"),
			warning_percent: formatPct(t?.warnPct ?? null, 1),
			forced_tokens: (t?.forcedTokens ?? 0).toLocaleString("en-US"),
			forced_percent: formatPct(t?.forcedPct ?? null, 1),
			remaining_to_forced: Math.max(0, (t?.forcedTokens ?? 0) - tokens).toLocaleString("en-US"),
			cycle: R.state.cycle,
			note_max_chars: NOTE_MAX_CHARS,
			tool_name: activeToolName(),
		};
	}

	function contextBarText(): string {
		const t = R.thresholds;
		const u = R.usage;
		if (!t) return "[--------------------] --%";
		const cachedPct = u.window > 0 ? (u.cachedTokens / u.window) * 100 : 0;
		return renderContextBar({ usedPct: u.percent, cachedPct, softPct: t.softPct, warnPct: t.warnPct, forcedPct: t.forcedPct }).text;
	}

	/** Footer tag: REJECTED > PASSIVE (no variant enabled) > handoff in flight > phase. */
	function statusTag(): string {
		if (inert()) return "REJECTED";
		if (!enabled()) return R.mode === "off" ? "OFF" : "PASSIVE";
		const h = handoff();
		if (h && h.status !== "done") return handoffTag(h.status);
		return levelTag(R.level);
	}

	function refreshUi(ctx: ExtensionContext) {
		R.usage = snapshotUsage(ctx);
		R.level = R.thresholds ? levelFor(R.usage.tokens, R.thresholds) : "unknown";
		if (ctx.mode === "tui") R.requestRender?.();
		else if (ctx.hasUI) ctx.ui.setStatus("self-compact", [contextBarText(), statusTag()].filter(Boolean).join(" "));
	}

	/**
	 * False when Pi would answer "Nothing to compact": the whole session still fits inside keepRecentTokens.
	 * Locking tools or asking for a note would then strand the agent, so the extension stays quiet instead.
	 */
	function compactable(ctx: ExtensionContext): boolean {
		return hasCompactionMaterial(ctx.sessionManager.getBranch(), keepRecentTokens(ctx.cwd));
	}

	/** Called whenever usage may have changed: records crossings (TUI-only line) and engages the forced lock. */
	function trackLevel(ctx: ExtensionContext) {
		resolveVariants();
		refreshUi(ctx);
		// No reachable self-compaction tool: stay passive so the agent is never locked out.
		if (!enabled()) return;
		if (inert() || !R.thresholds) return;
		const level = R.level;
		if (level === "unknown" || level === "idle") return;
		if (level === "forced" && !locked() && !activeHandoff() && compactable(ctx)) {
			setLocked(true);
			save();
		}
		if (LEVEL_ORDER[level] > LEVEL_ORDER[R.announcedLevel]) {
			R.announcedLevel = level;
			// The crossing entry carries the full guidance message the model will receive, shown once in the TUI.
			let text: string | undefined;
			try { text = renderGuidance(level); }
			catch { text = renderTemplate(level === "forced" ? FORCED_PROMPT : BUILTIN_PROMPTS[level === "notice" ? "soft" : "warning"], templateValues()); }
			pi.appendEntry(PHASE_ENTRY_TYPE, { level, tokens: R.usage.tokens, percent: R.usage.percent, text, at: Date.now() });
			if (ctx.mode !== "tui") notify(ctx, `self-compact: ${levelTag(level).toLowerCase()} threshold crossed at ${formatPct(R.usage.percent, 1)}${level === "forced" ? `; tools locked until ${activeToolName()} runs` : ""}`, level === "forced" ? "error" : level === "warning" ? "warning" : "info");
		}
	}

	/**
	 * The guidance message for a level. Variant A renders the (user-overridable)
	 * prompt files; variant B renders the experimental prompt with the same live
	 * numbers and thresholds. When both are enabled the control prompt wins.
	 */
	function renderGuidance(level: UsageLevel): string {
		const guidanceLevel: GuidanceLevel = level === "forced" ? "forced" : level === "notice" ? "notice" : "warning";
		if (R.variants.experimental && !R.variants.control) return renderTemplate(experimentalGuidance(guidanceLevel), templateValues());
		if (level === "notice") return renderTemplate(loadPromptFile("soft", R.searchDirs).text, templateValues());
		if (level === "forced") return renderTemplate(FORCED_PROMPT, templateValues());
		return renderTemplate(loadPromptFile("warning", R.searchDirs).text, templateValues());
	}

	/** One transient guidance message is rebuilt from current usage for every LLM call. */
	function guidanceText(ctx: ExtensionContext): string | undefined {
		if (!enabled()) return undefined;
		if (inert() || !R.thresholds || activeHandoff()) return undefined;
		const level = locked() ? "forced" : R.level;
		if (level === "unknown" || level === "idle") return undefined;
		if (!compactable(ctx)) return undefined;
		return renderGuidance(level);
	}

	function deliverHandoff(ctx: ExtensionContext) {
		if (!enabled()) return;
		const h = handoff();
		if (!R.alive || !h || h.status !== "ready") return;
		if (!ctx.isIdle()) {
			if (!R.deliveryTimer) {
				const epoch = R.epoch;
				R.deliveryTimer = setTimeout(() => {
					R.deliveryTimer = undefined;
					if (epoch === R.epoch) deliverHandoff(ctx);
				}, 25);
			}
			return;
		}
		// Content is exactly the saved note (verbatim contract); the header lives in the renderer and details.
		pi.sendMessage({ customType: HANDOFF_TYPE, content: h.note, display: true, details: { id: h.id, cycle: R.state.cycle, note: h.note } }, { triggerTurn: true });
	}

	function startCompaction(ctx: ExtensionContext, trigger: string) {
		if (!enabled()) return;
		const h = handoff();
		if (R.compactionInFlight || !h || (h.status !== "pending" && h.status !== "failed")) return;
		R.compactionInFlight = true;
		h.status = "compacting";
		save();
		notify(ctx, `self-compact: compacting (${trigger}, note ${h.note.length} chars)…`, "info");
		refreshUi(ctx);
		ctx.compact({
			onComplete: () => {
				R.compactionInFlight = false;
			},
			onError: () => {
				R.compactionInFlight = false;
			},
		});
	}

	function scheduleRetry(ctx: ExtensionContext) {
		const delay = 2_000 * Math.max(1, handoff()?.attempts ?? 1);
		deferInEpoch("retryTimer", delay, () => {
			if (handoff()?.status === "failed" && ctx.isIdle()) startCompaction(ctx, `auto-retry ${(handoff()?.attempts ?? 0) + 1}`);
		});
	}

	function infoLines(ctx: ExtensionContext): { lines: string[]; data: Record<string, unknown> } {
		R.usage = snapshotUsage(ctx);
		R.level = R.thresholds ? levelFor(R.usage.tokens, R.thresholds) : "unknown";
		const t = R.thresholds;
		const h = handoff();
		const describePrompt = (load: () => { text: string; source: string }) => {
			try { return load(); }
			catch (error) { return { text: "", source: `ERROR: ${error instanceof Error ? error.message : String(error)}` }; }
		};
		const soft = describePrompt(() => loadPromptFile("soft", R.searchDirs));
		const warning = describePrompt(() => loadPromptFile("warning", R.searchDirs));
		const compaction = describePrompt(() => resolveCompactionPrompt({ flag: R.compactPromptFlag, searchDirs: R.searchDirs }));
		const summaryInstructions = describePrompt(() => loadPromptFile("summaryInstructions", R.searchDirs));
		const model = ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : "(none)";
		const fmt = (n: number) => n.toLocaleString("en-US");
		const problem = inert();
		const lines: string[] = ["self-compact info"];
		lines.push(`settings: --compact-soft-at ${R.specs.softAt} (${R.sources.softAt}), --compact-at ${R.specs.at} (${R.sources.at}), --compact-buffer ${R.specs.buffer} (${R.sources.buffer}), --compact-prompt ${R.compactPromptFlag ? `set (${R.compactPromptFlag.length} chars)` : "unset"}, --compact-footer ${R.footerEnabled ? "on" : "off"}, --${EXPERIMENTAL_FLAG} ${flagOn(EXPERIMENTAL_FLAG) ? "on" : "off"}`);
		const modeState = R.modeBlocked ? `REQUESTED BUT NOT ACTIVE: ${R.modeBlocked}` : modeSummary(R.mode);
		lines.push(`mode: ${R.mode} (source: ${R.modeSource}${R.modeSource === "flag" ? ", CLI bootstrap" : ", saved in this session"}); ${modeState}; change it with /self-compact-mode`);
		lines.push(`variants: ${enabled() ? `active [${[R.variants.control ? `A/control ${CONTROL_TOOL_NAME}` : null, R.variants.experimental ? `B/experimental ${EXPERIMENTAL_TOOL_NAME}` : null].filter(Boolean).join(", ")}], primary ${activeToolName()}` : `none active (${CONTROL_TOOL_NAME} and ${EXPERIMENTAL_TOOL_NAME} are both inactive); the extension is passive: native compaction is not cancelled and tools are never locked`}`);
		if (problem) lines.push(`REJECTED: ${problem} (extension is inert; every tool is blocked until fixed)`);
		lines.push(`model: ${model}, window ${fmt(R.usage.window)} tokens, cap ${t ? fmt(t.capTokens) : "?"} (90%)`);
		if (t) {
			lines.push(`resolved: soft ${fmt(t.softTokens)} (${formatPct(t.softPct, 1)}), warning ${fmt(t.warnTokens)} (${formatPct(t.warnPct, 1)}), buffer ${fmt(t.bufferTokens)}, forced ${fmt(t.forcedTokens)} (${formatPct(t.forcedPct, 1)})${t.clamped ? " [clamped]" : ""}`);
			for (const note of t.notes) lines.push(`note: ${note}`);
		}
		lines.push(`usage: ${R.usage.tokens === null ? "unknown" : `${fmt(R.usage.tokens)} tokens (${formatPct(R.usage.percent, 1)}), ${fmt(R.usage.cachedTokens)} cached`}  ${contextBarText()}`);
		lines.push(`state: level ${R.level}, tools ${locked() ? `LOCKED (only ${activeToolName()})` : "unlocked"}, handoff ${h?.status ?? "none"}, attempts ${h?.attempts ?? 0}, compaction ${R.compactionInFlight ? "in flight" : "idle"}`);
		lines.push(`cycles completed: ${R.state.cycle}`);
		lines.push(`prompts: soft ${soft.source} (${soft.text.length} chars), warning ${warning.source} (${warning.text.length} chars), compaction ${compaction.source} (${compaction.text.length} chars)`);
		lines.push(`summary user instructions: ${summaryInstructions.source} (${summaryInstructions.text.length} chars)`);
		if (h) {
			const preview = h.note.length > 200 ? `${h.note.slice(0, 200)}…` : h.note;
			lines.push(`${h.status === "done" ? "last delivered note" : "pending note"} (${h.note.length} chars): ${preview.replace(/\s+/g, " ")}`);
			if (h.error) lines.push(`last error: ${h.error}`);
		}
		const data = {
			settings: { ...R.specs, compactPrompt: R.compactPromptFlag ?? null, footer: R.footerEnabled, experimentalFlag: flagOn(EXPERIMENTAL_FLAG), sources: R.sources },
			mode: { selected: R.mode, source: R.modeSource, summary: modeSummary(R.mode), persisted: R.modeSource !== "flag", blocked: R.modeBlocked ?? null },
			variants: { ...R.variants, enabled: enabled(), primary: primaryToolName(R.variants) ?? null },
			rejected: problem ?? null,
			model,
			thresholds: t ?? null,
			usage: R.usage,
			bar: contextBarText(),
			level: R.level,
			locked: locked(),
			handoff: h ? { id: h.id, status: h.status, attempts: h.attempts, noteChars: h.note.length, note: h.note, error: h.error ?? null } : null,
			cycle: R.state.cycle,
			prompts: {
				soft: { source: soft.source, chars: soft.text.length },
				warning: { source: warning.source, chars: warning.text.length },
				compaction: { source: compaction.source, chars: compaction.text.length },
				summaryInstructions: { source: summaryInstructions.source, chars: summaryInstructions.text.length },
			},
		};
		return { lines, data };
	}

	// ----------------------------------------------------------------- tools

	/** The agent's view of its own context: the same numbers as the footer, as plain JSON. */
	function contextView(ctx: ExtensionContext) {
		R.usage = snapshotUsage(ctx);
		R.level = R.thresholds ? levelFor(R.usage.tokens, R.thresholds) : "unknown";
		const t = R.thresholds;
		const u = R.usage;
		const pct = (n: number | null | undefined) => (n === null || n === undefined || !Number.isFinite(n) ? null : Number(n.toFixed(1)));
		const h = activeHandoff();
		return {
			used_tokens: u.tokens,
			used_percent: pct(u.percent),
			context_window: u.window,
			cached_tokens: u.cachedTokens,
			level: R.level,
			thresholds: t
				? {
						notice: { tokens: t.softTokens, percent: pct(t.softPct) },
						warning: { tokens: t.warnTokens, percent: pct(t.warnPct) },
						hard_cutoff: { tokens: t.forcedTokens, percent: pct(t.forcedPct) },
					}
				: null,
			tokens_until_warning: t && u.tokens !== null ? Math.max(0, t.warnTokens - u.tokens) : null,
			tokens_until_hard_cutoff: t && u.tokens !== null ? Math.max(0, t.forcedTokens - u.tokens) : null,
			tools_locked: locked(),
			pending_note: h ? { status: h.status, chars: h.note.length } : null,
			compaction_cycles: R.state.cycle,
			settings_error: inert() ?? null,
		};
	}

	pi.registerTool({
		name: VIEW_TOOL_NAME,
		label: "View Context",
		description: `See your own context usage as JSON: used_tokens, used_percent, context_window, level, the self-compact thresholds (notice, warning, hard_cutoff) and the tokens left before each. You cannot see these numbers any other way. Call it when you need to decide something (after a compaction, before a large read, when judging whether to compact). Do not call it every turn: the extension sends you a message when a threshold is crossed.`,
		promptSnippet: "Show your current context usage, percent, and the self-compact thresholds as JSON",
		promptGuidelines: [
			`${VIEW_TOOL_NAME} takes no arguments and never changes anything; use it when you need your current context numbers, not on every turn.`,
		],
		parameters: Type.Object({}),
		async execute(_toolCallId, _params, _signal, _onUpdate, ctx) {
			const view = contextView(ctx);
			refreshUi(ctx);
			return { content: [{ type: "text", text: JSON.stringify(view, null, 2) }], details: view };
		},
		renderCall(_args, theme) {
			return new Text(theme.fg("toolTitle", theme.bold(VIEW_TOOL_NAME)), 0, 0);
		},
		renderResult(result, _options, theme) {
			const first = result.content[0];
			const text = first && first.type === "text" ? first.text : "";
			return new Text(theme.fg("text", text), 0, 0);
		},
	});

	/**
	 * Both A/B variants share this one implementation: same thresholds, same
	 * forced lock, same note/handoff lifecycle. Only the prompt surface differs.
	 */
	function registerCompactTool(variant: CompactVariant) {
		pi.registerTool({
			name: variant.name,
			label: variant.label,
			description: variant.description,
			promptSnippet: variant.promptSnippet,
			promptGuidelines: variant.promptGuidelines,
			parameters: Type.Object({
				note_to_self: Type.String({ description: variant.noteDescription }),
			}),
			async execute(_toolCallId, params, signal, _onUpdate, ctx) {
				resolveVariants();
				if (!isCompactToolName(variant.name, R.variants)) {
					throw new Error(`${variant.name} is not enabled in this session (it was excluded with --tools/--exclude-tools, or --${EXPERIMENTAL_FLAG} is off). Nothing was saved and no tool is blocked.`);
				}
				if (signal?.aborted) throw new Error("Self-compaction cancelled before saving the note.");
				const problem = inert();
				if (problem) throw new Error(`self-compact is inert because its settings were rejected: ${problem}`);
				// The note is preserved byte for byte; only the checks look at the trimmed form.
				const raw = typeof params.note_to_self === "string" ? params.note_to_self : "";
				if (raw.trim().length === 0) throw new Error("note_to_self must not be blank. Write the goal, DONE work, IN PROGRESS state, decisions, test results, and the NEXT ACTION.");
				if (raw.length > NOTE_MAX_CHARS) throw new Error(`note_to_self exceeds ${NOTE_MAX_CHARS} characters (${raw.length}). Shorten it and call ${variant.name} again.`);
				const existing = activeHandoff();
				if (existing && (existing.status === "compacting" || existing.status === "ready")) throw new Error("Compaction is already in progress for the saved note.");
				if (!compactable(ctx)) {
					R.usage = snapshotUsage(ctx);
					const keep = keepRecentTokens(ctx.cwd);
					throw new Error(`Nothing to compact yet: Pi keeps the newest ${keep.toLocaleString("en-US")} tokens of messages untouched and this session does not reach past them (context ${R.usage.tokens?.toLocaleString("en-US") ?? "?"} tokens, ${formatPct(R.usage.percent, 1)}). No note was saved and no tool is blocked. Keep working and call ${variant.name} later.`);
				}
				if (existing && existing.note.trim() !== raw.trim()) {
					throw new Error(`A note is already saved (${existing.note.length} chars). Retry ${variant.name} with that saved note verbatim instead of a new one.`);
				}
				// A retry keeps the original bytes; a new cycle gets a fresh durable id.
				const note = existing ? existing.note : raw;
				R.state.handoff = { id: existing?.id ?? randomUUID(), note, status: "pending", attempts: 0, savedAt: Date.now() };
				R.lastCompactionError = undefined;
				setLocked(true);
				save();
				refreshUi(ctx);
				notify(ctx, `self-compact: note saved (${note.length} chars). Compaction runs when this turn ends.`, "info");
				const at = R.usage.tokens === null ? "unknown usage" : `${R.usage.tokens.toLocaleString("en-US")} tokens (${formatPct(R.usage.percent, 1)}), level ${R.level}`;
				return {
					content: [{ type: "text", text: `Note saved (${note.length} chars) at ${at}. Every other tool is blocked until compaction succeeds. Stop now: compaction runs when this turn ends and your note will be returned verbatim.` }],
					details: { handoffId: R.state.handoff.id, noteChars: note.length, cycle: R.state.cycle + 1, note, usedTokens: R.usage.tokens, usedPercent: R.usage.percent, level: R.level, tool: variant.name },
					terminate: true,
				};
			},
			renderCall(args, theme) {
				const note = typeof args?.note_to_self === "string" ? args.note_to_self : "";
				return new Text(`${theme.fg("toolTitle", theme.bold(variant.name))} ${theme.fg("muted", `note ${note.length.toLocaleString("en-US")} chars`)}`, 0, 0);
			},
			renderResult(result, { expanded }, theme) {
				const first = result.content[0];
				const text = first && first.type === "text" ? first.text : "";
				const details = result.details as { noteChars?: number; cycle?: number; note?: string; usedTokens?: number | null; usedPercent?: number | null; level?: string } | undefined;
				// Build the line from details (the text contains "21.1%", so splitting on "." would cut it short).
				const usage = details?.usedTokens !== undefined && details?.usedTokens !== null ? ` at ${details.usedTokens.toLocaleString("en-US")} tokens (${formatPct(details.usedPercent, 1)})` : "";
				const line = details?.noteChars !== undefined ? `Note saved (${details.noteChars.toLocaleString("en-US")} chars)${usage}. Compaction runs when this turn ends.` : text;
				let out = theme.fg("success", `✓ ${line}`);
				if (expanded && details?.note) out += `\n${theme.fg("dim", details.note)}`;
				return new Text(out, 0, 0);
			},
		});
	}

	// Both variants are registered at load, because registration is not exposure: the selected mode
	// decides which one is active, and Pi renders prompt snippets and guidelines from active tools
	// only. That keeps a switch instant and makes it survive a reload without re-registering.
	registerCompactTool(variantDefinition("control"));
	registerCompactTool(variantDefinition("experimental"));

	// -------------------------------------------------------------- commands

	pi.registerCommand("self-compact-mode", {
		description: `Select the self-compaction mode for this session (${COMPACT_MODES.join(" | ")}); saved in the session, no LLM turn`,
		getArgumentCompletions: (prefix: string) => {
			const needle = prefix.trim().toLowerCase();
			const items = MODE_CHOICES.filter((choice) => choice.label.toLowerCase().startsWith(needle)).map((choice) => ({
				value: choice.label,
				label: choice.label,
				description: choice.description,
			}));
			return items.length > 0 ? items : null;
		},
		handler: async (args, ctx) => {
			const requested = args.trim();
			let mode: CompactMode | undefined;
			if (requested) {
				mode = parseMode(requested);
				if (!mode) {
					feedback(ctx, `self-compact: "${requested}" is not a mode. Use ${COMPACT_MODES.join(", ")} (a and b are accepted too).`, "error");
					return;
				}
			} else if (ctx.hasUI) {
				const labels = MODE_CHOICES.map((choice) => `${choice.label}: ${choice.description}`);
				const pick = await ctx.ui.select(`Self-compaction mode for this session (now: ${R.mode}):`, labels);
				const index = pick ? labels.indexOf(pick) : -1;
				if (index < 0) return;
				mode = MODE_CHOICES[index]!.mode;
			} else {
				feedback(ctx, `self-compact: mode is ${R.mode} (${modeSummary(R.mode)}). Pass an argument: ${COMPACT_MODES.join(", ")}.`, "info");
				return;
			}
			switchMode(ctx, mode);
		},
	});

	pi.registerCommand("self-compact-info", {
		description: "Show self-compact settings, resolved thresholds, usage, state, cycle count, prompt sources, and pending notes (no LLM turn)",
		handler: async (_args, ctx: ExtensionCommandContext) => {
			// A bound command context: report the state as it is, with no attempt to change tools.
			const info = infoLines(ctx);
			pi.appendEntry(INFO_ENTRY_TYPE, { ...info.data, lines: info.lines, at: Date.now() });
			if (ctx.hasUI && ctx.mode !== "tui") ctx.ui.notify(info.lines.join("\n"), "info");
			refreshUi(ctx);
		},
	});

	pi.registerCommand("self-compact-now", {
		description: `Ask the agent to write its note_to_self and call the enabled self-compaction tool (${CONTROL_TOOL_NAME} or ${EXPERIMENTAL_TOOL_NAME}) now (reuses a saved note on retry)`,
		handler: async (_args, ctx: ExtensionCommandContext) => {
			resolveVariants();
			if (!enabled()) {
				notify(ctx, `self-compact: no self-compaction tool is enabled in this session (${CONTROL_TOOL_NAME} and ${EXPERIMENTAL_TOOL_NAME} are both inactive). Nothing to ask for.`, "warning");
				return;
			}
			const problem = inert();
			if (problem) {
				notify(ctx, `self-compact: cannot compact, settings were rejected: ${problem}`, "error");
				return;
			}
			const h = handoff();
			if (h && (h.status === "compacting" || h.status === "ready")) {
				notify(ctx, "self-compact: compaction is already in progress.", "info");
				return;
			}
			const saved = h && (h.status === "pending" || h.status === "failed") ? h.note : undefined;
			const text = nowPrompt(activeToolName(), saved);
			if (ctx.isIdle()) {
				pi.sendUserMessage(text);
				notify(ctx, saved ? "self-compact: asked the agent to compact now with its saved note." : "self-compact: asked the agent to write its note and compact now.", "info");
			} else {
				pi.sendUserMessage(text, { deliverAs: "steer" });
				notify(ctx, "self-compact: queued a steering request to compact now.", "info");
			}
		},
	});

	// ------------------------------------------------------------- renderers

	pi.registerMessageRenderer(HANDOFF_TYPE, (message, options, theme) => {
		const details = message.details as { cycle?: number; note?: string } | undefined;
		const note = details?.note ?? (typeof message.content === "string" ? message.content : "");
		// Always show the full note: this is exactly what was fed back into the agent after compaction.
		const header = theme.fg("success", theme.bold(`self-compact · handoff`)) + theme.fg("dim", ` cycle ${details?.cycle ?? "?"}, note_to_self returned verbatim to the agent (${note.length.toLocaleString("en-US")} chars):`);
		return new Text(`${header}\n${theme.fg("text", note)}`, options.outputPad ?? 1, 0);
	});

	pi.registerEntryRenderer(PHASE_ENTRY_TYPE, (entry, _options, theme) => {
		const data = entry.data as { level?: UsageLevel; percent?: number | null; text?: string } | undefined;
		const level = data?.level ?? "notice";
		// Show the full guidance message the model receives, once per crossing (older entries fall back to the one-liner).
		const text = data?.text?.trim() || `self-compact · ${levelTag(level).toLowerCase()} threshold crossed at ${formatPct(data?.percent ?? null, 1)}`;
		return new Text(theme.fg(levelColor(level), text), 0, 0);
	});

	pi.registerEntryRenderer(INFO_ENTRY_TYPE, (entry, _options, theme) => {
		const lines = (entry.data as { lines?: string[] } | undefined)?.lines ?? [];
		const [title, ...rest] = lines;
		return new Text([theme.fg("accent", theme.bold(title ?? "self-compact info")), ...rest.map((l) => theme.fg("text", l))].join("\n"), 0, 0);
	});

	function installFooter(ctx: ExtensionContext) {
		if (ctx.mode !== "tui" || !R.footerEnabled) return;
		ctx.ui.setFooter((tui, theme) => {
			R.requestRender = () => tui.requestRender();
			return {
				dispose: () => {
					R.requestRender = undefined;
				},
				invalidate() {},
				render(width: number): string[] {
					const t = R.thresholds;
					const u = R.usage;
					const level = R.level;
					const bar = renderContextBar({
						usedPct: t ? u.percent : null,
						cachedPct: u.window > 0 ? (u.cachedTokens / u.window) * 100 : 0,
						softPct: t?.softPct ?? 0,
						warnPct: t?.warnPct ?? 0,
						forcedPct: t?.forcedPct ?? 0,
					});
					const cells = bar.cells
						.map((c) => {
							if (c === "#") return theme.fg("success", c);
							if (c === "=") return theme.fg("accent", c);
							if (c === "~") return theme.fg("muted", c);
							if (c === "!") return theme.fg("warning", c);
							if (c === "|") return theme.fg("error", c);
							return theme.fg("dim", c);
						})
						.join("");
					const problem = inert();
					const tag = statusTag();
					const left = theme.fg("dim", ` ${ctx.model?.id ?? "no-model"}`) + (R.state.cycle > 0 ? theme.fg("dim", ` · cycle ${R.state.cycle}`) : "");
					const phase = tag ? ` ${theme.fg(problem ? "error" : locked() ? "error" : levelColor(level), tag)}` : "";
					const right = `${theme.fg("dim", "[")}${cells}${theme.fg("dim", `] ${bar.label}`)}${phase} `;
					const pad = " ".repeat(Math.max(1, width - visibleWidth(left) - visibleWidth(right)));
					return [truncateToWidth(left + pad + right, width)];
				},
			};
		});
	}

	// ---------------------------------------------------------------- events

	const recover = async (event: { reason?: string }, ctx: ExtensionContext) => {
		clearTimers();
		R.alive = true;
		R.epoch += 1;
		R.announcedLevel = "idle";
		R.promptErrors.clear();
		R.compactionInFlight = false;
		R.searchDirs = promptSearchDirs(ctx.cwd, EXTENSION_DIR);
		loadSettings();
		resolveVariants();
		resolve(ctx);

		const branch = ctx.sessionManager.getBranch() as never[];
		const recovered = recoverState(branch);
		R.state = recovered.state;

		// Mode: a per-session selection wins, otherwise the CLI flags bootstrap one.
		const persisted = recoverMode(branch);
		const selected: CompactMode = persisted?.mode ?? bootstrapMode(flagOn(EXPERIMENTAL_FLAG));
		const source: ModeEntry["source"] = persisted ? "session" : "flag";
		// A saved note must never be stranded by `off`: finish the handoff on a reachable variant.
		const wanted: CompactMode = activeHandoff() && selected === "off" ? "control" : selected;
		let outcome = applyMode(wanted, source, "passive");
		const alternate: CompactMode = wanted === "control" ? "experimental" : "control";
		// Fall back to the other variant so a pending note is never stranded. Without a pending
		// note only an already-requested variant is used: --exclude-tools self_compact alone must
		// not silently opt a session into the experimental arm.
		if (!outcome.ok && (activeHandoff() !== undefined || alternate === "control" || flagOn(EXPERIMENTAL_FLAG))) {
			outcome = applyMode(alternate, source, "passive");
		}
		if (!outcome.ok) {
			R.mode = selected;
			R.modeSource = source;
			reportModeFailure(ctx, selected, outcome);
		}

		const problem = inert();
		if (problem && enabled()) notify(ctx, `self-compact REJECTED settings: ${problem}. Every tool is blocked until the flags are fixed.`, "error");

		// No variant reachable: stay passive (no forced lock, no native-compaction
		// cancellation, no guidance) so the agent is never locked out of a missing tool.
		if (!enabled()) {
			if (R.state.locked) {
				setLocked(false);
				save();
			}
			installFooter(ctx);
			trackLevel(ctx);
			return;
		}
		const h = handoff();
		if (h && recovered.journaledUnanswered) {
			// Crash between journaling the handoff and the model's answer: resume without a user prompt.
			R.state.handoff = { ...h, status: "done" };
			setLocked(false);
			save();
			notify(ctx, `self-compact: the returned note was never answered before ${event.reason}; resuming from it.`, "warning");
			const id = h.id;
			const cycle = R.state.cycle;
			const note = h.note;
			deferInEpoch("recoveryTimer", 500, () => {
				if (!ctx.isIdle()) return;
				pi.sendMessage(
					{ customType: HANDOFF_TYPE, content: `Continue from your saved note_to_self above (self-compact cycle ${cycle}). Perform only its unfinished NEXT ACTION.`, display: false, details: { id, cycle, note, resumed: true } },
					{ triggerTurn: true },
				);
			});
		} else if (h && h.status === "ready") {
			if (recovered.answered) {
				R.state.handoff = { ...h, status: "done" };
				setLocked(false);
				save();
			} else {
				setLocked(false);
				save();
				notify(ctx, `self-compact: compaction finished before ${event.reason}; returning the saved note.`, "info");
				deliverHandoff(ctx);
			}
		} else if (h && (h.status === "pending" || h.status === "failed" || h.status === "compacting")) {
			R.state.handoff = { ...h, status: h.status === "compacting" ? "failed" : h.status, attempts: 0, error: h.status === "compacting" ? "Compaction was interrupted (session reloaded)." : h.error };
			setLocked(true);
			save();
			notify(ctx, `self-compact: restored a saved note (${h.note.length} chars, ${event.reason}). Tools stay locked until compaction succeeds.`, "warning");
			deferInEpoch("recoveryTimer", 500, () => {
				const current = handoff();
				if (current && (current.status === "pending" || current.status === "failed") && ctx.isIdle()) startCompaction(ctx, `recovery after ${event.reason}`);
			});
		}
		installFooter(ctx);
		trackLevel(ctx);
	};

	pi.on("session_start", recover);
	pi.on("session_tree", async (_event, ctx) => recover({ reason: "tree" }, ctx));

	pi.on("session_shutdown", async () => {
		R.alive = false;
		R.epoch += 1;
		clearTimers();
	});

	pi.on("model_select", async (_event, ctx) => {
		resolve(ctx);
		trackLevel(ctx);
	});

	pi.on("before_agent_start", async (event, ctx) => {
		trackLevel(ctx);
		const tool = primaryToolName(R.variants);
		if (!tool) return undefined;
		const viewActive = viewToolActive();
		if (R.systemPromptCache?.tool !== tool || R.systemPromptCache.viewActive !== viewActive) {
			R.systemPromptCache = { tool, viewActive, text: systemPromptLine(tool, viewActive) };
		}
		return { systemPrompt: event.systemPrompt + R.systemPromptCache.text };
	});

	pi.on("context", async (event, ctx) => {
		trackLevel(ctx);
		const messages = event.messages.filter(message => !(message.role === "custom" && message.customType === GUIDANCE_TYPE));
		try {
			const text = guidanceText(ctx);
			if (text) messages.push(guidanceMessage(text));
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			if (!R.promptErrors.has(message)) {
				R.promptErrors.add(message);
				notify(ctx, `self-compact: ${message}`, "warning");
			}
			if (R.level === "warning") messages.push(guidanceMessage(renderTemplate(BUILTIN_PROMPTS.warning, templateValues())));
		}
		return { messages };
	});

	pi.on("message_end", async (event, ctx) => {
		if (event.message.role === "assistant") {
			trackLevel(ctx);
			return;
		}
		if (event.message.role === "custom" && event.message.customType === HANDOFF_TYPE) {
			const h = handoff();
			const id = (event.message.details as { id?: string } | undefined)?.id;
			if (h && h.status === "ready" && h.id === id) {
				// Pi has journaled the verbatim handoff: the transaction is complete.
				R.state.handoff = { ...h, status: "done" };
				setLocked(false);
				save();
				refreshUi(ctx);
			}
		}
	});

	pi.on("tool_call", async (event, ctx) => {
		trackLevel(ctx);
		// Neither variant enabled: never block anything; the agent has no reachable compaction tool.
		if (!enabled()) return undefined;
		const problem = inert();
		if (problem) return { block: true, reason: `self-compact rejected its settings, so this session is not protected: ${problem}. Fix the --compact-* flags and restart.` };
		// Any enabled variant is allowed, and so is looking at the gauge.
		if (isCompactToolName(event.toolName, R.variants)) return undefined;
		if (event.toolName === VIEW_TOOL_NAME) return undefined;
		// Whole-batch preflight: Pi preflights siblings sequentially before running them concurrently,
		// so an ordinary tool before or after a self-compaction call in the same assistant message is blocked too.
		const branch = ctx.sessionManager.getBranch();
		for (let i = branch.length - 1; i >= 0; i--) {
			const entry = branch[i]!;
			if (entry.type !== "message" || entry.message.role !== "assistant") continue;
			const calls = (entry.message as AssistantMessage).content.filter((c) => c.type === "toolCall");
			const hasHandoff = calls.some((c) => c.type === "toolCall" && isCompactToolName(c.name, R.variants) && typeof c.arguments?.note_to_self === "string" && c.arguments.note_to_self.trim().length > 0 && c.arguments.note_to_self.length <= NOTE_MAX_CHARS);
			if (hasHandoff && calls.some((c) => c.type === "toolCall" && c.id === event.toolCallId)) {
				return { block: true, terminate: true, reason: `Tool "${event.toolName}" is blocked by self-compact: ${activeToolName()} is in this tool batch, so the run must end here. Wait for the handoff.` };
			}
			break;
		}
		if (locked()) {
			const h = handoff();
			const u = R.usage;
			const t = R.thresholds;
			const why = h && (h.status === "pending" || h.status === "compacting")
				? `a ${activeToolName()} note is saved and compaction is ${h.status}`
				: h && h.status === "failed"
					? `the last compaction failed (${h.error ?? "unknown error"}) and the saved note is kept`
					: `context is at ${formatPct(u.percent, 1)} (${u.tokens?.toLocaleString("en-US") ?? "?"} tokens), at or above the forced threshold of ${formatPct(t?.forcedPct ?? null, 1)} (${t?.forcedTokens.toLocaleString("en-US") ?? "?"} tokens)`;
			return {
				block: true,
				reason: `Tool "${event.toolName}" is blocked by self-compact: ${why}. Every tool except ${activeToolName()} is blocked until compaction succeeds. Write your note_to_self and call ${activeToolName()} now.`,
			};
		}
		return undefined;
	});

	pi.on("turn_end", async (_event, ctx) => {
		trackLevel(ctx);
	});

	pi.on("agent_end", async (_event, ctx) => {
		trackLevel(ctx);
		if (!enabled() || inert() || activeHandoff() || R.idleRequestEpoch === R.epoch) return;
		if (!locked() && R.level !== "warning" && R.level !== "forced") return;
		R.idleRequestEpoch = R.epoch;
		pi.sendMessage({ customType: GUIDANCE_TYPE, content: nowPrompt(activeToolName()), display: false }, { triggerTurn: true, deliverAs: "followUp" });
	});

	pi.on("agent_settled", async (_event, ctx) => {
		if (!R.alive) return; // shutdown during compaction: the ctx is already stale
		refreshUi(ctx);
		if (!enabled() || inert()) return;
		const h = handoff();
		if (!h || !ctx.isIdle()) return;
		if (h.status === "ready") deliverHandoff(ctx);
		else if (h.status === "pending" || (h.status === "failed" && h.attempts < MAX_AUTO_RETRIES && R.lastCompactionError)) startCompaction(ctx, h.status === "pending" ? "agent idle" : "retry after failure");
	});

	pi.on("session_before_compact", async (event, ctx) => {
		// Neither variant enabled: do not cancel Pi's native compaction.
		if (!enabled()) return undefined;
		if (event.reason !== "manual") {
			setLocked(true);
			save();
			refreshUi(ctx);
			return { cancel: true };
		}
		R.lastCompactionError = undefined;
		const model = ctx.model;
		if (!model) return undefined;
		const { signal } = event;
		let prompt;
		try { prompt = resolveCompactionPrompt({ flag: R.compactPromptFlag, searchDirs: R.searchDirs }); }
		catch (error) {
			R.lastCompactionError = error instanceof Error ? error.message : String(error);
			notify(ctx, `self-compact: ${R.lastCompactionError}`, "error");
			return { cancel: true };
		}
		const h = activeHandoff();

		let lastError = "unknown error";
		for (let attempt = 1; attempt <= SUMMARY_ATTEMPTS; attempt++) {
			if (signal.aborted) return { cancel: true };
			try {
				const instructions = loadPromptFile("summaryInstructions", R.searchDirs);
				const { result, truncatedInput } = await generateSummary(event, ctx, prompt, instructions);
				return {
					compaction: {
						...result,
						details: {
							...(result.details as Record<string, unknown>),
							handoffId: h?.id,
							selfCompact: { cycle: R.state.cycle + (h ? 1 : 0), promptSource: prompt.source, userPromptSource: instructions.source, reason: event.reason, noteChars: h?.note.length ?? 0, truncatedInput, attempt },
						},
					},
				};
			} catch (error) {
				lastError = error instanceof Error ? error.message : String(error);
				if (signal.aborted) return { cancel: true };
			}
		}
		R.lastCompactionError = `Summary generation failed after ${SUMMARY_ATTEMPTS} attempts: ${lastError}`;
		notify(ctx, `self-compact: ${R.lastCompactionError}`, "error");
		return { cancel: true };
	});

	pi.on("session_compact", async (event, ctx) => {
		R.epoch += 1;
		R.announcedLevel = "idle";
		R.compactionInFlight = false;
		// Neither variant enabled: native compaction ran; just release any stale lock.
		if (!enabled()) {
			if (R.state.locked) {
				setLocked(false);
				save();
			}
			refreshUi(ctx);
			return;
		}
		const h = handoff();
		if (h && h.status !== "done") {
			R.state.cycle += 1;
			R.state.handoff = { ...h, status: "ready", error: undefined };
			setLocked(false);
			save();
			notify(ctx, `self-compact: compaction ${event.reason} succeeded (cycle ${R.state.cycle}); returning the note (${h.note.length} chars) and restoring tools.`, "info");
			deliverHandoff(ctx);
		} else if (locked()) {
			// Context shrank through another path (e.g. /compact without a note): release the forced lock.
			setLocked(false);
			save();
		}
		refreshUi(ctx);
	});

	pi.on("session_compact_failed", async (event, ctx) => {
		if (!enabled()) return;
		// We intentionally defer native auto-compaction until our idle handoff transaction.
		if (event.reason !== "manual" && event.aborted) return;
		R.compactionInFlight = false;
		if (!R.alive) return; // shutdown aborted the compaction: the saved note is recovered on the next session start
		const h = handoff();
		if (!h || (h.status !== "compacting" && h.status !== "pending")) {
			refreshUi(ctx);
			return;
		}
		const ours = R.lastCompactionError !== undefined;
		R.state.handoff = { ...h, status: "failed", attempts: h.attempts + 1, error: R.lastCompactionError ?? event.errorMessage ?? (event.aborted ? "compaction was cancelled" : "compaction failed") };
		setLocked(true);
		save();
		refreshUi(ctx);
		const current = handoff()!;
		const canRetry = (ours || !event.aborted) && current.attempts < MAX_AUTO_RETRIES;
		if (canRetry) {
			notify(ctx, `self-compact: compaction failed (attempt ${current.attempts}): ${current.error}. Note kept, tools stay locked, retrying automatically.`, "warning");
			scheduleRetry(ctx);
		} else {
			notify(ctx, `self-compact: compaction ${event.aborted && !ours ? "cancelled" : "failed"} (attempt ${current.attempts}): ${current.error}. Note kept and tools stay locked. Run /self-compact-now or /compact to retry.`, "error");
		}
	});
}
