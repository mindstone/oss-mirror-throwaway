---
description: "Freshdesk bundled MCP reference — ticket management, search, replies, notes, API key auth, storage, tests"
last_updated: "2026-05-15"
---

# Freshdesk MCP

**Status**: Active
**Provider**: Bundled
**Auth**: API key (Basic auth with `apiKey:X`)
**Tool Count**: 11 tools across 5 categories

## See Also

- [MCP_ARCHITECTURE.md](../MCP_ARCHITECTURE.md) — General MCP configuration and discovery
- [MCP_IMPROVEMENT_WORKFLOW.md](../MCP_IMPROVEMENT_WORKFLOW.md) — Development workflow for MCP improvements
- [260223_freshdesk_mcp_connector.md](../../plans/partway/260223_freshdesk_mcp_connector.md) — Planning doc (API details, review history, stage notes)
- Source code: `resources/mcp/freshdesk/`
- Tests: `resources/mcp/freshdesk/test-mcp.test.ts`
- Connector catalog entry: `resources/connector-catalog.json` (`bundled-freshdesk`)
- Manager integration: `src/main/services/bundledMcpManager.ts` (`BUNDLED_MCP_CATALOG.Freshdesk`)
- Bridge endpoint: `src/main/services/bundledInboxBridge.ts` (`/bundled/freshdesk/configure`)


## Overview

The Freshdesk MCP provides access to Freshdesk Support for ticket management, search, replies, and internal notes. It is a **bundled MCP** that runs locally with API key authentication.

```
resources/mcp/freshdesk/
├── src/
│   └── index.ts          # All tools, handlers, and MCP server (~870 LOC)
├── test-mcp.test.ts      # Mock API tests (26 tests)
├── package.json
├── tsconfig.json
└── build/                # Compiled JS (gitignored)
```


## Tools

### Account Management

| Tool | API Endpoint | Description |
|------|-------------|-------------|
| `configure_freshdesk` | Bridge `/bundled/freshdesk/configure` | Connect a Freshdesk account (domain + API key) |
| `list_freshdesk_accounts` | Local `accounts.json` | List connected accounts with status |
| `remove_freshdesk_account` | Local | Disconnect an account |

### Ticket Listing & Search

| Tool | API Endpoint | Description |
|------|-------------|-------------|
| `list_freshdesk_tickets` | `GET /api/v2/tickets` | List tickets using predefined filters (new_and_my_open, watching, spam, deleted) |
| `get_freshdesk_ticket` | `GET /api/v2/tickets/{id}` | Get a single ticket with optional conversations |
| `search_freshdesk_tickets` | `GET /api/v2/search/tickets` | Search tickets using Freshdesk query syntax |

### Ticket Creation & Mutation

| Tool | API Endpoint | Description |
|------|-------------|-------------|
| `create_freshdesk_ticket` | `POST /api/v2/tickets` | Create ticket (requires email, subject, description) |
| `update_freshdesk_ticket` | `PUT /api/v2/tickets/{id}` | Update status, priority, assignee, tags, custom fields |

### Replies & Notes

| Tool | API Endpoint | Description |
|------|-------------|-------------|
| `reply_to_freshdesk_ticket` | `POST /api/v2/tickets/{id}/reply` | Add a public reply (visible to customer) |
| `add_freshdesk_note` | `POST /api/v2/tickets/{id}/notes` | Add a note (private/internal by default) |

### Discovery

| Tool | API Endpoint | Description |
|------|-------------|-------------|
| `list_freshdesk_ticket_fields` | `GET /api/v2/admin/ticket_fields` | List ticket fields including custom fields |


## Authentication

Freshdesk uses API key authentication via Basic auth:

```
Authorization: Basic base64("{apiKey}:X")
```

No email is required for API auth (unlike Zendesk). The API key is found in Freshdesk under Profile Picture → Profile Settings → API Key.

### Credential Storage

Accounts are stored in `accounts.json` at the path specified by the `FRESHDESK_CONFIG_PATH` environment variable (defaults to `~/.mcp/freshdesk`). In Mindstone, the actual path is `{userData}/mcp/freshdesk/`.

```json
{
  "accounts": [
    {
      "domain": "acme",
      "apiKey": "...",
      "agentEmail": "[external-email]",
      "authenticatedAt": "2026-02-23T10:00:00.000Z"
    }
  ],
  "defaultDomain": "acme"
}
```

- **Hot-reload**: Accounts are reloaded from disk on every tool call (no restart needed).
- **File permissions**: `accounts.json` is written with `0o600` (owner read/write only).
- **Credential verification**: On setup, the bridge verifies credentials via `GET /api/v2/agents/me` (falls back to `GET /api/v2/tickets?per_page=1` if 404).
- **Upsert by domain**: Re-configuring an existing domain updates the account in place.


## Freshdesk API Quirks

### Numeric Status & Priority

Freshdesk uses numeric values for status and priority. The MCP accepts both numeric and human-readable names in tool parameters:

**Status**: `2`=Open, `3`=Pending, `4`=Resolved, `5`=Closed (custom statuses may have higher values)

**Priority**: `1`=Low, `2`=Medium, `3`=High, `4`=Urgent

**Source** (read-only): `1`=Email, `2`=Portal, `3`=Phone, `7`=Chat, `8`=Feedback Widget, `9`=Outbound Email

### Rate Limits

Rate limits vary by Freshdesk plan:

| Plan | Requests/min |
|------|-------------|
| Blossom / Free | 100 |
| Garden | 200 |
| Estate | 400 |
| Forest | 700 |

The MCP handles 429 responses with `Retry-After` header information in error messages.

### Search Syntax

Freshdesk uses its own filter language (different from Zendesk):

```
"status:2"                          — Open tickets
"priority:4"                        — Urgent
"agent_id:1234"                     — Assigned to agent
"group_id:5678"                     — Assigned to group
"created_at:>'2024-01-01'"          — Created after date
"updated_at:<'2024-06-01'"          — Updated before date
"tag:'billing'"                     — With tag
"requester.email:'[external-email]'"   — By requester email
"type:'Bug'"                        — By ticket type
"subject:'login issue'"             — By subject keyword
```

Combine with `AND`/`OR`: `"status:2 AND priority:4"`

The MCP auto-wraps queries in `"..."` if not already quoted.

### Pagination

- **List endpoints**: Max 30 tickets per page (`per_page` capped at 30)
- **Search results**: Max 30 results per page
- Both use offset-based pagination with `page` parameter

### Key Differences from Zendesk

| Aspect | Zendesk | Freshdesk |
|--------|---------|-----------|
| Auth | `{email}/token:{apiToken}` | `{apiKey}:X` (simpler) |
| Reply | Update ticket with comment | Dedicated `POST /tickets/{id}/reply` |
| Notes | Internal comment via update | Dedicated `POST /tickets/{id}/notes` |
| Status values | String-based | Numeric (2-5) |
| Ticket list page size | Up to 100 | Max 30 |
| Search syntax | Zendesk query language | Freshdesk filter language |
