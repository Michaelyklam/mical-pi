#!/usr/bin/env node
import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const tasksPath = join(here, "swe-qa-smoke.json");
const tasks = JSON.parse(await readFile(tasksPath, "utf8"));
const requested = process.argv.filter((arg) => !arg.startsWith("--"));
const attemptsArg = process.argv.find((arg) => arg.startsWith("--attempts="));
const attempts = attemptsArg?.split("=")[1] ?? "1";
const selected = requested.length ? tasks.filter((task) => requested.includes(task.id)) : tasks;

function run(args) {
	return new Promise((resolve, reject) => {
		const child = spawn(process.execPath, args, { stdio: "inherit", env: process.env });
		child.on("error", reject);
		child.on("close", (code) => code === 0 ? resolve() : reject(new Error(`benchmark exited with ${code}`)));
	});
}

for (const task of selected) {
	const repo = join(here, "cache", "repos", task.id.replace(":", "-"));
	await run([
		join(here, "bench.mjs"), "run",
		"--repo", repo,
		"--tasks", tasksPath,
		"--task-id", task.id,
		"--attempts", attempts,
	]);
}
