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

### `extensions/ccstatusline-footer`

Replaces pi's built-in footer with a mirror of my Claude Code statusline
([ccstatusline](https://github.com/sirmalloc/ccstatusline)):

```
Model: claude-opus-5 | Ctx: 18.6k | ⎇ main | (+69,-7)
Cost: $1.23 | Today: $80.51/$60.24 | Quota: $100.22/$1500
```

- **Model / Ctx / branch / Cost** come from pi itself (`ctx.model`, `ctx.getContextUsage()`,
  `footerData.getGitBranch()`, and a usage sum over `sessionManager.getEntries()`).
- **`(+N,-M)`** is `git diff --shortstat` + `git diff --cached --shortstat`, the same pair
  ccstatusline uses, refreshed every 5s.
- **`Today:`** shells out to `~/.local/bin/ccstatusline-today-vs-budget` (needs `ccusage` + `jq`).
- **`Quota:`** reads `~/.cache/ccstatusline/usage.json`, and every 5 min invokes `ccstatusline`
  once (stdout discarded) purely to refresh that cache — reusing its keychain OAuth flow
  instead of reimplementing the `/oauth/usage` call.

`render()` is synchronous; every slow source runs on a background timer that calls
`tui.requestRender()`. Any source that fails just drops its segment, and the whole render
is wrapped so it can never break the TUI.

Installs itself on `session_start` in TUI mode. `/statusline` toggles back to pi's built-in footer.

**Requires** `ccstatusline`, `ccusage`, `jq`, and the `~/.local/bin/ccstatusline-today-vs-budget`
script on `PATH`. Without them the two money widgets are silently omitted and the rest still works.

Knobs at the top of `index.ts`:

| Constant | Default | Meaning |
|----------|---------|---------|
| `COLOR_MODE` | `"ansi"` | `"ansi"` = byte-identical ccstatusline 256-colors; `"theme"` = follow the pi theme |
| `QUOTA_LIMIT_LABEL` | `"/$1500"` | Text after the quota figure |
| `GIT_TTL_MS` | `5000` | Git shortstat refresh |
| `TODAY_TTL_MS` | `60000` | `ccusage` refresh |
| `QUOTA_READ_TTL_MS` | `30000` | Re-read the usage cache file |
| `QUOTA_REFRESH_TTL_MS` | `300000` | Have `ccstatusline` refresh the usage cache |

Note: `Cost:` is pi's own session cost, while `Today:` / `Quota:` describe *Claude Code*
spend (ccusage over `~/.claude` transcripts + the Anthropic extra-usage balance). Pi usage
billed to an API key does not appear in those two.

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

## Development

```bash
npm install       # pi core packages as devDeps so tsc can resolve them
npm run typecheck
```

Extensions import pi core from `peerDependencies` (`"*"`) — pi provides those at runtime,
so they must never be bundled.

Edit → `/reload` in a running pi session. No reinstall needed with the local-path install.

## Not in this repo

- `~/.pi/agent/settings.json` — mostly machine state (`lastChangelogVersion`).
- `~/.pi/agent/auth.json`, `models-store.json`, `sessions/` — credentials and history. Never commit these.
- API keys and other secrets.
