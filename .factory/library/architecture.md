# Architecture: Bundled MCP Connector Migration

## Overview

This mission migrates 4 bundled MCP connectors from rebel-app to the mcp-servers repo as independent npm packages. Each connector goes through two phases: (1) port to mcp-servers and publish, (2) remove bundled infrastructure from rebel-app.

## Two-Repo Architecture

### mcp-servers repo (`/Users/you/development/mcp-servers`)
- Loose multi-package repo (no workspace manager)
- Each connector is an independent npm package under `connectors/<name>/`
- Shared test harness at `test-harness/` (InMemoryTransport, MSW, bridge mock, temp config)
- CI via `.github/workflows/ci.yml` (matrix of connectors, Node 20+22)
- Publishing via `.github/workflows/publish.yml` (tag-triggered)

### rebel-app repo (`/Users/you/development/desktop/rebel-app-1`)
- Bundled connectors live in `resources/mcp/<source-dir>/`
- Generated bundles in `resources/mcp-generated/<name>/server.cjs`
- Bundled infrastructure in `src/main/services/bundledMcpManager.ts`:
  - `BUNDLED_MCP_CATALOG`: connector metadata + auth config
  - `resolve*ServerScript()`: locates the bundled script
  - `build*Payload()`: creates the spawn config
- Catalog in `resources/connector-catalog.json`: defines connector metadata, provider type, mcpConfig
- Auto-migration in `migrateBundledConnectorsToNpx()`: converts legacy node entries to npx

## Migration Flow Per Connector

```
1. Port to mcp-servers
   ├── Copy _template → connectors/<name>/
   ├── Port source with SDK upgrade (McpServer + registerTool + Zod)
   ├── Add ToolAnnotations + withErrorHandling
   ├── For OAuth: implement 4 auth modes
   ├── Write tests (smoke, mock API, auth, security)
   ├── Security audit (zero internal references)
   ├── npm publish → @mindstone-engineering/mcp-server-<name>
   └── Verify npx installation

2. Remove from rebel-app
   ├── Update connector-catalog.json (provider: bundled → rebel-oss, add mcpConfig)
   ├── Remove BUNDLED_MCP_CATALOG entry
   ├── Remove payload builder + script resolver
   ├── Remove from secondary infra (mcpConfigManager, cloudRegistration, oauthCredentials)
   ├── Remove bundled source + generated files
   ├── Update tests
   └── Validate (build, validate:fast, npm test)
```

## Connector Details

| Connector | Tools | Auth | SDK | Source LOC | Special |
|-----------|-------|------|-----|-----------|---------|
| Retell AI | 15 | API key | 1.29.0 | 1,038 | Single file, integration tests available |
| Browser Automation | 18 | None | 1.29.0 | 584 | Wraps external CLI binary |
| Outreach | 15 | OAuth user-provided | 0.7.0 → 1.26.0+ | 953 | First OAuth migration, no credentials available |
| Salesforce | 26 | OAuth user-provided | 0.7.0 → 1.26.0+ | 2,348 | Largest, multi-account, unused express dep |

## Key Infrastructure Files

### rebel-app
- `src/main/services/bundledMcpManager.ts` -- Primary bundled connector control plane
- `src/core/services/mcpConfigManager.ts` -- Bundled path repair, BUNDLED_SERVER_TO_CATALOG_ID, GENERATED_MCP_SCRIPT_NAMES
- `src/main/services/bundledMcpCloudRegistration.ts` -- Cloud auto-registration (only Salesforce of these 4)
- `src/core/services/oauthCredentials.ts` -- Shared OAuth credential resolvers (Salesforce + Outreach)
- `resources/connector-catalog.json` -- Connector metadata catalog

### mcp-servers
- `connectors/_template/` -- Starter template
- `connectors/zendesk/` -- Full reference implementation
- `test-harness/src/` -- Shared test utilities (createInMemoryTestClient, setupMswServer, createTempConfig, createBridgeHandlers)
- `.github/workflows/ci.yml` -- CI matrix (must add new connectors)

## Auto-Migration System

`migrateBundledConnectorsToNpx()` runs at startup after `configureBundledMcpManager()`. It:
1. Reads connector-catalog.json for entries with `provider === "rebel-oss"` and valid `mcpConfig`
2. Finds legacy user config entries with `command === "node"` for those catalogIds
3. Rewrites to npx format using catalog's mcpConfig
4. Preserves `userDisabledToolsByServer` and `disabledServers`
5. Cleans up stale entries
6. Is idempotent (safe to run multiple times)

## OAuth Auth Mode Architecture

OAuth connectors (Outreach, Salesforce) implement 4 auth modes:
1. **bridge**: Host (Rebel) manages auth, injects tokens via bridge state env var
2. **standalone_oauth**: User provides OAuth app credentials, connector runs localhost callback server
3. **manual_token**: User provides static token (useful for Salesforce session tokens)
4. **unconfigured**: No credentials -- tools return setup guidance

Detection precedence: bridge > standalone_oauth > manual_token > unconfigured
Detection happens ONCE at startup, stored as enum. No re-detection per tool call.

## Security Invariants

- OSS packages contain ZERO internal references (mindstone/rebel/nspr)
- Bridge env var NOT in source code -- injected at runtime
- Token files: mode 0o600, directories: mode 0o700
- Atomic writes for token persistence
- Host-neutral error messages
- npm audit clean of High/Critical vulnerabilities
