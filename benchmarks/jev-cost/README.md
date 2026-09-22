# Jev coding-cost pilot

Synthetic engineering pilot, not evidence of production savings. Eight JavaScript repair tasks have 58 behavioral cases and two multi-file fixtures. Task cases and reference solutions are parent-only. See `tasks/README.md` for the fixture contract.

## Providers and billing

- Astra: `openai-codex/gpt-6-astra`, Codex OAuth.
- Luna: `openai-codex/gpt-5.6-luna`, Codex OAuth.
- Jev: `typesafe/jev-1.13`, OpenRouter Decisions API. Record the served model version.
- Codex figures are API-equivalent estimates, **not actual subscription charges**. Jev figures are API-reported actual cost.
- A shared ledger conservatively caps actual Jev costs plus Codex API-equivalent costs and uncertain reservations at $50. Reservation precedes every generation call. Failed/unknown calls retain their reservation.
- Codex ignores a request output-token cap. Reserve its advertised maximum output at reachable pricing tiers instead. Input is bounded conservatively by UTF-8 bytes plus protocol/schema allowance. No automatic retries.
- Failed initialization before a request spends nothing. Authenticated model-catalog refresh is metadata discovery, not generation.

## Execution

Requires existing authorized pi Codex OAuth/OpenRouter credentials and the local Node Alpine image pinned in `grade.mjs` (`node@sha256:c610fcdfb1d5b4740dd70c284ed3cb16bb857e0f7166196e36a5501df7a3aa32`). No credentials enter grading containers. Paid calls occur only from explicit CLI commands:

```sh
node --test benchmarks/jev-cost/*.test.mjs
node benchmarks/jev-cost/bench.mjs smoke
node benchmarks/jev-cost/bench.mjs baseline
node benchmarks/jev-cost/bench.mjs routing
node benchmarks/jev-cost/bench.mjs variants
node benchmarks/jev-cost/bench.mjs verification
node benchmarks/jev-cost/bench.mjs screening
node benchmarks/jev-cost/context.mjs run
# Offline aggregation, after all paid commands complete:
node benchmarks/jev-cost/report.mjs
node benchmarks/jev-cost/render-report.mjs /tmp/jev-report-artifact
```

Default artifacts are outside the repository at `/tmp/jev-cost-pilot`; `JEV_BENCH_OUT` changes this location. The ledger has an exclusive writer lock. Do not run paid commands concurrently, discard a ledger, or clear a lock without confirming the writer has stopped. Completed runs are reused on resume. Never publish raw auth data or arbitrary runtime exception objects.

The context runner stops at unreviewed pending reservations. Explicitly reviewed uncertainty may proceed only with the entire uncertain amount still reserved against the cap; review is not settlement or forgiveness.

Each candidate/example runs in an ephemeral Docker container: no network, no host mounts, nonroot UID, read-only root filesystem, all capabilities dropped, no new privileges, memory/CPU/PID limits and an outer deadline. Docker removes the container; timeout cleanup explicitly removes it if the client was killed. The inner Node VM is a module loader, **not a security boundary**. Existing fixture self-tests execute only known trusted fixture code in ordinary subprocesses.

## Protocol and controls

- Baseline: both models, every task, two trials, alternating model order, medium reasoning, six-turn limit and three-minute deadline. Grade correctness and clean completion separately; verified success requires both.
- Routing: Jev chooses a model from prompt and buggy source. Luna also classifies the batch. Fixed rule sends multi-file tasks or tasks mentioning `fencing` or `cycle` to Astra; all others to Luna. Replay these selections against both measured model trials, including routing cost. This does not reproduce dynamic cache rebuilding and is not a fresh end-to-end routing trial.
- Tool catalog: sixteen short tool schemas, twelve describing disconnected external integrations. Controls: all schemas; fixed local read/write/example/discover set (added as a sanity check after the initial variant runs, not tuned on scores); ordinary discovery with read/discover initially; Jev initial selection; Jev each turn. Jev retains tools when noul >= 0.35, with discover/all fallback. No threshold fitting against outcomes. The fixed subset is retry-policy, lease-state, dependency-order.
- Observation masking: omit all but the two newest tool-result bodies; retain original task, system prompt, tool calls and result association. Small fixtures may not produce enough history to meaningfully test this policy.
- Context filtering: separate synthetic retrieved-note experiment. No raw user/system instruction filtering. This does not test replacement of real long-session compaction.
- Verification: Jev asks two narrow bug-presence questions; escalate if either noul >= 0.35. Test generated Luna patches, known-broken inputs and correct references. The ordinary-check control uses a separately written three-example suite per task (`checks.mjs`), not hidden grading cases. Escalation is a restart with Astra, replaying its original-task baseline. Include both generator costs, not just verifier cost.
- Bulk screening: Jev/Luna/Astra judge the same 16 correct/broken implementations. Reuse measured Astra fixes for broken inputs and measure Astra calls on already-correct inputs too. Pipeline repair totals are replay estimates, not new end-to-end trials. False negatives leave a broken item unrepaired; false positives incur unnecessary downstream work.

## Interpretation

Record input/output/cache token counts, duration, clean stop status, hidden-test results and all classifier costs. Report false negatives separately from false positives. Never claim a percentage cost reduction without a quality comparison. An eight-task synthetic pilot cannot establish production task-routing accuracy or long-session context savings. Different branches may benefit differently from provider caches despite distinct session IDs.

Initial access/setup and any interrupted calls are experiment overhead, not assigned to a successful arm. They remain in total spend/reservations. Parent planning/research and harness-development subscription usage is outside measured benchmark request totals; these are not whole-project accounting figures.
