/**
 * Everything the agent reads about self-compaction: tool names, the tool description, the
 * system-prompt line, and the text of each trigger message. Pure module, no Pi imports.
 *
 * The model is expected to compact on its own judgement. The extension helps in two ways:
 * it counts ordinary tool calls and nudges at TOOL_CALL_TRIGGER (mid-run once, and again at the
 * end of a heavy run), and it keeps the token thresholds (notice / warning / forced) as the
 * backstop that eventually blocks every other tool.
 */
import { NOTE_MAX_CHARS } from "./prompts.ts";

export const TOOL_NAME = "self_compact";
export const VIEW_TOOL_NAME = "view_context";

/** Ordinary tool calls since the last compaction after which the agent is nudged to compact. */
export const TOOL_CALL_TRIGGER = 10;

export const NOTE_SHAPE = "goal, DONE with exact paths and commands, IN PROGRESS, key decisions, verified results, exact NEXT ACTION last";

/** The core instruction. It appears in the tool description, the guidelines, and the system prompt. */
export const PROMPT =
	`Compact your own context proactively; do not wait for a threshold. Token thresholds are only a backstop. Trigger: whenever you reach a natural checkpoint (a sub-question answered, a read/edit/verify cycle finished, a phase of an investigation done) and there are ${TOOL_CALL_TRIGGER} or more tool calls since the last compaction whose verbatim output you no longer need, compact BEFORE starting the next step. Compaction is cheap and you continue immediately; stale tool output is what costs tokens on every turn. In note_to_self turn those tool calls into summaries: the overall goal, what you are working on now, the steps taken so far including failures and possible next paths, exact paths, commands, values and results you still need, and what to prioritize next.`;

export const TOOL_DESCRIPTION =
	`${PROMPT}\n\nHand off to yourself across a context compaction: provide note_to_self (1 to ${NOTE_MAX_CHARS} characters), call it alone in a tool batch. The note is saved, this run ends, the context is compacted once you are idle, and the note is returned verbatim so you continue from it. At the hard cutoff every other tool is blocked until this succeeds.`;

export const TOOL_GUIDELINES = [
	PROMPT,
	`Use ${TOOL_NAME} alone in a tool batch when you decide to compact, and always when a [self-compact · CHECKPOINT] or [self-compact · RUN ENDED] message arrives: the note is saved, the run ends, compaction runs once the agent is idle, and the note comes back verbatim.`,
	`After a [self-compact · handoff] message, continue only the unfinished NEXT ACTION from your note; if the task is complete, report completion and stop.`,
];

export const NOTE_DESCRIPTION =
	`Your message to yourself (1-${NOTE_MAX_CHARS} chars): summaries of the goal, current work, steps taken including failures and next paths, exact paths/commands/values still needed, and what to prioritize next.`;

/** Appended to the system prompt on every turn. `viewActive` mentions view_context only when that tool is available. */
export function systemPromptLine(viewActive: boolean): string {
	const view = viewActive
		? `You cannot see your own context usage otherwise: call ${VIEW_TOOL_NAME} (no arguments) whenever you need the current numbers as JSON, for example after a compaction or before deciding to compact; do not poll it every turn. `
		: "";
	return `\n\nself-compact (proactive): ${PROMPT} ${view}Call ${TOOL_NAME} alone in a tool batch. The run ends, the context is compacted while you are idle, and your note_to_self is returned to you verbatim as the next message (exactly the note text, nothing else); resume from it without another user message and never redo work the note marks as done. You also receive short [self-compact · …] messages: CHECKPOINT when the tool-call trigger is reached, RUN ENDED after a heavy run, and threshold NOTICE/WARNING/FORCED as the backstop. If no work remains, report completion and stop.`;
}

/** Mid-run nudge, once per compaction cycle, when the tool-call trigger is reached. Template. */
export const CHECKPOINT_PROMPT =
	`[self-compact · CHECKPOINT] {{tool_calls_since_compaction}} tool calls since the last compaction ({{used_tokens}} tokens, {{used_percent}} of {{context_window}}). Finish only the current atomic step, then compact before the next one: write note_to_self (${NOTE_SHAPE}) and call \`{{tool_name}}\` as your only tool call. If every one of those tool results is still needed verbatim for the very next step, continue and compact right after it.`;

/** End-of-run nudge, sent as a follow-up turn when a run used at least the trigger count. Template. */
export const RUN_END_PROMPT =
	`[self-compact · RUN ENDED] That run used {{tool_calls_this_run}} tool calls ({{tool_calls_since_compaction}} since the last compaction; {{used_tokens}} tokens, {{used_percent}} of {{context_window}}). Compact now, before the next request arrives: write note_to_self (${NOTE_SHAPE}, the answer you just gave in brief) and call \`{{tool_name}}\` as your only tool call.`;

/** Prompt used by /self-compact-now and the idle nudge past the warning line. */
export function nowPrompt(saved?: string): string {
	const base = `Compact now: write your note_to_self (max ${NOTE_MAX_CHARS} chars: ${NOTE_SHAPE}) and call ${TOOL_NAME} as your only tool call.`;
	if (!saved) return base;
	return `${base}\n\nA note is already saved from a previous attempt. Pass it to ${TOOL_NAME} verbatim instead of inventing a new one. Saved note, verbatim:\n\n${saved}\n\n---\nCall ${TOOL_NAME} now with exactly that note.`;
}
