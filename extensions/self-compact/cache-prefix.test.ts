/**
 * Prompt-cache boundary regression for self-compact.
 *
 * The extension used to re-render one transient `[self-compact · …]` guidance message on EVERY
 * LLM call: the `context` hook stripped the previous one out of the message list and appended a
 * fresh one with the current numbers. That rewrites prompt material the provider has already
 * seen, so the cached prefix breaks at the guidance block and every block after it has to be
 * re-written on each turn.
 *
 * The provider evidence for that claim, read from the INSTALLED Pi:
 *   - `convertToLlm` (pi-agent-core/dist/harness/messages.js) turns role "custom" into a user
 *     message, so a custom guidance message is an ordinary prompt block.
 *   - Pi's Anthropic serializer (pi-ai/dist/api/anthropic-messages.js convertMessages) accepts
 *     only user/assistant/toolResult and puts `cache_control` on the SYSTEM PROMPT, the LAST TOOL,
 *     and the LAST USER MESSAGE. So the only reusable cache prefix is "everything up to a
 *     previously cached block sequence"; a block removed or rewritten in the middle invalidates
 *     the cache from that block onward.
 *
 * This test drives the real extension through the real Pi extension loader, models Pi's
 * per-request pipeline (session projection -> `context` hook -> `convertToLlm`), and asserts the
 * invariant prefix caching needs: each request's canonical payload is an exact prefix of the next
 * one, so nothing already sent is ever removed or rewritten. No provider is called and no sleeps
 * are used; the loop is pure and deterministic.
 */
import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { convertToLlm, sessionEntryToContextMessages } from "@earendil-works/pi-coding-agent";

const HERE = dirname(fileURLToPath(import.meta.url));
const ENTRY = join(HERE, "index.ts");
const PI_DIST = resolve(HERE, "..", "..", "node_modules", "@earendil-works", "pi-coding-agent", "dist");
const loader: any = await import(pathToFileURL(join(PI_DIST, "core", "extensions", "loader.js")).href);

const GUIDANCE = "self-compact-guidance";
/** Keys of the threshold messages; the tool-call and idle nudges use the same customType with other keys. */
const THRESHOLD_KEYS = new Set(["notice", "warning", "forced"]);
/** 1M window: notice 100k, warning 200k, forced 300k (defaults.ts). */
const WINDOW = 1_000_000;
/** Small per-turn growth keeps a 30-turn run inside the notice band. */
const STEP = 1_000;
const START = 99_000;

// ------------------------------------------------------------------ modeling

let sequence = 0;

function messageEntry(message: any, parentId: string | null): any {
	sequence += 1;
	return { type: "message", id: `e${sequence}`, parentId, timestamp: new Date().toISOString(), message };
}

function seedEntries(): any[] {
	const usage = { input: 10, output: 10, cacheRead: 0, cacheWrite: 0, totalTokens: 20, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
	let parent: string | null = null;
	const entries: any[] = [];
	const push = (message: any) => {
		const entry = messageEntry(message, parent);
		entries.push(entry);
		parent = entry.id;
	};
	push({ role: "user", content: `seed prompt ${"x".repeat(4000)}`, timestamp: Date.now() });
	push({ role: "assistant", content: [{ type: "text", text: `seed answer ${"y".repeat(4000)}` }], api: "openai-completions", provider: "fake", model: "test-model", usage, stopReason: "stop", timestamp: Date.now() });
	push({ role: "user", content: "current prompt", timestamp: Date.now() });
	return entries;
}

/** Text of a message, ignoring timestamps/ids: exactly what the provider serializer reads. */
function textOf(content: any): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.map((block: any) =>
			block.type === "text" ? block.text : block.type === "toolCall" ? `toolCall(${block.name}:${JSON.stringify(block.arguments)})` : `[${block.type}]`,
		)
		.join("\u0000");
}

function canonical(payload: any[]): string[] {
	return payload.map((message: any) => `${message.role}:${textOf(message.content)}`);
}

/** The core invariant: request N's payload is an exact prefix of request N+1's. */
function assertAppendOnly(payloads: string[][], label: string) {
	for (let i = 1; i < payloads.length; i++) {
		const previous = payloads[i - 1]!;
		const next = payloads[i]!;
		assert.ok(previous.length <= next.length, `${label}: request ${i} dropped ${previous.length - next.length} block(s) (was ${previous.length}, now ${next.length})`);
		for (let index = 0; index < previous.length; index++) {
			if (previous[index] === next[index]) continue;
			const was = previous[index]!.slice(0, 160).replace(/\n/g, "\\n");
			const now = next[index]!.slice(0, 160).replace(/\n/g, "\\n");
			assert.fail(
				`${label}: request ${i} rewrote prompt block ${index}; the provider cache prefix breaks here.\n  before: ${was}\n  after:  ${now}`,
			);
		}
	}
}

function guidanceBlocks(payload: string[]): string[] {
	return payload.filter((block) => block.startsWith("user:") && block.includes("[self-compact ·"));
}

// -------------------------------------------------------------------- harness

interface Step {
	payload: string[];
	/** True when the `context` hook replaced the message list instead of leaving it alone. */
	hookRewrote: boolean;
}

async function host(t: TestContext, options: { flags?: Record<string, any>; excludedTools?: string[]; allowTools?: string[]; entries?: any[] } = {}) {
	const cwd = mkdtempSync(join(tmpdir(), "self-compact-cache-"));
	mkdirSync(join(cwd, ".pi"), { recursive: true });
	writeFileSync(join(cwd, ".pi", "settings.json"), JSON.stringify({ compaction: { keepRecentTokens: 100 } }));

	const loaded: any = await loader.loadExtensions([ENTRY], cwd);
	assert.deepEqual(loaded.errors, []);
	const extension = loaded.extensions[0];
	const excluded = new Set(options.excludedTools ?? []);
	const allowed = options.allowTools ? new Set(options.allowTools) : undefined;
	const entries: any[] = options.entries ?? seedEntries();
	const sent: any[] = [];
	const notices: any[] = [];
	const steps: Step[] = [];
	/** Messages Pi queues while the agent runs; Pi appends them at the end of the turn (turn_end). */
	const pending: any[] = [];
	let activeTools: string[] | undefined;
	let tokens = START;
	/** Pi's `isStreaming` is true for the whole agent run. */
	let streaming = false;
	let turn = 0;
	const failures: string[] = [];

	for (const [key, value] of Object.entries(options.flags ?? {})) loaded.runtime.flagValues.set(key, value);
	loaded.runtime.appendEntry = (customType: string, data: any) => entries.push({ type: "custom", customType, data });
	const permittedTools = () =>
		[...extension.tools.keys()].filter((name: string) => (!allowed || allowed.has(name)) && !excluded.has(name));
	loaded.runtime.getActiveTools = () => activeTools ?? permittedTools();
	loaded.runtime.setActiveTools = (names: string[]) => {
		const permitted = new Set(permittedTools());
		activeTools = [...new Set(names)].filter((name) => permitted.has(name));
	};
	// Pi's sendCustomMessage: while a run is active an append would land between a tool call and
	// its result, so Pi defers it to the end of the turn; otherwise the message lands immediately.
	loaded.runtime.sendMessage = (message: any, sendOptions: any) => {
		sent.push({ ...message, options: sendOptions });
		if (streaming) pending.push(message);
		else appendCustomMessage(message);
	};

	const appendCustomMessage = (message: any) => {
		sequence += 1;
		entries.push({
			type: "custom_message",
			customType: message.customType,
			content: message.content,
			display: message.display,
			details: message.details,
			id: `e${sequence}`,
			parentId: entries.at(-1)?.id ?? null,
			timestamp: new Date().toISOString(),
		});
	};

	const ctx: any = {
		cwd,
		mode: "tui",
		hasUI: true,
		thinkingLevel: "off",
		model: { id: "test-model", provider: "fake", contextWindow: WINDOW, maxTokens: 8192, api: "openai-completions", reasoning: false },
		sessionManager: { getBranch: () => entries, buildContextEntries: () => entries },
		getContextUsage: () => ({ tokens, contextWindow: WINDOW, percent: (tokens / WINDOW) * 100 }),
		isIdle: () => !streaming,
		compact: () => {},
		ui: { notify: (message: string, type: string) => notices.push({ message, type }), select: async () => undefined, setStatus() {}, setFooter() {} },
		modelRegistry: { complete: async () => { throw new Error("no provider calls in this test"); } },
	};

	const emit = async (name: string, event: any = {}): Promise<any> => {
		let result: any;
		for (const handler of extension.handlers.get(name) ?? []) result = await handler(event, ctx);
		return result;
	};

	t.after(async () => {
		await emit("session_shutdown", { reason: "quit" });
		rmSync(cwd, { recursive: true, force: true });
	});

	await emit("session_start", { reason: "start" });

	/** One LLM call: project the branch, run the context hook, serialize like Pi does. */
	const request = async (): Promise<Step> => {
		const projected = entries.flatMap((entry: any) => sessionEntryToContextMessages(entry));
		const hookResult = await emit("context", { messages: structuredClone(projected) });
		// Pi sends what the hook returns; a hook that rewrites the list is the unstable-prefix signal.
		const sent = hookResult?.messages ?? projected;
		const payload = convertToLlm(sent);
		const last = payload.at(-1)?.role ?? "none";
		// pi-ai turns a trailing toolResult into a user message and puts cache_control on the last
		// user message, so the anchor must always be user-convertible (never an assistant message).
		assert.ok(["user", "toolResult"].includes(last), `the last message must anchor the cache breakpoint, got ${last}`);
		const step = { payload: canonical(payload), hookRewrote: hookResult !== undefined };
		steps.push(step);
		return step;
	};

	/** One agent turn: before_agent_start, the LLM call, an assistant reply with one tool result, turn_end. */
	const runTurn = async (): Promise<Step> => {
		turn += 1;
		streaming = true;
		await emit("before_agent_start", { systemPrompt: "BASE" });
		const step = await request();
		entries.push(
			messageEntry(
				{
					role: "assistant",
					content: [
						{ type: "text", text: `answer ${turn} ${"z".repeat(80 + turn)}` },
						{ type: "toolCall", id: `call-${turn}`, name: "read", arguments: { path: `file-${turn}.ts` } },
					],
					api: "openai-completions",
					provider: "fake",
					model: "test-model",
					usage: { input: 10, output: 10, totalTokens: 20, cacheRead: 0, cacheWrite: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
					stopReason: "toolUse",
					timestamp: Date.now(),
				},
				entries.at(-1)?.id ?? null,
			),
		);
		entries.push(messageEntry({ role: "toolResult", toolCallId: `call-${turn}`, toolName: "read", content: [{ type: "text", text: `result ${turn}` }], isError: false, timestamp: Date.now() }, entries.at(-1)?.id ?? null));
		await emit("turn_end", { turnIndex: turn });
		streaming = false;
		while (pending.length > 0) appendCustomMessage(pending.shift()!);
		tokens += STEP;
		return step;
	};

	return {
		extension,
		ctx,
		entries,
		sent,
		notices,
		steps,
		emit,
		runTurn,
		runTurns: async (count: number) => {
			for (let i = 0; i < count; i++) await runTurn();
		},
		payloads: () => steps.map((step) => step.payload),
		setUsage: (value: number) => {
			tokens = value;
		},
		hookRewrites: () => steps.filter((step) => step.hookRewrote).length,
		guidance: () => sent.filter((message) => message.customType === GUIDANCE && THRESHOLD_KEYS.has(message.details?.key)).map((message) => String(message.content)),
		nudges: () => sent.filter((message) => message.customType === GUIDANCE && !THRESHOLD_KEYS.has(message.details?.key)),
		endRun: async () => {
			streaming = false;
			await emit("agent_end", { messages: [] });
			while (pending.length > 0) appendCustomMessage(pending.shift()!);
		},
		failures,
	};
}

// --------------------------------------------------------------------- tests

test("every request is an exact prefix extension of the last, across the notice crossing and 30 turns", async (t) => {
	const h = await host(t);
	await h.runTurns(30);
	assertAppendOnly(h.payloads(), "30 turns");
	assert.equal(h.hookRewrites(), 0, "the context hook must never rewrite the message list: that is what discards the provider prefix cache");

	const guidance = h.guidance();
	assert.equal(guidance.length, 1, `exactly one guidance message is persisted per threshold, got ${guidance.length}`);
	assert.match(guidance[0]!, /\[self-compact · notice\]/i);
	assert.match(guidance[0]!, /self_compact/);
	// The snapshot is written once: later requests must repeat it byte for byte.
	for (const payload of h.payloads().slice(2)) {
		assert.deepEqual(guidanceBlocks(payload), [`user:${guidance[0]}`], "the persisted guidance is never re-rendered with new numbers");
	}
});

test("warning and forced crossings append one guidance each and never rewrite the earlier ones", async (t) => {
	const h = await host(t);
	await h.runTurns(30); // notice (turn 2)
	const atNotice = h.guidance();
	assert.equal(atNotice.length, 1);

	h.setUsage(250_000); // warning
	await h.runTurns(2);
	h.setUsage(320_000); // forced: the lock engages here too
	await h.runTurns(3);
	const guidance = h.guidance();
	assert.equal(guidance.length, 3, "notice, warning and forced each append exactly one message");
	assert.match(guidance[1]!, /\[self-compact · warning\]/i);
	assert.match(guidance[2]!, /\[self-compact · forced\]/i);
	assert.ok(h.payloads().at(-1)!.includes(`user:${atNotice[0]}`), "the notice snapshot is still in context");
	assertAppendOnly(h.payloads(), "notice -> warning -> forced");

	// The level stays forced, so further turns add no guidance at all.
	await h.runTurns(5);
	assert.equal(h.guidance().length, 3, "no repeated guidance accumulation while the level is unchanged");
	assertAppendOnly(h.payloads(), "after the forced crossing");
});

test("resume/reload re-announces nothing: the persisted guidance is not duplicated", async (t) => {
	const h = await host(t);
	await h.runTurns(30);
	const before = h.guidance().length;
	assert.equal(before, 1);

	await h.emit("session_start", { reason: "reload" });
	assert.equal(h.guidance().length, before, "a reload must not append a second copy of the notice");

	await h.runTurns(3);
	assert.equal(h.guidance().length, before, "the restored session keeps announcing at most once per threshold");
	assertAppendOnly(h.payloads(), "after a reload");
});

test("the idle nudge is appended to the end of the transcript, never spliced into history", async (t) => {
	const h = await host(t);
	await h.runTurns(10); // crosses the notice line
	h.setUsage(250_000); // the nudge is for the warning phase and above
	await h.endRun();
	const nudge = h.nudges();
	assert.equal(nudge.length, 1, "one idle nudge is sent once the run ends above the warning line");
	assert.equal(nudge[0]!.details.key, "now");
	assert.equal(nudge[0]!.options.deliverAs, "followUp");

	await h.runTurns(5);
	assertAppendOnly(h.payloads(), "after the idle nudge");
	assert.equal(h.payloads().at(-1)!.filter((block) => block.includes("Compact now")).length, 1, "the nudge stays exactly once, at its original position");
});
