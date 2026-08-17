import { createHash } from "node:crypto";
import {
	parseFrontmatter,
	type SkillFrontmatter,
} from "@earendil-works/pi-coding-agent";
import { chmod, copyFile, lstat, mkdir, readdir, readFile, realpath, rm, stat } from "node:fs/promises";
import * as path from "node:path";
import { containedRealpath } from "./git.ts";
import type {
	InstalledSkill,
	MarketplaceManifest,
	MarketplacePluginEntry,
	PluginManifest,
} from "./types.ts";

const UNSUPPORTED_COMPONENTS = [
	"commands",
	"agents",
	"workflows",
	"hooks",
	"mcpServers",
	"lspServers",
	"outputStyles",
	"themes",
	"monitors",
	"settings",
	"channels",
	"dependencies",
	"userConfig",
] as const;
const MAX_FILES = 2_000;
const MAX_BYTES = 50 * 1024 * 1024;
const MAX_MANIFEST_BYTES = 1024 * 1024;

export async function readMarketplace(checkout: string): Promise<MarketplaceManifest> {
	const manifestPath = await containedRealpath(
		checkout,
		path.join(checkout, ".claude-plugin", "marketplace.json"),
	);
	const value = await readJson(manifestPath) as Partial<MarketplaceManifest>;
	if (!validName(value.name) || !value.owner || typeof value.owner.name !== "string" || !Array.isArray(value.plugins)) {
		throw new Error(`Invalid Claude marketplace manifest: ${manifestPath}`);
	}
	const pluginNames = new Set<string>();
	for (const entry of value.plugins) {
		if (!entry || !validName(entry.name) || !("source" in entry)) {
			throw new Error(`Invalid plugin entry in ${manifestPath}`);
		}
		if (pluginNames.has(entry.name)) {
			throw new Error(`Duplicate plugin name "${entry.name}" in ${manifestPath}`);
		}
		pluginNames.add(entry.name);
	}
	return value as MarketplaceManifest;
}

export async function readPluginManifest(pluginRoot: string): Promise<PluginManifest | undefined> {
	const declaredPath = path.join(pluginRoot, ".claude-plugin", "plugin.json");
	try {
		const manifestPath = await containedRealpath(pluginRoot, declaredPath);
		const value = await readJson(manifestPath) as Partial<PluginManifest>;
		if (!validName(value.name)) throw new Error(`Invalid plugin name in ${manifestPath}`);
		return value as PluginManifest;
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
		throw error;
	}
}

export async function assertSkillsOnly(
	pluginRoot: string,
	entry: MarketplacePluginEntry,
	manifest: PluginManifest | undefined,
): Promise<void> {
	const conflicts: string[] = [];
	for (const field of UNSUPPORTED_COMPONENTS) {
		if (entry[field] !== undefined || manifest?.[field] !== undefined) conflicts.push(field);
	}
	if (entry.experimental !== undefined || manifest?.experimental !== undefined) conflicts.push("experimental");
	if (conflicts.length > 0) {
		throw new Error(
			`Plugin declares unsupported non-skill components: ${[...new Set(conflicts)].sort().join(", ")}. ` +
			"The skills-only receiver refuses partial installation.",
		);
	}
	const executablePaths = [
		"commands", "agents", "workflows", "hooks", "monitors", "themes", "output-styles", "bin",
		".mcp.json", ".lsp.json", "settings.json",
	];
	for (const relative of executablePaths) {
		try {
			await lstat(path.join(pluginRoot, relative));
			conflicts.push(relative);
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
		}
	}
	if (conflicts.length > 0) {
		throw new Error(
			`Plugin declares or contains unsupported non-skill components: ${[...new Set(conflicts)].sort().join(", ")}. ` +
			"The skills-only receiver refuses partial installation.",
		);
	}
	if (entry.strict === false && manifest) {
		const manifestComponents = Object.keys(manifest).filter((key) => key === "skills" || UNSUPPORTED_COMPONENTS.includes(key as never));
		if (manifestComponents.length > 0) {
			throw new Error("strict:false marketplace entry conflicts with component declarations in plugin.json.");
		}
	}
}

export async function selectedSkillDirectories(options: {
	pluginRoot: string;
	marketplaceRoot: string;
	entry: MarketplacePluginEntry;
	manifest?: PluginManifest;
}): Promise<ReadonlyArray<{ name: string; sourcePath: string; absolutePath: string }>> {
	await assertSkillsOnly(options.pluginRoot, options.entry, options.manifest);
	const explicit = options.entry.strict === false
		? normalizePaths(options.entry.skills)
		: [...normalizePaths(options.manifest?.skills), ...normalizePaths(options.entry.skills)];
	const candidates: string[] = [];

	// An explicit skill list is publisher curation and is complete. This is
	// essential for repositories such as Matt Pocock's, where the same source
	// also contains draft/deprecated buckets. Claude's installed result follows
	// the explicit list for both direct and external marketplace channels.
	if (explicit.length === 0) {
		const defaultRoot = path.join(options.pluginRoot, "skills");
		if (await isDirectory(defaultRoot)) candidates.push(...await findSkillDirectories(defaultRoot));
		if (!await isDirectory(defaultRoot)) {
			const rootSkill = path.join(options.pluginRoot, "SKILL.md");
			if (await isFile(rootSkill)) candidates.push(options.pluginRoot);
		}
	}
	for (const declared of explicit) {
		const absolute = resolveDeclaredPath(options.pluginRoot, declared);
		const contained = await containedRealpath(options.pluginRoot, absolute);
		if (await isFile(path.join(contained, "SKILL.md"))) candidates.push(contained);
		else candidates.push(...await findSkillDirectories(contained));
	}

	const uniqueCandidates = [...new Set(candidates.map((candidate) => path.resolve(candidate)))];
	const unique = await Promise.all(uniqueCandidates.map((candidate) =>
		containedRealpath(options.pluginRoot, candidate),
	));
	if (unique.length === 0) throw new Error(`Plugin "${options.entry.name}" selects no skills.`);
	const selected = await Promise.all(unique.map(async (absolutePath) => {
		const skillFile = await containedRealpath(
			options.pluginRoot,
			path.join(absolutePath, "SKILL.md"),
		);
		if (!(await lstat(skillFile)).isFile()) {
			throw new Error(`SKILL.md must be a regular file: ${skillFile}`);
		}
		const content = await readFile(skillFile, "utf8");
		let frontmatter: SkillFrontmatter;
		try {
			frontmatter = parseFrontmatter<SkillFrontmatter>(content).frontmatter;
		} catch (error) {
			throw new Error(`Invalid skill frontmatter in ${skillFile}: ${error instanceof Error ? error.message : String(error)}`);
		}
		if (typeof frontmatter.description !== "string" || !frontmatter.description.trim()) {
			throw new Error(`Skill is missing a string frontmatter description: ${skillFile}`);
		}
		if (frontmatter.name !== undefined && typeof frontmatter.name !== "string") {
			throw new Error(`Skill frontmatter name must be a string: ${skillFile}`);
		}
		const name = frontmatter.name?.trim() || path.basename(absolutePath);
		if (!validName(name)) throw new Error(`Invalid skill name "${name}" in ${skillFile}`);
		return {
			name,
			sourcePath: toPosix(path.relative(options.pluginRoot, absolutePath)) || ".",
			absolutePath,
		};
	}));
	const names = new Set<string>();
	for (const skill of selected) {
		if (names.has(skill.name)) throw new Error(`Plugin contains duplicate skill name "${skill.name}".`);
		names.add(skill.name);
	}
	return selected.sort((a, b) => a.name.localeCompare(b.name));
}

export async function materializeSkills(options: {
	pluginRoot: string;
	cachePath: string;
	skills: ReadonlyArray<{ name: string; sourcePath: string; absolutePath: string }>;
	signal?: AbortSignal;
}): Promise<ReadonlyArray<InstalledSkill>> {
	await rm(options.cachePath, { recursive: true, force: true });
	await mkdir(options.cachePath, { recursive: true, mode: 0o700 });
	try {
		const installed: InstalledSkill[] = [];
		let files = 0;
		let bytes = 0;
		for (const skill of options.skills) {
			if (options.signal?.aborted) throw new Error("Plugin update cancelled.");
			const digest = await hashTree(skill.absolutePath, options.pluginRoot, (size) => {
				files++;
				bytes += size;
				if (files > MAX_FILES) throw new Error(`Plugin exceeds ${MAX_FILES} selected-skill files.`);
				if (bytes > MAX_BYTES) throw new Error(`Plugin exceeds ${MAX_BYTES} selected-skill bytes.`);
			});
			const destination = path.join(options.cachePath, "skills", skill.name);
			await mkdir(path.dirname(destination), { recursive: true });
			if (options.signal?.aborted) throw new Error("Plugin update cancelled.");
			await copySelectedTree(skill.absolutePath, destination, options.pluginRoot, options.signal);
			if (options.signal?.aborted) throw new Error("Plugin update cancelled.");
			installed.push({ name: skill.name, sourcePath: skill.sourcePath, cachePath: destination, digest });
		}
		return installed;
	} catch (error) {
		await rm(options.cachePath, { recursive: true, force: true }).catch(() => undefined);
		throw error;
	}
}

async function hashTree(root: string, allowedRoot: string, count: (bytes: number) => void): Promise<string> {
	const hash = createHash("sha256");
	const seen = new Set<string>();
	async function visit(candidate: string, relative: string): Promise<void> {
		const info = await lstat(candidate);
		if (info.isSymbolicLink()) {
			const target = await containedRealpath(allowedRoot, candidate);
			const real = await realpath(target);
			if (seen.has(real)) throw new Error(`Symlink cycle in selected skill: ${candidate}`);
			seen.add(real);
			await visit(target, relative);
			seen.delete(real);
			return;
		}
		if (info.isDirectory()) {
			for (const entry of (await readdir(candidate)).sort()) {
				if (entry === ".git") continue;
				await visit(path.join(candidate, entry), relative ? `${relative}/${entry}` : entry);
			}
			return;
		}
		if (!info.isFile()) throw new Error(`Unsupported file type in skill: ${candidate}`);
		count(info.size);
		hash.update(relative);
		hash.update("\0");
		hash.update(await readFile(candidate));
		hash.update("\0");
	}
	await visit(root, "");
	return hash.digest("hex");
}

async function copySelectedTree(
	source: string,
	destination: string,
	allowedRoot: string,
	signal?: AbortSignal,
	seen = new Set<string>(),
): Promise<void> {
	if (signal?.aborted) throw new Error("Plugin update cancelled.");
	const info = await lstat(source);
	if (info.isSymbolicLink()) {
		const target = await containedRealpath(allowedRoot, source);
		const real = await realpath(target);
		if (seen.has(real)) throw new Error(`Symlink cycle in selected skill: ${source}`);
		seen.add(real);
		await copySelectedTree(target, destination, allowedRoot, signal, seen);
		seen.delete(real);
		return;
	}
	if (info.isDirectory()) {
		await mkdir(destination, { recursive: true, mode: info.mode & 0o777 });
		for (const entry of await readdir(source)) {
			if (entry === ".git") continue;
			await copySelectedTree(
				path.join(source, entry),
				path.join(destination, entry),
				allowedRoot,
				signal,
				seen,
			);
		}
		return;
	}
	if (!info.isFile()) throw new Error(`Unsupported file type in skill: ${source}`);
	await copyFile(source, destination);
	await chmod(destination, info.mode & 0o777);
}

async function findSkillDirectories(root: string): Promise<string[]> {
	const skillFile = path.join(root, "SKILL.md");
	if (await isFile(skillFile)) return [root];
	const found: string[] = [];
	for (const entry of await readdir(root, { withFileTypes: true })) {
		if (entry.name.startsWith(".") || entry.name === "node_modules") continue;
		if (entry.isDirectory()) {
			found.push(...await findSkillDirectories(path.join(root, entry.name)));
		}
	}
	return found;
}

function resolveDeclaredPath(root: string, declared: string): string {
	if (declared !== "." && declared !== "./" && !declared.startsWith("./")) {
		throw new Error(`Plugin skill path must be relative and start with ./ : ${declared}`);
	}
	const resolved = path.resolve(root, declared);
	const relative = path.relative(path.resolve(root), resolved);
	if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
		throw new Error(`Plugin skill path escapes its root: ${declared}`);
	}
	return resolved;
}

function normalizePaths(value: unknown): string[] {
	if (typeof value === "string") return [value];
	if (Array.isArray(value) && value.every((item) => typeof item === "string")) return [...value];
	if (value === undefined) return [];
	throw new Error("Plugin skills must be a relative path or an array of relative paths.");
}

async function readJson(file: string): Promise<unknown> {
	const details = await lstat(file);
	if (!details.isFile()) throw new Error(`Manifest must be a regular file: ${file}`);
	const size = details.size;
	if (size > MAX_MANIFEST_BYTES) {
		throw new Error(`Manifest exceeds ${MAX_MANIFEST_BYTES} bytes: ${file}`);
	}
	return JSON.parse(await readFile(file, "utf8"));
}
async function isDirectory(candidate: string): Promise<boolean> {
	try { return (await lstat(candidate)).isDirectory(); } catch { return false; }
}
async function isFile(candidate: string): Promise<boolean> {
	try { return (await stat(candidate)).isFile(); } catch { return false; }
}
function validName(value: unknown): value is string {
	return typeof value === "string" && /^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/.test(value);
}
function toPosix(value: string): string { return value.split(path.sep).join("/"); }
