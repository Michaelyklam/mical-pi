import assert from "node:assert/strict";
import { test } from "node:test";
import sessionAliases from "./index.ts";

type Command = {
	description?: string;
	handler: (args: string, ctx: unknown) => Promise<void> | void;
};

function harness() {
	const commands = new Map<string, Command>();
	const notifications: Array<{ message: string; level: string; context: "old" | "new" }> = [];
	let newSessionCalls = 0;

	const freshContext = {
		hasUI: true,
		ui: {
			notify: (message: string, level: string) => notifications.push({ message, level, context: "new" }),
		},
	};

	const oldContext = {
		ui: {
			notify: (message: string, level: string) => notifications.push({ message, level, context: "old" }),
		},
		newSession: async (options: { withSession?: (ctx: typeof freshContext) => Promise<void> }) => {
			newSessionCalls++;
			await options.withSession?.(freshContext);
			return { cancelled: false };
		},
	};

	const pi = {
		registerCommand: (name: string, command: Command) => commands.set(name, command),
	};

	// Structural test double: this extension only uses registerCommand.
	sessionAliases(pi as never);

	return {
		commands,
		notifications,
		get newSessionCalls() {
			return newSessionCalls;
		},
		run: async (args = "") => {
			const command = commands.get("clear");
			assert.ok(command, "/clear must be registered");
			await command.handler(args, oldContext);
		},
	};
}

test("registers /clear as an alias for /new", () => {
	const h = harness();
	const command = h.commands.get("clear");
	assert.ok(command);
	assert.match(command.description ?? "", /alias for \/new/);
});

test("starts a new session with no copied conversation", async () => {
	const h = harness();
	await h.run();
	assert.equal(h.newSessionCalls, 1);
});

test("uses only the replacement-session context after switching", async () => {
	const h = harness();
	await h.run();
	assert.deepEqual(h.notifications, [{ message: "New session started", level: "info", context: "new" }]);
});

test("accepts surrounding whitespace", async () => {
	const h = harness();
	await h.run("  \t  ");
	assert.equal(h.newSessionCalls, 1);
});

test("rejects arguments instead of silently discarding them", async () => {
	const h = harness();
	await h.run("unexpected");
	assert.equal(h.newSessionCalls, 0);
	assert.deepEqual(h.notifications, [{ message: "Usage: /clear", level: "warning", context: "old" }]);
});
