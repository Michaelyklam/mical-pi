# self-compact: vendored from upstream

This extension is vendored from [`disler/self-compact-pi-agent`](https://github.com/disler/self-compact-pi-agent)
(MIT, Copyright (c) 2026 IndyDevDan; full text in `LICENSE` in this directory).

- Upstream repository SHA: `576fe4abda021849f5cde5b6f5796467ffa4bcbd`
- Upstream path: `apps/self-compact/extensions/self-compact/self-compact.ts` (entry) plus the pure
  helper modules `defaults.ts`, `thresholds.ts`, `summary.ts`, `state.ts`, `prompts.ts`, `context-bar.ts`
  and the prompt files at `apps/self-compact/.pi/self-compact/USER_PROMPT_*.md`.
- Upstream sample application (`apps/self-compact/` app files, verification scripts, e2e/RPC tests,
  justfile, specs) is intentionally NOT vendored. This package ships only the extension, its helper
  modules, its default prompt files, and focused local tests.

## Layout in this package

```
extensions/self-compact/
  index.ts        # extension entry point (upstream self-compact.ts, renamed to index.ts)
  defaults.ts     # shipped threshold defaults
  thresholds.ts   # parse/resolve/level logic
  summary.ts      # native compaction engine bridge (uses Pi's compact())
  state.ts        # persisted state snapshot + recovery reducer
  prompts.ts      # prompt file discovery/templating
  guidance.ts     # agent-facing text: tool description, system-prompt line, trigger messages
  context-bar.ts  # 20-cell context bar renderer
  prompts/        # vendored default prompt files (see prompts.ts)
  LICENSE         # upstream MIT license, unchanged
  UPSTREAM.md     # this file
```

Pi discovers exactly `index.ts` for a package subdirectory: it resolves a directory's entry via
`package.json` `pi.extensions`, then `index.ts` / `index.js`, and stops. Helper modules, the
`prompts/` directory, and the `*.test.ts` files next to the entry are therefore never loaded as
separate extensions.

## Local changes vs upstream

1. **Fixed-baseline defaults** (`defaults.ts`). Upstream ships percentage defaults
   (`softAt: "10%"`, `at: "20%"`, `buffer: "10%"`) that are recomputed against whatever context
   window the active model reports. Here the defaults are fixed token counts derived from a nominal
   1,000,000-token baseline:

   | line | tokens | nominal baseline share |
   | --- | --- | --- |
   | notice | 100,000 | 10% |
   | warning | 200,000 | 20% |
   | hard cutoff | warning + buffer = 300,000 before the window cap | 30% |

   The hard cutoff is still `min(warning + buffer, 90% of the actual window)`. For
   `openai-codex/gpt-6-astra` (272,000-token window) the forced line caps at 244,800 while
   notice/warning stay 100,000/200,000. This keeps the notice/warning lines stable when the active
   model changes, instead of moving them to a fraction of each model's window.

2. **Per-field clamping** (`thresholds.ts`). Upstream resolved with a single `fromDefaults` boolean,
   so setting any one flag disabled clamping for the other two fields. Local version clamps each
   field independently using its source (`flag` vs `default`): defaults that do not fit a small
   window are clamped down with a note, while explicit flags are still validated strictly and can
   make the extension inert. `validateSpecs` is source-aware for the same reason, so a partial
   override cannot be rejected before the window is known.

3. **Vendored prompt defaults** (`prompts.ts`, `prompts/`). Upstream's second prompt search directory
   was `<extension dir>/../../.pi/self-compact` (the sample app's working directory). Local version
   reads the vendored defaults from `<extension dir>/prompts/` and keeps `<cwd>/.pi/self-compact/`
   as the first, user-editable override.

4. **Entry renamed** `self-compact.ts` → `index.ts` to match this package's multi-file extension
   convention. Header comments in `index.ts` record the upstream SHA and these changes.

5. **Footer bar is opt-in** (`index.ts`). This package also ships `extensions/usage-footer`, which
   installs its own Pi footer. Upstream always replaced the footer; local version only installs the
   self-compact bar when `--compact-footer` is set, so the two extensions do not overwrite each
   other. `/self-compact-info` lists the setting, and the rest of the extension (guidance, lock,
   `view_context`, `self_compact`) works the same with the bar disabled.

6. **Proactive compaction, one tool, derived lock** (`guidance.ts`, `index.ts`, `state.ts`, tests).
   The agent-facing text lives in `guidance.ts`: the tool description, guidelines, and system-prompt
   line all tell the agent to compact on its own judgement at natural checkpoints once
   `TOOL_CALL_TRIGGER` (10) ordinary tool calls have accumulated, with the token thresholds as a
   backstop. `index.ts` counts ordinary tool calls (not `self_compact`, not `view_context`) and
   sends two extra trigger messages, `CHECKPOINT` mid-run and `RUN ENDED` as a follow-up turn after
   a heavy run. All triggers (those two, the three threshold levels, and the idle `now` nudge) go
   through one `fire()` that sends a `self-compact-guidance` message once per compaction cycle and
   restores its once-per-cycle guard from the context on reload or compaction. The forced lock is
   derived (`activeHandoff() || level === "forced" && compactable`) instead of persisted; older
   state snapshots that carry `locked` are read and the field dropped. Usage is re-read in
   `message_end`, `tool_call`, `context`, and `agent_end`; the `turn_end` hook is gone.

   An earlier local version ran an A/B experiment with a second tool (`self_compact_experimental`),
   a per-session `/self-compact-mode` selector, and transactional tool-set switching. It was
   removed: the proactive wording is now the only wording, and the mode entries it persisted
   (`self-compact-mode`) are ignored on read.

7. **Append-only threshold guidance (prompt-cache boundary fix)** (`index.ts`, `cache-prefix.test.ts`,
   `extension.test.ts`, README). Upstream rebuilt one transient guidance message on every LLM call:
   the `context` hook filtered the previous one out of the message list and pushed a fresh copy
   rendered from the current numbers, and the idle "compact now" nudge (sent with
   `triggerTurn: true`) was filtered out the same way on the next call. Both rewrote prompt material
   the provider had already seen. The local version instead appends the guidance once per level per
   context epoch with `pi.sendMessage(..., { triggerTurn: false })` (Pi journals it as a
   `custom_message` entry, which `convertToLlm` turns into a user message for the provider) and never
   edits or removes it afterwards; `view_context` reports the live numbers, so nothing needs
   re-rendering. The `context` hook now only detects crossings and returns `undefined`. The idle
   nudge is sent the same way (key `now`). Per-epoch
   re-announcement is restored from the compaction-aware context projection, so a reload, resume, or
   `/tree` move never duplicates a guidance message already in the model's context, while a
   compaction that summarizes it away lets the new epoch announce again.

   Why a guidance message cannot simply be re-rendered: Pi's Anthropic serializer
   (`pi-ai/dist/api/anthropic-messages.js`) accepts only user/assistant/toolResult messages and puts
   `cache_control` on the system prompt, the last tool, and the last user message. A prefix cache is
   reused up to the first block that differs from a cached prefix, so a block that changes or
   vanishes in the middle invalidates the cache from that block onward and every later tool result
   has to be written again on each turn. `cache-prefix.test.ts` drives the real extension through the
   real extension loader, models Pi's per-request pipeline (session projection -> `context` hook ->
   `convertToLlm`) and asserts that every request payload is an exact prefix extension of the
   previous one across the notice/warning/forced crossings, a reload, and the idle nudge. It uses no provider, no sleeps, and no fake server.

## Native overflow behavior

The extension cancels Pi's automatic compaction. On `session_before_compact` with reason
`threshold` or `overflow` it returns `{cancel: true}` and engages the forced lock, so Pi's own
auto-compaction never runs. Compaction happens only through the `self_compact` note handoff. On
Pi 0.84.4 a cancelled automatic compaction emits `compaction_end` with `aborted: true` and a
`session_compact_failed` event, which the extension ignores when it is not a manual compaction.

The 90% hard cap (`HARD_CAP_FRACTION`) only bounds how far the thresholds reach. The forced line
can never sit above 90% of the window, which leaves at least 10% of the window for the agent to
write `note_to_self` and for the summarizer request to run. That is headroom, not a safety net.
Native auto-compaction, overflow recovery included, is replaced rather than preserved, so a turn
that grows past the window before the agent compacts (a large tool result, for example) gets no
automatic recovery and Pi fails that request. The upstream design accepts that trade to guarantee
the note exists before the context is discarded.

## Upstream references (not vendored)

- Upstream targets Pi `0.85.1`; this package is installed against Pi `0.84.4`. The required hooks,
  the `terminate` tool-result flag, and the `ctx`/`modelRegistry` APIs were verified against 0.84.4
  (see `extension.test.ts` and `docs/` in this package).
