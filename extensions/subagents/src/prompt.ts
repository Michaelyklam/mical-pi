/** All model-facing strings for the subagents tools. */

/** Describes subagent_spawn, including harnesses and the fixed concurrency cap. */
export const SUBAGENT_SPAWN_TOOL_DESCRIPTION =
  "Spawn a background subagent: a fully autonomous, headless agent with its own context window and the selected harness's normal host permissions. Fire-and-forget: this returns immediately with an id. When the subagent settles, its output is injected automatically. Continue independent work if available; otherwise give a pending-work update and end the turn so the main session stays available. subagent_check inspects actionable progress and subagent_send redirects it mid-run. Children cannot orchestrate more agents/workflows or ask the user, and cannot see this conversation, so the prompt must be self-contained. Only use trusted working directories. Max 16 subagents can be running at once across all harnesses.";

/** Adds background subagent delegation to the parent model's available-tools prompt. */
export const SUBAGENT_SPAWN_PROMPT_SNIPPET =
  "Spawn a background subagent on a chosen harness (pi, Claude Code, or Codex; own context, normal tools) for a self-contained task";

/** Guides the parent model to delegate standalone tasks and avoid unnecessary blocking waits. */
export const SUBAGENT_SPAWN_PROMPT_GUIDELINES = [
  "Use subagent_spawn to delegate self-contained tasks that can run in the background; give it a complete, standalone prompt.",
  "Read the subagents skill before using subagent_spawn for provider selection and harness defaults.",
  "After subagent_spawn, continue only independent parent work; leave the assigned investigation and implementation to the worker. Results arrive automatically. If nothing independent remains, give a pending-work update and end the turn without claiming completion; resume when the result arrives. Reserve subagent_wait for an explicit user request for a blocking wait.",
  "Use subagent_check when progress information would change your next action, not for routine polling. Review the actual patch, then consolidate corrections through subagent_send to the same worker.",
  "Leave settled subagents unmodified unless you need them again. Send follow-up work directly with subagent_send; Pi children with self-compaction enabled manage their own context. Reserve subagent_compact for manual recovery when that context management is unavailable or insufficient, or when the user requests it. Claude Code and Codex subagents cannot be compacted through this tool.",
];

/** Model-facing schema descriptions for subagent_spawn task and execution options. */
export const SUBAGENT_SPAWN_PARAMETER_DESCRIPTIONS = {
  prompt:
    "Task prompt for the subagent. Must be self-contained: include all needed context, file paths, and what to report back.",
  name: "Short human-readable name for this subagent, shown in listings and the UI",
  harness:
    'Harness to run the subagent on: "pi", "claude" (Claude Code), or "codex" (Codex CLI).',
  workingDir:
    "Trusted working directory for the autonomous child (default: current working directory)",
  model:
    'Model hint interpreted by the chosen harness. Pi accepts provider/model-id or a bare ID within the parent provider; omit to inherit the current model. Claude and Codex use native aliases/slugs.',
  reasoningEffort:
    "Reasoning effort on a shared scale; the harness maps it to its nearest native equivalent (pi thinking level, codex reasoning effort, claude thinking budget). Omit for the harness default (pi inherits the current level).",
};

/** Builds the subagent_spawn result that tells the parent model how to continue or inspect the child. */
export function buildSubagentSpawnResult(options: {
  id: string;
  title: string;
  harness: string;
  modelLabel: string;
  cwd: string;
}) {
  return (
    `Spawned subagent ${options.id} "${options.title}" (${options.harness}: ${options.modelLabel}, ${options.cwd}).\n` +
    `It runs in the background. Its result arrives automatically when it finishes. Continue independent work if available; otherwise give a pending-work update and end the turn. ` +
    `Use subagent_check only to investigate progress, subagent_send to steer it, subagent_cancel to stop it, or subagent_list to see all. No blocking wait is needed for automatic delivery.`
  );
}

/** Describes explicit blocking collection of one or more subagent results. */
export const SUBAGENT_WAIT_TOOL_DESCRIPTION =
  "Legacy blocking wait: use only when the user explicitly requests a blocking wait. Normally, subagent results are injected automatically; continue independent work or end the turn with a pending-work update instead. This tool parks your turn and prevents a reply until all listed subagents settle. Results already delivered are reported as a pointer rather than repeated.";

/** Model-facing schema description for the subagent ids to await. */
export const SUBAGENT_WAIT_PARAMETER_DESCRIPTIONS = {
  ids: 'Subagent ids to wait for, e.g. ["sa-1", "sa-2"]',
};

/** Describes aborting running subagents while retaining their partial transcripts. */
export const SUBAGENT_CANCEL_TOOL_DESCRIPTION =
  "Cancel one or more running subagents. This aborts their active work but preserves their partial session transcripts on disk.";

/** Model-facing schema description for the subagent ids to cancel. */
export const SUBAGENT_CANCEL_PARAMETER_DESCRIPTIONS = {
  ids: 'Subagent ids to cancel, e.g. ["sa-1", "sa-2"]',
};

/** Describes explicit context compaction for settled Pi subagents. */
export const SUBAGENT_COMPACT_TOOL_DESCRIPTION =
  "Manually compact a settled Pi subagent for recovery when its own context management is unavailable or insufficient, or when the user requests it. For normal reuse, send follow-up work directly with subagent_send. This operation runs only above 40,000 context tokens; otherwise it returns a skip result. Claude Code and Codex backends do not support it and return an error.";

export const SUBAGENT_COMPACT_PARAMETER_DESCRIPTIONS = {
  id: "Settled Pi subagent id to compact, e.g. \"sa-1\"",
};

export function buildSubagentCompactResult(options: {
  id: string;
  title: string;
  compacted: boolean;
  tokensBefore?: number;
  estimatedTokensAfter?: number;
  reason?: "below-threshold" | "unknown-usage";
}) {
  if (options.compacted) {
    return `Compacted ${options.id} "${options.title}" from ${options.tokensBefore ?? "?"} to approximately ${options.estimatedTokensAfter ?? "?"} context tokens.`;
  }
  if (options.reason === "below-threshold") {
    return `Skipped compaction for ${options.id} "${options.title}": ${options.tokensBefore ?? 0} context tokens does not exceed the 40,000-token threshold.`;
  }
  return `Skipped compaction for ${options.id} "${options.title}": context usage is unknown, so the 40,000-token threshold could not be verified.`;
}

/** Describes nonblocking inspection of a subagent without consuming its result. */
export const SUBAGENT_CHECK_TOOL_DESCRIPTION =
  "Peek at a subagent's status and recent activity without blocking. Does not consume its result. Use when progress information would change your next action, such as investigating a suspected stall; completion is delivered automatically.";

/** Model-facing schema description for the subagent id to inspect. */
export const SUBAGENT_CHECK_PARAMETER_DESCRIPTIONS = {
  id: "Subagent id",
};

/** Describes two-way messaging with a tracked subagent. */
export const SUBAGENT_SEND_TOOL_DESCRIPTION =
  "Send a message to a subagent you already spawned: correct its course, narrow its task, or ask a follow-up question. A running child receives it inside its current run where the harness supports live steering (pi, Claude Code) and as its next turn where it does not (Codex). A settled child starts a new run that keeps its existing context. Returns immediately; the child's reply arrives as a result message when the run settles.";

/** Model-facing schema descriptions for subagent_send. */
export const SUBAGENT_SEND_PARAMETER_DESCRIPTIONS = {
  id: "Subagent id to message, e.g. \"sa-1\"",
  message:
    "Message for the subagent. It cannot see this conversation, so restate any context it needs and say what you want back.",
};

/** Builds the subagent_send result describing where the message landed. */
export function buildSubagentSendResult(options: {
  id: string;
  title: string;
  wasRunning: boolean;
}) {
  const landing = options.wasRunning
    ? "It is running, so the message joins its active run (harnesses without live steering queue it as the next turn)."
    : "It had already settled, so this starts a new run on top of its existing context.";
  return (
    `Sent to ${options.id} "${options.title}". ${landing}\n` +
    `Its result arrives automatically when the run settles. Continue independent work if available; otherwise give a pending-work update and end the turn. No blocking wait is needed.`
  );
}

/** Points a blocking wait at output the parent has already received. */
export function buildAlreadyDeliveredNotice(options: {
  id: string;
  title: string;
  status: "running" | "done" | "error";
}) {
  const verb = options.status === "error" ? "failed" : "finished";
  return (
    `## ${options.id} "${options.title}" ${verb}\n\n` +
    `[output already delivered in this conversation as a subagent result message; not repeated here]`
  );
}

/** Describes listing all tracked running and settled subagents. */
export const SUBAGENT_LIST_TOOL_DESCRIPTION =
  "List all subagents (running and finished) with their harness and status.";

/** Builds the child completion/failure wrapper injected into the parent model's context. */
export function buildSubagentResultMessage(options: {
  id: string;
  title: string;
  status: "running" | "done" | "error";
  errorText?: string;
  output: string;
}) {
  const verb = options.status === "error" ? "failed" : "finished";
  let text = `Subagent ${options.id} "${options.title}" ${verb}.`;
  if (options.errorText) text += `\nError: ${options.errorText}`;
  text += `\n\n${options.output}`;
  return text;
}
