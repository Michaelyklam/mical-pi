#!/usr/bin/env node
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const defaultRepo = "/Users/michael.lam/Documents/augment-projects/KaraokeAugment";
const defaultTasks = join(here, "tasks.json");
const zgExtension = join(here, "zg-tool.ts");
const zgGuidance = join(here, "official-zg-guidance.md");
const sourceGlobs = ["frontend/src/**", "backend/**/*.py", "convex/**", "scripts/**/*.py", "docs/**/*.md"];

function parseArgs(argv) {
	const [command = "help", ...rest] = argv;
	const options = {};
	for (let index = 0; index < rest.length; index++) {
		const item = rest[index];
		if (!item.startsWith("--")) throw new Error(`Unexpected argument: ${item}`);
		const key = item.slice(2);
		const value = rest[index + 1];
		if (!value || value.startsWith("--")) options[key] = true;
		else { options[key] = value; index++; }
	}
	return { command, options };
}

function runProcess(command, args, { cwd, capture = true } = {}) {
	return new Promise((resolvePromise, reject) => {
		const child = spawn(command, args, { cwd, env: process.env, stdio: capture ? ["ignore", "pipe", "pipe"] : "inherit" });
		let stdout = "";
		let stderr = "";
		if (capture) {
			child.stdout.setEncoding("utf8").on("data", (chunk) => { stdout += chunk; });
			child.stderr.setEncoding("utf8").on("data", (chunk) => { stderr += chunk; });
		}
		child.on("error", reject);
		child.on("close", (code, signal) => resolvePromise({ code, signal, stdout, stderr }));
	});
}

export function parsePiJson(stdout) {
	const events = stdout.split("\n").filter(Boolean).map((line) => JSON.parse(line));
	const assistantMessages = events
		.filter((event) => event.type === "message_end" && event.message?.role === "assistant")
		.map((event) => event.message);
	const usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0, totalTokens: 0, costUsd: 0 };
	for (const message of assistantMessages) {
		const current = message.usage ?? {};
		usage.input += current.input ?? 0;
		usage.output += current.output ?? 0;
		usage.cacheRead += current.cacheRead ?? 0;
		usage.cacheWrite += current.cacheWrite ?? 0;
		usage.reasoning += current.reasoning ?? 0;
		usage.totalTokens += current.totalTokens ?? 0;
		usage.costUsd += current.cost?.total ?? 0;
	}
	const toolCalls = events
		.filter((event) => event.type === "tool_execution_start")
		.map((event) => ({ name: event.toolName, args: event.args }));
	const assistantTurns = assistantMessages.map((message, index) => ({
		index: index + 1,
		stopReason: message.stopReason,
		usage: message.usage ?? {},
		textChars: message.content?.filter((block) => block.type === "text").reduce((sum, block) => sum + block.text.length, 0) ?? 0,
		toolCalls: message.content?.filter((block) => block.type === "toolCall").map((block) => ({ name: block.name, arguments: block.arguments })) ?? [],
	}));
	const finalMessage = [...assistantMessages].reverse().find((message) => message.stopReason !== "toolUse") ?? assistantMessages.at(-1);
	const answer = finalMessage?.content?.filter((block) => block.type === "text").map((block) => block.text).join("\n") ?? "";
	return {
		usage: { ...usage, logicalInput: usage.input + usage.cacheRead + usage.cacheWrite },
		toolCalls,
		assistantTurns,
		toolCounts: Object.fromEntries([...new Set(toolCalls.map((call) => call.name))].map((name) => [name, toolCalls.filter((call) => call.name === name).length])),
		turns: assistantMessages.length,
		answer,
		stopReason: finalMessage?.stopReason,
		errors: assistantMessages.filter((message) => message.stopReason === "error").map((message) => message.errorMessage ?? "unknown error"),
	};
}

export function gradeAnswer(task, answer) {
	const normalized = answer.toLowerCase().replaceAll("\\", "/");
	const paths = task.requiredPaths.map((path) => ({ value: path, found: normalized.includes(path.toLowerCase()) }));
	const concepts = task.concepts.map((concept) => ({ value: concept, found: normalized.includes(concept.toLowerCase()) }));
	const hits = [...paths, ...concepts].filter((item) => item.found).length;
	const total = paths.length + concepts.length;
	return { score: total ? hits / total : null, paths, concepts };
}

async function repositoryFingerprint(repo) {
	const commit = await runProcess("git", ["rev-parse", "HEAD"], { cwd: repo });
	const diff = await runProcess("git", ["diff", "--binary", "HEAD"], { cwd: repo });
	const untracked = await runProcess("git", ["ls-files", "--others", "--exclude-standard"], { cwd: repo });
	return {
		commit: commit.stdout.trim(),
		dirty: Boolean(diff.stdout || untracked.stdout),
		workingTreeHash: createHash("sha256").update(diff.stdout).update(untracked.stdout).digest("hex"),
	};
}

async function indexRepository(repo, embedding) {
	const startedAt = Date.now();
	const args = ["index", ".", "--rebuild", "--embedding", embedding, "--mode", "direct"];
	for (const glob of sourceGlobs) args.push("--glob", glob);
	console.log(`Indexing ${repo} with ${embedding}...`);
	const result = await runProcess("zg", args, { cwd: repo, capture: false });
	if (result.code !== 0) throw new Error(`zg index failed with exit code ${result.code}`);
	const meta = { repo, embedding, sourceGlobs, durationMs: Date.now() - startedAt, createdAt: new Date().toISOString(), repository: await repositoryFingerprint(repo) };
	await writeFile(join(here, "index-meta.json"), JSON.stringify(meta, null, 2) + "\n");
	console.log(`Index ready in ${(meta.durationMs / 1000).toFixed(1)}s.`);
}

function runPrompt(task) {
	if (task.promptVerbatim) return task.question;
	return [
		"Answer this repository-comprehension question by inspecting the current repository with the available read-only tools.",
		"Do not modify files. Ground every claim in source code. Cite repository-relative file paths and relevant symbols or line ranges.",
		"Prefer a concise but complete answer. Stop searching once you have enough evidence.",
		"",
		task.question,
	].join("\n");
}

async function runOne({ repo, model, thinking, profile, task, attempt }) {
	const tools = profile === "zg" ? "read,grep,find,ls,zvec_grep_search" : "read,grep,find,ls";
	const args = [
		"--mode", "json", "--no-session", "--model", model, "--thinking", thinking,
		"--no-extensions", "--no-skills", "--no-prompt-templates", "--no-themes", "--no-context-files",
		"--tools", tools,
	];
	if (profile === "zg") args.push("--extension", zgExtension, "--append-system-prompt", zgGuidance);
	args.push(runPrompt(task));
	const startedAt = Date.now();
	const result = await runProcess("pi", args, { cwd: repo });
	const durationMs = Date.now() - startedAt;
	if (result.code !== 0) throw new Error(`pi failed (${result.code}): ${result.stderr.slice(-2000)}`);
	const parsed = parsePiJson(result.stdout);
	return {
		taskId: task.id,
		profile,
		attempt,
		durationMs,
		...parsed,
		grade: gradeAnswer(task, parsed.answer),
		stderr: result.stderr.trim(),
	};
}

function mean(values) {
	const numeric = values.filter((value) => typeof value === "number" && Number.isFinite(value));
	return numeric.length ? numeric.reduce((sum, value) => sum + value, 0) / numeric.length : null;
}
function percentChange(before, after) { return typeof before === "number" && before !== 0 && typeof after === "number" ? ((after - before) / before) * 100 : null; }

export function summarize(runs) {
	const aggregate = {};
	for (const profile of ["baseline", "zg"]) {
		const selected = runs.filter((run) => run.profile === profile);
		aggregate[profile] = {
			runs: selected.length,
			quality: mean(selected.map((run) => run.grade.score)),
			input: mean(selected.map((run) => run.usage.input)),
			logicalInput: mean(selected.map((run) => run.usage.logicalInput)),
			output: mean(selected.map((run) => run.usage.output)),
			reasoning: mean(selected.map((run) => run.usage.reasoning)),
			cacheRead: mean(selected.map((run) => run.usage.cacheRead)),
			cacheWrite: mean(selected.map((run) => run.usage.cacheWrite)),
			toolCalls: mean(selected.map((run) => run.toolCalls.length)),
			turns: mean(selected.map((run) => run.turns)),
			durationMs: mean(selected.map((run) => run.durationMs)),
		};
	}
	const changes = {};
	for (const metric of ["quality", "input", "logicalInput", "output", "reasoning", "toolCalls", "turns", "durationMs"]) {
		changes[metric] = percentChange(aggregate.baseline[metric], aggregate.zg[metric]);
	}
	return { aggregate, changes };
}

function printSummary(summary) {
	const { baseline, zg } = summary.aggregate;
	console.log("\nmetric             baseline          zg       change");
	for (const [key, label] of [["quality", "quality proxy"], ["input", "input tokens"], ["logicalInput", "logical input"], ["output", "output tokens"], ["reasoning", "reasoning tokens"], ["toolCalls", "tool calls"], ["turns", "model turns"], ["durationMs", "wall time ms"]]) {
		const change = summary.changes[key];
		const display = (value) => typeof value === "number" ? value.toFixed(1) : "n/a";
		console.log(`${label.padEnd(18)}${display(baseline[key]).padStart(10)}${display(zg[key]).padStart(12)}${(change === null ? "n/a" : `${change >= 0 ? "+" : ""}${change.toFixed(1)}%`).padStart(13)}`);
	}
}

async function runBenchmark(options) {
	const repo = resolve(String(options.repo ?? defaultRepo));
	const tasksPath = resolve(String(options.tasks ?? defaultTasks));
	const model = String(options.model ?? "openai-codex/gpt-5.6-luna");
	const thinking = String(options.thinking ?? "max");
	const attempts = Number(options.attempts ?? 1);
	const limit = Number(options.limit ?? Number.POSITIVE_INFINITY);
	const offset = Number(options.offset ?? 0);
	const requestedProfile = String(options.profile ?? "all");
	const profiles = requestedProfile === "all" ? ["baseline", "zg"] : [requestedProfile];
	if (!profiles.every((profile) => ["baseline", "zg"].includes(profile))) throw new Error("--profile must be baseline, zg, or all");
	const loadedTasks = JSON.parse(await readFile(tasksPath, "utf8"));
	const filteredTasks = options["task-id"] ? loadedTasks.filter((task) => task.id === options["task-id"]) : loadedTasks;
	const tasks = filteredTasks.slice(offset, offset + limit);
	if (tasks.length === 0) throw new Error("No tasks selected");
	for (const task of tasks) for (const path of task.requiredPaths) await readFile(join(repo, path));
	if (profiles.includes("zg")) {
		const status = await runProcess("zg", ["status", ".", "--mode", "direct", "--check-ready"], { cwd: repo });
		if (status.code !== 0) throw new Error(`zg index is not ready. Run: node ${basename(import.meta.filename)} index --repo ${repo}`);
	}

	const plan = [];
	for (let attempt = 1; attempt <= attempts; attempt++) {
		for (let taskIndex = 0; taskIndex < tasks.length; taskIndex++) {
			const order = (taskIndex + attempt) % 2 ? profiles : [...profiles].reverse();
			for (const profile of order) plan.push({ task: tasks[taskIndex], profile, attempt });
		}
	}
	const outputDir = resolve(String(options.output ?? join(here, "runs")));
	await mkdir(outputDir, { recursive: true });
	const outputPath = join(outputDir, `${new Date().toISOString().replaceAll(":", "-")}.json`);
	const document = { schemaVersion: 1, createdAt: new Date().toISOString(), repo, repository: await repositoryFingerprint(repo), model, thinking, attempts, tasksPath, runs: [] };
	for (const [index, item] of plan.entries()) {
		console.log(`[${index + 1}/${plan.length}] ${item.task.id} / ${item.profile} / attempt ${item.attempt}`);
		const run = await runOne({ repo, model, thinking, ...item });
		document.runs.push(run);
		await writeFile(outputPath, JSON.stringify(document, null, 2) + "\n");
		const quality = typeof run.grade.score === "number" ? `${(run.grade.score * 100).toFixed(0)}%` : "n/a";
		console.log(`  ${run.toolCalls.length} tools, ${run.usage.logicalInput} logical input tokens, quality ${quality}, ${(run.durationMs / 1000).toFixed(1)}s`);
	}
	document.summary = summarize(document.runs);
	await writeFile(outputPath, JSON.stringify(document, null, 2) + "\n");
	printSummary(document.summary);
	console.log(`\nRaw results: ${outputPath}`);
}

async function report(path) {
	const document = JSON.parse(await readFile(resolve(path), "utf8"));
	printSummary(document.summary ?? summarize(document.runs));
}

async function main() {
	const { command, options } = parseArgs(process.argv.slice(2));
	if (command === "index") await indexRepository(resolve(String(options.repo ?? defaultRepo)), String(options.embedding ?? "local/potion-code-16m-v2"));
	else if (command === "run") await runBenchmark(options);
	else if (command === "report" && options.file) await report(String(options.file));
	else {
		console.log("Usage:\n  node bench.mjs index [--repo PATH] [--embedding MODEL]\n  node bench.mjs run [--repo PATH] [--tasks FILE] [--task-id ID] [--attempts N] [--offset N] [--limit N] [--profile all|baseline|zg]\n  node bench.mjs report --file RUN.json");
	}
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
	main().catch((error) => { console.error(error.stack ?? error.message); process.exitCode = 1; });
}
