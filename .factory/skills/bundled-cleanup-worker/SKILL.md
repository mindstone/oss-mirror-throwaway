---
name: bundled-cleanup-worker
description: Removes bundled MCP connector infrastructure from rebel-app and updates catalog
---

# Bundled Cleanup Worker

NOTE: Startup and cleanup are handled by `worker-base`. This skill defines the WORK PROCEDURE.

## When to Use This Skill

Use for features that remove a migrated connector's bundled infrastructure from rebel-app. This includes: updating the connector catalog, removing BUNDLED_MCP_CATALOG entries, payload builders, script resolvers, generated bundles, and source directories.

## Required Skills

None.

## Work Procedure

### Step 0: Read Context

1. Read the feature description carefully -- it specifies which connector and what infrastructure to remove.
2. Read `.factory/library/architecture.md` for the removal pattern.
3. Identify the specific items to remove (listed in the feature description).

### Step 1: Update connector-catalog.json

1. Open `resources/connector-catalog.json` in rebel-app.
2. Find the entry with the connector's catalogId (e.g., `bundled-retell-ai`).
3. Change `provider` from `"bundled"` to `"rebel-oss"`.
4. Add `mcpConfig` object:
```json
{
  "command": "npx",
  "args": ["-y", "@mindstone-engineering/mcp-server-<name>@<version>"],
  "env": {
    "<ENV_VAR>": "${<ENV_VAR>}"
  }
}
```
The env section should include all required environment variables as placeholders. For OAuth connectors, include CLIENT_ID, CLIENT_SECRET, and CONFIG_DIR. The bridge state env var is injected at runtime by Rebel -- do NOT add it to the catalog.

4. Update the tool count if it changed during SDK upgrade.
5. Verify the JSON is valid.

### Step 2: Remove BUNDLED_MCP_CATALOG Entry

1. Open `src/main/services/bundledMcpManager.ts`.
2. Find the connector's entry in the `BUNDLED_MCP_CATALOG` object.
3. Remove the entire entry (key + value).
4. Verify no syntax errors (matching braces, trailing commas).

### Step 3: Remove Payload Builder and Script Resolver

1. In `bundledMcpManager.ts`, find and remove:
   - `resolve<Name>ServerScript()` function
   - `build<Name>Payload()` function
2. Grep for any other callers of these functions BEFORE removing:
   ```bash
   rg 'resolve<Name>ServerScript|build<Name>Payload' src/
   ```
3. If callers exist outside bundledMcpManager.ts, update them or return to orchestrator.

### Step 4: Remove from Secondary Infrastructure

Check and remove from these files if the connector is present:

1. **mcpConfigManager.ts** (`src/core/services/mcpConfigManager.ts`):
   - Remove from `BUNDLED_SERVER_TO_CATALOG_ID` if present
   - Remove from `INSTANCE_PREFIX_TO_CATALOG_ID` if present
   - Remove from `GENERATED_MCP_SCRIPT_NAMES` if present

2. **bundledMcpCloudRegistration.ts** (`src/main/services/bundledMcpCloudRegistration.ts`):
   - Remove discovery function if present (only Salesforce of these 4 is there)
   - Remove from discovery list

3. **oauthCredentials.ts** (`src/core/services/oauthCredentials.ts`):
   - BEFORE removing credential resolvers, check ALL consumers:
   ```bash
   rg 'resolve<Name>Credentials' src/ --glob '!*.test.*'
   ```
   - If used by settingsHandlers.ts, bundledInboxBridge.ts, or other non-bundled services, DO NOT REMOVE. Note this in the handoff.
   - If only used by bundledMcpManager.ts, safe to remove.

### Step 5: Remove Bundled Source and Generated Files

1. Remove the bundled source directory: `resources/mcp/<source-dir>/`
2. Remove the generated bundle if it exists: `resources/mcp-generated/<name>/`
3. Check `scripts/mcp-config.json` for entries that reference the removed connector and update if needed.

### Step 6: Update Tests

1. Grep for test files that reference the removed connector:
   ```bash
   rg '<connector-name>' src/ test/ scripts/ --glob '*.test.*'
   ```
2. Remove or update test references that are now invalid.
3. Check `scripts/__tests__/mcp-smoke.test.ts` for expected tool counts or server references.
4. Check `scripts/validate-mcp-bundles.ts` for references.

### Step 7: Verify

Run ALL verification commands:
```bash
npm run build
npm run validate:fast
npm run test
```

All must pass. If they fail, diagnose and fix. Common issues:
- Orphaned imports (grep for removed function names)
- Stale test expectations (tool counts, server names)
- Missing commas or braces in JSON after removal

Also verify clean removal:
```bash
rg 'resolve<Name>ServerScript|build<Name>Payload|<BUNDLED_CATALOG_KEY>' src/
```
Must return zero matches.

### Step 8: Commit

Stage only the files you changed. Commit with:
```
refactor(mcp): Remove bundled <name> connector infrastructure. Migrated to @mindstone-engineering/mcp-server-<name> (rebel-oss).

- Catalog entry updated to provider: rebel-oss
- Removed BUNDLED_MCP_CATALOG entry, payload builder, script resolver
- Removed bundled source directory resources/mcp/<source-dir>/
```

## Example Handoff

```json
{
  "salientSummary": "Removed Retell AI bundled infrastructure from rebel-app. Updated catalog to rebel-oss, removed BUNDLED_MCP_CATALOG entry, payload builder, script resolver, and source directory. validate:fast and npm test both pass.",
  "whatWasImplemented": "Updated resources/connector-catalog.json (provider: rebel-oss, added mcpConfig). Removed from bundledMcpManager.ts: RetellAI BUNDLED_MCP_CATALOG entry, resolveRetellAIServerScript(), buildRetellAIPayload(). Removed resources/mcp/retell-ai/ directory. Updated test expectations.",
  "whatWasLeftUndone": "",
  "verification": {
    "commandsRun": [
      { "command": "npm run build", "exitCode": 0, "observation": "Build succeeded" },
      { "command": "npm run validate:fast", "exitCode": 0, "observation": "All validations pass" },
      { "command": "npm run test", "exitCode": 0, "observation": "All tests pass" },
      { "command": "rg 'resolveRetellAIServerScript|buildRetellAIPayload|RetellAI.*BUNDLED' src/", "exitCode": 1, "observation": "No orphaned references (exit 1 = no results)" }
    ],
    "interactiveChecks": []
  },
  "tests": {
    "added": []
  },
  "discoveredIssues": []
}
```

## When to Return to Orchestrator

- OAuth credential resolver is used by non-bundled services (e.g., settingsHandlers.ts) and cannot be removed
- validate:fast fails with errors unrelated to the removal (pre-existing issues)
- Removing the connector breaks other bundled connectors (entangled code)
- Build or packaging fails in ways that require architectural decisions
