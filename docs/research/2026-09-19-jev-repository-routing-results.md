# Harder repository routing results

Date: September 19, 2026. Follow-up to the synthetic pilot, which had a ceiling effect.

## Result

On six authored feature tasks in real repository modules, Astra passed **5/6** and Luna **1/6**. On the three held-out tasks alone, Astra passed **2/3**, Luna **0/3**.

Jev, the Luna classifier and the fixed keyword rule all chose Astra for every held-out task. They therefore reproduced Astra-only quality. Jev added a small selection fee and showed no advantage over the rule on this set. This round distinguishes coding capability much better than the first pilot, but does not establish learned-router value on a natural workload mix.

Use Astra for this kind of complex multi-module change. Do not infer that it is infallible or that Luna cannot solve a failed case with more time. A mixed held-out set near the capability boundary is still needed before installing a learned router.

## Preparation and controls

- User approved mical-pi and personal-website/apps/foosheq, including selected sanitized source sent to Jev through OpenRouter.
- Source revisions: mical-pi `503adb5f944d3443d3e82f2c337c3a6f0d9e5d41`; personal-website `b8c6e9bd5ecd6c5620cf7bce82329bcf0e801b10`.
- 42 retained file instances checked against their commits. One provider fixture name was sanitized without changing behavior; other retained files were byte-identical. Minimal package/test configs were authored for isolation.
- Six independent tasks, three calibration and three evaluation. These are proposed features in actual code, not claims of discovered production bugs. Full selected modules and their existing tests remain visible.
- 150 hidden feature cases in total, in addition to visible regressions. Some hidden commands rerun the visible suite, so their displayed totals overlap.
- Every baseline passed visible tests and failed hidden feature requirements. Every reference passed both, inside the same isolated image. Foosheq authors also checked twelve deliberately incomplete reference variants, all rejected.
- Task/source/grade fingerprints and policy frozen before paid runs. All three evaluation routing decisions saved before either generator attempted held-out work.
- Same generation policy: 24 model turns, 10 minutes, medium reasoning, 262144-byte serialized context cap. Separate sessions, alternating model order. Each model navigates files with tools; solutions are not pasted into prompts.
- Candidate runtime grading covers selected modules, not full application builds, hardware or browser integration.

## Per-task outcomes

| Task | Split | Luna | Astra |
|---|---|---|---|
| Cancellable device capture | Calibration | Fail: turn limit; 435/445 tests | Pass: 445/445 |
| Durable undo/redo history | Calibration | Fail: 331/337 | Pass: 337/337 |
| Provider charge reconciliation | Calibration | Pass: 7/7 after one transport restart | Pass: 7/7 |
| Cancellable workflow handles | Evaluation | Fail: 7/9 | Fail: 7/9 |
| Group graph gesture | Evaluation | Fail | Pass: 325/325 |
| Portable capture transcript | Evaluation | Fail: turn limit | Pass: 377/377 |

Both workflow implementations missed repeated-result serialization behavior. They passed the existing 13 regression tests but failed the same two hidden feature checks. No candidate was repaired or resubmitted after hidden feedback.

Luna's failures were not solely a turn-limit effect: it finished normally on durable history, workflow cancellation and graph gestures while still missing requirements. Conversely, turn-limited failures do not prove that larger iteration budgets would not help. This round did not test that sensitivity.

## Held-out policy replay

Costs are Codex API-equivalent estimates plus actual Jev selector charges. These are not subscription payments. No uncertainty reservation occurs in the held-out coding results; the transport reservation is in calibration.

| Policy | Verified success | Total accounted cost |
|---|---:|---:|
| Luna only | 0/3 | $0.04964724 |
| Astra only | 2/3 | $2.055936 |
| Fixed keyword rule | 2/3 | $2.055936 |
| Jev selection | 2/3 | $2.056590696 |
| Luna selection | 2/3 | $2.0588182 |
| Luna then visible-check fallback | 1/3 | $0.97650124 |
| Hindsight oracle, not deployable | 2/3 | $1.42776048 |

The fixed rule uses cancellation/concurrency/atomicity/rollback/stale/reconnect/transaction language. It was not tuned on evaluation outcomes. Both learned selectors see the same baseline excerpts and calibration summaries; hidden tests and candidate results are excluded. Uncertain calibration cost is explicitly distinguished from known usage in selector inputs.

Fallback escalates only on abnormal completion or failed visible tests. Existing regressions accepted the incorrect completed Luna patches, so this gate missed feature failures. Hidden grading is never used as an escalation oracle.

The hindsight oracle saves cost by choosing the cheaper failed attempt on the task neither model solved. It is an upper bound on retrospective selection, not an available routing algorithm. Replay does not reproduce dynamic handoff, cache rebuilding or fresh routed sessions.

## Accounting

This round:

- API-reported Jev charges: **$0.000654696**.
- Known Codex API-equivalent usage: **$4.01557696**.
- Additional uncertain reservation: **$0.1714505**.

Across both rounds:

- API-reported OpenRouter charges: **$0.004221672**.
- Known Codex API-equivalent usage: **$6.6552598**.
- Uncertain reservations: **$6.760163**.
- Conservatively committed against the original $50 cap: **$13.419644472**.
- Remaining conservative allowance: **$36.580355528**.

One Luna calibration attempt failed at the provider transport boundary with an upstream connection timeout. After explicit review, it was restarted once from a fresh isolated snapshot, without hidden feedback. Earlier calls and the full unknown-call reservation remain in task and budget accounting. The completed task used 17 turns on the restart; total attempts consumed 30 model calls. Coding failures were not retried.

Parent planning, task authoring and benchmark-development subscription resources are outside these measured generation-request totals, as in the first round. Actual subscription savings and quota impact were not measured.

## Safety and reproducibility

Generated code ran only in fresh Docker containers: no network or host mounts, nonroot, dropped capabilities, read-only image, bounded tmpfs/memory/PIDs/CPU and timeout cleanup. Original source and dirty working trees were not modified. No production services, devices or credentials were accessed.

Sandbox image: `sha256:e02fddcff7689714ef9c396e4603f0aaec383c01660e995310c643e88af81d02`.

The runner rejects stale task/checkpoint fingerprints, requires all held-out routes before any held-out generation, retains partial selector checkpoints, and rejects inconsistent test summaries. Incomplete comparisons are withheld rather than silently omitting interrupted costs. Protected-file hashes detect final mutation, not temporary tampering restored before exit; this is not a complete malicious-benchmark-gaming defense.

134 offline regression tests pass, including all 11 Docker sandbox checks. Files:

- `benchmarks/jev-cost/REPOSITORY-PILOT.md`
- `benchmarks/jev-cost/repo-runner.mjs`
- `benchmarks/jev-cost/repo-sandbox.mjs`
- `benchmarks/jev-cost/repo-report.mjs`
- `benchmarks/jev-cost/repo-tasks/`
- Raw artifacts and frozen protocol: `/tmp/jev-cost-pilot/repo-runs/`

## Limits

Only three evaluation tasks, all author-rated hard. Calibration mixes moderate and hard work, but the evaluation set does not represent the normal easy/hard workload mix. The tasks are correlated by repository, have one completed attempt per model, and were authored with reference solutions rather than independently sampled from production issues. Provider-cache and sampling variation remain. These results justify further boundary-case testing, not a general savings percentage or automatic default changes.
