import assert from "node:assert/strict";
import { test } from "node:test";
import mcpHealth from "./index.ts";
import { MCP_STATUS_EVENT, STATUS_KEY } from "./status.ts";

type Handler = (data: unknown) => void;

/** Minimal stand-in for the parts of ExtensionAPI/ExtensionContext this extension uses. */
function harness(mode: "tui" | "print" = "tui") {
	const bus = new Map<string, Handler[]>();
	const lifecycle = new Map<string, Handler[]>();
	const statuses: Array<string | undefined> = [];

	const ctx = {
		mode,
		ui: {
			theme: { fg: (_color: string, text: string) => `<${text}>` },
			setStatus: (key: string, value?: string) => {
				assert.equal(key, STATUS_KEY, "must not write to another extension's footer key");
				statuses.push(value);
			},
		},
	};

	const pi = {
		events: {
			on: (channel: string, handler: Handler) => {
				bus.set(channel, [...(bus.get(channel) ?? []), handler]);
			},
		},
		on: (event: string, handler: (e: unknown, c: unknown) => void) => {
			lifecycle.set(event, [...(lifecycle.get(event) ?? []), (d) => handler(d, ctx)]);
		},
	};

	// biome-ignore lint/suspicious/noExplicitAny: structural test double
	mcpHealth(pi as any);

	return {
		statuses,
		publish: (snapshot: unknown) => {
			for (const h of bus.get(MCP_STATUS_EVENT) ?? []) h(snapshot);
		},
		startSession: () => {
			for (const h of lifecycle.get("session_start") ?? []) h({});
		},
		subscribed: () => (bus.get(MCP_STATUS_EVENT) ?? []).length,
	};
}

test("subscribes to the adapter's status channel", () => {
	assert.equal(harness().subscribed(), 1);
});

test("clears the footer while servers are healthy", () => {
	const h = harness();
	h.startSession();
	h.publish({ servers: [{ name: "hex", status: "cached" }] });
	assert.deepEqual(h.statuses, [undefined, undefined]);
});

test("writes a themed warning naming the broken server", () => {
	const h = harness();
	h.startSession();
	h.publish({ servers: [{ name: "hex", status: "failed", failedAgoSeconds: 5 }] });
	assert.equal(h.statuses.at(-1), "<MCP: hex failed 5s ago>");
});

test("renders a snapshot that arrived before the first session_start", () => {
	// Load order puts this extension ahead of pi-mcp-adapter, but the adapter also
	// publishes during its own init, so the first snapshot can precede session_start.
	const h = harness();
	h.publish({ servers: [{ name: "hex", status: "needs-auth" }] });
	assert.deepEqual(h.statuses, [], "nothing renders before a context exists");
	h.startSession();
	assert.equal(h.statuses.at(-1), "<MCP: hex needs auth>");
});

test("clears a previously shown warning once the server recovers", () => {
	const h = harness();
	h.startSession();
	h.publish({ servers: [{ name: "hex", status: "failed" }] });
	assert.equal(h.statuses.at(-1), "<MCP: hex failed>");
	h.publish({ servers: [{ name: "hex", status: "connected" }] });
	assert.equal(h.statuses.at(-1), undefined);
});

test("does not touch the footer outside tui mode", () => {
	const h = harness("print");
	h.startSession();
	h.publish({ servers: [{ name: "hex", status: "failed" }] });
	assert.deepEqual(h.statuses, []);
});

test("falls back to unthemed text when no theme is available", () => {
	const bus: Handler[] = [];
	const statuses: Array<string | undefined> = [];
	const ctx = { mode: "tui", ui: { setStatus: (_k: string, v?: string) => statuses.push(v) } };
	const pi = {
		events: { on: (_c: string, h: Handler) => bus.push(h) },
		on: (_e: string, h: (e: unknown, c: unknown) => void) => h({}, ctx),
	};
	// biome-ignore lint/suspicious/noExplicitAny: structural test double
	mcpHealth(pi as any);
	for (const h of bus) h({ servers: [{ name: "hex", status: "failed" }] });
	assert.equal(statuses.at(-1), "MCP: hex failed");
});
