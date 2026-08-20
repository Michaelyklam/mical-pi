import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { Usage } from "@earendil-works/pi-ai";
import type { SubagentOrigin } from "./domain.ts";

export const BTW_TITLE_MAX_LENGTH = 60;

/** Build a compact dashboard title from the first non-empty prompt line. */
export function deriveBtwTitle(prompt: string) {
  const firstLine = prompt
    .split("\n")
    .find((line) => line.trim())
    ?.trim();
  const title = firstLine?.replace(/\s+/g, " ") ?? "";
  if (!title) return "by the way";
  const codePoints = Array.from(title);
  if (codePoints.length <= BTW_TITLE_MAX_LENGTH) return title;
  return `${codePoints.slice(0, BTW_TITLE_MAX_LENGTH - 1).join("")}…`;
}

/** User asides remain visible in the dashboard but hidden from model tools. */
export function isModelVisible(snap: { readonly origin: SubagentOrigin }) {
  return snap.origin === "model";
}

function zeroUsage(usage: Usage): Usage {
  return {
    ...usage,
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    ...(usage.cacheWrite1h !== undefined ? { cacheWrite1h: 0 } : {}),
    ...(usage.reasoning !== undefined ? { reasoning: 0 } : {}),
    totalTokens: 0,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  };
}

/**
 * Snapshot the parent's compaction-aware active branch for a /btw child.
 *
 * The deep copy prevents either session from mutating shared message objects.
 * Historical usage is zeroed because the child did not incur the parent's
 * earlier requests; retaining it would double-count tokens and cost in the
 * child's saved session. Message content, tool calls, and tool results remain
 * intact so the child receives the actual thread rather than a lossy summary.
 */
export function cloneBtwParentMessages(
  messages: ReadonlyArray<AgentMessage>,
): AgentMessage[] {
  return messages.map((message) => {
    const copy = structuredClone(message);
    if (copy.role === "assistant") {
      return { ...copy, usage: zeroUsage(copy.usage) };
    }
    if (copy.role === "toolResult" && copy.usage) {
      return { ...copy, usage: zeroUsage(copy.usage) };
    }
    return copy;
  });
}
