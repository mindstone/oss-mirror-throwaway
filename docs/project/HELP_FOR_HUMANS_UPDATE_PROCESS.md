---
description: "Periodic audit and update process for rebel-system/help-for-humans/ user-facing documentation"
last_updated: "2026-06-21"
---

# Help-for-Humans Update Process

A periodic workflow for ensuring `rebel-system/help-for-humans/` documentation stays accurate and comprehensive for end users and the Rebel agent.

## See Also

- [HELP_FOR_HUMANS_DOCUMENTATION](./HELP_FOR_HUMANS_DOCUMENTATION.md) — **Canonical writing guide**, quality checklist, and internal-to-user doc mapping
- [REBEL_SYSTEM_FILES](./REBEL_SYSTEM_FILES.md) — Directory structure and audience distinction
- [CHANGELOG_UPDATE_PROCESS](./CHANGELOG_UPDATE_PROCESS.md) — Changelog style and dual-changelog system
- [signposting-to-single-source-of-truth](../../rebel-system/skills/documentation/signposting-to-single-source-of-truth/SKILL.md) — Cross-referencing without duplication

> **Model routing**: run the Phase 3 per-area audits across agents in parallel, using a not-too-expensive model for large trawls (e.g. **Cursor Composer**); reserve frontier models for the Phase 5 review gate — **GPT by default, Opus for contested calls**. See [MODEL_ROSTER](../../coding-agent-instructions/workflows/CHIEF_ENGINEER2/MODEL_ROSTER.md).


## When to Run This Process

- **After major releases** — When new features ship that users or the agent should know about
- **Periodically** — Monthly or quarterly review to catch drift
- **After changelog updates** — Cross-reference recent changes to ensure docs reflect them


## Process Overview

### Phase 1: Gather Context

1. **Review recent changes**:
   - Read `CHANGELOG.md` for recent user-facing changes
   - Read `rebel-system/help-for-humans/changelog.md` for what's already documented
   - Note features/changes that may need doc updates

2. **Inventory current docs**:
   - List all files in `rebel-system/help-for-humans/`
   - Identify which feature areas each doc covers
   - Note any obvious gaps (features without docs)

3. **Cross-reference with codebase**:
   - Check `docs/project/` for features that should have user-facing equivalents
   - Review Settings UI, onboarding flow, and major features for coverage


### Phase 2: Plan Updates

For each doc area, determine:

| Action | When |
|--------|------|
| **Update existing doc** | Feature exists, doc exists but is outdated |
| **Create new doc** | Feature exists, no doc covers it |
| **Refactor/split doc** | Doc covers too much or is poorly organized |
| **Delete doc** | Feature removed or doc is redundant — **requires discussion** |
| **No change needed** | Doc is accurate and complete |

**Important**: Major refactors or deletions should be discussed with the team before proceeding. Flag these for review rather than acting unilaterally.


### Phase 3: Execute Updates

Spawn agents by feature area to work in parallel:

```
Feature Areas to Audit:
├── Core Concepts
│   ├── terminology.md
│   ├── how-it-works.md
│   ├── how-rebel-is-built.md
│   ├── getting-started.md
│   ├── why-rebel.md
│   ├── product-overview-and-features.md
│   └── migrating-from-other-ai-tools.md
├── Workspaces & Memory
│   ├── spaces.md
│   ├── space-shared-folders.md
│   ├── memory-folders-and-approvals.md
│   ├── where-rebel-stores-things.md
│   ├── starred-and-trash.md
│   └── google-drive-desktop-local-sync.md
├── Voice & Interaction
│   ├── voice-and-audio.md
│   ├── voice-dictation-apps.md
│   ├── voice-recorders.md
│   ├── elevenlabs-text-to-speech.md
│   ├── Rebel-interface.md
│   ├── keyboard-shortcuts-and-hotkeys.md
│   └── quick-open.md
├── Tools & Integrations
│   ├── mcp-connectors-tools-and-integrations.md
│   ├── browser-automation.md
│   ├── klavis-migration.md (migration guide)
│   └── connectors/ (individual connector docs)
│       ├── slack.md
│       ├── google-workspace.md
│       ├── microsoft-365.md
│       ├── notion.md
│       ├── hubspot.md
│       ├── salesforce.md
│       ├── zendesk.md
│       ├── figma.md
│       ├── disabling-connectors.md
│       └── (40+ total — one per catalog connector)
├── AI & Models
│   ├── AI-models.md
│   ├── multi-model-council-mode.md
│   ├── session-modes.md
│   ├── using-skills.md
│   └── architecture-technical-description.md
├── Features
│   ├── automations.md
│   ├── inbox.md
│   ├── inbound-triggers.md
│   ├── scratchpad.md
│   ├── the-spark.md
│   ├── file-search.md
│   ├── file-attachments.md
│   ├── searching-conversations.md
│   ├── conversation-drafts.md
│   ├── reply-comment-annotations.md
│   ├── meetings-and-notetaker.md
│   ├── running-big-jobs-unleashed-auto-done.md
│   ├── time-saved-estimation.md
│   ├── Markdown.md
│   ├── privacy-mode.md
│   ├── safe-mode.md
│   └── demo-mode.md
├── Settings & Configuration
│   ├── settings-and-configuration.md
│   ├── permissions.md
│   ├── security-and-tool-safety.md
│   ├── secrets-and-passwords.md
│   ├── variables-and-user-info.md
│   └── re-running-onboarding.md
├── Troubleshooting
│   ├── troubleshooting.md
│   ├── diagnostics-logging.md
│   ├── undoing-AI-changes.md
│   ├── clean-reinstall-and-factory-reset.md
│   ├── using-rebel-on-multiple-devices.md
│   ├── windows-installer-upgrade.md
│   └── windows-security-and-antivirus.md
├── Policies
│   └── Rebel-privacy-policy.md
└── Tutorials & Guides
    ├── external-IDE-OBSOLETE/ (deprecated)
    ├── coding-setup-with-Python.md
    ├── Mixpanel-API-access.md
    └── Notion-access-and-syncing.md
```

**Agent prompt template:**
```
Audit and update help-for-humans docs for [FEATURE AREA].

Context:
- Read REBEL_SYSTEM_FILES.md for writing guidelines
- Review recent CHANGELOG.md entries for [FEATURE AREA]
- Compare against codebase (docs/project/[RELATED_DOC].md, relevant src/ code)

Tasks:
1. Read current help-for-humans doc(s) for this area
2. Identify what's outdated, missing, or incorrect
3. Update docs following REBEL_SYSTEM_FILES.md guidelines
4. Add cross-references to related help docs where helpful
5. Ensure YAML frontmatter has accurate description

Output:
- Summary of changes made
- Any issues requiring human discussion (deletions, major refactors)
```


### Phase 4: Review & Commit

1. **Self-review**: Check all updated docs against the quality checklist in REBEL_SYSTEM_FILES.md
2. **Cross-reference check**: Ensure links between docs are bidirectional where appropriate
3. **Commit**: Use descriptive commit message summarizing areas updated
4. **Submodule update**: Push rebel-system changes, update pointer in main repo


## Guidelines for Specific Actions

### Adding New Docs

When a feature needs a new help doc:

1. Check if it should be a standalone doc or a section in an existing doc
2. Follow the signposting principle — link to related docs, don't duplicate
3. Add cross-references FROM existing docs TO the new doc
4. Use YAML frontmatter with description
5. Match the naming convention: `feature-name.md` (hyphenated, lowercase)

### Updating Existing Docs

1. Preserve the existing structure where it works well
2. Update outdated information; don't just append
3. Remove obsolete content (features that no longer exist)
4. Update cross-references if related features changed

### Refactoring Docs

For minor refactoring (within a single doc):
- Proceed if it improves clarity or organization
- Note the change in commit message

For major refactoring (splitting, merging, renaming):
- **Flag for discussion** before proceeding
- Document the proposed change and rationale
- Wait for approval before executing

### Deleting Docs

**Always flag for discussion**. Reasons to delete:
- Feature was removed from the app
- Content was merged into another doc
- Doc is completely redundant

Provide:
- Which doc to delete
- Why it's no longer needed
- Where users should look instead (if applicable)


## Changelog Cross-Reference

When auditing, use the changelogs as a source of truth for recent changes:

1. **Internal changelog** (`CHANGELOG.md`): Has detailed timestamps and covers developer-facing changes too
2. **User changelog** (`rebel-system/help-for-humans/changelog.md`): Already summarized for users

Focus on `[User-facing]` entries from the internal changelog that might need deeper documentation beyond the changelog entry.


## User-Facing Language Guidelines

The user changelog and help docs are read by non-technical users. Avoid leaking implementation details:

**Never mention:**
- Internal tooling names (Squirrel, Electron Forge, Vite, etc.)
- Package managers or build systems (npm, webpack, etc.)
- Programming language internals (Python PATH, Node.js, etc.)
- OS-specific developer concepts (Microsoft Store app aliases, symlinks, etc.)
- Internal component names or architecture terms

**Instead, describe the user impact:**
| Technical reality | User-facing description |
|-------------------|------------------------|
| "Fixed Squirrel update paths" | "Connectors repair themselves after app updates" |
| "Python PATH conflict with MS Store" | Skip entirely, or "Scripts run more reliably" |
| "Electron IPC race condition" | "Startup is more reliable" |
| "Zod schema validation" | Skip entirely (internal) |

**Rule of thumb:** If a user would need to Google the term to understand it, rephrase or omit it.


## Phase 5: GPT Accuracy Review

Before committing, spawn `researcher-gpt5.5-high` (escalate to Opus for contested or high-stakes calls) to review all proposed doc changes for factual accuracy, correct user-facing language, and adherence to the guidelines above. Incorporate any corrections before proceeding.


## Output Checklist

After running this process:

- [ ] All help-for-humans docs reviewed for accuracy
- [ ] Outdated content updated or removed
- [ ] New docs created for undocumented features (if any)
- [ ] Cross-references added/updated between related docs
- [ ] YAML frontmatter accurate on all docs
- [ ] Major refactors/deletions flagged (not executed unilaterally)
- [ ] Changes committed with descriptive message
- [ ] rebel-system submodule pointer updated (if applicable)
