---
description: "ServiceNow bundled MCP connector — Basic Auth setup, incident/change/knowledge/user tools, catalog entry, authentication"
last_updated: "2026-02-19"
---

# ServiceNow MCP

Enterprise IT Service Management platform. Query and manage incidents, change requests, knowledge base articles, and users.

**Status**: Implemented (Feb 2026)

**Tool Count**: 10 tools across 5 categories

## See Also

- [MCP_ARCHITECTURE.md](../MCP_ARCHITECTURE.md) - General MCP configuration and discovery
- [MCP_IMPROVEMENT_WORKFLOW.md](../MCP_IMPROVEMENT_WORKFLOW.md) - Development workflow for MCP improvements
- API docs: [ServiceNow REST Table API](https://developer.servicenow.com/dev.do#!/reference/api/latest/rest/c_TableAPI)
- Source code: `resources/mcp/servicenow/`
- Linear: FOX-2573


## Overview

ServiceNow is available as a **bundled MCP** that runs locally with Basic Auth (username/password).

| Attribute | Value |
|-----------|-------|
| **Provider** | Bundled MCP |
| **Auth** | HTTP Basic Auth (username + password) |
| **Data flow** | Local only |
| **Setup** | Enter instance name + username + password |
| **Rate limits** | Instance-dependent (typically 1,000+ requests/hour) |


## Connector Catalog Entry

```json
{
  "id": "bundled-servicenow",
  "name": "ServiceNow",
  "provider": "bundled",
  "bundledConfig": {
    "authType": "api-key",
    "settingsKey": "servicenow.enabled",
    "serverName": "ServiceNow",
    "setupToolName": "configure_servicenow"
  }
}
```


## Tools

### Configuration

| Tool | Description |
|------|-------------|
| `configure_servicenow` | Configure instance name, username, and password |

### Incidents

| Tool | Description |
|------|-------------|
| `list_servicenow_incidents` | List/search incidents with encoded query support |
| `get_servicenow_incident` | Get incident by number (INC0010001) or sys_id |
| `create_servicenow_incident` | Create a new incident |
| `update_servicenow_incident` | Update an existing incident by sys_id |

### Change Requests

| Tool | Description |
|------|-------------|
| `list_servicenow_change_requests` | List/search change requests |
| `get_servicenow_change_request` | Get change request by number (CHG0010001) or sys_id |

### Knowledge Base

| Tool | Description |
|------|-------------|
| `search_servicenow_knowledge` | Search KB articles by keyword or encoded query |
| `get_servicenow_knowledge_article` | Get full article including body text |

### Users

| Tool | Description |
|------|-------------|
| `list_servicenow_users` | List/search users by name, department, etc. |


## Authentication

- **Method**: HTTP Basic Auth
- **Username**: ServiceNow username
- **Password**: ServiceNow password
- **Requirements**: Account with `itil` and `knowledge` roles for full access
- **Base URL**: `https://{instance}.service-now.com/api/now/table/`


## Setup Flow

1. Go to **Settings -> Connectors** -> Find **ServiceNow**
2. Click **"Set up"**
3. Enter your ServiceNow instance name (e.g., `acme` for `acme.service-now.com`)
4. Enter your ServiceNow username and password
5. Click **Connect**

**Recommended roles for the integration user:**
- `itil` - Read/write access to incidents, change requests, and tasks
- `knowledge` - Read/write access to knowledge base articles
- `personalize_dictionary` - Optional, for sys_user table access


## Technical Details

- **Type**: Bundled MCP (maintained by Mindstone)
- **Transport**: stdio (runs as subprocess)
- **Server script**: `resources/mcp/servicenow/build/index.js`
- **Environment Variables**:
  - `SERVICENOW_INSTANCE` (required) - ServiceNow instance name
  - `SERVICENOW_USERNAME` (required) - ServiceNow username
  - `SERVICENOW_PASSWORD` (required) - ServiceNow password


## Known Limitations

- **No OAuth flow**: Uses Basic Auth only. For environments requiring OAuth, a future update may add support.
- **Instance name only**: Currently expects `{instance}.service-now.com` format. Custom domains are not yet supported.
- **List limits**: Default 20 results per query. Use `limit` and `offset` parameters for pagination.
- **Response size**: List operations use `sysparm_fields` to keep responses compact (<10KB).
- **ServiceNow query syntax**: Filters use ServiceNow's encoded query language (e.g., `active=true^priority=1`). See [Encoded Query Strings](https://developer.servicenow.com/dev.do#!/learn/learning-plans/utah/encoded_queries).


## Troubleshooting

**"Invalid credentials or insufficient permissions":**
1. Verify instance name, username, and password are correct
2. Ensure the account has the `itil` and `knowledge` roles
3. Check that the account is active and not locked

**"Could not reach ServiceNow":**
1. Verify your instance name is correct (e.g., `acme` not `acme.service-now.com`)
2. Check that your ServiceNow instance is online and accessible
3. Ensure there are no network restrictions blocking the connection

**"Rate limited":**
- Wait before retrying
- Rate limits are configured per-instance by your ServiceNow admin
