# Bug Fix Implementation Notes

This document provides guidance on common bug fix patterns and best practices when implementing fixes.

## General Principles

1. **Minimal Changes**: Only modify code necessary to fix the bug
2. **Preserve Style**: Follow existing code patterns and conventions
3. **No Refactoring**: Avoid unrelated refactoring in bug fix commits
4. **Backward Compatible**: When possible, ensure changes don't break existing usage
5. **Test Coverage**: Consider if existing tests cover the fix

## Common Bug Fix Patterns

### React Component Issues

#### State Management Problems
- **Infinite Loops in useEffect**: Check dependency arrays
- **Stale Closures**: Verify hook dependencies are correct
- **Race Conditions**: Use cleanup functions in useEffect
- **Multiple Renders**: Add useCallback or useMemo if needed

```typescript
// WRONG: Missing dependency
useEffect(() => {
  setData(items.filter(x => x.active))
}, []) // ❌ Missing 'items'

// RIGHT: Proper dependencies
useEffect(() => {
  setData(items.filter(x => x.active))
}, [items])
```

#### Props and Re-render Issues
- Check if component re-renders unnecessarily
- Verify props are passed correctly
- Look for missing memoization on expensive components
- Check for derived state issues

#### Event Handler Problems
- Verify event handlers are bound correctly
- Check for memory leaks in event listeners
- Ensure cleanup in cleanup functions
- Look for event delegation issues

### State Management (Redux/Context)

#### Selector Issues
- Verify selectors return correct slice of state
- Check for selector memoization
- Look for mutation of state in reducers
- Verify actions dispatch correct payloads

#### Async Operations
- Check for missing error handling
- Verify async action properly updates state
- Look for race conditions in async flows
- Check for proper loading/error states

### API and Data Flow

#### Request/Response Issues
- Verify request parameters are correct
- Check response parsing and error handling
- Look for missing null checks
- Verify data transformations

#### Caching Issues
- Check if stale cache is being used
- Verify cache invalidation logic
- Look for missing cache busting

### Styling and UI

#### Layout Issues
- Check CSS specificity conflicts
- Look for z-index stacking issues
- Verify flexbox/grid alignment
- Check for overflow and clipping

#### Responsive Design
- Check media query breakpoints
- Verify styles apply at correct breakpoints
- Look for mobile-specific issues

### Performance Issues

#### Rendering Performance
- Identify unnecessary re-renders
- Check for missing memoization
- Look for large list rendering without virtualization
- Verify animation frame usage

#### Memory Leaks
- Check for cleanup functions in effects
- Look for event listener cleanup
- Verify timers are cleared
- Check for circular references

## Investigation Checklist

When investigating a bug, follow this checklist:

- [ ] Read the bug description completely
- [ ] Understand the reproduction steps
- [ ] Identify affected components/services
- [ ] Search for related issues or comments
- [ ] Check git history for recent changes to affected files
- [ ] Review error logs or console errors
- [ ] Trace execution path step by step
- [ ] Look for edge cases or boundary conditions
- [ ] Check for timing-related issues
- [ ] Review related test cases

## Root Cause Categories

### Most Common
1. **Dependency Array Issues** - Missing dependencies in useEffect
2. **State Management** - Incorrect state updates or selectors
3. **Props Passing** - Wrong or missing props
4. **Event Handling** - Incorrect event binding or delegation
5. **API/Data** - Incorrect data parsing or transformation

### Less Common
6. **Race Conditions** - Timing-dependent bugs
7. **Memory Leaks** - Cleanup functions not called
8. **Type Issues** - Type mismatches causing runtime errors
9. **CSS/Styling** - Specificity or cascade issues
10. **Browser Compatibility** - Browser-specific bugs

## Code Review Checklist

Before presenting the fix to the user:

- [ ] Does the fix address the root cause?
- [ ] Are all necessary files modified?
- [ ] Does the fix follow existing code patterns?
- [ ] Are there any unrelated changes included?
- [ ] Does it maintain backward compatibility?
- [ ] Are error messages clear?
- [ ] Is the fix minimal and focused?
- [ ] Would this fix cause other issues?

## Common Mistakes to Avoid

1. **Over-fixing**: Adding unnecessary changes beyond the bug fix
2. **Incomplete fixes**: Only fixing symptoms, not root cause
3. **Breaking changes**: Fixing bug in a way that breaks other features
4. **Style violations**: Not following project conventions
5. **Untested assumptions**: Assuming root cause without proper investigation
6. **Refactoring creep**: Taking opportunity to refactor unrelated code
7. **Committing on behalf of user**: User must review and commit

## Testing Considerations

After implementing a fix, consider:

- [ ] Does the bug no longer occur?
- [ ] Do existing tests still pass?
- [ ] Are there new edge cases to test?
- [ ] Should new tests be added?
- [ ] Are there related bugs that might appear?

## Integration with git

### Branching
- Branch names follow pattern: `[TICKET-ID]-[kebab-case-description]`
- Always branch from `main`
- Keep branch up to date with main if needed

### Commits (User Responsibility)
- User will commit changes with descriptive messages
- Commits should reference the ticket ID
- Example: `git commit -m "Fix SUP-13928: Resolve blinking grid indicators"`

### Review Process
- Changes are reviewed before committing
- Use `git diff` to review changes
- Verify no accidental changes are included
