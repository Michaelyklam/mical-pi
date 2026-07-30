# Account-aware usage footer implementation plan

## Goal

Replace the Claude-specific `ccstatusline-footer` implementation with an account-aware usage footer. The selected Provider Account controls identity, session cost, account-wide allowance windows, local fallback usage, and the `/usage` dashboard.

The implementation follows [the domain language](../../CONTEXT.md), [the UX design](../usage-footer-ux.md), [ADR 0001](../adr/0001-identify-provider-accounts.md), and [ADR 0002](../adr/0002-separate-reported-and-estimated-cost.md).

## Verified integration facts

- `ctx.modelRegistry.getProviderAuth(providerId)` resolves the selected provider's current request authentication without reading secrets from `auth.json` directly.
- OpenAI OAuth access tokens contain stable ChatGPT account and profile claims.
- Anthropic OAuth supports:
  - `GET https://api.anthropic.com/api/oauth/profile` for stable account/organization identity and a suggested label.
  - `GET https://api.anthropic.com/api/oauth/usage` for account-wide rolling windows and spend-control usage.
- The installed Codex app-server supports:
  - `account/read`
  - `account/rateLimits/read`
  - `account/usage/read`
  - external `chatgptAuthTokens` login with Pi's selected access token and ChatGPT account ID.
- Codex `account/usage/read` returns account-wide daily token buckets, including other hosts.
- `ccusage daily --json --by-agent` returns separate native `claude`, `codex`, and `pi` token/model breakdowns. Its Pi bucket lacks provider-account identity and must not be used for provider-aware totals.
- Pi assistant messages store provider, model, token usage, and calculated cost. Compaction, branch-summary, and tool-result usage do not store provider identity.
- Footer rendering is synchronous; all network, subprocess, filesystem scanning, and pricing resolution must feed cached view models.

## Module design

Rename `extensions/ccstatusline-footer/` to `extensions/usage-footer/`. Keep `/statusline` as a compatibility command.

```text
extensions/usage-footer/
├── index.ts
├── domain.ts
├── account-catalog.ts
├── persistence.ts
├── pricing.ts
├── session-ledger.ts
├── local-usage.ts
├── usage-monitor.ts
├── adapters/
│   ├── anthropic.ts
│   └── codex.ts
├── ui/
│   ├── footer.ts
│   ├── usage-dashboard.ts
│   └── account-wizard.ts
└── *.test.ts
```

### Account Catalog module

The Account Catalog is the deep module responsible for account discovery, identity, labels, credential rotation, inactivity, archival, and legacy mappings.

Its interface should remain small:

```ts
interface AccountCatalog {
  discover(): Promise<AccountDiscovery>;
  resolve(providerId: string): Promise<ProviderAccount>;
  apply(decision: AccountDecision): Promise<void>;
  list(): readonly ProviderAccount[];
}
```

The implementation hides OAuth claim decoding, Anthropic profile lookup, API-key fingerprinting, label uniqueness, migration, and persistence.

Identity rules:

1. OAuth: `providerId + stable upstream account identity`.
2. API key/gateway: `providerId + user-selected account label`.
3. Different provider IDs are always different Provider Accounts.
4. Store only a non-reversible SHA-256 credential fingerprint for detecting key changes; never store raw keys.
5. A changed key requires a decision: replace credentials for an existing labeled account or create a new account.
6. Friendly labels are unique within a provider.
7. Legacy provider-only history maps once to the account configured during migration.

### Usage Monitor module

The Usage Monitor owns refresh scheduling, shared snapshots, freshness, stale behavior, and local fallback selection.

```ts
interface UsageMonitor {
  start(onChange: () => void): Promise<void>;
  stop(): Promise<void>;
  get(accountKey: AccountKey): AccountUsageView;
  refresh(accountKey: AccountKey, options?: { force?: boolean }): Promise<void>;
}
```

Provider adapters are internal seams because Anthropic, Codex, and test adapters genuinely vary. Each adapter returns normalized provider-native data:

```ts
interface ProviderUsageSnapshot {
  fetchedAt: number;
  sourceLabel: string;
  windows: AllowanceWindow[];
  accountTodayTokens?: number;
  accountSpend?: MoneyObservation;
  diagnostics?: Record<string, unknown>;
}
```

Freshness rules:

- Shared refresh TTL: 60 seconds.
- Keep the latest successful account-wide snapshot after failures.
- Mark it stale immediately after a failed refresh.
- After 30 minutes without success, use Local Usage.
- A window whose reset time has passed is invalid even if the snapshot is younger than 30 minutes.
- `/usage` can force refresh and displays sanitized errors and cache age.

### Session Ledger module

The Session Ledger attributes all incurred usage in the current session, including abandoned branches and pre-compaction history.

```ts
interface SessionLedger {
  record(targetEntryId: string, account: ProviderAccount, kind: AttributionKind): void;
  summarize(entries: readonly SessionEntry[], account: ProviderAccount): SessionCostSummary;
}
```

Persist custom entries containing only target entry ID, Provider Account key, provider/model identity, attribution kind, and timestamp. Do not persist prices or calculated estimates.

Attribution rules:

- Assistant messages: record the resolved Provider Account at message completion.
- Compactions: record the selected Provider Account in `session_compact`.
- Branch summaries: record the selected Provider Account in `session_tree` when a summary entry exists.
- Tool-result usage: exclude unless a future tool explicitly supplies provider-account attribution.
- Legacy entries without records: use the persisted provider-to-current-account migration mapping.
- New unattributable entries: exclude and report their count in `/usage`.

### Pricing module

Pricing calculates estimates from current registry metadata and owns no pricing table.

```ts
interface PricingResolver {
  estimate(providerId: string, modelId: string, usage: Usage): CostEstimate | undefined;
}
```

Resolution order:

1. Use the exact selected registry model if it has nonzero rates.
2. For zero-priced router models, remove the router namespace and find exact canonical model-ID matches in the live registry.
3. Accept canonical pricing only when all matching nonzero schedules agree; ambiguity returns unavailable.
4. Apply Pi's request-wide pricing tiers using total input usage.
5. No fuzzy family matching.
6. No persisted unit rates.
7. Recalculate estimates from stored token usage so registry updates correct old estimates.

Provider-reported per-request monetary charges, when a provider eventually exposes them, remain a separate `reported` amount. Do not treat account-wide spend deltas as session charges because concurrent hosts make that attribution unsound.

## Provider adapters

### Anthropic adapter

1. Resolve the selected provider authentication through `ModelRegistry`.
2. Call `/api/oauth/profile` to obtain stable account and organization UUIDs plus suggested organization/profile labels.
3. Call `/api/oauth/usage` with a short timeout and abort support.
4. Normalize `five_hour` and `seven_day` into short/long windows when present.
5. If rolling windows are absent but spend control is enabled, normalize `spend.percent` or extra-usage monthly utilization as a long provider-native Usage window rather than reviving a separate Quota field.
6. Preserve account-wide spend as dashboard diagnostics; do not call it current-session cost.
7. Sanitize all errors and never log OAuth tokens or profile email addresses by default.

### Codex adapter

Use the installed `codex app-server --stdio` protocol as an isolated adapter rather than copying private backend URLs.

1. Resolve Pi's selected OpenAI Codex access token.
2. Decode stable ChatGPT account ID, plan, and profile claims.
3. Launch a transient Codex app-server with a temporary `CODEX_HOME`.
4. Initialize with experimental protocol support.
5. Login using `chatgptAuthTokens` with Pi's access token and account ID.
6. Request `account/read`, `account/rateLimits/read`, and `account/usage/read`.
7. Normalize the main `codex` bucket's primary and secondary windows for the footer.
8. Retain named/model-specific buckets for `/usage` diagnostics.
9. Use the current date's daily bucket as account-wide Account Today tokens.
10. Terminate the subprocess and remove the temporary home on completion, timeout, or abort.
11. If `codex` is missing, incompatible, or fails, degrade through the Usage Monitor.

The shared 60-second cache ensures multiple Pi processes do not each invoke the private provider endpoint every render. Only the process holding the refresh lock performs the fetch; others consume the shared snapshot.

## Local Usage

Local Usage combines provider-attributed Pi history with matching native-client history on this host.

### Pi history

- Scan `getAgentDir()/sessions/**/*.jsonl` for the local calendar day.
- Pair usage entries with persisted account-attribution custom entries.
- Apply legacy provider mappings where needed.
- Maintain an incremental per-file cache keyed by path, size, and modification time so a 60-second refresh does not fully parse all history.
- Aggregate tokens by Provider Account and model.

### Native Claude/Codex history

- Run `ccusage daily --json --by-agent --since <local-date> --until <local-date>`.
- Ignore its `pi` bucket to avoid double counting.
- Include the `claude` bucket only when Claude Code's stable local account identity matches the selected Anthropic Provider Account.
- Include the `codex` bucket only when Codex CLI's stable local account identity matches the selected OpenAI Codex Provider Account.
- Use token/model breakdowns only; ignore ccusage's monetary totals and run them through the Pricing module.
- If native-client identity cannot be verified, exclude that client's transcripts rather than mixing accounts.

Local fallback renders today's total tokens plus estimated cost. If some models have no pricing, show known estimated cost and expose unknown-priced tokens in `/usage`; if none can be priced, render `est n/a`.

## Persistence

Use Pi's global agent directory rather than hard-coding `~/.pi`:

```text
<getAgentDir()>/usage-footer/accounts.json
<cache-dir>/mical-pi/usage-footer/snapshots.json
<cache-dir>/mical-pi/usage-footer/local-index.json
```

`accounts.json` stores schema version, account identities, labels, credential fingerprints, inactive/archived state, and legacy mappings. It contains no tokens, API keys, unit prices, or estimates.

`snapshots.json` stores timestamped provider observations and errors. `local-index.json` stores derived token aggregates and file metadata. Use versioned schemas, validation on read, atomic temp-file replacement, restrictive permissions, and a cross-process lock with stale-lock recovery.

Persisted provider-reported monetary observations are allowed; persisted pricing rates are not.

## UI implementation

### Footer

- Follow Pi theme roles.
- Build semantic segments and fit them by priority instead of truncating the completed line.
- Line 1: `provider/model · account`, context, branch, diff.
- Line 2: nonzero reported/estimated session cost and Usage.
- Five-cell Unicode progress bars.
- Success below 70%, warning at 70–89%, error at 90%+.
- Preserve account/model and Usage longest.
- If one window fits, choose the most utilized.
- Hide zero cost; show `Est: n/a` when tokens exist without pricing.
- Keep `/statusline` toggle compatibility.

### Startup account wizard

- On `session_start` with reason `startup`, discover configured unlabeled accounts and open one batch custom TUI.
- Populate suggestions from upstream organization/profile metadata.
- Require labels for API-key/gateway accounts.
- Escape uses temporary labels and asks again next startup.
- On a mid-process newly selected account, show the one-account variant.
- Key rotation offers existing-account replacement or new-account creation.

### `/usage` dashboard

- Centered overlay with full-replacement fallback on narrow terminals.
- Wide: account list plus detail pane. Narrow: list then detail.
- Active account first, then alphabetical by label.
- Show inactive historical accounts and archive management.
- Detail sections: identity/source/freshness, all provider windows and reset times, current session cost split, Account Today or Local Today, attribution/exclusions, pricing source, and last sanitized error.
- Actions: refresh, rename, use account, archive/restore, close.
- `Use account…` presents models for that provider and calls `pi.setModel()` only after explicit selection.
- For inactive accounts, prefill the appropriate built-in `/login` command and close the dashboard. Pi exposes no public callable login interface, so do not reimplement or directly manipulate credential storage. After login, the normal first-selection flow handles labeling and model choice.

### `/account-label`

Provide a lightweight command for scripting/quick edits in addition to dashboard management. Default to the active account; support selecting another known account when no label argument is supplied.

## Lifecycle wiring

`index.ts` should only compose modules and bind Pi events:

- `session_start`: create session-scoped resources, migrate legacy mappings, install footer, start monitor, and launch startup wizard when applicable.
- `model_select`: resolve the new Provider Account, refresh its usage, request render, and prompt if newly unlabeled.
- `message_end`: persist assistant-message attribution and request render.
- `session_compact`: persist compaction attribution.
- `session_tree`: persist branch-summary attribution.
- `agent_settled`: refresh local aggregates cheaply after usage changes.
- `session_shutdown`: clear timers, abort in-flight work, terminate subprocesses, release locks, and dispose UI resources.

All background resources begin at `session_start`, not extension factory load.

## Testing strategy

Add `tsx` as a development dependency and a `test` script using `tsx --test 'extensions/usage-footer/**/*.test.ts'`. Test through module interfaces.

### Account Catalog tests

- OAuth identity stability and re-login separation.
- Different provider IDs with the same upstream organization remain separate.
- API-key rotation mapped to existing versus new labels.
- Provider-local label uniqueness.
- startup-dismiss temporary labels.
- legacy provider mapping.
- no secrets written to persistence.

### Pricing tests

- selected nonzero rates.
- exact router-prefix canonical inheritance.
- no fuzzy matching.
- conflicting canonical schedules return unavailable.
- long-context tier selection.
- zero usage and partially unpriced aggregates.

### Session Ledger tests

- account-scoped assistant usage.
- all branches count as incurred usage.
- compaction and branch-summary attribution.
- legacy mapping.
- nested tool usage exclusion.
- reported and estimated amounts stay separate.

### Usage Monitor tests

- 60-second shared TTL.
- stale marker after failed refresh.
- 30-minute fallback.
- expired reset windows invalidated early.
- refresh locking and stale-lock recovery.
- one account's refresh cannot overwrite another account's view.

### Adapter fixture tests

- Anthropic profile, rolling windows, null windows, spend-control fallback, and malformed responses.
- Codex main and model-specific buckets, daily token bucket, protocol errors, timeouts, and missing binary.
- No live provider calls in the normal test suite.

### Local Usage tests

- Pi/provider/account attribution across multiple session files.
- incremental file updates.
- native client identity match/mismatch.
- exclusion of ccusage's Pi bucket.
- local-day timezone boundary.

### UI tests

- footer snapshots at wide, medium, narrow, and very narrow widths.
- semantic segment drop order.
- theme-role colors and ANSI-safe widths.
- progress rounding and thresholds.
- live/stale/local/loading/missing-price states.
- dashboard wide/narrow navigation and management actions.
- wizard save, skip, uniqueness, rotation, and mid-session flows.

Run `npm run typecheck` and the full test command before manual TUI verification.

## Delivery sequence

1. **Foundation:** rename the extension; add domain types, persistence, fixtures, and test runner.
2. **Identity:** implement Account Catalog, label persistence, legacy migration, and attribution entries.
3. **Costs:** implement Session Ledger and live-registry Pricing module; replace the old aggregate cost calculation.
4. **Usage:** implement Anthropic/Codex adapters, shared Usage Monitor, and Local Usage index.
5. **Footer:** replace Today/Quota rendering with account identity, split cost certainty, provider-native bars, and responsive priority layout.
6. **Management UI:** add startup wizard, `/usage`, `/account-label`, account switching, archive/restore, and login handoff.
7. **Hardening:** concurrency, abort/shutdown, stale cache recovery, malformed/private API behavior, and narrow-terminal tests.
8. **Documentation cleanup:** update README, remove requirements for the old `ccstatusline-today-vs-budget` and Claude-only quota cache, and document private-adapter fallback behavior.
9. **Manual verification:** exercise Anthropic Enterprise, personal Codex, `verkada`, and `verkada-anthropic`; switch accounts mid-session; rotate a test key; simulate offline/stale states; and inspect `/usage` at multiple terminal widths.

## Acceptance criteria

- Switching Provider Accounts changes session cost and Usage without leaking the previous account's state.
- Anthropic and Codex account-wide data include other-host usage where their upstream systems report it.
- `verkada` and `verkada-anthropic` remain separate accounts and fall back locally unless their own adapters are added.
- Re-authenticating the same provider as another upstream account creates a distinct account and prompts for a label.
- No unit-price constants or raw credentials are persisted by the extension.
- Reported and estimated monetary values are never silently combined.
- Old provider-only history maps to the current account; future direct and summary usage is explicitly attributed.
- Nested unattributable tool usage is excluded and visible in dashboard diagnostics.
- The footer remains useful from wide to very narrow terminals and never exceeds render width.
- Provider failures never crash rendering; stale and local scope are explicit.
