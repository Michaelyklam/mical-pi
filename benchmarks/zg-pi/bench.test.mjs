import assert from "node:assert/strict";
import { test } from "node:test";
import { gradeAnswer, parsePiJson, summarize } from "./bench.mjs";

const lines = [
	{ type: "message_end", message: { role: "assistant", stopReason: "toolUse", usage: { input: 100, output: 20, cacheRead: 50, cacheWrite: 10, reasoning: 8, totalTokens: 180, cost: { total: 0.01 } }, content: [{ type: "toolCall", name: "grep" }] } },
	{ type: "tool_execution_start", toolName: "grep", args: { pattern: "thing" } },
	{ type: "message_end", message: { role: "assistant", stopReason: "stop", usage: { input: 200, output: 40, cacheRead: 80, cacheWrite: 0, reasoning: 12, totalTokens: 320, cost: { total: 0.02 } }, content: [{ type: "text", text: "See src/a.ts" }] } },
].map(JSON.stringify).join("\n");

test("parsePiJson totals authoritative assistant usage and tool calls", () => {
	const parsed = parsePiJson(lines);
	assert.deepEqual(parsed.usage, { input: 300, output: 60, cacheRead: 130, cacheWrite: 10, reasoning: 20, totalTokens: 500, costUsd: 0.03, logicalInput: 440 });
	assert.equal(parsed.toolCalls.length, 1);
	assert.deepEqual(parsed.toolCounts, { grep: 1 });
	assert.equal(parsed.answer, "See src/a.ts");
});

test("gradeAnswer reports path and concept coverage", () => {
	const grade = gradeAnswer({ requiredPaths: ["src/a.ts", "src/b.ts"], concepts: ["lease", "cursor"] }, "The lease is in src/a.ts.");
	assert.equal(grade.score, 0.5);
	assert.deepEqual(grade.paths.map((item) => item.found), [true, false]);
});

test("summarize compares profile means", () => {
	const makeRun = (profile, input, tools) => ({ profile, usage: { input, logicalInput: input, output: 10, reasoning: 5, cacheRead: 0, cacheWrite: 0 }, toolCalls: Array(tools).fill({}), turns: 2, durationMs: 100, grade: { score: 1 } });
	const summary = summarize([makeRun("baseline", 100, 4), makeRun("zg", 50, 2)]);
	assert.equal(summary.changes.input, -50);
	assert.equal(summary.changes.toolCalls, -50);
});
