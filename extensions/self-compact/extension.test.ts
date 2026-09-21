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
	"turn_end",
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
		excludedTools?: string[];
		allowTools?: string[];
		/** Resume: reuse the entries of another host so this instance recovers its branch. */
		entries?: any[];
		/** What a scripted `ctx.ui.select` returns (the picker path). */
		selectChoice?: string | ((labels: string[]) => string | undefined);
		/** Extra registered tools attributed to other extensions (mode switching must not touch them). */
		tools?: Dict;
	} = {},
) {
	const { flags = {}, settings = { compaction: { keepRecentTokens: 100 } }, window = 200_000 } = options;
	const excludedTools = new Set(options.excludedTools ?? []);
	const allowTools = options.allowTools ? new Set(options.allowTools) : undefined;
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
	const selects: any[] = [];
	let tokens = 0;
	let footer: any;

	for (const [name, definition] of Object.entries(options.tools ?? {})) extension.tools.set(name, { name, ...definition });

	for (const [key, value] of Object.entries(flags)) loaded.runtime.flagValues.set(key, value);
	loaded.runtime.appendEntry = (customType: string, data: any) => entries.push({ type: "custom", customType, data });
	loaded.runtime.sendMessage = (message: any, messageOptions: any) => messages.push({ ...message, options: messageOptions });
	// Model Pi's tool selection for extension tools: every registered extension tool is active
	// unless a strict --tools allowlist or an --exclude-tools entry removes it. A tool registered
	// later (variant B) joins the active set automatically, exactly like Pi's refreshTools().
	// `setActiveTools` keeps only registered tools the filters allow and ignores the rest, so a
	// filtered selection is observable as "the tool did not come up".
	const allowedTools = () =>
		[...extension.tools.keys()].filter((name: string) => (!allowTools || allowTools.has(name)) && !excludedTools.has(name));
	let activeTools: string[] | undefined;
	loaded.runtime.getActiveTools = () => activeTools ?? allowedTools();
	loaded.runtime.setActiveTools = (names: string[]) => {
		const allowed = new Set(allowedTools());
		activeTools = [...new Set(names)].filter((name: string) => allowed.has(name));
	};

	const ctx: any = {
		cwd,
		mode: "tui",
		hasUI: true,
		thinkingLevel: "off",
		model: { id: "test-model", provider: "fake", contextWindow: window, maxTokens: 8192, api: "openai-completions", reasoning: true },
		sessionManager: { getBranch: () => entries },
		getContextUsage: () => ({ tokens, contextWindow: window, percent: tokens / window * 100 }),
		isIdle: () => true,
		compact: (compactOptions: any) => compactions.push(compactOptions),
		ui: {
			notify: (message: string, type: string) => notices.push({ message, type }),
			select: async (title: string, labels: string[]) => {
				selects.push({ title, labels });
				return typeof options.selectChoice === "function" ? options.selectChoice(labels) : options.selectChoice;
			},
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
		activeTools: (): string[] => loaded.runtime.getActiveTools(),
		mode: (): any => [...entries].reverse().find((entry: any) => entry.customType === "self-compact-mode")?.data ?? null,
		setMode: (arg = "") => extension.commands.get("self-compact-mode").handler(arg, ctx),
		infoData: (): any => entries.filter((entry: any) => entry.customType === "self-compact-info").at(-1)?.data,
		selects,
		execute: (note = "NEXT ACTION: continue") =>
			extension.tools.get("self_compact").definition.execute("call", { note_to_self: note }, undefined, undefined, ctx),
		definition: (name = "self_compact") => extension.tools.get(name).definition,
		guidance: async () => {
			const result = await emit("context", { messages: [] });
			const message = (result.messages as any[]).find((m: any) => m.role === "custom" && m.customType === "self-compact-guidance");
			return typeof message?.content === "string" ? message.content : undefined;
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
	for (const helper of ["defaults.ts", "thresholds.ts", "summary.ts", "state.ts", "prompts.ts", "context-bar.ts", "variants.ts"]) {
		assert.ok(!paths.some((path: string) => path.endsWith(`/self-compact/${helper}`)), `${helper} must not be loaded as an extension`);
	}
});

test("lifecycle: every registered hook, tool, command, flag and renderer loads on the installed Pi", async (t) => {
	const h = await host(t);
	for (const hook of EXPECTED_HOOKS) {
		assert.ok((h.extension.handlers.get(hook)?.length ?? 0) >= 1, `missing ${hook} handler`);
	}
	assert.deepEqual([...h.extension.tools.keys()].sort(), ["self_compact", "self_compact_experimental", "view_context"]);
	assert.deepEqual([...h.extension.commands.keys()].sort(), ["self-compact-info", "self-compact-mode", "self-compact-now"]);
	assert.deepEqual([...h.extension.flags.keys()].sort(), ["compact-at", "compact-buffer", "compact-experimental", "compact-footer", "compact-prompt", "compact-soft-at"]);
	assert.deepEqual([...(h.extension.entryRenderers?.keys() ?? [])].sort(), ["self-compact-info", "self-compact-phase"]);
	assert.deepEqual([...h.extension.messageRenderers.keys()], ["self-compact-handoff"]);
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
	assert.equal((await h.emit("tool_call", { toolName: "read" })).block, true);
	assert.deepEqual(await h.emit("session_before_compact", { reason: "overflow" }), { cancel: true });
});

test("self_compact returns terminate, saves the note, and agent_settled starts ctx.compact()", async (t) => {
	const h = await host(t);
	h.usage(180_000);
	await h.emit("turn_end");
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
	await h.emit("turn_end");
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
	assert.equal(h.messages.length, 1, "the handoff message is delivered after compaction");
	assert.equal(h.messages[0].customType, "self-compact-handoff");
	assert.equal(h.messages[0].content, note, "the note is returned byte for byte");
	assert.equal(h.messages[0].options.triggerTurn, true);

	await h.emit("message_end", { message: { role: "custom", customType: "self-compact-handoff", details: h.messages[0].details } });
	const finalState = h.entries.filter((entry: any) => entry.customType === "self-compact-state").at(-1).data;
	assert.equal(finalState.handoff.status, "done");
	assert.equal(finalState.locked, false);
	assert.equal(finalState.cycle, 1);
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

// ---------------------------------------------------------------- A/B variants

const B = "self_compact_experimental";
const A = "self_compact";
const EXACT_B_PROMPT =
	"if the current context contains many tool calls, compact your own context and turn them into summaries of what our overall goal is, what we are currently working on, and what steps we've been through including summaries of failures and possible next paths. Leave a message for yourself for what to prioritize next.";
/** Matches the bare control tool name, not the `self_compact_experimental` prefix. */
const BARE_A = /(?<![\w_])self_compact(?![\w_])/;

test("A-only (default): both variants are registered and only the control prompt is exposed", async (t) => {
	const h = await host(t);
	assert.deepEqual([...h.extension.tools.keys()].sort(), [A, B, "view_context"].sort(), "both variants are registered at load");
	assert.equal(hasVariant(h, B), false, "variant B is registered but not active");
	const control = h.definition(A);
	assert.match(control.description, /note_to_self/);
	assert.ok(!control.description.includes(EXACT_B_PROMPT), "the control tool must not carry the experimental prompt");
	assert.ok(!control.promptGuidelines.some((g: string) => g.includes(EXACT_B_PROMPT)));

	h.usage(150_000);
	await h.emit("turn_end");
	const guidance = await h.guidance();
	assert.ok(guidance, "A-only still sends threshold guidance");
	assert.ok(BARE_A.test(guidance!), "the control guidance names self_compact");
	assert.ok(!guidance!.includes(EXACT_B_PROMPT));

	const sys = await h.emit("before_agent_start", { systemPrompt: "BASE" });
	assert.ok(sys.systemPrompt.includes(A));
	assert.ok(!sys.systemPrompt.includes(B));
});

test("B-only: the exact experimental prompt is exposed verbatim and every extension message targets B", async (t) => {
	const h = await host(t, { flags: { "compact-experimental": true }, excludedTools: [A] });
	assert.deepEqual([...h.extension.tools.keys()].sort(), [A, B, "view_context"].sort(), "both variants are registered, A is excluded from the active set");

	const experimental = h.definition(B);
	assert.ok(experimental.description.includes(EXACT_B_PROMPT), "B's tool description carries the user's exact words");
	assert.ok(experimental.promptGuidelines.includes(EXACT_B_PROMPT), "B's guidelines carry the user's exact words");
	assert.match(experimental.parameters.properties.note_to_self.description, /Leave a message for yourself for what to prioritize next\./);
	assert.equal(experimental.promptSnippet, EXACT_B_PROMPT);

	h.usage(280_000);
	await h.emit("turn_end");
	const guidance = await h.guidance();
	assert.ok(guidance, "B-only sends threshold guidance");
	assert.ok(guidance!.includes(EXACT_B_PROMPT), "the rendered B guidance carries the exact prompt");
	assert.match(guidance!, /`self_compact_experimental` now as your only tool call/);
	assert.ok(!BARE_A.test(guidance!), "B guidance never tells the agent to call the unavailable control tool");

	const sys = await h.emit("before_agent_start", { systemPrompt: "BASE" });
	assert.match(sys.systemPrompt, /self_compact_experimental/);
	assert.ok(!BARE_A.test(sys.systemPrompt), "the system prompt names only the enabled variant");

	const blocked = await h.emit("tool_call", { toolName: "read" });
	assert.equal(blocked.block, true);
	assert.match(blocked.reason, /self_compact_experimental/);
	assert.ok(!BARE_A.test(blocked.reason), "the forced-lock reason names the enabled variant");
	assert.equal(await h.emit("tool_call", { toolName: B }), undefined, "B is reachable while locked");
	assert.ok((await h.emit("tool_call", { toolName: A })).block, "the excluded control tool stays blocked");
});

test("bootstrap: --compact-experimental selects the experimental mode and deactivates control", async (t) => {
	const h = await host(t, { flags: { "compact-experimental": true } });
	assert.deepEqual(h.activeTools().filter((name) => name === A || name === B), [B], "the flag alone selects variant B, not both");
	assert.deepEqual(modeEntries(h).at(-1).data.mode, "experimental");
	assert.equal(modeEntries(h).at(-1).data.source, "flag");

	h.usage(280_000);
	await h.emit("turn_end");
	const guidance = await h.guidance();
	assert.ok(guidance.includes(EXACT_B_PROMPT), "the experimental arm is the one exposed");
	assert.ok(!BARE_A.test(guidance), "the inactive control tool is never named");

	const sys = await h.emit("before_agent_start", { systemPrompt: "BASE" });
	assert.match(sys.systemPrompt, /self_compact_experimental/);
	assert.ok(!BARE_A.test(sys.systemPrompt), "the system prompt names only the selected variant");

	assert.ok((await h.emit("tool_call", { toolName: A })).block, "the forced lock does not treat the inactive variant as a compaction tool");
	assert.equal(await h.emit("tool_call", { toolName: B }), undefined, "the selected variant stays reachable while locked");
});

test("neither enabled: the extension is passive, native compaction is preserved, and nothing deadlocks", async (t) => {
	const h = await host(t, {
		settings: { compaction: { keepRecentTokens: 100, enabled: true } },
		excludedTools: [A, B],
	});
	h.usage(280_000);
	await h.emit("turn_end");
	assert.equal(await h.guidance(), undefined, "no guidance without a reachable tool");
	assert.equal(await h.emit("tool_call", { toolName: "read" }), undefined, "ordinary tools are never blocked");
	assert.equal(await h.emit("session_before_compact", { reason: "threshold" }), undefined, "native auto-compaction is not cancelled");
	assert.equal(await h.emit("session_before_compact", { reason: "overflow" }), undefined, "native overflow recovery is preserved");
	assert.equal(await h.emit("before_agent_start", { systemPrompt: "BASE" }), undefined, "no system-prompt line is appended");

	await assert.rejects(
		h.definition(A).execute("c", { note_to_self: "x" }, undefined, undefined, h.ctx),
		/not enabled in this session/,
	);
	const before = h.messages.length;
	await h.extension.commands.get("self-compact-now").handler("", h.ctx);
	assert.equal(h.messages.length, before, "/self-compact-now sends nothing when no variant is enabled");
	assert.ok(h.notices.some((notice) => /no self-compaction tool is enabled/.test(notice.message)));

	await h.info();
	const info = h.entries.filter((entry: any) => entry.customType === "self-compact-info").at(-1).data;
	assert.deepEqual(info.variants, { control: false, experimental: false, enabled: false, primary: null });
});

test("A and B share the same thresholds, compaction engine, and handoff contract", async (t) => {
	const a = await host(t);
	const b = await host(t, { flags: { "compact-experimental": true }, excludedTools: [A] });
	a.usage(150_000);
	b.usage(150_000);
	const viewA = JSON.parse((await a.view()).content[0].text);
	const viewB = JSON.parse((await b.view()).content[0].text);
	assert.deepEqual(viewB.thresholds, viewA.thresholds, "the prompt is the only variable; thresholds are identical");

	a.usage(180_000);
	b.usage(180_000);
	await a.emit("turn_end");
	await b.emit("turn_end");
	const note = "GOAL: same engine\nNEXT ACTION: compare";
	const ra = await a.definition(A).execute("call", { note_to_self: note }, undefined, undefined, a.ctx);
	const rb = await b.definition(B).execute("call", { note_to_self: note }, undefined, undefined, b.ctx);
	assert.equal(ra.terminate, true);
	assert.equal(rb.terminate, true);
	assert.equal(ra.details.noteChars, rb.details.noteChars);

	const compactionA = await a.emit("session_before_compact", summaryEvent());
	const compactionB = await b.emit("session_before_compact", summaryEvent());
	assert.equal(
		compactionA.compaction.details.selfCompact.promptSource,
		compactionB.compaction.details.selfCompact.promptSource,
		"both variants run the same vendored compaction prompt",
	);
	assert.match(String(compactionB.compaction.details.selfCompact.promptSource), /USER_PROMPT_COMPACTION_MESSAGE\.md$/);

	for (const [host, details] of [[a, compactionA.compaction.details], [b, compactionB.compaction.details]] as const) {
		await host.emit("session_compact", { reason: "manual", compactionEntry: { id: "c1", details } });
		assert.equal(host.messages.at(-1).content, note, "the note is returned byte for byte");
		await host.emit("message_end", { message: { role: "custom", customType: "self-compact-handoff", details: host.messages.at(-1).details } });
		const final = host.entries.filter((entry: any) => entry.customType === "self-compact-state").at(-1).data;
		assert.equal(final.handoff.status, "done");
		assert.equal(final.locked, false);
		assert.equal(final.cycle, 1);
	}
});

test("B runs the shared handoff lifecycle: note, idle compaction, verbatim return, unlock", async (t) => {
	const h = await host(t, { flags: { "compact-experimental": true }, excludedTools: [A] });
	h.usage(180_000);
	await h.emit("turn_end");
	const note = "GOAL: variant B lifecycle\nNEXT ACTION: run the tests";
	const result = await h.definition(B).execute("call", { note_to_self: note }, undefined, undefined, h.ctx);
	assert.equal(result.terminate, true, "Pi must end the run after the note is saved");
	assert.equal(h.entries.filter((entry: any) => entry.customType === "self-compact-state").at(-1).data.handoff.status, "pending");

	await h.emit("agent_settled");
	assert.equal(h.compactions.length, 1, "ctx.compact() runs once the agent is idle");
	const compaction = await h.emit("session_before_compact", summaryEvent());
	await h.emit("session_compact", { reason: "manual", compactionEntry: { id: "c1", details: compaction.compaction.details } });
	assert.equal(h.messages.at(-1).content, note);
	assert.equal(h.messages.at(-1).customType, "self-compact-handoff");
	await h.emit("message_end", { message: { role: "custom", customType: "self-compact-handoff", details: h.messages.at(-1).details } });
	const final = h.entries.filter((entry: any) => entry.customType === "self-compact-state").at(-1).data;
	assert.equal(final.handoff.status, "done");
	assert.equal(final.locked, false);
	assert.equal(final.cycle, 1);
});

// ------------------------------------------------------- session mode selection

const UNRELATED = "unrelated_tool";
const unrelatedTool = {
	label: "Unrelated",
	description: "a tool owned by some other extension",
	parameters: { type: "object", properties: {} },
	execute: async () => ({ content: [{ type: "text", text: "unrelated" }] }),
};
const modeEntries = (h: any) => h.entries.filter((entry: any) => entry.customType === "self-compact-mode");
const hasVariant = (h: any, name: string) => h.activeTools().includes(name);

test("default is control, with no mode entry written and no other tool disturbed", async (t) => {
	const h = await host(t, { tools: { [UNRELATED]: unrelatedTool } });
	assert.equal(hasVariant(h, A), true);
	assert.equal(hasVariant(h, B), false, "variant B is registered but not active");
	assert.equal(h.extension.tools.has(B), true, "registration happens at load, not on selection");
	assert.equal(h.activeTools().includes(UNRELATED), true);
	assert.deepEqual(modeEntries(h), [], "the default needs no persisted entry");

	const info = await h.info();
	void info;
	assert.equal(h.infoData().mode.selected, "control");
	assert.equal(h.infoData().mode.source, "flag");
	assert.equal(h.infoData().mode.persisted, false);
});

test("/self-compact-mode switches A -> B -> off -> A, exposing only the selected variant", async (t) => {
	const h = await host(t, { tools: { [UNRELATED]: unrelatedTool } });
	const messagesBefore = h.messages.length;

	await h.setMode("experimental");
	assert.deepEqual(h.activeTools().filter((name) => name === A || name === B), [B], "variant B only");
	assert.equal(h.activeTools().includes(UNRELATED), true, "unrelated tools are preserved");
	assert.ok(h.extension.tools.has(B), "variant B stays registered while selected");
	assert.deepEqual(modeEntries(h).at(-1).data.mode, "experimental");
	assert.equal(modeEntries(h).at(-1).data.source, "user");

	// The system-prompt line follows the selection, and B's prompt is the only arm exposed.
	let sys = await h.emit("before_agent_start", { systemPrompt: "BASE" });
	assert.match(sys.systemPrompt, /self_compact_experimental/);
	assert.ok(!BARE_A.test(sys.systemPrompt), "no control tool name in the prompt");
	h.usage(280_000);
	await h.emit("turn_end");
	const guidance = await h.guidance();
	assert.ok(guidance.includes(EXACT_B_PROMPT), "the guidance carries variant B's exact prompt");
	assert.ok(!BARE_A.test(guidance), "the guidance never names the inactive control tool");
	assert.ok((await h.emit("tool_call", { toolName: A })).block, "the inactive variant is no longer a compaction tool");
	assert.ok((await h.emit("tool_call", { toolName: "read" })).block, "the forced lock is live in B mode");
	assert.equal(await h.emit("tool_call", { toolName: B }), undefined, "B is reachable while locked");

	await h.setMode("off");
	assert.equal(hasVariant(h, A), false);
	assert.equal(hasVariant(h, B), false);
	assert.equal(h.activeTools().includes(UNRELATED), true);
	assert.equal(await h.emit("tool_call", { toolName: "read" }), undefined, "off stops the lock");
	assert.equal(await h.emit("session_before_compact", { reason: "threshold" }), undefined, "off restores native compaction");
	assert.equal(await h.emit("session_before_compact", { reason: "overflow" }), undefined, "off restores native overflow recovery");
	assert.equal(await h.guidance(), undefined, "off stops the reminders");
	assert.equal(await h.emit("before_agent_start", { systemPrompt: "BASE" }), undefined, "off appends no system-prompt line");
	assert.equal(modeEntries(h).at(-1).data.mode, "off");

	await h.setMode("a");
	assert.deepEqual(h.activeTools().filter((name) => name === A || name === B), [A], "back to control only");
	assert.equal(h.activeTools().includes(UNRELATED), true);
	assert.ok(h.extension.tools.has(B), "B stays registered but inactive");
	h.usage(280_000);
	await h.emit("turn_end");
	const back = await h.guidance();
	assert.ok(BARE_A.test(back), "control guidance is back");
	assert.ok(!back.includes(EXACT_B_PROMPT));
	sys = await h.emit("before_agent_start", { systemPrompt: "BASE" });
	assert.ok(!sys.systemPrompt.includes(B), "the inactive variant leaves the system prompt too");
	assert.equal(h.messages.length, messagesBefore, "switching modes never starts a model turn");
});

test("the picker path runs ctx.ui.select and applies the picked mode without a model turn", async (t) => {
	const h = await host(t, { selectChoice: (labels: string[]) => labels.find((label) => label.startsWith("Experimental")) });
	const messagesBefore = h.messages.length;
	await h.setMode();
	assert.equal(h.selects.length, 1, "one picker dialog");
	assert.equal(h.selects[0].labels.length, 3, "Control, Experimental, Off");
	assert.deepEqual(h.activeTools().filter((name) => name === A || name === B), [B]);
	assert.equal(modeEntries(h).at(-1).data.mode, "experimental");
	assert.equal(h.messages.length, messagesBefore, "the picker command sends no message");

	// Cancelling the picker changes nothing.
	h.ctx.ui.select = async (title: string, labels: string[]) => { h.selects.push({ title, labels }); return undefined; };
	await h.setMode();
	assert.deepEqual(h.activeTools().filter((name) => name === A || name === B), [B], "cancel keeps the mode");
});

test("a mode argument that is not a mode is reported and changes nothing", async (t) => {
	const h = await host(t);
	await h.setMode("self_compact");
	assert.ok(h.notices.some((notice) => notice.type === "error" && /is not a mode/.test(notice.message)));
	assert.deepEqual(h.activeTools().filter((name) => name === A || name === B), [A]);
	assert.deepEqual(modeEntries(h), [], "nothing is persisted for a bad argument");
});

test("the mode is durable per session: reload and resume keep it, /tree back reverts it", async (t) => {
	const h1 = await host(t);
	await h1.setMode("experimental");
	assert.equal(modeEntries(h1).length, 1);

	await h1.emit("session_start", { reason: "reload" });
	assert.deepEqual(h1.activeTools().filter((name) => name === A || name === B), [B], "reload re-applies the saved mode");
	assert.equal(modeEntries(h1).length, 1, "a reload never re-persists the mode");

	const h2 = await host(t, { entries: h1.entries });
	assert.deepEqual(h2.activeTools().filter((name) => name === A || name === B), [B], "resume re-applies the saved mode");
	assert.equal(modeEntries(h2).length, 1);
	await h2.info();
	assert.equal(h2.infoData().mode.selected, "experimental");
	assert.equal(h2.infoData().mode.source, "session");
	assert.equal(h2.infoData().mode.persisted, true);
	assert.equal(h2.infoData().variants.experimental, true);

	// /tree to the leaf before the switch: the branch no longer carries the mode entry.
	const modeIndex = h1.entries.findIndex((entry: any) => entry.customType === "self-compact-mode");
	h1.entries.length = modeIndex;
	await h1.emit("session_tree", { reason: "tree" });
	assert.equal(modeEntries(h1).length, 0, "the default bootstrap writes no entry");
	assert.deepEqual(h1.activeTools().filter((name) => name === A || name === B), [A], "tree navigation reverts to the branch mode");
});

test("a pending note blocks mode switching instead of being stranded", async (t) => {
	const h = await host(t);
	h.usage(180_000);
	await h.emit("turn_end");
	const note = "GOAL: keep the note\nNEXT ACTION: settle the handoff";
	await h.execute(note);

	await h.setMode("off");
	assert.ok(h.notices.some((notice) => notice.type === "warning" && /cannot switch to off while a note is saved/.test(notice.message)));
	assert.deepEqual(modeEntries(h), [], "a refused switch persists nothing");
	assert.equal(h.entries.filter((entry: any) => entry.customType === "self-compact-state").at(-1).data.handoff.status, "pending", "the note is kept");
	assert.equal(hasVariant(h, A), true, "the working mode is still active");
	assert.ok((await h.emit("tool_call", { toolName: "read" })).block, "the lock still protects the pending note");

	// Once the handoff settles the switch is allowed again.
	await h.emit("agent_settled");
	const compaction = await h.emit("session_before_compact", summaryEvent());
	await h.emit("session_compact", { reason: "manual", compactionEntry: { id: "c1", details: compaction.compaction.details } });
	assert.equal(h.messages.at(-1).content, note);
	await h.emit("message_end", { message: { role: "custom", customType: "self-compact-handoff", details: h.messages.at(-1).details } });
	assert.equal(h.entries.filter((entry: any) => entry.customType === "self-compact-state").at(-1).data.handoff.status, "done");

	await h.setMode("off");
	assert.equal(modeEntries(h).at(-1).data.mode, "off", "the switch works after the handoff is done");
	assert.equal(hasVariant(h, A), false);
});

test("a CLI filter that denies a variant is reported and rolled back, and B can still be selected when allowed", async (t) => {
	const h = await host(t, { allowTools: ["view_context", UNRELATED, B], tools: { [UNRELATED]: unrelatedTool } });
	assert.equal(hasVariant(h, A), false, "--tools denies the control tool");
	assert.equal(hasVariant(h, B), false, "B was never requested at startup");
	assert.ok(h.notices.some((notice) => notice.type === "error" && /the control mode cannot be activated/.test(notice.message)));
	assert.deepEqual(modeEntries(h), [], "a blocked bootstrap persists no mode entry");
	assert.deepEqual(h.activeTools(), ["view_context", UNRELATED], "the blocked tool is not activated anyway");

	const before = h.activeTools();
	await h.setMode("control");
	assert.ok(h.notices.some((notice) => notice.type === "error" && /cannot activate control/.test(notice.message) && /filters deny self_compact/.test(notice.message)));
	assert.deepEqual(h.activeTools(), before, "a denied selection rolls the tool set back");
	assert.deepEqual(modeEntries(h), [], "the refused mode is not persisted");
	assert.equal(await h.emit("session_before_compact", { reason: "threshold" }), undefined, "the session stays passive and safe");
	await h.info();
	assert.equal(h.infoData().mode.selected, "control");
	assert.match(h.infoData().mode.blocked, /filters deny self_compact/);

	await h.setMode("experimental");
	assert.ok(h.notices.some((notice) => notice.type === "info" && /mode experimental/.test(notice.message)));
	assert.deepEqual(h.activeTools().filter((name) => name === A || name === B), [B], "the allowed variant activates");
	assert.equal(h.activeTools().includes(UNRELATED), true, "unrelated tools survive the failed and the successful switch");
	await h.info();
	assert.equal(h.infoData().mode.selected, "experimental");
	assert.equal(h.infoData().mode.blocked, null);
});

test("a user switch Pi denies is transactional: the running mode stays fully active", async (t) => {
	const h = await host(t, { excludedTools: [B], tools: { [UNRELATED]: unrelatedTool } });
	assert.deepEqual(h.activeTools().filter((name) => name === A || name === B), [A], "control is running");
	assert.deepEqual(modeEntries(h), [], "the default mode persists nothing");
	const before = h.activeTools();

	await h.setMode("experimental");
	assert.ok(
		h.notices.some((notice) => notice.type === "error" && /cannot activate experimental/.test(notice.message) && /filters deny self_compact_experimental/.test(notice.message)),
		"the refusal names the denied variant",
	);
	assert.ok(h.notices.some((notice) => /Nothing changed: the session still runs control/.test(notice.message)), "the message names the mode that is really running");
	assert.deepEqual(h.activeTools(), before, "a refused switch restores the exact previous tool set");
	assert.equal(hasVariant(h, A), true, "the running control tool is still active");
	assert.equal(hasVariant(h, B), false, "the denied variant never comes up");
	assert.equal(h.activeTools().includes(UNRELATED), true, "unrelated tools survive the refusal");
	assert.deepEqual(modeEntries(h), [], "a refused switch persists nothing");
	await h.info();
	assert.equal(h.infoData().mode.selected, "control", "the effective mode is unchanged");
	assert.equal(h.infoData().mode.blocked, null, "the mode that runs is not reported as blocked");
	assert.deepEqual(await h.emit("session_before_compact", { reason: "threshold" }), { cancel: true }, "the restored mode still owns compaction");
});

test("a saved note is never stranded when no variant can be activated", async (t) => {
	const h = await host(t, { entries: seedEntries(), window: 200_000 });
	h.usage(280_000);
	await h.emit("turn_end");
	const note = "GOAL: stranded note\nNEXT ACTION: recover it";
	await h.execute(note);
	const state = h.entries.filter((entry: any) => entry.customType === "self-compact-state").at(-1).data;
	assert.equal(state.handoff.status, "pending");

	// Resume with both variants denied by the CLI: the note must be kept, warned about, and left unlocked.
	const resumed = await host(t, { entries: h.entries, excludedTools: [A, B] });
	assert.ok(resumed.notices.some((notice) => /saved note \(\d+ chars\) cannot be compacted/.test(notice.message)));
	const resumedState = resumed.entries.filter((entry: any) => entry.customType === "self-compact-state").at(-1).data;
	assert.equal(resumedState.handoff.status, "pending", "the note survives");
	assert.equal(resumedState.handoff.note, note);
	assert.equal(resumedState.locked, false, "no deadlock: nothing is locked without a reachable tool");
	assert.equal(await resumed.emit("tool_call", { toolName: "read" }), undefined);
});
