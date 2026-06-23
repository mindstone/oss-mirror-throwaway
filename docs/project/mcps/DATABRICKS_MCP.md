---
description: "Databricks MCP connector reference — community npx server, PAT setup, SQL warehouse queries, Unity Catalog tools"
last_updated: "2026-02-19"
---

# Databricks MCP

Connect Rebel to Databricks for SQL warehouse queries and Unity Catalog exploration.

| Property | Value |
|----------|-------|
| **Status** | Added Feb 2026 |
| **Type** | Community MCP (npx) |
| **Provider** | characat0 |
| **Source** | https://github.com/characat0/databricks-mcp-server |
| **npm** | `databricks-mcp-server@0.0.10` |
| **License** | MIT |
| **Auth** | Personal Access Token |
| **Tools** | 5 |


## Overview

Databricks MCP enables querying SQL warehouses and exploring Unity Catalog metadata through natural language. Users can list catalogs, schemas, and tables, execute SQL queries, and discover available SQL warehouses.


## Setup

### Prerequisites

- Node.js 18+ installed on your machine
- A Databricks workspace with Personal Access Token authentication enabled
- `CAN_USE` permission on at least one SQL Warehouse

### Step 1: Generate a Personal Access Token

1. Sign in to your Databricks workspace
2. Go to **User Settings** > **Developer** > **Access Tokens**
3. Click **Generate New Token**
4. Name it (e.g., `Rebel AI`) and set an expiry
5. Copy the token immediately — it won't be shown again

**Official docs**: [Databricks Personal Access Tokens](https://docs.databricks.com/en/dev-tools/auth/pat.html)

### Step 2: Add Connection in Rebel

1. Go to **Settings** > **Connectors**
2. Find **Databricks** and click **+ Add**
3. Fill in:
   - **Workspace URL**: Your full Databricks workspace URL (e.g., `https://your-workspace.cloud.databricks.com`)
   - **Personal Access Token**: The token from Step 1


## Tools

| Tool | Description |
|------|-------------|
| `list_catalogs` | List all Unity Catalogs in the workspace |
| `list_schemas` | List schemas in a specified catalog |
| `list_tables` | List tables in a schema (supports regex filtering) |
| `execute_sql` | Execute SQL statements on a SQL warehouse |
| `list_warehouses` | List available SQL warehouses |


## Troubleshooting

### "Authentication failed" or "Invalid token"

- Verify your token hasn't expired (tokens can have expiry dates)
- Check the workspace URL includes `https://` and has no trailing slash
- Regenerate the token if it may have been revoked

### "No SQL warehouse available"

- Use `list_warehouses` to see available warehouses
- Ensure your token has `CAN_USE` permission on at least one SQL warehouse
- Check if the warehouse is running (stopped warehouses can't execute queries)

### SQL query timeout

- The default timeout is 60 seconds
- For long-running queries, consider breaking them into smaller operations
- Check warehouse auto-stop settings — the warehouse may need to start up first

### Connection timeout on first use

- First invocation downloads the Go binary via npm — this may take a moment
- Subsequent uses will be faster (binary is cached by npm)


## References

- [characat0/databricks-mcp-server](https://github.com/characat0/databricks-mcp-server) — Source repository
- [npm: databricks-mcp-server](https://www.npmjs.com/package/databricks-mcp-server) — npm package
- [Databricks PAT docs](https://docs.databricks.com/en/dev-tools/auth/pat.html) — Token generation guide
- [Databricks SQL docs](https://docs.databricks.com/en/sql/index.html) — SQL warehouse documentation
