/** Real Pi extension loader and summary engine, scripted context. No provider requests.
 * Same-run AgentSession coverage is in lifecycle.test.ts; these isolate policy and recovery.
 */
import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const ENTRY = join(HERE, "index.ts");
const PI_DIST = resolve(HERE, "../../node_modules/@earendil-works/pi-coding-agent/dist");
const loader: any = await import(pathToFileURL(join(PI_DIST, "core/extensions/loader.js")).href);
type Dict = Record<string, any>;
const usage = { input: 10, output: 10, cacheRead: 0, cacheWrite: 0, totalTokens: 20, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
function answer(text: string): any {
	return { role: "assistant", content: [{ type: "text", text }], api: "openai-completions", provider: "fake", model: "test-model", usage, stopReason: "stop", timestamp: 2 };
}
function seedEntries(): any[] {
	return [
		{ type: "message", id: "s1", parentId: null, message: { role: "user", content: "Prior investigation. ".repeat(200), timestamp: 1 } },
		{ type: "message", id: "s2", parentId: "s1", message: answer("Verified findings. ".repeat(200)) },
		{ type: "message", id: "s3", parentId: "s2", message: { role: "user", content: "Implement the findings.", timestamp: 3 } },
	];
}
function summaryEvent(): Dict & { completions: Array<(outcome: Dict) => void> } {
	const completions: Array<(outcome: Dict) => void> = [];
	return {
		completions,
		// The operation-owned completion registration interface (patched core; optional on unpatched Pi).
		registerCompletion: (callback: (outcome: Dict) => void) => completions.push(callback),
		reason: "manual", signal: new AbortController().signal,
		preparation: {
			messagesToSummarize: [{ role: "user", content: "Implement parser. Tests remain pending.", timestamp: 1 }],
			turnPrefixMessages: [], isSplitTurn: false, firstKeptEntryId: "keep", tokensBefore: 80000,
			settings: { enabled: true, reserveTokens: 16384, keepRecentTokens: 100 },
			fileOps: { read: new Set(["README.md"]), written: new Set(["parser.ts"]), edited: new Set() },
		},
	};
}
async function host(t: TestContext, options: { flags?: Dict; window?: number; entries?: any[]; activeTools?: string[]; supported?: boolean; keep?: number } = {}) {
	const cwd = mkdtempSync(join(tmpdir(), "self-compact-it-"));
	mkdirSync(join(cwd, ".pi"));
	writeFileSync(join(cwd, ".pi/settings.json"), JSON.stringify({ compaction: { keepRecentTokens: options.keep ?? 100 } }));
	const loaded = await loader.loadExtensions([ENTRY], cwd);
	assert.deepEqual(loaded.errors, []);
	const extension = loaded.extensions[0];
	const entries = options.entries ?? seedEntries();
	const messages: any[] = [], notices: any[] = [], compactions: any[] = [], requests: any[] = [], userMessages: any[] = [];
	let tokens = 0, footer: any;
	const activeTools = options.activeTools ?? ["read", "self_compact", "view_context"];
	for (const [key, value] of Object.entries(options.flags ?? {})) loaded.runtime.flagValues.set(key, value);
	loaded.runtime.appendEntry = (customType: string, data: any) => entries.push({ type: "custom", customType, data });
	loaded.runtime.sendMessage = (message: any, sendOptions: any) => {
		messages.push({ ...message, options: sendOptions });
		entries.push({ ...message, type: "custom_message", id: `m${entries.length}` });
	};
	loaded.runtime.getActiveTools = () => activeTools;
	loaded.runtime.sendUserMessage = (text: string, opts?: any) => userMessages.push({ text, options: opts });
	const window = options.window ?? 272_000;
	const ctx: any = {
		cwd, mode: "tui", hasUI: true, thinkingLevel: "off",
		model: { id: "test-model", provider: "fake", contextWindow: window, maxTokens: 8192, api: "openai-completions", reasoning: true },
		sessionManager: {
			getBranch: () => entries,
			buildContextEntries: () => { const last = entries.findLastIndex(e => e.type === "compaction"); return last < 0 ? entries : entries.slice(last); },
		},
		getContextUsage: () => ({ tokens, contextWindow: window, percent: tokens / window * 100 }),
		isIdle: () => false,
		requestCompaction: options.supported === false ? undefined : (opts: any) => compactions.push(opts),
		abortCompaction: () => compactions.at(-1)?.onError(new Error("Compaction cancelled")),
		compact: () => assert.fail("Legacy abort-and-restart compaction must not be used"),
		ui: {
			notify: (message: string, type: string) => notices.push({ message, type }),
			setFooter: (factory: any) => { footer = factory; }, setStatus() {},
		},
		modelRegistry: { complete: async (_model: any, request: any, opts: any) => { requests.push({ request, options: opts }); return answer("Verified summary."); } },
	};
	const emit = async (name: string, event: Dict = {}) => {
		let result: any;
		for (const handler of extension.handlers.get(name) ?? []) result = await handler(event, ctx);
		return result;
	};
	t.after(async () => { await emit("session_shutdown", { reason: "quit" }); rmSync(cwd, { recursive: true, force: true }); });
	await emit("session_start", { reason: "start" });
	const definition = (name = "self_compact") => extension.tools.get(name).definition;
	return {
		extension, ctx, entries, messages, notices, compactions, requests, userMessages, emit, definition,
		usage: (value: number) => { tokens = value; },
		execute: (params: Dict = { note_to_self: "NEXT ACTION: implement the parser" }) => definition().execute("call", params, undefined, undefined, ctx),
		view: async () => (await definition("view_context").execute("view", {}, undefined, undefined, ctx)).details,
		state: () => entries.filter(e => e.customType === "self-compact-state").at(-1)?.data,
		sent: () => messages.filter(m => m.customType === "self-compact-guidance"),
		command: (name: string) => extension.commands.get(name).handler("", ctx),
		footer: () => footer,
	};
}

test("discovery exposes only the extension entry, not its helpers", async t => {
	const root = mkdtempSync(join(tmpdir(), "compact-discovery-"));
	for (const dir of ["extensions", "cwd", "agent"]) mkdirSync(join(root, dir));
	symlinkSync(HERE, join(root, "extensions/self-compact"), "dir");
	t.after(() => rmSync(root, { recursive: true, force: true }));
	const found = await loader.discoverAndLoadExtensions([join(root, "extensions")], join(root, "cwd"), join(root, "agent"));
	assert.deepEqual(found.errors, []);
	assert.deepEqual(found.extensions.map((e: any) => realpathSync(e.path)), [realpathSync(ENTRY)]);
});

test("tools, commands, flags and lifecycle hooks load on installed Pi", async t => {
	const h = await host(t);
	assert.deepEqual([...h.extension.tools.keys()].sort(), ["self_compact", "view_context"]);
	assert.deepEqual([...h.extension.commands.keys()].sort(), ["self-compact-cancel", "self-compact-info", "self-compact-now"]);
	assert.ok(h.extension.flags.has("compact-timeout-ms"));
	assert.equal(h.extension.handlers.has("input"), false, "no next-request gate");
	assert.equal(h.extension.handlers.has("agent_settled"), false, "no stop/restart lifecycle");
	for (const name of ["session_before_compact", "session_compact", "session_compact_failed", "context", "tool_call"]) assert.ok(h.extension.handlers.has(name));
});

test("threshold defaults use the fixed baseline and cap at 90% of the model window", async t => {
	for (const [window, hard] of [[1_000_000, 300_000], [272_000, 244_800]]) {
		const h = await host(t, { window }); h.usage(150_000);
		const v = await h.view();
		assert.equal(v.used_tokens, 150_000);
		assert.equal(v.level, "notice");
		assert.equal(v.thresholds.notice.tokens, 100_000);
		assert.equal(v.thresholds.warning.tokens, 200_000);
		assert.equal(v.thresholds.hard_cutoff.tokens, hard);
		assert.equal(v.tokens_until_warning, 50_000);
		assert.equal(v.compaction.timeout_ms, 300_000);
	}
});

test("many tool calls, task endings and new prompts never request compaction", async t => {
	const h = await host(t); h.usage(40_000);
	const prompt = await h.emit("before_agent_start", { systemPrompt: "BASE" });
	assert.match(prompt.systemPrompt, /between logical sections/);
	assert.match(prompt.systemPrompt, /If the task is complete, report completion and stop/);
	for (let i = 0; i < 30; i++) assert.equal(await h.emit("tool_call", { toolName: "read", toolCallId: `r${i}` }), undefined);
	await h.emit("agent_end"); await h.emit("agent_settled");
	for (const source of ["interactive", "rpc", "extension"]) assert.equal(await h.emit("input", { source, text: "Next request" }), undefined);
	assert.equal(h.sent().length, 0);
	assert.equal(h.compactions.length, 0);
	assert.equal((await h.view()).tool_call_trigger, undefined);
});

test("token thresholds append passive guidance once and survive reload", async t => {
	const h = await host(t, { window: 1_000_000 });
	for (const count of [150_000, 250_000, 320_000]) { h.usage(count); await h.emit("context"); await h.emit("agent_end"); }
	assert.deepEqual(h.sent().map(m => m.details.key), ["notice", "warning", "forced"]);
	assert.ok(h.sent().every(m => m.options.triggerTurn === false));
	await h.emit("session_start", { reason: "reload" }); await h.emit("context");
	assert.equal(h.sent().length, 3);
});

test("tool requests safe-point compaction immediately without terminating or rewriting the note", async t => {
	const h = await host(t, { flags: { "compact-timeout-ms": "1000" } });
	const note = "  GOAL: parser\nNEXT ACTION: implement it\n";
	const result = await h.execute({ note_to_self: note });
	assert.equal(result.terminate, undefined);
	assert.equal(h.compactions.length, 1);
	assert.equal(h.compactions[0].timeoutMs, 1000);
	assert.equal(h.state().handoff.note, note);
	assert.equal(h.state().handoff.status, "pending");
	assert.equal((await h.view()).tools_locked, true);
	await assert.rejects(h.execute({ note_to_self: "replacement" }), /already pending/);
	assert.equal(h.state().handoff.note, note);
	await h.emit("agent_settled");
	assert.equal(h.compactions.length, 1, "settling does not launch another compaction");
});

test("successful summary returns the exact note as passive context, with provenance", async t => {
	const h = await host(t); const note = "NEXT ACTION: run tests";
	await h.execute({ note_to_self: note });
	const event = summaryEvent();
	const result = await h.emit("session_before_compact", event);
	assert.equal(h.state().handoff.status, "compacting");
	assert.match(h.requests[0].request.systemPrompt, /context-compaction summarizer/);
	assert.ok(h.requests[0].options.maxTokens <= 8192);
	assert.deepEqual(result.compaction.details.readFiles, ["README.md"]);
	assert.deepEqual(result.compaction.details.modifiedFiles, ["parser.ts"]);
	assert.equal(typeof event.completions.at(-1), "function", "the hook registers completion on the event at entry");
	h.compactions[0].onComplete({ details: result.compaction.details });
	const returned = h.messages.filter(m => m.customType === "self-compact-handoff");
	assert.equal(returned.length, 1);
	assert.equal(returned[0].content, note);
	assert.equal(returned[0].options.triggerTurn, false, "never starts another model run");
	assert.equal(h.state().handoff.status, "done");
	assert.equal(h.state().cycle, 1);
	assert.equal((await h.view()).tools_locked, false);
	event.completions.at(-1)!({ committed: true, result: result.compaction });
	assert.equal((await h.view()).compaction.source, null, "the completion registration owns the in-flight bookkeeping");
	await h.emit("session_compact", { reason: "manual", compactionEntry: { details: result.compaction.details } });
	assert.equal(h.state().cycle, 1, "the delayed observation cannot redo the work");
});

test("note delivery rides the request completion callback, not the async event", async t => {
	const h = await host(t); const note = "NEXT ACTION: run tests";
	await h.execute({ note_to_self: note });
	const before = h.messages.length;
	const details = { handoffId: h.state().handoff.id };
	// Completion seam: no session_compact event is emitted at all.
	h.compactions[0].onComplete({ summary: "Summary", details });
	assert.equal(h.messages.length, before + 1, "the handoff is delivered without any session_compact event");
	const returned = h.messages.filter(m => m.customType === "self-compact-handoff");
	assert.equal(returned.length, 1);
	assert.equal(returned[0].content, note, "the exact note is returned");
	assert.equal(returned[0].options.triggerTurn, false);
	assert.equal(h.state().handoff.status, "done");
	assert.equal(h.state().cycle, 1);
	h.compactions[0].onComplete({ summary: "Summary", details }); // idempotent
	assert.equal(h.state().cycle, 1, "completion bookkeeping happens exactly once");
});

test("failed compaction at 40k unlocks ordinary tools, retains note, and accepts {} retry", async t => {
	const h = await host(t); h.usage(40_000);
	const note = "NEXT ACTION: original plan\n";
	await h.execute({ note_to_self: note });
	const id = h.state().handoff.id;
	h.compactions[0].onError(new Error("Compaction cancelled"));
	assert.equal(h.state().handoff.error, "Compaction cancelled");
	assert.equal((await h.view()).tools_locked, false);
	assert.equal(await h.emit("tool_call", { toolName: "read" }), undefined);
	await h.emit("agent_end"); await h.emit("agent_settled");
	assert.equal(h.compactions.length, 1, "no automatic retry");
	h.entries.push({ type: "message", message: { role: "user", content: "Also preserve this new requirement", timestamp: 4 } });
	await h.execute({});
	assert.equal(h.compactions.length, 2);
	assert.equal(h.state().handoff.note, note);
	assert.equal(h.state().handoff.id, id);
	h.compactions[1].onError(new Error("Provider unavailable"));
	await h.execute({ note_to_self: "NEXT ACTION: updated plan including the new requirement" });
	assert.notEqual(h.state().handoff.id, id);
	assert.match(h.state().handoff.note, /updated plan/);
});

test("summary failures keep the real error, not just the hook cancellation", async t => {
	const h = await host(t); await h.execute();
	h.ctx.modelRegistry.complete = async () => { throw new Error("Provider credits exhausted"); };
	const event = summaryEvent();
	const result = await h.emit("session_before_compact", event);
	assert.equal(result.cancel, true);
	assert.match(String(result.error?.message), /credits exhausted/, "the real cause travels on the hook result");
	h.compactions[0].onError(result.error);
	assert.match(h.state().handoff.error, /credits exhausted/);
	assert.equal((await h.view()).tools_locked, false);
	assert.equal(h.compactions.length, 1);
	event.completions.at(-1)!({ committed: false, error: result.error, aborted: false });
	assert.equal((await h.view()).compaction.source, null, "failure completion clears the in-flight bookkeeping");
});

test("delayed failure notification must not fail a newer retry", async t => {
	const h = await host(t);
	await h.execute();
	h.compactions[0].onError(new Error("old failure"));
	await h.execute({});
	assert.equal(h.state().handoff.status, "pending");
	await h.emit("session_compact_failed", { reason: "manual", aborted: false, errorMessage: "old failure" });
	assert.equal(h.state().handoff.status, "pending", "old informational event changed the current attempt");
});

test("delayed success notification must not invalidate a newer summary", async t => {
	const h = await host(t);
	await h.execute();
	const oldDetails = { handoffId: h.state().handoff.id };
	h.compactions[0].onComplete({ details: oldDetails });
	await h.execute({ note_to_self: "NEXT ACTION: second phase" });
	let release: () => void, entered: () => void;
	const gate = new Promise<void>(r => { release = r; });
	const started = new Promise<void>(r => { entered = r; });
	h.ctx.modelRegistry.complete = async () => { entered!(); await gate; return { ...answer("Second summary") }; };
	const result = h.emit("session_before_compact", summaryEvent());
	await started;
	await h.emit("session_compact", { reason: "manual", compactionEntry: { details: oldDetails } });
	release!();
	assert.ok((await result).compaction, "old notification changed epoch and cancelled a new summary");
});

test("hard cutoff keeps diagnostics and cancellation available after failure", async t => {
	const h = await host(t); h.usage(250_000); await h.execute();
	await h.command("self-compact-cancel");
	assert.equal(h.state().handoff.status, "failed");
	assert.equal((await h.emit("tool_call", { toolName: "read" })).block, true);
	for (const toolName of ["self_compact", "view_context", "subagent_check", "subagent_cancel", "list_sessions", "kill_session"]) assert.equal(await h.emit("tool_call", { toolName }), undefined);
	await h.command("self-compact-info");
	assert.ok(h.entries.some(e => e.customType === "self-compact-info"));
});

test("reload preserves interrupted notes without locking or launching work", async t => {
	for (const status of ["pending", "compacting", "failed", "ready"]) {
		const entries = seedEntries();
		entries.push({ type: "custom", customType: "self-compact-state", data: { version: 1, cycle: 2, handoff: { id: "h1", note: "NEXT ACTION: finish", status, attempts: 1, savedAt: 1 } } });
		const h = await host(t, { entries });
		assert.equal((await h.view()).tools_locked, false);
		assert.equal(h.compactions.length, 0);
		assert.equal(h.userMessages.length, 0);
		assert.ok(h.messages.every(m => m.options.triggerTurn === false));
		assert.equal(h.state().handoff.note, "NEXT ACTION: finish");
		await h.emit("agent_settled");
		assert.equal(h.compactions.length, 0);
	}
});

test("/self-compact-now retries a failed note directly without a model turn", async t => {
	const h = await host(t); await h.execute();
	h.compactions[0].onError(new Error("Transient failure"));
	await h.command("self-compact-now");
	assert.equal(h.compactions.length, 2);
	assert.equal(h.userMessages.length, 0);
});

test("unpatched Pi and excluded self_compact leave native compaction and ordinary tools alone", async t => {
	for (const options of [{ supported: false }, { activeTools: ["read", "view_context"] }]) {
		const h = await host(t, options); h.usage(260_000);
		assert.equal(await h.emit("tool_call", { toolName: "read" }), undefined);
		for (const reason of ["threshold", "overflow"]) assert.equal(await h.emit("session_before_compact", { reason }), undefined);
		assert.equal(await h.emit("before_agent_start", { systemPrompt: "BASE" }), undefined);
		assert.equal((await h.view()).tools_locked, false);
		assert.equal(h.sent().length, 0);
		if (options.supported === false) { await assert.rejects(h.execute(), /lifecycle patch/); assert.equal(h.state(), undefined); }
		await h.command("self-compact-now");
		assert.equal(h.userMessages.length, 0);
	}
});

test("invalid settings disable protection without bricking the session", async t => {
	for (const flags of [{ "compact-soft-at": "300k", "compact-at": "200k" }, { "compact-timeout-ms": "0" }]) {
		const h = await host(t, { flags });
		assert.equal(await h.emit("tool_call", { toolName: "read" }), undefined);
		assert.equal(await h.emit("session_before_compact", { reason: "threshold" }), undefined);
		await assert.rejects(h.execute(), /inert/);
	}
});

test("empty, oversized, and too-small-session requests save nothing and do not lock", async t => {
	const h = await host(t);
	await assert.rejects(h.execute({}), /must not be blank/);
	await assert.rejects(h.execute({ note_to_self: " " }), /must not be blank/);
	await assert.rejects(h.execute({ note_to_self: "x".repeat(24_001) }), /exceeds/);
	assert.equal(h.state(), undefined);
	const small = await host(t, { keep: 1_000_000 });
	await assert.rejects(small.execute(), /Nothing to compact/);
	assert.equal((await small.view()).tools_locked, false);
});

test("mixed batches block sibling work without terminating the logical task", async t => {
	const h = await host(t);
	h.entries.push({ type: "message", message: { ...answer(""), content: [{ type: "toolCall", id: "work", name: "read", arguments: {} }, { type: "toolCall", id: "self", name: "self_compact", arguments: {} }] } });
	const result = await h.emit("tool_call", { toolName: "read", toolCallId: "work" });
	assert.equal(result.block, true);
	assert.equal(result.terminate, undefined);
});

test("tool renderer displays errors as errors and note acceptance is not a green success", async t => {
	const h = await host(t); const colors: string[] = [];
	const theme = { fg: (color: string, text: string) => { colors.push(color); return text; }, bold: (text: string) => text };
	const error = h.definition().renderResult({ content: [{ type: "text", text: "Note rejected" }] }, { expanded: false }, theme, { isError: true });
	assert.match(error.render(100).join(""), /Note rejected/);
	assert.ok(colors.includes("error")); assert.ok(!colors.includes("success"));
	colors.length = 0;
	h.definition().renderResult(await h.execute(), { expanded: false }, theme, { isError: false });
	assert.ok(!colors.includes("success"));
});

test("footer remains opt-in and tool counts are telemetry across reload/tree", async t => {
	const h = await host(t); assert.equal(h.footer(), undefined);
	const on = await host(t, { flags: { "compact-footer": true } }); assert.equal(typeof on.footer(), "function");
	h.entries.push({ type: "message", message: { ...answer(""), content: Array.from({ length: 12 }, (_, i) => ({ type: "toolCall", id: `r${i}`, name: "read", arguments: {} })) } });
	await h.emit("session_start", { reason: "reload" });
	assert.equal((await h.view()).tool_calls_since_compaction, 12);
	await h.emit("session_tree");
	assert.equal((await h.view()).tool_calls_since_compaction, 12);
	assert.equal(h.sent().length, 0);
});
