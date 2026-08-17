# Claude Code Plugin Receiver for Pi — Plan

## Decision

Build a **skills-only Claude marketplace compatibility module** for Pi, first as an extension here and then propose the proven seam upstream to Pi.

Do not reverse engineer Claude Code's private cache. Anthropic now publicly documents marketplace/plugin manifests, source types, version precedence, cache behavior, and auto-updates. Implement that documented interface independently. Reject executable Claude-only components until Pi has explicit compatibility and trust semantics for them.

See [`../research/claude-code-plugin-receiver.md`](../research/claude-code-plugin-receiver.md) for the primary-source research.

## Why the existing mechanisms are not enough

### Weekly subtree sync

`.github/workflows/sync-external-skills.yml` copies selected skills into this repository and opens weekly PRs. It is reviewable but delayed, duplicates source, requires merges, and does not automatically include new promoted skills.

### Installing Matt's repository as a Pi git package

Pi can install unpinned git packages, detect upstream changes, and update with `pi update --extensions`. But direct installation is semantically wrong:

- Matt's Claude manifest selects 25 promoted skills.
- The repository currently contains 35 `SKILL.md` files, including intentionally excluded `in-progress` and `misc` buckets.
- It has no Pi manifest, so Pi's conventional recursive discovery would load all 35.
- A static Pi filter could list today's promoted paths but would not learn about newly promoted skills.
- Pi notifies about package updates rather than applying them automatically.

### `npx skills update`

Vercel's open-source Skills CLI supports cross-agent installation, lock files, and explicit updates. Matt describes this as the editable-copy workflow. It is a valuable implementation reference and fallback, but it deliberately copies files and requires a command; it does not provide managed read-only subscriptions.

## Compatibility scope

### MVP

- Marketplace sources: GitHub shorthand and public HTTPS git URLs.
- Plugin sources: relative path, `github`, `url`, and `git-subdir`.
- Components: portable `skills` only. Claude `commands` are inventoried and rejected rather than translated.
- Manifest behavior: `.claude-plugin/marketplace.json`, `.claude-plugin/plugin.json`, strict mode, and relevant marketplace overlays. For safety and publisher curation, any explicit `skills` list is treated as a complete allowlist across both direct and reviewed channels; the receiver never broadens it with conventional recursive discovery. This conservative rule matches Matt's observed 25-skill installations even though Anthropic's generic path-rule documentation describes additive discovery outside its source-root exception.
- Version precedence matching Anthropic:
  1. plugin manifest `version`;
  2. marketplace entry `version`;
  3. resolved git commit SHA.
- User-scope installation.
- Automatic update checks for every installed subscription on every Pi startup, plus manual operations.
- Pi-owned immutable version cache and provenance lock.
- Running sessions remain on their loaded version until `/reload` or restart.
- A generated changelog is shown exactly once, the first time a newly installed plugin version is actually loaded into a TUI session.

### Explicitly unsupported in MVP

- Claude agents, hooks, MCP/LSP servers, workflows, monitors, themes, output styles, settings, channels, dependencies, and `bin` executables.
- npm and archive sources.
- project/managed scopes and private repositories.
- exact Claude namespacing semantics.

The install UI must inventory unsupported components. It must never silently execute or partially translate them.

## Deep module and seam

Put source resolution, translation, caching, provenance, updates, and safety behind one `PluginReceiver` module:

```ts
interface PluginReceiver {
  addMarketplace(source: MarketplaceSource): Promise<MarketplaceSummary>;
  install(id: PluginId, options?: InstallOptions): Promise<InstallResult>;
  sync(target?: PluginId | MarketplaceId): Promise<SyncResult>;
  resources(): Promise<InstalledSkillResources>;
}
```

The implementation hides:

- catalog and plugin manifest parsing;
- strict-mode merge and skill-path curation;
- source-specific fetching and SHA verification;
- effective-version calculation;
- staging, validation, and atomic cache promotion;
- install state, enablement, update locks, retries, and rollback;
- path containment and symlink policy;
- conversion to Pi resource paths.

Use internal source adapters because multiple real source forms vary. Each adapter returns a staged immutable tree plus provenance. Transport details do not cross the `PluginReceiver` seam.

Before fixing the normalized representation, compare it with OpenAI Codex's marketplace reader, xAI Grok Build, and Epiphytic's translator.

## Storage

Own state under Pi rather than reading or mutating Claude's undocumented registries:

```text
~/.pi/agent/claude-plugins/
  subscriptions.json
  marketplaces/<marketplace>/checkout/
  cache/<marketplace>/<plugin>/<resolved-version>/
  state/<marketplace>/<plugin>.json
  locks/<marketplace>.lock
```

State records source identity, effective version, resolved commit/digest, selected paths, cache path, update time, provenance, and the last version whose changelog was shown.

Each promoted update also stores a deterministic update receipt: previous/new version, previous/new source commit, and added, removed, or modified skills. Plugin manifests have no standard changelog field, so this generated receipt is authoritative; a publisher `CHANGELOG.md` may be linked as supplementary information but is never required.

Never mutate an active version directory. Fetch into a temporary sibling, validate, atomically rename, then atomically switch state. Retain at least one previous version for rollback and active older sessions.

## Pi extension integration

Create `extensions/claude-plugin-receiver/`:

- `resources_discover`: expose enabled skill paths from selected immutable versions.
- `/marketplace add|list|remove|update`: manage catalogs.
- `/plugin-install`, `/plugin-list`, `/plugin-update`, `/plugin-remove`: manage subscriptions without claiming a future Pi `/plugin` namespace.
- `session_start`: immediately start one non-blocking update check for every installed subscription.
- `session_shutdown`: cancel update work and release owned resources.

The extension factory performs no network work, so it cannot delay Pi initialization. As soon as `session_start` fires, the receiver checks remote state in the background while Pi remains usable. After an update, notify the user that a new version is staged and offer `/reload`; never switch resources during an active turn. On the next reload/startup, append a TUI-only changelog card and atomically mark that version as shown. Headless child sessions must neither display nor consume pending changelogs.

### Startup-update invariant

An installed subscription means “keep this plugin current.” There is no separate auto-update switch in the normal flow:

- every Pi startup checks every installed subscription against its configured release channel;
- the check never blocks the editor or model startup;
- adding a marketplace alone does not subscribe to every plugin—automatic updates begin only after explicit plugin installation;
- `PI_OFFLINE` skips network access and loads the last valid cache;
- an optional per-plugin pause setting exists as an escape hatch, but the default is always-on;
- concurrent Pi sessions collapse to one updater through a cross-process lock;
- failures retain the last valid version and are recorded for `/plugin-list`, without repeated noisy notifications;
- state records `lastAttemptAt`, `lastSuccessfulCheckAt`, `lastUpdateAt`, remote provenance, the latest bounded error, and changelog acknowledgement;
- a manual `/plugin-update` bypasses retry backoff but not validation or integrity checks.

Long term, move this into Pi's package manager or add a package-source adapter seam. A permanent second package manager would duplicate Pi's existing install, trust, filtering, update, and provenance machinery.

## Update algorithm

1. Start asynchronously as soon as `session_start` fires; do not block Pi startup.
2. Acquire a cross-process marketplace lock. If another Pi process owns it, observe its resulting state rather than performing duplicate network work.
3. Refresh the catalog and remote source metadata. Use conditional requests or lightweight remote-ref checks where supported, but perform a real freshness check on every startup.
4. Resolve each enabled plugin source and effective version.
5. Skip unchanged effective versions.
6. Fetch into a bounded temporary directory.
7. Validate JSON, declared paths, skill frontmatter, containment, pins, and size/file-count limits.
8. Inventory unsupported/executable components. Fail closed if a previously skill-only plugin begins declaring executable behavior.
9. Atomically promote cache and state.
10. Persist an update receipt by hashing the selected skill trees and classifying added, removed, and modified skills.
11. Notify; activate only on reload/next launch.
12. On the first TUI session that loads the new version, show its changelog card once and persist acknowledgement. Print/RPC child sessions do not consume it.
13. Retain rollback data and garbage-collect older orphaned versions later.

Honor publisher version gates exactly: when `plugin.json` declares a version, a content-only commit does not update users until that version changes. Always retain source SHA as provenance.

## Security invariants

- Treat Markdown skill updates as supply-chain updates, not harmless content refreshes.
- No normalized path or symlink may escape the staged plugin/marketplace root.
- Never execute fetched scripts, hooks, package lifecycle scripts, or binaries in MVP.
- Spawn git with argument arrays, never shell interpolation.
- Bound network time, bytes, extracted bytes, and file count.
- Verify SHA/digest pins before promotion.
- Keep credentials out of URLs, logs, state, and model context.
- Explicit plugin installation is the subscription consent; installed skill plugins update automatically on every startup unless individually paused.
- Background updates retain rollback data and notify clearly.
- Require renewed consent before any future release enables executable component classes.

## Matt Pocock pilot

Pilot both channels explicitly:

1. **Reviewed channel:** Anthropic's official marketplace entry, whose source is SHA-pinned and updates after Anthropic advances the pin.
2. **Direct channel:** Matt's repository marketplace, whose explicit plugin version is the release gate.

Acceptance criteria:

- plugin `mattpocock-skills` installs;
- exactly the 25 manifest-selected skills load;
- excluded `in-progress`, `misc`, and other non-promoted buckets do not load;
- an upstream version bump is detected and staged;
- the current session stays on the old immutable version;
- `/reload` activates the new version;
- update failure leaves the prior version usable;
- the first session loading a new version shows one generated changelog, and later sessions do not repeat it;
- provenance clearly identifies reviewed vs direct channel.

Pilot migration completed:

1. compared the vendored copies and found no intentional working-tree modifications;
2. installed `mattpocock-skills@claude-plugins-official` version `1.2.3` with exactly 25 curated skills;
3. removed Matt's entries from `.github/skill-sources.json` and deleted the vendored `skills/<name>` copies;
4. retained the existing workflow for unrelated standalone sources;
5. rollback now uses the receiver's previous immutable cached version rather than a git-vendored fallback.

## Test strategy

Test through `PluginReceiver` using local bare git repositories and fixtures.

### Contract tests

- add/install/resources/sync/remove;
- all source adapters satisfy one staged-tree contract;
- strict-mode and marketplace-overlay precedence;
- version precedence and no-op updates;
- added/removed skill paths activate only after state switch/reload;
- direct and reviewed channels produce accurate provenance.

### Safety tests

- traversal, absolute paths, escaping symlinks, malformed JSON, duplicate IDs;
- SHA mismatch and mutable-ref races;
- excessive size/file count;
- executable components introduced by update;
- interrupted fetch, invalid new version, atomic rollback;
- changelog receipts correctly classify added/removed/modified skills and are acknowledged exactly once;
- concurrent Pi processes racing on one lock;
- private data absent from errors and persisted state.

### Pi integration tests

- resource discovery exposes only curated paths;
- current session retains old version after background update;
- reload selects new version and displays its TUI-only changelog once;
- headless child sessions do not consume pending changelogs;
- collisions are deterministic and visible;
- offline startup uses the last valid cache.

## Delivery phases

### Phase 0 — disposable baseline

Install Matt as a filtered, unpinned Pi git package in a disposable agent directory. Confirm resource filtering and update notifications. This validates assumptions but is not the final solution.

### Phase 1 — read-only translator

Implement schemas, normalized representation, strict-mode composition, curation, inventory, and `resources()` against local fixtures. No network.

### Phase 2 — subscription and startup updater

Add git adapters, immutable cache/state, install/remove/manual-update commands, confirmation UI, and reload activation. An installed plugin is automatically checked on every subsequent Pi startup. Include cross-process locks, atomic promotion, bounded failure state, rollback, and offline behavior from the start—automatic freshness is core behavior, not a later enhancement.

### Phase 3 — reviewed release channel

Add official-marketplace support and verify that direct and reviewed channels resolve, update, and report provenance independently.

### Phase 4 — hardening

Only as demanded: private git auth, npm/archive adapters, dependency/rename handling, project scope, richer inventory, and namespacing.

### Phase 5 — upstream Pi proposal

Open a Pi design issue before hardening this into a parallel package manager. Propose either native Claude marketplace support or a small package-source adapter seam.

## Existing work and requested input

- **OpenAI Codex** already implements a first-party Claude/Cursor marketplace reader, normalized source model, receiver-owned versioned cache, path checks, and command migration. This is the closest receiver and should be reviewed first.
- **xAI Grok Build** implements Claude compatibility with separate executable trust, full-SHA policy, containment checks, and transactional updates. Borrow those ideas, not its dependence on Claude's undocumented registry files.
- **Google Gemini CLI** has an open, bot-triaged marketplace/monorepo feature request. Coordinate around a common normalized representation.
- **Epiphytic `ai-plugin-translator`** already uses adapters, a normalized intermediate representation, provenance, and explicit unsupported-component reports. Evaluate reuse/alignment.
- **Vercel Skills CLI maintainers** already own cross-agent discovery, locks, update checks, deletion handling, and download limits. Ask whether managed subscriptions or a library resolver are planned.
- **Matt Pocock** should be asked whether downstream receivers should default to his direct release channel or Anthropic's reviewed/pinned channel.
- **Pi maintainers** should be consulted before we add a second updater/cache.

No existing Pi issue or implementation was found. Open an upstream design issue with this plan and the Matt fixture before implementation, then record responses here.

## Primary references

- [Research note with pinned citations](../research/claude-code-plugin-receiver.md)
- [Anthropic: Create plugins](https://code.claude.com/docs/en/plugins)
- [Anthropic: Plugin marketplaces](https://code.claude.com/docs/en/plugin-marketplaces)
- [Anthropic: Discover/install and auto-update](https://code.claude.com/docs/en/discover-plugins)
- [Anthropic: Plugins reference](https://code.claude.com/docs/en/plugins-reference)
- [Pi packages](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/packages.md)
- [Pi skills](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/skills.md)
- [Matt Pocock plugin ADR](https://github.com/mattpocock/skills/blob/main/.agents/adr/0002-ship-as-a-claude-code-plugin.md)
- [Vercel Skills CLI](https://github.com/vercel-labs/skills)
- [OpenAI Codex marketplace reader](https://github.com/openai/codex/blob/main/codex-rs/core-plugins/src/marketplace.rs)
- [xAI Grok Build plugins guide](https://github.com/xai-org/grok-build/blob/main/crates/codegen/xai-grok-pager/docs/user-guide/09-plugins.md)
- [Gemini marketplace request](https://github.com/google-gemini/gemini-cli/issues/28428)
- [AI plugin translator](https://github.com/Epiphytic/ai-plugin-translator)
