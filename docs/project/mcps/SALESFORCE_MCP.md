---
description: "Salesforce CRM MCP connector — installable from mindstone/mcp-servers GitHub org"
last_updated: "2026-05-11"
status: active
---

# Salesforce MCP

OSS MCP server for Salesforce CRM access. Installable from the [`mindstone/mcp-servers`](https://github.com/mindstone/mcp-servers) GitHub org; surfaces in Rebel via Settings → Connectors. Runs locally for privacy — data never leaves your machine.

**Status**: Active — migrated from bundled to OSS in v0.4.35 (260429 batch)

## See Also

- [MCP_ARCHITECTURE.md](../MCP_ARCHITECTURE.md) - General MCP configuration
- [MCP_IMPROVEMENT_WORKFLOW.md](../MCP_IMPROVEMENT_WORKFLOW.md) - How this MCP was designed
- [KLAVIS_TO_BUNDLED_MCP_MIGRATION.md](../KLAVIS_TO_BUNDLED_MCP_MIGRATION.md) - Migration strategy
- [260107_salesforce_pkce_oauth.md](../../plans/partway/260107_salesforce_pkce_oauth.md) - PKCE OAuth implementation plan
- [260109_salesforce_mcp_anthropic_guidelines.md](../../plans/finished/260109_salesforce_mcp_anthropic_guidelines.md) - Tool design improvements


## Overview

The Salesforce MCP provides access to core CRM objects:
- **Accounts** - Companies and organizations
- **Contacts** - People at accounts
- **Opportunities** - Sales pipeline deals
- **Leads** - Prospective customers
- **SOQL Queries** - Direct database queries for advanced use cases


## Tools

| Tool | Description |
|------|-------------|
| `salesforce_list_connected_accounts` | List connected Salesforce accounts |
| `salesforce_connect_account` | Start OAuth flow for new account |
| `salesforce_disconnect_account` | Disconnect an account |
| `salesforce_get_accounts` | Query CRM accounts with filtering |
| `salesforce_create_account` | Create new CRM account |
| `salesforce_update_account` | Update existing CRM account |
| `salesforce_get_contacts` | Query contacts with filtering |
| `salesforce_create_contact` | Create new contact |
| `salesforce_update_contact` | Update existing contact |
| `salesforce_get_opportunities` | Query opportunities with filtering |
| `salesforce_create_opportunity` | Create new opportunity |
| `salesforce_update_opportunity` | Update existing opportunity |
| `salesforce_get_leads` | Query leads with filtering |
| `salesforce_create_lead` | Create new lead |
| `salesforce_convert_lead` | Convert lead to account/contact/opportunity |
| `salesforce_query` | Execute raw SOQL query |
| `salesforce_describe_object` | Get object schema metadata |


## Setup Requirements

### 1. Create a Salesforce External Client App

> **Note:** Salesforce replaced "Connected Apps" with "External Client Apps" as of Spring '26. The setup is similar but the UI paths have changed.

In your Salesforce org:
1. Go to **Setup** → search "External Client App" → **External Client App Manager**
2. Click **Create New External Client App**
3. Enter a name (e.g. "Mindstone Rebel"), your email, set **Distribution State** to **Local**
4. Under **API (Enable OAuth Settings)**, check **Enable OAuth**
5. Configure OAuth Settings:
   - **Callback URL**: `https://rebel-auth.mindstone.com/salesforce/callback`
   - **OAuth Scopes**: 
     - `api` (Manage user data via APIs)
     - `refresh_token` (Perform requests at any time)
     - `offline_access` (Access your data offline)
6. Click **Create**
7. Reopen the app from **Manage External Client Apps**
8. In the **Settings** tab → **OAuth Settings** → click **Consumer Key and Secret** to copy them
9. In the **Policies** tab → click **Edit** → set **Refresh token is valid until revoked** → **Save**

> **Note:** The callback URL uses Cloudflare redirect + PKCE for improved reliability in enterprise environments where localhost loopback may be blocked.

> **Note:** If you see "Insufficient Privileges" when viewing Consumer Key/Secret, your profile needs the "View all External Client Apps, views their settings, and edit policies" permission.

### 2. Configure User Permissions

**CRITICAL**: Users must have the **"API Enabled"** permission to use the Salesforce API.

Create a Permission Set:
1. Go to **Setup** → **Permission Sets** → **New**
2. Name: "Mindstone Rebel API Access"
3. Under **System Permissions**, enable:
   - **API Enabled** ✓
4. Under **Object Permissions**, enable Read/Create/Edit for:
   - Accounts
   - Contacts
   - Opportunities
   - Leads
5. Assign to users who need Rebel integration

### 3. Configure in Rebel

In Rebel Settings:
1. Enable Salesforce under Connectors
2. Enter your Connected App Consumer Key (Client ID) and Consumer Secret
3. Click "Set up with Rebel" to start OAuth flow
4. Complete authentication in your browser
5. Return to Rebel - a configuration chat will start to verify your setup


## See Also

- [MCP_OSS_CONNECTORS.md](../MCP_OSS_CONNECTORS.md) — OSS connector architecture, install lifecycle, and the 260429 migration batch this connector belongs to
- [MCP_ARCHITECTURE.md](../MCP_ARCHITECTURE.md) — General MCP configuration
- [KLAVIS_TO_BUNDLED_MCP_MIGRATION.md](../KLAVIS_TO_BUNDLED_MCP_MIGRATION.md) — Legacy migration context
- [260107_salesforce_pkce_oauth.md](../../plans/partway/260107_salesforce_pkce_oauth.md) — PKCE OAuth implementation plan
- [260109_salesforce_mcp_anthropic_guidelines.md](../../plans/finished/260109_salesforce_mcp_anthropic_guidelines.md) — Tool design improvements


## Architecture

The connector source lives in the [`mindstone/mcp-servers`](https://github.com/mindstone/mcp-servers) monorepo under `packages/mcp-server-salesforce/`. The packaged npm artifact (`@mindstone-engineering/mcp-server-salesforce`) is installed by Rebel's managed-install service on first connect.

```
packages/mcp-server-salesforce/src/
├── index.ts              # Entry point
├── modules/
│   └── accounts/         # Token and connection management
│       ├── token.ts      # Token storage
│       ├── manager.ts    # Connection management
│       └── types.ts      # Type definitions
├── tools/
│   ├── definitions.ts    # Tool schemas (Anthropic-compliant)
│   ├── handlers.ts       # Tool implementations
│   └── server.ts         # MCP server
└── utils/
    └── logger.ts
```

OAuth authentication is handled by the main process (`src/main/services/salesforceAuthService.ts`) using PKCE + Cloudflare redirect + deep link callback pattern.

### Token Storage

OAuth tokens are stored locally in the Electron userData directory:
```
<userData>/salesforce-mcp/credentials/<username>.token.json
```

On macOS: `~/Library/Application Support/mindstone-rebel/salesforce-mcp/`


## Common Issues

### "API Enabled" Permission Error

**Symptom**: API calls fail for non-admin users

**Cause**: Standard Salesforce profiles often have "API Enabled" disabled by default

**Solution**: Create a Permission Set with "API Enabled" and assign to users (see Setup Requirements above)

### OAuth Callback Error

**Symptom**: OAuth flow doesn't complete

**Causes**:
1. Callback URL mismatch - ensure External Client App uses `https://rebel-auth.mindstone.com/salesforce/callback`
2. Client ID/Secret incorrect
3. Authorization timed out (5 minute limit)

### Session Expired

**Symptom**: `INVALID_SESSION_ID` error

**Solution**: Re-authenticate using `salesforce_connect_account`


## Sandbox vs Production

Currently, only **production** Salesforce orgs are supported (`login.salesforce.com`).

Sandbox support (`test.salesforce.com`) is planned for a future update. The OAuth endpoints differ between environments:
- Production: `https://login.salesforce.com/services/oauth2/`
- Sandbox: `https://test.salesforce.com/services/oauth2/`


## Environment Variables

| Variable | Description |
|----------|-------------|
| `SALESFORCE_CONFIG_DIR` | Token storage directory (Rebel sets this automatically to userData) |

Note: Client ID and Client Secret are stored in app settings, not environment variables.


## Development

The connector lives in the `mindstone/mcp-servers` monorepo. Clone and build from there:

```bash
git clone https://github.com/mindstone/mcp-servers.git
cd mcp-servers/packages/mcp-server-salesforce
npm install
npm run build

# Test locally (requires real credentials)
SALESFORCE_CLIENT_ID=xxx SALESFORCE_CLIENT_SECRET=xxx npm start
```


## References

- [Salesforce REST API Guide](https://developer.salesforce.com/docs/atlas.en-us.api_rest.meta/api_rest/)
- [jsforce Documentation](https://jsforce.github.io/)
- [OAuth 2.0 Web Server Flow](https://help.salesforce.com/s/articleView?id=sf.remoteaccess_oauth_web_server_flow.htm)
- [Klavis Salesforce MCP](https://github.com/Klavis-AI/klavis/tree/main/mcp_servers/salesforce) - Reference implementation
