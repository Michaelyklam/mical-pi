/**
 * Persisted state (one snapshot entry per change) and the pure recovery reducer.
 *
 * Merged design: a single `self-compact-state` snapshot (gpt-6-astra) plus branch checks for
 * "compaction landed but the note never came back" and "journaled but unanswered" (claude-fable-5-1).
 */

import type { CompactMode } from "./variants.ts";

export type HandoffStatus = "pending" | "compacting" | "failed" | "ready" | "done";

export interface Handoff {
	/** Durable id: carried in compaction details and in the handoff message details. */
	id: string;
	note: string;
	status: HandoffStatus;
	attempts: number;
	savedAt: number;
	error?: string;
}

export interface PersistedState {
	version: 1;
	cycle: number;
	locked: boolean;
	handoff?: Handoff;
}

/** customType of the state snapshot entries (not sent to the LLM). */
export const STATE_TYPE = "self-compact-state";
/** customType of the handoff message that returns the note (sent to the LLM). */
export const HANDOFF_TYPE = "self-compact-handoff";
/** customType of the TUI-only threshold-crossing line. */
export const PHASE_ENTRY_TYPE = "self-compact-phase";
/** customType of /self-compact-info cards. */
export const INFO_ENTRY_TYPE = "self-compact-info";
/** customType of the selected-mode entry (durable per session, not sent to the LLM). */
export const MODE_ENTRY_TYPE = "self-compact-mode";

/**
 * The mode a session selected, persisted as a custom entry on the session branch so
 * it survives reload and resume and follows /tree navigation.
 */
export interface ModeEntry {
	version: 1;
	mode: CompactMode;
	/** How the mode came to be: a picker/argument switch, or the CLI bootstrap. */
	source: "user" | "session" | "flag";
	at: number;
}

const MODES: readonly CompactMode[] = ["control", "experimental", "off"];

function isModeEntry(entry: EntryLike): entry is EntryLike & { data: ModeEntry } {
	const data = entry.data as ModeEntry | undefined;
	return entry.type === "custom" && entry.customType === MODE_ENTRY_TYPE && data?.version === 1 && MODES.includes(data.mode);
}

/** Latest selected mode on the branch, or undefined when the session never selected one. */
export function recoverMode(entries: EntryLike[]): ModeEntry | undefined {
	let found: ModeEntry | undefined;
	for (const entry of entries) if (isModeEntry(entry)) found = entry.data;
	return found;
}

export function emptyState(): PersistedState {
	return { version: 1, cycle: 0, locked: false };
}

/** Minimal structural view of the session entries we care about (subset of Pi's SessionEntry). */
export interface EntryLike {
	type: string;
	customType?: string;
	data?: unknown;
	details?: unknown;
	message?: { role?: string; usage?: unknown; stopReason?: string };
}

export interface RecoveredState {
	state: PersistedState;
	/** The handoff message for the current handoff was journaled but no assistant answered it. */
	journaledUnanswered: boolean;
	/** The handoff message was journaled and an assistant answered it. */
	answered: boolean;
}

function isState(entry: EntryLike): entry is EntryLike & { data: PersistedState } {
	return entry.type === "custom" && entry.customType === STATE_TYPE && (entry.data as PersistedState | undefined)?.version === 1;
}

/**
 * Rebuild state from branch entries (root -> leaf). The latest snapshot wins; the branch is then checked
 * for a compaction carrying the handoff id (summary landed) and for the journaled handoff message.
 */
export function recoverState(entries: EntryLike[]): RecoveredState {
	let state = emptyState();
	for (const entry of entries) {
		if (isState(entry)) state = structuredClone(entry.data);
	}
	const result: RecoveredState = { state, journaledUnanswered: false, answered: false };
	const h = state.handoff;
	if (!h) return result;

	const handoffIndex = entries.findIndex((e) => e.type === "custom_message" && e.customType === HANDOFF_TYPE && (e.details as { id?: string; resumed?: boolean } | undefined)?.id === h.id && !(e.details as { resumed?: boolean }).resumed);
	if (handoffIndex !== -1) {
		// The note was journaled (status may already be "done"): answered or not decides whether to resume.
		const answered = entries.slice(handoffIndex + 1).some((e) => e.type === "message" && e.message?.role === "assistant");
		result.answered = answered;
		result.journaledUnanswered = !answered;
		if (h.status !== "done") state.handoff = { ...h, status: "ready" };
		return result;
	}
	if (h.status === "done") return result;
	const compactionLanded = entries.some((e) => e.type === "compaction" && (e.details as { handoffId?: string } | undefined)?.handoffId === h.id);
	if (compactionLanded || h.status === "ready") state.handoff = { ...h, status: "ready" };
	return result;
}

export interface UsageLike {
	input?: number;
	output?: number;
	cacheRead?: number;
	cacheWrite?: number;
	totalTokens?: number;
}

/** Usage of the latest valid assistant message after the latest compaction entry. */
export function latestAssistantUsage(entries: EntryLike[]): UsageLike | undefined {
	let compactionIndex = -1;
	for (let i = entries.length - 1; i >= 0; i--) {
		if (entries[i]!.type === "compaction") {
			compactionIndex = i;
			break;
		}
	}
	for (let i = entries.length - 1; i > compactionIndex; i--) {
		const entry = entries[i]!;
		if (entry.type !== "message" || entry.message?.role !== "assistant") continue;
		const stop = entry.message.stopReason;
		if (stop === "aborted" || stop === "error") continue;
		const usage = entry.message.usage as UsageLike | undefined;
		if (!usage) continue;
		const total = usage.totalTokens || (usage.input ?? 0) + (usage.output ?? 0) + (usage.cacheRead ?? 0) + (usage.cacheWrite ?? 0);
		if (total > 0) return usage;
	}
	return undefined;
}
