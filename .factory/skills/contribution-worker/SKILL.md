---
name: contribution-worker
description: Implements OSS MCP contribution flow features using CHIEF_ENGINEER workflow patterns — TDD, IPC contracts, store creation, UI wiring
---

# Contribution Worker

NOTE: Startup and cleanup are handled by `worker-base`. This skill defines the WORK PROCEDURE.

## When to Use This Skill

Features related to the OSS MCP contribution flow:
- UI entry point wiring (Settings CTAs → seeded conversations)
- Contribution state store (creation, CRUD, migrations, IPC)
- Catalog schema extensions (contributor metadata)
- GitHub auth service (contribution-specific OAuth)
- GitHub submission service (fork, push, PR via REST API)
- MCPBuildCard state mapping and wiring
- MCPSetupOfferCard / MCPSavedForLaterCard conversation integration
- Status transport (fetch-on-mount with staleness)
- Notification and banner wiring
- Skill document updates for in-app contribution path

## Required Skills

None — this worker uses unit tests and validate:fast only.

## Work Procedure

### Step 0: Read Context

1. Read `docs/plans/260410_oss_mcp_integration_forward_plan.md` — the forward plan is the canonical reference. Find the P-section matching your feature and read it thoroughly, including any referenced decisions (D1-D9).
2. Read `.factory/library/architecture.md` for system architecture context.
3. Read the feature's `preconditions`, `expectedBehavior`, and `verificationSteps` from features.json.

### Step 1: Understand Existing Patterns

Before writing any code, investigate the codebase patterns you'll need to follow:
- For IPC: read `src/shared/ipc/contracts.ts` and an existing channel group
- For stores: read `src/core/services/communityEventsStore.ts` as the pattern
- For OAuth: read `src/main/services/githubAuthService.ts` as the pattern (DO NOT MODIFY)
- For UI wiring: read the existing `handleConfigureWithRebel` pattern in `src/renderer/App.tsx`
- For MCP tools: read an existing bundled tool definition for the registration pattern

### Step 2: Write Tests First (TDD)

Write failing tests BEFORE implementation:
1. Create test file(s) in the appropriate `__tests__/` directory following existing naming conventions
2. Write test cases that cover the feature's `expectedBehavior` items
3. Run `npm run test -- --grep '<pattern>'` to confirm tests fail (red)
4. Each test must have a clear assertion — no "it renders without crashing" padding

### Step 3: Implement

1. Implement the minimum code to make tests pass (green)
2. Follow existing patterns — DO NOT invent new abstractions unless the feature requires it
3. Key conventions:
   - Business logic in `src/core/` (platform-agnostic, no electron imports)
   - Electron-specific code only in `src/main/` (OAuth deep-links, file permissions)
   - IPC contracts with Zod schemas in `src/shared/ipc/channels/`
   - Stores use lazy `getStore()` pattern, registered in `ALL_STORE_VERSIONS`
   - Pino logging: `log.warn({ data }, 'message')` not `log.warn('message', { data })`

### Step 4: Verify

1. Run `npm run test` — full test suite must pass
2. Run `npm run validate:fast` — all validators must pass
3. If the feature adds IPC channels, run `npm run validate:ipc` explicitly
4. If the feature adds/bumps a store version, `validate:store-versions` catches missing registrations
5. Check for TypeScript errors in changed files: `npx tsc --noEmit` on specific files if needed

### Step 5: Clean Up

1. Remove any debug logging or temporary code
2. Ensure no `any` types were introduced
3. Check imports are clean (no unused imports)

## Example Handoff

```json
{
  "salientSummary": "Implemented ConnectorContribution store in src/core/ with full CRUD, lazy getStore(), registered CONTRIBUTION_STORE_VERSION in ALL_STORE_VERSIONS. Added 3 IPC read channels (contribution:list, contribution:get-by-session, contribution:get) with Zod schemas. Ran npm test (all passing), validate:fast green, validate:ipc green.",
  "whatWasImplemented": "ConnectorContribution persistent store with ContributionStatus type (10 states), createDefaultState(), CRUD methods (createContribution, getContribution, getContributionBySession, updateContribution, listContributions), acknowledgedEvents array for per-surface dismissal tracking. IPC channels registered in contracts.ts, handlers in contributionHandlers.ts, preload bridge exposes contributionApi.",
  "whatWasLeftUndone": "",
  "verification": {
    "commandsRun": [
      { "command": "npm run test -- --grep 'contribution'", "exitCode": 0, "observation": "12 tests passing covering store CRUD, default state, IPC handlers, Zod validation" },
      { "command": "npm run validate:fast", "exitCode": 0, "observation": "All validators pass including validate:store-versions and validate:ipc" }
    ],
    "interactiveChecks": []
  },
  "tests": {
    "added": [
      {
        "file": "src/core/services/__tests__/contributionStore.test.ts",
        "cases": [
          { "name": "creates store with correct default state", "verifies": "VAL-STATE-1" },
          { "name": "CRUD operations work correctly", "verifies": "VAL-STATE-4" },
          { "name": "acknowledgedEvents tracks per-surface dismissals", "verifies": "VAL-STATE-8" }
        ]
      },
      {
        "file": "src/main/ipc/__tests__/contributionHandlers.test.ts",
        "cases": [
          { "name": "contribution:list returns all contributions", "verifies": "VAL-STATE-7" },
          { "name": "contribution:get-by-session returns correct record", "verifies": "VAL-STATE-7" }
        ]
      }
    ]
  },
  "discoveredIssues": []
}
```

## When to Return to Orchestrator

- Feature requires a GitHub OAuth App client ID that hasn't been registered yet
- IPC contract changes break existing tests in unrelated areas
- The forward plan's design decision needs to change based on implementation findings
- A precondition from features.json is not met (e.g., store doesn't exist yet for a feature that depends on it)
- Security concern discovered (e.g., token storage pattern needs review)
