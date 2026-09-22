# mical-pi task set

Delivered two tasks under the user's approved quality fallback, not the requested four:

| Task | Split | Difficulty |
| --- | --- | --- |
| reported-charge-reconciliation | calibration | moderate |
| cancellable-workflow-handles | evaluation | hard |

The hard calibration task and second held-out hard task are not supplied. This set therefore does not satisfy the original 2+2 split. I prioritized validating real subsystem interactions over adding weaker fixtures. Both tasks are independent feature requests on committed `503adb5f944d3443d3e82f2c337c3a6f0d9e5d41`, with no asserted historical defect.

Each task has task.json, baseline/, reference/, hidden/, review.md, provenance.json, and validation.json. Read the per-task review for coverage and runtime requirements. The parent should use only baseline/ plus prompt when constructing candidate workspaces. No reference, hidden test, review, provenance, or validation files should be mounted during candidate work. Do not add reference solutions to candidate-visible Git history.

All author validation used scratch copies under `/tmp/jev-repo-author-mical/`. No existing repository source or working changes were edited. The only repository writes are new files beneath this directory. No live API calls, model calls, extra agents, deployments, or dependency installation occurred. Workflow tests spawn the real sandbox's restricted Node child or a synthetic IPC peer with fake callbacks; they never spawn agent runtimes.

Commands require Node v22.23.2 or a compatible release with `--permission`, and local tsx. The selected source has no Effect runtime dependency. Type-only Pi AI imports in the accounting subsystem are erased by tsx. The parent may supply a read-only node_modules mount. Set TMPDIR to a writable grading scratch directory.
