---
name: cleanup-worker
description: Removes dead bundled MCP connector code and updates build/package configuration
---

# Cleanup Worker

NOTE: Startup and cleanup are handled by `worker-base`. This skill defines the WORK PROCEDURE.

## When to Use This Skill

For features that involve removing dead code paths for migrated connectors, updating build scripts, fixing gating logic, and ensuring no regressions to remaining bundled connectors.

## Required Skills

None

## Work Procedure

### Phase 1: Understand scope
1. Read the feature description carefully — it specifies which files and what to remove/modify.
2. Read `AGENTS.md` for the list of 16 migrated connectors and 13 preserved connectors.
3. Read each target file to understand the code structure before making changes.

### Phase 2: Identify dependencies before removing
1. For each function/constant being removed, grep the entire `src/` directory for all usages.
2. If a usage exists outside the removal scope, DO NOT remove the function — flag it in the handoff.
3. Pay special attention to shared helpers (subdomain normalization, env placeholder resolution) that may be used by remaining bundled connectors.

### Phase 3: Make surgical removals
1. Remove code in order of dependency: consumers first, then definitions.
2. Remove imports of deleted functions/types from all files.
3. After each file edit, verify the removal is complete by grepping for the removed identifier.
4. Do NOT remove entire files unless every export in the file is dead code.

### Phase 4: Update build/package configuration
1. When modifying `scripts/mcp-config.json`, only remove the 16 migrated names — preserve all others.
2. When deleting `resources/mcp-generated/*/server.cjs`, only delete for the 16 migrated connectors.
3. Update `scripts/validate-mcp-bundles.ts` and `forge.config.cjs` to match the updated mcp-config.json.

### Phase 5: Verify nothing is broken
1. Run `npm run build` — must exit 0.
2. Run `npm run validate:fast` — must exit 0.
3. Run `npm run lint` — must exit 0 (warnings OK).
4. Grep for any orphaned imports or references to removed code.
5. If any check fails, fix the issue before completing.

### Phase 6: Commit
1. Stage only the files you changed.
2. Commit with a descriptive message following the repo's conventional commit format.

## Example Handoff

```json
{
  "salientSummary": "Removed 16 migrated connector entries from BUNDLED_MCP_CATALOG, deleted 16 builder functions and their constants/resolvers, removed 13 legacy bridge routes. Preserved shared subdomain helpers used by remaining connectors. validate:fast passes, build succeeds, lint clean.",
  "whatWasImplemented": "Removed all BUNDLED_MCP_CATALOG entries for: Fathom, Humaans, PandaDoc, TalentLMS, QuickBooks, ServiceNow, Mixmax, Gamma, Napkin, Kling, Runway, Freshdesk, ElevenLabs, NanoBanana, EmailImap, Workday. Removed corresponding buildXxxPayload functions, server name constants, script resolvers. Removed 13 /bundled/*/configure routes from bundledInboxBridge.ts. Updated isSelfConfiguringMcp to no longer match these 16. Preserved normalizeSingleLabelSubdomainInput (used by BambooHR path).",
  "whatWasLeftUndone": "",
  "verification": {
    "commandsRun": [
      {"command": "npm run build", "exitCode": 0, "observation": "Build succeeds, remaining 13 bundled MCPs generate CJS bundles"},
      {"command": "npm run validate:fast", "exitCode": 0, "observation": "All 14 validation steps pass including MCP bundle smoke (13/13)"},
      {"command": "npm run lint", "exitCode": 0, "observation": "No new errors, existing warnings unchanged"},
      {"command": "grep -r 'buildHumaansPayload\\|buildFathomPayload\\|buildGammaPayload' src/", "exitCode": 1, "observation": "No matches — all migrated builder functions removed"},
      {"command": "grep -r 'HUMAANS_SERVER_NAME\\|FATHOM_SERVER_NAME' src/", "exitCode": 1, "observation": "No matches — all migrated constants removed"}
    ]
  },
  "tests": {
    "added": [],
    "coverage": "No new tests — this is a removal task. Existing test suite passes."
  },
  "discoveredIssues": []
}
```

## When to Return to Orchestrator

- A function being removed is still used by a non-migrated connector or shared path
- validate:fast fails and the fix is non-obvious
- A removed connector's code is entangled with a preserved connector in a way that requires architectural decisions
- Build or packaging breaks in a way that requires changes outside the feature scope
