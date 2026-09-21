/**
 * self-compact — a Pi extension that lets a long-running agent manage its own context window.
 *
 *   pi -e extensions/self-compact/index.ts \
 *      [--compact-soft-at 100000] [--compact-at 200000] [--compact-buffer 100000] [--compact-prompt "..."] [--compact-footer]
 *
 * How it works
 * - The agent owns the decision. `self_compact({ note_to_self })` saves the note, ends the run,
 *   compaction runs once the agent is idle with the replacement summary prompt
 *   (--compact-prompt > USER_PROMPT_COMPACTION_MESSAGE.md > built-in), and the note is returned
 *   verbatim as a handoff message that starts the next turn. When Pi would find nothing to compact
 *   the tool refuses instead of saving a note and locking.
 * - Triggers nudge the agent with one appended message each, once per compaction cycle:
 *   CHECKPOINT after TOOL_CALL_TRIGGER ordinary tool calls mid-run, RUN ENDED as a follow-up turn
 *   after a run that used at least that many, and the token thresholds notice / warning / forced
 *   (capped at 90% of the model window) as the backstop. Past the warning line an idle run also
 *   gets a "compact now" follow-up. Messages are only ever appended, never rewritten or removed,
 *   which is what keeps the provider's prefix cache intact (see cache-prefix.test.ts).
 * - At the forced threshold, and while a note is waiting to be compacted, every tool except
 *   `self_compact` and `view_context` is blocked in `tool_call` with an explicit reason. The lock is
 *   derived from that state, not stored.
 * - This extension cancels Pi's automatic compaction (overflow recovery included) and replaces it
 *   with the note handoff. Failure or cancellation keeps the note; retries, /self-compact-now,
 *   reload and /tree recovery all resume from the saved note.
 * - `view_context()` returns used tokens, percent, level, thresholds and tool-call counts as JSON.
 * - Optional one-line footer (--compact-footer): model id on the left, context bar and phase on the right.
 *
 * Vendored from disler/self-compact-pi-agent (MIT), upstream SHA
 * 576fe4abda021849f5cde5b6f5796467ffa4bcbd; see UPSTREAM.md for the local changes.
 */
import { randomUUID } from "node:crypto";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import { Text, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { formatPct, renderContextBar } from "./context-bar.ts";
import {
	CHECKPOINT_PROMPT,
	NOTE_DESCRIPTION,
	nowPrompt,
	RUN_END_PROMPT,
	systemPromptLine,
	TOOL_CALL_TRIGGER,
	TOOL_DESCRIPTION,
	TOOL_GUIDELINES,
	TOOL_NAME,
	VIEW_TOOL_NAME,
} from "./guidance.ts";
import { BUILTIN_PROMPTS, FORCED_PROMPT, loadPromptFile, NOTE_MAX_CHARS, promptSearchDirs, renderTemplate, resolveCompactionPrompt, type TemplateValues } from "./prompts.ts";
import { emptyState, GUIDANCE_TYPE, HANDOFF_TYPE, INFO_ENTRY_TYPE, latestAssistantUsage, recoverState, STATE_TYPE, type EntryLike, type Handoff, type PersistedState } from "./state.ts";
import { generateSummary, hasCompactionMaterial, keepRecentTokens } from "./summary.ts";
import { DEFAULT_SPECS, LEVEL_ORDER, levelFor, resolveThresholds, SPEC_HELP, validateSpecs, type ResolvedThresholds, type SpecSource, type ThresholdSpecs, type UsageLevel } from "./thresholds.ts";

export { TOOL_NAME, VIEW_TOOL_NAME, TOOL_CALL_TRIGGER };
export { GUIDANCE_TYPE, HANDOFF_TYPE, STATE_TYPE };
const EXTENSION_DIR = dirname(fileURLToPath(import.meta.url));
const MAX_AUTO_RETRIES = 3;
const SUMMARY_ATTEMPTS = 2;

/** The five things that may message the model once per compaction cycle. */
type TriggerKey = "notice" | "warning" | "forced" | "checkpoint" | "run-end" | "now";
const THRESHOLD_KEYS: readonly UsageLevel[] = ["notice", "warning", "forced"];

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
	/** Bumps on every compaction and session start; every once-per-cycle guard and timer is keyed to it. */
	epoch: number;
	/** Trigger keys already sent to the model in this epoch. */
	fired: Set<TriggerKey>;
	/** Ordinary tool calls (not self_compact, not view_context) since the last compaction, and in the current run. */
	toolCalls: { sinceCompaction: number; thisRun: number };
	compactionInFlight: boolean;
	lastCompactionError?: string;
	footerEnabled: boolean;
	retryTimer?: ReturnType<typeof setTimeout>;
	recoveryTimer?: ReturnType<typeof setTimeout>;
	requestRender?: () => void;
	alive: boolean;
	promptErrors: Set<string>;
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
	// extensions/usage-footer owns the Pi footer in this package, so the self-compact bar is opt-in.
	pi.registerFlag("compact-footer", { description: "Replace the Pi footer with the self-compact context bar (default false).", type: "boolean", default: false });

	const R: Runtime = {
		specs: { ...DEFAULT_SPECS },
		sources: { softAt: "default", at: "default", buffer: "default" },
		searchDirs: promptSearchDirs(process.cwd(), EXTENSION_DIR),
		usage: { tokens: null, percent: null, cachedTokens: 0, window: 0 },
		level: "unknown",
		state: emptyState(),
		epoch: 0,
		fired: new Set(),
		toolCalls: { sinceCompaction: 0, thisRun: 0 },
		compactionInFlight: false,
		footerEnabled: false,
		alive: true,
		promptErrors: new Set(),
	};

	// ------------------------------------------------------------- settings

	const flag = (name: string): string | undefined => {
		const value = pi.getFlag(name);
		return typeof value === "string" && value.trim() !== "" ? value : undefined;
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

	// ---------------------------------------------------------------- state

	const inert = (): string | undefined => R.configError ?? R.resolveError;
	const handoff = (): Handoff | undefined => R.state.handoff;
	/** A handoff that still needs work; a completed ("done") handoff is history. */
	const activeHandoff = (): Handoff | undefined => {
		const h = R.state.handoff;
		return h && h.status !== "done" ? h : undefined;
	};
	/** Derived: tools are blocked while a note waits for compaction, or past the forced line when there is something to compact. */
	const locked = (ctx: ExtensionContext): boolean => activeHandoff() !== undefined || (R.level === "forced" && compactable(ctx));

	/** False when Pi would answer "Nothing to compact": the session still fits inside keepRecentTokens. */
	function compactable(ctx: ExtensionContext): boolean {
		return hasCompactionMaterial(ctx.sessionManager.getBranch(), keepRecentTokens(ctx.cwd));
	}

	function viewToolActive(): boolean {
		try {
			return pi.getActiveTools().includes(VIEW_TOOL_NAME);
		} catch {
			return true;
		}
	}

	function save() {
		pi.appendEntry(STATE_TYPE, structuredClone(R.state));
	}

	/** Info toasts stay out of the TUI (footer and messages already show them); warnings and errors show everywhere. */
	function notify(ctx: ExtensionContext, message: string, type: "info" | "warning" | "error" = "info") {
		if (!ctx.hasUI) return;
		if (type === "info" && ctx.mode === "tui") return;
		ctx.ui.notify(message, type);
	}

	function clearTimers() {
		for (const key of ["retryTimer", "recoveryTimer"] as const) {
			if (R[key]) clearTimeout(R[key]);
			R[key] = undefined;
		}
	}

	/** Run `fn` after `delayMs` only if the epoch is unchanged and the runtime is alive. */
	function deferInEpoch(key: "retryTimer" | "recoveryTimer", delayMs: number, fn: () => void) {
		if (R[key]) clearTimeout(R[key]);
		const epoch = R.epoch;
		R[key] = setTimeout(() => {
			R[key] = undefined;
			if (!R.alive || epoch !== R.epoch) return;
			fn();
		}, delayMs);
	}

	function newEpoch() {
		R.epoch += 1;
		R.fired.clear();
		R.toolCalls = { sinceCompaction: 0, thisRun: 0 };
	}

	// ---------------------------------------------------------------- usage

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

	/** Re-read usage and level, and redraw the footer/status. */
	function refresh(ctx: ExtensionContext) {
		R.usage = snapshotUsage(ctx);
		R.level = R.thresholds ? levelFor(R.usage.tokens, R.thresholds) : "unknown";
		if (ctx.mode === "tui") R.requestRender?.();
		else if (ctx.hasUI) ctx.ui.setStatus("self-compact", [contextBarText(), statusTag(ctx)].filter(Boolean).join(" "));
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
			tool_name: TOOL_NAME,
			tool_calls_since_compaction: R.toolCalls.sinceCompaction,
			tool_calls_this_run: R.toolCalls.thisRun,
		};
	}

	function contextBarText(): string {
		const t = R.thresholds;
		const u = R.usage;
		if (!t) return "[--------------------] --%";
		const cachedPct = u.window > 0 ? (u.cachedTokens / u.window) * 100 : 0;
		return renderContextBar({ usedPct: u.percent, cachedPct, softPct: t.softPct, warnPct: t.warnPct, forcedPct: t.forcedPct }).text;
	}

	/** Footer tag: REJECTED > handoff in flight > phase. */
	function statusTag(_ctx: ExtensionContext): string {
		if (inert()) return "REJECTED";
		const h = activeHandoff();
		if (h) return handoffTag(h.status);
		return levelTag(R.level);
	}

	// ------------------------------------------------------------- triggers

	/** The guidance body for a threshold level; prompt files for notice/warning, built-in for forced. */
	function thresholdText(level: UsageLevel): string {
		try {
			if (level === "forced") return renderTemplate(FORCED_PROMPT, templateValues());
			return renderTemplate(loadPromptFile(level === "notice" ? "soft" : "warning", R.searchDirs).text, templateValues());
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			if (!R.promptErrors.has(message)) {
				R.promptErrors.add(message);
				process.stderr.write(`[self-compact] ${message}\n`);
			}
			return renderTemplate(level === "forced" ? FORCED_PROMPT : BUILTIN_PROMPTS[level === "notice" ? "soft" : "warning"], templateValues());
		}
	}

	/**
	 * Send one trigger message to the model, once per epoch. Append-only: the message is never
	 * rewritten or removed afterwards, so the provider's prefix cache survives. `followUp` starts a
	 * turn (used when the agent is idle); otherwise the message just waits for the next turn.
	 */
	function fire(ctx: ExtensionContext, key: TriggerKey, text: string, followUp = false): boolean {
		if (!R.alive || R.fired.has(key)) return false;
		R.fired.add(key);
		const details = { key, epoch: R.epoch, cycle: R.state.cycle, tokens: R.usage.tokens, percent: R.usage.percent, toolCalls: R.toolCalls.sinceCompaction };
		pi.sendMessage({ customType: GUIDANCE_TYPE, content: text, display: true, details }, followUp ? { triggerTurn: true, deliverAs: "followUp" } : { triggerTurn: false });
		if (ctx.mode !== "tui") notify(ctx, `self-compact: ${key} sent at ${formatPct(R.usage.percent, 1)}`, key === "forced" ? "error" : key === "warning" ? "warning" : "info");
		return true;
	}

	/** True when a trigger may speak: settings valid, no note waiting, and Pi would have something to compact. */
	function mayTrigger(ctx: ExtensionContext): boolean {
		return !inert() && R.thresholds !== undefined && !activeHandoff() && compactable(ctx);
	}

	/** Evaluate the passive triggers (threshold crossing, tool-call checkpoint). Called whenever usage may have changed. */
	function tick(ctx: ExtensionContext) {
		refresh(ctx);
		const level = R.level;
		const crossed = THRESHOLD_KEYS.includes(level) && !THRESHOLD_KEYS.some((k) => LEVEL_ORDER[k] >= LEVEL_ORDER[level] && R.fired.has(k as TriggerKey));
		const checkpoint = R.toolCalls.sinceCompaction >= TOOL_CALL_TRIGGER && !R.fired.has("checkpoint");
		if (!crossed && !checkpoint) return;
		if (!mayTrigger(ctx)) return;
		if (crossed) fire(ctx, level as TriggerKey, thresholdText(level));
		if (checkpoint) fire(ctx, "checkpoint", renderTemplate(CHECKPOINT_PROMPT, templateValues()));
	}

	/** Restore the once-per-epoch guards from the messages still in the model's context after a reload or compaction. */
	function restoreFired(ctx: ExtensionContext) {
		let entries: EntryLike[];
		try {
			entries = (ctx.sessionManager.buildContextEntries() ?? ctx.sessionManager.getBranch()) as never[];
		} catch {
			entries = ctx.sessionManager.getBranch() as never[];
		}
		R.fired.clear();
		for (const entry of entries) {
			if (entry.type !== "custom_message" || entry.customType !== GUIDANCE_TYPE) continue;
			const details = entry.details as { key?: TriggerKey; level?: TriggerKey } | undefined;
			const key = details?.key ?? details?.level; // `level` is the pre-rewrite field name
			if (key) R.fired.add(key);
		}
	}

	// -------------------------------------------------------------- handoff

	function deliverHandoff(ctx: ExtensionContext) {
		const h = handoff();
		if (!R.alive || !h || h.status !== "ready" || !ctx.isIdle()) return;
		// Content is exactly the saved note (verbatim contract); the header lives in the renderer and details.
		pi.sendMessage({ customType: HANDOFF_TYPE, content: h.note, display: true, details: { id: h.id, cycle: R.state.cycle, note: h.note } }, { triggerTurn: true });
	}

	function startCompaction(ctx: ExtensionContext, trigger: string) {
		const h = handoff();
		if (R.compactionInFlight || !h || (h.status !== "pending" && h.status !== "failed")) return;
		R.compactionInFlight = true;
		h.status = "compacting";
		save();
		notify(ctx, `self-compact: compacting (${trigger}, note ${h.note.length} chars)…`, "info");
		refresh(ctx);
		const done = () => {
			R.compactionInFlight = false;
		};
		ctx.compact({ onComplete: done, onError: done });
	}

	function scheduleRetry(ctx: ExtensionContext) {
		const delay = 2_000 * Math.max(1, handoff()?.attempts ?? 1);
		deferInEpoch("retryTimer", delay, () => {
			if (handoff()?.status === "failed" && ctx.isIdle()) startCompaction(ctx, `auto-retry ${(handoff()?.attempts ?? 0) + 1}`);
		});
	}

	// ----------------------------------------------------------------- tools

	function contextView(ctx: ExtensionContext) {
		refresh(ctx);
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
			tools_locked: locked(ctx),
			pending_note: h ? { status: h.status, chars: h.note.length } : null,
			compaction_cycles: R.state.cycle,
			tool_calls_since_compaction: R.toolCalls.sinceCompaction,
			tool_calls_this_run: R.toolCalls.thisRun,
			tool_call_trigger: TOOL_CALL_TRIGGER,
			settings_error: inert() ?? null,
		};
	}

	pi.registerTool({
		name: VIEW_TOOL_NAME,
		label: "View Context",
		description: `See your own context usage as JSON: used_tokens, used_percent, context_window, level, the self-compact thresholds (notice, warning, hard_cutoff), the tokens left before each, and the tool calls since the last compaction. You cannot see these numbers any other way. Call it when you need to decide something (after a compaction, before a large read, when judging whether to compact). Do not call it every turn: the extension sends you a message when a trigger fires.`,
		promptSnippet: "Show your current context usage, percent, and the self-compact thresholds as JSON",
		promptGuidelines: [`${VIEW_TOOL_NAME} takes no arguments and never changes anything; use it when you need your current context numbers, not on every turn.`],
		parameters: Type.Object({}),
		async execute(_toolCallId, _params, _signal, _onUpdate, ctx) {
			const view = contextView(ctx);
			return { content: [{ type: "text", text: JSON.stringify(view, null, 2) }], details: view };
		},
		renderCall(_args, theme) {
			return new Text(theme.fg("toolTitle", theme.bold(VIEW_TOOL_NAME)), 0, 0);
		},
		renderResult(result, _options, theme) {
			const first = result.content[0];
			return new Text(theme.fg("text", first && first.type === "text" ? first.text : ""), 0, 0);
		},
	});

	pi.registerTool({
		name: TOOL_NAME,
		label: "Self Compact",
		description: TOOL_DESCRIPTION,
		promptSnippet: "Compact your own context: save a note_to_self, compaction runs when the turn ends, the note comes back verbatim",
		promptGuidelines: TOOL_GUIDELINES,
		parameters: Type.Object({ note_to_self: Type.String({ description: NOTE_DESCRIPTION }) }),
		async execute(_toolCallId, params, signal, _onUpdate, ctx) {
			if (signal?.aborted) throw new Error("Self-compaction cancelled before saving the note.");
			const problem = inert();
			if (problem) throw new Error(`self-compact is inert because its settings were rejected: ${problem}`);
			// The note is preserved byte for byte; only the checks look at the trimmed form.
			const raw = typeof params.note_to_self === "string" ? params.note_to_self : "";
			if (raw.trim().length === 0) throw new Error("note_to_self must not be blank. Write the goal, DONE work, IN PROGRESS state, decisions, test results, and the NEXT ACTION.");
			if (raw.length > NOTE_MAX_CHARS) throw new Error(`note_to_self exceeds ${NOTE_MAX_CHARS} characters (${raw.length}). Shorten it and call ${TOOL_NAME} again.`);
			const existing = activeHandoff();
			if (existing && (existing.status === "compacting" || existing.status === "ready")) throw new Error("Compaction is already in progress for the saved note.");
			refresh(ctx);
			if (!compactable(ctx)) {
				const keep = keepRecentTokens(ctx.cwd);
				throw new Error(`Nothing to compact yet: Pi keeps the newest ${keep.toLocaleString("en-US")} tokens of messages untouched and this session does not reach past them (context ${R.usage.tokens?.toLocaleString("en-US") ?? "?"} tokens, ${formatPct(R.usage.percent, 1)}). No note was saved and no tool is blocked. Keep working and call ${TOOL_NAME} later.`);
			}
			if (existing && existing.note.trim() !== raw.trim()) {
				throw new Error(`A note is already saved (${existing.note.length} chars). Retry ${TOOL_NAME} with that saved note verbatim instead of a new one.`);
			}
			// A retry keeps the original bytes; a new cycle gets a fresh durable id.
			const note = existing ? existing.note : raw;
			R.state.handoff = { id: existing?.id ?? randomUUID(), note, status: "pending", attempts: 0, savedAt: Date.now() };
			R.lastCompactionError = undefined;
			save();
			refresh(ctx);
			notify(ctx, `self-compact: note saved (${note.length} chars). Compaction runs when this turn ends.`, "info");
			const at = R.usage.tokens === null ? "unknown usage" : `${R.usage.tokens.toLocaleString("en-US")} tokens (${formatPct(R.usage.percent, 1)}), level ${R.level}`;
			return {
				content: [{ type: "text", text: `Note saved (${note.length} chars) at ${at}. Every other tool is blocked until compaction succeeds. Stop now: compaction runs when this turn ends and your note will be returned verbatim.` }],
				details: { handoffId: R.state.handoff.id, noteChars: note.length, cycle: R.state.cycle + 1, note, usedTokens: R.usage.tokens, usedPercent: R.usage.percent, level: R.level },
				terminate: true,
			};
		},
		renderCall(args, theme) {
			const note = typeof args?.note_to_self === "string" ? args.note_to_self : "";
			return new Text(`${theme.fg("toolTitle", theme.bold(TOOL_NAME))} ${theme.fg("muted", `note ${note.length.toLocaleString("en-US")} chars`)}`, 0, 0);
		},
		renderResult(result, { expanded }, theme) {
			const first = result.content[0];
			const text = first && first.type === "text" ? first.text : "";
			const details = result.details as { noteChars?: number; note?: string; usedTokens?: number | null; usedPercent?: number | null } | undefined;
			const usage = details?.usedTokens !== undefined && details?.usedTokens !== null ? ` at ${details.usedTokens.toLocaleString("en-US")} tokens (${formatPct(details.usedPercent, 1)})` : "";
			const line = details?.noteChars !== undefined ? `Note saved (${details.noteChars.toLocaleString("en-US")} chars)${usage}. Compaction runs when this turn ends.` : text;
			let out = theme.fg("success", `✓ ${line}`);
			if (expanded && details?.note) out += `\n${theme.fg("dim", details.note)}`;
			return new Text(out, 0, 0);
		},
	});

	// -------------------------------------------------------------- commands

	function infoLines(ctx: ExtensionContext): { lines: string[]; data: Record<string, unknown> } {
		refresh(ctx);
		const t = R.thresholds;
		const h = handoff();
		const describePrompt = (load: () => { text: string; source: string }) => {
			try { return load(); }
			catch (error) { return { text: "", source: `ERROR: ${error instanceof Error ? error.message : String(error)}` }; }
		};
		const prompts = {
			soft: describePrompt(() => loadPromptFile("soft", R.searchDirs)),
			warning: describePrompt(() => loadPromptFile("warning", R.searchDirs)),
			compaction: describePrompt(() => resolveCompactionPrompt({ flag: R.compactPromptFlag, searchDirs: R.searchDirs })),
			summaryInstructions: describePrompt(() => loadPromptFile("summaryInstructions", R.searchDirs)),
		};
		const model = ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : "(none)";
		const fmt = (n: number) => n.toLocaleString("en-US");
		const problem = inert();
		const lines: string[] = ["self-compact info"];
		lines.push(`settings: --compact-soft-at ${R.specs.softAt} (${R.sources.softAt}), --compact-at ${R.specs.at} (${R.sources.at}), --compact-buffer ${R.specs.buffer} (${R.sources.buffer}), --compact-prompt ${R.compactPromptFlag ? `set (${R.compactPromptFlag.length} chars)` : "unset"}, --compact-footer ${R.footerEnabled ? "on" : "off"}`);
		if (problem) lines.push(`REJECTED: ${problem} (extension is inert; every tool is blocked until fixed)`);
		lines.push(`model: ${model}, window ${fmt(R.usage.window)} tokens, cap ${t ? fmt(t.capTokens) : "?"} (90%)`);
		if (t) {
			lines.push(`resolved: soft ${fmt(t.softTokens)} (${formatPct(t.softPct, 1)}), warning ${fmt(t.warnTokens)} (${formatPct(t.warnPct, 1)}), buffer ${fmt(t.bufferTokens)}, forced ${fmt(t.forcedTokens)} (${formatPct(t.forcedPct, 1)})${t.clamped ? " [clamped]" : ""}`);
			for (const note of t.notes) lines.push(`note: ${note}`);
		}
		lines.push(`usage: ${R.usage.tokens === null ? "unknown" : `${fmt(R.usage.tokens)} tokens (${formatPct(R.usage.percent, 1)}), ${fmt(R.usage.cachedTokens)} cached`}  ${contextBarText()}`);
		lines.push(`state: level ${R.level}, fired [${[...R.fired].join(", ")}], tool calls ${R.toolCalls.sinceCompaction} since compaction (trigger ${TOOL_CALL_TRIGGER}), tools ${locked(ctx) ? `LOCKED (only ${TOOL_NAME})` : "unlocked"}, handoff ${h?.status ?? "none"}, attempts ${h?.attempts ?? 0}, compaction ${R.compactionInFlight ? "in flight" : "idle"}`);
		lines.push(`cycles completed: ${R.state.cycle}`);
		lines.push(`prompts: ${Object.entries(prompts).map(([k, p]) => `${k} ${p.source} (${p.text.length} chars)`).join(", ")}`);
		if (h) {
			const preview = h.note.length > 200 ? `${h.note.slice(0, 200)}…` : h.note;
			lines.push(`${h.status === "done" ? "last delivered note" : "pending note"} (${h.note.length} chars): ${preview.replace(/\s+/g, " ")}`);
			if (h.error) lines.push(`last error: ${h.error}`);
		}
		const data = {
			settings: { ...R.specs, compactPrompt: R.compactPromptFlag ?? null, footer: R.footerEnabled, sources: R.sources },
			rejected: problem ?? null,
			model,
			thresholds: t ?? null,
			usage: R.usage,
			bar: contextBarText(),
			level: R.level,
			fired: [...R.fired],
			toolCalls: { ...R.toolCalls, trigger: TOOL_CALL_TRIGGER },
			locked: locked(ctx),
			handoff: h ? { id: h.id, status: h.status, attempts: h.attempts, noteChars: h.note.length, note: h.note, error: h.error ?? null } : null,
			cycle: R.state.cycle,
			prompts: Object.fromEntries(Object.entries(prompts).map(([k, p]) => [k, { source: p.source, chars: p.text.length }])),
		};
		return { lines, data };
	}

	pi.registerCommand("self-compact-info", {
		description: "Show self-compact settings, resolved thresholds, usage, state, cycle count, prompt sources, and pending notes (no LLM turn)",
		handler: async (_args, ctx: ExtensionCommandContext) => {
			const info = infoLines(ctx);
			pi.appendEntry(INFO_ENTRY_TYPE, { ...info.data, lines: info.lines, at: Date.now() });
			if (ctx.hasUI && ctx.mode !== "tui") ctx.ui.notify(info.lines.join("\n"), "info");
		},
	});

	pi.registerCommand("self-compact-now", {
		description: `Ask the agent to write its note_to_self and call ${TOOL_NAME} now (reuses a saved note on retry)`,
		handler: async (_args, ctx: ExtensionCommandContext) => {
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
			const text = nowPrompt(saved);
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
		const header = theme.fg("success", theme.bold(`self-compact · handoff`)) + theme.fg("dim", ` cycle ${details?.cycle ?? "?"}, note_to_self returned verbatim to the agent (${note.length.toLocaleString("en-US")} chars):`);
		return new Text(`${header}\n${theme.fg("text", note)}`, options.outputPad ?? 1, 0);
	});

	pi.registerMessageRenderer(GUIDANCE_TYPE, (message, options, theme) => {
		const key = ((message.details as { key?: string; level?: string } | undefined)?.key ?? "notice") as UsageLevel;
		const text = typeof message.content === "string" ? message.content : "";
		return new Text(theme.fg(levelColor(THRESHOLD_KEYS.includes(key) ? key : "notice"), text), options.outputPad ?? 1, 0);
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
					const bar = renderContextBar({
						usedPct: t ? u.percent : null,
						cachedPct: u.window > 0 ? (u.cachedTokens / u.window) * 100 : 0,
						softPct: t?.softPct ?? 0,
						warnPct: t?.warnPct ?? 0,
						forcedPct: t?.forcedPct ?? 0,
					});
					const colors: Record<string, "success" | "accent" | "muted" | "warning" | "error" | "dim"> = { "#": "success", "=": "accent", "~": "muted", "!": "warning", "|": "error" };
					const cells = bar.cells.map((c) => theme.fg(colors[c] ?? "dim", c)).join("");
					const tag = statusTag(ctx);
					const left = theme.fg("dim", ` ${ctx.model?.id ?? "no-model"}`) + (R.state.cycle > 0 ? theme.fg("dim", ` · cycle ${R.state.cycle}`) : "");
					const phase = tag ? ` ${theme.fg(inert() || activeHandoff() ? "error" : levelColor(R.level), tag)}` : "";
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
		newEpoch();
		R.promptErrors.clear();
		R.compactionInFlight = false;
		R.searchDirs = promptSearchDirs(ctx.cwd, EXTENSION_DIR);
		loadSettings();
		resolve(ctx);

		const branch = ctx.sessionManager.getBranch() as never[];
		const recovered = recoverState(branch);
		R.state = recovered.state;
		// Never repeat a message the model already has in its context.
		restoreFired(ctx);

		const problem = inert();
		if (problem) notify(ctx, `self-compact REJECTED settings: ${problem}. Every tool is blocked until the flags are fixed.`, "error");

		const h = handoff();
		if (h && recovered.journaledUnanswered) {
			// Crash between journaling the handoff and the model's answer: resume without a user prompt.
			R.state.handoff = { ...h, status: "done" };
			save();
			notify(ctx, `self-compact: the returned note was never answered before ${event.reason}; resuming from it.`, "warning");
			const { id, note } = h;
			const cycle = R.state.cycle;
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
				save();
			} else {
				notify(ctx, `self-compact: compaction finished before ${event.reason}; returning the saved note.`, "info");
				deliverHandoff(ctx);
			}
		} else if (h && (h.status === "pending" || h.status === "failed" || h.status === "compacting")) {
			R.state.handoff = { ...h, status: h.status === "compacting" ? "failed" : h.status, attempts: 0, error: h.status === "compacting" ? "Compaction was interrupted (session reloaded)." : h.error };
			save();
			notify(ctx, `self-compact: restored a saved note (${h.note.length} chars, ${event.reason}). Tools stay locked until compaction succeeds.`, "warning");
			deferInEpoch("recoveryTimer", 500, () => {
				const current = handoff();
				if (current && (current.status === "pending" || current.status === "failed") && ctx.isIdle()) startCompaction(ctx, `recovery after ${event.reason}`);
			});
		}
		installFooter(ctx);
		tick(ctx);
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
		tick(ctx);
	});

	pi.on("before_agent_start", async (event) => {
		R.toolCalls.thisRun = 0;
		return { systemPrompt: event.systemPrompt + systemPromptLine(viewToolActive()) };
	});

	// Detection point only. This hook must never rewrite the message list: removing or re-rendering a
	// block that was already sent discards the provider's prefix cache from that block on.
	pi.on("context", async (_event, ctx) => {
		tick(ctx);
		return undefined;
	});

	pi.on("message_end", async (event, ctx) => {
		if (event.message.role === "assistant") {
			tick(ctx);
			return;
		}
		if (event.message.role === "custom" && event.message.customType === HANDOFF_TYPE) {
			const h = handoff();
			const id = (event.message.details as { id?: string } | undefined)?.id;
			if (h && h.status === "ready" && h.id === id) {
				// Pi has journaled the verbatim handoff: the transaction is complete.
				R.state.handoff = { ...h, status: "done" };
				save();
				refresh(ctx);
			}
		}
	});

	pi.on("tool_call", async (event, ctx) => {
		refresh(ctx); // the lock below reads the level; make sure it is current
		const problem = inert();
		if (problem) return { block: true, reason: `self-compact rejected its settings, so this session is not protected: ${problem}. Fix the --compact-* flags and restart.` };
		if (event.toolName === TOOL_NAME || event.toolName === VIEW_TOOL_NAME) return undefined;
		// Whole-batch preflight: Pi preflights siblings sequentially before running them concurrently,
		// so an ordinary tool before or after a self_compact call in the same assistant message is blocked too.
		const branch = ctx.sessionManager.getBranch();
		for (let i = branch.length - 1; i >= 0; i--) {
			const entry = branch[i]!;
			if (entry.type !== "message" || entry.message.role !== "assistant") continue;
			const calls = (entry.message as AssistantMessage).content.filter((c) => c.type === "toolCall");
			const hasHandoff = calls.some((c) => c.type === "toolCall" && c.name === TOOL_NAME && typeof c.arguments?.note_to_self === "string" && c.arguments.note_to_self.trim().length > 0 && c.arguments.note_to_self.length <= NOTE_MAX_CHARS);
			if (hasHandoff && calls.some((c) => c.type === "toolCall" && c.id === event.toolCallId)) {
				return { block: true, terminate: true, reason: `Tool "${event.toolName}" is blocked by self-compact: ${TOOL_NAME} is in this tool batch, so the run must end here. Wait for the handoff.` };
			}
			break;
		}
		if (locked(ctx)) {
			const h = activeHandoff();
			const u = R.usage;
			const t = R.thresholds;
			const why = h && (h.status === "pending" || h.status === "compacting")
				? `a ${TOOL_NAME} note is saved and compaction is ${h.status}`
				: h && h.status === "failed"
					? `the last compaction failed (${h.error ?? "unknown error"}) and the saved note is kept`
					: `context is at ${formatPct(u.percent, 1)} (${u.tokens?.toLocaleString("en-US") ?? "?"} tokens), at or above the forced threshold of ${formatPct(t?.forcedPct ?? null, 1)} (${t?.forcedTokens.toLocaleString("en-US") ?? "?"} tokens)`;
			return { block: true, reason: `Tool "${event.toolName}" is blocked by self-compact: ${why}. Every tool except ${TOOL_NAME} is blocked until compaction succeeds. Write your note_to_self and call ${TOOL_NAME} now.` };
		}
		R.toolCalls.sinceCompaction += 1;
		R.toolCalls.thisRun += 1;
		tick(ctx);
		return undefined;
	});

	pi.on("agent_end", async (_event, ctx) => {
		tick(ctx);
		if (!mayTrigger(ctx)) return;
		// Past the warning line (or locked) an idle agent is asked to compact now; otherwise a heavy run gets the RUN ENDED nudge.
		if (locked(ctx) || LEVEL_ORDER[R.level] >= LEVEL_ORDER.warning) {
			fire(ctx, "now", nowPrompt(), true);
		} else if (R.toolCalls.thisRun >= TOOL_CALL_TRIGGER) {
			fire(ctx, "run-end", renderTemplate(RUN_END_PROMPT, templateValues()), true);
		}
		// A follow-up turn continues the same run (no before_agent_start), so the per-run count is consumed here.
		R.toolCalls.thisRun = 0;
	});

	pi.on("agent_settled", async (_event, ctx) => {
		if (!R.alive) return; // shutdown during compaction: the ctx is already stale
		refresh(ctx);
		if (inert()) return;
		const h = handoff();
		if (!h || !ctx.isIdle()) return;
		if (h.status === "ready") deliverHandoff(ctx);
		else if (h.status === "pending" || (h.status === "failed" && h.attempts < MAX_AUTO_RETRIES && R.lastCompactionError)) startCompaction(ctx, h.status === "pending" ? "agent idle" : "retry after failure");
	});

	pi.on("session_before_compact", async (event, ctx) => {
		// Native threshold/overflow compaction is replaced by the note handoff: the forced level does the asking.
		if (event.reason !== "manual") {
			refresh(ctx);
			return { cancel: true };
		}
		R.lastCompactionError = undefined;
		if (!ctx.model) return undefined;
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
		newEpoch();
		// Guidance still inside the kept window must not be repeated; guidance summarized away may fire again.
		restoreFired(ctx);
		R.compactionInFlight = false;
		const h = handoff();
		if (h && h.status !== "done") {
			R.state.cycle += 1;
			R.state.handoff = { ...h, status: "ready", error: undefined };
			save();
			notify(ctx, `self-compact: compaction ${event.reason} succeeded (cycle ${R.state.cycle}); returning the note (${h.note.length} chars) and restoring tools.`, "info");
			deliverHandoff(ctx);
		}
		refresh(ctx);
	});

	pi.on("session_compact_failed", async (event, ctx) => {
		// Non-manual compactions are the ones this extension cancelled on purpose.
		if (event.reason !== "manual" && event.aborted) return;
		R.compactionInFlight = false;
		if (!R.alive) return; // shutdown aborted the compaction: the saved note is recovered on the next session start
		const h = handoff();
		if (!h || (h.status !== "compacting" && h.status !== "pending")) {
			refresh(ctx);
			return;
		}
		const ours = R.lastCompactionError !== undefined;
		const failed: Handoff = { ...h, status: "failed", attempts: h.attempts + 1, error: R.lastCompactionError ?? event.errorMessage ?? (event.aborted ? "compaction was cancelled" : "compaction failed") };
		R.state.handoff = failed;
		save();
		refresh(ctx);
		if ((ours || !event.aborted) && failed.attempts < MAX_AUTO_RETRIES) {
			notify(ctx, `self-compact: compaction failed (attempt ${failed.attempts}): ${failed.error}. Note kept, tools stay locked, retrying automatically.`, "warning");
			scheduleRetry(ctx);
		} else {
			notify(ctx, `self-compact: compaction ${event.aborted && !ours ? "cancelled" : "failed"} (attempt ${failed.attempts}): ${failed.error}. Note kept and tools stay locked. Run /self-compact-now or /compact to retry.`, "error");
		}
	});
}
