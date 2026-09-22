# self-compact: vendored from upstream

Vendored from [disler/self-compact-pi-agent](https://github.com/disler/self-compact-pi-agent),
commit `576fe4abda021849f5cde5b6f5796467ffa4bcbd`.
MIT, Copyright (c) 2026 IndyDevDan. `LICENSE` is unchanged.

The upstream entry is `apps/self-compact/extensions/self-compact/self-compact.ts`, with helpers
`defaults.ts`, `thresholds.ts`, `summary.ts`, `state.ts`, `prompts.ts`, and `context-bar.ts`.
Default prompt files came from `apps/self-compact/.pi/self-compact/USER_PROMPT_*.md`.
The sample application, verification scripts, justfile, specs and upstream e2e tests are not vendored.

## Local layout

`index.ts` is the only extension entry. Helpers, prompts and adjacent tests are not loaded as
extensions. `guidance.ts` holds model-facing policy; `summary.ts` calls Pi's summary engine;
`state.ts` stores the note and reconstructs state from the branch. Local tests include a scripted
SDK lifecycle test, extension-policy checks, and a prompt-prefix regression.

## Local changes

1. **Fixed-baseline thresholds.** Defaults are 100,000 tokens for notice, 200,000 for warning,
   and 100,000 extra before the hard cutoff. The cutoff is capped at 90% of the active window,
   giving 244,800 on a 272,000-token model. Default fields clamp independently on smaller windows;
   explicit invalid flags disable self-compaction without blocking ordinary tools.
2. **Prompt discovery and entry name.** Project overrides remain under `<cwd>/.pi/self-compact/`.
   Package defaults live under `extensions/self-compact/prompts/`. The entry was renamed to
   `index.ts` for Pi's directory discovery convention.
3. **Opt-in footer.** `--compact-footer` enables the context bar. Otherwise `extensions/usage-footer`
   keeps ownership of the footer.
4. **Logical-boundary policy.** The model decides when substantial context can be discarded between
   sections of continuing work. There is no ten-tool-call trigger, next-request gate, task-end
   compaction turn, or automatic retry on reload. Counts remain diagnostic telemetry. Older
   experiment/mode entries and removed trigger keys are ignored, not rewritten.
5. **Recoverable notes.** `self_compact({})` retries a saved failed note against current history.
   A supplied note may replace a failed one, but never an active request. Failure retains history
   and note, and releases the pending-note lock. The independent hard cutoff still applies;
   diagnostics and cancellation remain available. `/self-compact-now` retries directly and
   `/self-compact-cancel` cancels without scheduling another attempt. Tool errors render as errors;
   accepting a note is not displayed as completed compaction.
6. **Session-owned lifecycle.** `self_compact` no longer returns `terminate` or calls `ctx.compact`
   from `agent_settled`. It uses `ctx.requestCompaction`, added by the maintained Pi source patch,
   to compact after the tool batch and before the next response. The note is passive context in
   the same task, with no restart prompt. A failed or interrupted session never restarts on reload.
   If the run ends before the safe point, the queued request settles as failed at run settlement:
   no orphan lock, no model work, and the saved note stays recoverable.
7. **One operation, one outcome, one notification boundary.** The core patch shares ownership across
   manual, native and requested compaction. Equivalent manual calls join; conflicting operations
   fail busy. Each operation owns its abort controller and chooses its outcome exactly once, at the
   authoritative context commit (or its failure), then cleans up exactly once. The outcome is
   delivered through one boundary: a synchronous authoritative seam (the hook's
   `registerCompletion` registration on the `session_before_compact` event, registered at hook
   entry before any awaited work and delivered exactly once at the decided outcome of commit,
   failure, cancellation or timeout, plus the request callbacks, where all extension bookkeeping
   lives and real error causes are carried explicitly), and informational notifications that
   cannot re-decide the outcome. The seam returns the saved note before the next assistant
   response even when another `session_compact` listener stalls. The extension treats
   `session_compact` and `session_compact_failed` as observations only (projection and display),
   so late deliveries can never own a newer attempt or summary, and a resumed late hook dispatch
   declines without claiming in-flight state. A five-minute deadline includes summary retries;
   self-compaction can override it with `--compact-timeout-ms`. Late cancelled/timed-out results
   cannot change history or clear a newer operation. Task cancellation prevents continuation.
   Run settlement resolves an orphaned queued request and emits `agent_settled` to extensions and
   the public exactly once per settlement, publishing the public event only when still ready after
   all asynchronous handlers.
8. **Append-only guidance.** Token crossings append one passive message per level per context cycle,
   never rewriting an earlier prompt block. `view_context` gives live numbers. Restoring the guard
   from context prevents duplicate guidance on reload or tree navigation. Pi's Anthropic serializer
   caches the system prompt, last tool and last user message, so rewriting an earlier block would
   invalidate the prefix from that point. `cache-prefix.test.ts` checks this invariant without a provider.

## Core compatibility

The upstream extension targets Pi 0.85.1. This package currently supports Pi 0.84.4 through
`scripts/patch-pi-coding-agent-compaction-lifecycle.mjs` and its method template. This is a maintained
source patch, not a runtime prototype override. `postinstall` patches the local SDK, global SDK and
CLI bundle (including `PI_AI_PATCH_ROOTS`); all targets in each package are validated before writing.
Unknown source/version fails closed without partial rewrites. The patch marker carries its revision,
so a prior-revision install is upgraded in place instead of being silently kept; a current-revision
install is byte-identical (idempotent). A running Pi process needs a restart, not just `/reload`.

Without the request API, the extension refuses self-compaction before saving a note. It leaves
ordinary tools and native compaction available. Remove the compatibility patch once Pi ships the
same safe-point and single-operation behavior upstream.

## Native overflow behavior

While self-compaction is active with valid settings and core support, the extension cancels native
threshold and overflow compaction to require a note before discarding context. When it is excluded,
unsupported, or misconfigured, native compaction is left alone.

The 90% cutoff leaves headroom, not an overflow recovery guarantee. A sufficiently large tool
result can still exceed the window before the model writes its note. In that case the request can
fail; there is no automatic note-free fallback. This is the upstream trade-off retained here.

## Verification

- `npm run test:self-compact`: policy, note recovery, errors, prefix caching and real scripted SDK
  continuation/cancellation, orphan-request settlement, post-commit stall containment, error-cause
  preservation and exactly-once settlement. No provider calls.
- `npm run test:patch`: source patch idempotence, prior-revision upgrade of SDK and bundle copies,
  overlap, deadlines, stale-result protection, post-commit notification trouble, fixture cleanup
  and installation roots.
- `npm run test:subagents`: completion classification and the existing backend/manager tests.
- `node scripts/patch-pi-coding-agent-compaction-lifecycle.mjs --check`: installed patch status.
