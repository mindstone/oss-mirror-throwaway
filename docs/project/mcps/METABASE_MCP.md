---
description: "Metabase MCP connector for BI analytics — API key setup, dashboard/query tools, permissions, validation status"
last_updated: "2026-05-15"
---

# Metabase MCP

Connect Rebel to Metabase for BI dashboards, analytics queries, and KPI automation.

| Property | Value |
|----------|-------|
| **Status** | UNTESTED - Needs validation |
| **Type** | Community MCP (npx) |
| **Provider** | CognitionAI (Devin's creators) |
| **Source** | https://github.com/CognitionAI/metabase-mcp-server |
| **Auth** | API Key (preferred) or Username/Password |
| **Tools** | 81+ |


## Overview

Metabase MCP enables AI-powered interaction with your Metabase analytics platform. Query dashboards, execute SQL, manage cards/questions, and automate KPI reporting - all through natural language.


## Setup

### Prerequisites

- **Metabase 49+** (released April 2024) - API keys require this version or later
- **Admin access** to your Metabase instance (to create API keys)
- Node.js 18+ installed on your machine

### Step 1: Generate an API Key in Metabase

API keys are the recommended authentication method. They're more secure than username/password and don't expire with sessions.

1. **Open Admin Settings**
   - Click the **gear icon** (top-right corner of Metabase)
   - Select **Admin settings**

2. **Navigate to API Keys**
   - Go to **Settings** tab (left sidebar)
   - Click **Authentication**
   - Scroll down to **API Keys** and click **Manage**

3. **Create the API Key**
   - Click **Create API Key**
   - **Key name**: Enter something descriptive like `Rebel AI Assistant` or `KPI Automation`
   - **Group**: Select a group that has access to the data you want to query
     - The API key inherits all permissions from this group
     - For read-only access, choose a group with view-only permissions
     - For full access, choose the Administrators group
   - Click **Create**

4. **Copy the Key Immediately**
   - **Important**: Metabase only shows the key once! Copy it now.
   - The key format looks like: `mb_aDqk1Tc4ZotWb2TyjHY71glALKlB+g75dLgmSufWGLc=`
   - Store it securely (password manager, etc.)

> **Tip**: If you lose the key, you'll need to regenerate it (click the key name → Regenerate).

**Official docs**: [Metabase API Keys](https://www.metabase.com/docs/latest/people-and-groups/api-keys)

### Step 2: Add Connection in Rebel

1. Go to **Settings** → **Connectors**
2. Find **Metabase** and click **+ Add**
3. Fill in the configuration:
   - **METABASE_URL**: Your Metabase instance URL
     - Example: `https://analytics.company.com` or `https://metabase.internal.io`
     - Include `https://` but no trailing slash
   - **METABASE_API_KEY**: The key you copied in Step 1

### Alternative: Username/Password Authentication

If you can't create API keys (e.g., not an admin, or using Metabase < 49), you can use username/password as a fallback:

- **METABASE_URL**: Your Metabase instance URL
- **METABASE_USERNAME**: Your Metabase login email
- **METABASE_PASSWORD**: Your Metabase password

Note: This creates session tokens that may expire. API keys are preferred.

### Understanding Permissions

The API key's permissions are determined by its **Group assignment**:

| Group | Access Level |
|-------|--------------|
| Administrators | Full access to all databases, dashboards, and settings |
| All Users | Default access (varies by your Metabase config) |
| Custom Group | Only databases/collections that group can access |

**Best practice**: Create a dedicated group with minimal required permissions, then assign the API key to that group.


## Key Tools

The MCP provides 81+ tools. Here are the most useful for knowledge workers:

### Dashboards

| Tool | Description |
|------|-------------|
| `list_dashboards` | List all dashboards you have access to |
| `get_dashboard` | Get dashboard details by ID |
| `get_dashboard_cards` | Get all cards/questions in a dashboard |
| `execute_dashboard_query` | Execute dashboard queries with parameters |

### Cards/Questions

| Tool | Description |
|------|-------------|
| `list_cards` | List all saved questions/cards |
| `execute_card` | Run a saved question and get results |
| `search_content` | Search across dashboards, cards, and collections |

### Databases & SQL

| Tool | Description |
|------|-------------|
| `list_databases` | List connected databases |
| `execute_query` | Run custom SQL queries |
| `get_database_schema_tables` | Explore database structure |


## Usage Examples

### Check Today's KPIs

"What are the key metrics on the Executive Dashboard?"

### Run a Saved Question

"Execute the 'Monthly Revenue by Region' question"

### Custom SQL Query

"Query the sales database for total orders this week"

### Explore Available Data

"What dashboards do I have access to?"


## Tool Loading Modes

The MCP supports different loading modes for performance optimization:

| Flag | Description |
|------|-------------|
| `--essential` | Default. Load commonly-used tools only |
| `--all` | Load all 81+ tools |
| `--read` | Read-only tools (no modifications) |
| `--write` | Write tools only |

The default `--essential` mode is recommended for most users.


## Troubleshooting

### "Authentication failed" or "Invalid API key"

- **Check key format**: Valid keys start with `mb_` and are 12-254 characters
- **Verify URL**: Include `https://` but no trailing slash (e.g., `https://metabase.company.com`)
- **Key visibility**: If you lost the key, regenerate it in Admin → API Keys → click key name → Regenerate
- **Version check**: API keys require Metabase 49+ (April 2024). Older versions only support username/password

### "403 Forbidden" on some operations

- **Group permissions**: The API key only has access to what its assigned Group can access
- **Admin-only endpoints**: Some operations (like database management) require the key to be in the Administrators group
- **Data permissions**: Check if the Group has access to the specific database/table you're querying

### "Database not found" or empty results

- Use `list_databases` to see what databases the API key can access
- Check Group data permissions in Metabase Admin → Permissions
- Some databases may be hidden from non-admin groups

### "Card/Dashboard not found"

- Use `list_dashboards` or `list_cards` to find correct IDs
- Cards in private collections may not be accessible
- Check if the resource is in a collection your Group can access

### Connection timeout

- Verify Metabase instance is running and accessible from your network
- Check for firewall/VPN requirements
- Try accessing `METABASE_URL` directly in a browser
- For self-hosted: ensure the Metabase server allows external connections

### Key stopped working

- **Group deleted**: If the API key's Group was deleted, Metabase reassigns it to "All Users" (permissions change)
- **Key regenerated**: Someone may have regenerated the key in Admin settings
- **Session expired**: If using username/password auth, tokens expire - switch to API keys

### "Metabase API error" with specific endpoint

- The Metabase API is not versioned and may change between releases
- Check [Metabase API changelog](https://www.metabase.com/docs/latest/api) for breaking changes
- Verify your Metabase version supports the operation


## References

**MCP Implementation:**
- [CognitionAI/metabase-mcp-server](https://github.com/CognitionAI/metabase-mcp-server) - Source repository (81+ tools)

**Metabase Documentation:**
- [API Keys](https://www.metabase.com/docs/latest/people-and-groups/api-keys) - Creating and managing API keys
- [API Reference](https://www.metabase.com/docs/latest/api) - Full API documentation
- [Working with the Metabase API](https://www.metabase.com/learn/metabase-basics/administration/administration-and-operation/metabase-api) - Tutorial and examples
- [Metabase 49 Release Notes](https://www.metabase.com/releases/metabase-49) - API keys feature introduction (April 2024)

**Internal:**
- [Planning doc](../../plans/finished/251224_metabase_mcp_improvements.md) - Implementation decision log
