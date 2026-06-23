---
description: "Basecamp MCP connector reference — community OAuth setup, stdio architecture, project tools, env vars, alternatives"
last_updated: "2026-05-14"
---

# Basecamp MCP

**Status**: Beta
**Provider**: Community (`@aexol-studio/basecamp-to-llm`)
**Category**: Productivity
**Auth**: OAuth 2.0 (user-created OAuth app + built-in auth tool)

## Overview

Community MCP connector for Basecamp project management. Uses the `@aexol-studio/basecamp-to-llm` npm package (MIT, TypeScript) which provides 13 tools covering projects, kanban boards, cards, comments, people, and steps.

## Architecture

- **Transport**: stdio via `npx -y @aexol-studio/basecamp-to-llm@1.3.2 mcp`
- **Auth flow**: User provides OAuth client credentials via setup fields. The MCP server exposes an `authenticate` tool that the AI calls to initiate the browser-based OAuth flow with a localhost callback server on port 8787.
- **Token storage**: Managed by the package internally (not by Rebel's credential system)
- **API**: Basecamp REST JSON API at `https://3.basecampapi.com/{ACCOUNT_ID}/...`

## Setup Requirements

1. User creates an OAuth integration at https://launchpad.37signals.com/integrations
2. Sets redirect URI to `http://localhost:8787/callback`
3. Enters Client ID and Client Secret in Rebel's setup form
4. After connecting, asks Rebel to authenticate — triggers browser OAuth flow

## Tools (13)

| Tool | Description |
|------|-------------|
| `authenticate` | Start OAuth flow (opens browser) |
| `api_request` | Generic Basecamp API request |
| `sdk_projects_list` | List projects |
| `sdk_card_tables_get` | Get kanban board with columns and cards |
| `sdk_card_tables_get_card` | Get a single card |
| `sdk_card_tables_get_enriched` | Get enriched card with comments and attachments |
| `sdk_card_tables_create_task` | Create a card with checklist steps |
| `sdk_card_tables_update_card` | Update card title, content, due date, or assignees |
| `sdk_card_tables_move_card` | Move a card to a different column |
| `sdk_people_list` | List all people in the account |
| `sdk_comments_create` | Add a comment to a recording |
| `sdk_steps_complete` | Mark a step as completed or uncompleted |
| `sdk_attachments_download` | Download attachment as base64 |

## Env Vars

| Variable | Source | Description |
|----------|--------|-------------|
| `BASECAMP_CLIENT_ID` | Setup field | OAuth client ID from 37signals |
| `BASECAMP_CLIENT_SECRET` | Setup field | OAuth client secret from 37signals |
| `BASECAMP_REDIRECT_URI` | Default (`http://localhost:8787/callback`) | OAuth callback URL |
| `BASECAMP_USER_AGENT` | Default (`Rebel (basecamp-mcp)`) | Required by Basecamp API |

## Version

Pinned to `@aexol-studio/basecamp-to-llm@1.3.2` (Feb 2026). Update requires changing the version in `connector-catalog.json` and testing.

## Alternatives Considered

- `basecamp-mcp` (stefanoverna): 24 tools but requires manual refresh token acquisition
- `georgeantonopoulos/Basecamp-MCP-Server`: 64 tools, Python (not preferred for catalog)
- `jhliberty/basecamp-mcp-server`: 46 tools, not published to npm

See `docs/plans/finished/260223_basecamp_mcp_connector.md` for full research.
