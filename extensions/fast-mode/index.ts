import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

const STATE_ENTRY = "openai-fast-mode";
const TARGET_PROVIDERS = new Set(["openai", "openai-codex"]);

function supportsFastMode(ctx: ExtensionContext): boolean {
	return Boolean(
		ctx.model && TARGET_PROVIDERS.has(ctx.model.provider) && /^gpt-5\.6(?:-|$)/.test(ctx.model.id),
	);
}

function withFastMode(payload: unknown): unknown {
	if (!payload || typeof payload !== "object" || Array.isArray(payload)) return payload;
	return { ...payload, service_tier: "priority" };
}

export default function (pi: ExtensionAPI) {
	let enabled = false;

	function updateStatus(ctx: ExtensionContext): void {
		ctx.ui.setStatus("openai-fast-mode", enabled && supportsFastMode(ctx) ? "⚡ fast" : undefined);
	}

	pi.on("session_start", (_event, ctx) => {
		enabled = false;
		for (const entry of ctx.sessionManager.getBranch()) {
			if (entry.type === "custom" && entry.customType === STATE_ENTRY) {
				enabled = Boolean((entry.data as { enabled?: boolean } | undefined)?.enabled);
			}
		}
		updateStatus(ctx);
	});

	pi.on("model_select", (_event, ctx) => updateStatus(ctx));

	pi.on("before_provider_request", (event, ctx) => {
		if (!enabled || !supportsFastMode(ctx)) return;
		return withFastMode(event.payload);
	});

	pi.registerCommand("fast", {
		description: "Toggle OpenAI Fast mode for GPT-5.6",
		handler: async (args, ctx) => {
			const action = args.trim().toLowerCase();
			if (action && !["on", "off", "status"].includes(action)) {
				ctx.ui.notify("Usage: /fast [on|off|status]", "warning");
				return;
			}

			if (action !== "status") {
				enabled = action === "on" ? true : action === "off" ? false : !enabled;
				pi.appendEntry(STATE_ENTRY, { enabled });
			}

			updateStatus(ctx);
			const model = ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : "no model";
			const applicability = supportsFastMode(ctx) ? "" : `; inactive for ${model}`;
			ctx.ui.notify(`OpenAI Fast mode ${enabled ? "on" : "off"}${applicability}`, enabled ? "info" : "warning");
		},
	});
}
