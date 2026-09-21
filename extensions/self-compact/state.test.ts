/**
 * Pure tests for the branch-derived tool-call count. The count is rebuilt on every resume,
 * reload and /tree navigation instead of being persisted, so it must read the active branch
 * after the last real compaction and ignore the extension's own meta tools.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { countToolCallsSinceCompaction, type EntryLike } from "./state.ts";

function assistant(...names: string[]): EntryLike {
	return { type: "message", message: { role: "assistant", content: names.map((name, i) => ({ type: "toolCall", id: `${name}-${i}`, name, arguments: {} })) } };
}

function user(): EntryLike {
	return { type: "message", message: { role: "user", content: "hi" } };
}

function compaction(): EntryLike {
	return { type: "compaction", details: {} };
}

test("no compaction entry counts every ordinary call on the branch", () => {
	assert.equal(countToolCallsSinceCompaction([user(), assistant("read", "bash"), assistant("edit")]), 3);
});

test("only calls after the last compaction count", () => {
	const entries = [assistant("read", "bash"), compaction(), assistant("edit"), user(), assistant("read")];
	assert.equal(countToolCallsSinceCompaction(entries), 2);
});

test("the last compaction wins over an earlier one", () => {
	const entries = [compaction(), assistant("read", "bash", "edit"), compaction(), assistant("read")];
	assert.equal(countToolCallsSinceCompaction(entries), 1);
});

test("self_compact and view_context never count", () => {
	const entries = [compaction(), assistant("read", "self_compact", "view_context", "bash")];
	assert.equal(countToolCallsSinceCompaction(entries), 2);
});

test("non-tool-call content and other roles are ignored", () => {
	const entries = [user(), { type: "message", message: { role: "assistant", content: [{ type: "text", text: "hello" }] } }, assistant("read")];
	assert.equal(countToolCallsSinceCompaction(entries), 1);
});

test("an empty branch counts zero", () => {
	assert.equal(countToolCallsSinceCompaction([]), 0);
});
