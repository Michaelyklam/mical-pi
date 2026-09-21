import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import {
	classify,
	MIN_ANCHOR,
	PRETTY_ANCHOR,
} from "./patch-pi-ai-openrouter-cost.mjs";

const prettyFixture = [
	"function parseChunkUsage(rawUsage, model) {",
	"    const usage = { input: 1, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };",
	PRETTY_ANCHOR,
	"    return usage;",
	"}",
	"",
].join("\n");

const minFixture = `function parseChunkUsage(rawUsage,model){let usage={input:1};${MIN_ANCHOR}}\n`;

test("patch rewrites the pretty pi-ai source to preserve usage.reportedCost", () => {
	const plan = classify(prettyFixture);
	assert.equal(plan.status, "stale");
	const patched = plan.patch(prettyFixture);
	assert.ok(patched.includes("PI_REPORTED_COST_PATCH"));
	assert.ok(patched.includes("model.provider === \"openrouter\""));
	assert.ok(patched.includes("usage.reportedCost = {"));
	// The original estimate hook is preserved.
	assert.ok(patched.includes(PRETTY_ANCHOR));
	// Idempotent: a second pass has nothing to do.
	assert.equal(classify(patched).status, "current");
});

test("patch rewrites the minified host bundle form", () => {
	const plan = classify(minFixture);
	assert.equal(plan.status, "stale");
	const patched = plan.patch(minFixture);
	assert.ok(patched.includes("PI_REPORTED_COST_PATCH"));
	assert.ok(patched.includes("usage.reportedCost={amount:reportedCost"));
	assert.ok(patched.includes(MIN_ANCHOR));
	assert.equal(classify(patched).status, "current");
});

test("patch refuses source it does not recognize instead of guessing", () => {
	assert.equal(classify("function parseChunkUsage() { return {}; }").status, "unsupported");
});

test("all discovered pi-ai copies are currently patched", () => {
	const script = fileURLToPath(new URL("./patch-pi-ai-openrouter-cost.mjs", import.meta.url));
	execFileSync(process.execPath, [script, "--check"], { stdio: "pipe" });
});
