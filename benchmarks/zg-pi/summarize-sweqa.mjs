#!/usr/bin/env node
import { readdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const runsDir = join(here, "runs");
const taskIds = new Set(JSON.parse(await readFile(join(here, "swe-qa-smoke.json"), "utf8")).map((task) => task.id));
const pairs = [];
for (const file of (await readdir(runsDir)).sort()) {
	const document = JSON.parse(await readFile(join(runsDir, file), "utf8"));
	if (document.runs?.length !== 2 || !document.runs.every((run) => taskIds.has(run.taskId))) continue;
	const baseline = document.runs.find((run) => run.profile === "baseline");
	const zg = document.runs.find((run) => run.profile === "zg");
	if (baseline && zg) pairs.push({ taskId: baseline.taskId, file, baseline, zg });
}
if (!pairs.length) throw new Error("No paired SWE-QA runs found");

const metrics = {
	input: (run) => run.usage.input,
	logicalInput: (run) => run.usage.logicalInput,
	output: (run) => run.usage.output,
	reasoning: (run) => run.usage.reasoning,
	toolCalls: (run) => run.toolCalls.length,
	turns: (run) => run.turns,
	durationMs: (run) => run.durationMs,
};
const change = (before, after) => ((after - before) / before) * 100;
const mean = (values) => values.reduce((sum, value) => sum + value, 0) / values.length;
const median = (values) => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)];
const summary = {};
for (const [name, get] of Object.entries(metrics)) {
	const changes = pairs.map(({ baseline, zg }) => change(get(baseline), get(zg)));
	summary[name] = {
		meanPairedChangePercent: mean(changes),
		medianPairedChangePercent: median(changes),
		zgWins: changes.filter((value) => value < 0).length,
		pairs: changes.length,
		pooledChangePercent: change(pairs.reduce((sum, pair) => sum + get(pair.baseline), 0), pairs.reduce((sum, pair) => sum + get(pair.zg), 0)),
	};
}
const result = {
	createdAt: new Date().toISOString(),
	pairCount: pairs.length,
	taskCounts: Object.fromEntries([...taskIds].map((id) => [id, pairs.filter((pair) => pair.taskId === id).length])),
	summary,
	pairs: pairs.map(({ taskId, file, baseline, zg }) => ({
		taskId,
		file,
		baseline: Object.fromEntries(Object.entries(metrics).map(([name, get]) => [name, get(baseline)])),
		zg: Object.fromEntries(Object.entries(metrics).map(([name, get]) => [name, get(zg)])),
		zgToolCalls: zg.toolCounts.zvec_grep_search ?? 0,
	})),
};
await writeFile(join(runsDir, "sweqa-summary.json"), JSON.stringify(result, null, 2) + "\n");
console.log("metric          mean paired     median    wins     pooled");
for (const [name, row] of Object.entries(summary)) {
	const pct = (value) => `${value >= 0 ? "+" : ""}${value.toFixed(1)}%`;
	console.log(`${name.padEnd(17)}${pct(row.meanPairedChangePercent).padStart(10)}${pct(row.medianPairedChangePercent).padStart(11)}${`${row.zgWins}/${row.pairs}`.padStart(9)}${pct(row.pooledChangePercent).padStart(11)}`);
}
console.log(`\n${pairs.length} paired runs. Raw summary: ${join(runsDir, "sweqa-summary.json")}`);
