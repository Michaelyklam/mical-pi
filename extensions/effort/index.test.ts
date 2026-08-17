import assert from "node:assert/strict";
import test from "node:test";
import type { Api, Model } from "@earendil-works/pi-ai";
import { getAvailableEffortLevels } from "./index.ts";

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
