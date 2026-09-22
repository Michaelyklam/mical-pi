# Provider charge reconciliation

## Scope and provenance

Calibration task, moderate difficulty. This is a proposed feature, not a historical regression. The baseline copies the real session ledger, pricing resolver, domain types, and pricing/ledger tests from committed `503adb5f944d3443d3e82f2c337c3a6f0d9e5d41`. No source came from the dirty working tree.

The ledger currently reconstructs all incurred usage, including abandoned branches and compaction, then uses current registry prices. It always returns `reported: 0`. The request adds a durable provider charge record that replaces an estimate for one already-attributable request. It does not treat Pi's locally computed Usage.cost as a provider bill.

Repository conventions were read from committed README.md, package.json, CONTEXT.md, and the selected tests. There were no committed AGENTS.md or CLAUDE.md files. Keep TypeScript modules, explicit `.ts` imports, and node:test assertions. The baseline includes the account terminology document.

The only source sanitization is replacing the organization-specific provider fixture name in pricing-ledger.test.ts with `router-fixture`. The fixture URL is already the reserved `https://example.test`. package.json is a new minimal offline test manifest. No credentials, provider configuration, Git metadata, or dependency directory are included.

## Required work

This needs an understanding of SessionLedger attribution, PricingResolver fallback and request-wide tiers, and the domain's distinction between reported and estimated amounts. The solution must reconcile out-of-order revisions, reject malformed persistent data, retain account/provider separation, and exclude charged requests from estimate metadata without changing the existing attribution counters.

The reference replaces only session-ledger.ts and domain.ts. It does not change pricing.ts or visible tests. Alternate implementations can pass; hidden tests check public summaries rather than internal data structures.

## Grading

Existing visible tests cover direct and canonical pricing, conflicting schedules, fuzzy-match rejection, tiers, account attribution, tools, branches, compaction, and legacy resolution.

Seven hidden tests cover mixed reported/estimated/unpriced requests, zero-dollar charges, timestamps and tie-breaking, malformed records, orphan reports, foreign accounts/providers, tool and unattributed exclusion, branch summaries, immutability, repeated summaries, tier fallback, and refusal to infer charges from Usage.cost.

Validated with Node v22.23.2 and tsx, using scratch workspaces and local dependencies only:

| Version | Visible | Hidden |
| --- | --- | --- |
| Baseline | 4/4 pass | 2/7 pass, 5 feature failures |
| Reference | 4/4 pass | 7/7 pass |

All tests completed; none were skipped or cancelled. The command arrays in task.json run from the workspace root. Hidden tests import the real baseline paths after hidden/ is copied into that workspace.

## Limits and leakage

The task does not add a live billing adapter, persistence writer, or UI changes. Those are outside the supplied subsystem. Interface presence is documented but not separately typechecked by the runtime tests.

Expose only baseline/ and the prompt to the candidate. Keep reference/, hidden/, review.md, provenance.json, and validation evidence outside the candidate filesystem. Do not commit reference solutions into any history made available to candidates. Run each task on its own clean baseline; never reuse another task's solved workspace.
