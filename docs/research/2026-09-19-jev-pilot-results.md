# Jev / Astra / Luna: synthetic coding-cost pilot

Run September 18–19, 2026. Implementation: `benchmarks/jev-cost/`. Raw artifacts and ledger: `/tmp/jev-cost-pilot/`. No production harness defaults changed.

## Verdict

No clear Jev advantage over the strongest simpler control emerged. Luna was sufficient for every baseline task; Jev tool selection essentially tied a fixed local tool set; lexical context filtering matched Jev; Luna bulk screening produced lower total repair cost. Jev verification caused unnecessary Astra escalation.

This is a small synthetic engineering pilot, not production evidence. Eight explicit JavaScript repair specifications and 58 hidden cases are too easy to establish routing quality for heavy repository work. Two baseline trials per task are repeated measurements, not 16 independent task types. Context notes are redundant synthetic retrieval noise, not essential history.

## Measured comparisons

Costs below combine Codex API-equivalent estimates with actual Jev charges where relevant. They are not actual subscription charges.

| Arm | Verified success | Total cost |
|---|---:|---:|
| Luna baseline | 16/16 | $0.02985624 |
| Astra baseline | 16/16 | $0.825052 |
| Jev routing replay | 16/16 | $0.174242516 |
| Fixed-rule routing replay | 16/16 | $0.4728642 |
| Luna routing replay | 16/16 | $0.48415144 |

Luna averaged 27.6× lower API-equivalent cost than Astra on these tasks. Mean accumulated model-request time was 19.16 seconds for Luna and 17.44 seconds for Astra; local tool/grader time is excluded. Do not infer that the cheaper model was faster.

### Tools: three-task subset

| Arm | Verified success | Total cost |
|---|---:|---:|
| Full catalog | 3/3 | $0.166958 |
| Fixed local tool set | 3/3 | $0.14146 |
| Ordinary discovery | 3/3 | $0.15323 |
| Jev initial selection | 3/3 | $0.141217196 |
| Jev every turn | 3/3 | $0.144062776 |
| Older observation masking | 3/3 | $0.18788 |

The Jev/fixed-set difference is $0.000243, far below what three single trials can establish reliably. The sixteen-schema catalog includes twelve disconnected external integrations. The fixed-local control was added after the initial variant runs as a sanity check, without score-based tuning. Masking short histories hurt measured cost; this says little about genuinely long sessions.

### Context: three-task subset

Every arm passed 3/3: no notes, raw notes, lexical filtering, Jev filtering, and Luna summarization. Raw cost was $0.12813; lexical filtering $0.06512; Jev $0.06633849; Luna summary $0.0603958; no notes $0.05263. Filter/summarizer costs are included. The target note duplicates the original request, so omitting all notes is valid here. This is not a compaction-safety test.

### Verification and escalation

All eight first-trial Luna patches were correct. Ordinary validation examples accepted all eight. At the preset 0.35 threshold, Jev incorrectly flagged four and triggered four unnecessary Astra restarts. Replay cost increased from $0.01431656 to $0.265279612 without improving correctness.

On known-broken controls, Jev detected 8/8 and ordinary checks detected 7/8. On correct references, Jev falsely flagged 4/8; ordinary checks flagged none. Sensitivity to realistic faulty Luna patches remains unmeasured because none occurred here. No threshold was tuned after seeing outcomes.

### Bulk screening plus repair

Corrected, blinded batch: eight broken and eight correct implementations, opaque IDs, mixed order. Paired versions of the same task make this easier than an unrelated production batch. Pipeline costs replay measured Astra repairs, including unnecessary work on already-correct inputs.

| Screener | Missed bugs | False alarms | Correct after repair | Total workflow cost |
|---|---:|---:|---:|---:|
| Review all | 0 | 8 unnecessary reviews | 16/16 | $0.948274 |
| Ordinary checks | 1 | 0 | 15/16 | $0.377338 |
| Jev | 0 | 3 | 16/16 | $0.648288602 |
| Luna | 0 | 0 | 16/16 | $0.428606 |
| Astra | 0 | 0 | 16/16 | $0.489588 |

Jev classification alone cost $0.000280602 versus Luna's $0.001818. Its false positives made the complete workflow about 51% more expensive than Luna screening. This illustrates why classifier-only savings are insufficient.

## Accounting and corrections

- 284 settled benchmark requests.
- Actual API-reported OpenRouter charges: **$0.003566976**.
- Codex API-equivalent estimate: **$2.63968284**, not an incremental charge.
- Uncertain reservations: **$6.5887125** ($0.01 for the initial rejected Jev call; $6.5787125 for a manually interrupted Astra request).
- Total conservatively committed against the $50 ceiling: **$9.231962316**.
- Parent research/planning and benchmark-development subagent subscription usage is outside these benchmark-request totals.

A security audit reproduced a VM escape. The live process was paused, generated-code execution moved into nonroot Docker containers without network/host mounts, and the interrupted request retained its full reservation. All 32 baseline grades were subsequently rechecked inside containers and matched.

The first bulk-classification payload accidentally leaked good/bad labels through item IDs. Those classifier results were discarded. All three classifiers were rerun with opaque IDs and mixed ordering. Old costs remain experiment overhead. A regression test now checks payload blinding.

82 offline tests pass. Only the new benchmark directory and this results note were added for this pilot; unrelated working-tree changes were preserved.

## Next experiment

Use a held-out set of larger real-repository tasks on which Luna sometimes fails. Measure real large-catalog discovery and long-history masking before introducing a learned selector. Fit any Jev thresholds on separate development data. Keep behavior tests and do not use Jev as a security or correctness authority.
