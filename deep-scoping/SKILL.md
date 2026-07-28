---
name: deep-scoping
description: Deep analysis of a bug ticket using an adversarial multi-agent debate pattern. An Investigator agent explores the codebase and forms hypotheses, then a Critic agent independently verifies claims and challenges weak points. They debate back and forth (up to 3 rounds) until the root cause is clearly established. Produces higher-confidence scoping reports than standard bug-scoping. Use this for complex or high-priority bugs where you want extra rigor.
---

# Deep Scoping Skill

This skill performs a deep, high-confidence bug scoping analysis using an adversarial multi-agent debate pattern. An Investigator's findings are independently scrutinized by a Critic, and they go back and forth until the root cause is clearly established.

## What This Skill Does

Given a Linear bug ticket, this skill will:

1. **Read the bug ticket** from Linear MCP
2. **Spawn an Investigator agent** to explore the codebase and form hypotheses
3. **Spawn a Critic agent** to independently verify claims and challenge weak hypotheses
4. **Run a debate loop** where agents go back and forth until root cause is clearly established
5. **Provide a structured assessment** including:
   - Type: Frontend-only, Backend-only, or Mixed
   - Complexity: Low, Medium, or High
   - Files affected: Number and list of files to be modified
   - Summary: Brief description of the scope
   - Debate Summary: Confidence level based on adversarial review

## When to Use This vs bug-scoping

| | bug-scoping | deep-scoping |
|---|---|---|
| **Speed** | Fast (single agent) | Slower (multi-agent debate) |
| **Best for** | Straightforward bugs, quick triage | Complex bugs, high-priority issues |
| **Confidence** | Standard | Higher (adversarially verified) |
| **Cost** | Lower (1 subagent) | Higher (2+ subagents, multiple rounds) |

Use **bug-scoping** for routine triage. Use **deep-scoping** when you want extra rigor — e.g., the bug is high-priority, the codebase area is complex, or previous scoping attempts were inconclusive.

## How to Use This Skill

### Invoke the skill with a Linear issue ID:
```
@claude, use the deep-scoping skill for issue VKD-1234
```

### Or reference a specific bug:
```
Please deep-scope VKD-1234
```

## Output Format

The skill will provide a structured response:

```
## Deep Scope Assessment: [ISSUE_ID] - [TITLE]

### Scope Type
- **Type**: [Frontend-only | Backend-only | Mixed]
- **Rationale**: [Brief explanation of why this type]

### Complexity Rating
- **Complexity**: [Low | Medium | High]
- **Reasoning**: [Explanation based on COMPLEXITY_SCALE.md]

### Behavior Analysis
- **Is behavior expected?**: [Yes - code working as written | No - code defect | Partial - design mismatch]
- **Analysis**: [Explanation of whether the observed bug behavior matches what the code should produce, and whether this is a code defect or requirements issue]

### Files Affected
- **Count**: [Number] files
- **Estimated Changes**: [Low | Moderate | High] code changes
- **Key Areas**:
  - [File/Directory 1]
  - [File/Directory 2]
  - [etc.]

### Duplicate Tickets
- **Found**: [Yes | No]
- **Duplicates**: (if found)
  - [ISSUE-ID]: [Title] - Created: [date], Closed: [date or "Open"]
  - [Additional context about timeline - e.g., "Regression after 13 months", "Recently reopened", etc.]
- **Analysis**: [If duplicates found, analyze timeline and potential regressions. Note if a bug returned after significant time, which may indicate regression from later changes]

### Fix Status
- **Already Fixed?**: [Yes | No | Unclear]
- **Evidence**: [If fix exists, describe what code prevents the bug and when it was added]
- **Recommendation**: [If already fixed, recommend closing the ticket or verifying the fix is deployed]

### Debate Summary
- **Rounds**: [Number of debate rounds]
- **Key Challenges Raised**: [What the critic contested]
- **Resolutions**: [How each challenge was resolved — accepted, revised, or unresolved]
- **Confidence Level**: [High | Medium | Low]
  - High: Critic agreed within 1-2 rounds, strong evidence
  - Medium: Required 3 rounds or partial agreement
  - Low: Max rounds reached with unresolved disagreements

### Summary
[Brief paragraph describing the scope and what needs to be done]
```

## Implementation Steps

When executing this skill, the main Claude Code instance acts as the **Orchestrator**, coordinating two specialized agents through an adversarial debate.

### Step 0: Consult the investigation wiki

Before spawning the Investigator, read `.claude/skills/investigation-wiki/wiki/INDEX.md` and check if the ticket's symptom matches an existing playbook. If it does, include the playbook path and its known root causes in the shared context block — both agents should know the prior art so they argue against (or strengthen) it rather than re-deriving from scratch. New playbook-worthy findings get auto-ingested at session end via the Stop hook.

### Step 1: Orchestrator Setup (runs in main Claude Code)

1. **Fetch the Linear issue** via MCP:
   - Retrieve the issue using `get_issue`
   - Retrieve relevant comments using `list_comments`

2. **Pull the latest code** to ensure code is up-to-date:
   ```bash
   MAIN_WORKTREE=$(git worktree list | head -1 | awk '{print $1}')
   git fetch origin
   git -C "$MAIN_WORKTREE" pull origin master 2>/dev/null || true
   ```

3. **Download any embedded images** from the issue description:
   - Parse the markdown description for image references (format: `![image.png](https://uploads.linear.app/...)`)
   - If images are found:
     a. Read the Linear API key from `.claude/secrets.json`
     b. Extract image URLs from the description
     c. Download each image using curl:
        ```bash
        curl -L -H "Authorization: {API_KEY}" "https://uploads.linear.app/{image-path}" --output /tmp/linear-image-{n}.png
        ```
     d. Read the downloaded images to view their content for additional context

4. **Prepare a shared context block** containing:
   - Issue ID, title, and full description
   - Image findings (if any screenshots were downloaded and analyzed)
   - Comments from the issue thread
   - This context block will be passed to both agents

### Step 2: Spawn Investigator Agent

Use the `Task` tool with `subagent_type="general-purpose"` and provide the following prompt:

```
You are the INVESTIGATOR in an adversarial bug scoping analysis for Linear issue {ISSUE_ID}.
Your goal is to thoroughly investigate the bug and return a comprehensive structured report.
Your findings will be independently reviewed by a Critic agent, so be precise and cite evidence.

## Shared Context
{SHARED_CONTEXT_BLOCK}

## Investigation Steps:

1. **Parse the issue description** (including any image findings from context) to understand:
   - What is broken
   - Expected vs actual behavior
   - Affected features or components
   - Any additional error logs or screenshots

2. **Search for duplicate tickets**:
   - Search Linear for similar issues using keywords from the bug title/description
   - Look for issues with similar symptoms, error messages, or affected components
   - For any potential duplicates found:
     a. Check the creation date
     b. Check if/when they were closed
     c. **Analyze timeline for regressions**: If a similar bug was fixed >6 months ago and is now back, this indicates a regression
     d. **Check related PRs for old bugs**: For regressions, examine the PR that fixed the original bug and investigate recent commits that may have touched the same code areas
   - Include duplicate findings with dates and timeline analysis

3. **Locate the relevant code**:
   - Search for components/services mentioned in the bug
   - Check the DIRECTORY_STRUCTURE.md to understand folder organization
   - Navigate to suspected problem areas
   - **Capture relevant code snippets** (10-30 lines around the key areas)
   - **IMPORTANT**: Always read code from the main worktree path (`/Users/michael.lam/Documents/Verkada Repos/`)

4. **Inspect live prod data when the bug is user/org/entity-specific**:
   - If the ticket names a specific org, user, device, filter, alert, or group that's behaving wrong, check the actual DB state — the bug may be a data condition, not a code defect.
   - **How**: read memory `reference_verkada_athena_prod.md` for the Athena query pattern. `prod-us-west-data-access` AWS SSO profile → Athena has CDC replicas of every service's Postgres (`vlive`, `auth`, `vmercury`, `vprovision`, etc.) in `*_latest` views.
   - Especially check for "silent drop" paths where the code swallows the exclusion with no log (vlive alert permission check, dedup ordering, ExpandGroup failures, etc.) — the memory lists known traps with line numbers.

5. **Reproduce in the UI for any rendering / interaction / network-dependent bug — even if code analysis seems conclusive**:
   - If the ticket includes a `VSUP-...` support token + customer org, use the `support-org-login` skill to drive the customer's Command UI in Chrome — confirm the symptom, capture network traces, and inspect frontend state that Athena can't see.
   - If no support token is provided but the bug is reproducible on a generic org, use a test org (ClaudeCodeTestOrgA/B — see `reference_test_orgs.md` and `test-credentials.md`) or a VSUP token to a Verkada-internal lab org (e.g. `tse-lab-us`).
   - **Bias toward doing the repro, not skipping it.** A clean code-trace is not a substitute — UI repro is what catches subtle interaction bugs (stale state, race conditions, viewport-conditional code paths) that the trace can miss, and it produces the artifact (screenshots, network trace) the Investigator's report needs anyway. The "skip because code analysis is conclusive" instinct has been wrong on past tickets.
   - Skip ONLY when the bug is purely backend / data-condition AND Athena already confirmed the cause AND there is no rendered UI piece in the symptom.
   - Mind known Chrome MCP traps before kicking off: the extension-collision hard block (`reference_chrome_mcp_extension_blocker.md`), the CDP device-override stickiness on `resize_window` (`reference_chrome_mcp_cdp_override.md`), and `save_to_disk` being a no-op (`reference_screencapture_for_pr_screenshots.md`).

6. **Analyze the scope**:
   - Identify all files that would need changes
   - Determine if frontend, backend, or both are affected
   - Count the approximate lines of code that would change

7. **Verify if the observed behavior is expected**:
   - Review the code logic to understand what the current implementation does
   - Compare the actual behavior described in the bug with what the code should produce
   - Determine if the bug is a genuine code defect, working-as-coded but wrong requirements, or a design mismatch

8. **Form root cause hypotheses**:
   - Based on your investigation, form 1-3 hypotheses about what's causing the bug
   - For each hypothesis, provide specific evidence (file paths, line numbers, code snippets)
   - Identify which files would need to be changed for each hypothesis

9. **Check if the bug has already been fixed**:
   - After identifying the root cause, check current code for existing fixes
   - Look for code that prevents the bug behavior, recent changes to affected files
   - Use git log or git blame to find when any fix was committed

10. **Determine complexity** using these rules:
   - Low: Web-only OR <=3 files, <=30 lines
   - Medium: Backend involved OR <=5 files, <=100 lines
   - High: Everything else

## Return Format:

Return your findings as a structured report:

## INVESTIGATION REPORT FOR {ISSUE_ID}

### Issue Summary
- **ID**: {ISSUE_ID}
- **Title**: {ISSUE_TITLE}
- **Description**: {BRIEF_SUMMARY}

### Scope Type
- **Type**: [Frontend-only | Backend-only | Mixed]
- **Rationale**: [Brief explanation]

### Complexity Rating
- **Complexity**: [Low | Medium | High]
- **Reasoning**: [Explanation based on rules above]

### Behavior Analysis
- **Is behavior expected?**: [Yes - code working as written | No - code defect | Partial - design mismatch]
- **Analysis**: [Explanation]

### Files Affected
- **Count**: {NUMBER} files
- **Estimated Changes**: [Low | Moderate | High] code changes
- **Key Areas**:
  - {FILE_PATH_1} (Lines: {LINE_RANGE})
  - {FILE_PATH_2} (Lines: {LINE_RANGE})

### Code Locations & Snippets
For each key file, provide:
- **File**: {FULL_PATH}
- **Lines**: {LINE_RANGE}
- **Snippet**: {RELEVANT_CODE_10-30_LINES}
- **Notes**: {WHY_THIS_CODE_IS_RELEVANT}

### Root Cause Hypotheses

#### Hypothesis 1: {DESCRIPTION}
- **Evidence**: {CODE_OBSERVATIONS_WITH_FILE_PATHS_AND_LINE_NUMBERS}
- **Files Affected**: {FILE_LIST}
- **Likelihood**: [High | Medium | Low]

#### Hypothesis 2: {DESCRIPTION} (if applicable)
- **Evidence**: {CODE_OBSERVATIONS}
- **Files Affected**: {FILE_LIST}
- **Likelihood**: [High | Medium | Low]

### Duplicate Tickets
- **Found**: [Yes | No]
- **Duplicates**: (if found)
  - {ISSUE-ID}: {Title} - Created: {date}, Closed: {date or "Open"}
- **Analysis**: {Timeline and regression analysis if applicable}

### Fix Status
- **Already Fixed?**: [Yes | No | Unclear]
- **Evidence**: {If fix exists, describe what code prevents the bug, which commit/PR, and when}
- **Recommendation**: {Next steps}

### Summary
{BRIEF_PARAGRAPH}

### Investigation Notes
{ANY_ADDITIONAL_CONTEXT}

**IMPORTANT**: Be precise with code citations. The Critic agent will independently verify your claims by reading the same files. Unsupported or vague claims will be challenged.
```

### Step 3: Spawn Critic Agent

After receiving the Investigator's report, use the `Task` tool with `subagent_type="general-purpose"` to spawn the Critic:

```
You are the CRITIC in an adversarial bug scoping analysis for Linear issue {ISSUE_ID}.
An Investigator agent has analyzed this bug and produced a report. Your job is to independently
verify their claims, challenge weak hypotheses, and identify gaps.

## Shared Context
{SHARED_CONTEXT_BLOCK}

## Investigator's Report
{INVESTIGATOR_REPORT}

## Your Task:

1. **Independently verify code citations**: Read the cited files and line numbers. Does the code
   actually say what the Investigator claims? Are the snippets accurate and current?

2. **Challenge each root cause hypothesis**:
   - Is the evidence sufficient to support it?
   - Are there simpler explanations the Investigator missed?
   - Does the cited code actually lead to the described bug behavior?

3. **Identify missing considerations**:
   - Other code paths that could be relevant
   - Edge cases not examined
   - Related systems or dependencies not explored
   - Configuration or environment factors

4. **Propose alternative root causes** if the Investigator's seem weak or incomplete

5. **Verify scope & complexity rating**:
   - Are all affected files accounted for?
   - Is the complexity rating consistent with the evidence?

6. **Check duplicate analysis thoroughness**:
   - Were the right keywords used?
   - Were obvious related terms missed?

7. **Verify live data claims**: If the Investigator's hypothesis rests on a data condition (e.g. "user lacks permission X on entity Y", "filter is misconfigured", "group membership stale"), independently confirm via Athena. See memory `reference_verkada_athena_prod.md` for the query pattern — don't accept Investigator's data claims on trust.

8. **Verify UI repro claims**: If the Investigator reproduced (or failed to reproduce) the bug via `support-org-login` or a test org, sanity-check the claim — was the right org/account used, did the captured network trace actually show the symptom, did they look at the right state? **If the Investigator skipped UI repro on a rendering / interaction / network-dependent bug, flag it as a gap and require the repro before convergence.** "Code analysis is conclusive" is not sufficient justification on its own — viewport-conditional or stale-state bugs need to be observed.

9. **IMPORTANT**: Always read code from the main worktree path (`/Users/michael.lam/Documents/Verkada Repos/`)

## Return Format:

## CRITIQUE OF INVESTIGATION REPORT

### Hypothesis Review
For each hypothesis from the Investigator:
- **Hypothesis**: [Name]
- **Verdict**: [Supported | Weakly Supported | Unsupported | Contradicted]
- **Evidence Gap**: [What's missing or incorrect]
- **Code Verification**: [Did the cited code actually support the claim? What did you find when you read the files?]

### Missing Considerations
- [Things the Investigator didn't examine that could be relevant]

### Alternative Root Causes
- [Other plausible explanations with evidence from your own code reading]

### Scope & Complexity Check
- **Investigator's Rating**: [X]
- **Critic's Assessment**: [Agree | Should be Y because...]

### Convergence Status
- **Status**: [Agree | Partially Agree | Disagree]
  - Agree: The investigation is thorough, hypotheses are well-supported, no major gaps
  - Partially Agree: Core findings are correct but specific items need revision
  - Disagree: Fundamental issues with the analysis that need addressing
- **Unresolved Items**: [List of remaining concerns that must be addressed]

**IMPORTANT**: Do NOT rubber-stamp the report. Your value comes from genuine scrutiny.
Read the actual code files yourself. If you find the same evidence the Investigator found,
say so explicitly. If you find something different, highlight the discrepancy.
```

### Step 4: Debate Loop (max 3 rounds)

If the Critic's convergence status is NOT `Agree`, enter the debate loop:

**For each round:**

1. **Resume Investigator** using the `Task` tool with the `resume` parameter (passing the Investigator's agent ID from Step 2):
   ```
   The Critic agent has reviewed your investigation report and raised the following challenges.
   Address each concern by either:
   - Defending your finding with additional evidence (cite specific code)
   - Revising your finding based on valid criticism
   - Acknowledging the gap and providing additional investigation

   ## Critic's Feedback:
   {CRITIC_REPORT}

   Return an updated investigation report that addresses each challenge. For revised items,
   clearly mark what changed. For defended items, provide the additional evidence.
   ```

2. **Resume Critic** using the `Task` tool with the `resume` parameter (passing the Critic's agent ID from Step 3):
   ```
   The Investigator has responded to your critique. Review their defense/revisions.

   ## Investigator's Response:
   {INVESTIGATOR_UPDATED_REPORT}

   Evaluate whether each of your concerns was adequately addressed.
   Return an updated critique with a new convergence status.
   If concerns were resolved, update your verdicts accordingly.
   If new issues emerged from their revisions, note those too.
   ```

3. **Check convergence**: If the Critic's updated status is `Agree`, break out of the loop.

4. **If max rounds (3) reached without agreement**: Note the unresolved disagreements in the final report. The orchestrator should briefly summarize what couldn't be resolved.

### Step 5: Synthesize Final Report

After convergence (or max rounds):

1. **Merge converged findings** into the final output format (see "Output Format" section above)
2. **Build the Debate Summary section**:
   - Count the number of debate rounds
   - Summarize key challenges the Critic raised
   - Note how each challenge was resolved (accepted revision, defended with evidence, or unresolved)
   - Assign confidence level:
     - **High**: Critic agreed within 1-2 rounds, strong evidence
     - **Medium**: Required 3 rounds or partial agreement on final round
     - **Low**: Max rounds reached with unresolved disagreements
3. **Present the complete assessment to the user**
4. The code snippets, hypotheses, and debate history are preserved for the bug-fix skill to reference later

## Reference Materials

- **COMPLEXITY_SCALE.md**: Detailed complexity definitions and examples (in the bug-scoping skill directory)
- **DIRECTORY_STRUCTURE.md**: Guide to frontend/backend file organization (in the bug-scoping skill directory)

## Tips

- Use the Linear MCP to get complete issue context
- Refer to DIRECTORY_STRUCTURE.md to quickly identify frontend vs backend areas
- Look at related code to understand impact scope
- Consider dependencies between files when estimating changes
- When in doubt, lean toward the more conservative (higher) complexity rating
- **For duplicate detection**: Search using both exact phrases and related keywords. A bug "dropdown doesn't close" might be related to "modal remains open" or "overlay won't dismiss"
- **For regressions**: Pay special attention to bugs that reappear >6 months after being fixed - these often indicate code refactors or new features inadvertently broke the original fix
- **For investigating regressions**: Use git log and git blame to find commits affecting the same files/functions between the original fix and now
- **On the debate loop**: The adversarial pattern catches single-agent blind spots. Even if the Investigator is mostly right, the Critic often surfaces edge cases or missing file references that improve the final report
- **Debate efficiency**: Most well-investigated bugs converge in 1-2 rounds. If round 3 is reached, the disagreements are usually about subjective complexity ratings or alternative hypotheses that are both plausible — note these for the user rather than forcing agreement
