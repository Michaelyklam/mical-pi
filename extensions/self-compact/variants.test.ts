/**
 * Focused tests for the A/B variant definitions.
 *
 * These pin the experiment contract: the exact experimental prompt, the
 * deterministic selection rules, and the fact that both variants describe the
 * SAME mechanics (only the prompt surface differs).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
	bootstrapMode,
	COMPACT_MODES,
	CONTROL_TOOL_NAME,
	EXPERIMENTAL_FLAG,
	EXPERIMENTAL_PROMPT,
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
} from "./variants.ts";
import { NOTE_MAX_CHARS } from "./prompts.ts";

test("the experimental prompt is the user's wording, verbatim", () => {
	assert.equal(
		EXPERIMENTAL_PROMPT,
		"if the current context contains many tool calls, compact your own context and turn them into summaries of what our overall goal is, what we are currently working on, and what steps we've been through including summaries of failures and possible next paths. Leave a message for yourself for what to prioritize next.",
	);
	assert.equal(EXPERIMENTAL_FLAG, "compact-experimental");
	assert.equal(CONTROL_TOOL_NAME, "self_compact");
	assert.equal(EXPERIMENTAL_TOOL_NAME, "self_compact_experimental");
	assert.equal(VIEW_TOOL_NAME, "view_context");
});

test("selectVariants resolves the active tools Pi reports", () => {
	assert.deepEqual(selectVariants([]), { control: false, experimental: false });
	assert.deepEqual(selectVariants([CONTROL_TOOL_NAME, VIEW_TOOL_NAME]), { control: true, experimental: false });
	assert.deepEqual(selectVariants([EXPERIMENTAL_TOOL_NAME]), { control: false, experimental: true });
	assert.deepEqual(selectVariants([CONTROL_TOOL_NAME, EXPERIMENTAL_TOOL_NAME]), { control: true, experimental: true });
	assert.equal(hasEnabledVariant(selectVariants([])), false);
	assert.equal(hasEnabledVariant(selectVariants([EXPERIMENTAL_TOOL_NAME])), true);
});

test("the control tool is the deterministic primary when both variants are active", () => {
	assert.equal(primaryToolName(selectVariants([CONTROL_TOOL_NAME, EXPERIMENTAL_TOOL_NAME])), CONTROL_TOOL_NAME);
	assert.equal(primaryToolName(selectVariants([EXPERIMENTAL_TOOL_NAME])), EXPERIMENTAL_TOOL_NAME);
	assert.equal(primaryToolName(selectVariants([])), undefined, "no primary means the extension stays passive");

	const both = selectVariants([CONTROL_TOOL_NAME, EXPERIMENTAL_TOOL_NAME]);
	assert.equal(isCompactToolName(CONTROL_TOOL_NAME, both), true);
	assert.equal(isCompactToolName(EXPERIMENTAL_TOOL_NAME, both), true);
	assert.equal(isCompactToolName("read", both), false);

	const bOnly = selectVariants([EXPERIMENTAL_TOOL_NAME]);
	assert.equal(isCompactToolName(CONTROL_TOOL_NAME, bOnly), false, "an excluded variant is not a reachable compaction tool");
	assert.equal(isCompactToolName(EXPERIMENTAL_TOOL_NAME, bOnly), true);
});

test("variant B exposes the exact prompt on every prompt surface; variant A does not", () => {
	const control = variantDefinition("control");
	const experimental = variantDefinition("experimental");
	assert.ok(!control.description.includes(EXPERIMENTAL_PROMPT));
	assert.ok(!control.promptGuidelines.some((g) => g.includes(EXPERIMENTAL_PROMPT)));
	assert.ok(!control.promptSnippet.includes(EXPERIMENTAL_PROMPT));
	assert.ok(!control.noteDescription.includes(EXPERIMENTAL_PROMPT));
	assert.equal(control.guidance, undefined, "the control variant reads the vendored prompt files");

	assert.ok(experimental.description.includes(EXPERIMENTAL_PROMPT));
	assert.ok(experimental.promptGuidelines.includes(EXPERIMENTAL_PROMPT));
	assert.equal(experimental.promptSnippet, EXPERIMENTAL_PROMPT);
	assert.match(experimental.noteDescription, /Leave a message for yourself for what to prioritize next\./);
	assert.equal(typeof experimental.guidance, "function");
});

test("both variants describe the same note/handoff mechanics and length limit", () => {
	for (const variant of [variantDefinition("control"), variantDefinition("experimental")]) {
		assert.match(variant.description, new RegExp(String(NOTE_MAX_CHARS)));
		assert.match(variant.description, /note_to_self/);
		assert.match(variant.description, /note is returned verbatim|note comes back verbatim/);
		assert.match(variant.description, /blocked until this succeeds/);
	}
});

test("the experimental guidance carries the exact prompt plus live numbers at every level", () => {
	for (const level of ["notice", "warning", "forced"] as const) {
		const text = experimentalGuidance(level);
		assert.ok(text.includes(EXPERIMENTAL_PROMPT), `${level} guidance must carry the exact prompt`);
		assert.match(text, /\{\{used_tokens\}\}/);
		assert.match(text, /\{\{forced_tokens\}\}/);
	}
	// The notice level asks for no action, so it does not name the tool; warning and forced do.
	assert.doesNotMatch(experimentalGuidance("notice"), /\{\{tool_name\}\}/);
	assert.match(experimentalGuidance("warning"), /\{\{tool_name\}\}/);
	assert.match(experimentalGuidance("forced"), /\{\{tool_name\}\}/);
	assert.match(experimentalGuidance("forced"), /Every tool except/);
	assert.match(experimentalGuidance("warning"), /as your only tool call/);
});

test("mode vocabulary: parse the arguments, describe the modes, resolve the tool and the summary", () => {
	assert.deepEqual(COMPACT_MODES, ["control", "experimental", "off"]);
	assert.deepEqual(MODE_CHOICES.map((choice) => choice.mode), ["control", "experimental", "off"]);
	// The picker labels are what `ui.select` returns and what the argument parser accepts.
	assert.deepEqual(MODE_CHOICES.map((choice) => choice.label), ["Control", "Experimental", "Off"]);
	for (const choice of MODE_CHOICES) assert.equal(parseMode(choice.label), choice.mode, `${choice.label} round-trips`);

	assert.equal(parseMode(" Control "), "control");
	assert.equal(parseMode("a"), "control");
	assert.equal(parseMode("B"), "experimental");
	assert.equal(parseMode("experiment"), "experimental");
	assert.equal(parseMode("OFF"), "off");
	assert.equal(parseMode("none"), "off");
	assert.equal(parseMode(""), undefined);
	assert.equal(parseMode("self_compact"), undefined);
	assert.equal(parseMode("control please"), undefined);

	assert.equal(modeToolName("control"), CONTROL_TOOL_NAME);
	assert.equal(modeToolName("experimental"), EXPERIMENTAL_TOOL_NAME);
	assert.equal(modeToolName("off"), undefined, "off activates no variant tool");

	// `off` is the only mode whose summary promises native compaction and no lock.
	assert.match(modeSummary("off"), /native Pi compaction is restored/);
	assert.match(modeSummary("off"), /no lock/);
	assert.match(modeSummary("control"), new RegExp(`only ${CONTROL_TOOL_NAME} is active`));
	assert.match(modeSummary("experimental"), new RegExp(`only ${EXPERIMENTAL_TOOL_NAME} is active`));
});

test("bootstrap is flag-driven: control by default, experimental only when the flag asks for it", () => {
	assert.equal(bootstrapMode(false), "control");
	assert.equal(bootstrapMode(true), "experimental");
	assert.equal(bootstrapMode(false), "control", "the plain default never asks for variant B");
});
