# Jev coding-agent evidence audit

Audited 2026-09-18. Desk research only; no model calls, paid experiments, installs, or implementation.

## Conclusion

**Within the sources checked, no strong, independently reproduced evidence establishes that Jev lowers total cost per successful coding task while preserving or improving task success.** There is useful component-level evidence, public integration code, and one newly located end-to-end toy experiment with substantial limitations. This is not evidence that Jev cannot help.

The strongest findings are Firstmate's detailed dispatch verification record and TypeSafe's 488-request skill-selection experiment. Neither measures completed coding tasks. A public `jev-auto` experiment reports approximately 8% lower estimated Claude spend on one app, but a fixed cheapest-model baseline did much better. Its cost calculation omits Jev charges, its grading is weak, and raw run artifacts were not found in the checked tree.

## 1. Firstmate: substantive public code, private evaluation inputs

[Kun Chen's original post](https://x.com/kunchenguid/status/2100468943853085061) reports **71% lower cost and 90% lower wall time for dispatch**, including the supervisor LLM call that invokes Jev. Its [attached graphic](https://pbs.twimg.com/media/HSYK_gbagAAqKqr.jpg?name=orig) labels the denominator explicitly as cost/time **per dispatch**: the old path takes 28.6 seconds and three tool calls; Jev takes about 200 ms, with a subsequent code stage labeled 2.75 seconds. No absolute baseline dollar amount or itemized cost trace is supplied.

The post claims agreement with Fable on 25 tasks. That is agreement with another model, not proof that the selected agents completed their tasks correctly. Its separate observation of 100+ API calls and a $0.01 dashboard reading is not a measured total coding bill.

The [public verification record](https://github.com/kunchenguid/firstmate/blob/1bb72cc5f88014c86e3d03244efa0bb26c22d001/docs/verification/dispatch-resolve.md) is more informative:

| Measure | September 16 run | September 17 run |
|---|---:|---:|
| Briefs | 25: 15 real + 10 synthetic | Same 25, changed none-option wording |
| Rule agrees with hand label | 20/25 (80%) | 20/25 (80%) |
| Resolved profile agrees with hand label | 20/25 (80%) | 18/25 (72%) |
| Clear / ambiguous / escalate / error | 18 / 1 / 6 / 0 | 17 / 2 / 6 / 0 |
| Clear profile differs from hand label | 0/18 | 1/17 (5.9%) |
| API latency, min / median / max | 152 / 214 / 348 ms | 137 / 220 / 1,795 ms |

The first run's disagreements included one bad hand label, three approval-gated escalations, and one ambiguous case. Therefore 20% label disagreement is **not** a 20% unsafe-dispatch rate. Conversely, zero API errors does not mean zero routing errors. The second run's clear mismatch selected medium rather than high reasoning for a synthetic tweak at 0.90 confidence. Non-clear outcomes were 7/25 and 8/25; their downstream resolution costs are not reported.

The record also reports 25/25 agreement between lean and full Jev requests. That is a different comparison from the post's claimed Fable agreement; the public record does not reconcile them.

**Reproducibility:** [resolver source](https://github.com/kunchenguid/firstmate/blob/1bb72cc5f88014c86e3d03244efa0bb26c22d001/bin/fm-dispatch-resolve.sh) and [offline tests](https://github.com/kunchenguid/firstmate/blob/1bb72cc5f88014c86e3d03244efa0bb26c22d001/tests/fm-dispatch-resolve.test.sh) are public. The tests fake `curl` and quota responses; they establish integration behavior, not live accuracy. The record explicitly keeps briefs and user rules in a private report. The resolver uses floating `jev-latest` (observed as `jev-1.13.0`), a 0.6 confidence floor, and deterministic approval/quota gates. Neither the 71% saving nor the live accuracy tables can be independently reproduced from the public inputs alone.

## 2. Newly located end-to-end attempt: `33Audits/jev-auto`

[Benchmark report and scripts](https://github.com/33Audits/jev-auto/tree/792b5b803d55f1eb8f30b30c215d0fcb5b3f3aa7/bench) describe **one six-turn Vite/React todo-app build per arm**, not six independent tasks. The control also uses the relay but pins the model tier.

| Claude Code, MCP disabled | Reported wall time | Estimated generation spend | Reported checks |
|---|---:|---:|---:|
| Pinned balanced | 119 s | $1.8749 | 7/7 |
| Jev routing | 123 s | $1.7257 | 7/7 |
| Pinned cheapest | 104 s | $0.4279 | 7/7 |

Jev routing saves **7.96% of estimated generation spend**, not 77%. The **77.18%** saving belongs to simply using the cheapest model throughout. Routed wall time is slightly worse; the author cautions against interpreting differences under about 10%. With MCP enabled and about 308k context, routing reportedly changes nothing because the cheapest tier cannot hold the context.

The Codex comparison reports 286 → 227 seconds and $2.3724 → $0.7038 with 7/7 checks. **Do not quote the roughly 70% dollar reduction as measured savings:** the author says Codex prices are placeholders, and routed token use actually rises from 330k to 478k.

Code-level qualifications:

- [Cost accounting](https://github.com/33Audits/jev-auto/blob/792b5b803d55f1eb8f30b30c215d0fcb5b3f3aa7/src/ledger.mjs) applies model rates and approximate cache multipliers to generation usage. The [Jev appraiser](https://github.com/33Audits/jev-auto/blob/792b5b803d55f1eb8f30b30c215d0fcb5b3f3aa7/src/appraisers/typesafe.mjs) discards API usage, so this is not an all-in bill. It uses `jev-latest` and falls back to local heuristics on missing keys or errors.
- [Grading](https://github.com/33Audits/jev-auto/blob/792b5b803d55f1eb8f30b30c215d0fcb5b3f3aa7/bench/grade.mjs) checks source patterns: a checkbox string counts as toggling; an `expect` plus `render`/`screen` counts as a real test. Seven checks are not seven independently validated successful tasks, nor do they establish behavioral equivalence.
- Scripts and prompts are public, but raw result ledgers/generated apps were not found in the checked tree. No rerun was performed. This is a rerunnable experimental design, not an independently reproduced result or broad failure-rate estimate.

This is closer to the requested evidence than dispatch-only demonstrations, but too small and incompletely accounted to settle the question.

## 3. Best larger component experiment: skill suggestion

TypeSafe's [cookbook, code and rendered results](https://docs.typesafe.ai/cookbooks/skill_suggestion.md) compare `claude-haiku-4-5-20251001` alone, with `jev-1.12` suggestions, and with oracle labels. There are **488 synthetic requests**, one first-response measurement per request per arm, against a 182-skill catalog:

- **315 covered requests:** wrong or missing first skill loads fall from 16.8% to 7.3%, consistent with 53 → 23 errors. The paired breakdown reports 37 fixed and seven newly broken cases.
- **173 uncovered requests:** needless loads fall from 9.8% to 4.0%, consistent with 17 → seven errors.
- Oracle error rates remain 2.5% and 1.2%. These are skill-load errors, not coding-task failures.

The source supplies prompts, thresholds and scoring code, and describes replay using `requests.json`, `hermes_roster.json` and `json_cache.json`. Those named data/cache files were not independently obtained in this audit, so complete offline reproduction was not verified. Requests were model-generated from skills; there is no reported downstream task completion or all-in cost comparison. **The full skill roster stays in the agent prompt**, so this experiment does not demonstrate roster-token savings.

## 4. Review demos and Hunter Bohm's small suite

- **`devagrawal09/jev-review`:** inspected [commit `31f8960`](https://github.com/devagrawal09/jev-review/tree/31f89602797fb7bea007f8a480bf368bf564954e). Public workflow, lockfile and dashboard, but no labeled benchmark corpus, baseline experiment, accuracy report, or cost ledger found. `npm run check` performs type/dependency/syntax checks, not defect-detection evaluation. [Policy](https://github.com/devagrawal09/jev-review/blob/31f89602797fb7bea007f8a480bf368bf564954e/src/domain/config.ts) limits follow-up to eight signals and profiles to five files. The README explicitly calls findings review prompts, not proof of defects. Runnable review code is not evidence of measured savings or recall.
- **Hunter Bohm:** [08:40 onward](https://www.youtube.com/watch?v=2XFXe-oGnrI&t=520s) reports roughly 50% lower time/cost across coding, email and browser experiments; Astra still writes code and Jev replaces review. The description corrects strict passes to **22/24 versus 24/24**, or observed failures **2/24 versus 0/24**. It calls this the original suite, not 24 confirmed independent coding tasks. The coding-only denominator, grading rules, repeated runs, full cost breakdown and public reproduction artifacts were not identified. His roughly $0.15 testing remark does not itemize all-model expenditure. Evidence remains a creator-reported small mixed suite.
- **Separate PR-screening demo:** [original post](https://x.com/redp314/status/2100585126652481915) reports six real PRs, 14 typed checks, about $0.00007 per PR, and half-second answers. Its 1,000-PR/$0.07 versus ~$14.50 Opus comparison is an extrapolation, not 1,000 measured reviews. No labeled defect-recall or escalation-cost result is supplied. Do not attribute this different demo's 200× claim to `jev-review`.
- **Ray Amjad:** [18:15 onward](https://www.youtube.com/watch?v=ScvXFi4MUSc&t=1095s) reports classifying 150 comments in 9.3 seconds for ~$0.01. No matched quality baseline or completed rewriting bill; this is screening cost only.

## 5. Security SaaS and vendor classification are different denominators

Sentry engineer Greg Pstrucha's [original post](https://x.com/grichadev/status/2100437998571860087) concerns a **security pipeline**, not autonomous coding. Its [attached table](https://pbs.twimg.com/media/HSY_7aXbIAAxJoj.png?name=orig) reports:

| Model | Accuracy | Latency | Cost / 1K |
|---|---:|---:|---:|
| TypeSafe/Jev | 99.3% | 0.259 s | $0.026 |
| GPT-OSS 120B | 96.4% | 1.821 s | $0.080 |
| Gemini 3.1 Flash-Lite | 99.3% | 1.338 s | $0.372 |

Against the equal-accuracy Gemini row, those numbers imply 14.3× lower classification cost and 5.17× lower latency. Against GPT-OSS, cost is only 3.08× lower. The headline "over 5x" needs a named comparator. Sample size, precise unit behind "1K", label provenance, class balance, false-positive/negative rates, latency aggregation and evaluation artifacts are absent. A 99.3% accuracy implies 0.7% aggregate error, not a 0.7% missed-attack rate. This testimonial cannot establish coding-agent economics or security equivalence.

TypeSafe's [launch post](https://typesafe.ai/blog/introducing-system-one-models-and-jev) attributes 193.6× speed and 444.6× cost headlines to four structured workflows, scored against other models' reference probabilities. It acknowledges favorable comparison conditions and an adapter that makes LLMs return probabilities. These are not completed coding tasks. [LangChain's integration post](https://www.langchain.com/blog/building-a-harness-with-jev) supplies routing/approval examples but no comparative coding benchmark.

## Scope and remaining evidence gap

Read both existing research notes, original video metadata/captions, linked posts and images, official documentation, and the repository files cited above. Ordinary `web_search` returned no results; Bing HTML fallback found Firstmate, LangChain and `jev-auto`. Searches included Jev + benchmark/cost/Firstmate/SWE-bench, TypeSafe + security/Sentry, and Hunter Bohm + Jev. Several Bing queries returned mostly irrelevant results, so search coverage is limited. X posts were read through the public FxTwitter mirror when direct X retrieval failed. A further [Jev orchestrator README](https://github.com/WXK-AI/jev-ex) advertises ~68% savings but supplies no measured task sample or matched result table; it was not treated as benchmark evidence.

What remains missing is a public, pinned, representative coding-task A/B dataset with independently checkable success, repeated runs, all model and tool costs, fallback/retry costs, and total cost per successful task. Cheap classification, agreement with an expensive model, and schema validity do not substitute for that evidence.
