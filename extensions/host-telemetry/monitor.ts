import { AgentRegistry } from "./registry.ts";
import { SystemMetricCollector, type SystemMetrics } from "./metrics.ts";

export interface HostTelemetrySnapshot extends SystemMetrics {
	agents: number;
}

export interface HostTelemetryMonitorOptions {
	sessionId: string;
	onSnapshot: (snapshot: HostTelemetrySnapshot) => void;
	registry?: AgentRegistry;
	collector?: SystemMetricCollector;
	intervalMs?: number;
}

/** Owns the one-second host sampler and this Pi session's agent lease. */
export class HostTelemetryMonitor {
	private readonly registry: AgentRegistry;
	private readonly collector: SystemMetricCollector;
	private readonly sourceCounts = new Map<string, number>();
	private readonly intervalMs: number;
	private timer: NodeJS.Timeout | undefined;
	private currentTick: Promise<void> | undefined;

	constructor(private readonly options: HostTelemetryMonitorOptions) {
		this.registry = options.registry ?? new AgentRegistry(options.sessionId);
		this.collector = options.collector ?? new SystemMetricCollector();
		this.intervalMs = options.intervalMs ?? 1_000;
	}

	async start(): Promise<void> {
		this.collector.start();
		await this.tick();
		this.timer = setInterval(() => void this.tick(), this.intervalMs);
		this.timer.unref?.();
	}

	setChildAgentCount(source: string, count: number): void {
		this.sourceCounts.set(source, Math.max(0, Math.floor(count)));
	}

	private childAgents(): number {
		return [...this.sourceCounts.values()].reduce((sum, count) => sum + count, 0);
	}

	private tick(): Promise<void> {
		if (this.currentTick) return this.currentTick;
		const operation = this.sample().finally(() => {
			if (this.currentTick === operation) this.currentTick = undefined;
		});
		this.currentTick = operation;
		return operation;
	}

	private async sample(): Promise<void> {
		try {
			await this.registry.heartbeat(this.childAgents());
			const [agents, metrics] = await Promise.all([
				this.registry.count(),
				this.collector.sample(),
			]);
			this.options.onSnapshot({ agents, ...metrics });
		} catch {
			// Telemetry must never interfere with an interactive Pi session.
		}
	}

	async stop(): Promise<void> {
		if (this.timer) clearInterval(this.timer);
		this.timer = undefined;
		this.collector.stop();
		await this.currentTick;
		await this.registry.remove();
	}
}
