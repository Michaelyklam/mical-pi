import assert from "node:assert/strict";
import test from "node:test";
import type { Api, Model } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import effortExtension, {
	matchEffortLevels,
	effortDisplayName,
	getAvailableEffortLevels,
	getEffortBorderRgb,
	getEffortGradientPosition,
	getEffortSelectItems,
	labelEditorTopBorder,
} from "./index.ts";

function model(overrides: Partial<Model<Api>> = {}): Model<Api> {
	return {
		id: "test-model",
		name: "Test model",
		api: "openai-responses",
		provider: "test-provider",
		baseUrl: "https://example.com",
		reasoning: true,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 128_000,
		maxTokens: 16_384,
		...overrides,
	};
}

test("matches every effort level exactly and tolerates common typos", () => {
	for (const level of ["off", "minimal", "low", "medium", "high", "xhigh", "max"]) {
		assert.deepEqual(matchEffortLevels(` ${level.toUpperCase()} `), [level]);
	}
	for (const [input, expected] of Object.entries({
		off: "off", of: "off", minmal: "minimal", lwo: "low", meduim: "medium",
		hihg: "high", hgh: "high", higgh: "high", higg: "high", xhihg: "xhigh", mxa: "max",
		hi: "high", med: "medium",
	})) {
		assert.deepEqual(matchEffortLevels(input), [expected], input);
	}
	assert.deepEqual(matchEffortLevels("m"), ["minimal", "medium", "max"]);
	for (const input of ["", "   ", "banana", "high low", "z", "a".repeat(1000)]) {
		assert.deepEqual(matchEffortLevels(input), [], input);
	}
});

function commandHarness(selectedModel: Model<Api> | undefined = model()) {
	let command!: Parameters<ExtensionAPI["registerCommand"]>[1];
	const changes: string[] = [];
	const notices: string[] = [];
	let pickerCalls = 0;
	const handlers = new Map<string, (event: unknown, ctx: ExtensionCommandContext) => void>();
	const pi = {
		events: { on() {} },
		on: (event: string, handler: (event: unknown, ctx: ExtensionCommandContext) => void) => handlers.set(event, handler),
		registerCommand: (name: string, registered: typeof command) => {
			assert.equal(name, "effort");
			command = registered;
		},
		setThinkingLevel: (level: string) => changes.push(level),
	} as unknown as ExtensionAPI;
	const ctx = {
		model: selectedModel,
		mode: "rpc",
		ui: {
			notify: (text: string) => notices.push(text),
			custom: async () => { pickerCalls++; return null; },
		},
	} as unknown as ExtensionCommandContext;
	effortExtension(pi);
	handlers.get("session_start")!({}, ctx);
	return { command, ctx, changes, notices, handlers, pickerCalls: () => pickerCalls };
}

test("inline effort commands set the level without opening a picker", async () => {
	const h = commandHarness(model({ thinkingLevelMap: { xhigh: "xhigh", max: "max" } }));
	h.ctx.mode = "tui";
	for (const level of ["off", "minimal", "low", "medium", "high", "xhigh", "max", "hihg", "MED"]) {
		await h.command.handler(level, h.ctx);
	}
	assert.deepEqual(h.changes, ["off", "minimal", "low", "medium", "high", "xhigh", "max", "high", "medium"]);
	assert.equal(h.pickerCalls(), 0);
	assert.equal(h.notices.at(-2), "Effort set to high");
});

test("invalid, ambiguous, and unsupported effort leave the setting unchanged", async () => {
	const h = commandHarness();
	for (const input of ["banana", "m", "xhigh", "xhihg", "max"]) {
		await h.command.handler(input, h.ctx);
	}
	assert.deepEqual(h.changes, []);
	assert.match(h.notices[0], /Unknown effort/);
	assert.match(h.notices[1], /ambiguous/);
	assert.match(h.notices[2], /unavailable/);
	const missing = commandHarness();
	missing.ctx.model = undefined;
	await missing.command.handler("high", missing.ctx);
	assert.deepEqual(missing.changes, []);
	assert.match(missing.notices[0], /Select a model/);
});

test("bare effort keeps the TUI picker and non-TUI level listing", async () => {
	const h = commandHarness();
	await h.command.handler("  ", h.ctx);
	assert.match(h.notices[0], /Available effort levels/);
	h.ctx.mode = "tui";
	await h.command.handler("", h.ctx);
	assert.equal(h.pickerCalls(), 1);
	assert.deepEqual(h.changes, []);
});

test("completions match prefixes and typos and follow model capabilities", async () => {
	const h = commandHarness();
	const complete = async (input: string) => (await h.command.getArgumentCompletions!(input))?.map((item) => item.value) ?? [];
	assert.deepEqual(await complete(""), ["off", "minimal", "low", "medium", "high"]);
	assert.deepEqual(await complete("m"), ["minimal", "medium"]);
	assert.deepEqual(await complete("hihg"), ["high"]);
	assert.deepEqual(await complete("banana"), []);
	assert.deepEqual(await complete("xhigh"), []);
	h.ctx.model = model({ reasoning: false });
	h.handlers.get("model_select")!({}, h.ctx);
	assert.deepEqual(await complete(""), ["off"]);
});

test("returns only off for a model without reasoning", () => {
	assert.deepEqual(getAvailableEffortLevels(model({ reasoning: false })), ["off"]);
});

test("returns the standard levels for a reasoning model", () => {
	assert.deepEqual(getAvailableEffortLevels(model()), ["off", "minimal", "low", "medium", "high"]);
});

test("honors unsupported and extended levels from model metadata", () => {
	assert.deepEqual(
		getAvailableEffortLevels(
			model({
				thinkingLevelMap: {
					off: null,
					minimal: null,
					low: "low",
					medium: null,
					high: "high",
					xhigh: null,
					max: "max",
				},
			}),
		),
		["low", "high", "max"],
	);
});

test("returns no levels when no model is selected", () => {
	assert.deepEqual(getAvailableEffortLevels(undefined), []);
});

test("effort choices describe intensity without token estimates", () => {
	const items = getEffortSelectItems(["off", "minimal", "low", "medium", "high", "xhigh", "max"]);
	assert.deepEqual(items.map((item) => item.description), [
		"No reasoning",
		"Very brief reasoning",
		"Light reasoning",
		"Moderate reasoning",
		"Deep reasoning",
		"Extra-high reasoning",
		"Maximum reasoning",
	]);
	assert.ok(items.every((item) => !/tokens?|~\d/i.test(item.description ?? "")));
});

test("effort colors span each model's supported range", () => {
	const levels = ["low", "medium", "high"] as const;
	assert.equal(getEffortGradientPosition(levels, "low"), 0);
	assert.equal(getEffortGradientPosition(levels, "medium"), 0.5);
	assert.equal(getEffortGradientPosition(levels, "high"), 1);
	assert.deepEqual(getEffortBorderRgb(levels, "low"), { r: 33, g: 217, b: 33 });
	assert.deepEqual(getEffortBorderRgb(levels, "medium"), { r: 217, g: 217, b: 33 });
	assert.deepEqual(getEffortBorderRgb(levels, "high"), { r: 217, g: 33, b: 33 });
});

test("effort colors interpolate over however many levels the model supports", () => {
	const levels = ["off", "low", "high", "max"] as const;
	assert.deepEqual(getEffortBorderRgb(levels, "off"), { r: 33, g: 217, b: 33 });
	assert.deepEqual(getEffortBorderRgb(levels, "low"), { r: 155, g: 217, b: 33 });
	assert.deepEqual(getEffortBorderRgb(levels, "high"), { r: 217, g: 155, b: 33 });
	assert.deepEqual(getEffortBorderRgb(levels, "max"), { r: 217, g: 33, b: 33 });
	assert.deepEqual(getEffortBorderRgb(["off"], "off"), { r: 33, g: 217, b: 33 });
});

test("the editor border shows model, effort, and fast mode", () => {
	const border = labelEditorTopBorder("─".repeat(32), 32, "gpt-5.6-sol", "high", true, (text) => text);
	assert.equal(border, "───── gpt-5.6-sol · High · fast ");
	assert.equal(border.length, 32);
	assert.equal(effortDisplayName("xhigh"), "XHigh");
});

test("the editor border truncates the model before effort status", () => {
	const border = labelEditorTopBorder("─".repeat(22), 22, "gpt-5.6-sol", "high", true, (text) => text);
	const plain = border.replaceAll(/\x1b\[[0-9;]*m/g, "");
	assert.equal(plain, " gpt-5… · High · fast ");
	assert.equal(plain.length, 22);
});
