# DeepSeek Harness vs pi coding agent

**As inspected 2026-08-20:** DeepSeek Harness commit `141eb6f` / `0.1.0-rc.8`; pi commit `5cd93f6` / release `0.84.2`.

## Bottom line

For an expert's **primary, keyboard-first daily coding environment**, pi is the clear choice. It ships the actual terminal TUI, continuing sessions, steering/follow-ups, tree navigation, model switching, Codex subscription login, print/JSON/RPC modes, and a low-friction extension surface. DeepSeek Harness currently ships a local browser UI as its only maintained interactive client; its terminal package was deliberately deleted. The non-Web choices are a one-shot headless profile and integration surfaces, not a continuing terminal UI.[1][3][7]

DeepSeek Harness is more interesting as an **orchestration/runtime substrate**. Its Cordis architecture makes the loop, providers, tools, session log, policy, sandbox, subagents, and UI seams replaceable plugins with scoped, reversible registrations. It also ships substantially more formal machinery for safe delegation and auditable state. That is valuable for building a controlled multi-agent platform, but it is not presently the better product to inhabit all day.[2][5][6]

**Recommendation for Michael:** adopt pi as the daily driver; trial DeepSeek Harness only as a bounded automation/orchestration backend, and otherwise watch it until a maintained terminal/native host and a compatibility-stable release exist.

## Direct comparison

| Dimension | pi coding agent | DeepSeek Harness | Practical verdict |
|---|---|---|---|
| Daily interface | First-party terminal TUI plus print/JSON, RPC, and SDK. The TUI includes live tool rendering, steering/follow-up queues, session resume/fork/tree, model selection, context/cost display, and extension UI.[7] | First-party local Web UI. The old TUI was removed as an unsupported product-sized frontend. Headless is one task/one fresh session; ACP/JSON-RPC/SDK are integration surfaces.[1][3] | **pi decisively wins** for terminal-native daily work. A localhost Web app is still a browser UI. |
| Built-in autonomous workflow | Deliberately omits subagents, plan mode, built-in todos, permission popups, and background bash; users compose these with extensions or tmux.[7] | Built-in plan/delegation behavior in the Web product, plus provider-neutral subagent machinery for in-process spawn/fork, ACP, Codex, Claude Code, and DSH SDK. Continuable child sessions have durable identity, authorization, cancellation, follow-up, reporting, and cold resume.[6][14] | **DSH wins** for safely structured parallel orchestration; pi wins if the expert prefers explicit tmux/process composition and minimal policy. |
| Extension ergonomics | A TypeScript file can register tools, commands, shortcuts, event interceptors, custom compaction, and full TUI components; auto-discovered extensions hot-reload with `/reload`. Packages bundle extensions, skills, prompts, and themes from npm/git.[7][8] | “Everything is a plugin”: typed services/events, dependency injection, profiles/bundles/patch layers, per-agent scope, and reversible effects. Capability seams separate definitions, providers, and consumers.[2] | **pi wins for fast personal customization**; **DSH wins for disciplined platform architecture** and replacing whole backends. |
| Extension lifecycle / isolation | Broad API and direct access are easy, but extensions run arbitrary code with the user's permissions and long-lived resources require explicit shutdown handling.[8][10] | Cordis registrations unwind automatically on unload; service dependencies and configuration schemas are explicit. Sandboxing and policy are independent replaceable seams.[2][5] | **DSH has the stronger lifecycle model**. Neither makes unreviewed third-party plugin code safe merely by calling it a plugin. |
| Model portability today | Large built-in provider catalog, API keys and multiple OAuth/subscription logins, including ChatGPT Plus/Pro Codex; `/model` and shortcuts switch models during a session. Custom compatible providers use `models.json`; extensions can implement new transports/OAuth.[7][9] | Generic provider support is itself backed by pi's `pi-ai`, with configurable custom routes and a clean provider-neutral LLM seam. However, the adapter's own limitations say it runs no OAuth login flow for OAuth-only providers; Codex tokens supplied manually expire without refresh. Existing sessions retain their logged model rather than simply following a newly selected default.[4][13] | **pi wins operational portability**, especially Codex/OAuth and live switching. **DSH wins architectural replaceability** if one is willing to build/maintain adapters. |
| Context engineering | Minimal system prompt; hierarchical `AGENTS.md`/`CLAUDE.md`; replace/append `SYSTEM.md`; on-demand skills; prompt templates; per-turn context interception; configurable/custom compaction. Tree history and branch summaries make experimentation and rollback unusually usable.[7][8][11] | Ordered/scoped system-prompt sections, dynamic prompt context, tool-schema assembly, skills-provider registries, and `agent/pre-step`/request waterfalls. The append-only session event log is the authority: model-visible inputs must be reconstructable, while compaction is recorded as durable replacement events.[2] | **pi wins legibility and hands-on control**. **DSH wins provenance, replay, scope, and formal auditability**—better foundations for evidence gates and signed lanes. |
| Safety defaults | Project trust gates project-local dynamic config, but it is explicitly not a sandbox. Built-in tools and extensions run as the user; unattended/untrusted work should run in a container, VM, micro-VM, or external policy sandbox.[10] | Built-in approval policy and filesystem-effect sandbox modes (`read-only`, `workspace-write`, `danger-full-access`) with fail-closed provider behavior and reported full/partial enforcement. Network and process visibility are explicitly outside this sandbox vocabulary.[5] | **DSH wins built-in bounded execution**, with the important caveat that its sandbox is not a complete network/process security boundary. |
| Session model | Tree-structured JSONL; in-place branch navigation, fork/clone, HTML/JSON export, and lossy compaction while full history remains available.[7][11] | Append-only durable event log; projection drives model context, UI replay, telemetry, persistence, forks, and subagent lineage.[2][6] | **pi is better for an individual exploring and backtracking**; **DSH is better for machine-auditable orchestration state**. |
| Maintenance risk | Mature 0.x product surface at `0.84.2`, one coherent TUI/agent stack, pinned direct dependencies and shrinkwrapped CLI. Still fast-moving, and a heavily customized extension estate remains yours to maintain.[7][12] | Explicit developer preview with compatibility-breaking changes promised. `rc.8` uses a large plugin graph, vendored Cordis, generated contracts, many capability packages, bilingual docs, and a Web frontend; this buys rigor but expands upgrade and contributor surface.[1][2] | **pi has lower adoption and wrapper cost today**. DSH's strong internal gates reduce some defect risk but do not cancel prerelease API churn or architectural complexity. |

## Meaningful qualitative advantages

### Where DeepSeek Harness is genuinely better

- **Formal composability rather than one broad hook API.** A filesystem, subprocess world, sandbox, LLM adapter, compactor, or subagent transport can be replaced behind a typed seam without forking the loop. Scoped registrations allow different agents to receive different capabilities.[2]
- **Auditable model context.** “Model-visible means logged” is a strong invariant for replay, forensic review, evidence gates, and signed execution lanes. Pi exposes excellent context hooks, but DSH makes reconstructability an architectural contract rather than an extension convention.[2]
- **Built-in safe orchestration primitives.** Durable continuable children, explicit authority checks, tool/persona filters, depth limits, structured output, provider capability negotiation, and Codex/Claude Code delegation are materially beyond pi's “build it or use tmux” baseline.[6][7]
- **First-class bounded execution.** DSH separates approval from sandbox mode and fails closed if confinement was requested but unavailable.[5]

### Where those advantages become disadvantages

- **The architecture has a high concept and maintenance tax.** Cordis contexts, plugin trees, bundles, patches, scopes, effects, session-event maps, waterfalls, service definitions/providers/consumers, generated catalogs, and persistence projections are appropriate for a platform team; they are excessive friction for a developer who wants to add one command or status widget.[2]
- **The product/interface mismatch is severe.** DSH has the deeper runtime but no maintained terminal frontend. Building a custom TUI against a compatibility-breaking RC recreates exactly the product-sized maintenance burden upstream chose to delete.[1][3]
- **Its apparent model breadth partly comes from pi itself.** The generic DSH adapter is backed by `@earendil-works/pi-ai`; DSH adds routing, replay, credentials, and seam discipline, but does not independently erase upstream provider constraints. Its current OAuth gap makes practical Codex portability worse than pi's native `/login` path.[4][9]

### Where pi is genuinely better

- **It is already the expert-facing product.** Its interaction model is optimized around a real terminal session: steer the working model, queue a follow-up, inspect/collapse tools and thinking, switch models, jump the session tree, and keep working.[7]
- **Customization has a short feedback loop.** Edit a TypeScript extension, `/reload`, and use full TUI primitives. The same mechanism can intercept context/provider payloads, implement permission prompts, or supply custom compaction.[8]
- **Context controls are understandable files.** `AGENTS.md`, `SYSTEM.md`, skills, prompt templates, tree history, and compaction can be inspected and versioned without learning a deployment graph.[7][11]
- **Codex/OAuth is a shipped workflow, not an adapter project.** Pi supports subscription login and automatic token refresh; this directly matches a Codex-heavy daily workflow.[9]

### Where pi is weaker

- **Safety is opt-in composition.** Project trust protects loading but not tool execution. Permission gates, path protection, and sandbox routing are examples/extensions, while robust isolation is delegated to the OS/container/VM.[8][10]
- **Parallel-agent discipline is not a core contract.** There is no built-in subagent lifecycle, authority model, task board, plan mode, or background bash. tmux is transparent and robust, but evidence gates, signed lanes, bounded delegation, and aggregation must be designed by the user or a package.[7]
- **Easy extensions can become a personal fork in disguise.** Full TUI and lifecycle access are powerful, but a large set of private extensions is still an integration surface to retest on every rapid 0.x upgrade.[8][12]

## Hype-resistant decision

- **Adopt pi** for primary interactive coding. Its compromises are explicit and align with a terminal-native expert who is comfortable using tmux, worktrees, containers, and external orchestration.[7][10]
- **Trial DSH** only for a specific backend problem that needs its strengths: durable multi-agent delegation, provider-neutral sandbox/remote execution, formal replay, or policy/audit controls. Evaluate it headlessly or through its SDK rather than pretending its local Web UI is a terminal-native equivalent.[1][2][6]
- **Do not build a DSH TUI yet** unless owning a frontend through breaking RC changes is itself the objective.[1][3]
- **Best near-term hybrid:** pi as the human control surface; separate sandboxed pi/Codex processes or a bounded DSH service as delegated workers. Keep branch/worktree ownership, evidence gates, and credentials enforced outside model prose.[5][6][7]

## Sources

[1] https://github.com/deepseek-ai/deepseek-harness/blob/master/README.md
[2] https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/architecture.md
[3] https://github.com/deepseek-ai/deepseek-harness/blob/master/.agents/notes/implemented/simplification/2026-08-04-remove-tui-package.md
[4] https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/llm/llm-pi-ai/README.md
[5] https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/subsystems/sandbox.md
[6] https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/subsystems/subagent.md
[7] https://github.com/earendil-works/pi/blob/main/packages/coding-agent/README.md
[8] https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/extensions.md
[9] https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/providers.md
[10] https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/security.md
[11] https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/compaction.md
[12] https://github.com/earendil-works/pi/releases/tag/v0.84.2
[13] https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/user/guide/providers.md
[14] https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/user/guide/index.md
