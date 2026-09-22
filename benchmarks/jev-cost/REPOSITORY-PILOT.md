# Harder repository routing pilot

User-approved scope: mical-pi and the Foosheq app under personal-website. Selected sanitized source and task descriptions may reach Jev through OpenRouter. No credentials, personal records, production access, deployment or edits to the original projects.

## Why this round exists

Both fixed models passed all earlier synthetic tasks. That ceiling prevented meaningful measurement of routing quality. This round uses authored feature requests in real, multi-module source snapshots. These are not claims of newly discovered production bugs or independent historical benchmark issues.

## Preparation before spending

Task authors work from committed snapshots, not dirty working trees. Each task has a visible repository subset, existing regression tests, a separate reference implementation and hidden feature tests. Parent checks that the baseline passes visible tests but fails hidden requirements, and that the reference passes both. Task IDs, source fingerprints, split and policy are frozen before paid generation.

The model can inspect and search its source snapshot, make precise edits, add source or tests, and run offline commands. It cannot read reference files, hidden tests, original git history, host files, credentials or other task runs. Existing test files and package configuration are protected from model edits. Hidden tests are introduced only after the coding session ends.

A clean completion is not sufficient. Verified success also requires passing visible and hidden tests without reducing the reference hidden-test count or passed count. This checks selected runtime requirements; it is not a full production build, hardware certification or proof of correctness. As with ordinary test-based benchmarks, protected-file checks and test counts are safeguards, not a complete defense against deliberately malicious benchmark gaming.

## Controls

- Astra-only and Luna-only attempt every task independently.
- Calibration outcomes may inform selectors, but evaluation outcomes may not. Hold-out routing decisions are saved before either coding model attempts any held-out task.
- Jev and Luna selectors receive identical task descriptions, file trees, deterministic baseline source excerpts and calibration summaries.
- Fixed rule: Astra for requests containing cancel/concurren/atomic/rollback/stale/reconnect/transaction; Luna otherwise. This rule is not fitted to evaluation outcomes.
- Cheap-first fallback escalates only after abnormal completion or failed visible checks. Hidden grading is never an escalation oracle.
- A hindsight oracle is an explicitly nondeployable bound using already-observed outcomes, reported separately.
- Routing/fallback totals replay measured independent coding runs. They do not measure fresh model-switching sessions, warm handoff or cache rebuilding.

Each generator has 24 model turns, ten minutes, medium reasoning and a 262144-byte serialized context cap. Separate session IDs and alternating model order reduce some ordering effects but do not eliminate shared provider-cache effects. No quality claims should depend on a single task or one lucky sample.

## Safety and budget

All generated code runs in fresh Docker containers, not a Node VM on the host. Containers have no network or host mounts, run as nonroot with dropped capabilities, use read-only images and resource-limited writable tmpfs. Public package dependencies are prepared offline from local installations; no host credential environment enters candidate processes. The container is removed after execution or timeout.

The original locked ledger remains at `/tmp/jev-cost-pilot/budget.json`. There is no new $50 allowance. At authorization, $9.231962316 was conservatively committed, including previous estimates and uncertainty. Actual Jev charges and Codex API-equivalent estimates stay separate. Before each model request the full advertised output allowance and conservative input bound must fit the remaining cap. No automatic retry after unknown usage.

Parent planning, task authoring and test-runner development use existing subscription resources outside recorded benchmark-generation request totals, as in the first round.

## Commands

Run paid commands sequentially, never concurrently:

```sh
# Offline setup and validation
node benchmarks/jev-cost/repo-sandbox.mjs setup
node --test benchmarks/jev-cost/repo-runner.test.mjs benchmarks/jev-cost/repo-sandbox.test.mjs
node benchmarks/jev-cost/repo-runner.mjs inventory
node benchmarks/jev-cost/repo-runner.mjs validate
node benchmarks/jev-cost/repo-runner.mjs freeze

# Paid benchmark requests, against the original ledger
node benchmarks/jev-cost/repo-runner.mjs run calibration
node benchmarks/jev-cost/repo-runner.mjs route
node benchmarks/jev-cost/repo-runner.mjs run evaluation

# Offline aggregate report; no source code in the browser artifact
node benchmarks/jev-cost/repo-report.mjs /tmp/jev-repository-report
```

An interrupted run is not silently resumed as a fresh attempt. Review its reservation and artifact first. Never discard or reset the original ledger to continue spending.
