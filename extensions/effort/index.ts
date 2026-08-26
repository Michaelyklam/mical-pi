import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import { getSupportedThinkingLevels, type Api, type Model } from "@earendil-works/pi-ai";
import { CustomEditor, DynamicBorder, type ExtensionAPI, type Theme } from "@earendil-works/pi-coding-agent";
import {
	Container,
	type RgbColor,
	type SelectItem,
	SelectList,
	sliceByColumn,
	truncateToWidth,
	visibleWidth,
} from "@earendil-works/pi-tui";
import { FAST_MODE_STATUS_EVENT, type FastModeStatus } from "../shared/fast-mode-status.ts";

const EFFORT_DESCRIPTIONS: Record<ThinkingLevel, string> = {
	off: "No reasoning",
	minimal: "Very brief reasoning",
	low: "Light reasoning",
	medium: "Moderate reasoning",
	high: "Deep reasoning",
	xhigh: "Extra-high reasoning",
	max: "Maximum reasoning",
};

export function getAvailableEffortLevels(model: Model<Api> | undefined): ThinkingLevel[] {
	if (!model) return [];
	return getSupportedThinkingLevels(model) as ThinkingLevel[];
}

export function getEffortSelectItems(availableLevels: readonly ThinkingLevel[]): SelectItem[] {
	return availableLevels.map((level) => ({
		value: level,
		label: level,
		description: EFFORT_DESCRIPTIONS[level],
	}));
}

export function getEffortGradientPosition(
	availableLevels: readonly ThinkingLevel[],
	currentLevel: ThinkingLevel,
): number {
	if (availableLevels.length <= 1) return 0;
	const index = availableLevels.indexOf(currentLevel);
	return Math.max(0, index) / (availableLevels.length - 1);
}

/** Map the model's supported effort range onto a green-to-red hue gradient. */
export function getEffortBorderRgb(
	availableLevels: readonly ThinkingLevel[],
	currentLevel: ThinkingLevel,
): RgbColor {
	const position = getEffortGradientPosition(availableLevels, currentLevel);
	const hue = 120 * (1 - position);
	const saturation = 0.85;
	const value = 0.85;
	const chroma = value * saturation;
	const hueSection = hue / 60;
	const secondary = chroma * (1 - Math.abs((hueSection % 2) - 1));
	const offset = value - chroma;
	const [red, green, blue] = hueSection < 1
		? [chroma, secondary, 0]
		: [secondary, chroma, 0];
	return {
		r: Math.round((red + offset) * 255),
		g: Math.round((green + offset) * 255),
		b: Math.round((blue + offset) * 255),
	};
}

export function effortDisplayName(level: ThinkingLevel): string {
	return level === "xhigh" ? "XHigh" : `${level[0].toUpperCase()}${level.slice(1)}`;
}

export function labelEditorTopBorder(
	topBorder: string,
	width: number,
	modelId: string,
	currentLevel: ThinkingLevel,
	fastModeActive: boolean,
	colorize: (text: string) => string,
): string {
	const effort = effortDisplayName(currentLevel);
	const status = fastModeActive ? `${effort} · fast` : effort;
	const suffix = ` · ${status}`;
	const contentWidth = Math.max(0, width - 2);
	const content = visibleWidth(suffix) >= contentWidth
		? truncateToWidth(status, contentWidth, "")
		: `${truncateToWidth(modelId, contentWidth - visibleWidth(suffix), "…")}${suffix}`;
	const label = truncateToWidth(` ${content} `, width, "");
	const prefixWidth = Math.max(0, width - visibleWidth(label));
	return `${sliceByColumn(topBorder, 0, prefixWidth)}${colorize(label)}`;
}

function rgbColorizer(theme: Theme, color: RgbColor): (text: string) => string {
	const prefix = theme.getColorMode() === "truecolor"
		? `\x1b[38;2;${color.r};${color.g};${color.b}m`
		: `\x1b[38;5;${16 + 36 * Math.round(color.r / 51) + 6 * Math.round(color.g / 51) + Math.round(color.b / 51)}m`;
	return (text: string) => `${prefix}${text}\x1b[39m`;
}

export default function effortExtension(pi: ExtensionAPI) {
	let fastModeActive = false;
	let requestEditorRender: (() => void) | undefined;

	pi.events.on(FAST_MODE_STATUS_EVENT, (data) => {
		const active = (data as FastModeStatus | undefined)?.active;
		if (typeof active !== "boolean") return;
		fastModeActive = active;
		requestEditorRender?.();
	});

	pi.on("session_start", (_event, ctx) => {
		if (ctx.mode !== "tui") return;
		ctx.ui.setEditorComponent((tui, editorTheme, keybindings) => {
			requestEditorRender = () => tui.requestRender();
			return new class extends CustomEditor {
				override render(width: number): string[] {
					const currentLevel = pi.getThinkingLevel();
					const availableLevels = getAvailableEffortLevels(ctx.model);
					const effortColor = rgbColorizer(
						ctx.ui.theme,
						getEffortBorderRgb(availableLevels, currentLevel),
					);
					const inheritedBorderColor = this.borderColor;
					const bashBorderColor = ctx.ui.theme.getBashModeBorderColor();
					const activeBorderColor = inheritedBorderColor("─") === bashBorderColor("─")
						? inheritedBorderColor
						: effortColor;

					this.borderColor = activeBorderColor;
					let lines: string[];
					try {
						lines = super.render(width);
					} finally {
						this.borderColor = inheritedBorderColor;
					}
					if (lines[0]) {
						lines[0] = labelEditorTopBorder(
							lines[0],
							width,
							ctx.model?.id ?? "no-model",
							currentLevel,
							fastModeActive,
							activeBorderColor,
						);
					}
					return lines;
				}
			}(tui, editorTheme, keybindings);
		});
	});

	pi.on("session_shutdown", () => {
		requestEditorRender = undefined;
	});

	pi.registerCommand("effort", {
		description: "Select the reasoning effort for the current model",
		handler: async (args, ctx) => {
			const model = ctx.model;
			if (!model) {
				ctx.ui.notify("Select a model before choosing an effort level", "warning");
				return;
			}

			const availableLevels = getAvailableEffortLevels(model);
			const requestedLevel = args.trim().toLowerCase();

			if (requestedLevel) {
				if (!availableLevels.includes(requestedLevel as ThinkingLevel)) {
					ctx.ui.notify(
						`Effort "${requestedLevel}" is unavailable for ${model.provider}/${model.id}. Available: ${availableLevels.join(", ")}`,
						"warning",
					);
					return;
				}

				pi.setThinkingLevel(requestedLevel as ThinkingLevel);
				ctx.ui.notify(`Effort set to ${requestedLevel}`, "info");
				return;
			}

			if (ctx.mode !== "tui") {
				ctx.ui.notify(
					`Available effort levels for ${model.provider}/${model.id}: ${availableLevels.join(", ")}`,
					"info",
				);
				return;
			}

			const selectedLevel = await ctx.ui.custom<ThinkingLevel | null>((tui, theme, _keybindings, done) => {
				const items = getEffortSelectItems(availableLevels);
				const container = new Container();
				container.addChild(new DynamicBorder((text: string) => theme.fg("accent", text)));

				const selectList = new SelectList(items, items.length, {
					selectedPrefix: (text) => theme.fg("accent", text),
					selectedText: (text) => theme.fg("accent", text),
					description: (text) => theme.fg("muted", text),
					scrollInfo: (text) => theme.fg("dim", text),
					noMatch: (text) => theme.fg("warning", text),
				}, {
					minPrimaryColumnWidth: 12,
					maxPrimaryColumnWidth: 32,
				});
				const currentIndex = availableLevels.indexOf(pi.getThinkingLevel());
				if (currentIndex >= 0) selectList.setSelectedIndex(currentIndex);
				selectList.onSelect = (item) => done(item.value as ThinkingLevel);
				selectList.onCancel = () => done(null);

				container.addChild(selectList);
				container.addChild(new DynamicBorder((text: string) => theme.fg("accent", text)));

				return {
					render: (width: number) => container.render(width),
					invalidate: () => container.invalidate(),
					handleInput: (data: string) => {
						selectList.handleInput(data);
						tui.requestRender();
					},
				};
			});

			if (selectedLevel) {
				pi.setThinkingLevel(selectedLevel);
				ctx.ui.notify(`Effort set to ${selectedLevel}`, "info");
			}
		},
	});
}
