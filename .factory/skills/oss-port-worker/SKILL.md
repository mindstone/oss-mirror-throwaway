---
name: oss-port-worker
description: Ports a bundled MCP connector to the mcp-servers repo as an OSS npm package
---

# OSS Port Worker

NOTE: Startup and cleanup are handled by `worker-base`. This skill defines the WORK PROCEDURE.

## When to Use This Skill

Use for features that port a bundled MCP connector from rebel-app to the mcp-servers repo. This includes: creating the connector package, porting source code, upgrading SDK, writing tests, running security audit, publishing to npm.

## Required Skills

None.

## Work Procedure

### Step 0: Read Context

1. Read the feature description carefully -- it specifies which connector, tool count, auth pattern, and any special requirements.
2. Read `.factory/library/architecture.md` for the migration pattern.
3. Read `.factory/library/environment.md` for repo locations and credentials.
4. Read the reference docs specified in AGENTS.md (MCP_SERVER_STANDARD.md is mandatory).

### Step 1: Examine Source and Reference

1. Read the bundled connector source in `resources/mcp/<source-dir>/src/` in rebel-app.
2. Read the `connectors/_template/` directory in mcp-servers for the starter pattern.
3. Read `connectors/zendesk/` as the reference implementation (especially src/server.ts, src/tools/*.ts, test/ structure).
4. Note: SDK version, tool names, auth pattern, dependencies.

### Step 2: Create Connector Package

1. Copy `connectors/_template/` to `connectors/<name>/` in mcp-servers. The template carries both `package.json` (with `mcpName` placeholder) AND `server.json` (with placeholders) — DO NOT remove either file.
2. Update `package.json`:
   - name: `@mindstone-engineering/mcp-server-<name>`
   - version: start at `0.1.0`
   - **mcpName: `io.github.mindstone/mcp-server-<name>`** (must equal `server.json.name` exactly — registry verifies ownership against the live npm metadata)
   - bin: `mcp-server-<name>` -> `dist/index.js`
   - dependencies: add connector-specific deps (e.g., jsforce for Salesforce)
   - Remove template placeholder comments
3. Update `server.json` (registry manifest):
   - Replace every `CONNECTOR_NAME` placeholder with the slug (lowercase, hyphenated)
   - Replace `CONNECTOR_TITLE` with the user-facing brand name (e.g. "Salesforce")
   - Replace `CONNECTOR_DESCRIPTION` with a short (≤100 char) summary
   - Set `version` and `packages[0].version` to `0.1.0` (must equal `package.json.version`)
   - Replace the placeholder `CONNECTOR_API_KEY` env var block with the actual env vars the connector reads. Declare every required and optional env var with `isRequired` + `isSecret` flags. **DO NOT declare `MCP_HOST_BRIDGE_STATE` or `MINDSTONE_REBEL_BRIDGE_STATE`** — those are Rebel-internal plumbing, not user inputs
   - Update `_meta.com.mindstone.rebel.catalogId` to `bundled-<name>` (must match the catalog ID used in rebel-app's `connector-catalog.json`)
   - Validate locally: `mcp-publisher validate server.json` — must exit 0
4. Update `tsconfig.json` if needed (usually template is fine).
5. Create `README.md` with: description, installation (`npx -y @mindstone-engineering/mcp-server-<name>`), configuration (env vars), available tools.
6. Create `catalog-entry.json` following zendesk pattern (id, name, description, category, icon, maturity, verifiedSource, requiresSetup, setupFields).
7. Run `npm ci` to install dependencies.

### Step 3: Port Source Code with SDK Upgrade

Follow the migration sequencing from MCP_SERVER_STANDARD.md:

**Stage 0: Dependencies**
- Ensure `@modelcontextprotocol/sdk` is `^1.26.0` and `zod` is `^3.23.0`

**Stage 1: Module Structure**
- Split monolithic source into standard modules: types.ts, client.ts (API calls), utils.ts (error wrapper), tools/*.ts (per-domain tool files), server.ts, index.ts
- For OAuth connectors: add auth.ts (4 auth modes)

**Stage 2: Tool Registration**
- Convert ALL tools to `server.registerTool(name, { description, inputSchema: { ... z.schema ... }, annotations: { readOnlyHint, destructiveHint, ... } }, withErrorHandling(async (args) => { ... }))`
- Add ToolAnnotations to EVERY tool:
  - Read/search/list tools: `readOnlyHint: true`
  - Create tools: `readOnlyHint: false, destructiveHint: false`
  - Update/delete tools: `readOnlyHint: false, destructiveHint: true`
  - Idempotent updates: add `idempotentHint: true`
- Ensure ALL top-level parameters are snake_case. If renaming from camelCase, add backwards-compatible aliases.

**Stage 3: Server + Entry Point**
- `src/server.ts`: create McpServer, register tools via tool modules, export createServer function
- `src/index.ts`: `#!/usr/bin/env node` shebang, create StdioServerTransport, connect

**Stage 4: Build Pipeline**
- `npm run build` must succeed (tsc + chmod +x dist/index.js)
- Verify shebang preserved in dist/index.js

**Stage 5: Docs**
- LICENSE (copy from template)
- README.md with installation, configuration, tools list

**For OAuth Connectors (Outreach, Salesforce):**
- Implement 4 auth modes in auth.ts:
  1. `bridge`: detected when MCP_HOST_BRIDGE_STATE env var is present (do NOT hardcode this var name in source -- read from generic env var like `MCP_HOST_BRIDGE_STATE`)
  2. `standalone_oauth`: detected when CLIENT_ID + CLIENT_SECRET present but no bridge
  3. `manual_token`: detected when only token present
  4. `unconfigured`: no credentials at all
- Detection happens ONCE at startup
- Precedence: bridge > standalone_oauth > manual_token > unconfigured
- Token persistence: atomic writes (temp file + rename), mode 0o600
- Config directories: mode 0o700, create if not exists
- Error messages: host-neutral (no "Rebel" or "Mindstone" references)

### Step 4: Write Tests

Write tests BEFORE running them (TDD where practical):

1. **smoke.test.ts**: Server starts via InMemoryTransport. Verify exact tool count. Verify all tool names are registered. Verify descriptions are non-empty. Verify inputSchema is valid.

2. **Mock API tests** (per domain, using MSW):
   - Set up MSW handlers for the service's REST API
   - Test at least one read tool and one write tool through the full MCP pipeline
   - Test error responses (4xx → structured error, 5xx → structured error, not crash)
   - Test pagination if applicable (limit/offset passed correctly)
   - Test input validation (missing required params → clean error)

3. **auth.test.ts** (OAuth connectors only):
   - Test mode detection for each of the 4 modes
   - Test unconfigured mode returns setup guidance
   - Test token persistence creates files with correct permissions

4. **security.test.ts**:
   - Grep source for internal references (mindstone/rebel/nspr)
   - Verify no bridge code in source
   - Verify no hardcoded secrets
   - Verify host-neutral error messages

### Step 5: Security Audit

Run the full security checklist from AGENTS.md. ALL checks must pass with ZERO matches:
```bash
rg -i 'mindstone|rebel|nspr' --glob '!LICENSE' --glob '!package.json' --glob '!server.json' --glob '!node_modules' --glob '!*.lock' src/ test/
rg 'MINDSTONE_REBEL_BRIDGE_STATE|bridge\.ts|/bundled/' --glob '!node_modules' src/ test/
rg 'sk_live|sk_test|key_real|xoxb-|xoxp-' --glob '!node_modules' src/ test/
npm audit --audit-level=high
mcp-publisher validate server.json
```

`server.json` is exempted from the `mindstone|rebel` grep because the namespace `io.github.mindstone/...` and the `_meta.com.mindstone.rebel` block are intentionally branded — they are the registry's mechanism for asserting ownership of the namespace.

### Step 6: Build, Test, Publish

1. `npm run build` -- must succeed
2. `npm test` -- all tests must pass
3. `npm audit --audit-level=high` -- zero high/critical
4. `mcp-publisher validate server.json` -- must exit 0 (cross-file consistency: `mcpName` ↔ `server.json.name`, version ↔ `packages[0].version`, identifier ↔ `package.json.name`)
5. `npm publish --access public`
6. Verify: `npx -y @mindstone-engineering/mcp-server-<name>@<version>` starts correctly
7. Update `.github/workflows/ci.yml` matrix to include the new connector
8. (Maintainer task, post-publish) `mcp-publisher login github-oidc && mcp-publisher publish connectors/<name>/server.json` to register the connector with the official MCP Registry. Verify with `curl -s "https://registry.modelcontextprotocol.io/v0/servers?search=<name>" | jq .`

### Step 7: Commit

Stage only files in `connectors/<name>/` and the CI workflow. Commit with:
```
feat(<name>): Port <name> MCP connector to OSS npm package.

- Migrated from rebel-app bundled connector
- SDK upgraded to McpServer + registerTool + Zod
- Published as @mindstone-engineering/mcp-server-<name>@<version>
```

## Example Handoff

```json
{
  "salientSummary": "Ported Retell AI connector to mcp-servers as @mindstone-engineering/mcp-server-retell-ai@0.1.0. Created 15 tools with McpServer+registerTool+Zod, wrote smoke/mock/security tests (12 test cases), passed security audit (zero internal refs), published to npm, verified npx installation.",
  "whatWasImplemented": "Created connectors/retell-ai/ with full source port: src/index.ts (entry), src/server.ts (McpServer), src/client.ts (API calls), src/types.ts, src/utils.ts, src/tools/calls.ts, src/tools/agents.ts, src/tools/llms.ts, src/tools/voices.ts, src/tools/config.ts. All 15 tools have ToolAnnotations and withErrorHandling. Published @mindstone-engineering/mcp-server-retell-ai@0.1.0.",
  "whatWasLeftUndone": "",
  "verification": {
    "commandsRun": [
      { "command": "npm run build", "exitCode": 0, "observation": "TypeScript compiled successfully, shebang preserved" },
      { "command": "npm test", "exitCode": 0, "observation": "12 tests passed (4 smoke, 5 mock API, 3 security)" },
      { "command": "npm audit --audit-level=high", "exitCode": 0, "observation": "0 vulnerabilities" },
      { "command": "rg -i 'mindstone|rebel|nspr' --glob '!LICENSE' --glob '!package.json' src/ test/", "exitCode": 1, "observation": "No matches (exit 1 = no results)" },
      { "command": "npm publish --access public", "exitCode": 0, "observation": "Published @mindstone-engineering/mcp-server-retell-ai@0.1.0" },
      { "command": "npx -y @mindstone-engineering/mcp-server-retell-ai@0.1.0", "exitCode": 0, "observation": "Server started on stdio, 15 tools registered" }
    ],
    "interactiveChecks": []
  },
  "tests": {
    "added": [
      { "file": "test/smoke.test.ts", "cases": [
        { "name": "registers all 15 tools", "verifies": "Tool count and names" },
        { "name": "all tools have descriptions", "verifies": "Description non-empty" },
        { "name": "all tools have annotations", "verifies": "ToolAnnotations present" },
        { "name": "all tools have valid input schemas", "verifies": "Zod schema validity" }
      ]},
      { "file": "test/tools/agents.test.ts", "cases": [
        { "name": "list_agents returns agent array", "verifies": "Read tool response shape" },
        { "name": "create_agent sends correct payload", "verifies": "Write tool API call" },
        { "name": "API 401 returns structured error", "verifies": "Error handling" }
      ]}
    ]
  },
  "discoveredIssues": []
}
```

## When to Return to Orchestrator

- npm publish fails (auth issues, name conflicts)
- Source code has patterns that can't be cleanly converted to McpServer (e.g., streaming, SSE)
- SDK upgrade introduces breaking changes that require architectural decisions
- Security audit finds real secrets or problematic dependencies that need human judgment
- Template or test harness has bugs that block progress
