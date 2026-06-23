---
description: "QuickBooks Online bundled MCP — accounting entities, OAuth-style credential setup, REST API architecture, tools, tests, limitations"
last_updated: "2026-02-20"
---

# QuickBooks Online MCP

**Status**: Active
**Provider**: Bundled (`resources/mcp/quickbooks/`)
**Auth**: API-key style (Client ID + Secret + Refresh Token + Realm ID)
**Linear**: FOX-2585

## Overview

Bundled MCP server for QuickBooks Online accounting. Provides CRUD operations for invoices, bills, customers, vendors, employees, accounts, items, estimates, purchases, and journal entries via the QuickBooks Online REST API v3.

Inspired by the [official Intuit MCP server](https://github.com/intuit/quickbooks-online-mcp-server) (Apache-2.0), but written from scratch using `fetch()` for esbuild compatibility and testability.

## Architecture

- Single-file TypeScript MCP (`src/index.ts`) using `@modelcontextprotocol/sdk`
- Direct `fetch()` calls to QuickBooks Online REST API v3
- OAuth2 token refresh via Intuit's token endpoint
- No external dependencies beyond the MCP SDK
- Bridge endpoint for credential configuration (`/bundled/quickbooks/configure`)

## Tools (14)

| Tool | Description |
|------|-------------|
| `configure_quickbooks` | Configure credentials (Client ID, Secret, Refresh Token, Realm ID) |
| `query_quickbooks` | Run QuickBooks Query Language queries |
| `get_quickbooks_entity` | Get a single entity by type and ID |
| `list_quickbooks_invoices` | List/filter invoices (unpaid, paid, overdue) |
| `list_quickbooks_customers` | List/search customers |
| `list_quickbooks_bills` | List bills (accounts payable) |
| `list_quickbooks_vendors` | List/search vendors |
| `list_quickbooks_accounts` | List chart of accounts by type |
| `list_quickbooks_employees` | List employees |
| `create_quickbooks_invoice` | Create an invoice with line items |
| `create_quickbooks_customer` | Create a customer |
| `create_quickbooks_bill` | Create a bill with line items |
| `create_quickbooks_vendor` | Create a vendor |

## Setup

Users need four credentials from the [Intuit Developer Portal](https://developer.intuit.com/):

1. **Client ID** and **Client Secret** from an Intuit Developer app
2. **Refresh Token** from the OAuth Playground or an OAuth flow
3. **Realm ID** (Company ID) from the QuickBooks Online URL

Refresh tokens expire after 100 days of inactivity. The MCP handles access token refresh automatically.

## API Reference

- Base URL (production): `https://quickbooks.api.intuit.com/v3/company/{realmId}/`
- Base URL (sandbox): `https://sandbox-quickbooks.api.intuit.com/v3/company/{realmId}/`
- Token endpoint: `https://oauth.platform.intuit.com/oauth2/v1/tokens/bearer`
- [API docs](https://developer.intuit.com/app/developer/qbo/docs/api/accounting/all-entities/invoice)

## Testing

```bash
npx vitest run resources/mcp/quickbooks/test-mcp.test.ts
```

Uses mock API tests (`createMcpTestClientWithMockApi`) intercepting QuickBooks API and OAuth endpoints.

## Known Limitations

- No update operations (planned for v2)
- No report generation (P&L, Balance Sheet)
- OAuth setup requires manual credential gathering from Intuit Developer Portal
- Refresh tokens expire after 100 days of inactivity

## Future Improvements

- Full OAuth flow with localhost callback (like Google Workspace)
- Update operations for all entity types
- Financial report tools (P&L, Balance Sheet, Cash Flow)
- Multi-company support
