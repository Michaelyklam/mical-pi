/** All model-facing strings for the subagents tools. */

/** Describes subagent_spawn, including harnesses and the fixed concurrency cap. */
export const SUBAGENT_SPAWN_TOOL_DESCRIPTION =
  "Spawn a background subagent: a fully autonomous, headless agent with its own context window and the selected harness's normal host permissions. Provider billing routes are isolated: pi children must use the parent model's exact provider; Claude Code is available only to anthropic parents; Codex CLI is available only to openai-codex parents. Fire-and-forget: this returns immediately with an id. When the subagent settles, its output arrives on its own between your tool calls, so keep working instead of waiting for it; subagent_check peeks at progress and subagent_send redirects it mid-run. Children cannot orchestrate more agents/workflows or ask the user, and cannot see this conversation, so the prompt must be self-contained. Only use trusted working directories. Max 16 subagents can be running at once across all harnesses.";

/** Adds background subagent delegation to the parent model's available-tools prompt. */
export const SUBAGENT_SPAWN_PROMPT_SNIPPET =
  "Spawn a background subagent on a chosen harness (pi, Claude Code, or Codex; own context, normal tools) for a self-contained task";

/** Guides the parent model to delegate standalone tasks and avoid unnecessary blocking waits. */
export const SUBAGENT_SPAWN_PROMPT_GUIDELINES = [
  "Use subagent_spawn to delegate self-contained tasks that can run in the background; give it a complete, standalone prompt.",
  "Use the pi harness with its inherited model by default so subagent work stays on the parent's provider billing route.",
  "Never select a model from a different provider. Claude Code is permitted only when the parent provider is anthropic; Codex CLI is permitted only when the parent provider is openai-codex.",
  "After subagent_spawn, keep working on parent tasks. A child's result is injected between your tool calls when it settles, so subagent_wait is only for when you cannot take another step without the result.",
  "Use subagent_check to peek at a running child and subagent_send to correct, narrow, or follow up on it. Prefer those over cancelling and respawning.",
];

/** Model-facing schema descriptions for subagent_spawn task and execution options. */
export const SUBAGENT_SPAWN_PARAMETER_DESCRIPTIONS = {
  prompt:
    "Task prompt for the subagent. Must be self-contained: include all needed context, file paths, and what to report back.",
  name: "Short human-readable name for this subagent, shown in listings and the UI",
  harness:
    'Harness to run the subagent on. Use "pi" by default. "claude" is allowed only for an anthropic parent; "codex" only for an openai-codex parent. Cross-provider spawns are rejected.',
  workingDir:
    "Trusted working directory for the autonomous child (default: current working directory)",
  model:
    'Model hint interpreted by the chosen harness. Pi model hints are restricted to the parent model\'s exact provider; omit to inherit the current model. Claude and Codex hints use their native aliases/slugs when those harnesses are permitted.',
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
    `It runs in the background. Its result will be injected between your tool calls when it finishes, so continue with other work. ` +
    `subagent_check to peek, subagent_send to steer it, subagent_cancel to stop it, subagent_list to see all, ` +
    `subagent_wait(ids: ["${options.id}"]) only if you cannot proceed without the result.`
  );
}

/** Describes explicit blocking collection of one or more subagent results. */
export const SUBAGENT_WAIT_TOOL_DESCRIPTION =
  "Block until all listed subagents have settled, then return their final outputs. This parks your turn and the user cannot get a reply until it returns, so prefer letting results arrive on their own and use this only when you cannot take another step without the result. Results already injected into this conversation are reported as a pointer rather than repeated.";

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

/** Describes nonblocking inspection of a subagent without consuming its result. */
export const SUBAGENT_CHECK_TOOL_DESCRIPTION =
  "Peek at a subagent's status and recent activity without blocking. Does not consume its result. Use this to check in on a running child between your own tool calls.";

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
    `Keep working: its result arrives between your tool calls when the run settles. Use subagent_check to peek meanwhile.`
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
