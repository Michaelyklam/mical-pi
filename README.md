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

Personal development skills shared between Pi and Claude Code. Pi discovers them through this package; `~/.claude/skills` points to this directory for Claude Code. Third-party skills are tracked in `.github/skill-sources.json` and checked weekly by `.github/workflows/sync-external-skills.yml`.

### `extensions/fast-mode`

Adds `/fast [on|off|status]` for GPT-5.6 requests through the OpenAI and OpenAI Codex providers. When enabled, outgoing requests include `service_tier: "priority"` (OpenAI's backward-compatible name for Fast mode); a `⚡ fast` footer status indicates that requests for the selected model are being marked Fast. The setting is retained in the current session and defaults off in new sessions.

Fast mode uses the same model with accelerated API processing and premium token pricing. OpenAI guarantees the tier on its pay-as-you-go API; the ChatGPT OAuth backend may ignore or downgrade it.

### `extensions/usage-footer`

Replaces Pi's built-in footer with an account-aware model, cost, and allowance display:

```
Model: openai-codex/gpt-5.6-sol · personal | Ctx: 72.5k | ⎇ main | (+12,-4)
Est: ~$0.33 | Usage: 5h ██░░░ 43% · 7d █░░░░ 18%
```

A **Provider Account** is a Pi provider plus its stable upstream account identity. Different
provider IDs remain separate even when they share a gateway. OAuth accounts are detected from
upstream profile/claims; API-key and gateway accounts receive user labels at startup so key
rotation does not fragment their history.

- Session cost follows the selected Provider Account and includes all incurred branches.
- Provider-reported cost and Pi-registry estimates remain visibly separate.
- Router aliases inherit estimate pricing only from an unambiguous exact canonical model ID.
- Anthropic usage comes from the selected account's OAuth profile/usage endpoints.
- Codex usage comes from its account app-server protocol using Pi's selected OAuth token,
  including account-wide daily tokens from other hosts.
- Unsupported providers fall back to clearly labeled local-today tokens and estimates.
- Failed account-wide data is marked stale for up to 30 minutes before local fallback.
- Responsive rendering preserves provider/account identity and the most constrained Usage
  window before coding-context or cost details.

The extension follows Pi's theme and keeps `(+N,-M)` from staged plus unstaged Git shortstat.
`/statusline` toggles the footer. `/usage` opens the interactive account dashboard; it can
refresh, rename, archive, inspect, and switch Provider Accounts. `/account-label` quickly
renames the active account.

`codex` is required for account-wide Codex subscription data. `ccusage` is optional and only
augments local fallback with matching native Claude/Codex transcripts. Neither `ccstatusline`,
`jq`, nor the old `ccstatusline-today-vs-budget` helper is required.

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

**Auth is optional.** With no key it uses Firecrawl's documented keyless free tier
(rate-limited). That tier is sanctioned only for official Firecrawl clients, which is why
this uses the `firecrawl` SDK rather than hand-rolled `fetch` — undocumented keyless REST
could be gated at any time. For higher limits, get a key from
[firecrawl.dev](https://www.firecrawl.dev/signin) and export it:

```bash
export FIRECRAWL_API_KEY=fc-...   # in ~/.zshrc, NOT in this repo
```

The key is read per call, so exporting it and running `/reload` upgrades a live session off
the keyless tier. A `429` while keyless says so explicitly and points at signup.

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

### `extensions/subagents` + `skills/subagents`

Runs up to four background agents through Pi, Claude Code, or Codex while the parent keeps
working. The extension provides tools to spawn, check, list, wait for, and cancel children;
completed results return automatically as follow-up messages. `/subagents` opens an interactive
picker and takeover view, while `/btw` runs a one-off side question without adding its answer to
the parent model's context.

The companion skill teaches the model when and how to delegate, including the requirement that
each child receive a self-contained prompt. Pi children inherit the parent model and thinking
level by default. Claude and Codex children require their respective CLI/SDK authentication.

Vendored from
[davis7dotsh/my-pi-setup](https://github.com/davis7dotsh/my-pi-setup/tree/2657bae/extensions/subagents)
at upstream commit `2657bae`, together with its `tool-call-timeout` helper and runtime dependencies.
The matching
[subagents skill](https://github.com/davis7dotsh/my-pi-setup/tree/2657bae/skills/subagents)
is included unchanged.

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
- `~/.pi/agent/auth.json`, `models-store.json`, `sessions/` — credentials and history. Never commit these.
- API keys and other secrets.
