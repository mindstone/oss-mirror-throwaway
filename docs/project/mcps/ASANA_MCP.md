---
description: "Asana MCP connector reference — official V2 hosted server, OAuth setup, workspace-scoped flow, tool coverage, troubleshooting"
last_updated: "2026-02-18"
---

# Asana MCP

| Field | Value |
|-------|-------|
| **Type** | Direct (vendor-hosted) |
| **Provider** | Asana Inc. |
| **URL** | `https://mcp.asana.com/v2/mcp` |
| **Transport** | Streamable HTTP |
| **Auth** | OAuth 2.0 with pre-registered client (V2) |
| **Status** | Active |

## Overview

Asana's official V2 MCP server allows AI assistants to access the Asana Work Graph - tasks, projects, goals, and team organization. This is a **vendor-hosted MCP** (we don't build or maintain it).

## V2 Migration (Feb 2026)

Asana launched V2 on Feb 4, 2026. Key changes from V1:

- **Transport**: Streamable HTTP (replaces SSE)
- **Auth**: Pre-registered OAuth clients (replaces Dynamic Client Registration)
- **Tools**: Leaner set with simplified names (e.g., `create_task` instead of `asana_create_task`)
- **Workspace-scoped**: Each session is scoped to one workspace

V1 (`https://mcp.asana.com/sse`) is deprecated and will be shut down by May 11, 2026.

### Our Integration

We registered a "Rebel" OAuth app in Asana's developer console. The `client_id` and `client_secret` are stored in `connector-catalog.json` under `mcpConfig.oauthClientId` / `mcpConfig.oauthClientSecret`. Super-MCP's `SimpleOAuthProvider` uses these as pre-registered credentials, skipping DCR.

## Available Tools

Asana's V2 MCP server includes a focused set of tools for:
- Task creation and management (`create_task`, `update_task`, `search_objects`)
- Project tracking and status updates
- User information
- Object search via typeahead

Use `tools/list` after authentication to discover all available tools dynamically.

## Setup Requirements

### Asana Admin Requirements
- The "Rebel" MCP app must not be blocked via [App Management](https://help.asana.com/s/article/app-management-and-integrations)
- Enterprise+ customers can explicitly allow/block the app

### User Requirements
- Active Asana account with appropriate workspace permissions
- Browser access to complete OAuth flow

## Connection Flow

1. User clicks "Add" for Asana in Settings -> Connectors
2. Server config (with pre-registered client credentials) added to Super-MCP router
3. Super-MCP restarts
4. OAuth flow opens in browser (user selects workspace)
5. User authorizes access
6. Callback redirects to localhost with auth code
7. Tokens exchanged and stored

## Troubleshooting

### "Authentication required" after connecting
Try disconnecting and reconnecting the Asana integration in Settings -> Connectors.

### "App not available" Error
If you see a prompt about the app not being available:
1. Contact your Asana admin
2. Request they allow the "Rebel" app in App Management
3. Retry connection after approval

### Workspace Selection
V2 requires selecting a workspace during OAuth. To access a different workspace, add another Asana connection.

## References

- [Using Asana's MCP Server](https://developers.asana.com/docs/using-asanas-mcp-server) - Official usage guide
- [Integrating with Asana's MCP Server](https://developers.asana.com/docs/integrating-with-asanas-mcp-server) - Developer integration guide
- [V2 Announcement](https://forum.asana.com/t/new-v2-mcp-server-now-generally-available/1122647) - V2 launch details
- [Asana App Management](https://help.asana.com/s/article/app-management-and-integrations) - Admin controls
