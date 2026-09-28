import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
	THINKING_BINDING_BETA,
	addThinkingBindingBeta,
	withThinkingBindingFallback,
} from "./index.ts";

describe("Sonnet 5.5 compatibility", () => {
	it("appends the binding beta without replacing existing Anthropic betas", () => {
		const headers: Record<string, string | null> = {
			"Anthropic-Beta": "claude-code-20250219,oauth-2025-04-20",
		};

		addThinkingBindingBeta(headers);

		assert.equal(
			headers["Anthropic-Beta"],
			`claude-code-20250219,oauth-2025-04-20,${THINKING_BINDING_BETA}`,
		);
		assert.equal(headers["anthropic-beta"], undefined);
	});

	it("does not duplicate the binding beta", () => {
		const headers: Record<string, string | null> = {
			"anthropic-beta": THINKING_BINDING_BETA,
		};

		addThinkingBindingBeta(headers);

		assert.equal(headers["anthropic-beta"], THINKING_BINDING_BETA);
	});

	it("adds the drop-block fallback to adaptive thinking", () => {
		assert.deepEqual(
			withThinkingBindingFallback({
				model: "claude-sonnet-5-5",
				thinking: { type: "adaptive", display: "summarized" },
			}),
			{
				model: "claude-sonnet-5-5",
				thinking: {
					type: "adaptive",
					display: "summarized",
					block_binding: { prefix_mismatch_behavior: "drop_block" },
				},
			},
		);
	});

	it("leaves non-adaptive payloads untouched", () => {
		const payload = { thinking: { type: "enabled", budget_tokens: 1024 } };
		assert.equal(withThinkingBindingFallback(payload), payload);
	});
});
