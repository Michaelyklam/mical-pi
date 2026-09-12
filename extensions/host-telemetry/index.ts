import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { HostTelemetryMonitor } from "./monitor.ts";

export const HOST_AGENT_COUNT_EVENT = "mical:host-agent-count";
export const HOST_TELEMETRY_EVENT = "mical:host-telemetry";

interface AgentCountEvent {
	source?: unknown;
	count?: unknown;
	active?: unknown;
	idle?: unknown;
}

export default function hostTelemetry(pi: ExtensionAPI) {
	let monitor: HostTelemetryMonitor | undefined;

	pi.events.on(HOST_AGENT_COUNT_EVENT, (value) => {
		const event = value as AgentCountEvent;
		if (typeof event.source !== "string") return;
		if (typeof event.active === "number" && Number.isFinite(event.active)) {
			const idle = typeof event.idle === "number" && Number.isFinite(event.idle) ? event.idle : 0;
			monitor?.setChildAgentActivity(event.source, event.active, idle);
			return;
		}
		if (typeof event.count === "number" && Number.isFinite(event.count)) monitor?.setChildAgentCount(event.source, event.count);
	});

	pi.on("session_start", async (_event, ctx) => {
		if (ctx.mode !== "tui") return;
		monitor = new HostTelemetryMonitor({
			sessionId: ctx.sessionManager.getSessionId(),
			onSnapshot: (snapshot) => pi.events.emit(HOST_TELEMETRY_EVENT, snapshot),
		});
		monitor.setSelfActive(!ctx.isIdle());
		await monitor.start();
	});

	pi.on("agent_start", async () => {
		monitor?.setSelfActive(true);
	});

	pi.on("agent_settled", async () => {
		monitor?.setSelfActive(false);
	});

	pi.on("session_shutdown", async () => {
		const active = monitor;
		monitor = undefined;
		await active?.stop();
	});
}
