---
description: "Braze MCP connector reference — Python uvx server, API key setup, read-only analytics functions, cluster URLs, troubleshooting"
last_updated: "2026-02-24"
---

# Braze MCP

Community Python MCP connector for the Braze customer engagement platform. Read-only access to marketing analytics data.

## Status

| Field | Value |
|-------|-------|
| Provider | Community (Python/uvx) |
| Package | `braze-mcp-server==1.0.4` on PyPI |
| Author | Braze Inc. (official) |
| License | MIT |
| Maturity | Beta |
| Python | 3.12+ |
| Category | Sales |

## Architecture

```
Rebel → Super-MCP → uvx → braze-mcp-server → Braze REST API
```

- **Transport**: stdio via `uvx --native-tls braze-mcp-server==1.0.4`
- **Auth**: API key + REST API base URL (env vars: `BRAZE_API_KEY`, `BRAZE_BASE_URL`)
- **Access**: Read-only, non-PII data only
- **Catalog ID**: `braze`

## Available Tools

The Braze MCP exposes 35+ read-only functions via two meta-tools (`list_functions`, `call_function`):

| Category | Functions |
|----------|-----------|
| Campaigns | list, details, data_series |
| Canvases | list, details, data_summary, data_series |
| Catalogs | list, items, single item |
| CDI | integrations, job sync status |
| Content Blocks | list, info |
| Custom Attributes | get |
| Events | list, data_series, get |
| KPIs | new users, DAU, MAU, uninstalls |
| Messages | scheduled broadcasts |
| Preference Centers | list, details |
| Purchases | product list, revenue series, quantity series |
| Segments | list, data_series, details |
| Sends | data_series |
| Sessions | data_series |
| SDK Auth Keys | get |
| Subscriptions | user groups, group status |
| Templates | email list, email info |

## Setup

1. In Braze, go to **Settings > APIs and Identifiers > API Keys**
2. Create a new API key with read-only permissions
3. Note your REST API URL (varies by cluster, e.g., `https://rest.iad-01.braze.com`)
4. In Rebel, go to Settings > Connectors > Braze and enter both values

### Braze REST API URLs by Cluster

| Instance | REST Endpoint |
|----------|--------------|
| US-01 | `https://rest.iad-01.braze.com` |
| US-02 | `https://rest.iad-02.braze.com` |
| US-03 | `https://rest.iad-03.braze.com` |
| US-04 | `https://rest.iad-04.braze.com` |
| US-05 | `https://rest.iad-05.braze.com` |
| US-06 | `https://rest.iad-06.braze.com` |
| US-08 | `https://rest.iad-08.braze.com` |
| EU-01 | `https://rest.fra-01.braze.eu` |
| EU-02 | `https://rest.fra-02.braze.eu` |

## Troubleshooting

- **Python version**: Requires 3.12+. Check with `python3 --version`.
- **uvx not found**: Install uv from https://astral.sh/uv
- **Connection errors**: Verify the REST API URL matches your Braze cluster.
- **Permission denied**: Ensure the API key has the required read permissions.

## References

- [Official Braze MCP docs](https://www.braze.com/docs/user_guide/brazeai/mcp_server/)
- [Setup guide](https://www.braze.com/docs/user_guide/brazeai/mcp_server/setup/)
- [Available API functions](https://www.braze.com/docs/user_guide/brazeai/mcp_server/available_api_functions/)
- [PyPI package](https://pypi.org/project/braze-mcp-server/)
