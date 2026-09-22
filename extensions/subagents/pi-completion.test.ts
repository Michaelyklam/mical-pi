import assert from "node:assert/strict";
import test from "node:test";
import type { AgentSession } from "@earendil-works/pi-coding-agent";
import { piRunOutcome } from "./src/backends/pi.ts";

function session(...messages: unknown[]): Pick<AgentSession, "messages"> {
  return { messages } as Pick<AgentSession, "messages">;
}
const progress = { role: "assistant", content: [{ type: "text", text: "I will implement this next." }], stopReason: "stop" };

test("a final tool call cannot turn earlier progress into a completed assignment", () => {
  const s = session(progress, { role: "assistant", content: [{ type: "toolCall", name: "self_compact", arguments: {} }], stopReason: "toolUse" });
  const result = piRunOutcome(s);
  assert.equal(result._tag, "Failed");
  assert.equal("partialText" in result ? result.partialText : undefined, undefined);
});

test("only the final response is returned after continuation", () => {
  const result = piRunOutcome(session(progress, { role: "assistant", content: [{ type: "text", text: "Implemented and verified." }], stopReason: "stop" }));
  assert.deepEqual(result, { _tag: "Completed", finalText: "Implemented and verified." });
});

test("empty final text does not fall back to older progress", () => {
  assert.deepEqual(piRunOutcome(session(progress, { role: "assistant", content: [], stopReason: "stop" })), { _tag: "Completed", finalText: "" });
});

test("interruption and provider errors remain non-completions", () => {
  assert.deepEqual(piRunOutcome(session({ role: "assistant", content: [], stopReason: "aborted" })), { _tag: "Interrupted", partialText: undefined });
  assert.equal(piRunOutcome(session(progress), "Provider failure")._tag, "Failed");
  assert.equal(piRunOutcome(session({ ...progress, stopReason: "length" }))._tag, "Failed");
});
