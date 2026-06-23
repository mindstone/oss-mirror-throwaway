---
description: "Periodic audit and update process for docs/project/ developer documentation"
last_updated: "2026-06-21"
---

# Developer Documentation Update Process

A periodic workflow for ensuring `docs/project/` documentation stays accurate, evergreen, and follows the signposting-over-duplication principle.

This process also covers `docs/research/` documentation (especially `docs/research/libraries/`) when those docs serve as the canonical reference for library-specific detail that `docs/project/` docs signpost to.

For **what to write, where it lives, and how to organise it** — including principles, doc genres, folder layout, signposting conventions, in-code signpost policy, and frontmatter — see [DEV_DOCUMENTATION](./DEV_DOCUMENTATION.md) (the canonical guide). This doc covers only the periodic-audit workflow.

## See Also

- [DEV_DOCUMENTATION](./DEV_DOCUMENTATION.md) — **canonical guide** for what to write and how to organise it
- [DOC_REACHABILITY](./DOC_REACHABILITY.md) — the ~4-hops reachability principle and `npm run audit:doc-reachability` (run in Phase 1)
- [CAREFUL_DOC_UPDATES_PROCESS](./CAREFUL_DOC_UPDATES_PROCESS.md) — per-batch workflow for risky doc edits (clarify → propose → wait → commit)
- [`write-help-evergreen-doc`](../../rebel-system/skills/documentation/write-help-evergreen-doc/SKILL.md) — user-facing variant of evergreen-doc guidance
- [`signposting-to-single-source-of-truth`](../../rebel-system/skills/documentation/signposting-to-single-source-of-truth/SKILL.md) — cross-referencing without duplication
- [HELP_FOR_HUMANS_UPDATE_PROCESS](./HELP_FOR_HUMANS_UPDATE_PROCESS.md) — similar process for user-facing docs
- [CHANGELOG_UPDATE_PROCESS](./CHANGELOG_UPDATE_PROCESS.md) — changelog updates (triggers this process in its follow-up)
- `docs/research/libraries/` — library-specific reference docs maintained alongside this process

> **Model routing**: run the Phase 1 scans/audits across agents in parallel, using a not-too-expensive model for large trawls (e.g. **Cursor Composer**); reserve frontier models for the review gates (Phase 3/5) — **GPT by default, Opus for contested calls**. See [MODEL_ROSTER](../../coding-agent-instructions/workflows/CHIEF_ENGINEER2/MODEL_ROSTER.md).


## Sync Pairs

Documents that must be kept in sync when either changes. Check the other when modifying one.

| Internal (source of truth) | User-facing (derivative) | Sync direction | Notes |
|---|---|---|---|
| `coding-agent-instructions/workflows/CHIEF_ENGINEER2/CHIEF_ENGINEER2.md` | `rebel-system/skills/workflows/software-engineer/SKILL.md` | Internal → User-facing | Quality philosophy, phase structure, review principles |
| `docs/project/MCP_SERVER_STANDARD.md` | `rebel-system/skills/coding/build-custom-mcp-server/references/mcp-development-standard.md` | Internal → User-facing | SDK patterns, naming, architecture, security |
| `docs/project/MCP_TESTING.md` + `MCP_IMPROVEMENT_WORKFLOW.md` | `rebel-system/skills/coding/build-custom-mcp-server/references/mcp-testing-guide.md` | Internal → User-facing | Testing strategy, patterns, debugging |


## When to Run This Process

- **After CHANGELOG_UPDATE_PROCESS** — When recent changes may affect developer docs
- **After major architectural changes** — When patterns or principles shift
- **After dependency upgrades or new library adoption** -- Refresh any affected `docs/research/libraries/` reference docs and the `docs/project/` signposts that depend on them
- **Periodically** — Monthly or quarterly to catch drift
- **Before onboarding** — Ensure docs are accurate for new team members


## Process Overview

### Phase 1: Identify What Needs Attention

1. **Review recent CHANGELOG.md entries**:
   - Focus on `[Developer-facing]` entries
   - Note architectural changes, new patterns, or deprecated approaches

2. **Quick scan of docs/project/**:
   - Identify docs related to recent changes
   - Note any docs with stale `last_updated` frontmatter (>3 months), or missing frontmatter (treat as needing review)
   - Flag docs that reference deprecated patterns or removed code

3. **Quick scan of docs/research/libraries/**:
   - For each library reference doc, compare documented version claims against root `package.json`
   - Use upstream changelogs, npm pages, or official docs to verify documented APIs, gotchas, and recommendations are current
   - Flag libraries heavily used in the codebase that don't yet have a reference doc
   - Check that `docs/project/` docs signpost to relevant library reference docs where helpful

4. **Cross-reference with codebase**:
   - For key docs, verify signposted file paths still exist
   - Check that documented patterns match current implementation

5. **Run the doc-reachability auditor** (`npm run audit:doc-reachability`):
   - Triage the **unreachable high-risk units**: add a small narrow signpost doc, or a link from the nearest `[TOPIC]_OVERVIEW.md` hub. Fix any **stale code references** it flags.
   - Full principle, tiers, and remedy guidance: [DOC_REACHABILITY](./DOC_REACHABILITY.md).


### Phase 2: Plan Updates

Categorise each doc needing attention:

| Action | When |
|--------|------|
| **Update signposts** | File paths changed, new related docs exist |
| **Update principles/decisions** | Approach has evolved, new decisions made |
| **Update library reference** | Library version claims stale, new gotchas to document |
| **Simplify** | Doc contains too much implementation detail that's now stale |
| **Create library reference** | Heavily-used library with Rebel-specific complexity lacks a reference doc |
| **Create new doc** | Feature/pattern exists with no documentation |
| **Archive or delete** | Feature removed, doc is redundant — **requires discussion** |
| **No change needed** | Doc is accurate and follows principles |

**When capturing decisions**: If rationale lives in a planning doc (`docs/plans/`) or PR, summarise the stable decision here (2-3 sentences) and signpost to the plan/PR for full context—don't duplicate the detail.

**For complex or risky updates**: Get input from `reviewer-gpt5.5-high` droid before making changes (see Phase 3).


### Phase 3: Execute Updates

#### Standard Updates (low risk)

For straightforward signpost fixes or minor updates:
- Make the change directly
- Update `last_updated` in frontmatter
- Verify cross-references are bidirectional

#### Complex or Risky Updates

When updating docs that involve:
- Architectural decisions or principles
- Information that could be misunderstood
- Changes affecting multiple docs
- Uncertainty about current patterns

**Get reviewer input first:**

```
Spawn reviewer-gpt5.5-high agent with (escalate to Opus for contested or high-stakes calls):

Review this documentation update for [DOC_NAME].

Context:
- Current doc: [path]
- Proposed changes: [summary of what's changing]
- Reason: [why the update is needed]

Please assess:
1. Does the update accurately reflect current patterns/decisions?
2. Are there any factual errors or misleading simplifications?
3. Does it follow signposting-over-duplication principles?
4. Any cross-references that should be added or updated?
5. Complexity concerns — is this over-documenting?

Output: Specific feedback on the proposed changes.
```

Apply reviewer feedback before committing.


### Phase 4: Verify and Commit

1. **Validate signposts**: Ensure all referenced files/paths exist; prefer `file path + symbol name` over brittle line numbers
2. **Check cross-references**: Verify bidirectional links where helpful (not required for every link)
3. **Frontmatter check**: Confirm `description` and `last_updated` are accurate; add frontmatter if missing
4. **Library freshness check**: For any touched `docs/research/libraries/` doc, verify version claims match `package.json` and upstream
5. **Commit**: Use descriptive message (e.g., "docs: update MCP_ARCHITECTURE signposts and clarify routing decisions")


## Frontmatter Standard

See [DEV_DOCUMENTATION § Frontmatter standard](./DEV_DOCUMENTATION.md#frontmatter-standard). When auditing, add frontmatter to any doc missing it.


## Documentation Quality Checklist

See [DEV_DOCUMENTATION § Quality checklist](./DEV_DOCUMENTATION.md#quality-checklist) for the standard per-doc checklist. For audit-only checks, additionally verify:

- [ ] Library version claims match current `package.json` and upstream sources
- [ ] Signposting adequate across `docs/project/` and `docs/research/libraries/`
- [ ] Complex/risky changes reviewed by `reviewer-gpt5.5-high`


## Phase 5: GPT Accuracy Review

Before committing, spawn `researcher-gpt5.5-high` (escalate to Opus for contested or high-stakes calls) to review all proposed doc changes for factual accuracy, correct signposting, and adherence to the principles above. Incorporate any corrections before proceeding. For substantial multi-doc or library-reference updates, also run at least one reviewer from a different model family (e.g., Gemini alongside GPT) when available.


## Output Checklist

After running this process:

- [ ] Relevant docs/project/ docs reviewed for accuracy
- [ ] Doc-reachability auditor run; unreachable high-risk units triaged and stale code refs fixed
- [ ] Library reference docs reviewed for version freshness where relevant
- [ ] Signposts updated for any moved/renamed files
- [ ] Stale implementation details simplified or removed
- [ ] Complex changes validated by reviewer
- [ ] Major refactors/deletions flagged (not executed unilaterally)
- [ ] Changes committed with descriptive message
