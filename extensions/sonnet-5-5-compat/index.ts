import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

const TARGET_PROVIDER = "anthropic";
const TARGET_MODEL = "claude-sonnet-5-5";
export const THINKING_BINDING_BETA = "thinking-binding-controls-2026-08-01";

type JsonObject = Record<string, unknown>;
type MutableHeaders = Record<string, string | null>;

function isObject(value: unknown): value is JsonObject {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function isDirectSonnet55(ctx: Pick<ExtensionContext, "model">): boolean {
	return ctx.model?.provider === TARGET_PROVIDER && ctx.model.id === TARGET_MODEL;
}

export function addThinkingBindingBeta(headers: MutableHeaders): void {
	const existingKey = Object.keys(headers).find((key) => key.toLowerCase() === "anthropic-beta");
	const key = existingKey ?? "anthropic-beta";
	const features = new Set(
		typeof headers[key] === "string"
			? headers[key]
					.split(",")
					.map((feature) => feature.trim())
					.filter(Boolean)
			: [],
	);
	features.add(THINKING_BINDING_BETA);
	headers[key] = [...features].join(",");
}

export function withThinkingBindingFallback(payload: unknown): unknown {
	if (!isObject(payload) || !isObject(payload.thinking) || payload.thinking.type !== "adaptive") {
		return payload;
	}

	const existingBinding = isObject(payload.thinking.block_binding)
		? payload.thinking.block_binding
		: {};

	return {
		...payload,
		thinking: {
			...payload.thinking,
			block_binding: {
				...existingBinding,
				prefix_mismatch_behavior: "drop_block",
			},
		},
	};
}

export default function (pi: ExtensionAPI) {
	pi.on("before_provider_headers", (event, ctx) => {
		if (isDirectSonnet55(ctx)) addThinkingBindingBeta(event.headers);
	});

	pi.on("before_provider_request", (event, ctx) => {
		if (!isDirectSonnet55(ctx)) return;
		return withThinkingBindingFallback(event.payload);
	});
}
