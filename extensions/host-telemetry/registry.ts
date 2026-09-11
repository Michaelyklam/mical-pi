import { createHash, randomBytes } from "node:crypto";
import { mkdir, readFile, readdir, rename, unlink, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

export interface AgentLease {
	pid: number;
	sessionId: string;
	heartbeatAt: number;
	childAgents: number;
}

const LEASE_TTL_MS = 3_500;

export function defaultAgentRegistryDirectory(): string {
	if (process.env.XDG_RUNTIME_DIR) return join(process.env.XDG_RUNTIME_DIR, "mical-pi", "agents");
	const cache = process.env.XDG_CACHE_HOME || join(homedir(), ".cache");
	return join(cache, "mical-pi", "agents");
}

function processIsAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		return (error as NodeJS.ErrnoException).code === "EPERM";
	}
}

function validLease(value: unknown): value is AgentLease {
	if (!value || typeof value !== "object") return false;
	const lease = value as Partial<AgentLease>;
	return Number.isInteger(lease.pid) && Number(lease.pid) > 0 &&
		typeof lease.sessionId === "string" &&
		typeof lease.heartbeatAt === "number" && Number.isFinite(lease.heartbeatAt) &&
		typeof lease.childAgents === "number" && Number.isInteger(lease.childAgents) && lease.childAgents >= 0;
}

/** Atomic, crash-tolerant registry of interactive Pi sessions on this host. */
export class AgentRegistry {
	private readonly leasePath: string;

	constructor(
		private readonly sessionId: string,
		private readonly directory = defaultAgentRegistryDirectory(),
		private readonly pid = process.pid,
		private readonly isAlive: (pid: number) => boolean = processIsAlive,
	) {
		const key = createHash("sha256").update(`${pid}:${sessionId}`).digest("hex").slice(0, 20);
		this.leasePath = join(directory, `${pid}-${key}.json`);
	}

	async heartbeat(childAgents: number, now = Date.now()): Promise<void> {
		await mkdir(this.directory, { recursive: true, mode: 0o700 });
		const lease: AgentLease = { pid: this.pid, sessionId: this.sessionId, heartbeatAt: now, childAgents };
		const temporary = `${this.leasePath}.${randomBytes(4).toString("hex")}.tmp`;
		try {
			await writeFile(temporary, `${JSON.stringify(lease)}\n`, { mode: 0o600 });
			await rename(temporary, this.leasePath);
		} finally {
			await unlink(temporary).catch(() => undefined);
		}
	}

	async count(now = Date.now()): Promise<number> {
		let names: string[];
		try {
			names = await readdir(this.directory);
		} catch {
			return 0;
		}
		let agents = 0;
		await Promise.all(names.filter((name) => name.endsWith(".json")).map(async (name) => {
			const path = join(this.directory, name);
			try {
				const lease: unknown = JSON.parse(await readFile(path, "utf8"));
				if (!validLease(lease) || now - lease.heartbeatAt > LEASE_TTL_MS || !this.isAlive(lease.pid)) {
					await unlink(path).catch(() => undefined);
					return;
				}
				agents += 1 + lease.childAgents;
			} catch {
				await unlink(path).catch(() => undefined);
			}
		}));
		return agents;
	}

	async remove(): Promise<void> {
		await unlink(this.leasePath).catch(() => undefined);
	}
}
