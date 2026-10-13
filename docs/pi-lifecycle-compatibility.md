# Pi lifecycle patch compatibility

The maintained source patch supports Pi 1.1.0 and 1.2.0. Development dependencies are pinned to 1.2.0 for parity with the installed CLI. Peer dependencies remain host-supplied. V5 applies to SDK modules and the CLI bundle, upgrades prior markers, and checks every target before writing any file in a package.

## Review of 1.2.0

Compared the published 1.1.0 and 1.2.0 `dist/core/agent-session.js` and `dist/core/extensions/runner.js`, then reviewed the installed 1.2.0 core and documentation. These are source changes relevant to the patch:

- `_runAgentPrompt` becomes `_startRun` plus `_prepareRun`. `_startRun` sets `_isAgentRunActive` before compaction and `before_agent_start`. User and custom-message runs now share preparation.
- Aborting during preparation records the request; `agent_start` checks it before the first provider request.
- A preparation exception clears `_isAgentRunActive`, flushes pending messages, and resolves native idle waiters, but never reaches `_emitAgentSettled`. V4's separate run-end waiters and queued compaction request could survive this path. V5 adds `_resolveAgentRunEnd()` and `_settleRequestedCompaction()` to that catch path without publishing a false settlement event.
- Deferred custom-message runs call `sendCustomMessage` again rather than bypassing preparation. The patch retains the upstream deferred actions and their ordering.
- `emitBeforeAgentStart` receives a user/custom trigger union. This is outside the patched context-forwarding methods.
- Tool descriptions gain `reachesTools`. The patch leaves this metadata unchanged.

The `_runDefaultCompaction(preparation, model, customInstructions, signal, reason)` signature, canonical projection refresh, next-turn compaction and cancellation anchors, compact context binding, runner forwarding, and native settlement hooks remain compatible. The compaction serializer now omits thinking blocks; injected methods still call upstream summarization rather than replacing serialization.

This is not an open-ended version guard. Unknown versions fail even when they carry a copied patch marker. Recognized versions still must match the source anchors when applying or upgrading. A changed 1.2-style starting-run failure cleanup fails validation rather than being patched by guesswork.

## Verification

`npm install` runs all maintained patch installers. Run each installer with `--check`, then `npm run test:patch`, `npm run test:self-compact`, and `npm run typecheck`. Lifecycle tests cover cancellation, deadlines, one-owner commits, stale results, public settlement ordering, callback failures, bundle helper renames, idempotent prior-marker upgrades, and starting-run preparation failure.

For a prior-version regression run, install or extract the reviewed package with matching Pi dependencies and run:

```sh
PI_LIFECYCLE_TEST_ROOT=/absolute/path/to/pi-coding-agent \
  node --test scripts/patch-pi-coding-agent-compaction-lifecycle.test.mjs
```

This runs the same behavioral suite against that package's SDK and bundle without replacing the pinned installation. Pin `pi-ai`, `pi-agent-core`, `pi-codemode`, and `pi-tui` to 1.1.0 for the 1.1.0 compatibility run. Its dependency ranges otherwise permit 1.2.0, whose codemode declarations no longer export `MCP_TYPESCRIPT_PREAMBLE`; that mixed installation fails before the lifecycle tests load. The 1.2.0-specific starting-run test is skipped on 1.1.0, which activates only after preparation.

Restart Pi after installing or upgrading this patch. Reloading extensions cannot replace core modules already loaded in the process.
