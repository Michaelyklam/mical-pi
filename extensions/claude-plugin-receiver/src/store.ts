import { randomUUID } from "node:crypto";
import { open, readFile, rename, rm, writeFile, mkdir, stat, utimes } from "node:fs/promises";
import * as path from "node:path";
import type { ReceiverState } from "./types.ts";

const EMPTY_STATE: ReceiverState = {
	schemaVersion: 1,
	marketplaces: {},
	plugins: {},
};

export class ReceiverStore {
	readonly root: string;
	readonly statePath: string;

	constructor(root: string) {
		this.root = root;
		this.statePath = path.join(root, "subscriptions.json");
	}

	async initialize(): Promise<void> {
		await mkdir(this.root, { recursive: true, mode: 0o700 });
		await Promise.all([
			mkdir(path.join(this.root, "marketplaces"), { recursive: true, mode: 0o700 }),
			mkdir(path.join(this.root, "cache"), { recursive: true, mode: 0o700 }),
			mkdir(path.join(this.root, "tmp"), { recursive: true, mode: 0o700 }),
			mkdir(path.join(this.root, "locks"), { recursive: true, mode: 0o700 }),
		]);
	}

	async read(): Promise<ReceiverState> {
		await this.initialize();
		try {
			const parsed = JSON.parse(await readFile(this.statePath, "utf8")) as ReceiverState;
			if (parsed.schemaVersion !== 1 || !parsed.marketplaces || !parsed.plugins) {
				throw new Error(`Unsupported receiver state in ${this.statePath}`);
			}
			return parsed;
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") return structuredClone(EMPTY_STATE);
			throw error;
		}
	}

	async write(state: ReceiverState): Promise<void> {
		await this.initialize();
		const temporary = `${this.statePath}.${process.pid}.${Date.now()}.tmp`;
		await writeFile(temporary, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
		await rename(temporary, this.statePath);
	}

	async update(change: (state: ReceiverState) => ReceiverState): Promise<ReceiverState> {
		return this.withLock("state", async () => {
			const next = change(await this.read());
			await this.write(next);
			return next;
		});
	}

	async tryWithLock<T>(name: string, work: () => Promise<T>): Promise<T | undefined> {
		await this.initialize();
		const lockPath = path.join(this.root, "locks", `${safeSegment(name)}.lock`);
		for (let attempt = 0; attempt < 2; attempt++) {
			try {
				const token = randomUUID();
				const handle = await open(lockPath, "wx", 0o600);
				let stopHeartbeat: (() => void) | undefined;
				try {
					await handle.writeFile(JSON.stringify({ pid: process.pid, at: Date.now(), token }));
					stopHeartbeat = startHeartbeat(lockPath);
					return await work();
				} finally {
					stopHeartbeat?.();
					await handle.close().catch(() => undefined);
					await releaseOwnedLock(lockPath, token);
				}
			} catch (error) {
				if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
				if (attempt === 0 && await removeStaleLock(lockPath)) continue;
				return undefined;
			}
		}
		return undefined;
	}

	async withLock<T>(name: string, work: () => Promise<T>): Promise<T> {
		await this.initialize();
		const lockPath = path.join(this.root, "locks", `${safeSegment(name)}.lock`);
		for (let attempt = 0; attempt < 1_200; attempt++) {
			try {
				const token = randomUUID();
				const handle = await open(lockPath, "wx", 0o600);
				let stopHeartbeat: (() => void) | undefined;
				try {
					await handle.writeFile(JSON.stringify({ pid: process.pid, at: Date.now(), token }));
					stopHeartbeat = startHeartbeat(lockPath);
					return await work();
				} finally {
					stopHeartbeat?.();
					await handle.close().catch(() => undefined);
					await releaseOwnedLock(lockPath, token);
				}
			} catch (error) {
				if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
				if (await removeStaleLock(lockPath)) continue;
				await new Promise((resolve) => setTimeout(resolve, 50));
			}
		}
		throw new Error(`Timed out waiting for receiver lock "${name}"`);
	}
}

function startHeartbeat(lockPath: string): () => void {
	const timer = setInterval(() => {
		const time = new Date();
		void utimes(lockPath, time, time).catch(() => undefined);
	}, 30_000);
	timer.unref?.();
	return () => clearInterval(timer);
}

async function releaseOwnedLock(lockPath: string, token: string): Promise<void> {
	try {
		const details = JSON.parse(await readFile(lockPath, "utf8")) as { token?: string };
		if (details.token === token) await rm(lockPath, { force: true });
	} catch {
		// A stolen/removed lock is no longer ours to release.
	}
}

async function removeStaleLock(lockPath: string): Promise<boolean> {
	const takeoverPath = `${lockPath}.takeover`;
	const takeover = await acquireTakeover(takeoverPath);
	if (!takeover) return false;
	try {
		try {
			const details = JSON.parse(await readFile(lockPath, "utf8")) as { pid?: number };
			let deadOwner = false;
			if (details.pid) {
				try {
					process.kill(details.pid, 0);
					return false;
				} catch (error) {
					if ((error as NodeJS.ErrnoException).code !== "ESRCH") return false;
					deadOwner = true;
				}
			}
			if (!deadOwner && Date.now() - (await stat(lockPath)).mtimeMs <= 2 * 60_000) return false;
		} catch {
			return false;
		}
		await rm(lockPath, { force: true });
		return true;
	} finally {
		await takeover.close().catch(() => undefined);
		await rm(takeoverPath, { force: true }).catch(() => undefined);
	}
}

async function acquireTakeover(
	takeoverPath: string,
): Promise<Awaited<ReturnType<typeof open>> | undefined> {
	for (let attempt = 0; attempt < 2; attempt++) {
		try {
			const handle = await open(takeoverPath, "wx", 0o600);
			await handle.writeFile(JSON.stringify({ pid: process.pid, at: Date.now() }));
			return handle;
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "EEXIST") return undefined;
			try {
				const source = await readFile(takeoverPath, "utf8");
				const details = JSON.parse(source) as { pid?: number; at?: number };
				if (details.pid) {
					try {
						process.kill(details.pid, 0);
						return undefined;
					} catch (pidError) {
						if ((pidError as NodeJS.ErrnoException).code !== "ESRCH") return undefined;
					}
				} else if (Date.now() - (details.at ?? 0) <= 30_000) return undefined;
				if (await readFile(takeoverPath, "utf8") !== source) return undefined;
				await rm(takeoverPath, { force: true });
			} catch {
				try {
					if (Date.now() - (await stat(takeoverPath)).mtimeMs <= 30_000) return undefined;
					await rm(takeoverPath, { force: true });
				} catch { return undefined; }
			}
		}
	}
	return undefined;
}

export function safeSegment(value: string): string {
	const cleaned = value.replace(/[^a-zA-Z0-9._-]+/g, "-").replace(/^-+|-+$/g, "");
	return cleaned.slice(0, 100) || "item";
}
