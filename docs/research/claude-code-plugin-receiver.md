# Receiving Claude Code plugin marketplaces in Pi

> Research snapshot: 2026-08-11. Primary sources only. **Documented** means an official product document says it. **Source observation** means the behavior is visible in a cited repository snapshot but is not necessarily a supported contract. **Reported** means a first-party repository issue describes it; it is evidence of active work or a compatibility risk, not proof of current behavior. **Unknown** marks details that would require reverse engineering or an explicit vendor contract.

## Executive conclusion

Pi can consume the **skill payloads** in many Claude Code plugins because both products support `SKILL.md` and the Agent Skills format. Pi does **not** currently document support for `.claude-plugin/marketplace.json`, `.claude-plugin/plugin.json`, Claude's plugin IDs/scopes, source resolvers, version precedence, background updater, or cache registries. Treating a Claude marketplace as an ordinary Pi git package therefore does not reproduce the publisher's selected plugin contents or Claude's update semantics.[^pi-skills][^pi-packages]

For Matt Pocock's repository this distinction is concrete:

* his Claude manifest selects **25 explicit skill directories** and declares plugin version `1.2.3`;[^matt-plugin]
* the repository currently contains **35** `SKILL.md` files under `skills/`; ten in `in-progress/` or `misc/` are intentionally not selected by the Claude plugin;[^matt-skills-tree][^matt-adr]
* `package.json` has no `pi` manifest, so Pi's conventional recursive `skills/` discovery would expose all 35 if the repository were installed directly as a Pi git package.[^matt-package][^pi-packages]

**Recommendation:** implement a small, skills-first translation layer that resolves a marketplace entry, materializes its source into a Pi-owned cache, translates the Claude manifest's `skills` selection into Pi package skill paths, and records immutable provenance. Do not read Claude's mutable cache as Pi's source of truth, and do not silently translate hooks, MCP/LSP servers, agents, or commands until each has an explicit Pi compatibility and trust policy.

## 1. What Claude Code installs

### 1.1 Catalog and plugin are separate objects

**Documented.** Adding a marketplace registers a catalog; it installs no plugin. Installing is a second operation against a `plugin-name@marketplace-name` identifier.[^discover]

A Git-hosted marketplace conventionally has:

```text
repo/
  .claude-plugin/marketplace.json
  plugins/<plugin>/
    .claude-plugin/plugin.json       # optional, but authoritative in strict mode
    skills/<skill>/SKILL.md
    commands/*.md
    agents/*.md
    hooks/hooks.json
    .mcp.json
    .lsp.json
```

A plugin is a self-contained directory. Claude Code can discover skills, commands, agents, hooks, MCP servers, LSP servers, output styles, workflows, themes, and monitors from conventional locations or manifest paths.[^plugin-reference]

### 1.2 `marketplace.json` schema

**Documented.** `.claude-plugin/marketplace.json` requires:[^marketplace-schema]

| Field | Shape | Meaning |
|---|---|---|
| `name` | string | Public marketplace identifier; one registration per name |
| `owner` | object | `name` required; `email` and `url` optional |
| `plugins` | array | Catalog entries |

Optional marketplace fields include `$schema`, `description`, `version`, `metadata.pluginRoot`, cross-marketplace dependency permission, and `renames`. Anthropic reserves official-looking marketplace names and rechecks them at load time to reduce impersonation.[^marketplace-schema]

Each plugin entry requires `name` and `source`. It may carry plugin metadata and component paths plus marketplace-only `category`, `tags`, `strict`, `relevance`, and `defaultEnabled` fields. `strict` defaults to `true`: `plugin.json` is authoritative and marketplace component declarations supplement it. With `strict: false`, the marketplace entry is the complete component definition and a conflicting component declaration in `plugin.json` fails to load.[^marketplace-entries]

Supported plugin source forms are:[^plugin-sources]

| Source | Important fields | Notes |
|---|---|---|
| relative string | `"./path"` | Relative to marketplace root, not `.claude-plugin/` |
| `github` | `repo`, optional `ref`, `sha` | `sha` is an exact full commit pin |
| `url` | `url`, optional `ref`, `sha` | General git source |
| `git-subdir` | `url`, `path`, optional `ref`, `sha` | Sparse subdirectory fetch |
| `npm` | `package`, optional `version`, `registry` | Installed with npm |
| `archive` | HTTPS `url`, optional `sha256` | Zip, max 256 MiB; archive support requires Claude Code 2.1.224+ |

When both `ref` and `sha` exist, `sha` is effective. Archive redirects must remain on allowed HTTPS targets, and a supplied `sha256` is verified before install.[^plugin-sources]

### 1.3 `plugin.json` schema and skill selection

**Documented.** If `.claude-plugin/plugin.json` exists, only `name` is required. Metadata includes `displayName`, `version`, `description`, `author`, `homepage`, `repository`, `license`, `keywords`, `metadata`, and `defaultEnabled`. Component fields include `skills`, `commands`, `agents`, `workflows`, `hooks`, `mcpServers`, `outputStyles`, `lspServers`, `dependencies`, `userConfig`, `channels`, and experimental themes/monitors. Unknown top-level fields are ignored at runtime and warned on by validation.[^plugin-manifest]

`skills` accepts a string or array of relative paths. Normally these paths add to conventional `skills/` discovery. A marketplace entry whose source is the marketplace root is a special case: listing specific skill subdirectories is the complete set for that entry, which is how a repository can publish only a curated subset.[^path-rules]

**Compatibility boundary.** Claude Code follows the Agent Skills standard but adds frontmatter and runtime features such as invocation control, forked subagents, arguments, and dynamic shell context injection. Portable standard fields are `name`, `description`, `license`, `compatibility`, `metadata`, and `allowed-tools`; Claude-only fields or body substitutions may be ignored or behave differently in another receiver.[^claude-skills][^pi-skills]

## 2. Commands and protocol surface

### 2.1 User-facing commands

**Documented.** The interactive commands and scriptable shell equivalents are:[^discover][^plugin-cli][^marketplace-cli]

| Operation | Interactive | Non-interactive shell |
|---|---|---|
| Add catalog | `/plugin marketplace add <source>` | `claude plugin marketplace add <source> [--scope ...]` |
| List catalogs | `/plugin marketplace list` | `claude plugin marketplace list [--json]` |
| Refresh catalog | `/plugin marketplace update [name]` | `claude plugin marketplace update [name]` |
| Remove catalog | `/plugin marketplace remove <name>` | `claude plugin marketplace remove <name>` |
| Install | `/plugin install name@marketplace` | `claude plugin install name@marketplace [--scope user|project|local]` |
| Update plugin | `/plugin update ...` / plugin UI | `claude plugin update <plugin> [--scope ...]` |
| Enable/disable | `/plugin enable|disable ...` | `claude plugin enable|disable ...` |
| Inspect | plugin UI | `claude plugin list`, `claude plugin details` |
| Validate | `/plugin validate <path>` | `claude plugin validate <path> [--strict]` |
| Activate changed components | `/reload-plugins [--force]` | next process/session launch |

Marketplace add accepts GitHub `owner/repo`, general git/SSH URLs, local directories or direct manifest paths, and remote manifest URLs. A git URL can append `#ref` in the interactive add syntax. Direct manifest URLs cannot support relative plugin sources because only the JSON file is downloaded.[^discover]

**Protocol characterization.** There is no documented network registry protocol for third-party receivers. The interoperable surface is JSON manifests plus git/npm/HTTPS source resolution, local settings, and CLI commands. The shell CLI's `--json` output is useful for automation, but Anthropic does not publish `known_marketplaces.json` or `installed_plugins.json` as receiver APIs.

### 2.2 Scopes and project-driven installation

**Documented.** User, project, local, and managed scopes map plugin enablement to `~/.claude/settings.json`, `.claude/settings.json`, `.claude/settings.local.json`, and managed settings respectively. Project settings can declare `extraKnownMarketplaces` and `enabledPlugins`. After the user trusts the repository, Claude prompts to install missing catalogs/plugins; merely setting `enabledPlugins` for an external plugin does not make it load before materialization.[^scopes][^team-marketplaces]

Removing the final registration of a marketplace also uninstalls its plugins. Removing only one of several settings-scope declarations preserves shared state and cache.[^marketplace-cli]

## 3. Update and version semantics

### 3.1 Version is the cache/update key

**Documented.** Claude resolves a plugin version in this precedence order:[^versioning]

1. `version` in the plugin's `plugin.json`;
2. `version` in its marketplace entry;
3. resolved git commit SHA;
4. for archives, the declared SHA-256 or downloaded archive digest.

If the resolved version equals the installed version, manual and automatic update skip materialization. An explicit version therefore acts as a release gate: pushing commits without bumping it does not update existing users. A stale `plugin.json` version silently masks a marketplace entry version. Versionless git plugins update when the resolved commit changes.[^versioning]

A marketplace git source may be pinned to a branch/tag `ref`, while an individual git plugin source may additionally be pinned to a full `sha`. Updating a ref-pinned marketplace advances to the latest commit on that ref. Changing a catalog's plugin `sha` is a separate publisher action.[^plugin-sources][^marketplace-cli]

### 3.2 Background update behavior

**Documented.** When per-marketplace auto-update is enabled, Claude Code refreshes the catalog and updates installed plugins on disk after session start, with randomized delay up to ten minutes. The running session continues with the version loaded at launch; a notification asks for `/reload-plugins`, otherwise the new version is used on the next launch.[^auto-update]

Defaults are security-significant:

* official Anthropic marketplaces: auto-update **on**;
* third-party and local development marketplaces: auto-update **off**;
* managed `extraKnownMarketplaces` can set `autoUpdate: true`;
* `DISABLE_AUTOUPDATER` disables Claude and plugin automatic updates; adding `FORCE_AUTOUPDATE_PLUGINS=1` keeps plugin updates while disabling the Claude binary updater.[^auto-update]

If install lookup misses a plugin and auto-update is on, Claude Code 2.1.221+ refreshes that catalog once and retries. Earlier versions require manual refresh.[^discover]

For private HTTPS marketplaces, background pulls disable git credential helpers; SSH agents still work. On pull failure Claude may re-clone with stored credentials. `CLAUDE_CODE_PLUGIN_KEEP_MARKETPLACE_ON_FAILURE=1` keeps the prior clone instead of deleting/re-cloning after a failed pull.[^private-updates]

## 4. Storage and cache behavior

### 4.1 Supported/documented storage behavior

**Documented.** Marketplace plugins are copied into a versioned local cache under `~/.claude/plugins/cache` rather than executed in place. Each installed version has a separate directory. Superseded or uninstalled versions are marked orphaned and are removed after 14 days so sessions already using old paths continue safely; Glob/Grep omit orphaned versions.[^plugin-cache]

The documented seed-image layout exposes the broader shape:[^seed-cache]

```text
~/.claude/plugins/
  known_marketplaces.json
  marketplaces/<marketplace>/...
  cache/<marketplace>/<plugin>/<version>/...
  data/<sanitized-plugin-id>/...
```

`CLAUDE_CODE_PLUGIN_CACHE_DIR` redirects the primary plugin storage. `CLAUDE_CODE_PLUGIN_SEED_DIR` supplies one or more read-only prepopulated stores; seed marketplaces cannot be updated/removed, seed entries take precedence, and auto-update is disabled for them.[^seed-cache]

`${CLAUDE_PLUGIN_ROOT}` points to the ephemeral version directory. `${CLAUDE_PLUGIN_DATA}` points to persistent `~/.claude/plugins/data/{id}/`, survives updates, and is deleted when the plugin is uninstalled from its last scope unless `--keep-data` is used.[^plugin-data]

Installed plugins cannot traverse outside their cached root. Symlinks inside the plugin are preserved if internal, dereferenced if they target elsewhere in the same marketplace, and skipped if they escape the marketplace.[^plugin-cache]

### 4.2 Undocumented registry files

**Source observation, not an Anthropic contract.** xAI's compatible receiver parses these apparent Claude files and fields:

* `~/.claude/plugins/known_marketplaces.json`: map entries containing `installLocation`;
* `~/.claude/plugins/installed_plugins.json`: a top-level `plugins` map keyed by `name@marketplace`, with arrays containing `installPath`, optional `scope`, and optional `projectPath`;
* `~/.claude/settings.json` and `settings.local.json`: `enabledPlugins` booleans used to distinguish installed/enabled/disabled entries.[^grok-marketplace][^grok-discovery]

This is valuable implementation evidence but should not be copied into Pi as a stable protocol. Open Anthropic-repository reports describe registry/cache drift, stale versions, and scope corruption, reinforcing that a receiver should own its state rather than couple to these files.[^anthropic-cache-issue]

## 5. Security and trust semantics

### 5.1 Documented controls

**Documented.** Anthropic states that plugins and marketplaces are highly trusted components capable of arbitrary code execution with the user's privileges. Plugins may add executable hooks, MCP/LSP processes, monitors, and scripts as well as prompt-only skills. Users should inspect and trust the source before installation.[^security]

Relevant controls include:

* adding a marketplace does not install its plugins;
* the install UI can show context cost and a “Will install” component inventory before confirmation;
* the community marketplace applies Anthropic automated validation/safety screening and pins entries to commit SHAs; the official marketplace is curated at Anthropic's discretion;[^discover]
* git plugin sources can pin a full commit SHA; archive sources can pin and verify SHA-256;[^plugin-sources]
* managed `strictKnownMarketplaces` can deny all catalogs or exactly allowlist source objects, checked **before** network/filesystem work on add/install/update/refresh/auto-update;
* `blockedMarketplaces` blocks specific sources, while `disableSideloadFlags` can close the `--plugin-dir`, `--plugin-url`, `--agents`, and `--mcp-config` bypass paths;[^managed-security]
* project-scoped settings and skills are subject to workspace trust; project MCP servers have an additional per-server approval path.[^scopes]

### 5.2 Update trust gap

**Documented inference.** The docs describe one install trust decision followed by unattended on-disk updates and do not document per-update consent, signature verification, a transparency log, or an executable-component diff. A 2026 open issue in Anthropic's repository specifically requests re-consent or pin-by-default for changed executable content. Treat that issue as a security report, not confirmation from Anthropic that every described implementation detail remains current.[^update-trust-issue]

A safe Pi receiver should be stricter than transparent mirroring:

1. default third-party auto-update off;
2. record resolved commit/archive digest and manifest version;
3. fetch into staging and validate path containment before activation;
4. show selected skills and any executable files before first install;
5. require renewed approval if a later implementation ever enables hooks, MCP/LSP, binaries, or extensions;
6. support exact SHA pinning and an organization allow/block policy.

## 6. Matt Pocock's current distribution

### 6.1 Repository-owned fallback marketplace

**Source observation at commit `84fdeffd12f2ee307994d1eb6feb48173b6e0502`.** Matt's fallback marketplace is named `mattpocock`, contains one `mattpocock-skills` entry, and uses `source: "./"`.[^matt-marketplace] Its plugin manifest declares version `1.2.3` and explicitly lists 25 promoted skills across `skills/engineering/` and `skills/productivity/`.[^matt-plugin]

The repository ADR explains why the explicit list matters: bucket directories contain promoted and non-promoted content; Claude's `skills` array can curate across buckets. It also records validation of the add/install path and the invariant that every promoted skill appears in the manifest.[^matt-adr]

### 6.2 Official marketplace path

**Source observation.** The current `anthropics/claude-plugins-official` catalog entry points directly to `https://github.com/mattpocock/skills.git` at the exact commit SHA above. It does not use Matt's fallback `marketplace.json` for this install path.[^official-matt]

Matt's README describes the plugin as a managed, read-only subscription, installed with `claude plugins install mattpocock-skills`, whose updates arrive automatically. It contrasts that with `skills.sh`, which copies editable files and updates only when the user runs `npx skills update`.[^matt-readme]

**Resulting release chain.** Because the official entry is SHA-pinned and `plugin.json` has an explicit version, an installed release changes only after (a) Matt bumps the plugin version in a new commit and (b) Anthropic moves the official catalog pin to that commit. A push to Matt's `main` alone is not the effective official-marketplace update signal.[^versioning][^official-matt]

## 7. Can Pi consume it directly?

### 7.1 What works without a receiver

**Documented.** Pi implements Agent Skills, recursively discovers directories containing `SKILL.md`, ignores unknown frontmatter, and can load explicit skill files/directories from settings or `--skill`. Pi can also include `~/.claude/skills` as a skill source.[^pi-skills]

Therefore Pi can use a materialized Claude plugin's **portable skill directories** if they are explicitly added as Pi skill paths. For Matt's skills, their standard `SKILL.md` shape is the compatible payload.

### 7.2 What does not work directly

Pi's docs do not define a Claude marketplace receiver. In particular, Pi does not document:

* parsing either Claude manifest;
* resolving plugin entry source types or `plugin@marketplace` IDs;
* honoring `strict`, custom component merge rules, dependencies, scopes, or renames;
* namespacing plugin skills as `plugin:skill`;
* substituting Claude plugin variables or dynamic Claude-only skill syntax;
* loading Claude hooks, MCP/LSP servers, agents, monitors, or output styles as Pi resources;
* tracking Claude's version precedence, registries, or background updater.

**Source observation for Matt.** Installing the repository as an ordinary unpinned Pi git package would use Pi's conventional recursive `skills/` scan because its `package.json` lacks `pi.skills`. That includes ten skills Matt intentionally excludes from the Claude plugin. Direct package installation is thus technically loadable but semantically wrong.[^matt-package][^matt-adr][^pi-packages]

### 7.3 Preferred Pi translation

Translate Claude packaging into Pi's native package/resource model:

```text
Claude marketplace entry
  -> resolve and verify source
  -> parse plugin.json (or marketplace entry under strict:false)
  -> select portable skills only
  -> materialize versioned Pi-owned source
  -> expose exact directories as pi.skills / settings skill paths
  -> record lock metadata: marketplace source, plugin source, ref/SHA,
     manifest version, resolved commit/digest, selected paths
```

Pi packages already support git/npm/local sources, explicit `pi.skills` paths, package filtering, global/project scopes, and manual update commands. Unpinned git packages advance with `pi update --extensions`/`--all`; pinned refs stay pinned. Pi docs describe explicit update commands, not Claude-style background mutation.[^pi-packages]

For a minimal Matt-only integration, the receiver can clone the repository and translate the 25 entries in `.claude-plugin/plugin.json` to exact Pi `skills` paths. For a general receiver, resolve the marketplace first because the official listing may point to a different repository and SHA than the marketplace repository itself.

## 8. Compatible receivers and work worth consulting

### OpenAI Codex: direct manifest compatibility

**Source observation.** Current Codex source explicitly searches for `.claude-plugin/marketplace.json` alongside its own and Cursor marketplace manifests, parses relative, git URL, `git-subdir`, and npm source forms, and contains tests for `.claude-plugin/plugin.json` including multiple skill paths.[^codex-marketplace][^codex-manifest-tests] This is the closest first-party example of consuming the format directly.

Consult Codex for:

* a multi-ecosystem manifest reader with a normalized internal model;
* path containment and source normalization;
* materialization into a receiver-owned versioned cache;
* translating Claude `commands/` into receiver-native skills rather than pretending all components have parity.[^codex-marketplace][^codex-command-migration]

An open Codex issue reports unwanted automatic mirroring of Claude marketplaces and unresolved `${CLAUDE_PLUGIN_ROOT}` behavior. Whether every report detail remains current, it demonstrates why implicit cache sharing and partial component compatibility are dangerous.[^codex-mirroring-issue]

### xAI Grok Build: Claude state and format compatibility

**Source observation.** xAI's public Grok Build source accepts `.claude-plugin/plugin.json`, Claude marketplace/settings locations, Claude's `known_marketplaces.json` and `installed_plugins.json`, and aliases Claude plugin root/data variables. Its own UI/CLI supports marketplace add/update/remove, install/update/uninstall, explicit `--trust`, separate enablement from executable trust, path containment checks, transactional updates, and optional full-SHA policy.[^grok-guide][^grok-manifest][^grok-discovery]

Consult Grok Build if Pi needs to **import an existing Claude installation**. Its code is a practical map of undocumented registry files, but those parsers should remain a compatibility adapter, not Pi's canonical state.

### Gemini CLI: active gap and translator prototype

**Reported.** Gemini CLI issue #28428 is an open, bot-triaged request for monorepo/catalog installs or direct `marketplace.json` support; it identifies the same boundary between a source catalog and native extension update metadata.[^gemini-marketplace]

**Source observation.** `Epiphytic/ai-plugin-translator`, linked from an earlier Gemini CLI cross-ecosystem issue, implements deterministic Claude-to-Gemini translation through a normalized IR. It tracks source commit and translator version, emits provenance, reports unsupported components instead of silently dropping them, and updates only when source/translator state changes.[^translator] Its IR/adapters/provenance model is more appropriate for Pi than binding directly to Claude's cache.

## 9. Unknowns requiring reverse engineering or vendor clarification

The following are **not** stable contracts in the reviewed official docs:

1. Exact schemas, locking, atomic-write behavior, and migration rules for `known_marketplaces.json` and `installed_plugins.json`.
2. Exact cache-directory escaping/sanitization and behavior for unusual version strings or marketplace/plugin names.
3. The official/community marketplace review pipeline, screening checks, signing/attestation, incident response, and catalog-promotion latency.
4. Whether and when updated executable components receive any additional consent on every Claude surface (CLI, IDE, Desktop/Cowork); the docs describe updates but no re-consent protocol.
5. Precise retry/backoff/concurrency behavior beyond the documented startup delay, git timeout, and re-clone fallback.
6. A stable machine protocol for plugin operations beyond CLI commands and their current `--json` outputs.
7. Cross-version behavior for newer fields such as archive sources, dependencies, monitors, workflows, channels, and strict-mode merge edge cases.
8. Whether a future Claude release will change the internal registry/cache layout; compatible receivers should expect it to.

A Pi implementation should answer these through fixtures and conformance tests against public manifests, not by making undocumented Claude files part of Pi's package schema.

## 10. Recommended implementation order

1. **Ship skills-only translation first.** Support relative, GitHub/git URL, and `git-subdir` sources; reject or clearly defer all executable/non-skill components.
2. **Use a Pi-owned cache and lock record.** Never point stable Pi settings at Claude's versioned cache path. Store source identity, resolved SHA/digest, Claude version, and selected skill paths.
3. **Make updates explicit by default.** Add a check/status operation, then a user-approved update; consider opt-in background updates only after provenance and rollback exist.
4. **Honor publisher curation.** Parse `skills` arrays and source-root special behavior. Do not substitute “scan every `skills/` directory.”
5. **Separate format compatibility from runtime parity.** Unknown/unsupported fields should warn or fail according to policy, never silently activate partially translated hooks or MCP servers.
6. **Borrow designs, not state.** Use Codex's normalized direct reader, Grok Build's trust/path checks and transactional materialization, and the translator's IR/provenance reporting. Avoid their reported implicit-mirroring failure mode.
7. **For Matt now:** generate a Pi adapter exposing exactly the 25 manifest paths and update it from the official marketplace pin (or explicitly choose and label a direct-upstream channel).

## Primary sources

[^discover]: Anthropic, [Discover and install prebuilt plugins through marketplaces](https://code.claude.com/docs/en/discover-plugins).
[^marketplace-schema]: Anthropic, [Marketplace schema](https://code.claude.com/docs/en/plugin-marketplaces#marketplace-schema).
[^marketplace-entries]: Anthropic, [Plugin entries and strict mode](https://code.claude.com/docs/en/plugin-marketplaces#plugin-entries).
[^plugin-sources]: Anthropic, [Plugin sources](https://code.claude.com/docs/en/plugin-marketplaces#plugin-sources).
[^plugin-reference]: Anthropic, [Plugins reference: components](https://code.claude.com/docs/en/plugins-reference#plugin-components-reference).
[^plugin-manifest]: Anthropic, [Plugin manifest schema](https://code.claude.com/docs/en/plugins-reference#plugin-manifest-schema).
[^path-rules]: Anthropic, [Plugin path behavior rules](https://code.claude.com/docs/en/plugins-reference#path-behavior-rules) and [advanced marketplace entries](https://code.claude.com/docs/en/plugin-marketplaces#advanced-plugin-entries).
[^claude-skills]: Anthropic, [Extend Claude with skills](https://code.claude.com/docs/en/skills) and [using skill frontmatter outside Claude Code](https://code.claude.com/docs/en/skills#using-skill-frontmatter-outside-claude-code).
[^plugin-cli]: Anthropic, [Plugin CLI commands](https://code.claude.com/docs/en/plugins-reference#cli-commands).
[^marketplace-cli]: Anthropic, [Manage marketplaces from the CLI](https://code.claude.com/docs/en/plugin-marketplaces#manage-marketplaces-from-the-cli).
[^scopes]: Anthropic, [Plugin installation scopes](https://code.claude.com/docs/en/plugins-reference#plugin-installation-scopes) and [Claude Code settings scopes](https://code.claude.com/docs/en/settings#configuration-scopes).
[^team-marketplaces]: Anthropic, [Configure team marketplaces](https://code.claude.com/docs/en/discover-plugins#configure-team-marketplaces).
[^versioning]: Anthropic, [Version resolution and release channels](https://code.claude.com/docs/en/plugin-marketplaces#version-resolution-and-release-channels) and [version management](https://code.claude.com/docs/en/plugins-reference#version-management).
[^auto-update]: Anthropic, [Configure auto-updates](https://code.claude.com/docs/en/discover-plugins#configure-auto-updates).
[^private-updates]: Anthropic, [Private repositories: background auto-updates](https://code.claude.com/docs/en/plugin-marketplaces#background-auto-updates).
[^plugin-cache]: Anthropic, [Plugin caching and file resolution](https://code.claude.com/docs/en/plugins-reference#plugin-caching-and-file-resolution).
[^seed-cache]: Anthropic, [Pre-populate plugins for containers](https://code.claude.com/docs/en/plugin-marketplaces#pre-populate-plugins-for-containers).
[^plugin-data]: Anthropic, [Persistent data directory](https://code.claude.com/docs/en/plugins-reference#persistent-data-directory).
[^security]: Anthropic, [Plugin marketplace security](https://code.claude.com/docs/en/discover-plugins#security).
[^managed-security]: Anthropic, [Managed marketplace restrictions](https://code.claude.com/docs/en/plugin-marketplaces#managed-marketplace-restrictions).
[^update-trust-issue]: Anthropic Claude Code repository, [issue #73914: update trust and re-consent request](https://github.com/anthropics/claude-code/issues/73914) (open user report; not official documentation).
[^anthropic-cache-issue]: Anthropic Claude Code repository, [issue #76882: marketplace/update registry drift](https://github.com/anthropics/claude-code/issues/76882) (open user report; not official documentation).
[^matt-marketplace]: Matt Pocock, [`marketplace.json` at `84fdeffd`](https://github.com/mattpocock/skills/blob/84fdeffd12f2ee307994d1eb6feb48173b6e0502/.claude-plugin/marketplace.json).
[^matt-plugin]: Matt Pocock, [`plugin.json` at `84fdeffd`](https://github.com/mattpocock/skills/blob/84fdeffd12f2ee307994d1eb6feb48173b6e0502/.claude-plugin/plugin.json).
[^matt-package]: Matt Pocock, [`package.json` at `84fdeffd`](https://github.com/mattpocock/skills/blob/84fdeffd12f2ee307994d1eb6feb48173b6e0502/package.json).
[^matt-skills-tree]: Matt Pocock, [`skills/` tree at `84fdeffd`](https://github.com/mattpocock/skills/tree/84fdeffd12f2ee307994d1eb6feb48173b6e0502/skills).
[^matt-adr]: Matt Pocock, [ADR 0002: ship as a Claude Code plugin](https://github.com/mattpocock/skills/blob/84fdeffd12f2ee307994d1eb6feb48173b6e0502/.agents/adr/0002-ship-as-a-claude-code-plugin.md).
[^matt-readme]: Matt Pocock, [skills repository installation choices](https://github.com/mattpocock/skills/blob/84fdeffd12f2ee307994d1eb6feb48173b6e0502/README.md#installation-30-second-setup).
[^official-matt]: Anthropic, [`mattpocock-skills` official marketplace entry at `76e1fd77`](https://github.com/anthropics/claude-plugins-official/blob/76e1fd77f727b593f5bb19873d5b5fde21fd2db1/.claude-plugin/marketplace.json).
[^pi-skills]: earendil-works Pi, [Skills documentation at `2a9b4ebc`](https://github.com/earendil-works/pi/blob/2a9b4ebc680053c64e31f635b0b22d5e22564001/packages/coding-agent/docs/skills.md).
[^pi-packages]: earendil-works Pi, [Pi Packages documentation at `2a9b4ebc`](https://github.com/earendil-works/pi/blob/2a9b4ebc680053c64e31f635b0b22d5e22564001/packages/coding-agent/docs/packages.md).
[^codex-marketplace]: OpenAI Codex, [marketplace reader at `dad1db87`](https://github.com/openai/codex/blob/dad1db87bb5ad4b92af6b0f58502d12453681f81/codex-rs/core-plugins/src/marketplace.rs).
[^codex-manifest-tests]: OpenAI Codex, [Claude plugin manifest/skill path tests at `dad1db87`](https://github.com/openai/codex/blob/dad1db87bb5ad4b92af6b0f58502d12453681f81/codex-rs/core-plugins/src/marketplace_tests.rs).
[^codex-command-migration]: OpenAI Codex, [command migration module at `dad1db87`](https://github.com/openai/codex/tree/dad1db87bb5ad4b92af6b0f58502d12453681f81/codex-rs/core-plugins/src/command_migration).
[^codex-mirroring-issue]: OpenAI Codex repository, [issue #19372: implicit Claude marketplace mirroring](https://github.com/openai/codex/issues/19372) (open user report).
[^grok-guide]: xAI Grok Build, [Plugins user guide at `b13fa526`](https://github.com/xai-org/grok-build/blob/b13fa526f5112c0b20dad5f1f2300d3d3b127895/crates/codegen/xai-grok-pager/docs/user-guide/09-plugins.md).
[^grok-marketplace]: xAI Grok Build, [Claude marketplace/settings compatibility parser at `b13fa526`](https://github.com/xai-org/grok-build/blob/b13fa526f5112c0b20dad5f1f2300d3d3b127895/crates/codegen/xai-grok-agent/src/plugins/marketplace.rs).
[^grok-discovery]: xAI Grok Build, [plugin discovery and Claude registry receiver at `b13fa526`](https://github.com/xai-org/grok-build/blob/b13fa526f5112c0b20dad5f1f2300d3d3b127895/crates/codegen/xai-grok-agent/src/plugins/discovery.rs).
[^grok-manifest]: xAI Grok Build, [Claude manifest compatibility and containment checks at `b13fa526`](https://github.com/xai-org/grok-build/blob/b13fa526f5112c0b20dad5f1f2300d3d3b127895/crates/codegen/xai-grok-agent/src/plugins/manifest.rs).
[^gemini-marketplace]: Google Gemini CLI repository, [issue #28428: monorepo/marketplace support](https://github.com/google-gemini/gemini-cli/issues/28428) (open, bot-triaged feature request).
[^translator]: Epiphytic, [`ai-plugin-translator`](https://github.com/Epiphytic/ai-plugin-translator), linked by [Gemini CLI issue #17505](https://github.com/google-gemini/gemini-cli/issues/17505).
