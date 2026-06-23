---
name: sync-linear-tickets
description: "Sync ongoing work with Linear tickets. Finds work from git branches/commits, creates tickets if missing, syncs status based on merge state, and prompts testing for tickets in review >24 hours."
last_updated: 2026-01-20
agent_type: main_agent
---

# Sync Linear Tickets

Use this when you need to: (1) ensure all ongoing development work has corresponding Linear tickets, (2) keep ticket status in sync with actual git state, (3) identify work ready for testing.

## [AGENT USE]

- Discover ongoing work from git branches and recent commits
- Check Linear for existing tickets matching the work
- Create missing tickets with proper team/label conventions
- Sync ticket status based on merge state (merged → In Review)
- Surface tickets that have been In Review >24 hours for testing prompts

## [PERSONA]

You are a meticulous project coordinator who keeps Linear tickets synchronized with actual development work. You understand git workflows, can identify ticket references in commits and branches, and ensure nothing falls through the cracks.

## [GOAL]

Maintain unidirectional sync (git → Linear) between active development work and Linear tickets, ensuring all work is tracked, status reflects git reality, and completed work is promptly tested.

## [CONTEXT]

- Works with Factory Droid sessions by examining their git footprint (branches, commits)
- Uses Linear MCP for ticket operations
- Follows FOX team conventions (REBEL/LEARNING labels)
- Ticket numbers in commits/branches follow pattern: `FOX-XXX`
- Merged work should move to "In Review" status for testing
- Tickets in "In Review" >24 hours need testing prompts

## [PREREQUISITES]

- Linear MCP connected (see [Settings → Connectors](rebel://settings/tools))
- Git repository with standard branching conventions
- Access to git log and branch information
- Run `git fetch --prune` before sync to ensure up-to-date remote state

## [INPUTS]

```yaml
mode: "full-sync" | "status-only" | "create-missing" | "test-prompts"
options:
  days_lookback: 14                        # How many days of work to consider
  include_branches: true                   # Check active branches
  include_commits: true                    # Check recent commits
  auto_create: false                       # Create tickets without approval (default: ask)
  test_prompt_threshold_hours: 24          # Hours in Review before prompting
  dry_run: false                           # Preview changes without executing
```

## [PROCESS]

### Phase 0: Prepare

1. **Fetch latest remote state**
   ```bash
   git fetch --prune
   ```

### Phase 1: Discover Active Work

1. **List active git branches**
   ```bash
   git branch -a --sort=-committerdate | head -20
   git for-each-ref --sort=-committerdate --format='%(refname:short) %(committerdate:relative) %(subject)' refs/heads/ | head -20
   ```

2. **Extract recent commits with potential ticket references**
   ```bash
   git log --oneline --since="14 days ago" --all
   git log --oneline --author="$(git config user.name)" --since="14 days ago"
   ```

3. **Identify ticket references**
   - Pattern: `(?i)FOX-\d+` in branch names, commit messages (case-insensitive)
   - Also check for descriptive work (branches without ticket numbers)
   
4. **Build work inventory**
   ```yaml
   discovered_work:
     - source: "branch"
       name: "feature/add-dark-mode"
       ticket_ref: null
       last_activity: "2 hours ago"
       description: "Inferred from branch name: add dark mode feature"
       
     - source: "commit"  
       name: "Fix OAuth callback handling"
       ticket_ref: "FOX-2145"
       last_activity: "1 day ago"
       merged: false
   ```

### Phase 2: Match with Linear Tickets

1. **For work WITH ticket references (FOX-XXX)**
   - Fetch ticket from Linear: `linear___get_issue(id: "FOX-XXX")`
   - Record ticket status, assignee, last update
   
2. **For work WITHOUT ticket references**
   - Search Linear team-wide first (to avoid duplicates regardless of assignee):
     ```
     linear___list_issues(
       query: "<inferred description>",
       team: "FOX",
       limit: 20
     )
     ```
   - Also search by branch name pattern:
     ```
     linear___list_issues(
       query: "<branch-name-keywords>",
       team: "FOX",
       limit: 10
     )
     ```
   - Attempt fuzzy matching on title/description
   - Flag as "potentially missing ticket" if no match found

3. **Build match report**
   ```yaml
   matched_tickets:
     - work: "feature/fix-oauth-callback"
       ticket: "FOX-2145"
       status: "In Progress"
       synced: true
       
   unmatched_work:
     - work: "feature/add-dark-mode"
       suggested_title: "Feature: Add dark mode support"
       confidence: "high"
       reason: "No ticket found matching branch name"
   ```

### Phase 3: Check Merge Status

1. **For each matched ticket, check if work is merged**
   ```bash
   # Check if branch is merged to main/dev (exact match with grep -Fx)
   git branch --merged origin/main | grep -Fx "  feature-branch-name"
   git branch --merged origin/dev | grep -Fx "  feature-branch-name"
   
   # Check merge commits for ticket references (first-parent for cleaner mainline history)
   git log --oneline --first-parent --grep="FOX-XXX" origin/main --since="7 days ago"
   
   # Also check squash merges and regular commits
   git log --oneline --grep="FOX-XXX" origin/main --since="7 days ago"
   ```

2. **Identify status mismatches**
   ```yaml
   status_mismatches:
     - ticket: "FOX-2138"
       current_status: "In Progress"
       detected_state: "merged"
       recommended_status: "In Review"
       evidence: "Branch merged to main 2 days ago"
   ```

### Phase 4: Create Missing Tickets (if auto_create or approved)

1. **For each unmatched work item, propose ticket**
   ```yaml
   proposed_tickets:
     - title: "Feature: Add dark mode support"
       description: |
         ## Task
         Add dark mode support to the application.
         
         ## Context
         Discovered from active branch: feature/add-dark-mode
         
         ## Source
         - Branch: feature/add-dark-mode
         - First commit: <hash>
         - Last activity: 2 hours ago
       team: "FOX"
       assignee: "me"
       labels: ["REBEL"]
       state: "In Progress"  # Already being worked on
   ```

2. **Get approval (unless auto_create)**
   ```
   I found 2 pieces of work without Linear tickets:
   
   1. **feature/add-dark-mode** → "Feature: Add dark mode support"
   2. **feature/improve-search** → "Feature: Improve search performance"
   
   Shall I create these tickets? (yes/no/modify)
   ```

3. **Create approved tickets via Linear MCP**
   ```
   linear___create_issue(
     title: "Feature: Add dark mode support",
     description: "## Task\n...",
     team: "FOX",
     assignee: "me",
     labels: ["REBEL"],
     state: "In Progress"
   )
   ```

### Phase 5: Sync Ticket Status

1. **Verify current state before updating (conflict-safe)**
   ```
   # First check current state to avoid race conditions
   current = linear___get_issue(id: "FOX-2138")
   if current.state != "In Review" and current.state != "Done":
       # Safe to update
   ```

2. **Update tickets where merge detected but status not "In Review"**
   ```
   linear___update_issue(
     id: "FOX-2138",
     state: "In Review"
   )
   ```

3. **Add timestamped comment for tracking review duration**
   ```
   linear___create_comment(
     issueId: "FOX-2138",
     body: "✅ Work merged to main. Moving to In Review for testing.\n\n**Evidence**\n- Merged to `main` (commit: <hash>)\n- PR: <url>\n\n**How to test**\n- <repro/test steps>\n\n_Sync timestamp (UTC): 2026-01-20T10:30:00Z_"
   )
   ```
   
   > **Note**: The comment timestamp is used to calculate "time in review" since Linear's `updatedAt` changes on any edit. Look for comments starting with "✅ Work merged" to determine actual review start time.

### Phase 6: Generate Test Prompts

1. **Find tickets in "In Review" status**
   ```
   linear___list_issues(
     team: "FOX",
     state: "In Review",
     assignee: "me"
   )
   ```

2. **Calculate time in review using sync comment**
   For each ticket:
   ```
   comments = linear___list_comments(issueId: "FOX-XXX")
   sync_comment = find comment starting with "✅ Work merged"
   if sync_comment:
       review_start = parse timestamp from sync_comment
       hours_in_review = now - review_start
   else:
       # Fallback to updatedAt (less accurate)
       hours_in_review = now - ticket.updatedAt
   ```
   - Flag tickets where `hours_in_review > threshold` (default 24 hours)
   - **Note**: Fallback to `updatedAt` may undercount time if ticket was edited recently

3. **Generate test prompt report**
   ```markdown
   ## 🧪 Tickets Ready for Testing
   
   The following tickets have been in Review for over 24 hours:
   
   1. **FOX-2138** - Bug: OAuth callback handling (In Review for 2 days)
      - Last updated: 2026-01-18
      - Linear: FOX-2138
      - **Suggested test**: Verify OAuth flow works for Google and GitHub providers
      
   2. **FOX-2140** - Feature: Dark mode (In Review for 36 hours)
      - Last updated: 2026-01-19
      - Linear: FOX-2140
      - **Suggested test**: Check dark mode toggle, verify colors in all screens
   
   Would you like to mark any of these as tested? (Or I can move them to Done)
   ```

## [IMPORTANT]

- **Write for future readers**: avoid relative language ("yesterday"), use ISO-8601 timestamps, and include **Evidence** + **How to test** so someone can verify the state later.
- **Never create duplicate tickets** - always search thoroughly before creating
- **Preserve existing ticket context** - when updating, add comments rather than overwriting
- **Get approval before creating** - unless explicitly running with auto_create
- **Respect ticket ownership** - only sync tickets assigned to current user by default
- **Git evidence is source of truth** for merge status - Linear status follows git state
- **24-hour threshold is configurable** - some teams may want longer/shorter

## [TEMPLATE]

### Sync Report

```markdown
# Linear Ticket Sync Report
Generated: YYYY-MM-DD HH:MM

## Summary
- Active work items discovered: X
- Matched to existing tickets: Y
- Missing tickets (to create): Z
- Status updates needed: N
- Tickets ready for testing: M

## Ticket Matches
| Work Item | Ticket | Status | Synced |
|-----------|--------|--------|--------|
| feature/oauth-fix | FOX-2145 | In Progress | ✅ |
| feature/dark-mode | — | Missing | ❌ |

## Status Updates
| Ticket | Current | Recommended | Reason |
|--------|---------|-------------|--------|
| FOX-2138 | In Progress | In Review | Merged to main 2 days ago |

## Test Prompts (In Review >24h)
| Ticket | Title | Time in Review | Suggested Test |
|--------|-------|----------------|----------------|
| FOX-2140 | Dark mode | 36 hours | Toggle test, color verification |

## Actions Taken
- Created ticket FOX-2150 for "feature/dark-mode"
- Updated FOX-2138 status to In Review
- Added sync comments to 2 tickets
```

### Ticket Creation Preview

```markdown
## Proposed New Tickets

### 1. Feature: Add dark mode support
**Team**: FOX | **Label**: REBEL | **Status**: In Progress

**Description:**
> ## Task
> Add dark mode support to the application.
>
> ## Context
> Discovered from active branch `feature/add-dark-mode`.
>
> ## Evidence / Source
> - Branch: `feature/add-dark-mode`
> - First commit: <hash>
> - Last activity (UTC): 2026-01-20T10:30:00Z
>
> ## How to test
> - <manual test steps>
>
> ## Notes / Risks
> - <any user-impact/rollback notes>

---

Create these tickets? [yes / no / modify]
```

## [OUTPUT]

### Full Sync Result

```
🔄 Linear Ticket Sync Complete

**Discovered:** 8 active work items
**Matched:** 6 existing tickets
**Created:** 2 new tickets
**Updated:** 1 status change (In Progress → In Review)

### New Tickets Created
- **FOX-2150** - Feature: Add dark mode support
  Linear: FOX-2150
  
- **FOX-2151** - Feature: Improve search performance  
  Linear: FOX-2151

### Status Updates Applied
- **FOX-2138** - Bug: OAuth callback → Moved to In Review
  (Reason: Branch merged to main 2 days ago)

### 🧪 Ready for Testing (In Review >24h)
1. **FOX-2140** - Dark mode feature (36h in review)
2. **FOX-2138** - OAuth fix (just moved, will prompt tomorrow)

Would you like to test any of these now?
```

## [SUCCESS]

- All active work has corresponding Linear tickets
- Ticket status accurately reflects git merge state
- No duplicate tickets created
- User prompted to test work that's been waiting
- Clear audit trail via ticket comments

## [COMMON PATTERNS]

### Morning Sync
Run at start of day to:
1. Catch any work from yesterday that needs tickets
2. Update statuses for merged PRs
3. Surface tickets ready for testing

### Pre-PR Check
Before creating a PR:
1. Ensure ticket exists for the work
2. Verify ticket is in correct status
3. Add PR link to ticket

### End of Sprint Cleanup
At sprint end:
1. Find orphaned branches without tickets
2. Move merged work to appropriate status
3. Close out tested tickets

## [LIMITATIONS]

- **Session data access**: Cannot directly read Factory Droid session metadata; relies on git footprint
- **Fuzzy matching**: May miss tickets with very different naming conventions
- **Multi-repo**: Currently designed for single repository workflows
- **Time detection**: Uses sync comment timestamp when available; falls back to `updatedAt` which is less accurate (resets on any edit)
- **Multi-developer**: If multiple people work on the same ticket, sync may conflict; skill respects current state to avoid overwriting external changes
- **Race conditions**: Mitigated by check-before-update pattern, but not fully eliminated in high-concurrency scenarios

## [ERROR HANDLING]

- **Linear MCP timeout**: Retry once after 5 seconds; if still failing, skip that ticket and continue with others
- **Ticket not found**: Log warning and skip; may indicate deleted ticket or permission issue
- **Git command failure**: Abort sync and report error; git state must be reliable
- **Partial completion**: Report which items succeeded vs failed; allow user to retry failed items

## [RELATED SKILLS]

- [linear-mcp-work-with](../../rebel-system/skills/communication/linear-mcp-work-with/SKILL.md) - Core Linear MCP operations
- [GIT_COMMIT_CHANGES](../../coding-agent-instructions/docs/GIT_COMMIT_CHANGES.md) - Git workflow conventions

## See Also

- [LINEAR_MCP.md](./mcps/LINEAR_MCP.md) - Linear MCP setup and troubleshooting
