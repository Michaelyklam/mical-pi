# Jev video evidence notes

Researched 2026-09-18. Scope: three requested videos, not an independent benchmark or official API audit.

## Access and identity

Actual YouTube English captions retrieved for **all three videos** with the already-installed `yt-dlp`; no packages installed and no project code changed. These notes use complete timestamped captions plus video descriptions, not titles alone. Video imagery was not independently inspected. Auto-captions contain transcription errors (Jev becomes Jeb/Jeff; other model names are inconsistent), so reported measurements remain creator claims.

Jev is TypeSafe AI's structured-decision model, not a replacement text/code generator. Video descriptions link to the [TypeSafe launch post](https://typesafe.ai/blog/introducing-system-one-models-and-jev). Parent independently confirmed official identity and vendor pricing: **$0.042/million input tokens, free output**, equivalently $42/billion. Official documentation verification belongs to the parent research.

Local evidence directory: `/tmp/jev-video-notes/`. For each ID below:

- `<id>.en-orig.json3`: original English automatic captions.
- `<id>.en-orig.txt`: complete extracted text, with `[mm:ss]` timestamps.
- `<id>.info.json`: metadata, description, chapter data and caption URLs.
- Additional `.en.json3` captions downloaded; Ray also has `.en-en.json3`.
- `yt-dlp.log`: retrieval log. Temporary files are not durable repository artifacts.

Retrieval command used `yt-dlp --skip-download --write-info-json --write-subs --write-auto-subs --sub-langs 'en.*' --sub-format json3 --no-playlist`. No video/audio was downloaded.

## 1. Hunter Bohm: I Paired Jev With Astra. Here's What Changed.

[Video](https://www.youtube.com/watch?v=2XFXe-oGnrI), ID `2XFXe-oGnrI`, published September 18, 2026; 12:39. Transcript accessed.

| Time | Evidence and qualification |
|---|---|
| [00:48–02:24](https://www.youtube.com/watch?v=2XFXe-oGnrI&t=48s) | Explains predefined labels/probabilities. Explicitly says guaranteed output structure does **not** guarantee correct judgment: Jev can choose the wrong label. |
| [03:28](https://www.youtube.com/watch?v=2XFXe-oGnrI&t=208s) | Captions say "$4.2 per million" and then "$42 per billion", which conflict by 100×. Do not quote the first figure as verified pricing. Official figure supplied by parent is $0.042/million. |
| [06:52–08:38](https://www.youtube.com/watch?v=2XFXe-oGnrI&t=412s) | Relays Kun Chen's Firstmate dispatch experiment: Jev chooses agent tool, model and reasoning effort from task/routing policy. Claims 71% lower cost and 90% less time for **dispatch**, not the subsequent coding task. Third-party result, not Hunter's benchmark. [Linked original post](https://x.com/kunchenguid/status/2100468943853085061). |
| [08:40–10:18](https://www.youtube.com/watch?v=2XFXe-oGnrI&t=520s) | Creator reports his own coding, email-triage and computer-use tests. Claims roughly 50% lower cost and elapsed time. Astra still writes code; Jev replaces the review step. Email escalates uncertain classifications to Astra. Hard threaded emails caused difficulty. A Chrome shutdown delay affected browser timing; corrected browser result claimed ~2.5× faster and 77% lower cost. No public reproducible benchmark repository identified in description. |
| [11:19–12:05](https://www.youtube.com/watch?v=2XFXe-oGnrI&t=679s) | Says biggest savings came from **eliminating an Astra call**, not merely adding Jev alongside unchanged work. Says tests cost about $0.15, without a clear accounting breakdown. Mentions waitlist, agent skill and API key setup. |

Description correction is important: **Astra baseline 22/24 strict passes; Astra + Jev 24/24**. Description says a spoken 22/24 referred to the baseline. This clarification is description evidence; the extracted captions do not contain the number.

Other examples are relayed demos, not his measured coding workflow: Minecraft flag and crypto trading (02:59); email classification and barely coherent character-by-character text generation (04:54); computer use claimed 155× cheaper and 20× faster than Opus (06:01). Do not generalize those ratios to coding.

## 2. Ray Amjad: Jev + Claude Code = The New Agentic Coding Loop

[Video](https://www.youtube.com/watch?v=ScvXFi4MUSc), ID `ScvXFi4MUSc`, published September 18, 2026; 27:28. Transcript accessed. Retrieved page/title variants include "Jev Kills the Slowest Part of Agentic Coding"; use the stable video ID.

| Time | Evidence and qualification |
|---|---|
| [05:54–06:22](https://www.youtube.com/watch?v=ScvXFi4MUSc&t=354s) | Playground example evaluates a coding-task diff against multiple bounded questions: addresses task, weakened tests, verification strength and risk. This is structured screening, not generated review explanations. |
| [12:32–13:53](https://www.youtube.com/watch?v=ScvXFi4MUSc&t=752s) | Skill routing: relays official cookbook example selecting among 182 Hermes skills; wrong-skill rate claimed 17% → 7.3% with Haiku 4.5. Proposes removing ~10,000 skill-description tokens from his context, but does **not** demonstrate that saving in his agent. [Referenced cookbook](https://docs.typesafe.ai/cookbooks/skill_suggestion). |
| [14:53–17:56](https://www.youtube.com/watch?v=ScvXFi4MUSc&t=893s) | Relays browser flight-search demo (~7 seconds; fractional-cent cost, exact caption wording unclear) and parallel adversarial browser testing. Proposes Jev checking UI flows and Claude fixing failures. Explicitly says he will try parallel testing later. "$5 or $10" per day for thousands of sessions is speculation, not a measured bill. Notes browser/sandbox compute can become dominant. |
| [18:15–19:34](https://www.youtube.com/watch?v=ScvXFi4MUSc&t=1095s) | Strongest concrete cost example: pastes TypeSafe skill into an existing project, asks agent to agree on comment-quality criteria, sample first, shortlist bad comments, then delegate rewriting to Haiku. Reports **150 comments in 9.3 seconds for ~$0.01**. Agent projects **$0.57** for classifying all comments, with ~1,700 needing improvement. Full pass and Haiku rewrite costs are not measured here. |
| [19:44–20:27](https://www.youtube.com/watch?v=ScvXFi4MUSc&t=1184s) | Proposed qualitative checks: function name captures side effects; logged values classified as secrets, financial data or personal data. These are examples, not demonstrated accuracy benchmarks. |
| [20:27–22:43](https://www.youtube.com/watch?v=ScvXFi4MUSc&t=1227s) | Requests code-smell strategy on his codebase. Agent separates static-analysis checks from Jev questions. Estimates exhaustive Jev pass at **28 million input tokens / $1.19**. This is a quoted estimate, not a completed scan. Recommends sampling results and revising criteria. Admits some smells are unsuitable for Jev. |
| [22:44–23:39](https://www.youtube.com/watch?v=ScvXFi4MUSc&t=1364s) | Jev review filters findings before sending them to a coding agent. His Slack agent estimates 10× less reading; he says he will experiment further. **Not a demonstrated 10× end-to-end cost reduction.** [Review repo linked in description](https://github.com/devagrawal09/jev-review). |
| [23:45–25:29](https://www.youtube.com/watch?v=ScvXFi4MUSc&t=1425s) | Explicitly introduces a new idea: 50–500 project-specific questions per PR, broad screening followed by specialist review. Conceptual design, not a deployed result. |
| [25:30–26:04](https://www.youtube.com/watch?v=ScvXFi4MUSc&t=1530s) | Relays Sentry security-pipeline claim of >5× cheaper with better speed/accuracy than existing smaller models. No experimental details established by captions. |

Own noncoding demo: Jev handles Minecraft actions while Astra plans and reviews about every two minutes or after setbacks (09:24–12:30). Reports obtaining a diamond pickaxe by 23:41. Useful illustration of splitting frequent bounded decisions from occasional reasoning, not evidence of coding savings.

Description links the [Claude/Codex integration skill](https://github.com/typesafe-ai/skills/blob/main/skills/typesafe-ai/SKILL.md). No drop-in replacement for Claude Code's built-in review is demonstrated. The video promotes the creator's course and sandbox service.

## 3. Mehul Mohan: This NEW AI Unlocks Crazy Things (Jev Use Cases)

[Video](https://www.youtube.com/watch?v=TUGOZ3m78fU), ID `TUGOZ3m78fU`, published September 17, 2026; metadata duration 12:43. Transcript accessed despite web fetch initially returning only a player/title. This is largely a tour of other people's examples, not his own cost benchmark.

| Time | Evidence and qualification |
|---|---|
| [01:02–02:21](https://www.youtube.com/watch?v=TUGOZ3m78fU&t=62s) | Relays "instant compaction": classify which messages/tool calls to keep or discard instead of generating an LLM summary. Explicitly warns that Jev's own context limit requires chunking. No measured recall, cost or downstream task-quality comparison. This is selective retention, not semantic summarization. [Original post from description](https://x.com/tamarajtran/status/2100694549362553153). |
| [02:23–04:20](https://www.youtube.com/watch?v=TUGOZ3m78fU&t=143s) | Relays PR review claim "200 times cheaper" and half-second responses, then rejects treating it as full review. Scoped checks can catch an obvious hardcoded secret, but no flags does **not** imply shippable code. Cross-file dependencies require deeper review. [Original post](https://x.com/redp314/status/2100585126652481915). |
| [06:27–07:14](https://www.youtube.com/watch?v=TUGOZ3m78fU&t=387s) | Proposes command/tool-approval classification in a custom agent, analogous to Claude Code auto mode. Does not establish equivalent safety or demonstrate integration. No permission should be inferred from a probability alone. |
| [07:17–09:45](https://www.youtube.com/watch?v=TUGOZ3m78fU&t=437s) | Explains a Mario demo: deterministic adapter extracts JSON game state, Jev chooses predefined controls, code executes. Specifically says it is **not interpreting screenshots**. Quotes ~50–150 ms and 8–10 decisions/second as indicative, not measured by him. [Original post](https://x.com/faadilhshaik/status/2100086301894881578). |
| [09:47–10:35](https://www.youtube.com/watch?v=TUGOZ3m78fU&t=587s) | Natural-language if/else demo; suggests routing errors to an LLM or human. Warns against putting this in an application's hot path. [Original post](https://x.com/_pi0_/status/2100678127580287044). |

Trading (10:38) is explicitly called risky; driving (11:01) is a game simulation, not real autonomous-driving evidence. The **04:22–06:25 Greptile segment is paid promotion for another product**, not a Jev benchmark.

## Practical conclusion from these videos

Most defensible starting point: inexpensive screening of comments or narrowly scoped diff checks, followed by selective escalation to a coding model. Ray provides an actual small-sample comment-classification measurement. Hunter reports broader savings, but without reproducible artifacts or detailed accounting here.

Measure saved expensive-model calls/input tokens against Jev requests, fallback calls, retries, implementation work and browser compute. Preserve deterministic tests and deeper review; evaluate false negatives before reducing them. Skill routing and selective context retention are promising token-reduction proposals, not demonstrated end-to-end savings in these three videos. None proves Jev can replace a general coding agent.
