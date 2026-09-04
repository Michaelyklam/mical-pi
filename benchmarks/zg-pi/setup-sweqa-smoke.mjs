#!/usr/bin/env node
import { spawn } from "node:child_process";
import { access, mkdir, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const tasks = JSON.parse(await readFile(join(here, "swe-qa-smoke.json"), "utf8"));
const reposDir = join(here, "cache", "repos");
const requested = process.argv.slice(2);
const selected = requested.length ? tasks.filter((task) => requested.includes(task.id)) : tasks;

function run(command, args, cwd) {
	return new Promise((resolve, reject) => {
		const child = spawn(command, args, { cwd, stdio: "inherit", env: process.env });
		child.on("error", reject);
		child.on("close", (code) => code === 0 ? resolve() : reject(new Error(`${command} exited with ${code}`)));
	});
}

await mkdir(reposDir, { recursive: true });
// A running zg daemon may hold RocksDB handles for an index this script is about
// to replace. Stop it before removing any workspace index to avoid flush races.
try {
	await run("zg", ["server", "off"]);
} catch {
	// No daemon is a valid starting state.
}
for (const task of selected) {
	const slug = task.id.replace(":", "-");
	const repo = join(reposDir, slug);
	console.log(`\nPreparing ${task.id} at ${task.repositoryCommit}...`);
	try {
		await run("git", ["-C", repo, "rev-parse", "--git-dir"]);
	} catch {
		await run("git", ["clone", "--filter=blob:none", `https://github.com/${task.repository}.git`, repo]);
	}
	await run("git", ["-C", repo, "fetch", "--depth=1", "origin", task.repositoryCommit]);
	await run("git", ["-C", repo, "checkout", "--detach", task.repositoryCommit]);
	try {
		await access(join(repo, ".zvec-grep", "manifest.json"));
		console.log("Reusing existing index.");
	} catch {
		await run("zg", ["index", "--embedding", "local/potion-code-16m-v2", "--mode", "direct"], repo);
	}
}
console.log(`\nReady: ${selected.length} SWE-QA task repositories`);
