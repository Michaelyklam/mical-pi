import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

/**
 * Familiar aliases for Pi's built-in session commands.
 *
 * `/clear` intentionally calls ExtensionCommandContext.newSession() instead of
 * mutating SessionManager. That is Pi's supported replacement flow: it emits
 * session_before_switch, allows cancellation, shuts down the old extension
 * runtime, starts a fresh session, and reloads resources exactly like `/new`.
 */
export default function sessionAliases(pi: ExtensionAPI) {
	pi.registerCommand("clear", {
		description: "Start a new session (alias for /new)",
		handler: async (args, ctx) => {
			if (args.trim().length > 0) {
				ctx.ui.notify("Usage: /clear", "warning");
				return;
			}

			await ctx.newSession({
				// Session replacement invalidates the command's original ctx. Any
				// post-switch UI work must use the fresh context passed here.
				withSession: async (newCtx) => {
					if (newCtx.hasUI) newCtx.ui.notify("New session started", "info");
				},
			});
		},
	});
}
