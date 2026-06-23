---
description: "Omni Analytics MCP connector — semantic-layer querying, direct OAuth architecture, model/topic/data tools, prerequisites"
last_updated: "2026-03-23"
---

# Omni Analytics MCP

Connect Rebel to Omni Analytics for natural language querying through Omni's semantic layer.

| Property | Value |
|----------|-------|
| **Status** | Beta |
| **Type** | Direct MCP (vendor-hosted) |
| **Provider** | Omni (official) |
| **Source** | https://docs.omni.co/ai/mcp |
| **Auth** | OAuth 2.1 with PKCE (recommended) or API Key |
| **Tools** | 3: `pickModel`, `pickTopic`, `getData` |
| **Catalog ID** | `omni-analytics` |


## Overview

Omni Analytics is a BI platform (Looker/Tableau alternative). Their official MCP server enables natural language querying across datasets through Omni's semantic layer. Users select a model, pick a topic, and run queries — all via the three MCP tools.


## Architecture

This is a **direct** connector — Omni hosts the MCP server, no bundled code needed.

- **OAuth endpoint**: `https://callbacks.omniapp.co/callback/mcp` — handles both OAuth routing and MCP requests
- **API key endpoint**: `https://<INSTANCE>/mcp/https` — per-instance, not used in our catalog entry
- **Transport**: HTTP (Streamable HTTP)


## Tools

| Tool | Purpose |
|------|---------|
| `pickModel` | Lists available Omni models and their IDs |
| `pickTopic` | Lists topics within a selected model |
| `getData` | Executes a natural language query against a model/topic |


## Auth Flow

OAuth 2.1 with PKCE:
1. User clicks Connect in Rebel
2. Browser opens Omni authorization page (routes via last active Omni session cookie)
3. User authorizes, Omni creates an MCP OAuth PAT automatically
4. All subsequent queries use the authenticated user's permissions

**Multi-org caveat**: OAuth routes to the user's last logged-in Omni instance. Users in multiple orgs should sign into the correct one before connecting.

**Prerequisites** (org admin):
- Enable MCP Server: Settings > AI > General
- Enable PATs: Settings > API Keys > Personal tokens


## References

- Omni MCP docs: https://docs.omni.co/ai/mcp
- Omni MCP auth: https://docs.omni.co/ai/mcp/authentication
- Community request: https://rebels.mindstone.com/t/omni-connection-would-be-great/109
- Linear ticket: FOX-2917
