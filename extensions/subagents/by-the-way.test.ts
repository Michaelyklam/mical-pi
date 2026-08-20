import assert from "node:assert/strict";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import test from "node:test";
import {
  BTW_TITLE_MAX_LENGTH,
  cloneBtwParentMessages,
  deriveBtwTitle,
  isModelVisible,
} from "./src/by-the-way.ts";
import { persistInitialMessages } from "./src/backends/pi.ts";

test("deriveBtwTitle uses the first non-empty line and bounds the title", () => {
  assert.equal(
    deriveBtwTitle("\n   Why   does this work?   \nignore me"),
    "Why does this work?",
  );
  assert.equal(deriveBtwTitle(" \n\t"), "by the way");

  const title = deriveBtwTitle("x".repeat(BTW_TITLE_MAX_LENGTH + 10));
  assert.equal(title.length, BTW_TITLE_MAX_LENGTH);
  assert.equal(title, `${"x".repeat(BTW_TITLE_MAX_LENGTH - 1)}…`);

  const emojiTitle = deriveBtwTitle(
    `${"x".repeat(BTW_TITLE_MAX_LENGTH - 2)}😀 more`,
  );
  assert.equal(emojiTitle, `${"x".repeat(BTW_TITLE_MAX_LENGTH - 2)}😀…`);
});

test("only model-origin snapshots are visible to model-facing tools", () => {
  assert.equal(isModelVisible({ origin: "model" }), true);
  assert.equal(isModelVisible({ origin: "btw" }), false);
});

test("parent thread snapshots preserve content but not historical billing", () => {
  const usage = {
    input: 100,
    output: 20,
    cacheRead: 80,
    cacheWrite: 5,
    cacheWrite1h: 2,
    reasoning: 7,
    totalTokens: 205,
    cost: {
      input: 1,
      output: 2,
      cacheRead: 3,
      cacheWrite: 4,
      total: 10,
    },
  };
  const messages: AgentMessage[] = [
    { role: "user", content: "original question", timestamp: 1 },
    {
      role: "assistant",
      content: [{ type: "toolCall", id: "call-1", name: "read", arguments: { path: "README.md" } }],
      api: "anthropic-messages",
      provider: "anthropic",
      model: "test-model",
      usage,
      stopReason: "toolUse",
      timestamp: 2,
    },
    {
      role: "toolResult",
      toolCallId: "call-1",
      toolName: "read",
      content: [{ type: "text", text: "file contents" }],
      usage,
      isError: false,
      timestamp: 3,
    },
  ];

  const copied = cloneBtwParentMessages(messages);

  assert.deepEqual(copied.map((message) => message.role), ["user", "assistant", "toolResult"]);
  assert.notEqual(copied[0], messages[0]);

  const originalAssistant = messages[1];
  const assistant = copied[1];
  assert.equal(originalAssistant?.role, "assistant");
  assert.equal(assistant?.role, "assistant");
  if (originalAssistant?.role !== "assistant" || assistant?.role !== "assistant") {
    assert.fail("expected assistant messages");
  }
  assert.deepEqual(assistant.content, originalAssistant.content);
  assert.deepEqual(assistant.usage, {
    ...usage,
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    cacheWrite1h: 0,
    reasoning: 0,
    totalTokens: 0,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  });

  const originalToolResult = messages[2];
  const toolResult = copied[2];
  assert.equal(originalToolResult?.role, "toolResult");
  assert.equal(toolResult?.role, "toolResult");
  if (originalToolResult?.role !== "toolResult" || toolResult?.role !== "toolResult") {
    assert.fail("expected tool-result messages");
  }
  assert.deepEqual(toolResult.content, originalToolResult.content);
  assert.equal(toolResult.usage?.totalTokens, 0);
  assert.equal(originalAssistant.usage.totalTokens, 205);
});

test("parent thread snapshots persist in child session order", () => {
  const manager = SessionManager.inMemory("/tmp/btw-parent-context-test");
  const messages: AgentMessage[] = [
    { role: "user", content: "active branch question", timestamp: 1 },
    {
      role: "compactionSummary",
      summary: "Earlier work was compacted here.",
      tokensBefore: 100_000,
      timestamp: 2,
    },
  ];

  persistInitialMessages(manager, messages);
  const restored = manager.buildSessionContext().messages;

  assert.equal(restored[0]?.role, "user");
  assert.equal(restored[0]?.role === "user" ? restored[0].content : undefined, "active branch question");
  assert.equal(restored[1]?.role, "custom");
  assert.match(
    restored[1]?.role === "custom" && typeof restored[1].content === "string" ? restored[1].content : "",
    /Parent compactionSummary.*Earlier work was compacted here\./s,
  );
});

test("parent thread snapshots do not share nested message state", () => {
  const messages: AgentMessage[] = [
    { role: "user", content: [{ type: "text", text: "before" }], timestamp: 1 },
  ];
  const copied = cloneBtwParentMessages(messages);
  const original = messages[0];
  const copy = copied[0];
  assert.equal(original?.role, "user");
  assert.equal(copy?.role, "user");
  if (original?.role !== "user" || copy?.role !== "user") assert.fail("expected user messages");
  if (typeof copy.content === "string") assert.fail("expected structured content");
  const first = copy.content[0];
  if (first?.type === "text") first.text = "after";
  assert.deepEqual(original.content, [{ type: "text", text: "before" }]);
});
