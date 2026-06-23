---
description: "Bundled MCP testing guide — smoke and integration levels, shared harness usage, maintenance rules, and failure debugging"
last_updated: "2026-06-11"
---

# MCP Testing

How to test bundled MCP servers. Covers all test levels, how to keep tests current, and how to debug failures.

## See Also

- [MCP_REBEL_CLI_TESTING.md](./MCP_REBEL_CLI_TESTING.md) -- using the Electron-backed Rebel CLI for live MCP and connector tests against a real Rebel instance
- [MCP_CONNECTOR_AUTH_TOKEN_LIFECYCLE.md](./MCP_CONNECTOR_AUTH_TOKEN_LIFECYCLE.md) -- auth/token refresh mechanisms and the test cases required when changing connector authentication
- [MCP_IMPROVEMENT_WORKFLOW.md](./MCP_IMPROVEMENT_WORKFLOW.md) Phase 5 -- adding tests for a new MCP
- [TESTING_AUTOMATION_OVERVIEW.md](./TESTING_AUTOMATION_OVERVIEW.md) -- project-wide testing decision matrix
- `scripts/mcp-test-harness.ts` -- shared harness source code and JSDoc

---

## Test Levels

MCP servers are tested at four levels. Each level catches different problems.

| Level | What it checks | Command | Needs API keys? | In CI? | Speed |
|-------|---------------|---------|-----------------|--------|-------|
| **0 -- Bundle smoke** | server.cjs doesn't crash on startup | `npm run validate:fast` | No | Yes (via validate:fast) | ~2s |
| **1 -- Health check** | Tools register via raw JSON-RPC (rebel-inbox, rebel-diagnostics only) | `npm run test:mcp` | No | No | ~5s |
| **2 -- Harness smoke** | All 18 MCPs: start via MCP SDK Client, tools register, schemas valid, unconfigured errors handled | `npm run test:mcp:smoke` | No | Not yet | ~6s |
| **3 -- Integration** | Actual tool calls against real APIs, response shape validation | `npm run test:mcp:integration` | Yes | Not yet | Varies |

**Level 0** is part of `validate:fast` and runs on every commit. Levels 2 and 3 use the shared test harness (`scripts/mcp-test-harness.ts`).

### What each level catches

- **Level 0**: Import errors, missing dependencies, syntax errors, crashes on startup.
- **Level 1**: Tool registration failures, Zod schema errors (legacy -- only 2 MCPs configured).
- **Level 2**: Tool schema correctness (every tool has name, description, inputSchema), unconfigured error handling (returns `{ok: false}` not a crash), server stability after error.
- **Level 3**: Actual API responses have expected fields, pagination works, error handling for bad inputs, end-to-end tool behavior.

---

## Running Tests

```bash
# All smoke tests -- no keys needed, runs for every built MCP (~6s)
npm run test:mcp:smoke

# Integration tests -- skips automatically if API keys not set
npm run test:mcp:integration

# Integration tests for one MCP with a real key
HUMAANS_API_KEY=xxx npx vitest run resources/mcp/humaans/test-mcp.test.ts

# Legacy health check (rebel-inbox, rebel-diagnostics only)
npm run test:mcp
```

For a live post-change probe against MCP tools or connectors currently authenticated in your Rebel app, use the headless CLI flow in [MCP_REBEL_CLI_TESTING.md](./MCP_REBEL_CLI_TESTING.md). That path is intentionally adaptive: it discovers which matching connector packages are actually connected and reports unavailable packages instead of assuming every developer has the same connector set.

### Prerequisites

MCP bundles must be built before Level 2+ tests can run:
```bash
node scripts/build-bundled-mcps.mjs --force
```
If a bundle is missing, the smoke test skips it with a warning (not a failure).

---

## Keeping Tests Up to Date

### When you add a new MCP

1. **Smoke tests are automatic.** Add the MCP to `scripts/mcp-config.json`, build it, and smoke tests pick it up. No code needed.

2. **If the MCP needs special env vars to start** (like Microsoft or Google), add an entry to `MCP_TEST_OVERRIDES` in `scripts/__tests__/mcp-smoke.test.ts`.

3. **Add integration tests** by creating `resources/mcp/<name>/test-mcp.test.ts` with a declarative config:

```typescript
import { runMcpIntegrationSuite } from '../../../scripts/mcp-test-harness';

runMcpIntegrationSuite({
  name: 'my-mcp',
  envKey: 'MY_MCP_API_KEY',
  expectedTools: ['list_items', 'get_item', 'create_item'],
  unconfiguredTool: 'list_items',
  toolTests: [
    { tool: 'list_items', args: { limit: 2 }, expectOk: true, expectFields: ['ok', 'data'],
      extractId: { path: 'data[0].id', as: 'itemId' } },
    { tool: 'get_item', args: { id: '$itemId' }, expectOk: true, expectFields: ['ok', 'id'] },
    { tool: 'get_item', args: { id: 'invalid' }, expectOk: false },
    { tool: 'create_item', skip: true },  // skip write tools
  ],
});
```

4. **If the MCP follows the `{ok: false}` unconfigured error pattern**, add it to `UNCONFIGURED_TEST_MCPS` in `scripts/__tests__/mcp-smoke.test.ts`.

### When you add or rename tools

Update the `expectedTools` array in the MCP's `test-mcp.test.ts`. The smoke test will catch the mismatch (tool registration check), but the integration test needs the updated list.

### When you change a tool's response shape

Update `expectFields` in the relevant `toolTests` entry. If a field is removed, tests will fail at that assertion.

### When you change error handling

If you change how unconfigured errors are returned (e.g., from `{ok: false}` to `isError: true`), the harness handles both patterns. No test changes needed unless you change the error message text (which `expectedErrorSubstring` checks for).

---

## Debugging Test Failures

### Smoke test fails: "Server script not found"

The MCP hasn't been built. Run:
```bash
node scripts/build-bundled-mcps.mjs --force
```

### Smoke test fails: "Connection timeout"

The MCP server is hanging on startup. Debug by running it directly:
```bash
NODE_ENV=test node resources/mcp-generated/<name>/server.cjs
```
Check stderr for errors. Common causes:
- Missing required env vars (add to `MCP_TEST_OVERRIDES`)
- Network calls on startup that hang (e.g., Discourse fetching site info)

### Smoke test fails: "Tool missing description" or "inputSchema.type should be object"

A tool definition is malformed. Check the tool's registration in `src/index.ts` -- every tool needs `name`, `description`, and `inputSchema: { type: 'object', ... }`.

### Unconfigured test fails: error not detected

The harness checks two patterns:
1. MCP protocol: `result.isError === true`
2. Application JSON: `{ ok: false }` or `{ success: false }`

If your MCP uses a different error pattern, either:
- Adopt `{ok: false}` (preferred for consistency), or
- Remove the MCP from `UNCONFIGURED_TEST_MCPS` and test it manually

### Integration test fails: "Variable not yet extracted"

A `$variable` reference in `args` depends on a previous `extractId` that hasn't run yet. Tool tests run in order -- make sure the extracting test comes before the consuming test.

### Integration test fails: field missing

The API response shape changed. Update `expectFields` to match the new shape. If the field was removed intentionally, remove it from the test. If not, you found a bug.

### Integration test skipped unexpectedly

The required API key env var is not set. Either:
- Set it: `export HUMAANS_API_KEY=xxx`
- Or use a `.env.test.local` file (gitignored)

---

## Legacy Health Check (Level 1) Details

> Folded in from the former `MCP_HEALTH_TESTING.md` (2026-06-11). Covers `scripts/test-mcp-health.js` only — prefer the Level 2/3 harness for new work.

`npm run test:mcp` spawns each configured MCP server as a child process, sends a `tools/list` JSON-RPC request, verifies expected tools are present, and reports pass/fail with timing. Useful for verifying a fix without the full app-restart cycle.

To add an MCP, edit `MCP_CONFIGS` in `scripts/test-mcp-health.js`:

```javascript
'my-new-mcp': {
  script: path.join(RESOURCES_MCP, 'my-new-mcp', 'server.cjs'),
  env: { NODE_PATH: NODE_MODULES /* + required env vars */ },
  expectedMinTools: 5
}
```

Common failure modes:

- **`Cannot read properties of undefined (reading '_zod')`** — incorrect Zod v4 API usage, typically `z.record(z.string())` needing two args (`z.record(z.string(), z.string())`) or undefined values in an object shape.
- **Script not found** — `resources/mcp/<name>/server.cjs` doesn't exist (build it first).
- **Timeout** — server hangs during startup/registration; check stderr, or run directly: `NODE_PATH=./node_modules node resources/mcp/<name>/server.cjs`.
- **Missing environment variables** — check the MCP's required env vars in `bundledMcpManager.ts`.

---

## Architecture

```
scripts/mcp-test-harness.ts          -- shared module (harness + declarative runner)
scripts/__tests__/mcp-smoke.test.ts  -- Level 2 smoke tests (auto-discovers all MCPs)
resources/mcp/<name>/test-mcp.test.ts -- Level 3 per-MCP integration tests (declarative)

scripts/validate-mcp-bundles.ts      -- Level 0 bundle smoke (part of validate:fast)
scripts/test-mcp-health.js           -- Level 1 legacy health check
```

The harness uses the MCP SDK Client (`@modelcontextprotocol/sdk`) to spawn servers over stdio and interact via the standard MCP protocol. No Electron app needed -- tests run as pure Node processes.

### Design decision: declarative-first

Integration tests use `runMcpIntegrationSuite()` with a config object as the standard approach. This keeps per-MCP test files to ~10-15 lines and makes it easy to add tests for new MCPs without writing custom test code.

Custom test code (using the lower-level helpers `createMcpTestClient`, `callToolJson`, `assertToolReturnsError`) is available but should only be used when there's a strong need -- e.g., async polling workflows, multi-step OAuth flows, or file I/O operations.

---

## Related Files

| File | Purpose |
|------|---------|
| `scripts/mcp-test-harness.ts` | Shared harness: client creation, assertions, declarative runner |
| `scripts/__tests__/mcp-smoke.test.ts` | Smoke tests for all bundled MCPs |
| `scripts/validate-mcp-bundles.ts` | Level 0 bundle smoke (spawn + crash check) |
| `scripts/test-mcp-health.js` | Legacy health check (JSON-RPC, 2 MCPs only) |
| `scripts/mcp-config.json` | Source of truth for which MCPs are bundled |
| `resources/mcp/humaans/test-mcp.test.ts` | Example declarative integration test |
| `vitest.config.ts` | Test runner config (includes MCP test paths) |
| `docs/plans/partway/260217_mcp_test_harness.md` | Original planning doc with design decisions |
