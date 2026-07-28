---
name: bug-fix
description: Implement a fix for a bug after bug-scoping has analyzed it. Suggests a feature branch name, investigates root causes, proposes solutions, and implements the fix. Use this after running bug-scoping to move from analysis to implementation.
---

# Bug Fix Skill

This skill helps you implement fixes for bugs that have been scoped and analyzed using the bug-scoping skill.

## What This Skill Does

Given a Linear bug ticket that has been analyzed:

1. **Suggest a branch name** using the pattern: `[TICKET-ID]-[short-description]`
2. **Wait for user confirmation** of the branch name
3. **Rename the current branch** to match the ticket (Conductor already created the worktree)
4. **Investigate the bug** by attempting to reproduce it and understanding root causes
5. **Explore hypotheses** - If multiple causes are possible, investigate each one
6. **Propose a solution** - Present findings and recommended fix approach to the user
7. **Implement the fix** - After user approval, make the code changes in the worktree
8. **Verify changes** - Confirm the fix is complete and ready for review

## How to Use This Skill

### After running bug-scoping:
```
@claude, use the bug-fix skill for SUP-13928
```

### Or with a brief description:
```
@claude, use bug-fix to fix the blinking grid indicators issue (SUP-13928)
```

## Workflow

### Step 1: Branch Name Suggestion
- Extracts ticket ID and title from Linear
- Suggests branch name: `[TICKET-ID]-[kebab-case-title]`
- Examples:
  - `SUP-13928-fix-blinking-grids-indicators`
  - `INTS-423-fix-intercom-call-shutdowns`
  - `VKD-1001-resolve-device-sync-delay`
- Presents the suggested branch name to user
- **Waits for user to confirm branch name before proceeding**

### Step 2: Branch Setup
- Conductor has already created a worktree for this workspace
- Renames the current branch to match the suggested name
- Example commands:
  ```bash
  git branch -m [new-branch-name]
  ```
- Pulls the latest master in the main worktree to ensure code is up-to-date for comparison
- Runs `yarn install` in the background if dependencies aren't ready

### Step 3: Investigation & Reproduction
- Reviews bug description and reproduction steps
- Examines affected code areas identified by bug-scoping
- Attempts to understand how to reproduce the issue
- Reads relevant source files and traces execution paths

### Step 4: Root Cause Analysis
- When multiple hypotheses exist, explores each one:
  - Search for related error handling
  - Check for state management issues
  - Look for race conditions or timing issues
  - Review recent changes to affected files
- Presents all viable hypotheses with evidence

### Step 5: Solution Proposal
- Proposes the most likely fix(es)
- Explains why each hypothesis and solution makes sense
- Shares relevant code snippets and findings
- **Checks in with user** for approval before implementing

### Step 6: Implementation
- Makes necessary code changes
- Follows existing code patterns and style
- Updates related files if needed
- Ensures changes are backward compatible when possible
- changes should be minimal and elegant
- ensure that changes are clearly readable by code reviewers to make sure that they can approve it once it's been tested

### Step 7: Review
- Informs user that changes are complete
- User can review with: `git diff [branch-name]`
- User handles all git commits

## Output Format

### Branch Name Suggestion (First Step)

```
## Bug Fix: [ISSUE_ID] - [TITLE]

### Suggested Branch Name
`[suggested-branch-name]`

Please confirm if this branch name works for you, or suggest an alternative.

Once confirmed, I'll rename the current branch to match.
```

### Branch Setup (After Branch Confirmation)

```
## Setting Up Branch: [branch-name]

Renaming current branch and pulling latest master...
Branch renamed to: [branch-name]
```

### Investigation Report (After Branch Setup)

```
## Investigation Report: [ISSUE_ID] - [TITLE]

### Bug Summary
[Description of the bug and its impact]

### Reproduction Steps
[How to reproduce the issue]

### Root Cause Analysis

#### Hypothesis 1: [Description]
**Evidence**: [Code snippets and findings]
**Files Affected**: [List of files]

#### Hypothesis 2: [Description]
**Evidence**: [Code snippets and findings]
**Files Affected**: [List of files]

### Recommended Solution
[Most likely fix with rationale]

### Implementation Plan
1. [Step 1]
2. [Step 2]
3. [Step 3]

### Questions for User
- [Any clarifications needed?]
```

### After Implementation

```
## Fix Complete: [ISSUE_ID] - [TITLE]

### Changes Made
- File: `path/to/file.tsx` (Lines X-Y)
  - [Description of change]
- File: `path/to/file.ts` (Lines A-B)
  - [Description of change]

### Review
To review changes:
```bash
git diff [branch-name]
```

To commit when ready:
```bash
git add [files]
git commit -m "Fix: [short description]"
```
```

### After Linting

```
## Linting Results: [ISSUE_ID]

### Files Linted
- [List of modified files that were linted]

### Commands Run
- `npx eslint --fix [files]` - [PASS/FAIL]
- `npx tsc --noEmit [files]` - [PASS/FAIL]

### Issues Found
- [List any errors that required manual fixes, or "None - all issues auto-fixed"]

### Fixes Applied
- File: `path/to/file.tsx`
  - [Description of linting fix]
```

## Implementation Steps

When executing this skill:

1. **Extract ticket information**:
   - Get issue ID and title from Linear using the Linear MCP
   - Read the bug description and reproduction steps

2. **Suggest branch name**:
   - Generate branch name from ticket ID and title
   - Present the suggested branch name to the user
   - **STOP and wait for user confirmation of the branch name**

3. **Setup branch** (only after branch name confirmation):
   - Conductor has already created a worktree for this workspace
   - Rename the current branch to match the confirmed name:
     ```bash
     git branch -m [branch-name]
     ```
   - **Pull the latest master** to ensure we have up-to-date code for comparison:
     ```bash
     MAIN_WORKTREE=$(git worktree list | head -1 | awk '{print $1}')
     git fetch origin
     git -C "$MAIN_WORKTREE" pull origin master 2>/dev/null || true
     ```
     Note: `git -C` runs the pull from the main worktree's directory, so master gets updated there regardless of which worktree you're currently in. Always read code from the main worktree path since child worktrees have empty gitlinks.
   - If `yarn install` hasn't been run yet, run it in the background:
     ```bash
     yarn install &
     ```
   - Continue with investigation while dependencies install asynchronously

4. **Investigate the bug** (only after branch setup):
   - Read the bug ticket fully
   - Locate affected code areas (use bug-scoping results)
   - Review the relevant source files
   - Trace execution paths to understand the issue

5. **Attempt reproduction**:
   - Understand the reproduction steps
   - Examine code paths that would be triggered
   - Look for error logs or related issues

6. **Explore multiple hypotheses** (if applicable):
   - Identify all possible root causes
   - For each hypothesis, search for related code
   - Document evidence for each possibility
   - List files that would be affected by each fix

7. **Propose solution(s)**:
   - Present findings clearly to the user
   - Explain reasoning for each hypothesis
   - Recommend the most likely fix
   - Ask user for approval

8. **Implement after approval**:
   - Make code changes following existing patterns
   - Keep changes minimal and focused
   - Verify changes compile/pass type checks
   - Do NOT commit - user will handle this

9. **Run linting on changed files only**:
   - Get list of modified files: `git diff --name-only HEAD`
   - Run ESLint with auto-fix on only the modified files:
     ```bash
     npx eslint --fix [list of modified .ts/.tsx/.js/.jsx files]
     ```
   - Run TypeScript type checking on modified files:
     ```bash
     npx tsc --noEmit [list of modified .ts/.tsx files]
     ```
   - Capture any errors that weren't auto-fixed

10. **Fix any remaining linting issues**:
    - Review errors from linting output
    - Make necessary code changes to resolve issues
    - Re-run linting to verify all issues are resolved
    - Repeat until linting passes cleanly

11. **Communicate completion**:
   - Tell user which files were changed
   - Provide git diff instructions for review
   - Provide git commit instructions for user

12. **Validate on staging (Verkada-Web bug fixes only)**:

   For Verkada-Web fixes, prefer the CI-generated staging URL over a local dev server (see `feedback_use_pr_staging_links.md`). The flow that works:

   **(a) Open the draft PR first.** Don't spin up a dev server speculatively.
   - Commit the fix on the feature branch and push.
   - **Match the Verkada PR format from the first push** — see `reference_verkada_pr_format.md` for required sections (`## This PR resolves` / `## Description` / `## Root cause` / `## Testing` / `## Details on Added Tests`), title pattern (`{TICKET}: lowercase-verb description`), inline-screenshot convention (`#### before` / `#### after` h4s, not a separate `## Screenshots` heading), and the auto-injected CI blocks to preserve on re-edits. Don't invent section names — the conventions are non-obvious and reviewers expect the standard layout.
   - Open as draft: `gh pr create --draft --title "..." --body "..."`. Commit-and-PR is pre-authorized for bug-fix branches per `CLAUDE.md`.
   - **Apply the team label at creation time** (e.g. `gh pr edit <N> --add-label "Manage Alert Page"`). The Auto Labeler check fails without one — fixing it after the fact wastes a CI cycle. Discover labels with `gh label list --repo verkada/Verkada-Web --limit 200`.

   **(b) Wait for `Build / Preview (staging)` to pass.** Typical timing 7–9 min. Poll with:
   ```
   until gh pr checks <PR> | grep -E "Build / Preview \(staging\)\s+(pass|fail)" >/dev/null; do sleep 30; done
   ```
   Run in background via `run_in_background: true`. Don't poll in the foreground.

   **(c) Read the test results pragmatically.** When CI shows red:
   - Check whether the same failures exist on a recently-merged PR (`gh pr list --state merged --limit 3`). E2E flakes are common on Verkada-Web; failures that match recent merged PRs are pre-existing.
   - The relevant green checks for a frontend fix are `Build / Preview (staging)`, `Check Errors / TSC`, `Check Errors / TSC, Lint`, `Check Licenses`, `running-pr-security-checks`, `semgrep`.
   - E2E Playwright failures unrelated to your changed area are usually flake — note them in the PR body but don't block on them.

   **(d) Reproduce on staging.** The org-specific URL is:
   ```
   https://{org-shortname}__{branch-slug}.command.prod.cf.verkada.com/...
   ```
   - VSUP cookies set during `vsuiteweb-eng/engineering/auth` login cover `.command.prod.cf.verkada.com`, so they carry to staging subdomains automatically (see `reference_verkada_web_staging.md`).
   - For mobile-only bugs, **mind the Chrome MCP CDP override stickiness** (`reference_chrome_mcp_cdp_override.md`): if `resize_window` won't shrink `window.innerWidth`, close the tab via `tabs_close_mcp` and create a fresh one before resizing — that clears the override.

   **(e) Capture screenshots for the PR description.** Chrome MCP's `save_to_disk: true` flag is a no-op (writes nothing). Use macOS native instead (see `reference_screencapture_for_pr_screenshots.md`):
   ```bash
   # Position the Chrome window so the bounds are predictable
   osascript -e 'tell application "Google Chrome" to set bounds of window 1 to {0, 33, 500, 933}'
   osascript -e 'tell application "Google Chrome" to activate'
   sleep 1
   screencapture -R 0,33,500,900 -t jpg /tmp/{TICKET-ID}-screenshots/01-broken-on-prod.jpg
   ```
   Requires Screen Recording permission for the host shell (Terminal/iTerm) — System Settings → Privacy & Security → Screen Recording. The user grants this once.

   **(f) Embed screenshots in the PR description.** GitHub PR/issue bodies need `user-attachments/assets/...` URLs that are only generated by the web UI's drag-drop. There is no `gh` CLI command for this. Two options:
   - Save screenshots to `/tmp/{TICKET}-screenshots/`, run `open /tmp/{TICKET}-screenshots/`, and ask the user to drag from Finder onto the PR description (which should be in edit mode).
   - Or update the PR body to leave clear `<!-- DROP: filename.png -->` placeholders and a section telling reviewers what each screenshot demonstrates.

   **(g) Apply the "Ready For Testing" workspace label to the Linear ticket.** Per `feedback_pr_ready_for_testing_label.md` — every draft PR Claude opens ends up awaiting user human-eyes test, and the label is how the user filters all of them in a single Linear view. The workspace-level label already exists with ID `63901630-fca9-4894-b3f9-6f52e1278134`:
   ```bash
   KEY=$(python3 -c "import json; print(json.load(open('/Users/michael.lam/Documents/Verkada Repos/.claude/secrets.json'))['linear']['apiKey'])")
   LABEL_ID="63901630-fca9-4894-b3f9-6f52e1278134"
   UUID=$(curl -s -X POST https://api.linear.app/graphql -H "Authorization: $KEY" -H "Content-Type: application/json" \
     -d "{\"query\":\"query { issue(id: \\\"$TICKET\\\") { id } }\"}" | python3 -c "import json,sys; print(json.load(sys.stdin)['data']['issue']['id'])")
   curl -s -X POST https://api.linear.app/graphql -H "Authorization: $KEY" -H "Content-Type: application/json" \
     -d "{\"query\":\"mutation { issueAddLabel(id: \\\"$UUID\\\", labelId: \\\"$LABEL_ID\\\") { success } }\"}"
   ```

   **(h) Mark the PR ready only after explicit user approval** (per `CLAUDE.md`). Validation lives in the PR body or comments, not in the merge.

## Tips

- Always check the bug description for reproduction steps
- Use bug-scoping results to guide your investigation
- When in doubt about root cause, present multiple hypotheses
- Follow existing code patterns and style conventions
- Keep changes focused on the bug - avoid refactoring unrelated code
- Don't commit on behalf of the user - they'll handle all commits
- If the fix requires database changes, backend changes, or config updates, coordinate with the backend team

## Reference

- **Bug Scoping Skill**: Use this first to understand the scope before fixing
- **IMPLEMENTATION_NOTES.md**: Guidelines for common bug fix patterns
- **DIRECTORY_STRUCTURE.md**: Shared with bug-scoping; understand frontend vs backend

## Requirements

- Linear issue ID for the bug ticket
- Optional: Previous bug-scoping analysis (can be re-run if needed)
- Access to the Verkada-Web and/or Verkada-Backend repositories as needed
