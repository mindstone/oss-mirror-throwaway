---
description: "Mailchimp MCP connector for email marketing data — campaigns, audiences, subscribers, automations, reports, setup"
last_updated: "2026-02-20"
---

# Mailchimp MCP

Email marketing data: campaigns, audiences, subscribers, templates, automations, and analytics from Mailchimp.

## See Also

- [MCP_ARCHITECTURE.md](../MCP_ARCHITECTURE.md) - How MCPs are configured
- [MCP_IMPROVEMENT_WORKFLOW.md](../MCP_IMPROVEMENT_WORKFLOW.md) - Third-party MCP integration patterns
- [Mailchimp Marketing API](https://mailchimp.com/developer/marketing/api/) - Official API reference


## Overview

| Attribute | Value |
|-----------|-------|
| **ID** | `mailchimp` |
| **Provider** | Community (`@agentx-ai/mailchimp-mcp-server`) |
| **Version** | `1.1.1` (pinned) |
| **Auth** | API key (single key with data center suffix) |
| **Status** | Added Feb 2026 |
| **Maturity** | Beta |

Mailchimp is the dominant email marketing platform. This connector uses the community-maintained `@agentx-ai/mailchimp-mcp-server` package by AgentX AI, providing read-only access to the Mailchimp Marketing API v3.


## Connector Catalog Entry

```json
{
  "id": "mailchimp",
  "name": "Mailchimp",
  "description": "Email marketing data: view campaigns, audiences, subscribers, templates, automations, and reports.",
  "category": "sales",
  "provider": "community",
  "mcpConfig": {
    "transport": "stdio",
    "command": "npx",
    "args": ["-y", "@agentx-ai/mailchimp-mcp-server@1.1.1"]
  },
  "icon": "mail",
  "popular": false,
  "verified": false,
  "verifiedSource": "https://github.com/AgentX-ai/mailchimp-mcp",
  "requiresSetup": true,
  "setupUrl": "https://admin.mailchimp.com/account/api/",
  "setupUrlBehavior": "button",
  "setupFields": [
    { "id": "apiKey", "label": "Mailchimp API Key", "type": "password", "envVar": "MAILCHIMP_API_KEY" }
  ],
  "accountIdentity": "email",
  "maturity": "beta"
}
```


## Tools

The MCP provides 30+ read-only tools across these domains:

| Domain | Tools | Description |
|--------|-------|-------------|
| **Campaigns** | `list_campaigns`, `get_campaign` | View all campaigns and their details |
| **Lists/Audiences** | `list_lists`, `get_list` | View audience lists and details |
| **Members** | `list_members`, `get_member` | View subscribers in a list |
| **Segments** | `list_segments`, `get_segment` | View audience segments |
| **Templates** | `list_templates`, `get_template` | View email templates |
| **Automations** | `list_automations`, `get_automation`, `list_automation_emails`, `get_automation_email` | View classic automations and their emails |
| **Reports** | `list_campaign_reports`, `get_campaign_report`, `get_automation_report`, `get_automation_email_report`, `get_subscriber_activity` | Campaign and automation analytics |
| **Account** | `get_account` | Account info and statistics |
| **Folders** | `list_folders`, `get_folder` | Campaign folder management |
| **Files** | `list_files`, `get_file` | File Manager contents |
| **Landing Pages** | `list_landing_pages`, `get_landing_page` | Landing page details |
| **E-commerce** | `list_stores`, `get_store`, `list_products`, `get_product`, `list_orders`, `get_order` | Connected store data |
| **Conversations** | `list_conversations`, `get_conversation` | Mailchimp conversations |
| **Merge Fields** | `list_merge_fields`, `get_merge_field` | Custom fields on lists |


## Usage Examples

**List recent campaigns:**
```
Show my recent Mailchimp campaigns
```

**Check audience size:**
```
How many subscribers are on my main list?
```

**Campaign performance:**
```
What's the open rate on my last campaign?
```

**View templates:**
```
Show my Mailchimp email templates
```


## Setup

**Prerequisites:**
- A Mailchimp account (any plan)
- Node.js installed locally (required for npx)

**Get your API key:**
1. Go to [Mailchimp API Keys](https://admin.mailchimp.com/account/api/)
2. Click **Create A Key**
3. Name it (e.g., "Rebel") and click **Generate Key**
4. Copy the key immediately -- it won't be shown again

**Configure in Rebel:**
1. Go to **Settings > Connectors**
2. Find **Mailchimp** and click **Set up**
3. Paste the API key
4. Click **Connect**

**API key format:** Keys include a data center suffix (e.g., `xxxxxxxxxxxxxxxx-us1`). The MCP server extracts the data center automatically.


## Technical Details

- **Type**: Community MCP (third-party)
- **Transport**: stdio (runs via npx)
- **Package**: `@agentx-ai/mailchimp-mcp-server@1.1.1`
- **License**: MIT
- **Author**: AgentX AI
- **Repository**: https://github.com/AgentX-ai/mailchimp-mcp
- **npm**: https://www.npmjs.com/package/@agentx-ai/mailchimp-mcp-server
- **Environment Variables**:
  - `MAILCHIMP_API_KEY` (required) - Mailchimp API key with data center suffix
- **API**: Mailchimp Marketing API v3 (read-only operations only)


## Security Notes

- **API key scope**: Mailchimp API keys grant full account access (read + write). The MCP server only exposes read-only tools, but the underlying key has broader permissions.
- **Read-only**: All 30+ tools are read-only (no create/update/delete operations)
- **HTTPS enforced**: All API calls use HTTPS to `<dc>.api.mailchimp.com`
- **Version pinned**: Package version pinned to `1.1.1` to mitigate supply chain risk
- **Re-audit on version bump**: Review source code before updating the pinned version

**Code review notes (Feb 2026):** Community package from AgentX AI (7 GitHub stars, MIT license). TypeScript implementation using `@mailchimp/mailchimp_marketing` SDK. Credentials handled via environment variables only.


## Known Limitations

- **Read-only**: Cannot create campaigns, add subscribers, or modify any data
- **Classic automations only**: Automation endpoints cover classic automations, not Customer Journey Builder flows (Mailchimp API limitation)
- **Community maintained**: Not an official Mailchimp MCP -- may lag behind API changes
- **No OAuth**: Uses API keys (full account access), not OAuth with scoped permissions


## Troubleshooting

**"Missing required environment variables" error:**
1. Verify the API key is entered in Settings > Connectors
2. Disconnect and reconnect the Mailchimp connector

**"401 Unauthorized" or authentication errors:**
1. Verify your API key at [Mailchimp API Keys](https://admin.mailchimp.com/account/api/)
2. Check the key includes the data center suffix (e.g., `-us1`)
3. Generate a new key if needed

**"Server not found" or connection errors:**
1. Ensure Node.js is installed (`node --version` in terminal)
2. Check internet connectivity (npx needs to download the package)

**Empty results:**
- Verify your Mailchimp account has campaigns, lists, or subscribers
- Check that you're using the correct account (if you have multiple)


## Alternatives

| Service | Type | Notes |
|---------|------|-------|
| **Mailchimp** (this doc) | Community MCP | Local, version-pinned, read-only |
| **HubSpot** | Bundled MCP | [HUBSPOT_MCP.md](HUBSPOT_MCP.md) - CRM with marketing email tools |
| **Mixmax** | Bundled MCP | Sales email sequences and templates |


## References

- [Mailchimp Marketing API v3](https://mailchimp.com/developer/marketing/api/)
- [About Mailchimp API Keys](https://mailchimp.com/help/about-api-keys/)
- [@agentx-ai/mailchimp-mcp-server on GitHub](https://github.com/AgentX-ai/mailchimp-mcp)
- [@agentx-ai/mailchimp-mcp-server on npm](https://www.npmjs.com/package/@agentx-ai/mailchimp-mcp-server)
