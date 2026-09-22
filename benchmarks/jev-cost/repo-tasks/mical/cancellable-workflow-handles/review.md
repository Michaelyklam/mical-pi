# Cancellable workflow handles

## Scope and provenance

Held-out evaluation task, hard difficulty. This is a proposed feature, not a historical regression. The baseline is the committed workflow sandbox parent, permission-restricted child, serializer, run controller, and their existing tests from `503adb5f944d3443d3e82f2c337c3a6f0d9e5d41`. No dirty source or benchmark implementation was used.

The VM exposes lazy agent thenables. It detects unconsumed handles and unsettled requests when a workflow returns. The parent owns authenticated IPC, request budgets, abort controllers, and delivery suppression. RunController combines invocation cancellation with the run signal and semaphore queue. Existing whole-workflow cancellation already works; the task adds cancellation of one handle without disturbing siblings.

Repository conventions were read from committed README.md, package.json, CONTEXT.md, and the selected tests. No committed AGENTS.md or CLAUDE.md files exist. Sources retain their original formatting and `.ts` imports. No source sanitization was needed. package.json is a new minimal offline test manifest.

## Required work

The implementation must coordinate lazy dispatch, thenable consumers, orphan accounting, the VM-to-host bridge, authenticated parent validation, abort signals, request retirement, and late callback results. Simply adding an AbortController or racing a promise does not satisfy the contract.

The reference replaces only sandbox.ts and sandbox-child.cjs. RunController remains unchanged, but a hidden integration test exercises its queued invocation cancellation. The parent also converts synchronous callback throws into normal failed outcomes. No agent backend, SDK session, network provider, or external CLI is invoked.

The prompt specifies the new wire format because protocol validation is part of the public integration contract. It does not prescribe a data structure, implementation diff, or algorithm.

## Grading

The 13 visible tests exercise sandbox permissions, capability restrictions, parallel limits, lazy orphan detection, source-wrapper integrity, synchronous loop timeout, result serialization, atomic writes, controller cancellation, and existing whole-workflow abort.

Nine hidden tests exercise lazy and active cancellation, reason normalization, repeated consumers and cancellation, ignored canceled handles, noncooperative callbacks, late success and rejection, settled-result precedence, sibling isolation, RunController queue cancellation, synchronous callback throws, request budget preservation, and parent protocol validation. Protocol tests launch a small synthetic IPC peer against a scratch copy of the real parent; this is not an agent process. It verifies unknown IDs, invalid reasons, authentication, duplicates, post-completion cancellation, and suppression of canceled results.

Tests compare values inside the VM before serialization where necessary. The existing serializer replaces repeated object references with `[circular]`; tests do not impose a new serializer identity contract.

Validated with Node v22.23.2 and tsx, using scratch workspaces and local dependencies only:

| Version | Visible | Hidden |
| --- | --- | --- |
| Baseline | 13/13 pass | 0/9 pass, 9 failures |
| Reference | 13/13 pass | 9/9 pass |

All tests completed; none were skipped or cancelled. Hidden operations have test-only abort deadlines so an incomplete implementation does not leave a child running indefinitely. These do not introduce production request timeouts. The synchronous-throw test catches an uncaught callback error on the baseline; its deadline then cleans up the outstanding sandbox.

## Runtime and isolation

Use Node with `--permission` support, tested on v22.23.2. The Docker policy must allow spawning Node sandbox children and IPC. They receive only PATH and NODE_NO_WARNINGS, not provider credentials. Tests require writable temporary storage. Set TMPDIR to a grading-owned scratch directory. TSX is the only runtime package needed; no Effect or Pi SDK runtime imports occur in this selection.

## Limits and leakage

This is a selected subsystem task, not end-to-end Pi UI validation. The harness must supply only baseline/ and the prompt to the candidate. Keep hidden/, reference/, review.md, provenance.json, and validation evidence outside its filesystem. The source task directory must not be bind-mounted wholesale into a candidate container. Do not put references in any candidate-visible Git history. Grade each task independently on its clean committed baseline.
