# Coding-agent cost reduction: evidence, not proposals

Researched 2026-09-18. No live agent benchmark or implementation performed. Companion Jev audit: `2026-09-18-jev-evidence-audit.md`.

## Evidence standard

A convincing coding-cost result needs real coding tasks, a comparable baseline, total inference cost, task success measured with tests or equivalent verification, and enough code/data to inspect or reproduce it. A classifier's price, fewer prompt tokens, or a cheaper dispatch decision alone does not establish cheaper successful coding. Publicly inspectable research is stronger than anecdotes, but is not a guarantee of improvements in a different agent.

## Jev audit conclusion

Within checked sources, no strong independently reproduced evidence establishes lower all-in cost per successful coding task from Jev. The newly located `33Audits/jev-auto` report provides a closer test, but only one six-turn React app per arm. Fixed balanced generation cost is estimated $1.8749 (119s), Jev-routed $1.7257 (123s), and fixed cheapest $0.4279 (104s). All report 7/7 source-pattern checks. The 7.96% routing saving is not the 77.18% saving from simply using the cheapest model. Jev's API cost is omitted; checks do not establish behavioral equivalence. Codex cost savings use placeholder prices and are not measured billing savings. Parent also read the benchmark README directly.

Source: https://github.com/33Audits/jev-auto/tree/792b5b803d55f1eb8f30b30c215d0fcb5b3f3aa7/bench

Firstmate's 71% claim is dispatch-only. Public verification has 25 briefs with private inputs, 20/25 then 18/25 profile agreement with hand labels, including intentional escalations and some disagreements. No complete downstream coding-cost measurement. Runnable review integrations lack published recall/cost benchmarks. See companion audit for pinned sources and detailed caveats.

## Strong direct evidence: discard old tool observations without another model

Primary sources:
- Paper v3 (27 October 2025), https://arxiv.org/html/2508.21433v3
- Code/configuration/analysis notebooks: https://github.com/JetBrains-Research/the-complexity-trap
- Released trajectories: https://huggingface.co/datasets/JetBrains-Research/the-complexity-trap

JetBrains Research evaluated SWE-agent on 500 SWE-bench Verified issues across five model configurations. Observation masking keeps recent tool observations (10 turns in its SWE-agent configuration) and replaces older outputs with placeholders, preserving the agent's reasoning/actions. No classifier is needed.

Selected Table 1 results, mean cost per attempted instance:

| Model | Baseline cost | Masking cost | Baseline solve rate | Masking solve rate |
| --- | ---: | ---: | ---: | ---: |
| Qwen3-Coder 480B | $1.29 | $0.61 | 53.4% | 54.8% |
| Gemini 2.5 Flash, no thinking | $0.41 | $0.18 | 32.8% | 35.6% |
| Gemini 2.5 Flash, thinking | $0.56 | $0.24 | 40.4% | 36.4% |

The first two are meaningful measured cost reductions with comparable or higher observed solve rates. Small increases should not be represented as statistically established quality improvements. The third has a statistically significant quality drop, a counterexample to blanket “no quality loss” claims.

Critical qualifications:
- Baseline is an unmanaged raw history, not an optimized current coding agent. For Qwen3-Coder, masking versus existing LLM summarization is $0.61 versus $0.64, about 4.7% cheaper, not 53%.
- Gemini costs are returned by Vertex AI. Qwen models were self-hosted and dollar costs calculated post hoc at Alibaba API token prices; not measured GPU-hosting costs. Qwen3-32B pricing did not distinguish cache hits and misses.
- A 50-issue OpenHands probe required changing retention from 10 to 58 turns. Blindly copying the SWE-agent window degraded performance.
- Models/agents are older than the user's current configuration. This establishes a mechanism and a reproducible benchmark result, not guaranteed present-day savings.
- The v3 paper's general prose says no significant degradation, but its own table explicitly marks the thinking-Gemini solve-rate reduction significant. Report the table, not the headline.
- Hybrid masking plus summaries saved a further reported 7% versus masking and 11% versus summaries in a 50-issue experiment. Smaller evidence base than the main comparison.

Conclusion: stronger evidence for ordinary context-management code than for adding Jev to choose what to forget. Do not conclude all summarization should be disabled.

## Measured adjacent evidence: tool discovery without Jev

Primary source: Anthropic, 24 November 2025, https://www.anthropic.com/engineering/advanced-tool-use

Provider reports an 85% reduction in tool-loading/context token usage and improved accuracy on internal MCP evaluations:
- Opus 4: 49% → 74%.
- Opus 4.5: 79.5% → 88.1%.

Mechanism: defer most tool schemas; keep a few core tools; main model searches via regex/BM25/custom search and relevant schemas load only when needed. No separate classifier required. The provider says its native deferred loading preserves caching of the stable system/core-tool prefix.

This closely matches the user's discovery/escape-hatch proposal. Prior discussion was too speculative about this mechanism: there is already an implemented version with provider measurements. However, these are internal MCP results, not an independently reproduced full coding-task billing benchmark. Do not call 85% fewer tool/context tokens an 85% cheaper coding agent. Search adds a turn; compact or frequently used catalogs benefit less. Native Anthropic caching behavior is not automatically true for custom tool-list mutation in another provider/runtime.

## Other impressive numbers that do not meet the coding evidence bar

- Anthropic programmatic tool calling: 43,588 → 27,297 tokens (37% lower) on complex research tasks; not coding. Same advanced-tool-use source.
- Anthropic context editing: 84% fewer tokens in a 100-turn web-search evaluation, not coding. https://www.anthropic.com/news/context-management
- Jev skill selection: improvements in synthetic skill-loading accuracy, not demonstrated end-to-end coding cost. https://docs.typesafe.ai/cookbooks/skill_suggestion.md
- Jev extraction cascade: document data extraction, not software patches. https://docs.typesafe.ai/cookbooks/sde_cascade.md

## Practical conclusion

Do not invest in a Jev integration solely because a routing/classification call is cheap. First identify whether actual billed spend is dominated by uncached tool schemas, accumulated observations, reasoning/output, retries, or duplicate work. Tool discovery and observation masking address specific measured sources of waste; neither needs Jev. If those costs are already controlled, the published gains may largely be unavailable.

Search limitations: the web_search tool returned no results even for broad queries. Used fetched Bing result pages and direct primary-source retrieval; some search pages returned irrelevant results. This is a targeted evidence review, not an exhaustive proof that no other result exists. Jev-specific repository and original-post investigation is recorded separately.
