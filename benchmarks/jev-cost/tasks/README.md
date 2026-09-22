# Offline coding pilot fixtures

Eight synthetic JavaScript repair tasks for Astra/Luna/Jev cost experiments.
These are small, authored pilot tasks, not SWE-bench tasks or evidence of
performance on real repositories. They measure behavior on these cases only.
There are no research tasks, model calls, network requirements, or dependencies.

## Parent runner contract

`tasks/index.mjs` exports the same array as named `tasks` and as the default
export. Each task module also default-exports its individual task. Each task has:

| Field | Meaning |
| --- | --- |
| `id` | Stable unique string |
| `category` | Descriptive category string |
| `difficulty` | `easy` or `medium`; author estimate, not calibrated |
| `prompt` | Model-visible specification |
| `files` | Complete initial workspace map, relative `.mjs` path to broken source string |
| `entry` | Relative candidate module path to import |
| `exportName` | Named function export to invoke |
| `cases` | Parent-only array of `{args, expected}`; call `fn(...args)` |
| `referenceFiles` | Parent-only complete replacement workspace map for a passing implementation |

All functions are synchronous and accept/return JSON-compatible values. Inputs
must not be mutated. Compare results using `node:assert/strict`'s
`deepStrictEqual`, not source-text matching. Object property order is irrelevant;
array order matters. Exceptions, promises, missing exports, invalid JSON results,
and timeouts are failures. No production grading function is exported. The
parent runner implements grading and decides case-level versus task-level scoring.
A task-level pass should require every case to pass.

Build model-visible state by allowlisting fields, for example:

```js
import { tasks } from './tasks/index.mjs';
const task = tasks[0];
const visible = {
  id: task.id,
  prompt: task.prompt,
  files: structuredClone(task.files),
  entry: task.entry,
  exportName: task.exportName,
};
// Send only visible, never task or the imported registry, to the model.
```

Materialize only `files` in the candidate workspace. Never materialize the
fixture modules, `cases`, `referenceFiles`, or this directory in model-visible
state. Cases and references are checked into the parent repository, so they are
hidden by runner separation, not secret against a model with repository access.
The parent must restrict model file access to the candidate workspace. Give the
model file-edit operations, not arbitrary shell access.

The two multi-file tasks are `retry-policy` (`retry.mjs`, `policy.mjs`) and
`merge-patch` (`patch.mjs`, `values.mjs`). Each task is independent and needs only
its own file map. Other tasks cover tag normalization, query parsing, interval
merging, event scheduling, lease/fencing state, and dependency ordering.

## Local fixture checks

From the repository root, using Node.js 22 or newer:

```sh
node --test benchmarks/jev-cost/tasks.test.mjs
```

The tests create a fresh temporary directory for each baseline/reference run,
write only candidate modules, and import them in a separate Node process.
Verification data travels through stdin, not candidate files. Each process has
a 3-second timeout, a 1 MiB output limit, `shell: false`, and an empty environment
(no inherited credentials or `NODE_OPTIONS`). Temporary directories are removed
in `finally`. Cases use frozen inputs and run twice to catch mutation and leaked
state. References must pass every case; each baseline must load successfully and
fail a specific known behavioral assertion. Separate checks exercise the timeout,
environment clearing, and mutation detection.

These subprocess checks are for trusted fixture self-tests. A temporary working
directory and empty environment are NOT a security sandbox: candidate code can
still access host files, use the network, spawn descendants, or interfere with
in-process assertions. Before executing untrusted model output, the parent
runner needs OS/container isolation, no credential mounts, disabled networking,
resource/process limits, and external process-tree cleanup. Keep grading data
outside that isolation where practical. Do not treat the self-test helper as a
hardened production grader.
