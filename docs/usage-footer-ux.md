# Account-aware usage footer UX

## Footer

The footer remains two lines and follows Pi's active theme rather than using the legacy hard-coded ccstatusline ANSI palette.

```text
Model: openai-codex/gpt-5.6-sol · personal | Ctx: 72.5k | ⎇ main | (+12,-4)
Est: ~$0.33 | Usage: 5h ██░░░ 43% · 7d █░░░░ 18%
```

Provider, model, and friendly account label are always shown when space permits. On very narrow terminals, preserve provider and account while truncating the model:

```text
openai-codex/… · personal
7d ████░ 91%
```

### Cost states

Hide zero-valued session cost. Provider-reported and estimated amounts remain visually distinct:

```text
Cost: $3.20 + Est: ~$0.80
```

Reported cost uses normal text. Estimates are dim and carry `~`. If attributable usage exists but no current pricing source is available, show `Est: n/a`.

### Usage states

Show the provider-native short and long primary allowance windows as five-cell Unicode progress bars with percentage used:

```text
Usage: 5h ██░░░ 43% · 7d █░░░░ 18%
```

Use Pi theme roles to color each window: success below 70%, warning from 70% through 89%, and error at 90% or above. Color changes do not trigger notifications.

Retain a failed account-wide reading for up to 30 minutes, dimmed and marked stale:

```text
Usage: 5h ██░░░ 43% · 7d █░░░░ 18% (stale)
```

After 30 minutes, use the explicitly local fallback:

```text
Usage (local today): 8.4M tok · ~$12.30 est
```

The local label alone communicates degraded scope; endpoint errors stay in `/usage`.

### Responsive priority

Preserve account/model identity and Usage longest. As width shrinks, remove git diff, branch, context, and cost detail before truncating identity or allowance status. If only one allowance window fits, show the most utilized window.

## Account labels

At startup, one compact wizard lists every configured unlabeled account with upstream-derived suggestions where available. Users edit labels inline and save the batch. Dismissing the wizard never blocks Pi: temporary upstream/provider labels are used, and the wizard appears again next startup.

Gateway and API-key accounts without a stable upstream identity require a nonblank label before saving because the label also stabilizes identity across key rotation. Labels must be unique within a provider but may repeat across different providers.

If a new account appears after startup, show a one-account labeling prompt on first selection. When an API-key fingerprint changes for a provider with existing labeled accounts, the wizard asks whether the key replaces credentials for an existing account or belongs to a new account. Choosing an existing label preserves its history; creating a new account requires a new provider-unique label. Labels can later be changed through `/usage` or `/account-label`.

## `/usage` dashboard

`/usage` opens as a centered overlay on normal terminals and falls back to a full replacement UI when narrow. Wide layouts show an account list on the left and details on the right; narrow layouts use list-then-detail navigation.

Accounts are ordered with the active account first, then alphabetically by label. Previously seen unauthenticated accounts remain visible as inactive and may be archived.

```text
┌ Usage ──────────────────────────────────────────────────────────┐
│ Accounts                    │ personal                           │
│ > personal          Live    │ openai-codex · active              │
│   Verkada Eng       Live    │ Source: OpenAI account usage       │
│   Verkada gateway   Local   │ Refreshed 18s ago                  │
│   old-personal      Inactive│                                    │
│                             │ Allowance windows                  │
│                             │ 5h  ██░░░ 43%                      │
│                             │     resets in 2h 14m (3:30 PM)     │
│                             │ 7d  █░░░░ 18%                      │
│                             │     resets in 4d 6h (Mon 9:00 AM)  │
│                             │                                    │
│                             │ Current session                    │
│                             │ Reported cost: —                   │
│                             │ Estimated cost: ~$0.33             │
│                             │ Pricing: Pi registry, exact model  │
│                             │                                    │
│                             │ Account today                      │
│                             │ 8.4M tokens · provider reported    │
│                             │                                    │
│                             │ Attribution                        │
│                             │ 31 attributed · 2 excluded         │
│                             │ Last error: none                   │
│                             │                                    │
│ ↑↓ account  r refresh  e rename  u use  a archive  esc close    │
└─────────────────────────────────────────────────────────────────┘
```

Reset times include both relative duration and local clock time. The dashboard refreshes while open and supports:

- refresh now
- rename account
- inspect another account
- archive an inactive account
- use an account by selecting one of its models
- authenticate an inactive account before model selection
- inspect data source, cache age, errors, pricing source, and excluded unattributed usage

When the provider reports account-wide daily tokens, the dashboard labels them **Account today**. Otherwise it shows **Local today** with tokens and estimated cost. Daily tokens do not join allowance windows in the footer.

Browsing accounts never changes the active model. `Use account…` is an explicit action.
