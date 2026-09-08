---
name: agent-research
description: Run or resume a research task with shared memory, an iteration budget, and a soft cap on concurrent agents.
disable-model-invocation: true
---

# Agent research

Work as a trusted research associate. Agree on the objective and boundaries; use your judgment about how to investigate.

## Agree on the run

Use the conversation and existing research notes to establish:

- The question or improvement sought, and what evidence would count as success.
- What may change and what must remain intact.
- The iteration budget and stopping rule, including any review checkpoints or cost/time limits.
- A soft cap on concurrently active worker agents. Ask for this if the operator has not specified it; distinguish it from any hard limits.

Ask only about missing details that prevent a useful, bounded run. "Run N iterations" means spend N experiments investigating; "up to N, stopping at the target" permits early success. Clarify ambiguous stopping instructions before starting.

## Shared memory

Create a separate directory for each research task, following the project's convention or using `research/<task-id>/`. Keep its shared record in `research.md` and supporting artifacts alongside it. Reuse an existing task's record when resuming; keep unrelated investigations separate.

The record contains:

- **Agreement:** objective, boundaries, budgets, stopping rule, and iteration count.
- **Current understanding:** supported findings with evidence links, tentative hypotheses, disagreements, and open questions.
- **Experiment history:** append-only attempts and outcomes, including failures and interrupted work.

Keep current understanding concise and revise it as evidence changes. Preserve earlier evidence in the history; repeated claims or agent agreement do not establish a finding. Record active assignments so workers can avoid duplicate work.

One coordinator owns updates to the shared record. Workers read it and return findings with artifact references rather than overwrite shared conclusions. On resuming or handing off, reconcile the record with actual artifacts and active work before continuing. A fresh agent should be able to choose the next useful experiment from this record.

## Experiment loop

Establish a baseline before counting experiments. For each iteration:

1. Choose a useful question to test, informed by the evidence so far.
2. Run the experiment within the agreed boundaries, preserving the previous accepted state.
3. Evaluate the result. Keep supported improvements; restore the accepted state when a change fails or regresses. Retain useful evidence from either outcome.
4. Record the question, change, result, decision, and evidence needed to reproduce it. Count completed attempts, including failed experiments; mark interrupted attempts separately.

Then begin the next iteration without asking whether to continue. A plateau is information to investigate, not an automatic stopping point.

## Delegation

Spawn and replace workers as useful within runtime capabilities; there is no separate lifetime agent-count limit. Use the agreed soft cap as the normal concurrency level. A temporary burst above it is permitted when independent work justifies it; record the reason and return within the cap when that work finishes. Hard runtime, cost, and operator limits always apply.

All workers share the task's iteration and resource budgets. Reserve experiment slots before parallel dispatch so concurrent work cannot overspend the remaining iterations. Each assignment names its question, scope, budget, and expected evidence. Peer findings are evidence, not authority to change the agreement. At a stop or pause, stop or checkpoint outstanding workers and record unfinished work.

## Protect the result

Keep evaluation criteria and held-out evidence outside the optimization scope. Changes to the research agreement require user approval. Confirm promising results with repeat measurements or independent evidence appropriate to the task; distinguish observations from interpretation.

Preserve unrelated work. Pause if a blocker prevents valid or safe experimentation, and explain what is needed to resume. User interruption and agreed resource limits take precedence over the iteration count.

## Finish

At the agreed stopping point, leave the best verified state and summarize what changed, what did not work, what remains uncertain, and why the run ended. Link to the experiment record rather than repeating it.
