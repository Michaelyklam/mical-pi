/** Real SDK, Agent loop, extension runner and self_compact, with scripted model I/O.
 * The maintained source patch is tested in disposable sibling modules, never on prototypes.
 */
import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { DefaultResourceLoader, SessionManager, SettingsManager, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import selfCompact, { STATE_TYPE } from "./index.ts";
import { piRunOutcome } from "../subagents/src/backends/pi.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const dist = dirname(fileURLToPath(import.meta.resolve("@earendil-works/pi-coding-agent")));
const { patchSource } = await import(pathToFileURL(resolve(HERE, "../../scripts/patch-pi-coding-agent-compaction-lifecycle.mjs")).href);
const id = `.lifecycle-${process.pid}`;
const paths = [join(dist, `core/extensions/${id}-runner.mjs`), join(dist, `core/${id}-session.mjs`), join(dist, `core/${id}-sdk.mjs`)];
/** Fixture import rewrites must hit their anchors; a silent miss would test the installed module instead. */
function rewrite(source: string, anchor: string, replacement: string): string {
	assert.ok(source.includes(anchor), `fixture anchor missing: ${anchor}`);
	return source.replace(anchor, replacement);
}
let createAgentSession: any;
try {
	writeFileSync(paths[0]!, patchSource(readFileSync(join(dist, "core/extensions/runner.js"), "utf8")));
	let session = patchSource(readFileSync(join(dist, "core/agent-session.js"), "utf8"));
	session = rewrite(session, 'import { ExtensionRunner, wrapRegisteredTools, } from "./extensions/index.js";', `import { ExtensionRunner } from "./extensions/${id}-runner.mjs"; import { wrapRegisteredTools } from "./extensions/index.js";`);
	session = rewrite(session, 'from "./extensions/runner.js"', `from "./extensions/${id}-runner.mjs"`);
	writeFileSync(paths[1]!, session);
	writeFileSync(paths[2]!, rewrite(readFileSync(join(dist, "core/sdk.js"), "utf8"), 'from "./agent-session.js"', `from "./${id}-session.mjs"`));
	({ createAgentSession } = await import(pathToFileURL(paths[2]!).href));
} finally {
	for (const path of paths) if (existsSync(path)) unlinkSync(path);
}
function deferred() {
	let resolve!: () => void;
	const promise = new Promise<void>(r => { resolve = r; });
	return { promise, resolve };
}
const model = { id: "scripted", name: "Scripted", provider: "scripted", api: "openai-completions", baseUrl: "http://unused.invalid", input: ["text"], reasoning: false, contextWindow: 272000, maxTokens: 8192, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } };
const note = "DONE: investigation verified. NEXT ACTION: implement the remaining phase; respect newer instructions.";
function response(content: any[], stopReason = "stop"): any {
	return { role: "assistant", api: model.api, provider: model.provider, model: model.id, content, stopReason, timestamp: Date.now(), usage: { input: 100, output: 30, cacheRead: 0, cacheWrite: 0, totalTokens: 130, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } };
}
async function setup(t: TestContext, overrides: { complete?: any; streamSimple?: any; factories?: any[]; tools?: string[]; stopAfterTurn?: boolean } = {}) {
	const cwd = mkdtempSync(join(tmpdir(), "compact-sdk-"));
	const agentDir = join(cwd, "agent"); mkdirSync(agentDir); mkdirSync(join(cwd, ".pi"));
	writeFileSync(join(cwd, ".pi/settings.json"), JSON.stringify({ compaction: { keepRecentTokens: 100 } }));
	const started = deferred(), finish = deferred();
	const events: any[] = [], contexts: any[] = [], trace: string[] = [], errors: any[] = [];
	let calls = 0;
	const settingsManager = SettingsManager.inMemory({ compaction: { enabled: true, keepRecentTokens: 100 }, retry: { enabled: false } });
	const resources = new DefaultResourceLoader({
		cwd, agentDir, settingsManager, noExtensions: true, noSkills: true, noThemes: true, noPromptTemplates: true, noContextFiles: true,
		systemPrompt: "Scripted lifecycle test.",
		extensionFactories: [...(overrides.factories ?? []), selfCompact, (pi: ExtensionAPI) => {
			pi.registerTool({ name: "finish_phase", label: "Finish phase", description: "Record the completed phase", parameters: Type.Object({}),
				async execute() { writeFileSync(join(cwd, "phase.txt"), "Implemented and verified"); return { content: [{ type: "text", text: "Verified" }], details: {} }; },
			});
		}],
	});
	await resources.reload();
	const sm = SessionManager.inMemory(cwd);
	sm.appendMessage({ role: "user", content: "Investigate first. ".repeat(2000), timestamp: 1 });
	sm.appendMessage(response([{ type: "text", text: "I will implement this next. ".repeat(100) }]));
	const runtime = {
		getModel: () => model, getModels: () => [model], getAvailableSnapshot: () => [model], getRegisteredProviderIds: () => [],
		hasConfiguredAuth: () => true, isUsingOAuth: () => false, getAuth: async () => undefined,
		getCompatibilityRequestConfig: () => ({ authHeader: false }),
		complete: overrides.complete ?? (async () => { started.resolve(); await finish.promise; return response([{ type: "text", text: "The investigation is verified. Implementation remains pending." }]); }),
		streamSimple: overrides.streamSimple ?? ((_model: any, context: any) => {
			contexts.push({ messages: structuredClone(context.messages) }); calls++; trace.push(`response:${calls}`);
			const message = calls === 1
				? response([{ type: "toolCall", id: "compact", name: "self_compact", arguments: { note_to_self: note } }], "toolUse")
				: calls === 2 ? response([{ type: "toolCall", id: "finish", name: "finish_phase", arguments: {} }], "toolUse")
					: response([{ type: "text", text: "Implemented and verified." }]);
			assert.ok(calls <= 3, "Unexpected extra model turn");
			const stream = createAssistantMessageEventStream();
			stream.push({ type: "start", partial: message });
			stream.push({ type: "done", reason: message.stopReason, message }); stream.end();
			return stream;
		}),
	};
	const { session, extensionsResult } = await createAgentSession({ cwd, agentDir, model, modelRuntime: runtime, sessionManager: sm, settingsManager, resourceLoader: resources, tools: ["self_compact", "view_context", "finish_phase", ...(overrides.tools ?? [])], thinkingLevel: "off" });
	assert.deepEqual(extensionsResult.errors, []);
	await session.bindExtensions({ mode: "print", onError: (e: any) => errors.push(e) });
	if (overrides.stopAfterTurn) (session as any).agent.shouldStopAfterTurn = () => true;
	session.subscribe((e: any) => { events.push(e); trace.push(e.type); });
	t.after(async () => { finish.resolve(); await session.abort(); session.dispose(); rmSync(cwd, { recursive: true, force: true }); });
	return { session, sm, cwd, events, contexts, trace, errors, started, finish };
}

test("a self-compacting child keeps one logical run, receives steering, performs work and then settles", { timeout: 10_000 }, async t => {
	const h = await setup(t);
	const run = h.session.prompt("Implement the remaining phase.");
	await Promise.race([h.started.promise, run.then(() => { throw new Error(`Run ended before compaction: ${JSON.stringify({ errors: h.errors, events: h.events.filter(e => e.type === "tool_execution_end" || e.type === "message_end") })}`); })]);
	assert.equal(h.session.isStreaming, true);
	assert.equal(h.session.isCompacting, true);
	assert.equal(h.events.filter(e => e.type === "agent_settled").length, 0, "no premature child completion");
	assert.equal(existsSync(join(h.cwd, "phase.txt")), false);
	await assert.rejects(h.session.compact("Parent compaction must not overlap"), /already in progress/);
	await h.session.prompt("New requirement: also report verification.", { streamingBehavior: "steer" });
	h.finish.resolve(); await run; await h.session.waitForIdle();
	assert.deepEqual(h.errors, []);
	assert.equal(h.events.filter(e => e.type === "agent_start").length, 1);
	assert.equal(h.events.filter(e => e.type === "agent_settled").length, 1);
	assert.equal(h.contexts.length, 3);
	const resumed = JSON.stringify(h.contexts[1].messages);
	assert.ok(resumed.includes(note), "note must be visible before the first resumed response");
	assert.ok(resumed.includes("New requirement: also report verification."), "steering during compaction cannot be lost");
	assert.ok(h.trace.indexOf("tool_execution_end") < h.trace.indexOf("compaction_start"));
	assert.ok(h.trace.indexOf("compaction_end") < h.trace.indexOf("response:2"));
	assert.equal(readFileSync(join(h.cwd, "phase.txt"), "utf8"), "Implemented and verified");
	assert.deepEqual(piRunOutcome(h.session), { _tag: "Completed", finalText: "Implemented and verified." });
	assert.equal(h.sm.getBranch().filter(e => e.type === "compaction").length, 1);
});

test("interrupting compaction stops the task, preserves history, and ignores a late summary", { timeout: 10_000 }, async t => {
	const h = await setup(t);
	const run = h.session.prompt("Implement the remaining phase.");
	await Promise.race([h.started.promise, run.then(() => { throw new Error(`Run ended before compaction: ${JSON.stringify(h.errors)}`); })]);
	await h.session.abort(); await run;
	assert.equal(h.session.isStreaming, false);
	assert.equal(h.session.isCompacting, false);
	assert.equal(h.contexts.length, 1, "cancelled task must not call the model again");
	assert.equal(existsSync(join(h.cwd, "phase.txt")), false);
	h.finish.resolve(); await new Promise(r => setImmediate(r));
	assert.equal(h.sm.getBranch().filter(e => e.type === "compaction").length, 0);
	assert.ok(h.sm.getBranch().some(e => e.type === "message" && e.message.role === "user"));
	assert.equal(h.events.filter(e => e.type === "agent_settled").length, 1);
	assert.notEqual(piRunOutcome(h.session)._tag, "Completed");
});

test("a run that ends before the safe point settles its queued request: no orphan lock, note recoverable, next prompt accepted", { timeout: 10_000 }, async t => {
	let summaryCalls = 0;
	const h = await setup(t, {
		stopAfterTurn: true,
		complete: async () => { summaryCalls++; return response([{ type: "text", text: "Unexpected summary" }]); },
	});
	await h.session.prompt("Implement the remaining phase.");
	assert.equal(summaryCalls, 0, "settling the request must not start model work");
	assert.equal(h.session.isStreaming, false);
	assert.equal(h.session.isCompacting, false, "no orphan lock once the run ended");
	assert.equal((h.session as any)._requestedCompaction, undefined);
	assert.equal(h.events.filter(e => e.type === "agent_settled").length, 1, "settlement is not lost");
	const state = (h.sm.getBranch().filter(e => (e as any).customType === STATE_TYPE).at(-1) as any)?.data;
	assert.equal(state.handoff.status, "failed", "the saved note is retained for explicit retry");
	assert.match(state.handoff.error, /run ended before compaction/i);
	await h.session.prompt("Continue the task."); // accepted: the next prompt is not gated
	await h.session.waitForIdle();
	assert.equal(existsSync(join(h.cwd, "phase.txt")), true, "ordinary work proceeds");
	assert.equal(h.contexts.length, 2, "exactly the two scripted turns, no extra model or summary calls");
	assert.equal(summaryCalls, 0);
});

test("a stalled session_compact listener registered before self-compact cannot delay or fail the committed compaction", { timeout: 10_000 }, async t => {
	const staller = (pi: ExtensionAPI) => { pi.on("session_compact", async () => { await new Promise(() => {}); }); };
	const h = await setup(t, { factories: [staller] });
	const run = h.session.prompt("Implement the remaining phase.");
	await Promise.race([h.started.promise, run.then(() => { throw new Error("run ended before compaction"); })]);
	await h.session.prompt("New requirement: also report verification.", { streamingBehavior: "steer" });
	h.finish.resolve();
	await Promise.race([run, new Promise((_, rej) => setTimeout(() => rej(new Error("run stuck behind a stalled session_compact listener")), 3000))]);
	await h.session.waitForIdle();
	assert.deepEqual(h.errors, [], "committed success is never reported as failure");
	assert.equal(h.sm.getBranch().filter(e => e.type === "compaction").length, 1, "committed exactly once");
	assert.equal(h.session.isCompacting, false, "a post-commit notification cannot hold the operation");
	const resumed = JSON.stringify(h.contexts[1].messages);
	assert.ok(resumed.includes(note), "the exact note is visible before the first resumed response");
	assert.ok(resumed.includes("New requirement: also report verification."), "newer queued instructions survive");
	const state = (h.sm.getBranch().filter(e => (e as any).customType === STATE_TYPE).at(-1) as any)?.data;
	assert.notEqual(state.handoff.status, "failed");
	assert.equal(h.events.filter(e => e.type === "agent_settled").length, 1);
});

test("a scripted summary failure on manual compaction preserves its cause and stays distinct from cancellation", { timeout: 10_000 }, async t => {
	let calls = 0;
	const h = await setup(t, { complete: async () => { calls++; throw new Error("Provider credits exhausted"); } });
	await assert.rejects(h.session.compact("Preserve decisions."), /credits exhausted/);
	assert.ok(calls >= 1);
	const end: any = h.events.find(e => e.type === "compaction_end");
	assert.equal(end.aborted, false, "a failure is not a cancellation");
	assert.match(end.errorMessage, /credits exhausted/);
	assert.equal(h.sm.getBranch().filter(e => e.type === "compaction").length, 0);

	const hanging = deferred();
	const h2 = await setup(t, { complete: async () => { hanging.resolve(); await new Promise(() => {}); } });
	const pending = h2.session.compact("Preserve decisions.");
	await hanging.promise;
	h2.session.abortCompaction();
	await assert.rejects(pending, /Compaction cancelled/);
	const end2: any = h2.events.find(e => e.type === "compaction_end");
	assert.equal(end2.aborted, true, "explicit cancellation stays distinct");
	assert.equal(h2.sm.getBranch().filter(e => e.type === "compaction").length, 0);
});

test("manual compaction of a live run settles extensions and the public exactly once, never while compacting", { timeout: 10_000 }, async t => {
	const records: boolean[] = [];
	let ref: any;
	const probe = (pi: ExtensionAPI) => { pi.on("agent_settled", async () => { records.push(!!ref?.isCompacting); }); };
	const held = deferred();
	const hold = (pi: ExtensionAPI) => pi.registerTool({
		name: "hold_task", label: "Hold task", description: "Hold the run open until aborted.", parameters: Type.Object({}),
		execute: (_id: any, _p: any, signal: any) => {
			held.resolve();
			return new Promise((_res, rej) => signal?.addEventListener("abort", () => rej(Object.assign(new Error("tool aborted"), { name: "AbortError" })), { once: true }));
		},
	} as any);
	let calls = 0;
	const streamSimple = () => {
		const message = ++calls === 1
			? response([{ type: "toolCall", id: "hold", name: "hold_task", arguments: {} }], "toolUse")
			: response([{ type: "text", text: "Done." }]);
		const stream = createAssistantMessageEventStream();
		stream.push({ type: "start", partial: message });
		stream.push({ type: "done", reason: message.stopReason, message }); stream.end();
		return stream;
	};
	const h = await setup(t, { factories: [probe, hold], tools: ["hold_task"], streamSimple });
	ref = h.session;
	const run = h.session.prompt("Long task.");
	await held.promise;
	assert.equal(h.session.isStreaming, true);
	const comp = h.session.compact("Parent instructions.");
	await h.started.promise;
	h.finish.resolve();
	const result = await comp;
	assert.ok(result, "manual compaction commits while aborting the run");
	await run;
	assert.equal(h.sm.getBranch().filter(e => e.type === "compaction").length, 1);
	assert.deepEqual(records, [false], `exactly one extension settle, never while compacting: ${JSON.stringify(records)}`);
	assert.equal(h.events.filter(e => e.type === "agent_settled").length, 1, "exactly one public settle");
});

for (const mode of ["failure", "cancel", "timeout"]) test(`manual ${mode} clears extension compaction status at owner completion`, { timeout: 3000 }, async t => {
	const entered = deferred();
	const h = await setup(t, { complete: async () => { entered.resolve(); if (mode === "failure") throw new Error("Provider credits exhausted"); await new Promise(() => {}); } });
	const run = h.session._compactSession("manual", false, undefined, { timeoutMs: mode === "timeout" ? 20 : 2000 });
	await entered.promise;
	if (mode === "cancel") h.session.abortCompaction();
	await assert.rejects(run, /credits exhausted|Compaction cancelled|timed out/);
	assert.equal(h.session.isCompacting, false);
	const tool = h.session.agent.state.tools.find((entry: any) => entry.name === "view_context");
	const view = await tool.execute("review", {}, new AbortController().signal);
	assert.equal(view.details.compaction.source, null, "extension must not keep reporting manual compaction after the owner has finished");
	assert.equal(view.details.compaction.elapsed_ms, null);
});

test("a timed-out compaction whose hook dispatch resumes late cannot claim new in-flight state", { timeout: 10_000 }, async t => {
	const entered = deferred(), gate = deferred(), resumed = deferred();
	const h = await setup(t, {
		factories: [(pi: ExtensionAPI) => {
			// Registered before self-compact: its stall delays the shared before_compact dispatch.
			pi.on("session_before_compact", async () => { entered.resolve(); await gate.promise; resumed.resolve(); return undefined; });
		}],
	});
	const run = h.session._compactSession("manual", false, undefined, { timeoutMs: 20 });
	await entered.promise;
	await assert.rejects(run, /timed out/);
	gate.resolve(); // the old dispatch resumes after its operation already ended
	await resumed.promise;
	await new Promise(r => setImmediate(r));
	const tool = h.session.agent.state.tools.find((entry: any) => entry.name === "view_context");
	const view = await tool.execute("review", {}, new AbortController().signal);
	assert.equal(view.details.compaction.source, null, "a resumed late dispatch must not claim in-flight state");
	assert.equal(view.details.compaction.elapsed_ms, null);
	assert.deepEqual(h.errors, []);
});
