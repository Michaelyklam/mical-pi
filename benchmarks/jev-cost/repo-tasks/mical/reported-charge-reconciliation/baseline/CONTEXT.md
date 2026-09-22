# Pi Usage Footer

The language used to describe account-aware usage and quota information in Pi's footer.

## Language

**Provider Account**:
The boundary for usage tracking, identified by a Pi provider ID plus a stable upstream account identity when one is available. Different provider IDs are always separate provider accounts even if they resolve to the same upstream identity; re-authenticating one provider ID as a different upstream account creates a different provider account. Providers without a discoverable stable identity use an explicit configured account key or, as a final fallback, the provider ID.
_Avoid_: Billing account, provider route, subscription

**Account Label**:
A user-facing name assigned to a provider account. It may override an upstream-derived organization or profile name and, for API-key or gateway providers without a stable upstream identity, also serves as that provider's stable account key across credential rotation.
_Avoid_: Provider ID, account ID

**Account Session Cost**:
The cost of requests in the current Pi session attributable to the selected provider account, including incurred usage from abandoned branches and pre-compaction history. Provider-reported and estimated-only amounts remain separate when both occur. Estimated amounts use current externally maintained pricing metadata, and router-prefixed model IDs may inherit pricing only from an exact canonical model-ID match after the router namespace is removed.
_Avoid_: Bill, total cost

**Provider-Reported Cost**:
A monetary charge reported by the upstream company's own billing or usage system. It takes precedence over locally calculated estimates.
_Avoid_: Estimated cost, list-price cost

**Estimated Cost**:
A clearly labeled monetary approximation calculated when provider-reported cost is unavailable. The extension does not own or persist unit pricing rates and uses Pi's live model registry as its pricing source; if no current external pricing exists, the estimate is unavailable rather than zero.
_Avoid_: Cost, bill, provider-reported cost

**Account-Wide Usage**:
Usage reported by the provider account's upstream service, including activity from other processes and hosts authenticated to that account.
_Avoid_: Local usage, session cost

**Local Usage**:
Usage reconstructed from transcripts available on this host for one provider account. It is an explicitly incomplete fallback when account-wide usage is unavailable and is displayed as today's tokens plus an explicitly estimated API-equivalent cost.
_Avoid_: Account-wide usage

**Allowance Window**:
A provider-native rolling or calendar period whose utilization and reset time are reported by the upstream service, such as Codex's five-hour window or Anthropic's weekly window. Account-wide allowance windows replace the former synthetic daily-dollar target when available.
_Avoid_: Today, daily cost, quota

**Usage**:
The selected provider account's available allowance-window utilization. It replaces the former Today and Quota concepts; unsupported balances are not forced into a common quota representation.
_Avoid_: Today, quota
