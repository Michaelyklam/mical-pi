/**
 * The A/B variants of the self-compaction tool.
 *
 * The extension exposes one control tool (`self_compact`) and one experimental
 * tool (`self_compact_experimental`). Both are the SAME engine: same thresholds,
 * same forced lock, same note handoff, same persisted state. The only variable
 * is the prompt surface the agent sees (tool description, prompt snippet,
 * prompt guidelines, and the once-per-crossing threshold guidance message).
 *
 * Both tools are registered, but only the selected mode's tool is active. Variant B
 * is selected with /self-compact-mode or the --compact-experimental bootstrap flag. Its prompt is the
 * user's A/B-test wording, kept verbatim in EXPERIMENTAL_PROMPT; do not reword it.
 *
 * Which variants are live is decided by Pi, not by this module: `--exclude-tools`
 * and `--tools` remove extension tools from the active set, and the extension
 * reads `pi.getActiveTools()`. When both variants are active, the control tool is
 * canonical and every extension-generated message names it (see primaryToolName).
 */
import { NOTE_MAX_CHARS } from "./prompts.ts";

export const CONTROL_TOOL_NAME = "self_compact";
export const EXPERIMENTAL_TOOL_NAME = "self_compact_experimental";
export const VIEW_TOOL_NAME = "view_context";

/** Boolean extension flag that registers the experimental tool. Default off. */
export const EXPERIMENTAL_FLAG = "compact-experimental";

/**
 * Variant B's prompt, verbatim from the user's A/B test request.
 * Do not rewrite, expand, or "improve" this string.
 */
export const EXPERIMENTAL_PROMPT =
	"if the current context contains many tool calls, compact your own context and turn them into summaries of what our overall goal is, what we are currently working on, and what steps we've been through including summaries of failures and possible next paths. Leave a message for yourself for what to prioritize next.";

export type VariantKind = "control" | "experimental";

/** Threshold levels that get one persisted guidance message per crossing. */
export type GuidanceLevel = "notice" | "warning" | "forced";

export interface CompactVariant {
	kind: VariantKind;
	name: string;
	label: string;
	/** Main agent-facing prompt surface (tool description). */
	description: string;
	/** One-line entry in the system prompt's "Available tools" section. */
	promptSnippet: string;
	/** Bullets appended to the system prompt's "Guidelines" section while the tool is active. */
	promptGuidelines: string[];
	/** Description of the note_to_self parameter. */
	noteDescription: string;
	/** Guidance bodies rendered once per crossing; undefined means "read the vendored prompt files" (control). */
	guidance?: (level: GuidanceLevel) => string;
}

const NUMBERS =
	"Session numbers: {{used_tokens}} tokens used ({{used_percent}}) of {{context_window}}; warning line {{warning_tokens}} ({{warning_percent}}), hard cutoff {{forced_tokens}} ({{forced_percent}}), {{remaining_to_forced}} tokens away.";

/** Variant B guidance: the exact experimental prompt plus live numbers and the tool call. */
export function experimentalGuidance(level: GuidanceLevel): string {
	if (level === "notice") {
		return `[self-compact · NOTICE] ${NUMBERS} Nothing is blocked and no action is required yet.\n\n${EXPERIMENTAL_PROMPT}`;
	}
	if (level === "warning") {
		return `[self-compact · WARNING] ${NUMBERS} Finish the current atomic step, then:\n\n${EXPERIMENTAL_PROMPT}\n\nCall \`{{tool_name}}\` as your only tool call.`;
	}
	return `[self-compact · FORCED] ${NUMBERS} Every tool except \`{{tool_name}}\` is blocked until compaction succeeds:\n\n${EXPERIMENTAL_PROMPT}\n\nWrite your note_to_self and call \`{{tool_name}}\` now as your only tool call. Do not call any other tool.`;
}

const CONTROL_GUIDELINES = [
	`Use ${CONTROL_TOOL_NAME} alone in a tool batch when a [self-compact · …] message asks you to compact, or at a clean checkpoint when context is high.`,
	`A ${CONTROL_TOOL_NAME} note_to_self states the goal, DONE work with exact paths, IN PROGRESS state, key decisions, verified test results, and the exact NEXT ACTION as its last line; never list finished work as pending.`,
	`After a [self-compact · handoff] message, continue only the unfinished NEXT ACTION from your note; if the task is complete, report completion and stop.`,
];

const EXPERIMENTAL_GUIDELINES = [
	EXPERIMENTAL_PROMPT,
	`Use ${EXPERIMENTAL_TOOL_NAME} alone in a tool batch when you decide to compact: the note is saved, the run ends, compaction runs once the agent is idle, and the note comes back verbatim.`,
	`After a [self-compact · handoff] message, continue only the unfinished NEXT ACTION from your note; if the task is complete, report completion and stop.`,
];

export const VARIANTS: Record<VariantKind, CompactVariant> = {
	control: {
		kind: "control",
		name: CONTROL_TOOL_NAME,
		label: "Self Compact",
		description: `Hand off to yourself across a context compaction. Provide note_to_self (1 to ${NOTE_MAX_CHARS} characters): the goal, DONE work with exact file paths and commands, IN PROGRESS state, key decisions, verified test results, and the exact NEXT ACTION as the last line. Call it alone in a tool batch. The note is saved, this run ends, the context is compacted once you are idle, and the note is returned verbatim so you continue from NEXT ACTION. At the hard cutoff every other tool is blocked until this succeeds.`,
		promptSnippet: "Compact your own context: save a note_to_self, compaction runs when the turn ends, the note comes back verbatim",
		promptGuidelines: CONTROL_GUIDELINES,
		noteDescription: `Your handoff note (1-${NOTE_MAX_CHARS} chars). Ends with the exact NEXT ACTION.`,
	},
	experimental: {
		kind: "experimental",
		name: EXPERIMENTAL_TOOL_NAME,
		label: "Self Compact (Experimental)",
		description: `${EXPERIMENTAL_PROMPT}\n\nHand off to yourself across a context compaction: provide note_to_self (1 to ${NOTE_MAX_CHARS} characters), call it alone in a tool batch. The note is saved, this run ends, the context is compacted once you are idle, and the note is returned verbatim so you continue from it. At the hard cutoff every other tool is blocked until this succeeds.`,
		promptSnippet: EXPERIMENTAL_PROMPT,
		promptGuidelines: EXPERIMENTAL_GUIDELINES,
		noteDescription: `Your message to yourself (1-${NOTE_MAX_CHARS} chars). Leave a message for yourself for what to prioritize next.`,
		guidance: experimentalGuidance,
	},
};

export function variantDefinition(kind: VariantKind): CompactVariant {
	return VARIANTS[kind];
}

// ------------------------------------------------------------------ modes

/**
 * Which self-compaction tool a session selected. This is a per-session choice
 * (durable custom entry), never a global setting, so two Pi sessions can run
 * different arms side by side.
 */
export type CompactMode = "control" | "experimental" | "off";

export const COMPACT_MODES: readonly CompactMode[] = ["control", "experimental", "off"];

export interface ModeChoice {
	mode: CompactMode;
	/** Picker row and `control|experimental|off` argument value. */
	label: string;
	description: string;
}

/** Rows of the /self-compact-mode picker, in display order. */
export const MODE_CHOICES: readonly ModeChoice[] = [
	{ mode: "control", label: "Control", description: `the default variant A (${CONTROL_TOOL_NAME})` },
	{ mode: "experimental", label: "Experimental", description: `variant B of the A/B test (${EXPERIMENTAL_TOOL_NAME})` },
	{ mode: "off", label: "Off", description: "restore native Pi compaction, no guidance and no lock" },
];

/** The tool a mode activates; `off` activates neither variant. */
export function modeToolName(mode: CompactMode): string | undefined {
	if (mode === "control") return CONTROL_TOOL_NAME;
	if (mode === "experimental") return EXPERIMENTAL_TOOL_NAME;
	return undefined;
}

/** One-line description of what a mode turns on (info output and toasts). */
export function modeSummary(mode: CompactMode): string {
	if (mode === "control") return `only ${CONTROL_TOOL_NAME} is active`;
	if (mode === "experimental") return `only ${EXPERIMENTAL_TOOL_NAME} is active`;
	return "native Pi compaction is restored; no guidance, no lock, no cancellation";
}

/**
 * Parse a /self-compact-mode argument. Accepts the mode names plus the A/B
 * shorthands `a` and `b`; returns undefined for anything else.
 */
export function parseMode(value: string): CompactMode | undefined {
	switch (value.trim().toLowerCase()) {
		case "control":
		case "a":
			return "control";
		case "experimental":
		case "experiment":
		case "b":
			return "experimental";
		case "off":
		case "none":
			return "off";
		default:
			return undefined;
	}
}

/**
 * Mode for a session that has no persisted selection: `--compact-experimental`
 * asks for variant B, everything else starts on the control variant. Which tool
 * actually comes up is Pi's decision: `setActiveTools` applies the hard
 * `--tools` / `--exclude-tools` filters, and the recovery path falls back to the
 * other already-requested variant when the first one is denied, or reports that
 * no mode could be activated.
 */
export function bootstrapMode(experimentalFlag: boolean): CompactMode {
	return experimentalFlag ? "experimental" : "control";
}

/** Which self-compaction tools Pi currently has active. */
export interface VariantState {
	control: boolean;
	experimental: boolean;
}

export function selectVariants(activeToolNames: readonly string[]): VariantState {
	const names = new Set(activeToolNames);
	return { control: names.has(CONTROL_TOOL_NAME), experimental: names.has(EXPERIMENTAL_TOOL_NAME) };
}

export function hasEnabledVariant(state: VariantState): boolean {
	return state.control || state.experimental;
}

/**
 * The tool name every extension-generated message uses. The control tool wins
 * when both are active; with neither active there is no primary and the
 * extension stays passive (it never blocks tools or cancels native compaction).
 */
export function primaryToolName(state: VariantState): string | undefined {
	if (state.control) return CONTROL_TOOL_NAME;
	if (state.experimental) return EXPERIMENTAL_TOOL_NAME;
	return undefined;
}

/** True when `name` is a self-compaction tool that is enabled in this session. */
export function isCompactToolName(name: string, state: VariantState): boolean {
	return (state.control && name === CONTROL_TOOL_NAME) || (state.experimental && name === EXPERIMENTAL_TOOL_NAME);
}

/** All self-compaction tool names, enabled or not (recovery and blocking checks). */
export const COMPACT_TOOL_NAMES: readonly string[] = [CONTROL_TOOL_NAME, EXPERIMENTAL_TOOL_NAME];
