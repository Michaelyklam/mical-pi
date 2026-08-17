import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { promisify } from "node:util";
import test from "node:test";
import { parseMarketplaceSource } from "./src/git.ts";
import { PluginReceiver } from "./src/receiver.ts";

const exec = promisify(execFile);

async function skill(root: string, relative: string, body: string): Promise<void> {
	const directory = path.join(root, relative);
	await mkdir(directory, { recursive: true });
	await writeFile(path.join(directory, "SKILL.md"), `---\nname: ${path.basename(directory)}\ndescription: Test skill\n---\n\n${body}\n`);
}

async function writeManifests(root: string, version: string, skills: string[]): Promise<void> {
	await mkdir(path.join(root, ".claude-plugin"), { recursive: true });
	await writeFile(path.join(root, ".claude-plugin", "marketplace.json"), JSON.stringify({
		name: "test-marketplace",
		owner: { name: "Tests" },
		plugins: [{ name: "test-skills", source: "./" }],
	}, null, 2));
	await writeFile(path.join(root, ".claude-plugin", "plugin.json"), JSON.stringify({
		name: "test-skills",
		version,
		skills,
	}, null, 2));
}

async function commit(repo: string, message: string): Promise<string> {
	await exec("git", ["-C", repo, "add", "."]);
	await exec("git", ["-C", repo, "-c", "user.name=Tests", "-c", "user.email=tests@example.com", "commit", "-m", message]);
	return (await exec("git", ["-C", repo, "rev-parse", "HEAD"])).stdout.trim();
}

async function fixture(): Promise<{ root: string; repo: string; receiver: PluginReceiver }> {
	const root = await mkdtemp(path.join(tmpdir(), "pi-plugin-receiver-"));
	const repo = path.join(root, "upstream");
	await mkdir(repo);
	await exec("git", ["-C", repo, "init", "-b", "main"]);
	await skill(repo, "skills/promoted/alpha", "alpha v1");
	await skill(repo, "skills/in-progress/draft", "must not load");
	await writeManifests(repo, "1.0.0", ["./skills/promoted/alpha"]);
	await commit(repo, "v1");
	return {
		root,
		repo,
		receiver: new PluginReceiver(path.join(root, "receiver"), { allowLocalSources: true }),
	};
}

test("network marketplace sources reject credentials, SSH, and private hosts", () => {
	assert.throws(() => parseMarketplaceSource("https://token@github.com/acme/plugins.git"), /Credential-bearing/);
	assert.throws(() => parseMarketplaceSource("git@github.com:acme/plugins.git"), /public HTTPS/);
	assert.throws(() => parseMarketplaceSource("https://127.0.0.1/plugins.git"), /github\.com/);
	assert.equal(parseMarketplaceSource("acme/plugins").url, "https://github.com/acme/plugins.git");
});

test("annotated marketplace tag refs resolve to their peeled commit", async () => {
	const { repo, receiver } = await fixture();
	await exec("git", [
		"-C", repo,
		"-c", "user.name=Tests",
		"-c", "user.email=tests@example.com",
		"tag", "-a", "v1", "-m", "v1",
	]);
	const marketplace = await receiver.addMarketplace(`${repo}#v1`);
	assert.equal(marketplace.currentSha, (await exec("git", ["-C", repo, "rev-parse", "HEAD"])).stdout.trim());
});

test("installs only manifest-selected skills and shows initial changelog once", async () => {
	const { repo, receiver } = await fixture();
	const marketplace = await receiver.addMarketplace(repo);
	assert.equal(marketplace.name, "test-marketplace");

	const plugin = await receiver.install("test-skills@test-marketplace");
	assert.equal(plugin.current?.version, "1.0.0");
	assert.deepEqual(plugin.current?.skills.map((item) => item.name), ["alpha"]);
	assert.match(await readFile(plugin.current!.skills[0]!.cachePath + "/SKILL.md", "utf8"), /alpha v1/);

	const loaded = await receiver.loadedResources();
	assert.equal(loaded.skillPaths.length, 1);
	const first = await receiver.claimPendingChangelogs(loaded, "session-a");
	assert.deepEqual(first[0]?.receipt.added, ["alpha"]);
	assert.equal((await receiver.claimPendingChangelogs(loaded, "session-b")).length, 0);
	await receiver.acknowledgeChangelog(first[0]!.plugin.id, first[0]!.receipt.toVersion, "session-a");
	assert.equal((await receiver.claimPendingChangelogs(loaded, "session-b")).length, 0);
});

test("startup sync promotes a new version and records deterministic skill changes", async () => {
	const { repo, receiver } = await fixture();
	await receiver.addMarketplace(repo);
	const first = await receiver.install("test-skills@test-marketplace");
	const oldCache = first.current!.skills[0]!.cachePath;

	await skill(repo, "skills/promoted/alpha", "alpha v2");
	await skill(repo, "skills/promoted/beta", "beta v1");
	await writeManifests(repo, "1.1.0", ["./skills/promoted/alpha", "./skills/promoted/beta"]);
	await commit(repo, "v2");

	const result = await receiver.syncAll();
	assert.equal(result.failed.length, 0);
	assert.equal(result.updated.length, 1);
	const updated = result.updated[0]!;
	assert.equal(updated.current?.version, "1.1.0");
	assert.deepEqual(updated.pendingChangelog?.added, ["beta"]);
	assert.deepEqual(updated.pendingChangelog?.modified, ["alpha"]);
	assert.deepEqual(updated.pendingChangelog?.removed, []);
	assert.match(await readFile(oldCache + "/SKILL.md", "utf8"), /alpha v1/, "old immutable cache remains usable");
});

test("external reviewed-style sources still honor the explicit curated skill list", async () => {
	const root = await mkdtemp(path.join(tmpdir(), "pi-plugin-external-"));
	const pluginRepo = path.join(root, "plugin");
	const marketplaceRepo = path.join(root, "marketplace");
	await mkdir(pluginRepo);
	await mkdir(marketplaceRepo);
	await exec("git", ["-C", pluginRepo, "init", "-b", "main"]);
	await exec("git", ["-C", marketplaceRepo, "init", "-b", "main"]);
	await skill(pluginRepo, "skills/promoted/alpha", "alpha");
	await skill(pluginRepo, "skills/in-progress/draft", "excluded");
	await mkdir(path.join(pluginRepo, ".claude-plugin"), { recursive: true });
	await writeFile(path.join(pluginRepo, ".claude-plugin", "plugin.json"), JSON.stringify({
		name: "external-skills",
		version: "2.0.0",
		skills: ["./skills/promoted/alpha"],
	}, null, 2));
	await commit(pluginRepo, "plugin");
	await mkdir(path.join(marketplaceRepo, ".claude-plugin"), { recursive: true });
	await writeFile(path.join(marketplaceRepo, ".claude-plugin", "marketplace.json"), JSON.stringify({
		name: "reviewed",
		owner: { name: "Tests" },
		plugins: [{ name: "external-skills", source: { source: "url", url: pluginRepo } }],
	}, null, 2));
	await commit(marketplaceRepo, "catalog");

	const receiver = new PluginReceiver(path.join(root, "receiver"), { allowLocalSources: true });
	await receiver.addMarketplace(marketplaceRepo);
	const installed = await receiver.install("external-skills@reviewed");
	assert.deepEqual(installed.current?.skills.map((item) => item.name), ["alpha"]);
});

test("installation rejects marketplace overlay changes made after confirmation", async () => {
	const { repo, receiver } = await fixture();
	await receiver.addMarketplace(repo);
	const preview = await receiver.preview("test-skills@test-marketplace");
	const catalogPath = path.join(repo, ".claude-plugin", "marketplace.json");
	const catalog = JSON.parse(await readFile(catalogPath, "utf8"));
	catalog.plugins[0].skills = ["./skills/in-progress/draft"];
	await writeFile(catalogPath, JSON.stringify(catalog, null, 2));
	await commit(repo, "overlay changed");
	await assert.rejects(
		receiver.install("test-skills@test-marketplace", preview),
		/changed after confirmation/,
	);
	assert.equal((await receiver.state()).plugins[preview.id], undefined);
});

test("content-only commits do not bypass an explicit plugin version gate", async () => {
	const { repo, receiver } = await fixture();
	await receiver.addMarketplace(repo);
	const first = await receiver.install("test-skills@test-marketplace");
	await skill(repo, "skills/promoted/alpha", "changed without release");
	await commit(repo, "content only");

	const result = await receiver.syncAll();
	assert.equal(result.updated.length, 0);
	assert.equal((await receiver.state()).plugins[first.id]?.current?.version, "1.0.0");
});

test("rollback switches the state pointer to the previous immutable version", async () => {
	const { repo, receiver } = await fixture();
	await receiver.addMarketplace(repo);
	await receiver.install("test-skills@test-marketplace");
	await skill(repo, "skills/promoted/alpha", "alpha v2");
	await writeManifests(repo, "1.1.0", ["./skills/promoted/alpha"]);
	await commit(repo, "v2");
	await receiver.syncAll();

	const rolledBack = await receiver.rollback("test-skills@test-marketplace");
	assert.equal(rolledBack.current?.version, "1.0.0");
	assert.equal(rolledBack.previous?.version, "1.1.0");
	assert.match(await readFile(rolledBack.current!.skills[0]!.cachePath + "/SKILL.md", "utf8"), /alpha v1/);
	assert.deepEqual(rolledBack.pendingChangelog?.modified, ["alpha"]);
});

test("invalid marketplace updates leave the prior checkout and plugin cache active", async () => {
	const { repo, receiver } = await fixture();
	await receiver.addMarketplace(repo);
	const installed = await receiver.install("test-skills@test-marketplace");
	const oldSha = (await receiver.state()).marketplaces["test-marketplace"]!.currentSha;
	await writeFile(path.join(repo, ".claude-plugin", "marketplace.json"), "{ broken json");
	await commit(repo, "broken catalog");

	const result = await receiver.syncAll();
	assert.equal(result.updated.length, 0);
	assert.equal(result.failed.length, 1);
	const state = await receiver.state();
	assert.equal(state.marketplaces["test-marketplace"]?.currentSha, oldSha);
	assert.equal(state.plugins[installed.id]?.current?.version, "1.0.0");
	assert.match(await readFile(installed.current!.skills[0]!.cachePath + "/SKILL.md", "utf8"), /alpha v1/);
});

test("removal drops the subscription but retains cache paths selected by the current runtime", async () => {
	const { repo, receiver } = await fixture();
	await receiver.addMarketplace(repo);
	const installed = await receiver.install("test-skills@test-marketplace");
	const cachedSkill = installed.current!.skills[0]!.cachePath;
	assert.equal(await receiver.remove(installed.id), true);
	assert.equal((await receiver.state()).plugins[installed.id], undefined);
	assert.match(await readFile(cachedSkill + "/SKILL.md", "utf8"), /alpha v1/);
});

test("fails closed when a plugin declares executable components", async () => {
	const { repo, receiver } = await fixture();
	const pluginManifestPath = path.join(repo, ".claude-plugin", "plugin.json");
	const manifest = JSON.parse(await readFile(pluginManifestPath, "utf8"));
	manifest.hooks = "./hooks/hooks.json";
	await writeFile(pluginManifestPath, JSON.stringify(manifest, null, 2));
	await commit(repo, "add hooks");
	await receiver.addMarketplace(repo);
	await assert.rejects(receiver.install("test-skills@test-marketplace"), /unsupported non-skill components/);
	assert.equal((await receiver.state()).plugins["test-skills@test-marketplace"], undefined);
});

test("fails closed when Pi cannot parse a selected skill's frontmatter", async () => {
	const { repo, receiver } = await fixture();
	await writeFile(
		path.join(repo, "skills", "promoted", "alpha", "SKILL.md"),
		"---\nname: alpha\ndescription: [\n---\n",
	);
	await commit(repo, "invalid frontmatter");
	await receiver.addMarketplace(repo);
	await assert.rejects(receiver.install("test-skills@test-marketplace"), /Invalid skill frontmatter/);
	assert.equal((await receiver.state()).plugins["test-skills@test-marketplace"], undefined);
});

test("fails closed on declared skill paths that escape the plugin root", async () => {
	const { repo, receiver } = await fixture();
	await writeManifests(repo, "1.0.1", ["./skills/promoted/alpha", "../outside"]);
	await commit(repo, "traversal");
	await receiver.addMarketplace(repo);
	await assert.rejects(receiver.install("test-skills@test-marketplace"), /must be relative/);
});

test("fails closed when a selected SKILL.md symlink escapes the repository", async () => {
	const { root, repo, receiver } = await fixture();
	const external = path.join(root, "outside.md");
	await writeFile(external, "---\ndescription: outside\n---\n");
	const skillFile = path.join(repo, "skills", "promoted", "alpha", "SKILL.md");
	await rm(skillFile);
	await symlink(external, skillFile);
	await commit(repo, "escaping skill symlink");
	await receiver.addMarketplace(repo);
	await assert.rejects(receiver.install("test-skills@test-marketplace"), /escapes plugin root/);
});

test("fails closed on conventionally discovered executable plugin directories", async () => {
	const { repo, receiver } = await fixture();
	await mkdir(path.join(repo, "hooks"), { recursive: true });
	await writeFile(path.join(repo, "hooks", "hooks.json"), "{}");
	await commit(repo, "conventional hooks");
	await receiver.addMarketplace(repo);
	await assert.rejects(receiver.install("test-skills@test-marketplace"), /contains unsupported non-skill components/);
});
