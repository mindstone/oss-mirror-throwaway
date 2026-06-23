---
description: "Datadog MCP connector reference — community npx server, API and app key setup, observability tools, site configuration"
last_updated: "2026-05-15"
---

# Datadog MCP

Connect Rebel to Datadog for observability monitoring, log search, metrics queries, and incident tracking.

| Property | Value |
|----------|-------|
| **Status** | Beta |
| **Type** | Community MCP (npx) |
| **Provider** | winor30 (community) |
| **Source** | https://github.com/winor30/mcp-server-datadog |
| **Auth** | API Key + Application Key |
| **Tools** | 20 |
| **Version** | 1.7.0 (pinned) |


## Overview

Datadog MCP enables AI-powered interaction with your Datadog observability platform. Query metrics, search logs, list monitors, view dashboards, track incidents, and analyze APM traces through natural language.


## Setup

### Prerequisites

- A Datadog account with API access
- Node.js 18+ installed locally

### Step 1: Generate API and Application Keys

1. Log in to your Datadog organization
2. Go to **Organization Settings → API Keys**
3. Click **New Key**, name it (e.g., "Rebel"), and copy the key
4. Go to **Organization Settings → Application Keys**
5. Click **New Key**, name it, and copy it

> **Important**: The Application Key inherits the permissions of the user who creates it. For full monitoring access, create it with an admin account.

### Step 2: Add Connection in Rebel

1. Go to **Settings → Connectors**
2. Find **Datadog** and click **Set up**
3. Enter your **API Key** and **Application Key**
4. Optionally set your **Datadog Site** if not using US1 (datadoghq.com)

### Datadog Sites

| Site | Value |
|------|-------|
| US1 (default) | `datadoghq.com` |
| US3 | `us3.datadoghq.com` |
| US5 | `us5.datadoghq.com` |
| EU | `datadoghq.eu` |
| AP1 | `ap1.datadoghq.com` |
| US1-FED | `ddog-gov.com` |

Leave the site field empty for US1 (the default).


## Key Tools

| Tool | Description |
|------|-------------|
| `get_monitors` | Fetch monitor statuses, filter by name/tags/state |
| `get_logs` | Search and retrieve logs with query syntax |
| `query_metrics` | Query metrics data with time range |
| `list_dashboards` | List dashboards, filter by name/tags |
| `get_dashboard` | Get specific dashboard details |
| `list_incidents` | Retrieve incidents list |
| `get_incident` | Get detailed incident information |
| `list_traces` | Search APM traces |
| `get_hosts` | List infrastructure hosts |
| `create_monitor` | Create a new monitor |
| `update_monitor` | Update an existing monitor |
| `schedule_downtime` | Schedule monitor downtime |
| `get_rum_events` | Search RUM events |


## Usage Examples

- "Show me all alerting monitors"
- "Search error logs from the last hour"
- "Query CPU utilization metrics for the production cluster"
- "List my dashboards tagged with 'team:backend'"
- "What incidents are currently open?"


## Troubleshooting

### "Authentication failed"

- Verify both API Key and Application Key are correct
- API Key and Application Key are different — you need both
- Check that keys haven't been revoked in Datadog settings

### "Site not found" or connection errors

- If not on US1, set the Datadog Site field (e.g., `datadoghq.eu`)
- Verify the site value matches your Datadog org's region

### Missing data or "403 Forbidden"

- Application Key permissions depend on the creating user's role
- Ensure the user who created the Application Key has access to the resources you're querying


## References

- [winor30/mcp-server-datadog](https://github.com/winor30/mcp-server-datadog) — source repository
- [Datadog API & Application Keys](https://docs.datadoghq.com/account_management/api-app-keys/) — key management docs
- [Planning doc](../../plans/finished/260224_datadog_mcp_connector.md) — implementation decision log
