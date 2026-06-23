# Organizing Planning Documents

This guide describes how to periodically tidy up the `docs/plans/` folder by moving completed and obsolete planning documents to their appropriate subfolders.

## See Also

- `docs/plans/finished/` - Destination for completed planning docs
- `docs/plans/obsolete/` - Destination for superseded/abandoned planning docs
- `rebel-system/skills/documentation/write-planning-doc/SKILL.md` - How to write planning docs

## Overview

Planning documents accumulate in `docs/plans/` over time. Periodically reviewing and organizing them:
- Keeps the active folder focused on current/ongoing work
- Preserves institutional knowledge in categorized subfolders
- Makes it easier to find relevant active plans

## Folder Structure

```
docs/plans/
├── [active planning docs]     # Ongoing or recent work
├── finished/                  # Completed implementations
└── obsolete/                  # Superseded, abandoned, or diverged plans
```

## Classification Criteria

### FINISHED
Move to `finished/` when:
- The described work has been implemented in the codebase
- Key deliverables from the plan are present and working
- The plan explicitly marks itself as "complete" or "implemented"

### OBSOLETE
Move to `obsolete/` when:
- A newer planning doc supersedes this one
- The implementation diverged significantly from the plan
- The feature was abandoned or reverted
- The approach was replaced by a different solution

### ACTIVE (remain in main folder)
Keep in place when:
- Work is partially complete with remaining tasks
- The plan describes ongoing or upcoming work
- **The document is from the last 5 days** - always skip recent docs to avoid premature classification

## Process

### 1. Launch Parallel Review Agents

Launch **one subagent per document** (or very small batches of 2-3 related docs) to keep context windows focused. For each planning document:

```
Review the planning document at /path/to/docs/plans/YYMMDD_plan_name.md

Your task is to determine if this planning document should be:
1. FINISHED - The work described has been completed/implemented
2. OBSOLETE - The plan is no longer relevant (superseded, abandoned, or approach changed)
3. ACTIVE - Still relevant and work is ongoing or planned

To determine this:
1. Read the planning document to understand what it proposes
2. Search the codebase to see if the proposed changes have been implemented
3. Check for any related commits or changes that indicate completion
4. Look for newer planning docs that might supersede this one

Return a concise recommendation with:
- STATUS: FINISHED | OBSOLETE | ACTIVE
- EVIDENCE: Brief explanation of why (1-3 sentences)
- CONFIDENCE: HIGH | MEDIUM | LOW
```

### 2. Batch Move Files

After collecting recommendations, **move** (not copy) files to avoid duplicates:

```bash
cd docs/plans

# Move finished docs (use git mv for proper history tracking)
git mv 251201_feature_a.md 251202_feature_b.md finished/

# Move obsolete docs
git mv 251115_old_approach.md 251120_superseded.md obsolete/

# If a doc already exists in finished/ or obsolete/, delete the duplicate from main
rm 251203_already_moved.md
```

### 3. Commit with Summary

```bash
git add docs/plans/
git commit -m "chore(docs): organize planning docs into finished/obsolete folders

Reviewed N planning documents and categorized them:

Moved to finished/ (X docs):
- [Brief summary of major completed work]

Moved to obsolete/ (Y docs):
- [Brief summary of why obsolete]

~Z docs remain active (ongoing or recent work)"
```

## Tips

- **Skip recent docs**: Always exclude documents from the last 5 days to avoid premature classification
- **Prioritize older docs**: Start with the oldest documents (earliest date prefixes) as they're most likely to be finished or obsolete
- **Review before moving**: Present all recommendations to the user for approval before actually moving files
- **Batch similar docs**: Group related planning docs (same feature area) for review together
- **Trust explicit status**: If a doc explicitly says "Status: Complete" or "Implemented", trust it
- **Check git history**: `git log --oneline -- docs/plans/filename.md` shows when/why it was last touched
- **Look for superseding plans**: Newer docs often reference older ones they replace
- **When uncertain, leave active**: If confidence is low, keep the doc in the main folder

## Indicators of Completion

Strong signals a plan is FINISHED:
- Doc contains "Status: Complete/Implemented" header
- Key files/functions from the plan exist in codebase
- Related commits reference the plan or feature
- Newer docs reference this work as "already done"

Strong signals a plan is OBSOLETE:
- Newer plan explicitly supersedes it
- Key proposed files/patterns don't exist and different approach was taken
- Feature was implemented then reverted
- Doc proposes approach that conflicts with current codebase

## Maintenance Schedule

Consider running this process:
- Monthly for active projects
- Before major releases
- When `docs/plans/` exceeds ~50 active documents
