# Stable regression fixture: workspace-env NEGATIVE (must NOT fire)

> Excerpt pattern from `docs-private/postmortems/260412_mcp_apps_resource_routing_postmortem.md`
> and `docs/plans/260412_mcp_apps_resource_routing_fix.md`.
> This fixture proves the tightened `mcp-workspace-env-propagation` entry
> does NOT fire on unrelated MCP-apps routing work.
>
> Pre-tightening (before Stage 3), this plan would over-fire because
> `super-mcp/src/handlers/**/*.ts` globbed `readResource.ts`. After the
> tightening, the glob is narrowed to `stdioClient.ts` only, so this
> change no longer trips the hint.
>
> DO NOT sync this with live plan/postmortem edits — it is a regression anchor.

## Plan summary

Fix MCP-apps resource routing so `ui://google-workspace/...` requests
route to the correct instance. `sourcePackageId` must be threaded
through `agentMessageHandler.ts`, `super-mcp/src/catalog.ts`, and
`super-mcp/src/handlers/readResource.ts`.

## Paths touched

- `super-mcp/src/catalog.ts`
- `super-mcp/src/handlers/readResource.ts`
- `src/main/services/agentMessageHandler.ts`
- `src/main/ipc/mcpAppsHandlers.ts`
- `src/shared/ipc/channels/mcpApps.ts`
- `src/renderer/features/agent-session/components/McpAppView.tsx`

## Identifiers

`sourcePackageId`, `mcpAppInstance`, `registerResourceUris`, `ui://...`

## Expected behaviour

Fire `mcp-apps-package-identity-routing`, NOT `mcp-workspace-env-propagation`.
The workspace-env entry was the source of the 260412 over-fire pre-Stage-3.
