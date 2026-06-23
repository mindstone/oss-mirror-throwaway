---
description: "Human-in-the-loop process for high-stakes Markdown updates — clarify intent, propose diffs, inspect, commit in small batches"
last_updated: "2026-05-14"
---

# Careful Doc Updates Process

A lightweight, human-in-the-loop process for making changes to **important `.md` files** — workflow docs, project conventions, planning docs, agent instructions — where mistakes are expensive and reasoning matters as much as wording.

Use this when:
- The doc shapes how agents or humans work (CHIEF_ENGINEER, CODING_PRINCIPLES, AGENTS.md, skill files, etc.)
- The doc encodes hard-won decisions and rationale
- A wrong edit could propagate across many future sessions before being caught
- The user wants to think alongside the agent rather than approve a fait accompli

If the doc is low-stakes (a typo fix, a stale link, a small README update), skip this process and just make the edit.

---

## The Process

For each **set of related changes** (typically one stage of a multi-stage doc rework, or one logical sub-edit of a standalone doc):

### 1. Clarify intent before editing

- **Ask the user focused questions** to clarify intent, scope, and decisions. Prefer multiple-choice (via `AskUser`) over open-ended prose questions.
- **Provide options** with brief tradeoffs so the user can guide the decision without having to generate them from scratch.
- **Help manage cognitive load.** Don't dump every possible consideration at once — surface the genuinely consequential decisions. Hide the bikeshed.
- **Raise concerns or suggestions.** If you see a better alternative, a risk, an inconsistency, or a missing consideration, name it. The user wants your judgment, not just your obedience.
- **Stop and wait for the user's answers** before proposing the actual edit.

### 2. Propose surgical changes

- Once you have direction, **make surgical edits** — narrowly scoped, minimal diff, no opportunistic refactors.
- Show the **actual diff against the target file**, not a long synthesis or summary. The user's review energy should go into the source-file change, not into reading your meta-commentary.
- **Do not commit yet.**

### 3. Wait for user inspection

- **Pause and let the user inspect** the change in place.
- The user may:
  - Approve as-is
  - Request tweaks (iterate on the diff)
  - Reject and ask for a different approach (return to step 1)
- Do not auto-proceed to the next set of changes while the current diff is pending review.

### 4. Commit on explicit authorisation

- **Only commit when the user authorises** the commit for this specific change.
- Use path-scoped `git add` — include only the files agreed in this round. Do not opportunistically sweep in unrelated tracked or untracked files (see the repo's multi-agent guard rules).
- Use a descriptive commit message that explains **why**, not just **what**. Reference the planning doc and stage if applicable.
- If the repo requires AI provenance trailers or other commit-message conventions, include them.

### 5. Move to the next set of changes

- Briefly recap what landed.
- Surface what's next.
- Return to step 1.

---

## Principles

- **Small batches over big drops.** One logical change per round. Easier to review, easier to revert, easier to think about.
- **Decisions in conversation, edits in the file.** Don't bake unresolved decisions into a diff and hope the user notices. Resolve them in chat first.
- **Verbatim over paraphrase when capturing intent.** When the user states a preference, constraint, or reasoning, prefer to capture their wording in the doc rather than your interpretation.
- **Re-read the source of truth often.** On any non-trivial doc rework, re-open the target file before editing — agent context drifts, planning docs lag, and the on-disk version is what actually ships.
- **Plan-doc hygiene.** If the change is one stage of a multi-stage plan, update the plan's `Status`, `Implementation Notes`, and `Current State → Next stage` fields **before** committing, in the same atomic commit as the source-doc change.
- **Concerns are not delays.** Naming a risk or a better alternative is part of the work, not an interruption to it.

---

## When NOT to use this process

- Routine code changes (use CHIEF_ENGINEER or similar coding workflows instead).
- Trivial typo / link / formatting fixes.
- Bulk renames or mechanical sweeps where the decision has already been made and the per-file edits are uniform.
- Doc generation from code (changelogs, API references) where the doc is downstream of structured input.
