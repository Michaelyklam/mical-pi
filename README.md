# mical-pi

Michael's personal [pi](https://pi.dev) package: extensions, skills, prompts, and themes shared across machines. The skills are also exposed to other agent runtimes such as Claude Code.

## Install

```bash
# On this machine — local path install, NOT copied, so edits are live and /reload picks them up
pi install ~/Coding/mical-pi

# On another machine — pinned git ref
pi install git:git@github.com:Michaelyklam/mical-pi@v1
```

Update a pinned install by re-installing at a new ref:

```bash
pi install git:git@github.com:Michaelyklam/mical-pi@v2
pi update --extensions   # reconciles existing clones to the configured ref
```

Uses pi's convention directories (no `pi` manifest in `package.json`), so anything
dropped in these folders is picked up automatically:

| Directory | Loaded as |
|-----------|-----------|
| `extensions/` | `.ts` / `.js` extensions (also `<name>/index.ts`) |
| `skills/` | `SKILL.md` folders, plus top-level `.md` files |
| `prompts/` | `.md` prompt templates |
| `themes/` | `.json` themes |

Enable/disable individual resources with `pi config` (Tab switches global vs project scope).

## Contents

### `skills/`

Personal development skills shared between Pi and Claude Code. Pi discovers them through this package; `~/.claude/skills` points to this directory for Claude Code. Standalone third-party skills are tracked in `.github/skill-sources.json` and checked weekly by `.github/workflows/sync-external-skills.yml`. Marketplace-published skill collections, including Matt Pocock's skills, are installed and updated through `extensions/claude-plugin-receiver` instead of being copied into this directory.

### `extensions/effort`

Adds `/effort`, an interactive picker for the reasoning levels supported by the current model.
The picker uses Pi's model metadata, so unsupported levels stay hidden. Select a level in the
picker, or set one directly with `/effort high`.

### `extensions/mcp-health`

Replaces the persistent MCP footer entry with a silent-until-broken one. Shows nothing while
servers are healthy; when one is not, names it — `MCP: hex failed 12s ago`, `MCP: hex needs auth`.

Reads `pi-mcp-adapter`'s snapshot off pi's shared event bus
(`pi-mcp-adapter/status/v1`) and renders under its own `mcp-health` footer key. Requires
`settings.mcpFooterStatus: "off"` in the MCP config so the adapter's own footer does not render
alongside it; the adapter publishes its snapshot before honouring that setting, so turning the
footer off does not suppress the events this depends on.

**`cached` and `not-connected` count as healthy.** The adapter connects lazily, so a configured
server sits at `cached` (metadata cached, dials on first tool call) until it is actually used.
Treating "not currently connected" as a fault would leave the footer visible permanently, which
is the opposite of the point. Only `failed` and `needs-auth` are faults.

Unhealthy is matched as "not in the known-healthy set" rather than as a list of failure states,
so if the adapter renames or adds a failure status it surfaces in the footer as an unfamiliar
word instead of the indicator silently going quiet.

### `extensions/session-aliases`

Adds `/clear` as an alias for pi's built-in `/new` command. It uses
`ExtensionCommandContext.newSession()` rather than editing session storage directly, so it follows
pi's normal replacement lifecycle: extensions can cancel through `session_before_switch`, the old
runtime receives `session_shutdown`, and a fresh session starts with resources reloaded. The prior
session remains saved and available through `/resume`.

`/clear` accepts no arguments. Any argument produces a usage warning instead of being silently
lost.

### `extensions/fast-mode`

Adds `/fast [on|off|status]` for GPT-5.6 requests through the OpenAI and OpenAI Codex providers. When enabled, outgoing requests include `service_tier: "priority"` (OpenAI's backward-compatible name for Fast mode); a `⚡ fast` footer status indicates that requests for the selected model are being marked Fast. The setting is retained in the current session and defaults off in new sessions.

Fast mode uses the same model with accelerated API processing and premium token pricing. OpenAI guarantees the tier on its pay-as-you-go API; the ChatGPT OAuth backend may ignore or downgrade it.

### `extensions/live-time`

Replaces Pi's static `Working...` message during an active agent run with a live,
zero-padded elapsed timer:

```
Working for 00:02:17
```

The timer starts when the agent begins and continues across automatic retries and compaction.
After the agent settles, a durable `Turn took 00:02:17` line is added to the transcript.
Pi's existing spinner remains unchanged.

### `extensions/usage-footer`

Replaces Pi's built-in footer with an account-aware model, cost, and allowance display:

```
Model: gpt-5.6-sol · personal | ⚡ fast | Est: ~$0.33 | Usage: 5h ██░░░ 43% · 7d █░░░░ 18%
subagents: ■ 12 running · /subagents to view | workflows: ■ 2 running · /workflows to view | [Subagents: $0.13]
Ctx: 72.5k/371k | Cache: 94.2% latest · 91.8% session | ⎇ main | (+12,-4)
```

A **Provider Account** is a Pi provider plus its stable upstream account identity. Different
provider IDs remain separate even when they share a gateway. OAuth accounts are detected from
upstream profile/claims; API-key and gateway accounts receive user labels at startup so key
rotation does not fragment their history.

- Session cost follows the selected Provider Account and includes all incurred branches.
- Provider-reported OpenRouter charges and Pi-registry estimates remain visibly separate in session, local-today and child-agent totals. Historical records without a reported charge remain estimates.
- Router aliases inherit estimate pricing only from an unambiguous exact canonical model ID.
- Anthropic usage comes from the selected account's OAuth profile/usage endpoints.
- Codex usage comes from its account app-server protocol using Pi's selected OAuth token,
  including account-wide daily tokens from other hosts.
- Unsupported providers fall back to clearly labeled local-today tokens and estimates.
- Failed account-wide data is marked stale for up to 30 minutes before local fallback.
- Dispatcher and child-agent costs stay separate. Subagent/workflow activity and the
  bracketed aggregate for Pi, Claude Code, and Codex children use a dedicated row when present.
- Prompt-cache telemetry shows the latest main-conversation hit rate beside its session average.
  It uses the provider-independent ratio `cacheRead / (input + cacheRead + cacheWrite)` and stays
  hidden until the provider reports cache reads or writes. Tool, compaction, and branch-summary
  model calls are excluded so nested work does not distort conversation-context caching. Use
  `/session` for Pi's cumulative cached/uncached split and avoidable `Cache Re-billed` diagnostics.
- Responsive rendering preserves model/account identity, non-agent extension statuses, context,
  and cache rates before cost, allowance, and Git details.

The extension follows Pi's theme and keeps `(+N,-M)` from staged plus unstaged Git shortstat.
`/statusline` toggles the footer. `/usage` opens the interactive account dashboard; it can
refresh, rename, archive, inspect, and switch Provider Accounts. `/account-label` quickly
renames the active account.

`codex` is required for account-wide Codex subscription data. Discovery checks PATH, then the user's `.local/bin` and `.npm-global/bin`, so a restricted Pi process PATH does not hide an installed CLI. `ccusage` is optional and only
augments local fallback with matching native Claude/Codex transcripts. Neither `ccstatusline`,
`jq`, nor the old `ccstatusline-today-vs-budget` helper is required.

OpenRouter charge capture and split-compaction accounting use maintained Pi dependency patches. Restart Pi after applying them; after a global Pi update, run `npm run postinstall` to reapply and `npm run test:patch` to verify. See [`docs/openrouter-cost-tracking.md`](docs/openrouter-cost-tracking.md).

Design and behavior are documented in [`CONTEXT.md`](CONTEXT.md),
[`docs/usage-footer-ux.md`](docs/usage-footer-ux.md), and
[`docs/plans/account-aware-usage-footer.md`](docs/plans/account-aware-usage-footer.md).

### `extensions/firecrawl-web`

Gives pi web access, which it otherwise has none of — the built-ins are only
`read`/`bash`/`edit`/`write`/`grep`/`find`/`ls`, and pi has no MCP client, so this is a
plain custom tool pair backed by [Firecrawl](https://firecrawl.dev):

| Tool | Endpoint | Use |
|------|----------|-----|
| `web_search` | `POST /v2/search` | Discovery. `includeContent: true` also returns each result's page text, avoiding follow-up fetches. |
| `web_fetch` | `POST /v2/scrape` | Known URL → clean markdown. Handles JS-rendered pages and public PDF/DOCX URLs. |

This installation uses Michael's self-hosted Firecrawl server. Its URL and bearer token
live in `~/.pi/agent/firecrawl.env`, which must have mode `0600` and must never be committed.
The extension reads configuration at call time. The private file takes precedence over
inherited environment variables, preventing stale shell credentials from redirecting Pi:

```bash
FIRECRAWL_API_URL=https://firecrawl.example.com
FIRECRAWL_API_KEY=<private bearer token>
```

`PI_CODING_AGENT_DIR` changes the directory containing `firecrawl.env`. If neither the file
nor environment variables provide configuration, the official SDK's rate-limited keyless
cloud tier remains available as a fallback. See
[`docs/firecrawl.md`](docs/firecrawl.md) for credential installation, connectivity checks,
and external-agent API endpoints.

This is the one resource here with a runtime dependency (`firecrawl`). Pi runs `npm install`
for npm/git package installs, so it resolves automatically on other machines; for the
local-path install run `npm install` yourself. The SDK is imported lazily inside `execute`,
so sessions that never search pay no startup cost.

Known limitation: the SDK takes no `AbortSignal`, so cancelling returns control to the
agent immediately but does not tear down the in-flight request; `timeout` bounds it
server-side (60s search / 45s fetch).

### `extensions/ask-user`

An `ask_user` tool: the model asks one multiple-choice question (2-5 options) in a popup,
navigable with arrows or number keys, with an always-appended "Write my own answer…"
option that opens an inline editor.

| Outcome | Model is told |
|---------|---------------|
| Option picked | `User selected option N: <label>` |
| Free-form answer | `User wrote their own answer: …` |
| Esc | `User dismissed the question… Do not assume an answer` |
| Turn aborted | `Cancelled` |
| Non-TUI mode | `No interactive UI is available… ask in plain text instead` |

Dismissal and cancellation are deliberately different: Esc means the human *declined*, so
the model must not invent an answer, whereas an aborted turn just means the question never
got its chance. `executionMode: "sequential"` keeps the popup from racing other tool calls
for the editor.

Ported from [davis7dotsh/my-pi-setup](https://github.com/davis7dotsh/my-pi-setup/tree/main/extensions/ask-user).
One deviation: upstream depends on `effect` (a 4.x beta) purely to bridge pi's `AbortSignal`
into the UI promise and to tell interruption from real failure. That's a few lines of
`AbortController` here, so this port stays dependency-free. Behavior is identical — including
abort-mid-popup reporting `Cancelled` rather than `dismissed`.

### `extensions/claude-plugin-receiver`

Receives the skills section of Claude Code plugin marketplaces without depending on Claude's
private cache. Add a marketplace with `/marketplace add owner/repo`, then inspect and subscribe
to one plugin with `/plugin-install name@marketplace`. Installation shows the exact curated
skills and source commit before confirmation.

Installed subscriptions are checked asynchronously on every interactive Pi startup. Updates are
validated into immutable, Pi-owned cache versions, promoted atomically, and activated only after
`/reload` or restart; the previous loaded tree remains intact. The first TUI session loading a
new version shows a generated changelog once, including added, modified, and removed skills.
Offline and failed checks retain the last valid cache, concurrent Pi sessions share locks, and
plugins that declare Claude commands, agents, hooks, MCP/LSP servers, binaries, or other
non-skill components fail closed rather than being partially installed.

Commands: `/marketplace`, `/plugin-install`, `/plugin-update`, `/plugin-list`, `/plugin-rollback`,
`/plugin-remove`, and `/plugin-pause`. State lives under `~/.pi/agent/claude-plugins/` (or Pi's configured agent
directory). Design and primary-source research are in
[`docs/plans/claude-plugin-receiver.md`](docs/plans/claude-plugin-receiver.md) and
[`docs/research/claude-code-plugin-receiver.md`](docs/research/claude-code-plugin-receiver.md).

### `extensions/subagents` + `skills/subagents`

Runs up to 16 background agents through Pi, Claude Code, or Codex while the parent keeps
working. The extension provides tools to spawn, check, list, wait for, and cancel children;
completed results return automatically as follow-up messages. `/subagents` opens an interactive
picker and takeover view. `/btw` runs a one-off side question seeded with the parent's current,
compaction-aware active branch, including prior tool calls and results. The copied history is
stored in the child session for takeover and later resume, but the child's answer stays out of the
parent model's context. If `/btw` is opened while the parent is streaming, the snapshot includes
only messages persisted when the command starts.

The companion skill teaches the model when and how to delegate, including the requirement that
each child receive a self-contained prompt. Provider billing routes are isolated: Pi children
inherit the parent model and may select only models under that exact provider ID; Claude Code is
available only to `anthropic` parents; Codex CLI is available only to `openai-codex` parents.
Cross-provider spawns fail closed. Claude and Codex children also require their respective
CLI/SDK authentication.

Vendored from
[davis7dotsh/my-pi-setup](https://github.com/davis7dotsh/my-pi-setup/tree/2657bae/extensions/subagents)
at upstream commit `2657bae`, together with its `tool-call-timeout` helper and runtime dependencies.
The matching
[subagents skill](https://github.com/davis7dotsh/my-pi-setup/tree/2657bae/skills/subagents)
is included unchanged.

### `extensions/self-compact`

Lets a long-running agent manage its own context window. Three thresholds track usage: a notice
line, a warning line, and a hard cutoff. Crossing the notice or warning line sends the model a
transient guidance message on the next request without persisting it in the transcript. At the
hard cutoff every tool except the enabled self-compaction tool and `view_context` is blocked until
the agent compacts.

The agent compacts by calling the enabled self-compaction tool (`self_compact` by default, or
`self_compact_experimental` when the A/B experiment below is enabled) with a `note_to_self`. The
note is saved, the run
ends, and Pi compacts once the agent is idle using this extension's compaction prompt. The note is
returned to the agent byte for byte as the next message, so it resumes from its own `NEXT ACTION`
without a new user prompt. `view_context` returns the current tokens, percent, level, and resolved
thresholds as JSON. `/self-compact-now` asks the agent to compact immediately and reuses a saved
note on retry; `/self-compact-info` prints settings, thresholds, usage, state, and prompt sources
without an LLM turn.

The TUI footer bar is off by default, because this package also ships `extensions/usage-footer`,
which owns the footer. Pass `--compact-footer` to replace it with the self-compact context bar for a
session.

Defaults are fixed token counts derived from a nominal 1,000,000-token baseline, not percentages
of the active model's window, so the notice and warning lines stay put when the model changes.

| line | tokens | baseline share | flag |
| --- | --- | --- | --- |
| notice | 100,000 | 10% | `--compact-soft-at 100000` |
| warning | 200,000 | 20% | `--compact-at 200000` |
| hard cutoff | warning + buffer, capped at 90% of the actual window | 30% before the cap | `--compact-buffer 100000` |

The forced line is `min(warning + buffer, 0.9 * contextWindow)`. `openai-codex/gpt-6-astra`
reports a 272,000-token window, so its thresholds resolve to 100,000 / 200,000 / 244,800. This
extension cancels Pi's automatic compaction, overflow recovery included, and replaces it with the
note handoff, so the 90% cap is headroom rather than a safety net: it keeps the forced line at
least 10% below the window, which leaves room for the note and the summarizer call, but a turn that
outgrows the window before the agent compacts, a large tool result for example, gets no automatic
recovery and Pi fails that request. That is the upstream trade: the note is guaranteed to exist
before the context is discarded. On a window too small for the fixed defaults, defaulted
fields are clamped down and reported in `/self-compact-info`; an explicit flag that violates the
ordering or the cap is rejected and leaves the extension inert with every tool blocked. Clamping is
per field, so setting one flag does not disable clamping for the others.

#### Compaction mode: `self_compact` (control) vs `self_compact_experimental` (experiment)

The extension ships two self-compaction tools that share the entire engine (thresholds, forced
lock, note handoff, persisted state) and differ only in the prompt the agent sees. Variant A is the
existing `self_compact` tool and is the default control. Variant B is
`self_compact_experimental`, and its tool description, prompt snippet, guidelines, note parameter,
and threshold messages use the exact wording requested for the experiment:

> if the current context contains many tool calls, compact your own context and turn them into
> summaries of what our overall goal is, what we are currently working on, and what steps we've been
> through including summaries of failures and possible next paths. Leave a message for yourself for
> what to prioritize next.

`/self-compact-mode` picks the mode for the current session with a picker (`Control`,
`Experimental`, `Off`). Arguments skip the picker, which is what scripts and noninteractive runs
use: `/self-compact-mode experimental`, `/self-compact-mode control`, `/self-compact-mode off`
(`a`, `b`, and `none` are accepted aliases). The choice is stored as a durable entry in that
session only, so two Pi sessions can run different arms side by side and a resumed session keeps
its arm. New sessions start on Control. The command makes no model turn.

Both tools are registered at load, because registration is not exposure: exactly one variant is
active at a time, and Pi renders prompt snippets, guidelines, and tool descriptions from active
tools only. The extension reads `pi.getActiveTools()` and targets the enabled variant in the
system-prompt line, threshold messages, forced-lock errors, and commands, so the inactive arm never
appears in a request.

| mode | what the session runs |
| --- | --- |
| `Control` (default) | `self_compact` only |
| `Experimental` | `self_compact_experimental` only |
| `Off` | neither; Pi's automatic compaction is left alone and no tool is ever locked |

A session that saves a note and then switches to `Off` is refused until the handoff settles, so a
saved note is never stranded; resuming a session whose mode is `Off` while a note is pending falls
back to a compaction-capable mode instead.

One flag still bootstraps a new session you do not want to switch by hand: `--compact-experimental`
starts it on the Experimental mode and persists that choice like a picker switch. `--tools` and
`--exclude-tools` stay Pi's hard filters, and they win. A switch that Pi refuses is transactional:
the previous variant keeps running with every unrelated tool, the refusal is reported, and nothing
is persisted. A saved mode that Pi refuses at startup leaves the session passive instead, reported
in `/self-compact-info` and in a warning, rather than pretending the mode is live. `--tools` is a
strict allowlist across *all* tools, so `--exclude-tools` is the cleaner filter for one variant.

Read-only `view_context` stays registered in every mode, `Off` included, because it changes nothing.
`/self-compact-info` reports the mode, its source (picker, saved entry, or CLI bootstrap), and
whether the selection is blocked; `/self-compact-now` targets the enabled variant and refuses when
the mode is `Off`. Variant A keeps reading the vendored, user-overridable prompt files under
`.pi/self-compact/`; variant B always uses the experimental wording, so those overrides only affect
A.

Pi subagents are outside the experiment. A child session is built with
`createAgentSession({ excludeTools: CHILD_EXCLUDED_TOOL_NAMES })` in
`extensions/subagents/src/backends/pi.ts` and inherits neither the parent's CLI flags nor its mode
entry, so `--compact-experimental` and a parent's Experimental mode never reach a child. Every
child therefore runs variant A and B stays inactive there; `--tools` and `--exclude-tools` are not
forwarded either. Per-child variant selection is not available today. The only lever in the
subagents source is `CHILD_EXCLUDED_TOOL_NAMES`, which can turn self-compaction off inside children
by excluding `self_compact`, but cannot select variant B. Pi's `ExtensionRunner` exposes
`getFlagValues()` and `setFlagValue()` if that forwarding is ever wired up.

Vendored from
[disler/self-compact-pi-agent](https://github.com/disler/self-compact-pi-agent/tree/576fe4abda021849f5cde5b6f5796467ffa4bcbd)
at upstream commit `576fe4a` (MIT, Copyright (c) 2026 IndyDevDan). Local changes: fixed-baseline
token defaults, per-field clamping, the default prompt files moved to
`extensions/self-compact/prompts/`, the entry renamed to `index.ts`, the footer bar gated
behind `--compact-footer`, and the A/B experiment with its per-session mode selector
(`variants.ts`, `state.ts`, `/self-compact-mode`). The upstream sample app,
verification scripts, and e2e tests are not vendored; that detail and the full change list live in
[`extensions/self-compact/UPSTREAM.md`](extensions/self-compact/UPSTREAM.md). Tests run with
`npm run test:self-compact`.

### `extensions/workflows`

Runs model-authored, multi-phase Pi-agent pipelines through one `workflow` tool. A restricted
JavaScript orchestration script can sequence phases, fan out up to 16 isolated agents in
parallel, make up to 128 agent calls, require schema-validated results, select a model or
thinking level per agent, and aggregate the outputs. Use it only when explicitly requesting a workflow or saying
`ultracode`; ordinary one-off delegation should continue to use the subagent tools.

Runs can block with live progress or continue in the background. `/workflows` opens a dashboard
for run status, per-agent transcripts, timing, context utilization, token cost, and report
export. Bounded artifacts are stored under `~/.pi/agent/workflows/<runId>/`. Workflow scripts
cannot access files, the network, imports, timers, or process APIs, although their trusted child
agents retain normal Pi tools. Parallel phases should therefore investigate and return
structured findings; use a single later agent for file mutations.

Vendored from
[davis7dotsh/my-pi-setup](https://github.com/davis7dotsh/my-pi-setup/tree/4a37b7830bda00d4a7e861218f70e70097ddf2e8/extensions/workflows)
at upstream commit `4a37b78`, together with its shared child-session, activity-status, and
context-utilization helpers. One local fix keeps the first-response watchdog timer referenced
until it settles; upstream's unreferenced timer allows Node 22's test runner to exit before the
watchdog fires. `acorn` is required at runtime to parse workflow metadata without evaluating it.

## `scripts/update-agent-browser.sh`

Lockstep updater for browser automation. Keeps us current on upstream without
letting the two halves drift apart.

```bash
./scripts/update-agent-browser.sh --check   # report only
./scripts/update-agent-browser.sh           # update both, verify, roll back on failure
```

Browser automation is **two packages in two different package managers**:

| Component | Role | Lives in |
|---|---|---|
| `pi-agent-browser-native` | pi extension, exposes the `agent_browser` tool | `~/.pi/agent/npm/` (pi package) |
| `agent-browser` | the actual headless browser engine (`vercel-labs/agent-browser`) | global npm, `~/.local/bin` |

Each wrapper release targets **one exact** upstream version and explicitly ships no
backwards-compatibility shims. Current pair: wrapper **0.3.0** + upstream **0.33.2**.

Two consequences:

- **`pi update` cannot do this job.** It knows nothing about the global `agent-browser`
  binary, so it moves the wrapper alone and breaks the pair.
- **Don't install upstream `@latest`.** At time of writing latest was 0.34.0, which the
  wrapper rejects outright. The wrapper's own
  `scripts/agent-browser-capability-baseline.mjs` (`CAPABILITY_BASELINE.targetVersion`)
  is the source of truth; the script reads it rather than guessing.

The wrapper is therefore **pinned** in `settings.json` (`npm:pi-agent-browser-native@0.3.0`).
Pinned specs are skipped by `pi update --extensions`, which is deliberate — updates go
through this script so both halves move together and get verified before being kept.

The script installs the wrapper, reads its new baseline, installs the matching upstream,
runs the wrapper doctor, and **rolls both back** if the doctor fails.

### Gotcha: a repo-local `pi` shadows the real CLI

`pi-agent-browser-doctor` shells out to `pi` and enforces a minimum version. Both
`npm run` and `npm exec` prepend `node_modules/.bin` to `PATH`, so a repo with its own
pinned pi wins over the installed CLI and the doctor reports a false
"Pi 0.84.0 or newer is required".

This is not hypothetical — the installed CLI is 0.84.2, but:

| Repo | Local `node_modules/.bin/pi` |
|---|---|
| `mical-pi` (this one) | 0.82.1 |
| `~/Coding/Linny` | 0.81.1 |

`cd $HOME` does **not** fix it, because the stale entry is on `PATH` before the chdir.
The script strips every `node_modules/.bin` entry from `PATH` before running the doctor.
Verified green from `mical-pi` directly, via `npm run`, from `~/Coding/Linny`, and from `$HOME`.

## Development

```bash
npm install       # pi core packages as devDeps so tsc can resolve them
npm run typecheck
npm test
```

Extensions import pi core from `peerDependencies` (`"*"`) — pi provides those at runtime,
so they must never be bundled.

Edit → `/reload` in a running pi session. No reinstall needed with the local-path install.

## Not in this repo

- `~/.pi/agent/settings.json` — mostly machine state (`lastChangelogVersion`).
  Exception worth knowing: it also holds the `packages` list and the
  `pi-agent-browser-native` version pin. Losing it loses that pin.
- `~/.pi/agent/auth.json`, `models-store.json`, `sessions/` — credentials and history. Never commit these.
- API keys and other secrets.
