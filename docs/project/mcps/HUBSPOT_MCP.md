---
description: "HubSpot MCP connector for CRM and marketing data — OAuth setup, 95-tool coverage, scopes, sandbox links"
last_updated: "2026-05-29"
---

# HubSpot MCP

`rebel-oss` MCP package for HubSpot CRM access. Rebel keeps the bundled-style host catalog entry (`bundled-hubspot` with `bundledConfig` for OAuth setup), but the server now runs from `@mindstone/mcp-server-hubspot@0.2.0`.

**Status**: Active (May 2026) - 95 tools across CRM, products, forms, lists/segments, analytics, marketing emails, association labels, workflows, knowledge base, and Conversations Inbox

**Tool Count**: 95 tools

## See Also

- [HUBSPOT_API_DEEP_DIVE.md](./HUBSPOT_API_DEEP_DIVE.md) - Comprehensive HubSpot API reference (endpoints, scopes, rate limits, tier restrictions)
- [HUBSPOT_SANDBOX_TESTING.md](./HUBSPOT_SANDBOX_TESTING.md) - Sandbox test account setup, safety rules, testing checklists
- [MCP_ARCHITECTURE.md](../MCP_ARCHITECTURE.md) - General MCP configuration
- [MCP_IMPROVEMENT_WORKFLOW.md](../MCP_IMPROVEMENT_WORKFLOW.md) - How this MCP was designed
- [MCP_OSS_CONNECTORS.md](../MCP_OSS_CONNECTORS.md) - `rebel-oss` connector architecture and migration status
- [SALESFORCE_MCP.md](./SALESFORCE_MCP.md) - Similar CRM integration pattern


## Overview

The HubSpot MCP provides full CRM access:
- **Contacts** - People in your CRM
- **Companies** - Organizations
- **Deals** - Sales pipeline opportunities
- **Tickets** - Support tickets
- **Conversations Inbox** - Ticket conversation threads, messages, and full original message content (`conversations.read`)
- **Tasks** - To-do items and reminders
- **Notes** - Activity notes attached to records
- **Associations** - Relationships between objects (v3 unlabeled + v4 labeled)
- **Workflows** - Read-only workflow interrogation (v4 BETA, requires `automation` scope)
- **Properties** - Object schema and custom fields
- **Products** - Product catalog items
- **Line Items** - Products linked to deals for revenue tracking, including deal-association reads (FOX-3354)
- **Forms** - Lead capture forms and submissions
- **Analytics** - Website traffic reports (Marketing Hub required)
- **Marketing Emails** - Email campaigns and performance stats
- **Knowledge Base** - Help center articles (Service Hub Professional or Enterprise required)


## Tools

### Account Management

| Tool | Description |
|------|-------------|
| `list_hubspot_accounts` | List connected HubSpot accounts and auth status |
| `authenticate_hubspot_account` | Start OAuth flow for new/existing account |
| `complete_hubspot_auth` | Wait for OAuth callback completion |
| `remove_hubspot_account` | Disconnect an account |

### Contacts

| Tool | Description |
|------|-------------|
| `search_hubspot_contacts` | Search contacts with filters |
| `get_hubspot_contact` | Get a single contact by ID |
| `create_hubspot_contact` | Create new contact |
| `update_hubspot_contact` | Update existing contact |
| `delete_hubspot_contact` | Delete a contact |

### Companies

| Tool | Description |
|------|-------------|
| `search_hubspot_companies` | Search companies with filters |
| `get_hubspot_company` | Get a single company by ID |
| `create_hubspot_company` | Create new company |
| `update_hubspot_company` | Update existing company |
| `delete_hubspot_company` | Delete a company |

### Deals

| Tool | Description |
|------|-------------|
| `search_hubspot_deals` | Search deals with filters |
| `get_hubspot_deal` | Get a single deal by ID |
| `create_hubspot_deal` | Create new deal |
| `update_hubspot_deal` | Update existing deal |
| `delete_hubspot_deal` | Delete a deal |

### Tickets

| Tool | Description |
|------|-------------|
| `search_hubspot_tickets` | Search tickets with filters |
| `get_hubspot_ticket` | Get a single ticket by ID |
| `create_hubspot_ticket` | Create new ticket |
| `update_hubspot_ticket` | Update existing ticket |
| `delete_hubspot_ticket` | Delete a ticket |

### Tasks

| Tool | Description |
|------|-------------|
| `search_hubspot_tasks` | Search tasks |
| `get_hubspot_task` | Get a single task by ID |
| `create_hubspot_task` | Create new task |
| `update_hubspot_task` | Update existing task |
| `delete_hubspot_task` | Delete a task |

### Notes & Associations

| Tool | Description |
|------|-------------|
| `create_hubspot_note` | Create note with optional associations |
| `create_hubspot_association` | Link two objects together (v3, unlabeled) |
| `get_hubspot_associations` | Get associations for an object |
| `delete_hubspot_association` | Remove an association |
| `list_hubspot_association_labels` | List available v4 association labels for an object pair |
| `create_hubspot_labeled_association` | Create a labeled association (e.g., "Contract Signatory") using v4 API |

### Properties

| Tool | Description |
|------|-------------|
| `list_hubspot_properties` | List all properties for an object type |

### Owners

| Tool | Description |
|------|-------------|
| `list_hubspot_owners` | List all owners/users in the account |
| `get_hubspot_owner` | Get owner details by ID |

### Pipelines

| Tool | Description |
|------|-------------|
| `list_hubspot_pipelines` | List pipelines for deals or tickets |
| `get_hubspot_pipeline` | Get pipeline with stages |

### Engagements (Calls & Meetings)

| Tool | Description |
|------|-------------|
| `search_hubspot_calls` | Search logged calls |
| `get_hubspot_call` | Get call details |
| `create_hubspot_call` | Log a new call |
| `search_hubspot_meetings` | Search meetings |
| `get_hubspot_meeting` | Get meeting details |
| `create_hubspot_meeting` | Log a new meeting |
| `get_contact_engagements` | Get all activity for a contact |

### Products

| Tool | Description |
|------|-------------|
| `search_hubspot_products` | Search product catalog by name or SKU |
| `get_hubspot_product` | Get product details |
| `create_hubspot_product` | Create new product |
| `update_hubspot_product` | Update product properties |

### Line Items

| Tool | Description |
|------|-------------|
| `search_hubspot_line_items` | Search line items; v0.2.0 includes deal association reads so line items can be traced back to deals |
| `get_hubspot_line_item` | Get line item details, including deal associations when available |
| `create_hubspot_line_item` | Create line item and associate with deal |

### Conversations Inbox (FOX-3376, requires `conversations.read`)

| Tool | Description |
|------|-------------|
| `list_hubspot_ticket_threads` | List conversation threads associated with a HubSpot support ticket |
| `list_hubspot_thread_messages` | List messages on a conversation thread in chronological order |
| `get_hubspot_thread_message_original_content` | Fetch the full, untruncated original content for a conversation message |

### Forms

| Tool | Description |
|------|-------------|
| `list_hubspot_forms` | List all forms in HubSpot |
| `get_hubspot_form` | Get form configuration and fields |
| `get_hubspot_form_submissions` | Get form submissions |

### Analytics (Marketing Hub Required)

| Tool | Description |
|------|-------------|
| `get_hubspot_analytics_report` | Get website traffic analytics |

### Marketing Emails

| Tool | Description |
|------|-------------|
| `list_hubspot_marketing_emails` | List marketing emails |
| `get_hubspot_marketing_email` | Get marketing email details (subject, content, template) |
| `get_hubspot_email_statistics` | Get email performance statistics |

### Lists/Segments

| Tool | Description |
|------|-------------|
| `list_hubspot_lists` | List all contact lists/segments (MANUAL, DYNAMIC, SNAPSHOT types) |
| `get_hubspot_list` | Get list details including filter criteria for dynamic lists |
| `list_hubspot_list_members` | Get contact IDs in a list (paginated) |
| `batch_read_hubspot_contacts` | Fetch multiple contacts by ID (up to 100) - use to hydrate list member IDs |

### Workflows (v4 BETA, requires `automation` scope)

| Tool | Description |
|------|-------------|
| `list_hubspot_workflows` | List all automation workflows (read-only) |
| `get_hubspot_workflow` | Get full workflow structure: actions, triggers, branches (read-only) |

Users must reconnect HubSpot after this feature was added to grant the `automation` scope. If not granted, these tools return a clear 403 with reconnection instructions.

### Knowledge Base (Service Hub Professional or Enterprise required)

| Tool | Description |
|------|-------------|
| `list_hubspot_kb_articles` | List KB articles via GraphQL API (read-only) |
| `get_hubspot_kb_article` | Get a single KB article by ID via GraphQL API (read-only) |
| `search_hubspot_kb_articles` | Search published KB articles by query text via Site Search API (read-only) |

These are **read-only** tools — HubSpot does not currently provide a write API for Knowledge Base articles. List and get use the HubSpot GraphQL API (`/collector/graphql`); search uses the CMS Site Search API.

**Required OAuth scopes:** `cms.knowledge_base.articles.read` and `collector.graphql_query.execute` (added as optional scopes). Existing users must **reconnect HubSpot** to grant these new scopes before KB tools will work.

**Note:** `search_hubspot_kb_articles` uses the Site Search API which only indexes **published** articles. Use `list_hubspot_kb_articles` to browse all articles including drafts.

**Workflow for reading KB articles:**
1. `list_hubspot_kb_articles` → browse all articles (supports limit/offset pagination)
2. `get_hubspot_kb_article(articleId)` → get full article content
3. `search_hubspot_kb_articles(query)` → search published articles by keyword

**Workflow for exporting a segment:**
1. `list_hubspot_lists` → find the segment
2. `list_hubspot_list_members(listId)` → get contact IDs
3. `batch_read_hubspot_contacts(ids, ['email', 'firstname', 'lastname'])` → get contact details


## Setup Requirements

### HubSpot User Permission

The user connecting HubSpot must have **App Marketplace Access** permission in HubSpot (or be a Super Admin). This is a standard HubSpot requirement for all third-party OAuth apps — not specific to Rebel.

If a user sees "You don't have permission to connect this app", their HubSpot admin must grant them **App Marketplace Access** under **Settings → Users & Teams → Permissions → Account → Settings Access**. This is a one-time permission that applies to all third-party app installations.

> **For external companies**: When onboarding external users, ensure they know their HubSpot admin must grant them this permission before they can connect.

### HubSpot Developer Portal Configuration

The HubSpot app registration at https://app.hubspot.com/developer/ must have scope categories configured correctly:

| Category | Scopes |
|----------|--------|
| **Required** | `oauth`, `crm.objects.owners.read`, `crm.schemas.contacts.read`, `crm.schemas.companies.read`, `crm.schemas.deals.read`, `crm.objects.contacts.read`, `crm.objects.companies.read`, `crm.objects.deals.read`, `crm.objects.products.read`, `crm.objects.line_items.read`, `crm.lists.read` |
| **Optional** | `crm.objects.contacts.write`, `crm.objects.companies.write`, `crm.objects.deals.write`, `crm.objects.products.write`, `crm.objects.line_items.write`, `files`, `forms`, `tickets`, `content`, `automation`, `cms.knowledge_base.articles.read`, `collector.graphql_query.execute`, `conversations.read` |

This ensures the code's `optional_scope` parameter works correctly — HubSpot will grant optional scopes only if the user has access, without blocking the entire OAuth flow.

### Configure in Rebel

In Rebel Settings:
1. Enable HubSpot under Connectors
2. Enter your OAuth Client ID and Client Secret
3. Click "Connect" to start OAuth flow

### OAuth Scopes Requested

The OAuth URL uses `scope` for required scopes and `optional_scope` for scopes that depend on the user's HubSpot plan/permissions. HubSpot automatically grants only the optional scopes the user has access to, without blocking the flow.

**Required scopes (in `scope` parameter — always requested):**
- `oauth` - Basic OAuth
- `crm.objects.owners.read`
- `crm.schemas.contacts.read` / `crm.schemas.companies.read` / `crm.schemas.deals.read`
- `crm.objects.contacts.read` / `crm.objects.companies.read` / `crm.objects.deals.read`
- `crm.objects.products.read` / `crm.objects.line_items.read`
- `crm.lists.read` - Lists/segments API

**Optional scopes (in `optional_scope` parameter — granted if user has access):**
- `crm.objects.contacts.write` / `crm.objects.companies.write` / `crm.objects.deals.write`
- `crm.objects.products.write` / `crm.objects.line_items.write`
- `files` - File manager: upload and attachments
- `forms` - Read access to forms and submissions
- `tickets` (read/write)
- `content` - Marketing Hub: analytics, marketing emails
- `automation` - Workflow interrogation (v4 BETA, read-only)
- `cms.knowledge_base.articles.read` - Knowledge Base article read access (GraphQL)
- `collector.graphql_query.execute` - GraphQL API query execution (required for KB tools)
- `conversations.read` - Conversations Inbox read access for ticket threads/messages (FOX-3376; added in `@mindstone/mcp-server-hubspot@0.2.0`)

After authentication, the actually-granted scopes are stored in `accounts.json` via the HubSpot token info API (`GET /oauth/v1/access-tokens/{token}`). This enables scope-aware tool filtering at runtime.


## Architecture

The host catalog entry remains `bundled-hubspot` so Settings, OAuth setup, and existing account migration continue to use the same Rebel host path. Its `provider` is `rebel-oss`, and `mcpConfig.args` currently pins:

```json
["-y", "@mindstone/mcp-server-hubspot@0.2.0"]
```

The package source lives in `mindstone/mcp-servers`; Rebel-side host responsibilities are OAuth orchestration (`hubspotApi`), token storage, catalog payload construction, and scope-aware setup/reconnect UX.

### Token Storage

OAuth tokens are stored locally at:
```
~/.hubspot-mcp/
├── accounts.json                      # Account metadata
└── credentials/
    └── <sanitized-email>.token.json   # Per-account tokens
```

### Automatic Token Refresh

The HubSpot client automatically refreshes expired tokens:
- Tokens are refreshed 5 minutes before expiration
- Refresh is handled transparently during API calls
- Failed refresh prompts re-authentication


## Common Issues

### "App Marketplace Access" Permission Required

**Symptom**: User sees "You don't have permission to connect this app" or is told they need "App Marketplace access"

**Cause**: HubSpot requires the **App Marketplace Access** permission for any non-super-admin user installing a third-party OAuth app. This is a standard HubSpot policy (since October 2023), not specific to Rebel. It also triggers when an already-connected app requests new scopes during re-authentication.

**Solution**: The user's HubSpot admin must grant them **App Marketplace Access** under **Settings → Users & Teams → Permissions**. Super admins already have this permission. This is a one-time setting.

### OAuth Callback Error

**Symptom**: OAuth flow doesn't complete

**Causes**:
1. Client ID/Secret incorrect
2. OAuth scopes not properly configured in HubSpot app settings (see "HubSpot Developer Portal Configuration" above)

**Solution**: Verify OAuth app configuration and try again. Note: The callback uses dynamic port allocation, so port conflicts are handled automatically.

### Token Expired / Re-authentication Required

**Symptom**: API calls fail with authentication errors

**Cause**: OAuth tokens expired and auto-refresh failed

**Solution**: Re-authenticate using `authenticate_hubspot_account`

### Rate Limiting

**Symptom**: API calls return 429 errors

**Cause**: HubSpot API rate limits exceeded

**Solution**: HubSpot has tiered rate limits based on your plan:
- Free/Starter: 100 requests per 10 seconds
- Professional: 150 requests per 10 seconds
- Enterprise: 200 requests per 10 seconds

Wait a few seconds and retry.

### Missing Scopes

**Symptom**: API calls fail with permission errors

**Cause**: OAuth app missing required scopes, or the HubSpot developer portal scope categories don't match the code's `scope`/`optional_scope` split

**Solution**: Verify the HubSpot developer portal scope categories match the table in "HubSpot Developer Portal Configuration" above, then re-authenticate


## Search Filters

The search tools support HubSpot's filter operators:

| Operator | Description | Example |
|----------|-------------|---------|
| `EQ` | Equal to | `{ propertyName: "email", operator: "EQ", value: "john@example.com" }` |
| `NEQ` | Not equal to | `{ propertyName: "lifecyclestage", operator: "NEQ", value: "customer" }` |
| `LT` / `LTE` | Less than (or equal) | `{ propertyName: "amount", operator: "GTE", value: "10000" }` |
| `GT` / `GTE` | Greater than (or equal) | Same pattern |
| `CONTAINS_TOKEN` | Contains word | `{ propertyName: "firstname", operator: "CONTAINS_TOKEN", value: "john" }` |
| `IN` | Value in list | `{ propertyName: "dealstage", operator: "IN", value: "appointmentscheduled;qualifiedtobuy" }` |


## Common Properties

### Contact Properties
- `email`, `firstname`, `lastname`
- `phone`, `mobilephone`
- `company`, `jobtitle`
- `address`, `city`, `state`, `zip`, `country`
- `lifecyclestage` (subscriber, lead, marketingqualifiedlead, salesqualifiedlead, opportunity, customer, evangelist, other)

### Company Properties
- `name`, `domain`
- `industry`, `numberofemployees`, `annualrevenue`
- `phone`, `address`, `city`, `state`, `zip`, `country`

### Deal Properties
- `dealname`, `amount`
- `dealstage`, `pipeline`
- `closedate`
- `hubspot_owner_id`

### Ticket Properties
- `subject`, `content`
- `hs_pipeline`, `hs_pipeline_stage`
- `hs_ticket_priority` (LOW, MEDIUM, HIGH)

### Task Properties
- `hs_task_subject`, `hs_task_body`
- `hs_timestamp` (due date in milliseconds)
- `hs_task_status` (NOT_STARTED, IN_PROGRESS, COMPLETED)
- `hs_task_priority` (LOW, MEDIUM, HIGH)
- `hubspot_owner_id`


## Environment Variables

| Variable | Description |
|----------|-------------|
| `HUBSPOT_SCOPE_TIER` | Host-provided scope tier passed to the `rebel-oss` package |
| `LOG_MODE` | `strict` for host-safe package logging |
| `HUBSPOT_CLIENT_ID` / `HUBSPOT_CLIENT_SECRET` | Host OAuth app credentials used by Rebel's `hubspotApi` orchestration |
| HubSpot token/config paths | Managed by Rebel's host-side HubSpot auth service; existing accounts continue through the `bundled-hubspot` catalog identity |


## Development

```bash
# Rebel catalog pin
npx -y @mindstone/mcp-server-hubspot@0.2.0
```

Package source, build, and publish happen in `mindstone/mcp-servers`. Use [MCP_OSS_PACKAGE_MANUAL_UPDATE.md](../MCP_OSS_PACKAGE_MANUAL_UPDATE.md) for future version bumps, then update the exact semver in `resources/connector-catalog.json`.

## Version History

| Version | Notes |
|---------|-------|
| `0.2.0` | v0.4.41 catalog pin. Adds `conversations.read`, FOX-3376 Conversations Inbox tools, and FOX-3354 line-items-to-deals reads while preserving existing `0.1.2` users through the bundled-style host catalog entry. |


## References

- [HubSpot CRM API](https://developers.hubspot.com/docs/api/crm/understanding-the-crm)
- [HubSpot OAuth Guide](https://developers.hubspot.com/docs/api/oauth-quickstart-guide)
- [HubSpot Private Apps](https://developers.hubspot.com/docs/api/private-apps)
- [HubSpot API Rate Limits](https://developers.hubspot.com/docs/api/usage-details)
- [Klavis HubSpot MCP](https://github.com/Klavis-AI/klavis/tree/main/mcp_servers/hubspot) - Reference implementation
