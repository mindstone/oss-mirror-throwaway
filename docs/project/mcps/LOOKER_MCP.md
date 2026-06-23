---
description: "Looker MCP connector via Google MCP Toolbox — API3 auth, setup requirements, dashboard/query/model access"
last_updated: "2025-12-25"
---

# Looker MCP

| Property | Value |
|----------|-------|
| **Provider** | Community (Google MCP Toolbox) |
| **Transport** | stdio via `npx mcp-toolbox` |
| **Auth** | Looker API3 credentials (Client ID + Secret) |
| **Status** | UNTESTED - needs validation |

## Overview

Looker integration via Google's official MCP Toolbox. Enables querying Looker dashboards, explores, and data models.

## Setup Requirements

1. **Looker Admin Access** - User needs permission to create API3 keys
2. **API3 Credentials** - Client ID and Client Secret from Looker Admin > Users > API3 Keys
3. **Node.js** - Required for `npx` execution

## Configuration

The connector uses Pattern 4c (community MCP with setup fields):
- `LOOKER_BASE_URL` - Looker instance URL (e.g., `https://your-instance.cloud.looker.com`)
- `LOOKER_CLIENT_ID` - API3 Client ID
- `LOOKER_CLIENT_SECRET` - API3 Client Secret

## Available Tools

Exposed via `mcp-toolbox --prebuilt looker`:
- Query Looker explores
- Access dashboard data
- Retrieve LookML model metadata

See [MCP Toolbox Looker docs](https://googleapis.github.io/genai-toolbox/how-to/connect-ide/looker_mcp/) for full tool reference.

## References

- [Google Cloud: Introducing Looker MCP Server](https://cloud.google.com/blog/products/business-intelligence/introducing-looker-mcp-server)
- [Looker API Authentication](https://cloud.google.com/looker/docs/api-auth)
- [MCP Toolbox GitHub](https://github.com/googleapis/genai-toolbox)
