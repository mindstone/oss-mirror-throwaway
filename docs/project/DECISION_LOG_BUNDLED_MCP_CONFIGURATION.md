---
description: "Decision log for bundled MCP connector configuration — self-configuring servers, agent-driven add flow, bridge endpoints, and rationale"
last_updated: "2026-05-14"
---

# Decision Log: Bundled MCP Configuration Architecture

**Date**: 2026-01-01  
**Status**: Implemented  
**Related**: `src/main/ipc/settingsHandlers.ts`, `resources/mcp/*/`

## Context

Bundled MCPs are local MCP servers shipped with Rebel that provide integrations with external services (Google Workspace, Slack, HubSpot, Gamma, Fathom, Kling, NanoBanana, etc.).

## Problem

The `mcp-add-bundled-server` IPC handler used a switch statement that:
1. Required manual code changes for each new bundled MCP
2. Passed credentials (API keys) at add-time, conflating "add server" with "configure credentials"
3. Was missing entries for OAuth-based MCPs (GoogleWorkspace, Slack, HubSpot), causing them to fail when added from the Connectors UI
4. Created inconsistent behavior between API-key and OAuth connectors

## Decision

**MCPs are self-configuring.** Each bundled MCP exposes its own configuration/authentication tools:

| MCP | Self-Config Tool | Type |
|-----|------------------|------|
| GoogleWorkspace | `authenticate_workspace_account` | OAuth |
| Slack | `authenticate_slack_workspace` | OAuth |
| HubSpot | `authenticate_hubspot_account` | OAuth |
| Gamma | `configure_gamma_api_key` | API Key |
| Fathom | *(needs adding)* | API Key |
| Kling | *(needs adding)* | API Key |
| NanoBanana | *(needs adding)* | API Key |

**The "add connector" flow is:**
1. User clicks "Add" on a bundled connector
2. Generic handler adds MCP config entry (script path, node_modules, NO credentials)
3. Rebel conversation starts with prompt: "configure this new connection"
4. Rebel discovers MCP's configure/auth tools and uses them
5. MCP handles credential collection (API key prompt, OAuth flow, etc.)

**Alternative: Agent-driven flow via `rebel_mcp_add_server` (2026-02-08)**

Agents can now add catalog connectors with credentials in one step:
1. Agent calls `rebel_mcp_add_server({ catalogId: "bundled-fathom", setupFields: { apiKey: "..." } })`
2. Bridge resolves catalog entry via `buildPayloadFromCatalog()` → `upsertMcpServerEntry()`
3. Credentials are injected at add-time (no separate configure step needed)
4. For OAuth connectors, returns `requiresAuth: true` — agent directs user to authenticate

This complements (doesn't replace) the UI-driven self-configuration flow above. See `docs/plans/finished/260208_unified_mcp_add_tool.md` for full design.

## Implementation

### Removed
- Switch statement in `settingsHandlers.ts` `mcp-add-bundled-server` handler
- Credential passing at add-time (`apiKey`, `credentials` parameters)

### Added
- Generic `addBundledMcpServer(serverName)` function that:
  - Derives script path from convention: `resources/mcp/{folder}/build/index.js` or `server.cjs`
  - Derives node_modules path: `resources/mcp/{folder}/node_modules`
  - Uses catalog entry for description
  - Adds server with NO credentials (MCP self-configures)
- Self-configuration tools to MCPs that were missing them (Fathom, Kling, NanoBanana)

### MCP Self-Configuration Pattern

Each bundled MCP should:
1. Start without credentials (gracefully handle missing env vars)
2. Expose a `configure_*` or `authenticate_*` tool
3. When called, either:
   - **API Key**: Prompt user, validate, save via bridge `/bundled/{name}/configure`
   - **OAuth**: Generate auth URL, open browser, handle callback, save tokens
4. Hot-reload credentials without restart (like Gamma does with `this.client = new GammaClient(api_key)`)

### Bridge Endpoints

For API-key MCPs to persist credentials, the bundled bridge exposes:
- `POST /bundled/{mcp}/configure` - Saves credentials to MCP config and env vars

## Rationale

1. **Single Responsibility**: Adding a server ≠ configuring credentials
2. **Consistency**: All bundled MCPs work the same way (add → configure via tools)
3. **Extensibility**: New MCPs don't require code changes to settingsHandlers.ts
4. **User Experience**: Rebel guides users through setup conversationally
5. **Security**: Credentials never pass through IPC - MCPs handle their own secrets

## Migration Notes

- Existing configured MCPs continue to work (env vars already set)
- Users adding new MCPs get the improved flow automatically
- No breaking changes to existing configurations

## Appendix: Updates Since Original Decision (2026-02-08)

**Self-config tool table (above) is outdated.** Fathom, Kling, and NanoBanana all have self-config tools now. The table is preserved as historical context from when the decision was made.

**Credential passing was re-added for the agent-driven flow.** The original decision removed credential passing at add-time. This was later complemented by `buildPayloadFromCatalog()` which accepts credentials via `setupFields` for the chat-based add flow. The Settings UI flow still uses the self-configuration pattern. Both paths coexist — see the "Alternative: Agent-driven flow" section above.

**All connectors now use email-based identity.** The original implementation had Kling in a `SINGLE_INSTANCE_CATALOG_IDS` set, but Kling's catalog entry has `accountIdentity: "email"` — it was moved to standard email-based dedup for consistency.
