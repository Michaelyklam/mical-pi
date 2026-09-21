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
  variants.ts     # A/B variant definitions (control + experimental prompt surface)
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

6. **Compaction mode: `self_compact` vs `self_compact_experimental`** (`variants.ts`, `state.ts`,
   `index.ts`, tests). The extension exposes two self-compaction tools that share the whole engine
   (same thresholds, forced lock, note handoff, and persisted state) and differ only in the prompt
   the agent sees.

   - Variant A is the existing `self_compact` tool and remains the default control. Both tools are
     registered at load, because registration is not exposure: the selected mode decides which one
     is active, and Pi renders prompt snippets, guidelines, and descriptions from active tools only.
   - The mode is a per-session choice made with `/self-compact-mode`: an interactive `ctx.ui.select`
     picker (`Control`, `Experimental`, `Off`) plus `control|experimental|off` and the `a|b|none`
     aliases as arguments for noninteractive runs. It is stored as a durable custom entry
     (`self-compact-mode`) in that session and read back by `recoverMode()` on start, resume, reload,
     and tree navigation, so two sessions can run different arms at the same time. The command makes
     no model turn. A fresh session starts on Control, and `--compact-experimental` bootstraps a new
     session onto the Experimental mode.
   - `applyMode()` is the only place that changes the tool set: it removes both variant names from
     `pi.getActiveTools()`, adds the selected one, and calls `pi.setActiveTools`, which preserves
     every unrelated and foreign tool. Pi's hard filters still win, so a mode whose tool
     `--tools`/`--exclude-tools` denies is reported as blocked in `/self-compact-info` and in a
     warning, and nothing is persisted. A user switch is transactional: the exact tool set read
     before the attempt is put back, so a refused switch leaves the previous variant running with
     every unrelated tool. Startup recovery rolls back to passive instead (both variants trimmed),
     because Pi activates every registered extension tool while it builds the runtime and the set
     read there can already contain a variant the session never selected.
   - `Off` restores native compaction: no guidance, no lock, no timers, and `session_before_compact`
     returns `undefined` again. A pending note makes a switch to `Off` be refused until the handoff
     settles, and a resumed session whose saved mode is `Off` with a note pending falls back to a
     compaction-capable mode, so a saved note is never stranded.
   - Variant B's prompt is the user's A/B-test wording, kept verbatim in `variants.ts`
     (`EXPERIMENTAL_PROMPT`) and exposed on every prompt surface: tool description, prompt snippet,
     prompt guidelines, the `note_to_self` parameter description, and the transient notice/warning/
     forced guidance messages.
   - Tool selection stays Pi's: `--tools` (strict allowlist) and `--exclude-tools` (denylist) cover
     extension tools, and the extension reads `pi.getActiveTools()` for both `enabled()` and the
     variant it targets. Exactly one variant is active in every mode, so every extension-generated
     message names the selected one and the inactive arm never reaches a request. When neither can
     be active the extension is passive: native compaction is not cancelled, tools are never
     locked, and no guidance is sent. The read-only `view_context` tool stays registered, since it
     changes nothing, `Off` included.
   - Variant A keeps reading the vendored, user-overridable `.pi/self-compact/USER_PROMPT_*.md`
     files and is byte-identical to before this change. Variant B never reads those files, so file
     overrides cannot leak into the experiment arm.

   Mode matrix:

   | mode | active variant | how to select it |
   | --- | --- | --- |
   | `Control` (default) | `self_compact` | `/self-compact-mode control`, or nothing for a new session |
   | `Experimental` | `self_compact_experimental` | `/self-compact-mode experimental`, or `--compact-experimental` for a new session |
   | `Off` | none, native compaction untouched | `/self-compact-mode off` |

   The earlier flag matrix (`--exclude-tools self_compact` to run B alone) is no longer needed: the
   mode selects one variant by itself, and `--exclude-tools` is only a hard filter that can block a
   selection.

   Scope and limits of the experiment: both variants expose the same `note_to_self` schema and the
   same compaction prompt (`preferences`/`USER_PROMPT_COMPACTION_MESSAGE.md`), so the promoted
   summary engine is held constant. Thresholds and the forced-lock behaviour are shared code, not
   per-variant settings. `/self-compact-info` reports the active variants and the primary tool.

   Subagents are outside the experiment.
   `extensions/subagents/src/backends/pi.ts` builds every child with
   `createAgentSession({ excludeTools: CHILD_EXCLUDED_TOOL_NAMES })` and forwards no parent CLI
   flags or mode entries, so `--compact-experimental` and a parent's Experimental mode never reach a
   child: children always run variant A, and B is registered there like any extension tool but stays
   inactive. A real child session was inspected for this: its active tools were `self_compact`
   and `view_context` (no `self_compact_experimental`), and its system prompt carried control's
   snippet and guidelines. Per-child variant selection is not available today. The only
   subagents-side lever is `CHILD_EXCLUDED_TOOL_NAMES`, which can turn self-compaction off inside
   children by excluding `self_compact` but cannot select B. Pi's `ExtensionRunner` exposes
   `getFlagValues()` and `setFlagValue()` if that forwarding is ever wired up. The subagents
   extension was not changed.

   Runtime verification (real `pi` startup, fake provider, no billed request):

   - Harness: a local OpenAI-completions server records each request body and returns a canned SSE
     stream, a test-only extension registers the `fake` provider, and `pi` runs in print mode as
     `pi -ne -e <provider> -e extensions/self-compact/index.ts -p hi`. `node --test run.mjs` runs 11
     checks, all passing.
   - Control (the default): active tools `bash, edit, read, self_compact, view_context, write`;
     control snippet and guidelines present; the exact B prompt absent.
   - `--compact-experimental`: active tools `bash, edit, read, self_compact_experimental,
     view_context, write`, so the flag selects one arm instead of adding B next to A. The request
     carries B's snippet, guidelines, and note description, and no control snippet, control
     guideline, control note description, or bare `self_compact` appears anywhere in it.
   - Experimental with `--exclude-tools self_compact`: B only, same request evidence.
   - Experimental via `--tools read,bash,self_compact_experimental,view_context`: active tools are
     exactly those four, so a strict allowlist selects B too.
   - Passive (`--exclude-tools self_compact` without a mode that selects B, or both variants
     excluded): no variant active, no self-compact system-prompt line, no control snippet, no B
     prompt.
   - Resume: turn 1 with `--compact-experimental` persisted the mode entry, and turn 2 with
     `--continue` and no flag sent a request whose tools were `self_compact_experimental` and
     `view_context` only, so the saved arm was restored.
   - Deferred guidance: with the thresholds forced to 1/2/0 and a first response that calls a tool,
     the second request contained the `[self-compact · ...]` guidance carrying the exact B prompt
     and never the control name; the passive configuration showed no guidance at all.
   - Real SDK checks (real `AgentSession`, real extension loader, real command dispatcher): the
     picker and argument paths switch modes, preserve unrelated tools, persist exactly one mode
     entry, and start no model turn (`messages` empty and no provider request); `session.reload()`
     restored the saved arm and duplicated no entry; `Off`, an invalid argument, and a
     `--tools`-denied selection all behaved as described above.

No behavioural changes were made to `summary.ts`, `state.ts`, or `context-bar.ts`.

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
