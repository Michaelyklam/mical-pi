# Foosheq repository tasks

Source revision: `b8c6e9bd5ecd6c5620cf7bce82329bcf0e801b10`, under `apps/foosheq`.

All four tasks are independent feature requests. No baseline bugs were injected. Each baseline contains complete committed model modules and their unchanged existing tests, plus a minimal ESM package and offline Vitest configuration.

| Directory | Split | Difficulty | Baseline visible passes | Baseline hidden failures | Reference total passes |
|---|---|---|---:|---:|---:|
| `durable-history/` | calibration | moderate | 300 | 37 | 337 |
| `cancellable-capture/` | calibration | hard | 426 | 19 | 445 |
| `group-graph-gesture/` | evaluation | hard | 310 | 15 | 325 |
| `portable-capture-transcript/` | evaluation | hard | 314 | 63 | 377 |

All baseline visible commands exited 0. All baseline hidden commands exited 1 with feature-test failures. All reference combined commands exited 0. Hidden commands include the original visible tests. Source-only strict TypeScript checks passed for all references. Hidden tests also rejected 12 deliberately incomplete reference variants, three per task, tested only in scratch.

## Files and isolation

Each task directory contains:

- `task.json`: the requested metadata, prompt and exact test argv.
- `baseline/`: the only repository files to expose during coding.
- `reference/`: full replacement files for changed/new source paths only.
- `hidden/`: additional tests and mock helpers, with baseline-relative paths.
- `review.md`: context, difficulty rationale, coverage and validation results.
- `source-manifest.json`: hashes proving retained source matches the recorded commit.
- `validation.json`: run summaries, source-check commands and mutation-check results.

Keep reference, hidden, review, provenance and validation files outside model and router contexts. Merge hidden files only into an ephemeral grading workspace after coding. Do not overlay one task's reference onto another task.

The commands use `node node_modules/vitest/vitest.mjs run`, explicit files and `--configLoader runner`. Supply dependencies offline and read-only; no `npx` or package download is needed. Test caches stay under `.test-cache/`. Local validation used Node v22.23.2, Vitest 5.0.0 and TypeScript 7.0.2. The parent's Docker validation remains separate.

Authoring scripts, scratch workspaces and complete test logs are under `/tmp/jev-repo-author-foosheq/`. They are not benchmark inputs. The original repository and its uncommitted changes were not modified. No live API/model calls, additional agents, real device access, credentials, deployment or production commands were used.
