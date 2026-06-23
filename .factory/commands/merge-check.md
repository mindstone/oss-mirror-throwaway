---
description: Triple-review a merge/rebase to verify nothing was lost and conflicts were handled correctly
argument-hint: <branch or commit range, e.g. "origin/dev..dev" or "last rebase">
---

Launch all three reviewer droids **in parallel** to audit a merge or rebase operation. Each reviewer verifies from a different angle:

1. **reviewer-gpt5.5-high** - Fast scan for obvious losses, conflict markers, broken references
2. **reviewer-gemini3.1-pro** - Different perspective on merge strategy and commit coherence
3. **reviewer-opus4.7-thinking** - Deep analysis of conflict resolutions and architectural integrity

## Context Detection

First, gather context about what happened:

```bash
# Check current state
git status
git log --oneline -1

# Find what was merged/rebased (use $ARGUMENTS if provided, otherwise detect)
git reflog -10  # Look for rebase/merge operations

# If backup branch exists, compare against it
git branch --list 'backup-*' | head -5
```

## Instructions

1. **Detect the operation**: Identify what merge/rebase just happened
   - Check `git reflog` for recent rebase/merge
   - Look for backup branches (e.g., `backup-dev-before-rebase-*`)
   - Use `$ARGUMENTS` if provided (e.g., a commit range)

2. **Gather the evidence**:
   ```bash
   # Commits that were rebased/merged
   git log --oneline <old_base>..<new_head>
   
   # Files changed in the operation
   git diff --stat <old_base>..<new_head>
   
   # If backup exists, compare what changed
   git diff <backup_branch>..HEAD --stat
   git log --oneline <backup_branch>..HEAD
   git log --oneline HEAD..<backup_branch>  # Anything lost?
   ```

3. **Launch all 3 reviewers simultaneously** with the Task tool

4. **Each reviewer checks**:
   - Were any commits lost? (compare backup branch if available)
   - Are there leftover conflict markers (`<<<<<<<`, `=======`, `>>>>>>>`) in any files?
   - Do submodules point to valid, pushed commits?
   - Were conflict resolutions sensible? (examine files that had conflicts)
   - Is the commit history clean and logical?
   - Any files that disappeared unexpectedly?

5. **Synthesize findings** into a unified report

## Prompt Template for Each Reviewer

> Audit this merge/rebase operation for integrity.
>
> **Operation detected:** <rebase onto X / merge of Y into Z>
>
> **Commit range:** `$ARGUMENTS` (or auto-detected range)
>
> **Backup branch:** <if exists>
>
> **Your tasks:**
>
> 1. Run these commands to understand what happened:
>    ```bash
>    git status
>    git reflog -10
>    git log --oneline <range> 
>    git diff --stat <range>
>    git submodule status
>    ```
>
> 2. Check for problems:
>    - **Lost commits**: Compare backup branch (if any) to current HEAD
>    - **Conflict markers**: `grep -r "<<<<<<" src/` and other source dirs
>    - **Submodule integrity**: Are submodule pointers valid and pushed?
>    - **File deletions**: Any unexpected files removed?
>    - **Broken imports**: Quick grep for imports of deleted/moved files
>
> 3. If conflicts were resolved, examine the resolution:
>    - Were both sides' changes preserved appropriately?
>    - Any "ours" or "theirs" resolutions that lost important code?
>
> **Focus area:** $ARGUMENTS
>
> Provide your confidence level (0-100%) and categorize issues as:
> - **CRITICAL**: Data loss, broken builds, conflict markers left in
> - **WARNING**: Suboptimal resolution, missing tests, needs attention
> - **INFO**: Observations, suggestions for future

## Checklist for Synthesis

After all reviewers report, create a unified summary:

### Integrity Verification
- [ ] All original commits accounted for (none lost)
- [ ] No conflict markers in codebase
- [ ] Submodules point to valid, reachable commits
- [ ] No unexpected file deletions
- [ ] Build/lint passes (suggest running `npm run validate:fast`)

### Conflict Resolution Quality
- [ ] Conflicts resolved sensibly (both sides considered)
- [ ] No "scorched earth" resolutions (blindly taking one side)
- [ ] Related changes stayed coherent

### Ready to Push?
- **YES**: All checks pass, safe to `git push`
- **NO**: Issues found, list what needs fixing first
