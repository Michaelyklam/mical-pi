import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { formatMcpHealth, MCP_STATUS_EVENT, STATUS_KEY } from "./status.ts";

/**
 * Shows an MCP footer entry only when a server is unhealthy, naming it.
 *
 * pi-mcp-adapter's own footer is separate and stays on its "mcp" key; set
 * `settings.mcpFooterStatus: "off"` in the MCP config so the two do not both render.
 * The adapter publishes its snapshot before honouring that setting, so turning its
 * footer off does not stop the events this extension depends on.
 */
export default function mcpHealth(pi: ExtensionAPI) {
	// The event bus hands us data with no context, and a snapshot can arrive before
	// the first session_start. Hold the latest one and render when both are ready.
	let latest: unknown;
	let ctx: ExtensionContext | undefined;

	const render = () => {
		if (!ctx || ctx.mode !== "tui") return;
		const text = formatMcpHealth(latest);
		ctx.ui.setStatus(STATUS_KEY, text === undefined ? undefined : (ctx.ui.theme?.fg("warning", text) ?? text));
	};

	pi.events.on(MCP_STATUS_EVENT, (snapshot: unknown) => {
		latest = snapshot;
		render();
	});

	pi.on("session_start", (_event, context) => {
		ctx = context;
		render();
	});
}
