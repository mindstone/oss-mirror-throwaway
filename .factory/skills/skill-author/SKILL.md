---
name: skill-author
description: Creates and modifies skill files, workflow docs, reference docs, CI workflows, and TypeScript scripts following existing rebel-system and repo patterns.
---

# Skill Author

NOTE: Startup and cleanup are handled by `worker-base`. This skill defines the WORK PROCEDURE.

## When to Use This Skill

Use for features that create or modify:
- Skill files (`SKILL.md`) in `rebel-system/skills/`
- Workflow files (`SKILL.md`) in `rebel-system/workflows/`
- Reference docs in `rebel-system/*/references/`
- Working document templates
- GitHub Actions workflow YAML files
- TypeScript scripts in `scripts/`
- Internal documentation sync notices

## Required Skills

None. This worker type uses standard file tools and shell commands.

## Work Procedure

### Step 1: Read Context

1. Read the planning doc: `docs/plans/260409_productionise_build_custom_mcp_server.md` — find the stage(s) relevant to your feature.
2. Read the mission AGENTS.md for boundaries and conventions.
3. Read `.factory/library/architecture.md` for the overall architecture and derivation chain.
4. Read the feature description carefully — it contains specific requirements and references.

### Step 2: Study Existing Patterns

Before creating any file, read the relevant pattern exemplar:

- **For skill SKILL.md**: Read `rebel-system/skills/coding/build-custom-mcp-server/SKILL.md` — note YAML frontmatter (`name`, `description`), H1 title, reference doc listing, phase structure.
- **For workflow SKILL.md**: Read `rebel-system/workflows/showrunner/SKILL.md` — note NO YAML frontmatter, H1 title, overview, philosophy, phases, artifacts, working document section, handoff templates, quick reference, checklist.
- **For reference docs**: Read `rebel-system/skills/coding/build-custom-mcp-server/references/mcp_best_practices.md` — note H1, overview section, structured subsections, standalone readability.
- **For working document templates**: Read `rebel-system/workflows/showrunner/references/working-document-template.md` — note placeholder YAML frontmatter, required sections.
- **For internal source docs being derived**: Read the upstream source document(s) specified in the feature description. Identify topics to include vs. topics to strip (internal infrastructure).
- **For TypeScript scripts**: Read neighboring scripts in `scripts/` to understand imports, patterns, error handling.
- **For GitHub Actions**: Read existing workflows in `.github/workflows/` to understand conventions.

### Step 3: Plan Content

Before writing, enumerate:
- What sections/phases must the file contain?
- What cross-references must be included?
- What sync notices are needed?
- What content must be stripped (for derived docs)?
- What existing content must NOT be duplicated (check existing reference docs)?

### Step 4: Create/Modify Files

Write the file(s) following the patterns identified in Step 2. Key rules:

**For skill SKILL.md files:**
- YAML frontmatter with `name` (matching folder name) and `description`
- H1 title
- Reference doc listing near the top (if the skill has references)
- Phase-based structure for procedural skills
- `[IMPORTANT]` section for critical invariants
- Troubleshooting section if relevant

**For workflow SKILL.md files:**
- NO YAML frontmatter (matching showrunner)
- H1 title
- Overview/introduction section
- Philosophy/principles
- Phases section with clear numbered phases
- Artifacts section
- Working document section linking to template
- Handoff templates if delegating to subagents
- Quick reference / checklist

**For reference docs:**
- H1 near top
- Overview/purpose section
- Structured subsections
- Standalone readability (no "see above" dependencies)
- Sync notice near top (for derived docs): `> **Sync Notice** — Derived from \`path\` (YYYY-MM-DD). Internal doc is the upstream source of truth.`

**For sync notices on upstream docs:**
- Add after the overview/introduction section
- Format: `> **User-facing derivative:** \`path\`. When updating core principles or phase structure, check whether changes should propagate.`

**For TypeScript scripts:**
- Follow existing patterns in `scripts/`
- Use same import style, error handling, logging
- Add appropriate TypeScript types
- Include JSDoc comments for exported functions

**For GitHub Actions YAML:**
- Follow existing workflow patterns
- Use `actions/checkout@v4`
- Clear step names
- Proper error handling

### Step 5: Validate Cross-References

After creating/modifying files:
1. Verify all relative markdown links resolve to existing files
2. Verify all sync notices reference correct paths
3. Verify bidirectional sync notices exist (both directions)
4. Verify reference docs listed in skill files actually exist

### Step 6: Handle Submodule Commits

If you modified files in `rebel-system/` or `coding-agent-instructions/`:
1. `cd` into the submodule directory
2. `git add` the changed files
3. Commit with descriptive message: `<type>(<scope>): <summary>`
4. Return to rebel-app root
5. Stage the submodule pointer: `git add rebel-system` or `git add coding-agent-instructions`

### Step 7: Run Validation

- If you modified TypeScript in `scripts/`: run `npm run test` and verify no regressions
- If you modified any files: run `npm run validate:fast` as baseline
- For all features: verify the produced files match the structural patterns from Step 2

### Step 8: Commit

Commit all changes (including submodule pointer updates) with a descriptive message following the repo's commit format. Include AI provenance trailers.

## Example Handoff

```json
{
  "salientSummary": "Created mcp-development-standard.md derived from MCP_SERVER_STANDARD.md, covering SDK patterns, naming contract, module architecture, error handling, security baseline, and packaging. Verified no internal details leaked, sync notice present, all cross-references valid. Ran validate:fast — passed.",
  "whatWasImplemented": "New reference doc at rebel-system/skills/coding/build-custom-mcp-server/references/mcp-development-standard.md. Covers: McpServer+Zod SDK pattern, tool annotations, snake_case naming with service prefix, canonical param names, backwards-compatible renames, module splitting guidance, acyclic dependency layering, shared error wrapper, security baseline (file perms, atomic writes, Zod validation, path traversal prevention, request timeouts), ESM packaging. Sync notice cites MCP_SERVER_STANDARD.md as upstream. Strips: Sentry/PostHog, bundled build scripts, internal catalog management, migration status tables.",
  "whatWasLeftUndone": "",
  "verification": {
    "commandsRun": [
      { "command": "npm run validate:fast", "exitCode": 0, "observation": "All checks passed" },
      { "command": "cd rebel-system && git diff --name-only HEAD~1", "exitCode": 0, "observation": "Only skills/coding/build-custom-mcp-server/references/mcp-development-standard.md changed" }
    ],
    "interactiveChecks": [
      { "action": "Verified sync notice at top of file cites docs/project/MCP_SERVER_STANDARD.md with date 2026-04-09", "observed": "Present and correct" },
      { "action": "Searched file content for internal terms: Sentry, PostHog, bundledMcpManager, connector-catalog.json, harvest-mcp-tools", "observed": "None found — no internal details leaked" },
      { "action": "Checked all relative links in file resolve", "observed": "No broken links" },
      { "action": "Compared section coverage against MCP_SERVER_STANDARD.md required topics list", "observed": "All 12 required topics covered" }
    ]
  },
  "tests": {
    "added": []
  },
  "discoveredIssues": []
}
```

## When to Return to Orchestrator

- The upstream source document (e.g., MCP_SERVER_STANDARD.md) has fundamentally changed and the derivation plan no longer makes sense
- A submodule has uncommitted changes from another agent that conflict with your work
- The feature requires modifying a file that doesn't exist yet (missing precondition)
- Cross-reference validation reveals broken links that can't be fixed within this feature's scope
- TypeScript compilation fails due to issues in existing code (not introduced by this feature)
