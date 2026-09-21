# A/B report: self-compact control vs experimental on SUP-15081

Task in both threads: "investigate and root cause this issue. https://linear.app/verkada/issue/SUP-15081/retention-setting-ui-mismatch-on-cc-cameras". Model `anthropic/claude-fable-5-1`, both prompts sent at 21:25:20 UTC (14:25 local), same repo, same tools.

| | Control (`self_compact`, threshold only) | Experimental (`self_compact_experimental`, proactive) |
|---|---|---|
| Session | `01a0c5c7-fa16` | `01a0c5c8-0225` |
| Time to final answer | 17m 48s (21:43:08) | 11m 17s (21:36:37) |
| Assistant turns to answer | 36 | 35 |
| Tool calls to answer | 61 | 53 |
| Output tokens to answer | 16,278 | 15,040 |
| Cache write to answer | 84k | 107k |
| Cost to answer | **$2.50** | **$2.70** |
| Compactions | 0 | 7 (all after the answer) |
| Cost after the answer | $0 | **$5.61** (the loop, see below) |
| Total cost | $2.50 | $8.31 |

## Did they agree?

Yes, on every point. Both found the same two-part root cause:

1. `RetentionSlider.tsx` seeds `internalValue` from `value` once and never resyncs. PR #45167 (VER-1549, 2026-05-20) replaced `SliderMenuField`, which had `useEffect(() => setInternalValue(value), [value])`, and dropped that line.
2. `useRetentionDays.tsx` awaits `fetchRetentionDays()`, which returns void instead of the dispatch promise, so for CC cameras the hook reads a stale closure, sets `userStorageDays = 0`, and marks `loaded` before the data arrives. Verkada cameras take a different branch that really awaits, which is why only CC cameras show 0.

Both proposed the same fix (restore the effect; optionally return and await the dispatch promise) and both explained the Prod3 "doesn't work at all" report as `val !== userStorageDays` being false when the user picks the already-stored value. Experimental added two things control did not: the exact commit hash (`95516011b76`), and a "why other pages look right" section covering the navigate-from-connector-page case. Control's write-up was tighter and tied each step to the recording timeline more explicitly.

Experimental reached the answer 6.5 minutes faster with 8 fewer tool calls. I would not read much into that; single run, same model, and it started with a full cache miss (30.8k write) because it was the second process to start and lost the shared prefix.

## What the proactive variant actually did

The new code loaded in the experimental thread around 21:32 (you reloaded mid-run). From then on:

- 21:32:34 CHECKPOINT nudge at 28 tool calls, 62k tokens. It fired at 28 rather than 10 because the counter only started at reload and `compactable()` gates on there being enough material to summarize. **The model ignored it** and kept investigating for 25 more tool calls.
- 21:35:01 NOTICE at 100k tokens. Ignored (it was mid-investigation, which the prompt allows).
- 21:36:37 RUN ENDED nudge, 53 tool calls, 109k tokens. **The model complied**: wrote a 3,246-char note and called `self_compact_experimental`. Compaction landed at 21:38:46 (106k → ~31k prefix plus a 16.5k-char summary).

So in the one run we have, the mid-run nudge did nothing and the end-of-run nudge worked. That matches what the system prompt tells it (finish the atomic step first), but it means the compaction happened after the expensive part was already paid for. No pruning of useful context can be judged from this run because the user never asked a follow-up question after the compaction.

## The bug

After the first compaction the thread went into a loop: RUN ENDED → compact → RUN ENDED → compact, seven times, from 21:37 to 21:51. Each cycle cost about $0.70 in visible turns (a ~46k cache rewrite at $0.55–0.60 plus the compaction call at $0.10) plus the summarizer call, which pi does not record as a message. Total waste: $5.61, more than double the cost of the actual investigation.

Cause: the RUN ENDED follow-up is delivered inside the same agent run (`deliverAs: "followUp"`), so `before_agent_start` never fires again and `toolCallsThisRun` stayed at 53. Each compaction bumped the epoch, which re-armed the once-per-epoch guard, and `agent_end` fired the nudge again. The model's replies got progressively more exasperated ("Still waiting on your yes or no about opening the draft PR") until at 21:51:15 it refused: "Skipping this compaction: there have been zero tool calls". That refusal is what ended the loop, not the extension.

Fix (uncommitted, in `extensions/self-compact/index.ts`): reset `toolCallsThisRun` when the nudge is sent and again on `session_compact`. Regression test added in `extension.test.ts` ("RUN ENDED does not re-fire after the compaction it asked for"). 69/69 tests pass. My original test didn't catch it because it emitted `before_agent_start` between runs, which is not what happens for follow-ups.

## Takeaways

- Correctness: tie. Both threads got the right answer with the same fix.
- Cost to answer: control was $0.20 cheaper, within noise given experimental's cold-cache start.
- Proactive compaction did not trigger before the answer. The 10-tool-call trigger, as worded, gets deferred until a natural stopping point, and for a single investigation prompt that stopping point is the answer itself. If you want compaction to happen mid-investigation you would need the CHECKPOINT nudge to be firmer, or to fire at a natural pause (e.g. after a `read` batch, not during an `exec_command` chain).
- The experiment's real result is the loop bug. Fixed, but rerun needed before drawing any conclusion about cost savings or context loss. For the rerun, ask a follow-up question in both threads after the compaction (e.g. "which commit introduced it?") to test whether the summary kept what matters.

## Files

- Status script: [file:///Users/michael.lam/Coding/mical-pi/scripts/ab-session-status.sh](file:///Users/michael.lam/Coding/mical-pi/scripts/ab-session-status.sh)
- Control session: [file:///Users/michael.lam/.pi/agent/sessions/--Users-michael.lam-Documents-Verkada%20Repos--/2026-09-21T21-03-32-374Z_01a0c5c7-fa16-76e4-908f-37fbc1b9fd8b.jsonl](file:///Users/michael.lam/.pi/agent/sessions/--Users-michael.lam-Documents-Verkada%20Repos--/2026-09-21T21-03-32-374Z_01a0c5c7-fa16-76e4-908f-37fbc1b9fd8b.jsonl)
- Experimental session: [file:///Users/michael.lam/.pi/agent/sessions/--Users-michael.lam-Documents-Verkada%20Repos--/2026-09-21T21-03-34-437Z_01a0c5c8-0225-74bf-bf1e-dc4470a893b4.jsonl](file:///Users/michael.lam/.pi/agent/sessions/--Users-michael.lam-Documents-Verkada%20Repos--/2026-09-21T21-03-34-437Z_01a0c5c8-0225-74bf-bf1e-dc4470a893b4.jsonl)
- Sessions folder: [file:///Users/michael.lam/.pi/agent/sessions/--Users-michael.lam-Documents-Verkada%20Repos--/](file:///Users/michael.lam/.pi/agent/sessions/--Users-michael.lam-Documents-Verkada%20Repos--/)
