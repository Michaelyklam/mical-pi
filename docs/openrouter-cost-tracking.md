# OpenRouter cost tracking

How Mical Pi records what a provider actually charged, separately from the
estimate Pi calculates locally. The rules for that split live in
`docs/adr/0002-separate-reported-and-estimated-cost.md`; this file covers the
mechanism that produces the reported number and how to keep it installed.

## The problem

Pi's request parsers keep only a locally calculated estimate. OpenRouter returns
the real charge on the same usage object, and the parser drops it:

- `usage.cost` is the total amount charged to the OpenRouter account, in USD.
- `usage.cost_details.upstream_inference_cost` is the BYOK upstream cost.

Docs: <https://openrouter.ai/docs/cookbook/administration/usage-accounting>

## The patches

There are two patches. Both are needed: the first preserves the charge, the
second keeps it when a split compaction merges two calls.

### pi-ai: preserve the charge

`scripts/patch-pi-ai-openrouter-cost.mjs` rewrites `parseChunkUsage` in
`@earendil-works/pi-ai` so the upstream charge survives on `usage.reportedCost`
next to the untouched estimate on `usage.cost`:

```js
usage.reportedCost = {
  amount: 0.0123,        // usage.cost, the amount charged to the account
  currency: "USD",
  source: "openrouter",
  upstreamInferenceCost: 0.01, // only when OpenRouter reports it
};
```

The patch only fires for `model.provider === "openrouter"` and only for a
finite, non-negative `usage.cost`. Other providers keep their estimates; a
negative value is rejected rather than read as a credit.

`extensions/shared/billing.ts` is the single reader. It never derives a reported
charge from the estimate, from `usage.cost` on a non-OpenRouter model, or from
account balance deltas.

### pi-coding-agent: keep the charge across a split compaction

A large turn is compacted in two calls: a history summary and a turn prefix
summary. `combineUsage` in `@earendil-works/pi-coding-agent` merges them into a
fresh usage object that copies only token counters and `cost`, so the merged
object has no `reportedCost`. Without a fix, a genuinely billed summarization
call would be reclassified as estimated.

`scripts/patch-pi-coding-agent-compaction-cost.mjs` keeps each call on
`usage.billingComponents`:

```js
usage.billingComponents = [historyUsage, turnPrefixUsage];
```

`extensions/shared/billing.ts` accounts each component on its own, so a reported
call stays reported and only the un-reported call is estimated. The merged
`cost.total` is never used as the authoritative figure. Both the unbundled copy
and the minified host bundle are patched, including the duplicate inside
`@earendil-works/pi-agent-core` when present.

## Install and verify

`npm run postinstall` runs both patches as part of the normal install. Each
script patches every copy it finds, both repo-local and the host/global install
that actually serves requests, and both are idempotent.

```bash
node scripts/patch-pi-ai-openrouter-cost.mjs                    # apply
node scripts/patch-pi-coding-agent-compaction-cost.mjs          # apply
node scripts/patch-pi-ai-openrouter-cost.mjs --check            # exit 1 if stale
node scripts/patch-pi-coding-agent-compaction-cost.mjs --check  # exit 1 if stale
npm run test:patch                                              # patch-script regression tests
npm run test:shared                                             # parser, billing, compaction tests
```

The script syntax-checks each file after writing and reverts it on failure. A
repo-local copy it cannot recognize fails the run so installs cannot silently
lose billing; an unrecognized host copy only warns. Point it at extra installs
with `PI_AI_PATCH_ROOTS` (a colon-separated list of `node_modules` roots).

## After a Pi upgrade

A global Pi upgrade replaces the patched files. Re-apply both, then restart Pi:

```bash
node scripts/patch-pi-ai-openrouter-cost.mjs
node scripts/patch-pi-coding-agent-compaction-cost.mjs
node scripts/patch-pi-ai-openrouter-cost.mjs --check
node scripts/patch-pi-coding-agent-compaction-cost.mjs --check
```

The restart matters. A running Pi process already loaded the old module, so
reported charges begin with the next process, not the next request.

If the patch reports a copy as `UNSUPPORTED`, the pi-ai release changed shape.
Check whether upstream now preserves the charge. If it does, adapt the billing
reader to upstream's format and remove the corresponding patch from
`postinstall`. Retain support for persisted `usage.reportedCost` and
`billingComponents` so existing sessions remain accurate. If upstream still
drops the charge, update the patch anchors to the new code. Note the installed versions
the script prints for both pi-ai and pi-coding-agent.

## Removing it

Remove the patches from `postinstall`, then restore the affected dependency
files from a pre-patch backup or reinstall the dependencies. The markers
`PI_REPORTED_COST_PATCH` and `PI_BILLING_COMPONENTS_PATCH` identify patched
files. Keep the historical billing readers even after removing the patches.

## Reading the numbers

`extensions/shared/billing.ts` provides the types and helpers:

- `ReportedCost` is one provider charge with provenance.
- `CostDisclosure` is the reported/estimated split: `costUsd`,
  `reportedCostUsd`, `estimatedCostUsd`.
- `readReportedCost(usage, requestId?)` reads one charge, preferring an explicit
  request id over one carried on the usage object.
- `billingComponents(usage)` splits a merged usage into the calls it combines
  (a split compaction), flattening nested merges. `undefined` when the usage is
  not a merge.
- `accumulateCost` and `summarizeSessionEntries` fold a transcript. A merged
  usage is folded per component, otherwise the reported charge per entry wins
  when present and the estimate is the fallback. A reported zero stays reported
  and suppresses the estimate. A non-USD report cannot join the USD total, so it
  falls back to the estimate.
- `combineCostDisclosures` sums several splits without merging them. A source
  that only knows a combined total is treated as an estimate.

## Limits

- Existing transcripts without a preserved reported charge remain estimates; this does not backfill billing history.
- The patches recognize the `openrouter` provider ID. Custom gateway aliases need explicit support rather than being assumed to have OpenRouter billing semantics.
- Split compactions preserve each charge amount and source, but their individual generation IDs are not currently retained by the summarization layer.
- Local-today totals are incomplete host-local observations, not the OpenRouter account balance or invoice.
- Pi's generic `usage.cost` remains an estimate. The custom footer, dashboard and child accounting read the separate reported fields; unmodified core consumers may still display the generic estimate.

## Events

Two events carry the session's spend, one per source, so a listener sums them
without double counting:

- `SUBAGENT_COST_EVENT` (`"mical:subagent-cost"`) from the subagents extension.
- `WORKFLOW_COST_EVENT` (`"mical:workflow-cost"`) from the workflows extension.

Both payloads are a `CostDisclosure`. The workflow event is cumulative across
every run tracked in the session and across the phases inside each run; it is
recalculated as agents report usage and reset to no cost on session teardown.
