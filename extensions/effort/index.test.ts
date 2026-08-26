import assert from "node:assert/strict";
import test from "node:test";
import type { Api, Model } from "@earendil-works/pi-ai";
import {
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
