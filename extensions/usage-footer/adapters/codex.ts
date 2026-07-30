import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import type { AllowanceWindow, ProviderUsageSnapshot } from "../domain.ts";

export function normalizeCodexAccount(input: any, accountId: string): { stableIdentity: string; suggestedLabel?: string } {
	if (!accountId) throw new Error("Codex token did not include an account identity");
	const email = input?.account?.email;
	return { stableIdentity: accountId, suggestedLabel: typeof email === "string" ? email.split("@")[0] : input?.account?.planType };
}

function durationLabel(minutes?: number): string {
	if (!minutes) return "window";
	if (minutes % 1440 === 0) return `${minutes / 1440}d`;
	if (minutes % 60 === 0) return `${minutes / 60}h`;
	return `${minutes}m`;
}

function normalizeWindow(id: string, value: any, kind: AllowanceWindow["kind"]): AllowanceWindow | undefined {
	if (!value || typeof value.usedPercent !== "number") return undefined;
	return {
		id,
		label: durationLabel(value.windowDurationMins),
		usedPercent: value.usedPercent,
		windowMinutes: value.windowDurationMins ?? undefined,
		resetsAt: typeof value.resetsAt === "number" ? value.resetsAt * 1000 : undefined,
		kind,
	};
}

export function normalizeCodexUsage(rateResponse: any, tokenResponse: any, localDate: string, fetchedAt = Date.now()): ProviderUsageSnapshot {
	const main = rateResponse?.rateLimits ?? {};
	const windows = [normalizeWindow("codex-primary", main.primary, "primary"), normalizeWindow("codex-secondary", main.secondary, "secondary")].filter(
		(value): value is AllowanceWindow => Boolean(value),
	);
	const modelWindows: AllowanceWindow[] = [];
	for (const [limitId, limit] of Object.entries(rateResponse?.rateLimitsByLimitId ?? {})) {
		if (limitId === main.limitId) continue;
		const normalized = normalizeWindow(String(limitId), (limit as any).primary, "model");
		if (normalized) modelWindows.push({ ...normalized, label: (limit as any).limitName || normalized.label });
	}
	const today = (tokenResponse?.dailyUsageBuckets ?? []).find((item: any) => item.startDate === localDate);
	return {
		fetchedAt,
		sourceLabel: "OpenAI Codex account usage",
		windows,
		accountTodayTokens: typeof today?.tokens === "number" ? today.tokens : undefined,
		diagnostics: { modelWindows, planType: main.planType, rateLimitReachedType: main.rateLimitReachedType },
	};
}

class RpcClient {
	private nextId = 1;
	private pending = new Map<number, { resolve(value: any): void; reject(error: Error): void }>();
	private readonly process: ChildProcessWithoutNullStreams;

	constructor(command: string, codexHome: string) {
		this.process = spawn(command, ["app-server", "--stdio"], {
			env: { ...process.env, CODEX_HOME: codexHome },
			stdio: ["pipe", "pipe", "pipe"],
		});
		const lines = createInterface({ input: this.process.stdout });
		lines.on("line", (line) => {
			try {
				const message = JSON.parse(line);
				if (typeof message.id !== "number") return;
				const pending = this.pending.get(message.id);
				if (!pending) return;
				this.pending.delete(message.id);
				if (message.error) pending.reject(new Error(message.error.message ?? "Codex app-server request failed"));
				else pending.resolve(message.result);
			} catch {
				// Ignore non-protocol stdout.
			}
		});
		const rejectPending = (message: string) => {
			for (const pending of this.pending.values()) pending.reject(new Error(message));
			this.pending.clear();
		};
		this.process.on("error", (error) => rejectPending(`Codex app-server failed: ${error.message}`));
		this.process.on("exit", () => rejectPending("Codex app-server exited"));
	}

	request(method: string, params?: unknown, signal?: AbortSignal): Promise<any> {
		const id = this.nextId++;
		return new Promise((resolve, reject) => {
			const abort = () => {
				this.pending.delete(id);
				reject(new Error("Codex usage request aborted"));
			};
			if (signal?.aborted) return abort();
			signal?.addEventListener("abort", abort, { once: true });
			this.pending.set(id, {
				resolve: (value) => {
					signal?.removeEventListener("abort", abort);
					resolve(value);
				},
				reject,
			});
			this.process.stdin.write(`${JSON.stringify({ method, id, ...(params === undefined ? {} : { params }) })}\n`);
		});
	}

	close(): void {
		this.process.kill();
	}
}

export class CodexUsageAdapter {
	constructor(private readonly command = "codex") {}

	async fetch(input: { accessToken: string; accountId: string; planType?: string; localDate: string; signal?: AbortSignal }): Promise<{
		profile: { stableIdentity: string; suggestedLabel?: string };
		usage: ProviderUsageSnapshot;
	}> {
		const home = await mkdtemp(join(tmpdir(), "mical-pi-codex-"));
		const rpc = new RpcClient(this.command, home);
		try {
			await rpc.request("initialize", { clientInfo: { name: "mical-pi", version: "1" }, capabilities: { experimentalApi: true } }, input.signal);
			await rpc.request(
				"account/login/start",
				{ type: "chatgptAuthTokens", accessToken: input.accessToken, chatgptAccountId: input.accountId, chatgptPlanType: input.planType ?? null },
				input.signal,
			);
			const account = await rpc.request("account/read", { refreshToken: false }, input.signal);
			const rates = await rpc.request("account/rateLimits/read", undefined, input.signal);
			const tokens = await rpc.request("account/usage/read", undefined, input.signal);
			return { profile: normalizeCodexAccount(account, input.accountId), usage: normalizeCodexUsage(rates, tokens, input.localDate) };
		} finally {
			rpc.close();
			await rm(home, { recursive: true, force: true });
		}
	}
}
