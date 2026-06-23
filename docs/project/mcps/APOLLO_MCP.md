---
description: "Apollo (Apollo.io) vendor-hosted MCP connector — OAuth setup, prospecting/enrichment/sequence tools, credit-spend approval, troubleshooting"
last_updated: "2026-06-11"
---

# Apollo MCP

Apollo integration for Rebel uses Apollo.io's official, vendor-hosted MCP server. The MCP implementation is maintained by Apollo, not Mindstone.

## Status

| Aspect | Value |
|--------|-------|
| Catalog id | `apollo` |
| Provider type | `direct` (vendor-hosted) |
| Transport | Streamable HTTP (`mcpConfig.transport: "http"`) |
| Endpoint | `https://mcp.apollo.io/mcp` |
| Auth | OAuth 2.0 (handled by Apollo) |
| Category | `sales` |
| Maturity | `beta` |

## See Also

- [MCP_ARCHITECTURE.md](../MCP_ARCHITECTURE.md) — General MCP setup and troubleshooting
- [Apollo MCP product page](https://www.apollo.io/product/mcp) — Official overview
- [Apollo MCP documentation](https://docs.apollo.io/docs/apollo-mcp) — Official docs (tool list, scopes, credit notes)

## How It Works

Like other direct connectors (Notion, Linear), Apollo hosts its own MCP server:

```
User → Rebel → Super-MCP → Apollo MCP (https://mcp.apollo.io/mcp) → Apollo.io API
```

**What this means:**
- Tools and capabilities are maintained by Apollo
- OAuth is handled by Apollo's server
- We cannot fix bugs or add features to the MCP itself
- Tool behavior may change with Apollo's releases
- Access is scoped to the authorizing Apollo user — Rebel can only see and do what that user can

## Setup

1. Open **Settings → Connectors**
2. Click **+ Add** next to Apollo
3. Complete OAuth in the browser popup (sign in to Apollo, review access, click Authorize)
4. Apollo tools appear automatically after connection

**Connection time:** After adding Apollo, Super-MCP restarts (~30–60 seconds) before tools become available.

## Available Tools

Apollo's MCP provides tools for:

- **Prospecting / discovery**: `people_api_search` (search Apollo's 200M+ people DB by ICP filters), `organization_search`, `search_contacts` (your saved contacts), `search_sequences`
- **Enrichment**: `people_enrichment`, `bulk_people_enrichment`, `organization_enrichment`, `bulk_organization_enrichment`, `organization_job_postings`
- **CRM**: `create_contact`, `update_contact`, `create_account`, `update_account`
- **Sequences / outreach**: `create_update_sequence`, `add_contacts_to_sequence`, `remove_contacts_from_sequence`, `get_email_accounts`
- **Analytics & profile**: `query_analytics`, `profile`

The `tools` array in `resources/connector-catalog.json` is the in-repo copy used for tool-awareness; the live server is the source of truth. For the current list, check [Apollo's MCP docs](https://docs.apollo.io/docs/apollo-mcp) or use MCP tool discovery in a conversation.

## Credit Spend

Several Apollo actions consume Apollo credits (enrichment, sequence enrollment). Apollo recommends setting credit-spending actions to **Approval required** in the MCP client. Rebel's tool-safety layer surfaces these as approval prompts before execution.

## Usage Tips

**Prospecting:**
- "Find VPs of Marketing at Series B SaaS companies in the US"
- "Search for companies in fintech with 50–200 employees that are hiring engineers"

**Enrichment:**
- "Enrich this contact and get their verified email and phone"
- "Enrich these 20 companies with fresh firmographics"

**Sequences:**
- "Add these prospects to my outbound sequence"
- "Show engagement performance for my Q2 sequence"

## Troubleshooting

### OAuth Popup Doesn't Open
- Check browser popup blocker settings
- Try a different browser
- Ensure you're logged into Apollo in your browser

### OAuth Completes But No Tools Appear
- Wait 30–60 seconds for Super-MCP restart
- Check Settings → Connectors to verify "Connected" status
- Try disconnecting and reconnecting

### Tools Work But Return Empty Results
- Verify your Apollo plan/seat grants access to the requested data
- Check that records exist matching your query
- Enrichment may be limited by your remaining Apollo credits

## Vendor MCP Considerations

Since this is a vendor-hosted MCP:

| Aspect | Implication |
|--------|-------------|
| Bug fixes | Report to Apollo, not Mindstone |
| Feature requests | Request via Apollo's feedback channel |
| Availability | Depends on Apollo's service uptime |
| Tool changes | May change with Apollo releases |

If you encounter issues with Apollo's MCP behavior (not connection issues), check Apollo's status page or contact Apollo support.
