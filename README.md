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

To add a new one:

1. Add it as a subtree:
   ```bash
   git subtree add --prefix=<skill-name> <repo-url> <branch> --squash
   ```
2. Register it in `.github/skill-sources.json`:
   ```json
   {
     "name": "<skill-name>",
     "repo": "<repo-url>",
     "branch": "<branch>"
   }
   ```
3. Commit and push.

## Keeping external skills in sync

`.github/workflows/sync-external-skills.yml` runs every Monday (and on-demand via
`gh workflow run sync-external-skills.yml`). For each entry in `skill-sources.json`, it runs
`git subtree pull --squash` against the upstream repo. If upstream has new commits, it opens
a PR for review — nothing merges automatically. If nothing changed, the run completes with no
PR (this is the expected common case, not a failure).

This requires "Allow GitHub Actions to create and approve pull requests" to be enabled for
this repo (Settings → Actions → General → Workflow permissions) — without it, the PR-creation
step fails silently on `gh pr create`.

To manually check a single external skill for updates without waiting for the schedule:
```bash
git subtree pull --prefix=<skill-name> <repo-url> <branch> --squash
```
