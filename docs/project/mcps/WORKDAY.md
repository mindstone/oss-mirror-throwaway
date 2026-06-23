---
description: "Workday bundled MCP connector — read-only HCM worker and organisation access, dual OAuth grants, field allowlisting, tools"
last_updated: "2026-05-14"
---

# Workday MCP

**Status**: Beta
**Provider**: Bundled (`resources/mcp/workday/`)
**Auth**: OAuth 2.0 (dual grant: client_credentials + refresh_token)
**Linear**: FOX-2644

## See Also

- [MCP_ARCHITECTURE.md](../MCP_ARCHITECTURE.md) — General MCP configuration and discovery
- [MCP_IMPROVEMENT_WORKFLOW.md](../MCP_IMPROVEMENT_WORKFLOW.md) — Development workflow for MCP improvements
- API docs: [Workday REST API](https://community.workday.com/sites/default/files/file-hosting/restapi/index.html)
- Source code: `resources/mcp/workday/`
- Planning doc: `docs/plans/finished/260224_workday_mcp_connector.md`


## Overview

Read-only Workday HCM integration providing worker directory, employee profiles, and organizational structure access via the Workday REST API v1.

| Attribute | Value |
|-----------|-------|
| **Provider** | Bundled MCP |
| **Auth** | OAuth 2.0 (dual: client_credentials + refresh_token) |
| **Data flow** | Local only |
| **Setup** | Enter host, tenant, client ID, client secret, and optional refresh token |
| **Category** | Productivity (HR) |
| **Catalog ID** | `bundled-workday` |


## Architecture

- Single-file TypeScript MCP: `resources/mcp/workday/src/index.ts`
- Direct `fetch()` calls to Workday REST API v1
- OAuth 2.0 authentication with dual grant type support
- Token endpoint: `https://{host}/ccx/oauth2/{tenant}/token`
- API base: `https://{host}/ccx/api/v1/{tenant}/{resource}`
- Bridge endpoints for credential configuration and refresh token rotation persistence


## Authentication

### OAuth 2.0 Dual Grant Flow

Five configuration fields: `host`, `tenant`, `clientId`, `clientSecret`, `refreshToken` (optional).

**Grant type selection:**
- If `refreshToken` is provided → uses `refresh_token` grant with automatic rotation persistence
- If `refreshToken` is absent → uses `client_credentials` grant

**Token management:**
- Token cached in-memory with 60s early expiry (avoids edge-case failures near expiry)
- Auth header: `Basic base64(clientId:clientSecret)`
- Rotated refresh tokens persisted via bridge endpoint (`/bundled/workday/update-refresh-token`)

### Environment Variables

| Variable | Required | Description |
|----------|----------|-------------|
| `WORKDAY_HOST` | Yes | Workday API domain (e.g., `wd5-services1.workday.com`) |
| `WORKDAY_TENANT` | Yes | Customer tenant name (e.g., `acme_corp`) |
| `WORKDAY_CLIENT_ID` | Yes | From Workday API Client registration |
| `WORKDAY_CLIENT_SECRET` | Yes | From Workday API Client registration |
| `WORKDAY_REFRESH_TOKEN` | No | Pre-generated refresh token tied to ISU |


## Connector Catalog Entry

```json
{
  "id": "bundled-workday",
  "name": "Workday",
  "provider": "bundled",
  "category": "productivity",
  "maturity": "beta",
  "bundledConfig": {
    "authType": "api-key",
    "settingsKey": "workday.enabled",
    "serverName": "Workday",
    "setupToolName": "configure_workday_credentials"
  }
}
```


## Tools (4)

### Configuration

| Tool | Description |
|------|-------------|
| `configure_workday_credentials` | Configure OAuth credentials (host, tenant, client_id, client_secret, refresh_token?) |

### Workers

| Tool | Description | Key Parameters |
|------|-------------|----------------|
| `list_workday_workers` | List/search workers (employees + contingent workers) | `search?`, `limit?`, `offset?` |
| `get_workday_worker` | Get worker profile by ID | `worker_id` |

### Organizations

| Tool | Description | Key Parameters |
|------|-------------|----------------|
| `list_workday_organizations` | List organizations (departments, supervisory orgs) | `limit?`, `offset?` |

All data tools are **read-only**. No write operations in v1.


## Security

### Allowlisted Response Fields

All responses use strict field **allowlisting** (not blocklist). Only known-safe fields are returned.

**Worker list fields (compact):**
`id`, `descriptor`, `primaryWorkEmail`, `businessTitle`, `isManager`, `location.descriptor`, `supervisoryOrganization.descriptor`

**Worker detail fields (full profile):**
`id`, `descriptor`, `primaryWorkEmail`, `businessTitle`, `isManager`, `location`, `supervisoryOrganization`, `yearsOfService`, `href`

### Sensitive Fields Never Returned

SSN, taxId, bankAccount, personalEmail, personalPhone, dateOfBirth, salary, compensation details, home address, ethnicity, disability status, gender identity, marital status, emergency contacts, national IDs, tax/bank info.

### SSRF Prevention

Host URL validation blocks:
- Non-HTTPS URLs
- `localhost`, `127.0.0.1`, `[::1]`
- Private IP ranges: `10.x`, `172.16–31.x`, `192.168.x`, `169.254.x`, `0.x`

Host URLs are normalized (protocol prefix and trailing slashes stripped).


## Setup Flow

1. Go to **Settings → Connectors** → Find **Workday**
2. Click **Set up**
3. Enter your Workday host domain (e.g., `wd5-services1.workday.com`)
4. Enter your tenant name (e.g., `acme_corp`)
5. Enter your Client ID and Client Secret (from Workday API Client registration)
6. Optionally enter a refresh token (for refresh_token grant flow)
7. Click **Connect** — validates by exchanging credentials for an access token and probing the API


## Technical Details

- **Type**: Bundled MCP (maintained by Mindstone)
- **Transport**: stdio (runs as subprocess)
- **Server script**: `resources/mcp/workday/build/index.js`
- **Rate limits**: Tenant-specific (not publicly documented). 429 responses handled with exponential backoff (1s, 2s, 4s; max 3 retries; respects `Retry-After` header)
- **User-Agent**: `rebel-app/1.0 (Workday-MCP)`
- **Deep-pick filtering**: Nested objects (`location`, `supervisoryOrganization`) are deep-picked to prevent PII leakage


## Bridge Endpoints

| Endpoint | Purpose |
|----------|---------|
| `POST /bundled/workday/configure` | Validates credentials, persists all 5 fields to router config, restarts Super-MCP |
| `POST /bundled/workday/update-refresh-token` | Persists rotated refresh token to router config (no restart needed — MCP has token in memory) |


## Known Limitations

- **Read-only**: No write operations in v1
- **No developer sandbox**: All verification via mock tests only. Exact field names may vary by tenant configuration.
- **Some endpoints may be HCM-only**: REST API availability varies by Workday edition
- **Time-off and compensation deferred**: Planned for v2 (may be SOAP-only in some tenants)
- **Refresh token rotation**: If a rotated token is lost, admin must re-generate. Bridge persistence is best-effort.
- **API response variability**: Field names in Workday REST API responses may differ across tenant configurations


## Testing

```bash
npx vitest run resources/mcp/workday/test-mcp.test.ts
```

14 mock API tests covering:
- Tool listing (4 tools)
- `list_workday_workers` — allowlisted fields, search, pagination
- `get_workday_worker` — detail fields, 404 not found, input validation
- `list_workday_organizations` — fields, pagination
- Sensitive field verification (list + detail responses)
- Refresh token grant type
- Error handling (401 auth error, 429 rate limit)


## Troubleshooting

**"Invalid credentials":**
1. Verify host domain is correct (e.g., `wd5-services1.workday.com`, not `https://...`)
2. Confirm tenant name matches your Workday configuration
3. Check that Client ID and Client Secret are from an active API Client registration
4. If using refresh token, ensure it hasn't expired or been revoked

**"Could not reach Workday":**
1. Verify the host domain is accessible from your network
2. Check for VPN requirements — Workday tenants are often behind corporate networks
3. Ensure the host URL doesn't include protocol prefix (`https://`)

**"Rate limited":**
- Built-in retry logic handles 429 responses automatically (up to 3 retries)
- If persistent, check with your Workday admin about API rate limits for your tenant

**"Endpoint not available":**
- Some REST API endpoints may not be available in all Workday editions
- Check with your Workday admin about which APIs are enabled for your tenant


## Related Files

- MCP server: `resources/mcp/workday/src/index.ts`
- Tests: `resources/mcp/workday/test-mcp.test.ts`
- Catalog entry: `resources/connector-catalog.json` (id: `bundled-workday`)
- Bridge endpoints: `src/main/services/bundledInboxBridge.ts`
- Catalog registration: `src/main/services/bundledMcpManager.ts`
- Planning doc: `docs/plans/finished/260224_workday_mcp_connector.md`
