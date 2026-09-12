import { AgentRegistry, type AgentActivityCounts } from "./registry.ts";
import { SystemMetricCollector, type SystemMetrics } from "./metrics.ts";

export interface HostTelemetrySnapshot extends SystemMetrics {
	agents: number;
	agentActivity: AgentActivityCounts;
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
	private readonly sourceCounts = new Map<string, AgentActivityCounts>();
	private selfActive = false;
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

	setSelfActive(active: boolean): void {
		this.selfActive = active;
	}

	setChildAgentCount(source: string, count: number): void {
		const active = Math.max(0, Math.floor(count));
		this.sourceCounts.set(source, { active, idle: 0, total: active });
	}

	setChildAgentActivity(source: string, active: number, idle: number): void {
		const normalizedActive = Math.max(0, Math.floor(active));
		const normalizedIdle = Math.max(0, Math.floor(idle));
		this.sourceCounts.set(source, {
			active: normalizedActive,
			idle: normalizedIdle,
			total: normalizedActive + normalizedIdle,
		});
	}

	private childAgents(): AgentActivityCounts {
		return [...this.sourceCounts.values()].reduce<AgentActivityCounts>((sum, count) => ({
			active: sum.active + count.active,
			idle: sum.idle + count.idle,
			total: sum.total + count.total,
		}), { active: 0, idle: 0, total: 0 });
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
			const childAgents = this.childAgents();
			await this.registry.heartbeat(childAgents.active, Date.now(), this.selfActive, childAgents.idle);
			const [agentActivity, metrics] = await Promise.all([
				this.registry.activity(),
				this.collector.sample(),
			]);
			this.options.onSnapshot({ agents: agentActivity.total, agentActivity, ...metrics });
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
