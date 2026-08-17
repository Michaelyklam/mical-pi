/**
 * Formats the MCP footer status: silent when every server is healthy, naming the
 * offenders when they are not.
 *
 * The snapshot arrives over pi's shared event bus from pi-mcp-adapter
 * (channel "pi-mcp-adapter/status/v1"). It is another extension's payload, so it
 * is validated structurally rather than trusted.
 */

export const MCP_STATUS_EVENT = "pi-mcp-adapter/status/v1";

/** Our own footer key. Must not collide with the adapter's own "mcp" key. */
export const STATUS_KEY = "mcp-health";

/**
 * States that are NOT worth interrupting the user about.
 *
 * - `connected`  - live.
 * - `cached`     - tool metadata is cached and the server dials on first use.
 *                  This is the normal resting state under lazy connect, not a fault.
 * - `not-connected` - idle, nothing cached yet. Also normal.
 * - `disabled`   - switched off deliberately.
 *
 * Anything else is reported. Matching on healthy states rather than on a list of
 * failure states is deliberate: if the adapter adds or renames a failure status,
 * an unknown value surfaces in the footer instead of being silently swallowed.
 * A health indicator that fails closed is worse than one that occasionally
 * shows an unfamiliar word.
 */
const HEALTHY: ReadonlySet<string> = new Set(["connected", "cached", "not-connected", "disabled"]);

export interface McpServerStatusLike {
	readonly name: string;
	readonly status: string;
	readonly failedAgoSeconds?: number;
	readonly disabled?: boolean;
}

export interface McpStatusSnapshotLike {
	readonly servers: ReadonlyArray<McpServerStatusLike>;
}

/** Human-readable reason for one unhealthy server. */
export function describeProblem(server: McpServerStatusLike): string {
	if (server.status === "needs-auth") return `${server.name} needs auth`;
	if (server.status === "failed") {
		const age = server.failedAgoSeconds;
		return typeof age === "number" && Number.isFinite(age) && age >= 0
			? `${server.name} failed ${Math.round(age)}s ago`
			: `${server.name} failed`;
	}
	return `${server.name} ${server.status}`;
}

function isServerLike(value: unknown): value is McpServerStatusLike {
	if (typeof value !== "object" || value === null) return false;
	const record = value as Record<string, unknown>;
	return typeof record.name === "string" && record.name.length > 0 && typeof record.status === "string";
}

/**
 * Returns the footer text, or `undefined` when there is nothing to report.
 *
 * `undefined` is also returned for unparseable payloads: a malformed snapshot is
 * not evidence of a broken server, so inventing a warning would be misleading.
 */
export function formatMcpHealth(snapshot: unknown): string | undefined {
	if (typeof snapshot !== "object" || snapshot === null) return undefined;
	const servers = (snapshot as { servers?: unknown }).servers;
	if (!Array.isArray(servers)) return undefined;

	const problems = servers
		.filter(isServerLike)
		.filter((server) => server.disabled !== true && !HEALTHY.has(server.status))
		.map(describeProblem);

	return problems.length === 0 ? undefined : `MCP: ${problems.join(", ")}`;
}
