# Bug Investigation Hypothesis Template

Use this template when investigating bugs with multiple possible root causes.

## Structure

```markdown
## Investigation Report: [ISSUE_ID] - [TITLE]

### Bug Summary
[1-2 sentences describing what's broken and impact]

### Environment & Context
- **Ticket ID**: [ISSUE_ID]
- **Component(s)**: [Which parts of the system are affected]
- **Reproduction Rate**: [Always/Sometimes/Intermittent]
- **Affected Users/Scenarios**: [Who sees this issue]

### Reproduction Steps
1. [Step 1]
2. [Step 2]
3. [Observe issue]

### Root Cause Analysis

#### Hypothesis 1: [Concise Description]

**Likelihood**: [High/Medium/Low]

**Reasoning**:
- [Point 1]
- [Point 2]
- [Point 3]

**Evidence**:
```typescript
// Code snippet showing evidence
[Relevant code from repo]
```

**Files Affected**:
- `path/to/file1.tsx` (Lines X-Y)
- `path/to/file2.ts` (Lines A-B)

**Fix Approach**:
[Brief description of how you'd fix this]

---

#### Hypothesis 2: [Concise Description]

**Likelihood**: [High/Medium/Low]

**Reasoning**:
- [Point 1]
- [Point 2]
- [Point 3]

**Evidence**:
```typescript
// Code snippet showing evidence
[Relevant code from repo]
```

**Files Affected**:
- `path/to/file1.tsx` (Lines X-Y)
- `path/to/file2.ts` (Lines A-B)

**Fix Approach**:
[Brief description of how you'd fix this]

---

### Recommended Solution

**Primary Fix**: [Hypothesis X]

**Rationale**:
- Most likely based on evidence
- Simplest to implement
- Least disruptive to codebase

**Implementation Plan**:
1. [Action 1]
2. [Action 2]
3. [Action 3]

**Potential Side Effects**:
- [If any]

**Alternative Solutions**:
- Hypothesis X could also work if...

### Questions for User

- [ ] Have you observed any additional details about when this occurs?
- [ ] Are there any related tickets or previous attempts to fix this?
- [ ] Should I proceed with implementing Hypothesis [X]?
```

## When to Use Multiple Hypotheses

Use multiple hypotheses when:

1. **The bug is intermittent** - Suggests multiple possible causes
2. **The bug description is vague** - Multiple interpretations possible
3. **The affected code has complex interactions** - Hard to pinpoint exact cause
4. **Similar bugs exist with different causes** - This might be one of those cases
5. **The reproduction steps don't clearly point to one area** - Need to explore options

## How to Investigate Each Hypothesis

### Search for Evidence
1. Search the codebase for related code patterns
2. Check git history for recent changes to affected files
3. Look for error handling or edge cases
4. Review related components or services

### Trace Execution
1. Follow the code path that would be executed
2. Identify where things might go wrong
3. Check for timing or ordering issues
4. Look for assumptions that might be violated

### Check Similar Code
1. Look for patterns elsewhere in codebase
2. See if other components handle this correctly
3. Find working examples to compare against

## Ranking Hypotheses

Consider these factors when ranking likelihood:

1. **Code Complexity** - Complex code is more likely to have bugs
2. **Recent Changes** - Recently changed code is more likely to be the issue
3. **Common Patterns** - If this bug pattern is common, it's likely this cause
4. **Test Coverage** - Untested code is more likely to have bugs
5. **Type Safety** - Untyped or loosely typed code is more likely to have bugs
6. **Dependencies** - Code with many dependencies is more likely to have issues
7. **Specificity** - More specific evidence ranks the hypothesis higher

## Presenting Multiple Hypotheses

**DO**:
- Present hypotheses in order of likelihood
- Include specific evidence for each
- Make it clear which one you recommend
- Explain why you recommend that one
- Offer to implement alternative if user prefers

**DON'T**:
- Present too many hypotheses (3-4 max)
- Leave out specific code evidence
- Leave user uncertain which to choose
- Present equally likely hypotheses if you have a preference
- Overwhelm with speculation

## Hypothesis Investigation Workflow

```
1. Read bug description carefully
   ↓
2. List all possible root causes (brainstorm)
   ↓
3. Rank by likelihood based on code knowledge
   ↓
4. For top 3-4 hypotheses:
   - Search for related code
   - Find evidence
   - Trace execution path
   - Document findings
   ↓
5. Create final report with:
   - Ranked hypotheses
   - Evidence for each
   - Recommendation
   - Implementation plan
   ↓
6. Present to user
   ↓
7. Proceed with recommended fix or alternative if user prefers
```

## Example Hypotheses

### Example 1: Performance Issue

**Hypothesis 1: Unnecessary Re-renders**
- Component re-renders on every state change
- Missing memoization causing expensive operations to run
- Evidence: No useCallback or useMemo found in component

**Hypothesis 2: Inefficient Data Fetching**
- API called multiple times for same data
- Missing caching layer
- Evidence: API calls in useEffect without dependency array

**Hypothesis 3: Large List Rendering**
- No virtualization for long lists
- All items rendered even when not visible
- Evidence: Performance profiler shows N items rendered

### Example 2: Functional Bug

**Hypothesis 1: State Not Updated**
- setState call missing or condition not met
- Stale closure in callback
- Evidence: Missing dependency in useEffect

**Hypothesis 2: Wrong Selector**
- Redux selector returns wrong slice of state
- Selector not memoized causing stale data
- Evidence: Selector implementation doesn't match expected output

**Hypothesis 3: Race Condition**
- Multiple async operations updating state
- One overrides the other
- Evidence: Timing-dependent behavior in reproduction steps
