import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { HostTelemetryMonitor } from "./monitor.ts";

export const HOST_AGENT_COUNT_EVENT = "mical:host-agent-count";
export const HOST_TELEMETRY_EVENT = "mical:host-telemetry";

interface AgentCountEvent {
	source?: unknown;
	count?: unknown;
}

export default function hostTelemetry(pi: ExtensionAPI) {
	let monitor: HostTelemetryMonitor | undefined;

	pi.events.on(HOST_AGENT_COUNT_EVENT, (value) => {
		const event = value as AgentCountEvent;
		if (typeof event.source !== "string" || typeof event.count !== "number" || !Number.isFinite(event.count)) return;
		monitor?.setChildAgentCount(event.source, event.count);
	});

	pi.on("session_start", async (_event, ctx) => {
		if (ctx.mode !== "tui") return;
		monitor = new HostTelemetryMonitor({
			sessionId: ctx.sessionManager.getSessionId(),
			onSnapshot: (snapshot) => pi.events.emit(HOST_TELEMETRY_EVENT, snapshot),
		});
		await monitor.start();
	});

	pi.on("session_shutdown", async () => {
		const active = monitor;
		monitor = undefined;
		await active?.stop();
	});
}
