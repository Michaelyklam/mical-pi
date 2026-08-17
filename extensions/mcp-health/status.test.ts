import assert from "node:assert/strict";
import { test } from "node:test";
import { describeProblem, formatMcpHealth } from "./status.ts";

const server = (name: string, status: string, extra: Record<string, unknown> = {}) => ({ name, status, ...extra });

test("stays silent when every server is healthy", () => {
	const snapshot = {
		servers: [server("hex", "connected"), server("notion", "cached"), server("idle", "not-connected")],
	};
	assert.equal(formatMcpHealth(snapshot), undefined);
});

test("cached is healthy, because lazy connect leaves servers cached at rest", () => {
	assert.equal(formatMcpHealth({ servers: [server("hex", "cached")] }), undefined);
});

test("stays silent with no servers configured", () => {
	assert.equal(formatMcpHealth({ servers: [] }), undefined);
});

test("names a failed server and its age", () => {
	const snapshot = { servers: [server("hex", "failed", { failedAgoSeconds: 12 })] };
	assert.equal(formatMcpHealth(snapshot), "MCP: hex failed 12s ago");
});

test("omits the age when the adapter did not supply one", () => {
	assert.equal(formatMcpHealth({ servers: [server("hex", "failed")] }), "MCP: hex failed");
});

test("reports a server needing auth", () => {
	assert.equal(formatMcpHealth({ servers: [server("hex", "needs-auth")] }), "MCP: hex needs auth");
});

test("names every offender while ignoring healthy peers", () => {
	const snapshot = {
		servers: [
			server("hex", "connected"),
			server("notion", "failed", { failedAgoSeconds: 3 }),
			server("github", "needs-auth"),
			server("linear", "cached"),
		],
	};
	assert.equal(formatMcpHealth(snapshot), "MCP: notion failed 3s ago, github needs auth");
});

test("ignores deliberately disabled servers", () => {
	const snapshot = { servers: [server("hex", "disabled", { disabled: true })] };
	assert.equal(formatMcpHealth(snapshot), undefined);
});

test("ignores a disabled server even if its status looks unhealthy", () => {
	const snapshot = { servers: [server("hex", "failed", { disabled: true })] };
	assert.equal(formatMcpHealth(snapshot), undefined);
});

test("surfaces an unrecognised status rather than swallowing it", () => {
	// Guards against the adapter renaming a failure state and this footer going
	// quiet: unknown statuses are reported, not assumed healthy.
	assert.equal(formatMcpHealth({ servers: [server("hex", "needsAuth")] }), "MCP: hex needsAuth");
});

test("returns undefined for malformed payloads instead of inventing a warning", () => {
	for (const bad of [undefined, null, 42, "nope", {}, { servers: null }, { servers: "hex" }]) {
		assert.equal(formatMcpHealth(bad), undefined, `expected undefined for ${JSON.stringify(bad) ?? "undefined"}`);
	}
});

test("skips malformed server entries but still reports valid siblings", () => {
	const snapshot = { servers: [null, { name: "" }, { status: "failed" }, server("hex", "failed")] };
	assert.equal(formatMcpHealth(snapshot), "MCP: hex failed");
});

test("rejects a negative or non-finite failure age", () => {
	assert.equal(describeProblem({ name: "hex", status: "failed", failedAgoSeconds: -1 }), "hex failed");
	assert.equal(describeProblem({ name: "hex", status: "failed", failedAgoSeconds: Number.NaN }), "hex failed");
});

test("rounds a fractional failure age", () => {
	assert.equal(describeProblem({ name: "hex", status: "failed", failedAgoSeconds: 12.6 }), "hex failed 13s ago");
});
