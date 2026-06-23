---
description: "MoEngage MCP connector for campaign analytics — workspace auth, data centers, campaign stats, email/push/SMS tools"
last_updated: "2026-05-15"
---

# MoEngage MCP

Connect Rebel to MoEngage for campaign analytics and performance metrics.

| Property | Value |
|----------|-------|
| **Status** | Added Feb 2026 - Beta |
| **Type** | Community MCP (Python/uvx) |
| **Provider** | MoEngage (official) |
| **Source** | https://pypi.org/project/moengage-mcp-server/ |
| **Auth** | Workspace ID + Campaign Reports API Key |
| **Tools** | 4 |
| **Python Req** | 3.10+ |


## Overview

MoEngage MCP enables AI-powered interaction with MoEngage campaign data. Query campaign statistics, search campaigns by type (email, push, SMS), and analyze marketing performance through natural language.

**Use cases:**
- "Show my active email campaigns"
- "Get campaign stats for the last 30 days"
- "Compare CTR of campaigns abc123 and def456"
- "Find SMS campaigns with 'welcome' in the name"


## Setup

### Prerequisites

- **Python 3.10+** - Check with `python3 --version`
- **uv/uvx** - Install from https://astral.sh/uv
- **MoEngage account** with Campaign Reports API access

### Step 1: Get Credentials from MoEngage

1. Log into [MoEngage Dashboard](https://dashboard.moengage.com/)
2. Navigate to **Settings** > **Account** > **APIs**
3. Copy your **Workspace ID** and **Campaign Reports API Key**
4. Note your data center from the dashboard URL (e.g., `dashboard-02.moengage.com` = DC02)

### Step 2: Add Connection in Rebel

1. Go to **Settings** > **Connectors**
2. Find **MoEngage** and click **Set up**
3. Enter your Workspace ID, API Key, and optionally the Data Center code
4. Click **Connect**


## Tools

| Tool | Description |
|------|-------------|
| `get_campaign_stats` | Fetch performance metrics (delivery rates, CTR, impressions) for up to 50 campaigns by date range |
| `get_email_campaigns` | Search/retrieve email campaign details by ID, name, or status |
| `get_push_campaigns` | Search/retrieve push notification campaign details |
| `get_sms_campaigns` | Search/retrieve SMS campaign details |

### Campaign Stats Metrics

`get_campaign_stats` returns: attempted, sent, failed, impression, click, CTR (%), delivery rate (%), sent rate (%), failure rate (%).

### Campaign Status Values

`DRAFT`, `SCHEDULED`, `ACTIVE`, `PAUSED`, `COMPLETED`, `STOPPED`


## Data Centers

| Code | API Endpoint | Dashboard URL |
|------|-------------|---------------|
| `01` (default) | `api-01.moengage.com` | `dashboard.moengage.com` |
| `02` | `api-02.moengage.com` | `dashboard-02.moengage.com` |
| `03` | `api-03.moengage.com` | `dashboard-03.moengage.com` |
| `04` | `api-04.moengage.com` | `dashboard-04.moengage.com` |
| `05` | `api-05.moengage.com` | `dashboard-05.moengage.com` |
| `06` | `api-06.moengage.com` | `dashboard-06.moengage.com` |


## Troubleshooting

### "Python not found" or "uvx not found"

- Install Python 3.10+ from python.org
- Install uv/uvx: `curl -LsSf https://astral.sh/uv/install.sh | sh`

### Authentication errors

- Verify Workspace ID and API Key are correct
- Ensure API key has Campaign Reports permissions
- Check data center matches your account

### No data returned

- Verify campaign IDs exist in your account
- Check date range includes campaign activity
- Ensure API key has access to requested campaigns


## References

- [PyPI Package](https://pypi.org/project/moengage-mcp-server/) - Official MoEngage MCP server (v0.1.2)
- [MoEngage MCP Blog Post](https://www.moengage.com/blog/introducing-moengage-mcp-server/) - Announcement
- [MoEngage Developer Docs](https://developers.moengage.com/) - API documentation
- [Planning doc](../../plans/finished/260223_moengage_mcp_connector.md) - Implementation decision log
