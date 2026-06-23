---
description: "ChartMogul MCP connector reference — Python uvx server, API token setup, subscription analytics tools, testing status"
last_updated: "2026-05-15"
---

# ChartMogul MCP

Connect Rebel to ChartMogul for subscription analytics, revenue metrics, and customer management.

| Property | Value |
|----------|-------|
| **Status** | Added Feb 2026 - Needs end-to-end testing |
| **Type** | Community MCP (Python/uvx) |
| **Provider** | ChartMogul (official) |
| **Source** | https://github.com/chartmogul/chartmogul-mcp-server |
| **License** | MIT |
| **Auth** | API Token |
| **Tools** | 43+ |
| **Python Req** | 3.13+ |


## Overview

ChartMogul MCP enables AI-powered interaction with your subscription analytics. Query revenue metrics (MRR, ARR, churn, LTV), manage customers and subscriptions, track sales opportunities, and automate reporting - all through natural language.

**Use cases:**
- "What was our MRR last month?"
- "Show churn rate by month for Q4"
- "Top 10 customers by ARR"
- "Find customers who churned last week"
- "Create an opportunity for prospect X"


## Setup

### Prerequisites

- **Python 3.13+** - Check with `python3 --version`
- **uv/uvx** - Install from https://astral.sh/uv
- **ChartMogul account** with API access

### Step 1: Generate API Token in ChartMogul

1. Log into [ChartMogul](https://app.chartmogul.com)
2. Go to **Admin** → **API** (or navigate to `#/admin/api`)
3. Copy your API token (or create a new one if needed)

**Note:** The API token grants read/write access. The MCP has no DELETE capabilities built-in, but can create and update records.

### Step 2: Add Connection in Rebel

1. Go to **Settings** → **Connectors**
2. Find **ChartMogul** and click **Set up**
3. Click **Open ChartMogul** to navigate to API settings
4. Paste your API token and click **Connect**


## Tool Categories

The MCP exposes 43+ tools across 8 categories:

### Analytics & Metrics (10 tools)

| Tool | Description |
|------|-------------|
| `all_metrics` | Get all key metrics (MRR, ARR, LTV, etc.) in one call |
| `mrr_metrics` | Monthly Recurring Revenue with movement breakdown |
| `arr_metrics` | Annual Run Rate |
| `arpa_metrics` | Average Revenue Per Account |
| `asp_metrics` | Average Sale Price |
| `customer_count_metrics` | Active customer counts |
| `customer_churn_rate_metrics` | Customer churn rate % |
| `mrr_churn_rate_metrics` | Net MRR churn % |
| `ltv_metrics` | Customer Lifetime Value |
| `get_cfl_fields` | Returns CFL (ChartMogul Filter Language) syntax |

### Customer Management (10 tools)

| Tool | Description |
|------|-------------|
| `list_customers` | List customers with filtering |
| `search_customers` | Search by email |
| `retrieve_customer` | Get full customer profile |
| `create_customer` | Create new customer |
| `update_customer` | Update customer attributes |
| `list_customer_subscriptions` | Get subscriptions for a customer |
| `list_customer_activities` | Get lifecycle events (churn, upgrade, etc.) |
| `list_customer_attributes` | Get tags and custom attributes |
| `add_customer_tags` | Add tags to customer |
| `add_customer_custom_attributes` | Add custom data fields |

### Sales & CRM (8 tools)

| Tool | Description |
|------|-------------|
| `list_opportunities` | List sales opportunities |
| `retrieve_opportunity` | Get opportunity details |
| `create_opportunity` | Create new opportunity |
| `update_opportunity` | Update opportunity status/value |
| `list_tasks` | List CRM tasks |
| `retrieve_task` | Get task details |
| `create_task` | Create new task |
| `update_task` | Update task status |

### Plans (9 tools)

| Tool | Description |
|------|-------------|
| `list_plans` | List subscription plans |
| `retrieve_plan` | Get plan details |
| `create_plan` | Create new plan |
| `update_plan` | Modify plan |
| `list_plan_groups` | List plan groups |
| `retrieve_plan_group` | Get plan group |
| `create_plan_group` | Create plan group |
| `update_plan_group` | Update plan group |
| `list_plan_group_plans` | List plans in a group |

### Contacts & Notes (8 tools)

| Tool | Description |
|------|-------------|
| `list_contacts` | List individuals associated with customers |
| `retrieve_contact` | Get contact details |
| `create_contact` | Add new contact |
| `update_contact` | Modify contact |
| `list_customer_notes` | List notes and call logs |
| `retrieve_customer_note` | Get specific note |
| `create_customer_note` | Add note or call log |
| `update_customer_note` | Edit note |

### Account & Data Sources (3 tools)

| Tool | Description |
|------|-------------|
| `retrieve_account` | Get account info (currency, timezone) |
| `list_sources` | List billing system connections |
| `retrieve_source` | Get specific data source details |

### Data Operations (7 tools)

| Tool | Description |
|------|-------------|
| `list_subscription_events` | Track raw subscription changes |
| `create_subscription_event` | Manually record events |
| `update_subscription_event` | Correct event data |
| `list_invoices` | List invoices |
| `import_invoices` | Bulk import invoices |
| `retrieve_invoice` | Get invoice details |
| `list_activities` | Global revenue activities |


## ChartMogul API Reference

### Authentication

ChartMogul uses HTTP Basic Auth with the API token as username (password can be empty):
```
Authorization: Basic base64(token:)
```

### Rate Limits

- **40 requests/second** - Exceeding returns 429
- **~20 parallel connections** - Exceeding returns 503
- Recommendation: Use exponential backoff

### Data Model Notes

- **Currency values are integer cents** (e.g., $10.00 = `1000`)
- **UUIDs** are used for all entity IDs (e.g., `cus_...`, `pl_...`, `ds_...`)
- **CFL (ChartMogul Filter Language)** - Use `get_cfl_fields` for metrics filtering syntax

### Key Entities

| Entity | Description |
|--------|-------------|
| **Customer** | Parent entity; can have multiple data source customers |
| **Data Source Customer** | Customer record per billing source |
| **Subscription** | Active or cancelled subscription |
| **Plan** | Pricing plan for subscriptions |
| **Invoice** | Billing record |
| **Activity** | Revenue movement (new_biz, expansion, churn, etc.) |


## Safety Constraints

The MCP implements several safety measures:

1. **No DELETE endpoints** - Cannot destroy data
2. **List limits** - Default `limit=20` to prevent token overload
3. **Read-only metrics** - Analytics tools are strictly read-only
4. **Update patterns** - Updates take `data` dictionary, preventing accidental overwrites


## Usage Examples

### Get Monthly Revenue Trends

"What was our MRR over the last 6 months?"

### Analyze Churn

"Show customer churn rate by month for 2025"

### Customer Lookup

"Find customers with ARR over $50,000"

### Sales Pipeline

"List open opportunities created this month"


## Troubleshooting

### "Python not found" or "uvx not found"

- Install Python 3.13+ from python.org
- Install uv/uvx: `curl -LsSf https://astral.sh/uv/install.sh | sh`
- Verify: `python3 --version` and `uvx --version`

### "Authentication failed"

- Check API token is correct (no extra spaces)
- Verify token in ChartMogul Admin → API
- Token may have been regenerated

### "Rate limit exceeded" (429)

- Reduce concurrent requests
- Implement backoff (the MCP handles this automatically for most cases)
- Wait a few seconds and retry

### Tool returns empty results

- Check customer/entity exists with `list_*` tools first
- Verify API token has access to the data
- Check date filters are in correct format (YYYY-MM-DD)

### Metrics filtering not working

- Use `get_cfl_fields` to check valid filter syntax
- CFL format example: `mrr>1000~AND~plan_id=pl_123`


## References

**MCP Implementation:**
- [chartmogul/chartmogul-mcp-server](https://github.com/chartmogul/chartmogul-mcp-server) - Official MCP server (MIT license)
- [PyPI Package](https://pypi.org/project/chartmogul-mcp-server/) - Version 0.3.1+

**ChartMogul Documentation:**
- [API Reference](https://dev.chartmogul.com/reference/) - Full API documentation
- [Getting Started](https://dev.chartmogul.com/docs/) - Guides and tutorials
- [MCP with AI Guide](https://dev.chartmogul.com/docs/using-chartmogul-with-an-ai-assistant-and-mcp/) - Official MCP setup guide
- [Rate Limits](https://dev.chartmogul.com/docs/rate-limits/) - Rate limiting details
- [CFL Documentation](https://dev.chartmogul.com/docs/cfl/) - Filter language syntax

**Internal:**
- [Planning doc](../../plans/finished/260205_chartmogul_mcp_integration.md) - Implementation decision log
