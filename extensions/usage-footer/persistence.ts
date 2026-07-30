import { chmod, mkdir, open, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { AccountCatalogState, AccountCatalogStore } from "./account-catalog.ts";
import type { AccountKey, ProviderUsageSnapshot } from "./domain.ts";

async function readJson<T>(path: string): Promise<T | undefined> {
	try {
		return JSON.parse(await readFile(path, "utf8")) as T;
	} catch {
		return undefined;
	}
}

export async function writeJsonAtomic(path: string, value: unknown): Promise<void> {
	await mkdir(dirname(path), { recursive: true, mode: 0o700 });
	const temporary = `${path}.${process.pid}.${Date.now()}.tmp`;
	await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
	await rename(temporary, path);
	await chmod(path, 0o600).catch(() => undefined);
}

export async function withFileLock<T>(path: string, work: () => Promise<T>, staleMs = 30_000): Promise<T> {
	const lock = `${path}.lock`;
	await mkdir(dirname(path), { recursive: true, mode: 0o700 });
	for (let attempt = 0; attempt < 50; attempt++) {
		try {
			const handle = await open(lock, "wx", 0o600);
			await handle.close();
			try {
				return await work();
			} finally {
				await rm(lock, { force: true });
			}
		} catch (error: any) {
			if (error?.code !== "EEXIST") throw error;
			try {
				if (Date.now() - (await stat(lock)).mtimeMs > staleMs) {
					await rm(lock, { force: true });
					continue;
				}
			} catch {
				continue;
			}
			await new Promise((resolve) => setTimeout(resolve, 20 + attempt * 5));
		}
	}
	throw new Error("Timed out waiting for usage-footer cache lock");
}

export class JsonAccountCatalogStore implements AccountCatalogStore {
	constructor(private readonly path: string) {}
	load(): Promise<AccountCatalogState | undefined> {
		return readJson<AccountCatalogState>(this.path);
	}
	save(state: AccountCatalogState): Promise<void> {
		return withFileLock(this.path, () => writeJsonAtomic(this.path, state));
	}
}

interface SnapshotFile {
	version: 1;
	snapshots: Record<AccountKey, ProviderUsageSnapshot>;
}

export class JsonSnapshotStore {
	constructor(private readonly path: string) {}

	async load(key: AccountKey): Promise<ProviderUsageSnapshot | undefined> {
		return (await readJson<SnapshotFile>(this.path))?.snapshots[key];
	}

	async save(key: AccountKey, snapshot: ProviderUsageSnapshot): Promise<void> {
		await withFileLock(this.path, async () => {
			const current = (await readJson<SnapshotFile>(this.path)) ?? { version: 1 as const, snapshots: {} };
			current.snapshots[key] = snapshot;
			await writeJsonAtomic(this.path, current);
		});
	}
}
