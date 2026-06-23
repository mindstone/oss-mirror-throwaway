---
description: "Pipedrive MCP connector — CRM deals, contacts, organisations, activities, pipelines, setup, catalog entry, tool coverage"
last_updated: "2026-02-19"
---

# Pipedrive MCP

SMB CRM: deals, contacts, organisations, activities, pipelines, and sales reporting.

## See Also

- [MCP_ARCHITECTURE.md](../MCP_ARCHITECTURE.md) - How MCPs are configured
- [MCP_IMPROVEMENT_WORKFLOW.md](../MCP_IMPROVEMENT_WORKFLOW.md) - Third-party MCP integration patterns
- [Pipedrive API Documentation](https://developers.pipedrive.com/docs/api/v1) - Official API reference


## Overview

| Attribute | Value |
|-----------|-------|
| **ID** | `pipedrive` |
| **Provider** | Community (`@iamsamuelfraga/mcp-pipedrive`) |
| **Version** | `2.0.0` (pinned) |
| **Auth** | API token (single env var) |
| **Status** | Added Feb 2026 |
| **Maturity** | Beta |

Pipedrive is the #1 CRM for SMBs (100K+ customers). This connector uses the community-maintained `@iamsamuelfraga/mcp-pipedrive` package which provides comprehensive coverage of Pipedrive's API.


## Connector Catalog Entry

```json
{
  "id": "pipedrive",
  "name": "Pipedrive",
  "description": "Pipedrive CRM. Manage deals, contacts, organisations, activities, pipelines. Search and filter across all entities. Track deal stages, log calls and meetings, manage products and notes.",
  "category": "sales",
  "provider": "community",
  "mcpConfig": {
    "transport": "stdio",
    "command": "npx",
    "args": ["-y", "@iamsamuelfraga/mcp-pipedrive@2.0.0"]
  },
  "icon": "target",
  "popular": false,
  "verified": false,
  "verifiedSource": "https://github.com/iamsamuelfraga/mcp-pipedrive",
  "requiresSetup": true,
  "setupUrl": "https://app.pipedrive.com/settings/api",
  "setupUrlBehavior": "button",
  "setupFields": [
    { "id": "apiKey", "label": "Pipedrive API Token", "type": "password", "envVar": "PIPEDRIVE_API_TOKEN" }
  ],
  "accountIdentity": "email",
  "maturity": "beta"
}
```


## Tools

The MCP provides 100+ tools across 10 categories:

| Category | Tools | Description |
|----------|-------|-------------|
| **Deals** | 23 | Create, update, search, stage movement, participants, products, files |
| **Persons** | 12 | Contact management with custom fields, activities, deals, files |
| **Organisations** | 12 | Company management with relationships to persons and deals |
| **Activities** | 8 | Task, call, and meeting scheduling with completion tracking |
| **Files** | 7 | File upload, download, management, remote file linking |
| **Search** | 6 | Universal and entity-specific search |
| **Pipelines** | 8 | Pipeline and stage management, conversion statistics |
| **Notes** | 5 | Notes on deals, persons, and organisations |
| **Fields** | 8 | Custom field discovery and metadata |
| **System** | 5 | Health checks, metrics, user info, cache management |


## Usage Examples

**Pipeline review:**
```
What's in my sales pipeline? Show deal counts and values by stage.
```

**Deal management:**
```
Create a new deal for "Enterprise License" worth $50,000 linked to John Smith at Acme Corp.
```

**Contact search:**
```
Find all contacts at Acme Corporation and show their recent deals.
```

**Activity tracking:**
```
Show my overdue activities and reschedule them to next week.
```


## Setup

**Prerequisites:**
- Pipedrive account (any plan with API access)

**Get your API token:**
1. Go to [Pipedrive API settings](https://app.pipedrive.com/settings/api)
2. Scroll to **Your personal API token**
3. Copy the token

**Configure in Rebel:**
1. Go to **Settings → Connectors**
2. Find **Pipedrive** and click **Set up**
3. Paste the API token
4. Click **Connect**


## Technical Details

- **Type**: Community MCP (third-party)
- **Transport**: stdio (runs via npx)
- **Package**: `@iamsamuelfraga/mcp-pipedrive@2.0.0`
- **License**: MIT
- **Author**: Samuel Fraga
- **Repository**: https://github.com/iamsamuelfraga/mcp-pipedrive
- **Environment Variables**:
  - `PIPEDRIVE_API_TOKEN` (required) - Pipedrive personal API token
- **Built-in features**: Rate limiting (10 req/s), TTL caching, retry with exponential backoff, Zod validation


## Security Notes

- **API token scope**: Grants access to all data visible to the user's Pipedrive account
- **Read and write**: Tools support both read and write operations (create, update, delete) -- tool safety evaluation applies at runtime
- **Version pinned**: Package version pinned to `2.0.0` to mitigate supply chain risk
- **HTTPS enforced**: All API calls use HTTPS to `api.pipedrive.com`
- **Community maintained**: Source code not yet formally reviewed. `verified` flag is `false`. Package is MIT-licensed by Samuel Fraga (solo maintainer)


## Known Limitations

- **Community maintained**: Not an official Pipedrive MCP -- may lag behind API changes
- **API v1 only**: Uses Pipedrive REST API v1 (v2 endpoints not yet supported)
- **Rate limits**: Built-in rate limiter at 10 req/s; Pipedrive's own limits vary by plan


## Troubleshooting

**Authentication errors:**
1. Verify your API token at [Pipedrive API settings](https://app.pipedrive.com/settings/api)
2. Tokens don't expire, but can be regenerated (which invalidates the old one)
3. Disconnect and reconnect the connector in Settings -> Connectors

**Rate limiting (429 errors):**
- The MCP has built-in rate limiting and retry logic
- If persistent, check your Pipedrive plan's API rate limits

**No data returned:**
- Verify the Pipedrive account has the expected deals/contacts
- Check that custom field names match your Pipedrive configuration


## Alternatives

| Service | Type | Notes |
|---------|------|-------|
| **Pipedrive** (this doc) | Community MCP | SMB CRM, comprehensive API coverage |
| **HubSpot** | Bundled MCP | [HUBSPOT_MCP.md](HUBSPOT_MCP.md) - mid-market/enterprise CRM |
| **Salesforce** | Bundled MCP | [SALESFORCE_MCP.md](SALESFORCE_MCP.md) - enterprise CRM |
| **Affinity** | Community MCP | [AFFINITY_MCP.md](AFFINITY_MCP.md) - relationship intelligence CRM |


## References

- [Pipedrive API Documentation](https://developers.pipedrive.com/docs/api/v1)
- [mcp-pipedrive GitHub Repository](https://github.com/iamsamuelfraga/mcp-pipedrive)
- [mcp-pipedrive on npm](https://www.npmjs.com/package/@iamsamuelfraga/mcp-pipedrive)
