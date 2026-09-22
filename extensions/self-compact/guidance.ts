/** Model-facing self-compaction policy. Token thresholds are a backstop, not a schedule. */
import { NOTE_MAX_CHARS } from "./prompts.ts";

export const TOOL_NAME = "self_compact";
export const VIEW_TOOL_NAME = "view_context";
export const NOTE_SHAPE = "goal, DONE with exact paths and commands, IN PROGRESS, key decisions, verified results, exact NEXT ACTION last";

export const PROMPT =
	"Compact between logical sections of ongoing work when substantial earlier context is no longer needed verbatim. For example, finish an investigation before implementing its findings, or finish one implementation phase before starting another. Use your judgment: neither a tool-call count nor every small checkpoint warrants compaction. Keep working when the next step still needs the context. Token thresholds are a backstop. If the task is complete, report completion and stop; do not compact just to finish a task or prepare for a hypothetical next request.";

export const TOOL_DESCRIPTION =
	`${PROMPT}\n\nSave note_to_self (1 to ${NOTE_MAX_CHARS} characters) and compact before the next assistant response, after this tool batch finishes. Call it alone in a tool batch. Your note returns verbatim within the same task; resume its unfinished NEXT ACTION without repeating DONE work. After a failed attempt, call self_compact({}) to retry the saved note against current history, or supply a replacement note. Failure keeps the history and note; below the hard cutoff, it does not lock ordinary tools. Do not retry cancellation automatically.`;

export const TOOL_GUIDELINES = [
	PROMPT,
	`Use ${TOOL_NAME} alone in a tool batch. A saved note is a request, not proof that compaction succeeded.`,
	`After a [self-compact · handoff] message, continue only unfinished work, respecting any newer user instructions. If nothing remains, report completion and stop.`,
	`After failure, inspect the reason before retrying with ${TOOL_NAME}({}); you do not need to reproduce the saved note.`,
];

export const NOTE_DESCRIPTION =
	`Your message to yourself (1-${NOTE_MAX_CHARS} chars): ${NOTE_SHAPE}. Summarize work and failures; retain exact paths, commands, values, and constraints still needed. Omit to retry a saved note after failure.`;

export function systemPromptLine(viewActive: boolean): string {
	const view = viewActive
		? `Call ${VIEW_TOOL_NAME} for current context usage when it would affect a decision, not every turn. `
		: "";
	return `\n\nself-compact: ${PROMPT} ${view}Call ${TOOL_NAME} alone in a tool batch, with note_to_self (${NOTE_SHAPE}). Compaction runs between assistant responses without ending this task, and your note returns verbatim. Follow newer instructions if they change its NEXT ACTION. Threshold NOTICE/WARNING/FORCED messages are passive backstops, not a tool-call schedule.`;
}

export function nowPrompt(): string {
	return `Compact now: write note_to_self (max ${NOTE_MAX_CHARS} chars: ${NOTE_SHAPE}) and call ${TOOL_NAME} as your only tool call. If a failed note is saved and still accurate, call ${TOOL_NAME}({}) to reuse it.`;
}
