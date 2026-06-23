---
description: "Xero MCP connector — Mindstone fork, OAuth client credentials, setup, invoice attachment tools, history notes, token caching fix, currency support"
last_updated: "2026-06-09"
---

# Xero MCP

Xero accounting integration. List/create invoices, contacts, payments, quotes, and generate P&L and balance sheet reports.

| Property | Value |
|----------|-------|
| **Status** | Published catalog pin — Mindstone package with token caching, invoice attachments, history notes, and currency-aware invoice writes |
| **Type** | Community MCP (Node.js/npx) |
| **Provider** | Xero (official), via Mindstone fork |
| **Upstream** | https://github.com/XeroAPI/xero-mcp-server (`@xeroapi/xero-mcp-server`) |
| **Fork** | `mcp-servers/connectors/xero` |
| **npm package** | `@mindstone/mcp-server-xero@0.0.17` |
| **License** | MIT |
| **Auth** | OAuth2 Client Credentials (Custom Connection) |
| **Tools** | 50+ |
| **Linear** | FOX-2577 |

## See Also

- [MCP_ARCHITECTURE.md](../MCP_ARCHITECTURE.md) — General MCP configuration and discovery
- [MCP_IMPROVEMENT_WORKFLOW.md](../MCP_IMPROVEMENT_WORKFLOW.md) — Development workflow
- Upstream source: https://github.com/XeroAPI/xero-mcp-server
- Upstream PR: https://github.com/XeroAPI/xero-mcp-server/pull/125
- Xero API docs: https://developer.xero.com/documentation/api/accounting/overview
- Integration test: `scripts/__tests__/xero-token-caching.test.ts`


## Overview

Xero is available as a **community MCP** running via npx. The catalog points at the Mindstone package (`@mindstone/mcp-server-xero@0.0.17`) rather than the official package because the upstream still lacks the full Rebel-required behavior: token caching, invoice attachment tools, PR #145 history/note tools, and currency-aware invoice writes.

| Attribute | Value |
|-----------|-------|
| **Provider** | Community MCP (Mindstone fork) |
| **Auth** | OAuth2 Client Credentials |
| **Data flow** | Direct from user's machine to Xero API |
| **Setup** | Client ID + Client Secret from Xero Developer Portal |
| **Rate limits** | Xero enforces per-app rate limits (minute and daily) |


## Connector Catalog Entry

```json
{
  "id": "xero",
  "name": "Xero",
  "provider": "community",
  "mcpConfig": {
    "transport": "stdio",
    "command": "npx",
    "args": ["-y", "@mindstone/mcp-server-xero@0.0.17"]
  }
}
```

**Switchback**: Only switch back to upstream after upstream includes token caching, invoice attachments, history/note tools, and invoice currency writes. Then change one line:
```json
"args": ["-y", "@xeroapi/xero-mcp-server@<new-version>"]
```


## Setup

### Prerequisites

- Xero account with a **Custom Connection** subscription (~$5/month per connection)
- Xero Demo Company works for free testing

### Steps

1. Go to [Xero Developer Portal](https://developer.xero.com/app/manage)
2. Click **New App** → enter app name (e.g. "Rebel") → select **Custom connection** → enter company URL → Create
3. Select these scopes exactly:
   - Accounting: `accounting.attachments.read`, `accounting.banktransactions`, `accounting.contacts`, `accounting.invoices`, `accounting.manualjournals`, `accounting.payments`, `accounting.settings`
   - Reports: `accounting.reports.aged.read`, `accounting.reports.balancesheet.read`, `accounting.reports.banksummary.read`, `accounting.reports.budgetsummary.read`, `accounting.reports.executivesummary.read`, `accounting.reports.profitandloss.read`, `accounting.reports.taxreports.read`, `accounting.reports.tenninetynine.read`, `accounting.reports.trialbalance.read`
   - Payroll: `payroll.employees`, `payroll.settings`, `payroll.timesheets`
4. Enter the email of a Xero user who can authorise the connection, then save
5. That user receives an email — click **Connect** and select the Xero organisation
6. Copy the **Client ID** and generate a **Client Secret**
7. In Rebel: Settings → Connectors → Xero → paste both values

Available in AU, NZ, UK, and US.


## Mindstone Fork and Currency Support

A Mindstone-scoped package is published from `mcp-servers/connectors/xero` as `@mindstone/mcp-server-xero@0.0.17`. It preserves the previous catalog-pinned `@harrybloom18/xero-mcp-server@0.0.14-fix.4` invoice attachment behavior, preserves the `@harrybloom18/xero-mcp-server@0.0.14-fix.5` history/note tools from [XeroAPI/xero-mcp-server#145](https://github.com/XeroAPI/xero-mcp-server/pull/145), and supports optional `currencyCode` on `create-invoice` and `update-invoice`.

Currency codes are validated against the currencies enabled in the connected Xero organisation before invoice writes. Use `list-currencies` first when a user asks for a non-base currency; Xero's global currency enum includes currencies that may not be enabled for the organisation.

Release verification for `0.0.17` covered `mcp-publisher validate server.json`, `npm audit --audit-level=high --omit=dev`, package build/test/lint, npm publish, npm resolution, a live Xero Demo Company read smoke, a negative `GBP` currency preflight, a positive `USD` draft invoice create, and a published-package MCP stdio smoke.

Existing connected users have a package-rename migration. The generic npx version reconciler only allows this specific `xero` catalog rename from prior Xero package names to `@mindstone/mcp-server-xero`; arbitrary package-name swaps remain blocked.


## Invoice Attachment Tools

Available in the Mindstone package, preserved from the previous `@0.0.14-fix.4` fork. Two read-only tools for accessing files attached to Xero invoices:

| Tool | Description |
|------|-------------|
| `list_xero_invoice_attachments` | List attachments on an invoice (returns fileName, mimeType, contentLength) |
| `download_xero_invoice_attachment` | Download attachment content as base64 (with metadata) |

**Scope requirement**: These tools require the `accounting.attachments.read` scope on the user's Custom Connection. This scope is included in the MCP server's token request. If the user's Xero app doesn't have it enabled, they'll see a clear error message directing them to update their scopes in the Xero Developer Portal.

**File size note**: Attachments can be up to 10MB each. Downloaded content is base64-encoded (~33% larger). Use `list_xero_invoice_attachments` first to check file sizes before downloading.


## Token Caching Fix (FOX-2577)

### The Problem

The upstream `@xeroapi/xero-mcp-server` (as of `@0.0.14`, Feb 2026) calls `authenticate()` before every tool invocation. Each `authenticate()` call makes a fresh HTTP POST to `https://identity.xero.com/connect/token` to fetch a new `client_credentials` token — even though the existing token is still valid (tokens last 30 minutes / 1800s).

This means:
- Every tool call makes a redundant token request to Xero
- In long sessions with many tool calls, this can trigger Xero's rate limiting
- Rate-limited token requests cause "Failed to get Xero token" errors
- Users must manually reconnect to recover

### The Fix

We forked the upstream repo and added **17 lines** to `CustomConnectionsXeroClient` in `src/clients/xero-client.ts`:

1. **`tokenObtainedAt`** / **`tokenExpiresInMs`** fields — track when the token was obtained and its lifetime
2. **`REFRESH_BUFFER_MS = 5 min`** — refresh 5 minutes before actual expiry
3. **`isTokenValid()`** — returns `false` if no token cached or elapsed time exceeds `(expiresInMs - buffer)`
4. **`authenticate()`** early return — skips token fetch if `isTokenValid()` returns `true`
5. After fetching a new token, records `obtainedAt` and reads `expires_in` from Xero's response

**Key behaviours:**
- First call: fetches token normally (no cache yet, `expiresInMs === 0` → `isTokenValid()` returns false)
- Subsequent calls within 25 minutes: returns immediately (cached token still valid)
- After 25 minutes: fetches new token (5-min buffer before 30-min expiry)
- If `expires_in` is missing from response: falls back to fetching every call (safe degradation)

### Upstream PR

Submitted as https://github.com/XeroAPI/xero-mcp-server/pull/125

**When merged**: Change the catalog entry back to `@xeroapi/xero-mcp-server@<new-version>` and deprecate the fork. Run the test scripts in `tmp/agent-tests/xero/` against the new version to confirm the fix is included.

### Fork Maintenance

The old personal fork (`@harrybloom18/xero-mcp-server@0.0.14-fix.4`) was published on npm and pinned to a specific version. It has been superseded by the Mindstone-scoped package.

| Item | Detail |
|------|--------|
| Fork repo | https://github.com/harryblam/xero-mcp-server |
| npm package | `@mindstone/mcp-server-xero@0.0.17` |
| Based on | `@xeroapi/xero-mcp-server@0.0.14` |
| Diff | Token caching, invoice attachment tools, history/note tools, and currency-aware invoice writes |
| Upstream PR | https://github.com/XeroAPI/xero-mcp-server/pull/125 |
| Switchback | One-line change in `resources/connector-catalog.json` |

### Why a fork instead of bundled MCP?

We initially built a full bundled MCP (1,333 LOC) but reverted it because:
- The upstream MCP already has 50+ well-tested tool handlers
- A 17-line fork fix is far simpler to maintain than a parallel implementation
- Switching back to upstream after merge is trivial (one-line catalog change)
- The fork approach avoids duplicating all of Xero's business logic


## Testing

Integration tests live in `scripts/__tests__/xero-token-caching.test.ts` and use the shared MCP test harness. They verify token caching via real MCP tool calls (not internal API inspection).

### Running Tests

```bash
# Run with real Xero Demo Company credentials
XERO_CLIENT_ID=xxx XERO_CLIENT_SECRET=xxx npx vitest run scripts/__tests__/xero-token-caching.test.ts

# Test a different package version (e.g. to verify upstream fix before switching back)
XERO_PACKAGE="@xeroapi/xero-mcp-server@0.0.17" XERO_CLIENT_ID=xxx XERO_CLIENT_SECRET=xxx \
  npx vitest run scripts/__tests__/xero-token-caching.test.ts
```

Tests are skipped automatically when `XERO_CLIENT_ID` / `XERO_CLIENT_SECRET` are not set.

### What the Tests Verify

| Test | What it proves |
|------|---------------|
| Registers tools on startup | Server starts, MCP protocol works, 50+ tools available |
| Lists contacts successfully | First tool call authenticates and returns data |
| Second tool call reuses cached token | No extra auth latency — token was cached |
| Third tool call still uses cached token | Cache persists across multiple calls |

### Test Results (Feb 2026, v0.0.14-fix.4)

Verified end-to-end against Xero Demo Company:
- Token obtained with `expires_in: 1800s` (30 min)
- Subsequent `authenticate()` calls return cached token (no HTTP request)
- Simulated expiry (26min age, 25min threshold) correctly triggers refresh
- Refreshed token is different from original and works for API calls
- Total token fetches across 6 operations: **2** (initial + 1 refresh)

### Using Tests to Validate Upstream Fix

When upstream merges PR #125 and publishes a new version:

1. Run the test against the new version:
   ```bash
   XERO_PACKAGE="@xeroapi/xero-mcp-server@<new-version>" XERO_CLIENT_ID=xxx XERO_CLIENT_SECRET=xxx \
     npx vitest run scripts/__tests__/xero-token-caching.test.ts
   ```
2. If all tests pass, update the catalog entry to point at upstream
3. Deprecate/archive the fork


## Known Limitations

- **Concurrent tool calls**: If multiple tool calls race on token refresh (all see expired token simultaneously), they may each fetch a new token. This is benign — worst case is 2-3 fetches instead of 1, with no correctness issue.
- **Custom Connections only**: The fix applies to `CustomConnectionsXeroClient` (client_credentials flow). `BearerTokenXeroClient` is unaffected (uses externally-managed tokens).
- **No offline support**: Requires internet access for both token fetch and API calls.
