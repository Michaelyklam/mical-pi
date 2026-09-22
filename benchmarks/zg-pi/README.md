# Pi retrieval benchmark

The production zvec extension was removed on 2026-09-15 after repeated search failures and excessive index disk usage. It is no longer part of the default mical-pi setup. These standalone benchmark scripts remain for historical reference; running their indexing commands will create new indexes.

This benchmark compares pi's stock read-only retrieval tools with the same tools plus zvec-grep (`zg`). It measures complete repository Q&A runs rather than isolated query latency.

## Profiles

- `baseline`: `read`, `grep`, `find`, and `ls`
- `zg`: the same tools plus the benchmark-only `zvec_grep_search` extension

Both profiles use the same model, thinking level, prompt, repository, and task order. Runs alternate profile order to reduce systematic rate-limit and warm-cache bias. Skills, context files, prompt templates, themes, global extensions, shell access, and session persistence are disabled.

The default model is `openai-codex/gpt-5.6-luna` at `max` thinking. The default embedding model is the local `local/potion-code-16m-v2`. Repository contents do not leave the machine during indexing or retrieval.

## Reproduce the published SWE-QA smoke task

Requirements: Node.js 22+, pi, zg, git, and working Luna authentication.

```bash
cd ~/Coding/mical-pi
npm run bench:zg:sweqa:setup
npm run bench:zg:sweqa:smoke
```

This clones five repositories at the exact published commits and asks the original smoke-tier questions verbatim. The treatment uses zg's official tool name, description, schema, routing guidance, and whole-repository indexing policy. The deliberate substitutions from the published run are pi instead of Claude Code, Luna max instead of Opus high, and local Potion embeddings instead of remote Qwen embeddings.

Summarize every paired SWE-QA run currently in the results directory with:

```bash
npm run bench:zg:sweqa:summary
```

The report includes the mean and median paired percentage change, win count, and pooled change. The paired mean matches zg's published aggregation method more closely than comparing only grand totals.

The tool currently invokes zg's direct CLI and returns its agent-formatted output. It does not go through the MCP transport. Indexed retrieval and result content are the same implementation, but MCP's cross-group presentation can differ when a call contains several unfused query groups. Record that difference when comparing these numbers with the paper.

## Run the local KaraokeAugment pilot

```bash
npm run bench:zg:index
npm run bench:zg -- --limit 2 --attempts 1
```

Run all six local tasks three times per profile:

```bash
npm run bench:zg -- --attempts 3
```

Raw trajectories and answers are stored in `benchmarks/zg-pi/runs/`. Git ignores them because they can contain repository excerpts.

## Metrics

The runner records every provider-reported field from final assistant messages:

- uncached input tokens
- cache-read and cache-write tokens
- logical input (`input + cacheRead + cacheWrite`)
- output and reasoning tokens
- total tokens and reported cost
- model turns, tool calls by tool name, wall time, stop reason, and errors
- final answer and the arguments to every retrieval call

The `quality proxy` is deterministic coverage of expected source paths and concepts. It is useful for catching obviously incomplete answers, not for declaring two explanations equivalent. Read the paired answers before accepting a token reduction. A lower-token zg run with worse evidence is not a win.

## Fairness notes

Index build time is reported separately in `index-meta.json` and excluded from agent wall time. The index is reusable, so this matches zg's published protocol.

The treatment system prompt necessarily contains one extra tool schema and its description. That overhead is included in treatment input tokens. This makes the token comparison conservative.

The tasks emphasize intent, control flow, and evidence spread across files. Keep exact-symbol lookup as a separate task class if you add it. Combining both kinds without reporting them separately can hide where zg helps and where stock grep is already optimal.

The current KaraokeAugment checkout may be dirty. Every run records the commit and a working-tree fingerprint. Compare runs only when those values match.
