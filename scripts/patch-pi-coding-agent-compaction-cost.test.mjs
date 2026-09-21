import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { classify, MIN_ANCHOR, PRETTY_ANCHOR } from "./patch-pi-coding-agent-compaction-cost.mjs";

const MARKER = "PI_BILLING_COMPONENTS_PATCH";

const prettyFixture = [
	"function combineUsage(first, second) {",
	"    return {",
	"        input: first.input + second.input,",
	"        cost: {",
	"            input: first.cost.input + second.cost.input,",
	PRETTY_ANCHOR,
	"",
].join("\n");

const minFixture = `function combineUsage(first,second){return{input:first.input+second.input,cost:{input:first.cost.input+second.cost.input,${MIN_ANCHOR}\n`;

test("patch keeps each call in the unbundled combineUsage", () => {
	const plan = classify(prettyFixture);
	assert.equal(plan.status, "stale");
	const patched = plan.patch(prettyFixture);
	assert.ok(patched.includes(MARKER));
	assert.ok(patched.includes("billingComponents: ["));
	assert.ok(patched.includes("first.billingComponents"));
	// The merged token/cost totals are preserved.
	assert.ok(patched.includes("total: first.cost.total + second.cost.total,"));
	new Function(patched);
	// Idempotent: a second pass has nothing to do.
	assert.equal(classify(patched).status, "current");
});

test("patch keeps each call in the minified host bundle, including both copies", () => {
	// The bundle holds two definitions of combineUsage; both must be rewritten.
	const source = minFixture + minFixture;
	const plan = classify(source);
	assert.equal(plan.status, "stale");
	const patched = plan.patch(source);
	assert.equal(patched.split(MARKER).length - 1, 2);
	assert.ok(patched.includes("first.billingComponents"));
	assert.ok(patched.includes("total:first.cost.total+second.cost.total},"));
	new Function(patched);
	assert.equal(classify(patched).status, "current");
});

test("patch refuses source it does not recognize instead of guessing", () => {
	assert.equal(classify("function combineUsage() { return {}; }").status, "unsupported");
});

test("all discovered pi-coding-agent copies are currently patched", () => {
	const script = fileURLToPath(new URL("./patch-pi-coding-agent-compaction-cost.mjs", import.meta.url));
	execFileSync(process.execPath, [script, "--check"], { stdio: "pipe" });
});
