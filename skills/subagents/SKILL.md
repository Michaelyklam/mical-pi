---
name: subagents
description: Read before delegating assignments to subagents or composing an explicitly requested workflow.
---

# Subagents

Each subagent is headless, has its own context window, cannot see the parent conversation, cannot ask the user, and cannot spawn subagents or workflows. Give every child a self-contained prompt with paths, constraints, and the expected report.

## Runtime defaults and explicit selections

Omit `harness`, `model`, and `reasoning_effort` unless the user explicitly selects them. The runtime reads local per-harness defaults; without config, the harness is Pi, Pi inherits the parent's model and effort, and Claude Code/Codex use native defaults. Pass each user-selected field as an explicit tool argument. Fields override config independently.

Workflow `agent()` calls use the same Pi defaults. Omit `model`, `provider`, and `effort` when the user has no selection. An explicit `provider` requires an explicit `model`; an explicit model route replaces the configured route while an omitted effort still uses the configured effort.

For explicit Pi selections, resolve exact IDs from the model catalog. A bare ID uses the parent provider for subagents; `provider/model-id` selects an exact route. Report an unavailable selection before substituting a model or configuring another provider. When setting up or troubleshooting local defaults, read `../../docs/subagent-defaults.md` for the config shape, precedence, and errors.

Available harnesses are `pi`, `claude` (Claude Code, also "cc"), and `codex` (Codex CLI). Claude Code and Codex require their CLI to be installed and authenticated. Reasoning efforts are `off`, `minimal`, `low`, `medium`, `high`, `xhigh`, and `max`; each harness maps them to its supported native equivalent.

## Spawn and manage

Call `subagent_spawn` with a complete `prompt`, short `name`, and optional `harness`, `working_dir`, `model`, and `reasoning_effort`. At most 16 subagents run concurrently.

- `subagent_check({ id })`: peek without blocking.
- `subagent_compact({ id })`: manual recovery for a settled Pi child when its own context management is unavailable or insufficient, or when the user requests it. It runs only above 40,000 tokens; lower usage is skipped. Claude Code and Codex return an unsupported-backend error.
- `subagent_send({ id, message })`: send follow-up work directly. A running child gets it inside its current run on pi and Claude Code, and as its next turn on Codex; a settled child starts a new run on top of its existing context. Pi children with self-compaction enabled manage their own checkpoints and compaction before new work.
- `subagent_list()`: list all runs.
- `subagent_wait({ ids })`: legacy blocking tool, reserved for an explicit user request to block. Normal delegation uses automatic result delivery.
- `subagent_cancel({ ids })`: stop runs while preserving partial transcripts.
- `/subagents`: inspect or take over a run interactively.

## Delegate complete assignments

Give each coding worker ownership of investigation, implementation, testing and repairs within a bounded assignment. Keep tiny tasks in the parent when delegation would add more work than it saves. Before dispatching or requesting a revision, fill in the template below. Replace broad instructions such as "test thoroughly" with named checks and observable completion criteria.

### Choose testing depth

Choose by the risk of the changed behavior, not the size of the repository. Required repository checks and safety gates still apply at every level.

| Level | Use for | Expected evidence |
| --- | --- | --- |
| Light | Copy, styling, presentation-only changes, small isolated revisions | One targeted regression or before/after check and a smoke check of the affected user path. For published artifacts, verify the delivered version loads. |
| Standard | Feature or behavior changes within an existing module | Targeted regressions, affected-module tests and relevant integration checks. |
| Deep | Solver, persistence, security, shared architecture or release-critical changes | Explicitly named broader suites, invariants, compatibility or performance checks justified by the change. |

Reuse existing evidence only when its code, dependencies and execution conditions remain applicable; identify reused results as prior evidence, not fresh passes. Rerun checks invalidated by a change or concrete failure. A small visual revision does not automatically require repeating unchanged solver benchmarks or backend-equivalence suites.

### Assignment template

```text
Outcome: [The user-visible result or exact question to answer.]
Context: [Authoritative spec, relevant files, prior findings and existing checks.]
Ownership: [Writable paths; read-only inputs; preserve unrelated work.]
Scope: [Required changes and explicit exclusions. State which changes need approval.]

Testing level: [Light / Standard / Deep, with a short reason.]
Required checks: [Named commands or observable assertions; include delivery checks if relevant.]
Reuse: [Applicable prior evidence. Say what changes would invalidate it.]
Done when:
- [Specific observable outcome demonstrated.]
- [Required checks pass, or any blocked check is reported as blocked, not passed.]
- [Required artifact is delivered and accessible.]

Checkpoint: [Work budget; default 15 minutes of active work for a small revision.]
At the next safe boundary after this budget, if delivery is not imminent, return
PARTIAL or BLOCKED with completed work, the exact obstacle, remaining steps and
any decision needed. This is a scope-review checkpoint, not permission to skip
checks, claim completion or abandon a running job. Identify any live job and its
session/log so responsibility can be handed back explicitly.

Escalation: Fix failures within this scope. If completion requires changing an
excluded component, new dependencies, disputed requirements or broader testing,
report the evidence and proposed scope change before proceeding. After two
attempts at the same failure without new evidence, report the blocker rather
than repeating the loop. A concrete new hypothesis can justify another attempt.

Stop rule: Once the outcome and required checks are satisfied, deliver and stop.
List optional polish, extra scenarios and unrelated defects as follow-ups.
Expand checks only for a concrete changed dependency or failure, and explain why.

Return: DONE / PARTIAL / BLOCKED; concise outcome, changed paths, checks with
results, artifact/link, and remaining limitations. Put long logs in files.
```

For research or review-only assignments, replace implementation checks with a bounded question/finding list and required sources or artifacts. Do not turn a narrow investigation into an exhaustive audit.

Example, Light visual revision: update the wetness palette and legend only; preserve water rules. Demonstrate one pour-release-drain trace with conserved water, inspect the resulting colors in the browser, and verify the published build. Done means the intended sequence is visible and the link works, not that every historical numerical suite has been rerun.

### Parent review

Review the actual patch and required evidence, not just the worker's success claim. Respect the same testing budget during review; add independent checks when a concrete risk or evidence gap warrants them. Send one consolidated correction request to the same worker, specifying the remaining acceptance gap rather than restarting the entire assignment. Reassess scope at checkpoints instead of letting optional work become a new completion requirement.

## While children run

A settled child's result is delivered automatically. Continue only genuinely independent parent work; leave the assigned investigation and implementation to its worker. If nothing independent remains, tell the user what is still running and end the current turn without claiming the task is complete. Resume when the result is injected; keep the main session available for user input instead of blocking or polling.

`subagent_wait` parks the turn and prevents a reply until it returns. Reserve it for an explicit user request for a blocking wait. Depending on a child's result is not by itself a reason to call it. When a wait covers a result that already arrived, it reports a pointer instead of repeating the output.

Use `subagent_check` only when progress information would change your next action, such as investigating a suspected stall. Use `subagent_send` to correct or narrow an assignment rather than cancelling and respawning.

Leave settled children unmodified unless you need them again. Reuse them with `subagent_send` directly; routine parent-side compaction is unnecessary. Use `subagent_compact` only for the manual recovery cases above, not merely because a child finished or is being reused.
