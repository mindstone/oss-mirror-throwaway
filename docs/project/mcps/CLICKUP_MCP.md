---
description: "ClickUp MCP connector reference — official hosted beta server, OAuth flow, workspace tools, limitations, troubleshooting"
last_updated: "2026-02-20"
---

# ClickUp MCP

| Field | Value |
|-------|-------|
| **Type** | Direct (vendor-hosted) |
| **Provider** | ClickUp |
| **URL** | `https://mcp.clickup.com/mcp` |
| **Transport** | Streamable HTTP |
| **Auth** | OAuth 2.0 (vendor-managed) |
| **Status** | Public Beta |

## Overview

ClickUp's official first-party MCP server allows AI assistants to interact with ClickUp Workspace data — tasks, lists, folders, docs, time tracking, and chat. This is a **vendor-hosted MCP** (we don't build or maintain it). Available on all ClickUp plans.

## Available Tools

ClickUp exposes tools across these categories (per [official tool reference](https://developer.clickup.com/docs/mcp-tools)):

- **Search** — Full-text search across tasks, lists, folders, docs
- **Task Management** — CRUD tasks (including bulk), file attachments, tags
- **Comments** — Read and post comments on tasks
- **Time Tracking** — Start/stop timers, log time entries
- **Workspace Hierarchy** — Navigate and manage spaces, folders, lists
- **Members** — Look up workspace members, resolve assignees
- **Chat** — Read channels and send messages
- **Docs** — Create documents, manage pages

Tool names and availability may change as ClickUp's MCP exits beta. Use `tools/list` after authentication to discover the current tool set.

## Integration Notes

No bundled code or credentials on our side — authentication is fully managed by ClickUp's OAuth flow via Super-MCP. ClickUp maintains an [allowlist of vetted MCP client redirect URIs](https://developer.clickup.com/docs/connect-an-ai-assistant-to-clickups-mcp-server); Super-MCP's OAuth proxy must be compatible with their flow for connections to succeed.

## Connection Flow

1. User clicks "Add" for ClickUp in Settings → Connectors
2. Server config added to Super-MCP router
3. OAuth flow opens in browser (user signs in, selects workspace)
4. User authorizes access
5. Tokens exchanged and stored by Super-MCP

## Limitations

- **No deletion**: ClickUp has intentionally disabled deletion tools as a safety measure
- **Rate limits**: Wraps ClickUp's existing API; subject to [ClickUp rate limits](https://developer.clickup.com/docs/rate-limits)
- **OAuth only**: Cannot authenticate with API keys or personal access tokens
- **Workspace-scoped**: Each connection is scoped to one workspace

## Troubleshooting

### "Authentication required" after connecting
Disconnect and reconnect the ClickUp integration in Settings → Connectors.

### Rate limit errors
ClickUp's MCP wraps their REST API. LLM tool calls that trigger many API calls in sequence can hit rate limits. If this happens, wait briefly and retry.

### Missing workspace data
ClickUp permissions apply — users only see data they have access to in their workspace.

## References

- [ClickUp MCP Server](https://developer.clickup.com/docs/connect-an-ai-assistant-to-clickups-mcp-server) — Official overview
- [Setup Instructions](https://developer.clickup.com/docs/connect-an-ai-assistant-to-clickups-mcp-server-1) — Client setup guide
- [Supported Tools](https://developer.clickup.com/docs/mcp-tools) — Full tool reference
- [Rate Limits](https://developer.clickup.com/docs/rate-limits) — API rate limit details
- [Feedback](https://feedback.clickup.com/public-api/p/clickup-mcp-server-first-party-and-official) — ClickUp MCP beta feedback
