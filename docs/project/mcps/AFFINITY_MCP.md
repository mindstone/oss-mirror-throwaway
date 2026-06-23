---
description: "Affinity CRM MCP connector reference — community package, API key setup, catalog entry, tools for deal flow and relationships"
last_updated: "2026-02-02"
---

# Affinity CRM MCP

Relationship intelligence CRM for deal flow, investor relations, and professional networking.

## See Also

- [MCP_ARCHITECTURE.md](../MCP_ARCHITECTURE.md) - How MCPs are configured
- [MCP_IMPROVEMENT_WORKFLOW.md](../MCP_IMPROVEMENT_WORKFLOW.md) - Third-party MCP integration patterns
- [Affinity API Documentation](https://api-docs.affinity.co/) - Official API reference


## Overview

| Attribute | Value |
|-----------|-------|
| **ID** | `affinity-crm` |
| **Provider** | Community (`@alludium/affinity-mcp-server`) |
| **Version** | `1.0.3` (pinned) |
| **Auth** | API key |
| **Status** | Added Jan 2026 |
| **Maturity** | Beta |

Affinity CRM is popular in venture capital, private equity, and professional services for tracking relationships and deal flow. This connector uses the community-maintained `@alludium/affinity-mcp-server` package.


## Connector Catalog Entry

```json
{
  "id": "affinity-crm",
  "name": "Affinity CRM",
  "description": "Affinity relationship intelligence CRM. Search contacts, companies, deals, opportunities. Track pipeline stages, relationship strengths, field values. View notes, lists, and audit history.",
  "category": "sales",
  "provider": "community",
  "mcpConfig": {
    "transport": "stdio",
    "command": "npx",
    "args": ["-y", "@alludium/affinity-mcp-server@1.0.3"]
  },
  "icon": "users",
  "popular": false,
  "verified": false,
  "verifiedSource": "https://github.com/alludium/affinity-mcp-server",
  "requiresSetup": true,
  "setupUrl": "https://support.affinity.co/hc/en-us/articles/360032633992-How-to-obtain-your-API-Key",
  "setupUrlBehavior": "button",
  "setupFields": [
    {
      "id": "apiKey",
      "label": "Affinity API Key",
      "type": "password",
      "envVar": "AFFINITY_API_KEY"
    }
  ],
  "accountIdentity": "email",
  "maturity": "beta"
}
```


## Tools

The MCP provides 28 tools organized by domain:

### Authentication
| Tool | Description |
|------|-------------|
| `affinity_whoami` | Verify authentication and get current user info |

### Companies (V1 + V2 APIs)
| Tool | Description |
|------|-------------|
| `affinity_list_companies` | List companies with optional field data |
| `affinity_get_company` | Get company details by ID |
| `affinity_search_companies` | Search companies by name or domain |
| `affinity_create_company` | Create a new company |

### Persons (V1 + V2 APIs)
| Tool | Description |
|------|-------------|
| `affinity_list_persons` | List persons with optional field data |
| `affinity_get_person` | Get person details by ID |
| `affinity_search_persons` | Search persons by email or name |
| `affinity_create_person` | Create a new person |

### Lists & Pipelines
| Tool | Description |
|------|-------------|
| `affinity_list_lists` | Discover available lists |
| `affinity_get_list` | Get single list metadata |
| `affinity_get_list_entries` | Get entries from any list |
| `affinity_get_list_fields` | Get field definitions for a list |
| `affinity_get_swimlanes` | Get pipeline stages (Status field values) |
| `affinity_get_companies_in_swimlane` | Get companies at a specific pipeline stage |

### Opportunities
| Tool | Description |
|------|-------------|
| `affinity_list_opportunities` | List opportunities |
| `affinity_get_opportunity` | Get opportunity details by ID |

### Notes
| Tool | Description |
|------|-------------|
| `affinity_list_company_notes` | List notes for a company |
| `affinity_list_person_notes` | List notes for a person |
| `affinity_list_opportunity_notes` | List notes for an opportunity |
| `affinity_add_note` | Create a note attached to entities |

### Enhanced Details
| Tool | Description |
|------|-------------|
| `affinity_get_company_lists` | Get lists containing a specific company |
| `affinity_get_company_list_entries` | Get list entry data for a company across all lists |

### Field Data & Audit
| Tool | Description |
|------|-------------|
| `affinity_get_field_values` | Get all field values for an entity |
| `affinity_get_field_value_changes` | Get change history for a field (audit trail) |

### Schema Discovery
| Tool | Description |
|------|-------------|
| `affinity_get_persons_fields` | Get all global person field definitions |
| `affinity_get_organizations_fields` | Get all global organization field definitions |

### Network Intelligence
| Tool | Description |
|------|-------------|
| `affinity_get_relationship_strengths` | Find who on your team has the strongest connections to external contacts |


## Usage Examples

**Search for companies:**
```
Find companies in our deal pipeline
```

**Relationship intelligence:**
```
Who has the strongest connection to Acme Corp?
```

**Pipeline tracking:**
```
Show companies in the "Due Diligence" stage
```

**Field value audit:**
```
What changes were made to the Status field on the Acme deal?
```


## Setup

**Prerequisites:**
- Affinity account with API access (Scale, Advanced, or Enterprise plan)

**Get your API key:**
1. Log into the [Affinity web app](https://app.affinity.co/)
2. Go to **Settings** in the left sidebar
3. Navigate to the **API** section
4. Click **Generate** to create a new API key
5. Copy the key immediately - it won't be shown again

**Configure in Rebel:**
1. Go to **Settings → Connectors**
2. Find **Affinity CRM** and click **Set up**
3. Paste your API key
4. Click **Connect**


## Technical Details

- **Type**: Community MCP (third-party)
- **Transport**: stdio (runs via npx)
- **Package**: `@alludium/affinity-mcp-server@1.0.3`
- **License**: MIT
- **Repository**: https://github.com/alludium/affinity-mcp-server
- **Environment Variables**:
  - `AFFINITY_API_KEY` (required) - Your Affinity API key
- **Rate Limits**: 900 requests per minute per user (Affinity API limit)


## Security Notes

- **API key scope**: Your API key grants full access to your Affinity CRM data
- **Read-only by default**: Most tools are read-only except `affinity_add_note` and create operations
- **HTTPS enforced**: All API calls use HTTPS to `api.affinity.co`
- **Version pinned**: The package version is pinned to mitigate supply chain risk

**Code review notes (Jan 2026):** Source code reviewed before adoption. Clean TypeScript implementation, proper credential handling (API key only in auth headers), no suspicious patterns found. Main consideration was supply chain risk (newer package author) - mitigated by pinning to specific version.


## Known Limitations

- **Read-mostly**: Most tools are read-only; limited write operations available
- **Community maintained**: Not an official Affinity MCP - may lag behind API changes
- **No webhook support**: Cannot subscribe to real-time updates
- **No search by meeting/interaction**: Affinity's relationship strength data requires separate queries


## Troubleshooting

**"Invalid API key" or authentication errors:**
1. Verify your API key at Affinity Settings → API
2. Regenerate the key if needed
3. Ensure no extra whitespace when pasting

**"Rate limited":**
- Affinity limits to 900 requests per minute per user
- Wait 1 minute before retrying

**"No data returned":**
- Verify you have access to the requested lists/entities in Affinity
- Check that your account has the necessary permissions


## Alternatives

| Service | Type | Notes |
|---------|------|-------|
| **Affinity CRM** (this doc) | Community MCP | Local, version-pinned |
| [Klavis Affinity](https://docs.klavis.ai/documentation/mcp-server/affinity) | Klavis gateway | Cloud-hosted alternative |
| **HubSpot** | Bundled MCP | [HUBSPOT_MCP.md](HUBSPOT_MCP.md) - for general CRM |
| **Salesforce** | Bundled MCP | [SALESFORCE_MCP.md](SALESFORCE_MCP.md) - for enterprise CRM |


## References

- [Affinity API Documentation](https://api-docs.affinity.co/)
- [Affinity Help Center - API Keys](https://support.affinity.co/hc/en-us/articles/360032633992)
- [MCP Package Repository](https://github.com/alludium/affinity-mcp-server)
