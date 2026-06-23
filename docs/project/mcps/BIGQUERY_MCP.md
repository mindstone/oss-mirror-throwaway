---
description: "BigQuery MCP connector reference — Google MCP Toolbox setup, ADC authentication, SQL tools, project configuration"
last_updated: "2025-12-25"
---

# BigQuery MCP

| Property | Value |
|----------|-------|
| **Provider** | Community (Google MCP Toolbox) |
| **Transport** | stdio via `npx mcp-toolbox` |
| **Auth** | Google Application Default Credentials (ADC) |
| **Status** | UNTESTED - needs validation |

## Overview

BigQuery integration via Google's official MCP Toolbox. Enables running SQL queries, listing datasets/tables, forecasting time series, and conversational analytics on your BigQuery data warehouse.

## Setup Requirements

1. **Google Cloud SDK** - Install `gcloud` CLI from https://cloud.google.com/sdk/docs/install
2. **Application Default Credentials** - Run `gcloud auth application-default login`
3. **IAM Permissions** - User needs `roles/bigquery.user` or `roles/bigquery.dataViewer` on the project
4. **Node.js** - Required for `npx` execution

## Configuration

The connector uses Pattern 4c (community MCP with setup fields):
- `GOOGLE_CLOUD_PROJECT` - GCP Project ID for billing and default BigQuery resources

## Available Tools

Exposed via `mcp-toolbox --prebuilt bigquery`:

| Tool | Description |
|------|-------------|
| `bigquery-sql` | Run SQL queries directly against BigQuery datasets |
| `bigquery-execute-sql` | Execute structured queries with parameters |
| `bigquery-list-dataset-ids` | List available dataset IDs |
| `bigquery-list-table-ids` | List tables in a given dataset |
| `bigquery-get-dataset-info` | Retrieve metadata for a specific dataset |
| `bigquery-get-table-info` | Retrieve metadata for a specific table |
| `bigquery-forecast` | Forecast time series data |
| `bigquery-analyze-contribution` | Perform contribution/key driver analysis |
| `bigquery-conversational-analytics` | Natural language interaction with BigQuery |
| `bigquery-search-catalog` | Search Dataplex Catalog entries (tables, views, models) |

## Authentication

BigQuery MCP uses Google Application Default Credentials (ADC) by default:

```bash
# One-time setup
gcloud auth application-default login
```

This opens a browser OAuth flow. The resulting credentials are stored locally and used automatically by the MCP server.

For service account authentication (CI/CD or server deployments), set:
```bash
export GOOGLE_APPLICATION_CREDENTIALS=/path/to/service-account-key.json
```

## References

- [MCP Toolbox BigQuery Source](https://googleapis.github.io/genai-toolbox/resources/sources/bigquery/)
- [Google Cloud: ADC Setup](https://cloud.google.com/docs/authentication/provide-credentials-adc)
- [BigQuery IAM Roles](https://cloud.google.com/bigquery/docs/access-control)
- [MCP Toolbox GitHub](https://github.com/googleapis/genai-toolbox)
