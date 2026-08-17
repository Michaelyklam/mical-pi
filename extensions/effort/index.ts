import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import { getSupportedThinkingLevels, type Api, type Model } from "@earendil-works/pi-ai";
import { ThinkingSelectorComponent, type ExtensionAPI } from "@earendil-works/pi-coding-agent";

export function getAvailableEffortLevels(model: Model<Api> | undefined): ThinkingLevel[] {
	if (!model) return [];
	return getSupportedThinkingLevels(model) as ThinkingLevel[];
}

export default function effortExtension(pi: ExtensionAPI) {
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

			const selectedLevel = await ctx.ui.custom<ThinkingLevel | null>((tui, _theme, _keybindings, done) => {
				const selector = new ThinkingSelectorComponent(
					pi.getThinkingLevel(),
					availableLevels,
					done,
					() => done(null),
				);
				const selectList = selector.getSelectList();

				return {
					render: (width: number) => selector.render(width),
					invalidate: () => selector.invalidate(),
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
