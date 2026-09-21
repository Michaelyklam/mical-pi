/**
 * Integration tests for the vendored self-compact extension against the INSTALLED Pi.
 *
 * These load the real `extensions/self-compact/index.ts` through Pi's real extension loader
 * (jiti + registerTool/registerFlag/registerCommand/on) and drive the handlers with a fake
 * `ExtensionContext` whose `modelRegistry.complete` is scripted. That proves, on the installed
 * Pi 0.84.4:
 *   - every lifecycle hook the extension registers is accepted and fired by the loader,
 *   - `terminate: true` is returned from `self_compact` (Pi's early-termination contract),
 *   - `session_before_compact` cancellation (native auto-compaction stays off),
 *   - `ctx.compact()` is invoked from `agent_settled`,
 *   - the native `compact()` engine runs with the vendored compaction prompt,
 *   - `view_context` reports the fixed-baseline thresholds (1M and the 272k gpt-6-astra window).
 *
 * They do NOT spawn the CLI or hit a provider. Real end-to-end RPC coverage lives upstream.
 */
import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const ENTRY = join(HERE, "index.ts");
const PI_DIST = resolve(HERE, "..", "..", "node_modules", "@earendil-works", "pi-coding-agent", "dist");
const loader: any = await import(pathToFileURL(join(PI_DIST, "core", "extensions", "loader.js")).href);

type Dict = Record<string, any>;

const EXPECTED_HOOKS = [
	"session_start",
	"session_tree",
	"session_shutdown",
	"model_select",
	"before_agent_start",
	"context",
	"message_end",
	"tool_call",
	"agent_end",
	"agent_settled",
	"session_before_compact",
	"session_compact",
	"session_compact_failed",
];

function seedEntries(chars = 2000): any[] {
	const usage = { input: 10, output: 10, cacheRead: 0, cacheWrite: 0, totalTokens: 20, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
	return [
		{ type: "message", id: "seed-1", parentId: null, timestamp: "2026-01-01T00:00:00.000Z", message: { role: "user", content: "seed prompt ".repeat(chars / 12), timestamp: 1 } },
		{ type: "message", id: "seed-2", parentId: "seed-1", timestamp: "2026-01-01T00:00:01.000Z", message: { role: "assistant", content: [{ type: "text", text: "seed answer ".repeat(chars / 12) }], api: "openai-completions", provider: "fake", model: "test-model", usage, stopReason: "stop", timestamp: 2 } },
		{ type: "message", id: "seed-3", parentId: "seed-2", timestamp: "2026-01-01T00:00:02.000Z", message: { role: "user", content: "current prompt", timestamp: 3 } },
	];
}

function summaryEvent(overrides: Dict = {}): Dict {
	return {
		reason: "manual",
		signal: new AbortController().signal,
		preparation: {
			messagesToSummarize: [{ role: "user", content: "Implement parser. Tests remain pending.", timestamp: 1 }],
			turnPrefixMessages: [],
			isSplitTurn: false,
			firstKeptEntryId: "keep",
			tokensBefore: 80000,
			settings: { enabled: true, reserveTokens: 16384, keepRecentTokens: 1500 },
			fileOps: { read: new Set(["README.md"]), written: new Set(["parser.ts"]), edited: new Set() },
			...overrides,
		},
	};
}

async function host(
	t: TestContext,
	options: {
		flags?: Dict;
		settings?: Dict;
		window?: number;
		/** Resume: reuse the entries of another host so this instance recovers its branch. */
		entries?: any[];
	} = {},
) {
	const { flags = {}, settings = { compaction: { keepRecentTokens: 100 } }, window = 200_000 } = options;
	const cwd = mkdtempSync(join(tmpdir(), "self-compact-it-"));
	mkdirSync(join(cwd, ".pi"), { recursive: true });
	writeFileSync(join(cwd, ".pi", "settings.json"), JSON.stringify(settings));

	const loaded: any = await loader.loadExtensions([ENTRY], cwd);
	assert.deepEqual(loaded.errors, []);
	const extension = loaded.extensions[0];

	const entries: any[] = options.entries ?? seedEntries();
	const messages: any[] = [];
	const notices: any[] = [];
	const compactions: any[] = [];
	const requests: any[] = [];
	let tokens = 0;
	let footer: any;

	for (const [key, value] of Object.entries(flags)) loaded.runtime.flagValues.set(key, value);
	loaded.runtime.appendEntry = (customType: string, data: any) => entries.push({ type: "custom", customType, data });
	// Pi journals every sent custom message on the branch; model it so reload recovery sees what the model saw.
	loaded.runtime.sendMessage = (message: any, messageOptions: any) => {
		messages.push({ ...message, options: messageOptions });
		entries.push({ type: "custom_message", id: `m${messages.length}`, parentId: entries.at(-1)?.id ?? null, timestamp: new Date().toISOString(), customType: message.customType, content: message.content, display: message.display, details: message.details });
	};
	loaded.runtime.getActiveTools = () => [...extension.tools.keys()];

	const ctx: any = {
		cwd,
		mode: "tui",
		hasUI: true,
		thinkingLevel: "off",
		model: { id: "test-model", provider: "fake", contextWindow: window, maxTokens: 8192, api: "openai-completions", reasoning: true },
		sessionManager: {
			getBranch: () => entries,
			// What the model still sees: everything after the last compaction entry (Pi replaces the rest with the summary).
			buildContextEntries: () => {
				const last = entries.findLastIndex((entry: any) => entry.type === "compaction");
				return last < 0 ? entries : entries.slice(last);
			},
		},
		getContextUsage: () => ({ tokens, contextWindow: window, percent: tokens / window * 100 }),
		isIdle: () => true,
		compact: (compactOptions: any) => compactions.push(compactOptions),
		ui: {
			notify: (message: string, type: string) => notices.push({ message, type }),
			setFooter: (factory: any) => { footer = factory; },
			setStatus() {},
		},
		modelRegistry: {
			complete: async (_model: any, request: any, requestOptions: any) => {
				requests.push({ request, options: requestOptions });
				return {
					role: "assistant", api: "openai-completions", provider: "fake", model: "test-model", timestamp: 1, stopReason: "stop",
					content: [{ type: "text", text: "Verified summary." }],
					usage: { input: 10, output: 10, totalTokens: 20, cacheRead: 0, cacheWrite: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
				};
			},
		},
	};

	const emit = async (name: string, event: Dict = {}): Promise<any> => {
		let result: any;
		for (const handler of extension.handlers.get(name) ?? []) result = await handler(event, ctx);
		return result;
	};

	t.after(async () => {
		await emit("session_shutdown", { reason: "quit" });
		rmSync(cwd, { recursive: true, force: true });
	});

	await emit("session_start", { reason: "start" });

	return {
		extension, ctx, entries, messages, notices, compactions, requests, emit,
		usage: (value: number) => { tokens = value; },
		infoData: (): any => entries.filter((entry: any) => entry.customType === "self-compact-info").at(-1)?.data,
		execute: (note = "NEXT ACTION: continue") =>
			extension.tools.get("self_compact").definition.execute("call", { note_to_self: note }, undefined, undefined, ctx),
		definition: (name = "self_compact") => extension.tools.get(name).definition,
		/** Every model-facing trigger message sent so far (threshold guidance and nudges share one customType). */
		sent: () => messages.filter((m: any) => m.customType === "self-compact-guidance"),
		/** Model a landed compaction: Pi appends the compaction entry, then fires session_compact. */
		compacted: async () => {
			entries.push({ type: "compaction", id: `k${entries.length}`, parentId: entries.at(-1)?.id ?? null, timestamp: new Date().toISOString(), summary: "summary", firstKeptEntryId: null, tokensBefore: tokens, details: {} });
			await emit("session_compact", { reason: "manual", compactionEntry: entries.at(-1) });
		},
		view: () => extension.tools.get("view_context").definition.execute("view", {}, undefined, undefined, ctx),
		info: () => extension.commands.get("self-compact-info").handler("", ctx),
		footerFactory: () => footer,
		footer: () => footer({ requestRender() {} }, { fg: (_color: string, text: string) => text, bold: (text: string) => text }).render(100)[0],
	};
}

test("discovery: the package subdirectory exposes exactly index.ts (helpers are not entry points)", async (t) => {
	const root = mkdtempSync(join(tmpdir(), "self-compact-discovery-"));
	const extDir = join(root, "extensions");
	const cwd = join(root, "cwd");
	const agentDir = join(root, "agent");
	mkdirSync(extDir, { recursive: true });
	mkdirSync(cwd, { recursive: true });
	mkdirSync(agentDir, { recursive: true });
	symlinkSync(HERE, join(extDir, "self-compact"), "dir");
	t.after(() => rmSync(root, { recursive: true, force: true }));

	const discovered: any = await loader.discoverAndLoadExtensions([extDir], cwd, agentDir);
	assert.deepEqual(discovered.errors, []);
	const paths = discovered.extensions.map((extension: any) => realpathSync(extension.path));
	assert.equal(paths.length, 1, `expected one entry point, got ${JSON.stringify(paths)}`);
	assert.equal(paths[0], realpathSync(ENTRY));
	for (const helper of ["defaults.ts", "thresholds.ts", "summary.ts", "state.ts", "prompts.ts", "context-bar.ts", "guidance.ts"]) {
		assert.ok(!paths.some((path: string) => path.endsWith(`/self-compact/${helper}`)), `${helper} must not be loaded as an extension`);
	}
});

test("lifecycle: every registered hook, tool, command, flag and renderer loads on the installed Pi", async (t) => {
	const h = await host(t);
	for (const hook of EXPECTED_HOOKS) {
		assert.ok((h.extension.handlers.get(hook)?.length ?? 0) >= 1, `missing ${hook} handler`);
	}
	assert.deepEqual([...h.extension.tools.keys()].sort(), ["self_compact", "view_context"]);
	assert.deepEqual([...h.extension.commands.keys()].sort(), ["self-compact-info", "self-compact-now"]);
	assert.deepEqual([...h.extension.flags.keys()].sort(), ["compact-at", "compact-buffer", "compact-footer", "compact-prompt", "compact-soft-at"]);
	assert.deepEqual([...(h.extension.entryRenderers?.keys() ?? [])].sort(), ["self-compact-info"]);
	assert.deepEqual([...h.extension.messageRenderers.keys()].sort(), ["self-compact-guidance", "self-compact-handoff"]);
});

test("view_context reports the fixed 1M-baseline defaults on a 1,000,000-token window", async (t) => {
	const h = await host(t, { window: 1_000_000 });
	h.usage(150_000);
	const view = JSON.parse((await h.view()).content[0].text);
	assert.equal(view.used_tokens, 150_000);
	assert.equal(view.context_window, 1_000_000);
	assert.equal(view.level, "notice");
	assert.deepEqual(view.thresholds, {
		notice: { tokens: 100_000, percent: 10 },
		warning: { tokens: 200_000, percent: 20 },
		hard_cutoff: { tokens: 300_000, percent: 30 },
	});
	assert.equal(view.tokens_until_warning, 50_000);
	assert.equal(view.tokens_until_hard_cutoff, 150_000);
});

test("view_context caps the forced line at 90% on the 272,000-token gpt-6-astra window", async (t) => {
	const h = await host(t, { window: 272_000 });
	h.usage(100_000);
	const view = JSON.parse((await h.view()).content[0].text);
	assert.equal(view.thresholds.notice.tokens, 100_000);
	assert.equal(view.thresholds.warning.tokens, 200_000);
	assert.equal(view.thresholds.hard_cutoff.tokens, 244_800);
	assert.equal(view.thresholds.hard_cutoff.percent, 90);
	assert.equal(view.level, "notice");
});

test("native auto-compaction is cancelled and the forced lock blocks ordinary tools", async (t) => {
	const h = await host(t, { settings: { compaction: { keepRecentTokens: 100, enabled: true } } });
	assert.deepEqual(await h.emit("session_before_compact", { reason: "threshold" }), { cancel: true });
	assert.deepEqual(await h.emit("session_before_compact", { reason: "overflow" }), { cancel: true });
	assert.equal(await h.emit("tool_call", { toolName: "read" }), undefined, "below the forced line nothing is blocked");
	h.usage(180_000); // forced on the 200k window (capped at 90%)
	const blocked = await h.emit("tool_call", { toolName: "read" });
	assert.equal(blocked.block, true);
	assert.match(blocked.reason, /forced threshold/);
});

test("self_compact returns terminate, saves the note, and agent_settled starts ctx.compact()", async (t) => {
	const h = await host(t);
	h.usage(180_000);
	const blocked = await h.emit("tool_call", { toolName: "read" });
	assert.equal(blocked.block, true);
	assert.match(blocked.reason, /self_compact/);
	assert.equal(await h.emit("tool_call", { toolName: "self_compact" }), undefined, "self_compact is always allowed");

	const result = await h.execute("NEXT ACTION: finish the parser");
	assert.equal(result.terminate, true, "Pi must end the run after the note is saved");
	assert.equal(result.details.noteChars, "NEXT ACTION: finish the parser".length);
	const state = h.entries.filter((entry: any) => entry.customType === "self-compact-state").at(-1).data;
	assert.equal(state.handoff.status, "pending");
	assert.equal(state.handoff.note, "NEXT ACTION: finish the parser");

	await h.emit("agent_settled");
	assert.equal(h.compactions.length, 1, "ctx.compact() runs once the agent is idle");
});

test("manual compaction runs Pi's native engine with the vendored prompt and returns the note verbatim", async (t) => {
	const h = await host(t);
	h.usage(180_000);
	const note = "GOAL: ship it\nNEXT ACTION: run the tests";
	await h.execute(note);

	const result = await h.emit("session_before_compact", summaryEvent());
	assert.ok(result.compaction, "manual compaction is not cancelled");
	assert.equal(h.requests.length, 1);
	assert.match(h.requests[0].request.systemPrompt, /context-compaction summarizer/, "vendored compaction prompt is the system prompt");
	assert.ok(h.requests[0].options.maxTokens <= 8192);
	const details = result.compaction.details;
	assert.ok(details.handoffId, "compaction details carry the durable handoff id");
	assert.match(String(details.selfCompact.promptSource), /self-compact\/prompts\/USER_PROMPT_COMPACTION_MESSAGE\.md$/);
	assert.deepEqual(result.compaction.details.readFiles, ["README.md"]);
	assert.deepEqual(result.compaction.details.modifiedFiles, ["parser.ts"]);

	await h.emit("session_compact", { reason: "manual", compactionEntry: { id: "c1", details } });
	const handoffMessages = () => h.messages.filter((message: any) => message.customType === "self-compact-handoff");
	assert.equal(handoffMessages().length, 1, "the handoff message is delivered after compaction");
	assert.equal(handoffMessages()[0].content, note, "the note is returned byte for byte");
	assert.equal(handoffMessages()[0].options.triggerTurn, true);

	await h.emit("message_end", { message: { role: "custom", customType: "self-compact-handoff", details: handoffMessages()[0].details } });
	const finalState = h.entries.filter((entry: any) => entry.customType === "self-compact-state").at(-1).data;
	assert.equal(finalState.handoff.status, "done");
	assert.equal(finalState.cycle, 1);
	h.usage(50_000); // the compaction shrank the context
	assert.equal((await h.view()).details.tools_locked, false, "the derived lock releases once the note is delivered");
});

test("the footer bar is opt-in so extensions/usage-footer keeps the footer by default", async (t) => {
	const off = await host(t);
	assert.equal(off.footerFactory(), undefined, "no footer is installed without --compact-footer");
	const on = await host(t, { flags: { "compact-footer": true } });
	assert.equal(typeof on.footerFactory(), "function", "--compact-footer installs the context bar");
	assert.match(on.footer(), /\[[#=~!|-]{20}\]/);
});

test("a rejected explicit flag override leaves the extension inert and blocks every tool", async (t) => {
	const h = await host(t, { flags: { "compact-soft-at": "300k", "compact-at": "200k", "compact-buffer": "100k" } });
	const blocked = await h.emit("tool_call", { toolName: "read" });
	assert.equal(blocked.block, true);
	assert.match(blocked.reason, /rejected its settings/);
	assert.ok(h.notices.some((notice) => notice.type === "error" && /REJECTED settings/.test(notice.message)));
	await assert.rejects(h.execute(), /inert/);
});


// ------------------------------------------------------------------ triggers

test("the tool-call trigger sends one CHECKPOINT mid-run and one RUN ENDED after a heavy run, once per cycle", async (t) => {
	const h = await host(t, { window: 1_000_000 });
	h.usage(50_000); // well below every threshold: only the tool-call trigger can speak
	const sys = await h.emit("before_agent_start", { systemPrompt: "BASE" });
	assert.match(sys.systemPrompt, /self-compact \(proactive\)/);
	assert.match(sys.systemPrompt, /do not wait for a threshold/);

	for (let i = 0; i < 9; i++) assert.equal(await h.emit("tool_call", { toolName: "read", toolCallId: `c${i}` }), undefined);
	assert.equal(h.sent().length, 0, "nine ordinary tool calls: nothing yet");
	assert.equal(await h.emit("tool_call", { toolName: "view_context", toolCallId: "v" }), undefined);
	assert.equal(h.sent().length, 0, "view_context does not count toward the trigger");
	await h.emit("tool_call", { toolName: "bash", toolCallId: "c9" });
	assert.equal(h.sent().length, 1, "the tenth ordinary tool call sends the checkpoint");
	assert.match(h.sent()[0].content, /^\[self-compact · CHECKPOINT\] 10 tool calls since the last compaction/);
	assert.match(h.sent()[0].content, /call `self_compact` as your only tool call/);
	assert.equal(h.sent()[0].details.key, "checkpoint");
	assert.equal(h.sent()[0].options.triggerTurn, false, "a mid-run message never starts a turn");

	for (let i = 10; i < 15; i++) await h.emit("tool_call", { toolName: "read", toolCallId: `c${i}` });
	assert.equal(h.sent().length, 1, "the checkpoint is sent once per cycle");

	await h.emit("agent_end");
	assert.equal(h.sent().length, 2, "a run with >= trigger tool calls gets a RUN ENDED follow-up");
	assert.match(h.sent()[1].content, /^\[self-compact · RUN ENDED\] That run used 15 tool calls \(15 since the last compaction/);
	assert.deepEqual(h.sent()[1].options, { triggerTurn: true, deliverAs: "followUp" });

	// The follow-up turn runs inside the same agent loop (no before_agent_start): a compaction
	// followed by another agent_end must not ask again.
	await h.compacted();
	await h.emit("agent_end");
	await h.emit("agent_end");
	assert.equal(h.sent().length, 2, "RUN ENDED is not re-fired after the compaction it asked for");
	const view = (await h.view()).details;
	assert.equal(view.tool_calls_since_compaction, 0, "compaction resets the counter");
	assert.equal(view.tool_call_trigger, 10);

	// A light run stays quiet; a heavy run in the new cycle fires again (once there is something to compact again).
	h.entries.push(...seedEntries().map((entry) => ({ ...entry, id: `post-${entry.id}` })));
	await h.emit("before_agent_start", { systemPrompt: "BASE" });
	await h.emit("tool_call", { toolName: "read", toolCallId: "d0" });
	await h.emit("agent_end");
	assert.equal(h.sent().length, 2, "a light run sends nothing");
	for (let i = 1; i <= 10; i++) await h.emit("tool_call", { toolName: "read", toolCallId: `d${i}` });
	assert.equal(h.sent().length, 3, "the checkpoint re-arms in the new cycle");
});

test("past the warning line the idle nudge wins over RUN ENDED, and threshold guidance fires once per level", async (t) => {
	const h = await host(t, { window: 1_000_000 });
	h.usage(150_000);
	await h.emit("before_agent_start", { systemPrompt: "BASE" });
	for (let i = 0; i < 12; i++) await h.emit("tool_call", { toolName: "read", toolCallId: `c${i}` });
	assert.deepEqual(h.sent().map((m: any) => m.details.key), ["notice", "checkpoint"]);

	h.usage(250_000);
	await h.emit("agent_end");
	assert.deepEqual(h.sent().map((m: any) => m.details.key), ["notice", "checkpoint", "warning", "now"]);
	await h.emit("agent_end");
	assert.equal(h.sent().length, 4, "the idle nudge is sent once per cycle");

	await h.emit("session_start", { reason: "reload" });
	await h.emit("context", { messages: [] });
	assert.equal(h.sent().length, 4, "a reload repeats nothing the model already has");
});

test("a saved note derives the lock and silences every trigger until the handoff is done", async (t) => {
	const h = await host(t, { window: 1_000_000 });
	h.usage(50_000);
	await h.execute("NEXT ACTION: continue");
	assert.equal((await h.view()).details.tools_locked, true);
	const blocked = await h.emit("tool_call", { toolName: "read", toolCallId: "x" });
	assert.equal(blocked.block, true);
	assert.match(blocked.reason, /note is saved and compaction is pending/);
	h.usage(250_000);
	await h.emit("agent_end");
	assert.equal(h.sent().length, 0, "no guidance or nudge while a note is waiting");
});
