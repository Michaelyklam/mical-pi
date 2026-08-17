import { execFile } from "node:child_process";
import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import { lstat, mkdir, readdir, realpath, rename, rm } from "node:fs/promises";
import * as path from "node:path";
import type { GitSource } from "./types.ts";

const GIT_TIMEOUT_MS = 30_000;
const MAX_REPOSITORY_FILES = 10_000;
const MAX_REPOSITORY_BYTES = 100 * 1024 * 1024;
const MAX_STAGING_BYTES = 200 * 1024 * 1024;

export function parseMarketplaceSource(raw: string, options?: { allowLocal?: boolean }): GitSource {
	const value = raw.trim();
	if (!value) throw new Error("Marketplace source is required.");
	let source = value;
	let ref: string | undefined;
	const hash = value.lastIndexOf("#");
	if (hash > 0) {
		source = value.slice(0, hash);
		ref = value.slice(hash + 1) || undefined;
	}
	if (/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(source)) {
		return { kind: "git", url: `https://github.com/${source}.git`, ref };
	}
	if (source.startsWith("https://")) {
		const url = new URL(source);
		if (url.username || url.password) throw new Error("Credential-bearing marketplace URLs are not allowed.");
		if (url.hostname.toLowerCase() !== "github.com") {
			throw new Error(`Only public github.com marketplace sources are supported in the skills-only MVP: ${url.hostname}`);
		}
		return { kind: "git", url: url.toString(), ref };
	}
	if (options?.allowLocal && (source.startsWith("file://") || path.isAbsolute(source))) {
		return { kind: "git", url: source, ref };
	}
	throw new Error(
		"Marketplace source must be GitHub owner/repo or a public HTTPS git URL.",
	);
}

export async function remoteHead(source: GitSource, exactSha?: string, signal?: AbortSignal): Promise<string> {
	await assertPublicSource(source);
	if (exactSha) {
		if (!/^[0-9a-f]{40}$/i.test(exactSha)) throw new Error(`Invalid git SHA "${exactSha}".`);
		return exactSha.toLowerCase();
	}
	const patterns = source.ref
		? source.ref.startsWith("refs/")
			? [source.ref, `${source.ref}^{}`]
			: [source.ref, `refs/heads/${source.ref}`, `refs/tags/${source.ref}`, `refs/tags/${source.ref}^{}`]
		: ["HEAD"];
	const { stdout } = await runGit(["ls-remote", source.url, ...patterns], signal);
	const lines = stdout.trim().split(/\r?\n/).filter(Boolean);
	const dereferenced = lines.find((line) => line.endsWith("^{}"));
	const selected = dereferenced ?? lines[0];
	const sha = selected?.match(/^([0-9a-f]{40})\s/i)?.[1];
	if (!sha) throw new Error(`Could not resolve ${source.url}${source.ref ? `#${source.ref}` : ""}.`);
	return sha.toLowerCase();
}

export async function materializeGit(options: {
	source: GitSource;
	sha: string;
	destination: string;
	signal?: AbortSignal;
}): Promise<void> {
	await assertPublicSource(options.source);
	const parent = path.dirname(options.destination);
	await mkdir(parent, { recursive: true, mode: 0o700 });
	const stage = path.join(parent, `.stage-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`);
	try {
		await mkdir(stage, { recursive: true, mode: 0o700 });
		await runGit(["-C", stage, "init"], options.signal);
		await runGit(["-C", stage, "remote", "add", "origin", options.source.url], options.signal);
		await runGit([
			"-C", stage, "fetch", "--depth=1", "--filter=blob:none", "--no-tags", "origin", options.sha,
		], options.signal, stage);
		const tree = (await runGit(["-C", stage, "ls-tree", "-r", "--name-only", "FETCH_HEAD"], options.signal)).stdout;
		const treeFiles = tree.split(/\r?\n/).filter(Boolean);
		if (treeFiles.length > MAX_REPOSITORY_FILES) {
			throw new Error(`Plugin repository exceeds ${MAX_REPOSITORY_FILES} files.`);
		}
		await runGit(["-C", stage, "checkout", "--detach", "FETCH_HEAD"], options.signal, stage);
		await validateRepositorySize(stage);
		const actual = (await runGit(["-C", stage, "rev-parse", "HEAD"], options.signal)).stdout.trim().toLowerCase();
		if (actual !== options.sha.toLowerCase()) {
			throw new Error(`Git checkout integrity mismatch: expected ${options.sha}, received ${actual}.`);
		}
		await atomicReplace(stage, options.destination);
	} finally {
		await rm(stage, { recursive: true, force: true }).catch(() => undefined);
	}
}

export async function atomicReplace(stage: string, destination: string): Promise<void> {
	const backup = `${destination}.backup-${process.pid}-${Date.now()}`;
	let movedOld = false;
	try {
		try {
			await rename(destination, backup);
			movedOld = true;
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
		}
		await rename(stage, destination);
		if (movedOld) await rm(backup, { recursive: true, force: true });
	} catch (error) {
		if (movedOld) {
			await rm(destination, { recursive: true, force: true }).catch(() => undefined);
			await rename(backup, destination).catch(() => undefined);
		}
		throw error;
	}
}

export async function containedRealpath(root: string, candidate: string): Promise<string> {
	const [realRoot, realCandidate] = await Promise.all([realpath(root), realpath(candidate)]);
	const relative = path.relative(realRoot, realCandidate);
	if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
		throw new Error(`Path escapes plugin root: ${candidate}`);
	}
	return realCandidate;
}

async function validateRepositorySize(root: string): Promise<void> {
	let files = 0;
	let bytes = 0;
	async function visit(directory: string): Promise<void> {
		for (const entry of await readdir(directory, { withFileTypes: true })) {
			if (entry.name === ".git") continue;
			const candidate = path.join(directory, entry.name);
			const info = await lstat(candidate);
			if (info.isDirectory()) {
				await visit(candidate);
				continue;
			}
			files++;
			bytes += info.size;
			if (files > MAX_REPOSITORY_FILES) throw new Error(`Plugin repository exceeds ${MAX_REPOSITORY_FILES} files.`);
			if (bytes > MAX_REPOSITORY_BYTES) throw new Error(`Plugin repository exceeds ${MAX_REPOSITORY_BYTES} bytes.`);
		}
	}
	await visit(root);
}

async function runGit(
	args: ReadonlyArray<string>,
	signal?: AbortSignal,
	monitorPath?: string,
): Promise<{ stdout: string; stderr: string }> {
	return new Promise((resolve, reject) => {
		let limitError: Error | undefined;
		let checking = false;
		const child = execFile("git", [...args], {
			timeout: GIT_TIMEOUT_MS,
			maxBuffer: 4 * 1024 * 1024,
			encoding: "utf8",
			env: {
				...process.env,
				GIT_TERMINAL_PROMPT: "0",
				GIT_CONFIG_NOSYSTEM: "1",
				GIT_CONFIG_GLOBAL: process.platform === "win32" ? "NUL" : "/dev/null",
				GIT_CONFIG_COUNT: "2",
				GIT_CONFIG_KEY_0: "credential.helper",
				GIT_CONFIG_VALUE_0: "",
				GIT_CONFIG_KEY_1: "http.followRedirects",
				GIT_CONFIG_VALUE_1: "false",
			},
			signal,
		}, (error, stdout, stderr) => {
			if (monitor) clearInterval(monitor);
			if (!error && !limitError) {
				resolve({ stdout, stderr });
				return;
			}
			const details = error as (Error & { stderr?: string }) | null;
			const text = limitError?.message || details?.stderr || stderr || details?.message || "Git command failed";
			reject(new Error(text.trim().slice(0, 4096)));
		});
		const monitor = monitorPath
			? setInterval(() => {
				if (checking) return;
				checking = true;
				void directoryUsage(monitorPath).then(({ bytes, files }) => {
					if (bytes > MAX_STAGING_BYTES || files > MAX_REPOSITORY_FILES * 2) {
						limitError = new Error(
							`Plugin staging exceeded safety limits (${files} files, ${bytes} bytes).`,
						);
						child.kill("SIGKILL");
					}
				}).catch(() => undefined).finally(() => { checking = false; });
			}, 100)
			: undefined;
	});
}

async function directoryUsage(root: string): Promise<{ files: number; bytes: number }> {
	let files = 0;
	let bytes = 0;
	async function visit(directory: string): Promise<void> {
		for (const entry of await readdir(directory, { withFileTypes: true })) {
			const candidate = path.join(directory, entry.name);
			const info = await lstat(candidate);
			if (info.isDirectory()) await visit(candidate);
			else {
				files++;
				bytes += info.size;
			}
			if (bytes > MAX_STAGING_BYTES || files > MAX_REPOSITORY_FILES * 2) return;
		}
	}
	await visit(root);
	return { files, bytes };
}

async function assertPublicSource(source: GitSource): Promise<void> {
	if (!source.url.startsWith("https://")) return; // local test fixtures only
	const hostname = new URL(source.url).hostname;
	const addresses = await lookup(hostname, { all: true, verbatim: true });
	if (addresses.length === 0 || addresses.some(({ address }) => privateAddress(address))) {
		throw new Error(`Marketplace host resolves to a non-public address: ${hostname}`);
	}
}

function privateAddress(address: string): boolean {
	const normalized = address.toLowerCase();
	if (isIP(normalized) === 4) return unsafeHost(normalized);
	if (isIP(normalized) !== 6) return true;
	if (normalized === "::" || normalized === "::1") return true;
	if (/^f[cd]/.test(normalized) || /^fe[89ab]/.test(normalized) || /^ff/.test(normalized)) return true;
	if (normalized.startsWith("2001:db8:")) return true;
	const mapped = normalized.match(/::ffff:(\d+\.\d+\.\d+\.\d+)$/)?.[1];
	return mapped ? unsafeHost(mapped) : false;
}

function unsafeHost(hostname: string): boolean {
	const host = hostname.toLowerCase().replace(/^\[|\]$/g, "");
	if (host === "localhost" || host === "::1") return true;
	const octets = host.split(".").map(Number);
	if (octets.length !== 4 || octets.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) return false;
	const [a, b, c] = octets as [number, number, number, number];
	return (
		a === 0 ||
		a === 10 ||
		a === 127 ||
		(a === 100 && b >= 64 && b <= 127) ||
		(a === 169 && b === 254) ||
		(a === 172 && b >= 16 && b <= 31) ||
		(a === 192 && (b === 168 || (b === 0 && (c === 0 || c === 2)))) ||
		(a === 198 && (b === 18 || b === 19 || (b === 51 && c === 100))) ||
		(a === 203 && b === 0 && c === 113) ||
		a >= 224
	);
}
