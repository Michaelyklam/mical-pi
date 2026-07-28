# mical-skills

Personal global Claude Code skills (`~/.claude/skills/`), synced across devices via this repo.

## What belongs here

Only skills that are genuinely domain-agnostic — useful in any project, not tied to a
specific company, repo, or workflow. If a skill hardcodes paths, secrets files, org-specific
bots, or depends on sibling skills that live in a specific project, it belongs in that
project's own `.claude/skills/` instead, not here.

(Verkada-specific skills like `bug-fix`, `deep-scoping`, `comment-on-linear-ticket`,
`send-slack-message`, and `vtb-docs-sync` were moved out to the Verkada Repos workspace's
`.claude/skills/` for this reason.)

## Adding a skill pulled from an external source

Some skills (e.g. `mastering-aws-cli`) are third-party — pulled in from someone else's public
repo rather than written from scratch. These are tracked as `git subtree`s, not plain copied
files, so updates can be pulled and reviewed instead of silently drifting or being forgotten.

There are two shapes of source repo, handled differently:

### Case A: the skill lives at the repo root

e.g. `mastering-aws-cli` — `SKILL.md` sits directly at the top of the upstream repo.

1. Add it as a subtree:
   ```bash
   git subtree add --prefix=<skill-name> <repo-url> <branch> --squash
   ```
2. Register it in `.github/skill-sources.json` (no `subpath`):
   ```json
   {
     "name": "<skill-name>",
     "repo": "<repo-url>",
     "branch": "<branch>"
   }
   ```

### Case B: the skill is nested inside a subfolder of a bigger repo

e.g. Matt Pocock's `skills/engineering/*` skills (`tdd`, `code-review`, `wayfinder`, etc.)
from `mattpocock/skills` — many individual skills live inside one repo's subdirectory.
`git subtree add`/`pull` only understand a *repo root*, so a subfolder needs its history
extracted first via `git subtree split`, run from an actual clone of the source repo (its
`--prefix` check requires the path to exist on disk in the current working directory —
it won't work against a bare fetch):

```bash
# One-time: clone the source repo somewhere scratch
git clone <repo-url> /tmp/src && cd /tmp/src

# Extract just this skill's subfolder as its own branch
git subtree split --prefix=<subpath-in-source-repo> -b split-<skill-name> <branch>

# Back in this repo: add it from that local clone + branch
cd ~/.claude/skills
git subtree add --prefix=<skill-name> /tmp/src split-<skill-name> --squash
```

Register it with the `subpath` field so the sync workflow knows to repeat the split step:
```json
{
  "name": "<skill-name>",
  "repo": "<repo-url>",
  "branch": "<branch>",
  "subpath": "<path-to-skill-folder-in-source-repo>"
}
```

Then commit and push either way.

## Keeping external skills in sync

`.github/workflows/sync-external-skills.yml` runs every Monday (and on-demand via
`gh workflow run sync-external-skills.yml`). For each entry in `skill-sources.json`:
- **Root-case entries** (no `subpath`): `git subtree pull --squash` directly against the
  upstream repo.
- **Subpath entries**: clones the upstream repo once (reused across every skill sharing that
  `repo` value — e.g. all 17 `mattpocock/skills` entries share a single clone per run),
  re-runs `git subtree split --prefix=<subpath>` to get the current state of just that
  skill's folder, then pulls from that split branch.

If upstream has new commits, it opens a PR for review — nothing merges automatically. If
nothing changed, the run completes with no PR (this is the expected common case, not a
failure).

This requires "Allow GitHub Actions to create and approve pull requests" to be enabled for
this repo (Settings → Actions → General → Workflow permissions) — without it, the PR-creation
step fails silently on `gh pr create`.

To manually check a single root-case external skill for updates without waiting for the
schedule:
```bash
git subtree pull --prefix=<skill-name> <repo-url> <branch> --squash
```
For a subpath entry, redo the clone-and-split dance above rather than a plain `subtree pull`.
