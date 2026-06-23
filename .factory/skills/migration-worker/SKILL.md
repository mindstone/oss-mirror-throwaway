---
name: migration-worker
description: Fixes startup migration ordering, reconnect UI flows, and updates tests for migrated connectors
---

# Migration Worker

NOTE: Startup and cleanup are handled by `worker-base`. This skill defines the WORK PROCEDURE.

## When to Use This Skill

For features that fix the startup migration function ordering, update reconnect/setup UI paths to pass catalogId, and update/remove stale tests.

## Required Skills

None

## Work Procedure

### Phase 1: Understand the migration system
1. Read the feature description and AGENTS.md for context.
2. Read `src/main/index.ts` to understand startup ordering — find where `migrateBundledConnectorsToNpx` is called vs where `configureBundledMcpManager` is called.
3. Read `src/main/services/bundledMcpManager.ts` — understand `migrateBundledConnectorsToNpx()`, `resolveConnectorCatalogPath()`, and `requireConfig()`.
4. Read the renderer files that call `mcpAddBundledServer` to understand which pass catalogId and which don't.

### Phase 2: Fix startup migration ordering
1. Move `migrateBundledConnectorsToNpx()` call to AFTER `configureBundledMcpManager()` runs, or refactor it to accept explicit paths instead of depending on global config.
2. Verify the migration function can now access `resolveConnectorCatalogPath()` without throwing.
3. Test by inspecting the code flow — ensure no circular dependency is created.

### Phase 3: Fix reconnect UI paths
1. For each UI file that calls `mcpAddBundledServer` without `catalogId`, add the catalogId parameter.
2. The catalogId should come from the connector's catalog entry (e.g., `bundled-humaans` for Humaans).
3. Files to check: `ExpandedConnectionCard.tsx`, `UnifiedConnectionsPanel.tsx`, `ToolAuthStep.tsx`.
4. Verify by grepping for all `mcpAddBundledServer` call sites — every one should pass catalogId.

### Phase 4: Update tests
1. Remove tests in `bundledMcpManager.test.ts` that test removed builder functions (buildKlingPayload, buildFathomPayload, etc.).
2. Update migration tests to reflect the new startup ordering.
3. Add or update tests verifying that migrated connector names no longer appear in BUNDLED_MCP_CATALOG.
4. Run `npm run test` — must pass.

### Phase 5: Verify everything
1. Run `npm run test` — must exit 0.
2. Run `npm run validate:fast` — must exit 0.
3. Run `npm run build` — must exit 0.
4. Grep to confirm all `mcpAddBundledServer` calls include catalogId.

### Phase 6: Commit
1. Stage only the files you changed.
2. Commit with a descriptive message.

## Example Handoff

```json
{
  "salientSummary": "Fixed startup migration ordering — migrateBundledConnectorsToNpx now runs after configureBundledMcpManager. Updated 3 UI files to pass catalogId on reconnect. Removed 12 stale tests for migrated builders, added 2 tests for migration ordering. All tests pass (npm run test exit 0).",
  "whatWasImplemented": "Moved migrateBundledConnectorsToNpx call from index.ts:3477 to after initCoreServices completes. Updated ExpandedConnectionCard.tsx, UnifiedConnectionsPanel.tsx, and ToolAuthStep.tsx to pass catalogId when calling mcpAddBundledServer. Removed stale buildXxxPayload tests for Kling, Fathom, Gamma, NanoBanana. Updated TalentLMS/ServiceNow normalization tests. Updated migration test suite.",
  "whatWasLeftUndone": "",
  "verification": {
    "commandsRun": [
      {"command": "npm run test", "exitCode": 0, "observation": "All test suites pass, no failures"},
      {"command": "npm run validate:fast", "exitCode": 0, "observation": "All validation checks pass"},
      {"command": "npm run build", "exitCode": 0, "observation": "Build succeeds"},
      {"command": "grep -rn 'mcpAddBundledServer' src/renderer/", "exitCode": 0, "observation": "All 4 call sites include catalogId parameter"}
    ]
  },
  "tests": {
    "added": [
      {"file": "src/main/services/__tests__/bundledMcpManager.test.ts", "cases": [
        {"name": "migrateBundledConnectorsToNpx runs after manager configured", "verifies": "VAL-MIG-001"},
        {"name": "migrated connectors not in BUNDLED_MCP_CATALOG", "verifies": "VAL-GATE-001"}
      ]}
    ],
    "coverage": "Removed 12 stale tests, added 2 new tests, updated 4 existing tests."
  },
  "discoveredIssues": []
}
```

## When to Return to Orchestrator

- Startup ordering change creates circular dependency
- Migration function has dependencies beyond configureBundledMcpManager that also need reordering
- UI component's catalogId is not readily available in the component's props/context
- Test failures reveal deeper issues in the migration logic
