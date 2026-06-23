---
name: pre-implementation-feature-check
description: "Pre-flight checks before implementing a feature: searches for existing implementations, reviews recent work, checks git status, and validates the feature rationale to prevent duplicate effort."
last_updated: 2025-01-05
tools_required: []
agent_type: main_agent
---

# Pre-Implementation Feature Check

Run this skill before starting any significant feature implementation to avoid duplicate work and validate your approach.


## See Also

- [sounding-board-mode](../../rebel-system/skills/thinking/sounding-board-mode/SKILL.md) - for deeper discussion of approach and alternatives
- [devils-advocate](../../rebel-system/skills/thinking/devils-advocate/SKILL.md) - for stress-testing the feature rationale
- [discuss-plan-implement-complex-task](../../rebel-system/skills/thinking/discuss-plan-implement-complex-task/SKILL.md) - full workflow for complex tasks
- [write-planning-doc](../../rebel-system/skills/documentation/write-planning-doc/SKILL.md) - for creating implementation plans after validation


## When to Use

Use this skill when:
- Starting a new feature or significant enhancement
- About to make changes to a codebase you haven't touched recently
- Working in a team where others may have parallel work in progress
- Uncertain whether similar functionality already exists


## Process

Run through all checks below before starting implementation. Report findings to the user with a clear recommendation.


### 1. Git Status & Sync Check

First, check if you're in sync with the remote:

```bash
git fetch origin
git status
git rev-list HEAD..origin/dev --count
git rev-list HEAD..origin/main --count
```

**Check for:**
- [ ] Any uncommitted local changes (warn if unrelated to this feature)
- [ ] Commits behind `origin/dev` - if > 0, **WARN**: "You are N commits behind dev"
- [ ] Commits behind `origin/main` - note if diverged

**If behind dev, check unpulled commits for overlap:**

```bash
git log HEAD..origin/dev --oneline
git log HEAD..origin/dev --name-only
```

Review commit messages and changed files for anything that might:
- Touch the same files you plan to modify
- Implement similar functionality
- Conflict with your planned approach

**Report to user**: "The following recent commits on dev may be relevant to your planned work: [list with brief explanation of why each might overlap]"


### 2. Codebase Search for Existing Features

Search the codebase for similar functionality:

**Search patterns to use:**
- Keywords from the feature name/description
- Function/component names you might create
- Domain-specific terms (e.g., "calendar", "sync", "notification")
- UI patterns you plan to implement

```bash
# Search code for relevant terms
grep -r "featureKeyword" src/
grep -r "similarFunctionName" src/

# Search for similar component names
find src/ -name "*FeatureName*"

# Check for existing hooks/services
grep -r "use[FeatureName]" src/
grep -r "[featureName]Service" src/
```

**Check these locations specifically:**
- `src/renderer/features/` - existing feature implementations
- `src/main/services/` - existing backend services
- `src/shared/types.ts` - existing type definitions for this domain
- `src/main/ipc/` - existing IPC handlers

**Report to user**: List any existing code that appears to implement similar functionality, with file paths and brief descriptions.


### 3. Planning Docs Review

Check for recent or in-progress work on similar features:

```bash
# Check active planning docs
ls -la docs/plans/*.md

# Search planning docs for relevant terms
grep -r "featureKeyword" docs/plans/
grep -r "featureKeyword" docs/plans/finished/
```

**Look for:**
- [ ] Active plans (not in `finished/` or `obsolete/`) touching same area
- [ ] Recently finished plans that may have implemented something similar
- [ ] Obsolete plans that explain why a similar approach was abandoned

**Report to user**: "Found these relevant planning docs: [list with status and relevance]"


### 4. Target Code Inspection

Read the files you plan to modify and look for:

**Check for existing implementations:**
- Comments mentioning similar functionality (`// TODO:`, `// FIXME:`, `// NOTE:`)
- Existing functions/methods that might already do what you need
- Conditional logic that might already handle your use case
- Disabled or commented-out code that attempted something similar

**Check for architectural clues:**
- Patterns established in the file you should follow
- Dependencies already in use for similar problems
- Existing abstractions you should extend rather than duplicate

**Report to user**: "In the files you plan to modify, I found: [relevant existing code, patterns, or TODOs]"


### 5. Feature Rationale Validation

Challenge the feature itself:

**Questions to answer:**
1. What specific user problem does this solve?
2. Why hasn't it been built already? (Did someone try and abandon it? Is it intentionally not included?)
3. Could this be solved by configuring/extending existing functionality?
4. Is this the simplest solution to the problem?
5. Are there existing tools/libraries that already solve this?

**If any concerns arise**, discuss with user before proceeding. See [sounding-board-mode](../../rebel-system/skills/thinking/sounding-board-mode/SKILL.md) for structured discussion.


## Output Format

After running all checks, provide a summary:

```markdown
## Pre-Implementation Check: [Feature Name]

### Git Status
- Branch: `[branch]`
- Behind dev: [N commits / up to date]
- Potentially overlapping commits: [list or "none found"]

### Existing Code Search
- Similar implementations found: [list or "none found"]
- Related code to review: [list files]

### Planning Docs
- Active plans in same area: [list or "none"]
- Relevant finished plans: [list or "none"]

### Target Code Analysis
- Existing patterns to follow: [list]
- Related TODOs/FIXMEs: [list or "none"]
- Suggested approach based on existing code: [brief recommendation]

### Rationale Check
- [Pass/Concerns]: [brief explanation]

### Recommendation
[PROCEED / PROCEED WITH CAUTION / STOP AND DISCUSS]

[If not PROCEED, explain what needs to be resolved first]
```


## Important

- **Always run git fetch first** - stale local refs will miss recent work
- **Search broadly, then narrow** - start with general keywords, refine if too many results
- **Read commit messages carefully** - they often reveal intent better than code
- **Don't skip the rationale check** - duplicate features often happen because the "why" wasn't questioned
- **When in doubt, ask** - a 5-minute conversation can save hours of wasted work


## Examples

### Example: Before adding a "calendar sync" feature

```
Git: 3 commits behind dev
  - "feat(calendar): add Google Calendar MCP integration" ← RELEVANT
  - "fix(settings): calendar timezone handling"
  - "chore: update dependencies"

Codebase search:
  - src/main/services/calendarSyncService.ts ← EXISTS!
  - src/renderer/features/settings/components/CalendarSettings.tsx

Planning docs:
  - docs/plans/251228_google_oauth_consolidation.md (active) - mentions calendar

Recommendation: STOP AND DISCUSS
  - calendarSyncService.ts already exists
  - Recent commit added Google Calendar integration
  - Need to clarify: are you extending existing functionality or is this different?
```
