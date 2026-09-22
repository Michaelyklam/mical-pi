# Jev for coding-agent cost reduction

Research date: 2026-09-18. Desk research, not a benchmark on our repositories. Video captions are automatic and can mistranscribe names and numbers. Three additional video notes are in `2026-09-18-jev-video-notes.md`.

## Bottom line

Jev is a cheap structured-decision service, not a replacement coding agent. It can choose among supplied options, score against a rubric, and return yes/no probabilities. It cannot generate patches, summaries, explanations, arbitrary shell commands, or free-form tool arguments. Savings require replacing existing work or reducing expensive downstream work, not simply adding another call.

## Primary-source facts

- Current documented model: `jev-1.13.0`. $0.042 per million input tokens; output free. Text input only. 64k total request limit, with state plus longest question limited to 32k. Rate limits currently 250,000 tokens/sec and 1,200 requests/minute, explicitly subject to change. [Models](https://docs.typesafe.ai/models.md)
- Questions are evaluated independently against shared state; independent checks can be batched. Each question should be narrow. [Introduction](https://docs.typesafe.ai/introduction)
- Choice/Score confidence is derived from the shape of the probability distribution, not a separately guaranteed probability of correctness. Noul has no confidence field. Thresholds need testing on the target domain. [Confidence](https://docs.typesafe.ai/confidence.md)
- Known failures include literal interpretation, arithmetic, dates, indirection, irrelevant long context, and adversarial input. Schema guarantees are not correctness guarantees. [Known limitations](https://docs.typesafe.ai/model-jaggedness/jev-1.13.md)
- Vendor headline speed/cost comparisons concern four structured business workflows, not end-to-end coding. Reference labels are consensus outputs of other strong models, not independent human ground truth. The vendor explicitly says the headline gains are toward the high end of expected real-world gains. [Launch post](https://typesafe.ai/blog/introducing-system-one-models-and-jev), [eval methodology](https://evals.typesafe.ai/)
- Installing the TypeSafe skill teaches the coding agent the API; it does not automatically replace the agent's reasoning with Jev. [Agent skill](https://docs.typesafe.ai/agent-skill.md)

## Two videos reviewed directly

### Sam Witteveen: Jev - The Ultimate Classification Model?

[Video](https://www.youtube.com/watch?v=X117w2Rark8). Full English automatic captions retrieved using yt-dlp and read; local transcript `/tmp/jev-research/X117w2Rark8.en-orig.txt`.

- 05:31: language classification, including romanized Thai, presented in a demo app.
- 06:29: sentiment scoring; repeated calls vary, especially on ambiguous inputs.
- 09:18: customer-support routing with ambiguous inputs and independent refund/urgency checks.
- 10:51: suggests safety/code-review classifications; no quantified coding accuracy benchmark supplied in the transcript.
- 11:16: tool selection explicitly distinguished from extracting/generating tool arguments. This is a critical constraint for coding integration.
- 11:50: chains 20 classification tasks; useful demonstration of cheap composition, not an end-to-end coding test.
- 14:09: explains that “cannot hallucinate” means no invented output/schema violations, not no wrong answers.
- Some architecture discussion is explicitly speculation, not published technical evidence.

### Rob Shocks: JEV Breakdown: The First AI Model Built For Code

[Video](https://www.youtube.com/watch?v=2Bs0Ink_-Uo). Full English automatic captions retrieved and read; local transcript `/tmp/jev-research/2Bs0Ink_-Uo.en-orig.txt`.

- 01:28–01:50: proposes guardrails, security review, model routing and ticket triage. These are suggested applications, not validated coding-agent savings.
- 02:23: reports a Vercel classification testimonial. Not independently verified here.
- 05:00: Doom consumes structured game state, not video. Not a coding-agent evaluation.
- 06:16: Wikipedia traversal demo; 06:39–07:24: smart-home commands mapped onto predefined device actions, with a displayed 185ms response cited by the presenter.
- 08:06–09:36: playground choices, ticket priority, team routing and tool selection.
- Title's “built for code” means decisions consumed by software, not writing source code.

## Other three videos: evidence summary

All three full automatic transcripts were retrieved and reviewed by the research subagent. Details and caveats are in `2026-09-18-jev-video-notes.md`.

- [Hunter Bohm, 08:40](https://www.youtube.com/watch?v=2XFXe-oGnrI&t=520s): reports roughly 50% cost/time reductions in small coding, email and computer-use tests. Astra still generates code, with Jev screening review decisions. Description corrects strict passes to baseline 22/24 versus combined 24/24. No reproducible benchmark repository identified. His strongest practical point at 11:19 is that savings come from eliminating an expensive call, not adding Jev alongside unchanged work.
- [Ray Amjad, 18:15](https://www.youtube.com/watch?v=ScvXFi4MUSc&t=1095s): reports screening 150 comments in 9.3 seconds for about $0.01, with a coding model intended to rewrite selected comments. $0.57 for a full comment pass and $1.19 for a code-smell scan are estimates, not completed measured workflows. This is the clearest small-scale coding-related example in the supplied videos.
- [Mehul Mohan, 01:02](https://www.youtube.com/watch?v=TUGOZ3m78fU&t=62s): relays context filtering as “instant compaction.” It selects existing content; it does not summarize. No retention-quality benchmark. At 02:23 he explicitly warns that cheap narrow PR checks cannot replace full review.

Bulk semantic code screening is therefore another sensible pilot: classify existing comments or functions against one precise rubric, inspect a sample, and send only flagged items to a generative model. Use static analysis for machine-checkable conditions. The Jev cost alone excludes rewriting, review and false-positive work.

Selective context retention is higher risk. Dropping a constraint or decision can silently harm later coding. Jev also cannot ingest an arbitrary whole agent history due to its 32k state-plus-question bound. This is not a replacement for our summary-based subagent compaction.

## Practical candidates for our agent setup

These are recommendations inferred from the API and evidence, not measured savings for our setup.

1. **Search-result relevance scoring.** Retrieve candidates using rg/BM25/embeddings, then score short passages and return selected original passages. Preserve provenance and allow fallback searches. Start by reordering, not deleting potentially relevant evidence. This can lower expensive-model input and useless reads, but missing the crucial file is costly.
2. **Skill/tool suggestion.** Classify a request against the existing catalog; retain “none” and uncertainty paths. Select a tool or skill, not arbitrary arguments. Keep mandatory instructions available. Preserve stable cached prompt prefixes rather than rewriting the catalog every turn.
3. **Issue and failure triage.** Classify ownership, task category, or failure type when ordinary parsers cannot. Exit codes, compiler errors and test outcomes belong in deterministic code. Do not pay a model to compute known facts.
4. **Model routing.** A task-category/risk/difficulty signal can suggest a cheaper model, with fallback to the current model. Requires labeled outcomes from our tasks: apparent simplicity is not evidence that a weaker coding model will succeed.
5. **Narrow semantic checks after a cheap model.** Possible for document extraction or specific source-grounded checks. Do not replace tests, security review or whole-patch review with “is this correct?” classification.

## Closest official evidence

[Skill suggestion cookbook](https://docs.typesafe.ai/cookbooks/skill_suggestion.md): two-stage ranking over 182 Hermes skills, then detailed examination of the top three. On 488 synthetic requests with Haiku, wrong skill loads decreased from 16.8% to 7.3%, needless loads from 9.8% to 4.0%. Vendor experiment using Jev 1.12, not our Pi setup or current model. The full roster stays in the main prompt, so this does not demonstrate direct prompt-token reduction. It fixes 37 covered cases but breaks 7 previously correct cases. A displayed failure suggests the X skill for Mastodon.

[Extraction cascade cookbook](https://docs.typesafe.ai/cookbooks/sde_cascade.md): cheap generative model extracts, Jev verifies narrow per-field questions, expensive model handles flagged cases. Internal results on 100 extraction prompts, not coding. The walkthrough hard-codes one illustrative bad extraction and the cost chart is historical. Useful architecture; insufficient evidence to claim the same gains on patches.

## Cost accounting

At published input pricing:

- 10,000 input tokens cost $0.00042 per call.
- 1,000 such calls cost $0.42, before other services or provider charges.

For a cheap-model-first cascade:

`expected cost = cheap generation + Jev verification + escalation_rate * expensive retry + other overhead`

Include cached-token rates, repeated context, latency, retries, human review, and mistakes. If only 10% of baseline spend is eligible and that portion becomes 100x cheaper, overall theoretical savings are 9.9%, not 100x. Subscription quota reduction may not reduce the monthly cash bill. Do not assume passing unfiltered private code to another provider is acceptable; review retention and policy first.

## Recommended experiment

Use 100–200 representative saved tasks or search decisions, including ambiguous/failure cases. Compare existing behavior, deterministic baseline, cheap general-purpose classifier and Jev. Run Jev in shadow mode first. Measure relevant-file recall, wrong routing/skill rates, unnecessary escalations, task success, total cost per successful task, p50/p95 latency, and cache effects. Pin the model version. Tune thresholds on a separate set and keep a fallback on errors/uncertainty. Avoid security authorization and automatic destructive actions as first applications.
