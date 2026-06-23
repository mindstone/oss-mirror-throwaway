---
description: "Official n8n MCP connector for operating workflows — instance-hosted OAuth, setup-field URL flow, tools, known risks"
last_updated: "2026-05-12"
---

# n8n (Official) MCP

n8n's first-party MCP server, shipped inside each customer's own n8n instance from April 2026 onwards. Best for **operating** existing workflows (run, test, publish, monitor) rather than authoring brand-new ones.

| Property | Value |
|----------|-------|
| **Status** | Beta — added May 2026, untested end-to-end in Rebel |
| **Type** | Direct (vendor-hosted, inside the user's own n8n instance) |
| **Catalog ID** | `n8n` |
| **Maintainer** | n8n team |
| **Source** | https://docs.n8n.io/advanced-ai/mcp/accessing-n8n-mcp-server/ |
| **Auth** | OAuth 2.0 (browser handshake against the user's n8n instance) |
| **Transport** | Streamable HTTP at `https://<your-n8n-domain>/mcp-server/http` |
| **n8n version required** | The first n8n release that ships the built-in MCP server (April 2026+). Older instances will return 404 at `/mcp-server/http`. |
| **Tools** | 25 (10 workflow management + 7 workflow builder + 8 data tables) |
| **Sister entry** | [`n8n-community`](./N8N_COMMUNITY_MCP.md) — different feature shape, see comparison there |

> See `N8N_COMMUNITY_MCP.md` for the side-by-side "Official vs Community" comparison table and rule-of-thumb. We keep both in the catalog because they cover different jobs.

---

## Why this entry exists

n8n shipped their official MCP server as a built-in feature of n8n (April 2026 release). Unlike most direct connectors in the catalog, the server isn't hosted at a single vendor-owned URL — every customer's n8n instance hosts its own copy at `https://<their-domain>/mcp-server/http`. That means:

- The catalog `mcpConfig.url` is intentionally absent. The user supplies their instance URL via a `setupFields.url` entry.
- The catalog still sets `mcpConfig.oauth: true` so Super-MCP initiates the OAuth handshake against the supplied URL.
- This combination — direct OAuth + user-supplied URL via setupFields — was a previously-unhandled save-path shape. See `docs/plans/260512_n8n_official_mcp_and_setupfield_oauth_propagation.md` for the propagation fix that made it work.

## Setup flow

1. User goes to **Settings → Connectors**, finds **n8n (Official)**, clicks **Set up**.
2. User pastes their instance URL (Cloud, self-hosted, or community edition).
3. User clicks **Set up with Rebel** to trigger the OAuth handshake.
4. Super-MCP opens the n8n OAuth page in the default browser.
5. User signs in / authorises in their own n8n instance.
6. Tokens are stored by Super-MCP; the connector becomes Connected.

## Tools

25 tools, grouped by area. Names match the official docs verbatim.

### Workflow management (10)
- `search_workflows` — Search for workflows with optional filters.
- `get_workflow_details` — Detailed info about a specific workflow including triggers.
- `execute_workflow` — Execute a workflow by ID. Performs full execution, no mocking.
- `get_execution` — Execution details by execution ID and workflow ID.
- `test_workflow` — Test a workflow using pin data to bypass external services.
- `prepare_test_pin_data` — Returns JSON Schemas describing the expected pin-data shape for each node.
- `publish_workflow` — Publish (activate) a workflow for production execution.
- `unpublish_workflow` — Unpublish (deactivate) a workflow.
- `search_projects` — Search for projects accessible to the current user.
- `search_folders` — Search for folders within a project.

### Workflow builder (7)
- `get_sdk_reference` — n8n Workflow SDK reference (patterns, expressions, functions).
- `search_nodes` — Search nodes by service name, trigger type, or utility function.
- `get_node_types` — TypeScript type definitions for n8n nodes.
- `get_suggested_nodes` — Curated node recommendations for workflow technique categories.
- `validate_workflow` — Validate n8n Workflow SDK code; returns JSON if valid or errors to fix.
- `create_workflow_from_code` — Create a workflow from validated SDK code.
- `update_workflow` — Update an existing workflow from validated SDK code.

### Data tables (8)
- `archive_workflow` — Archive a workflow by ID.
- `search_data_tables` — Find data tables accessible to the current user.
- `create_data_table` — Create a new data table with specified columns.
- `add_data_table_column` — Add a new column to an existing data table.
- `rename_data_table_column` — Rename a column in a data table.
- `delete_data_table_column` — Delete a column (permanent — removes data too).
- `rename_data_table` — Rename an existing data table.
- `add_data_table_rows` — Insert rows; each row is an object mapping column names to values.

## Known risks

- **Direct OAuth + no pre-registered `oauthClientId`**: If the n8n instance's MCP server doesn't advertise OAuth Dynamic Client Registration (DCR) via its `.well-known/oauth-authorization-server` metadata, Super-MCP can't complete the handshake and the user will hit a 5-minute timeout. We've trusted n8n's docs claim of OAuth2 support; smoke-test against a real instance before declaring this stable. The same risk is flagged for Zapier in `src/shared/__tests__/connectorCatalog.test.ts`.
- **Version drift**: Pre-April-2026 n8n instances return 404 at `/mcp-server/http`. The setup copy mentions this, but there's no version probe — users may report "MCP failed to connect" without realising their n8n is too old.
- **No identity correlation**: `accountIdentity: "none"` — we don't track which n8n account is connected. Multi-account users will need to manage this manually.

## Related work

- Planning doc: `docs/plans/260512_n8n_official_mcp_and_setupfield_oauth_propagation.md`
- Save-path propagation fix: `src/renderer/features/settings/components/ExpandedConnectionCard.tsx` (`handleSetupSave`, `if (baseConfig)` branch)
- Regression guard: `src/renderer/features/settings/components/__tests__/ExpandedConnectionCard.saveRoute.test.tsx` — `[direct + oauth + setupFields URL]` test
- Brand icon: `src/renderer/assets/brand/n8n.svg` (icon-only path from the n8n logomark)

## References

- [n8n MCP server overview](https://docs.n8n.io/advanced-ai/mcp/accessing-n8n-mcp-server/) — endpoint shape, auth options
- [n8n Workflow SDK reference](https://docs.n8n.io/advanced-ai/mcp/n8n-mcp-server-tools/) — full tool docs
- [n8n release notes](https://docs.n8n.io/release-notes/) — confirm which version first shipped MCP
