# Astra Flash Orchestrator assessment

Reviewed upstream commit `bcc7f9eaee051126c0ce821a55194d0b20425b22`. Source inspected without running the installer or repository code. No harness defaults changed.

## Recommendation

Borrow its delegation policy rather than installing its Codex-specific integration. Keep the expensive coordinator's context small, delegate coherent work with explicit acceptance criteria, and review actual patches. Start with narrow worker tasks rather than automatically assigning complex implementation to a cheaper model.

## What the repository provides

The [installer](https://github.com/ethanplusai/astra-flash-orchestrator/blob/bcc7f9eaee051126c0ce821a55194d0b20425b22/install.py) installs a skill and a pinned worker role. Supporting scripts validate local routing configuration and plans. It relies on a separately installed Codex Router. It does not implement an inference engine, automatic scheduler, usage accounting, budget enforcement or a pi adapter.

The [skill](https://github.com/ethanplusai/astra-flash-orchestrator/blob/bcc7f9eaee051126c0ce821a55194d0b20425b22/skill/astra-flash-orchestrator/SKILL.md) assigns Astra planning and acceptance, with DeepSeek Flash handling discovery and implementation/test/fix loops. Its useful practices are minimal worker briefs, consolidated fixes, concise completion reports, file-backed logs and avoiding duplicate investigation or progress polling. Most are instructions rather than enforced restrictions.

## Savings caveat

The [benchmark](https://github.com/ethanplusai/astra-flash-orchestrator/blob/bcc7f9eaee051126c0ce821a55194d0b20425b22/docs/BENCHMARK.md) reports 98.9% lower Astra input per code line across different task mixes. Combined input rose from roughly 294.5M to 1,006.1M tokens, about 3.4 times. This demonstrates workload shifting, not total-token reduction. Estimated API-equivalent costs are not measured subscription quota savings. Some worker work remained unaccepted, and code lines are not a quality measure.

Worker authentication and charges depend on the separate provider setup. DeepSeek work should not be assumed to be included in an existing ChatGPT subscription. Sending private source to another provider requires explicit approval.

## Fit with mical-pi

- `extensions/subagents/src/backends/pi.ts` already supports selecting a model and reasoning level. Both inherit from the parent when omitted. Children load normal resources, so small tasks may still carry unnecessary prompt/tool overhead.
- `skills/subagents/SKILL.md` requires explicit user authorization for switching providers. A cross-provider cheap-worker policy needs that authorization; it should not silently replace current behavior.
- `extensions/usage-footer` already separates parent/child estimates and displays supported account allowances. Evaluate real quota depletion separately from estimated dollar cost.
- The [synthetic pilot](2026-09-19-jev-pilot-results.md) found Luna adequate on every baseline task, at much lower API-equivalent cost. The [harder repository pilot](2026-09-19-jev-repository-routing-results.md) found Astra passed 5/6 tasks and Luna 1/6. Visible checks accepted some incorrect completed patches. Neither pilot tested DeepSeek, so neither establishes its capability.

## Smallest useful next step

Propose an opt-in worker profile for bounded discovery, log analysis, test scaffolding and mechanical edits. Keep architecture and complex cross-module work on the stronger model. Give workers a small brief, relevant files and explicit checks; request a short report with patch locations and unresolved risks. Count retries and parent review, and compare accepted-task quality plus actual allowance changes before adopting a default. Do not add a learned router or new orchestration system without evidence that simpler rules are insufficient.
