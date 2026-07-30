/**
 * ask_user - Lets the model ask a single multiple-choice question.
 *
 * - 2 to 5 model-provided options, plus an always-present "Write my own answer" option
 * - Popup UI: arrow keys or number keys to pick, Enter to confirm
 * - "Write my own answer" opens an inline editor (Esc returns to the options)
 * - Esc on the options dismisses the question (the model is told you declined)
 *
 * Ported from https://github.com/davis7dotsh/my-pi-setup/tree/main/extensions/ask-user
 * with one change: upstream pulls in `effect` (a 4.x beta) purely to bridge pi's
 * AbortSignal into the UI promise and to tell interruption apart from a real failure.
 * Both are a few lines of AbortController here, so this port keeps pi-pack free of a
 * beta dependency. Behavior and UX are otherwise identical.
 *
 * Dismissal and cancellation are deliberately distinct outcomes: Esc means "the user
 * declined to answer" (the model must not invent an answer), while an aborted turn just
 * means the question never got a chance to be answered.
 */

import { Type } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Editor, type EditorTheme, Key, matchesKey, Text, truncateToWidth } from "@earendil-works/pi-tui";
import {
	ASK_USER_PARAMETER_DESCRIPTIONS,
	ASK_USER_PROMPT_GUIDELINES,
	ASK_USER_PROMPT_SNIPPET,
	ASK_USER_TOOL_DESCRIPTION,
	buildAskUserResultMessage,
} from "./prompt.ts";

const MIN_OPTIONS = 2;
const MAX_OPTIONS = 5;

const OptionSchema = Type.Object({
	label: Type.String({ description: ASK_USER_PARAMETER_DESCRIPTIONS.optionLabel }),
	description: Type.Optional(Type.String({ description: ASK_USER_PARAMETER_DESCRIPTIONS.optionDescription })),
});

const AskUserParams = Type.Object({
	question: Type.String({ description: ASK_USER_PARAMETER_DESCRIPTIONS.question }),
	options: Type.Array(OptionSchema, {
		minItems: MIN_OPTIONS,
		maxItems: MAX_OPTIONS,
		description: ASK_USER_PARAMETER_DESCRIPTIONS.options,
	}),
});

interface AskUserDetails {
	question: string;
	options: string[];
	answer: string | null;
	wasCustom: boolean;
	cancelled: boolean;
}

type SelectionResult = { answer: string; wasCustom: boolean; index?: number } | null;

interface DisplayOption {
	label: string;
	description?: string;
	isOther?: boolean;
}

function wrapText(text: string, width: number): string[] {
	const lines: string[] = [];
	for (const paragraph of text.split("\n")) {
		const words = paragraph.split(/\s+/).filter(Boolean);
		if (words.length === 0) {
			lines.push("");
			continue;
		}
		let current = "";
		for (const word of words) {
			const candidate = current ? `${current} ${word}` : word;
			if (candidate.length > width && current) {
				lines.push(current);
				current = word;
			} else {
				current = candidate;
			}
		}
		if (current) lines.push(current);
	}
	return lines;
}

export default function askUser(pi: ExtensionAPI) {
	pi.registerTool({
		name: "ask_user",
		label: "Ask User",
		description: ASK_USER_TOOL_DESCRIPTION,
		promptSnippet: ASK_USER_PROMPT_SNIPPET,
		promptGuidelines: ASK_USER_PROMPT_GUIDELINES,
		parameters: AskUserParams,
		// The UI takes over the editor, so it must not race other tool calls.
		executionMode: "sequential",

		async execute(_toolCallId, params, signal, _onUpdate, ctx) {
			const reply = (text: string, answer: string | null = null, wasCustom = false) => ({
				content: [{ type: "text" as const, text }],
				details: {
					question: params.question,
					options: params.options.map((o) => o.label),
					answer,
					wasCustom,
					cancelled: answer === null,
				} satisfies AskUserDetails,
			});

			// Schema minItems/maxItems are advisory to the model, so enforce them here too.
			if (params.options.length < MIN_OPTIONS || params.options.length > MAX_OPTIONS) {
				throw new Error(
					`ask_user requires between ${MIN_OPTIONS} and ${MAX_OPTIONS} options (got ${params.options.length}). Retry with a valid number of options.`,
				);
			}

			if (ctx.mode !== "tui") {
				return reply(buildAskUserResultMessage({ kind: "no-ui" }));
			}

			if (signal?.aborted) {
				return reply(buildAskUserResultMessage({ kind: "cancelled" }));
			}

			const allOptions: DisplayOption[] = [...params.options, { label: "Write my own answer…", isOther: true }];

			const showQuestion = (uiSignal: AbortSignal) =>
				ctx.ui.custom<SelectionResult>((tui, theme, _kb, done) => {
					let optionIndex = 0;
					let editMode = false;
					let cachedLines: string[] | undefined;
					let settled = false;

					function finish(result: SelectionResult) {
						if (settled) return;
						settled = true;
						uiSignal.removeEventListener("abort", cancel);
						done(result);
					}

					function cancel() {
						finish(null);
					}

					uiSignal.addEventListener("abort", cancel, { once: true });
					if (uiSignal.aborted) queueMicrotask(cancel);

					const editorTheme: EditorTheme = {
						borderColor: (s) => theme.fg("accent", s),
						selectList: {
							selectedPrefix: (t) => theme.fg("accent", t),
							selectedText: (t) => theme.fg("accent", t),
							description: (t) => theme.fg("muted", t),
							scrollInfo: (t) => theme.fg("dim", t),
							noMatch: (t) => theme.fg("warning", t),
						},
					};
					const editor = new Editor(tui, editorTheme);

					editor.onSubmit = (value) => {
						const trimmed = value.trim();
						if (trimmed) {
							finish({ answer: trimmed, wasCustom: true });
						} else {
							editMode = false;
							editor.setText("");
							refresh();
						}
					};

					function refresh() {
						cachedLines = undefined;
						tui.requestRender();
					}

					function selectOption(index: number) {
						const selected = allOptions[index];
						if (selected.isOther) {
							optionIndex = index;
							editMode = true;
							refresh();
						} else {
							finish({ answer: selected.label, wasCustom: false, index: index + 1 });
						}
					}

					function handleInput(data: string) {
						if (editMode) {
							if (matchesKey(data, Key.escape)) {
								editMode = false;
								editor.setText("");
								refresh();
								return;
							}
							editor.handleInput(data);
							refresh();
							return;
						}

						if (matchesKey(data, Key.up)) {
							optionIndex = (optionIndex - 1 + allOptions.length) % allOptions.length;
							refresh();
							return;
						}
						if (matchesKey(data, Key.down)) {
							optionIndex = (optionIndex + 1) % allOptions.length;
							refresh();
							return;
						}

						// Number keys jump straight to an option
						if (data.length === 1 && data >= "1" && data <= String(allOptions.length)) {
							selectOption(Number(data) - 1);
							return;
						}

						if (matchesKey(data, Key.enter)) {
							selectOption(optionIndex);
							return;
						}

						if (matchesKey(data, Key.escape)) {
							finish(null);
						}
					}

					function render(width: number): string[] {
						if (cachedLines) return cachedLines;

						const lines: string[] = [];
						const add = (s: string) => lines.push(truncateToWidth(s, width));

						const title = " Question ";
						add(theme.fg("accent", `─${title}${"─".repeat(Math.max(0, width - title.length - 1))}`));
						for (const line of wrapText(params.question, Math.max(10, width - 2))) {
							add(` ${theme.fg("text", theme.bold(line))}`);
						}
						lines.push("");

						for (let i = 0; i < allOptions.length; i++) {
							const opt = allOptions[i];
							const selected = i === optionIndex;
							const prefix = selected ? theme.fg("accent", " ❯ ") : "   ";
							const marker = opt.isOther ? "✎" : `${i + 1}.`;
							const label = `${marker} ${opt.label}`;

							if (selected || (opt.isOther && editMode)) {
								add(prefix + theme.fg("accent", label));
							} else {
								add(prefix + theme.fg(opt.isOther ? "muted" : "text", label));
							}

							if (opt.description) {
								add(`      ${theme.fg("muted", opt.description)}`);
							}
						}

						if (editMode) {
							lines.push("");
							add(theme.fg("muted", " Your answer:"));
							for (const line of editor.render(width - 2)) {
								add(` ${line}`);
							}
						}

						lines.push("");
						if (editMode) {
							add(theme.fg("dim", " Enter submit • Esc back to options"));
						} else {
							add(theme.fg("dim", ` ↑↓ or 1-${allOptions.length} select • Enter confirm • Esc dismiss`));
						}
						add(theme.fg("accent", "─".repeat(width)));

						cachedLines = lines;
						return lines;
					}

					return {
						render,
						invalidate: () => {
							cachedLines = undefined;
						},
						handleInput,
						dispose: () => {
							uiSignal.removeEventListener("abort", cancel);
						},
					};
				});

			// Bridge pi's turn-level signal into the component so an aborted turn tears the
			// popup down instead of leaving it waiting on input forever.
			const controller = new AbortController();
			const forwardAbort = () => controller.abort();
			signal?.addEventListener("abort", forwardAbort, { once: true });

			let result: SelectionResult;
			try {
				result = await showQuestion(controller.signal);
			} finally {
				signal?.removeEventListener("abort", forwardAbort);
			}

			// A null result means Esc *or* abort; the signal is what distinguishes them.
			if (!result) {
				return reply(buildAskUserResultMessage({ kind: signal?.aborted ? "cancelled" : "dismissed" }));
			}

			if (result.wasCustom) {
				return reply(buildAskUserResultMessage({ kind: "custom", answer: result.answer }), result.answer, true);
			}

			return reply(
				buildAskUserResultMessage({ kind: "selected", answer: result.answer, index: result.index }),
				result.answer,
			);
		},

		renderCall(args, theme, _context) {
			let text = theme.fg("toolTitle", theme.bold("ask_user "));
			text += theme.fg("muted", typeof args.question === "string" ? args.question : "");
			const opts = Array.isArray(args.options) ? (args.options as DisplayOption[]) : [];
			if (opts.length > 0) {
				const numbered = opts.map((o, i) => `${i + 1}. ${o.label}`);
				text += `\n${theme.fg("dim", `  ${numbered.join("  ")}`)}`;
			}
			return new Text(text, 0, 0);
		},

		renderResult(result, _options, theme, _context) {
			const details = result.details as AskUserDetails | undefined;
			if (!details) {
				const first = result.content[0];
				return new Text(first?.type === "text" ? first.text : "", 0, 0);
			}

			if (details.cancelled || details.answer === null) {
				return new Text(theme.fg("warning", "✗ dismissed"), 0, 0);
			}

			if (details.wasCustom) {
				return new Text(
					theme.fg("success", "✓ ") + theme.fg("muted", "(wrote) ") + theme.fg("accent", details.answer),
					0,
					0,
				);
			}

			const idx = details.options.indexOf(details.answer) + 1;
			const display = idx > 0 ? `${idx}. ${details.answer}` : details.answer;
			return new Text(theme.fg("success", "✓ ") + theme.fg("accent", display), 0, 0);
		},
	});
}
