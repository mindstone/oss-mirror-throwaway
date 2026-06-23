---
description: "Vanta MCP — compliance posture (OSS via @mindstone/mcp-server-vanta, OAuth client_credentials, read+write)"
last_updated: "2026-05-19"
status: beta
---

# Vanta MCP

MCP exposing Vanta compliance APIs — vulnerabilities, tests, controls, evidence, resources, people, vendors, documents, and aggregate compliance summary. Read + write (13 read tools, 5 write tools).

Originally shipped as a bundled connector under `resources/mcp/vanta/`. **Migrated to OSS on 2026-05-19** — the host catalog now launches the connector via `npx -y @mindstone/mcp-server-vanta@0.1.0`. The bundled-source tree has been removed.

| | |
|---|---|
| **Source** | [github.com/mindstone/mcp-servers/connectors/vanta](https://github.com/mindstone/mcp-servers/tree/main/connectors/vanta) |
| **Published** | [@mindstone/mcp-server-vanta on npm](https://www.npmjs.com/package/@mindstone/mcp-server-vanta) |
| **Catalog ID** | `bundled-vanta` (host-side identifier retained for settings-migration compatibility) |
| **Provider** | `rebel-oss` |
| **Server name** | `Vanta` |
| **Transport** | stdio (launched via `npx -y @mindstone/mcp-server-vanta@<pinned-version>`) |
| **Auth** | OAuth `client_credentials` grant |
| **Credentials** | `VANTA_CLIENT_ID`, `VANTA_CLIENT_SECRET`, `VANTA_REGION` |
| **Regions** | US (default), EU, AUS |
| **Migration plan** | [`260519_vanta_oss_migration.md`](../../plans/finished/260519_vanta_oss_migration.md) |

## Intent & Design Rationale

### Why this MCP exists

The official [VantaInc/vanta-mcp-server](https://github.com/VantaInc/vanta-mcp-server) has broken OAuth (Issue #44) and has been unmaintained since Feb 2026. Our bundled connector implements proper OAuth `client_credentials` auth against Vanta's Developer Console.

### Why bundled

- Official Vanta MCP server is broken.
- No working npm community implementation as of May 2026.
- Vanta's Developer Console only provides OAuth app credentials (Client ID + Secret), not simple API keys.

### Auth flow

OAuth `client_credentials` grant via `POST /oauth/token` with scope `vanta-api.all:read`. The API client exchanges the Client ID + Secret for a short-lived Bearer token (1 hour TTL), caches it in memory, and refreshes 5 minutes before expiry. Credentials injected at spawn time via `credentialEnvVars: ['VANTA_CLIENT_ID', 'VANTA_CLIENT_SECRET', 'VANTA_REGION']`.

### Region support

Vanta has three regional deployments with separate API and app domains:

| Region | API base URL | App URL |
|--------|-------------|---------|
| US (default) | `https://api.vanta.com/v1` | `https://app.vanta.com` |
| EU | `https://api.eu.vanta.com/v1` | `https://app.eu.vanta.com` |
| AUS | `https://api.aus.vanta.com/v1` | `https://app.aus.vanta.com` |

The setup UI shows a region dropdown (`VANTA_REGION` env var). `api.ts` resolves the base URL from this value, defaulting to US if unset or unrecognized.

## API Endpoints

All endpoints are GET with cursor-based pagination (`{results:{data,pageInfo}}`):

| Endpoint | Tools |
|----------|-------|
| `/v1/vulnerabilities` | `vanta_list_vulnerabilities`, `vanta_get_vulnerability` |
| `/v1/tests` | `vanta_list_tests`, `vanta_get_test`, `vanta_query_test_results`, `vanta_get_compliance_summary` |
| `/v1/controls` | `vanta_list_controls`, `vanta_get_control` |
| `/v1/resources` | `vanta_list_resources` |
| `/v1/evidence` | `vanta_list_evidence` |
| `/v1/people` | `vanta_list_people` |

## Tool Surface (11 tools)

- **List + Get**: vulnerabilities, tests, controls (6 tools)
- **List only**: resources, evidence, people (3 tools)
- **Query**: `vanta_query_test_results` — tests endpoint with date range filters
- **Composite**: `vanta_get_compliance_summary` — paginates tests and aggregates pass/fail by framework

All tools have `readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true`.

## Design Decisions

- **OAuth client_credentials** — auto-exchanges Client ID + Secret for Bearer token; cached with 5-min-before-expiry refresh
- **Cursor pagination** — `{results:{data,pageInfo}}` unwrapping in API client
- **Rate limiting** — 60 req/60s local tracking + 429 retry with backoff (max 3 retries, `Retry-After` capped at 2 min)
- **Response size** — 25KB tool output cap with truncation hints; 2MB pre-parse body cap
- **ID sanitization** — `^[a-zA-Z0-9_-]+$` regex before direct GET
- **Error sanitization** — Bearer tokens redacted from upstream error messages
- **Composite summary** — paginates up to 5 pages / 500 tests, aggregates by framework, sets `partial: true` if truncated
- **getById fallback** — single-page scan on 404 (full cursor pagination deferred)
- **Query param mapping** — `status`/`framework`/`severity`/`service` → `*Filter` suffix; `date_from`/`date_to` → `dateFrom`/`dateTo` (no suffix)

## Known Limitations

- `/v1/evidence` and `/v1/people` filter parameter names assumed to follow the `*Filter` convention — unverified against live API
- `getById` fallback only searches first page (500 items)
- Rate limiter has check-then-act race under concurrent calls (acceptable for sequential MCP usage)

## Signposting

- **Source (OSS)**: [`github.com/mindstone/mcp-servers/connectors/vanta/src/`](https://github.com/mindstone/mcp-servers/tree/main/connectors/vanta/src)
- **API client (OSS)**: [`connectors/vanta/src/api.ts`](https://github.com/mindstone/mcp-servers/blob/main/connectors/vanta/src/api.ts)
- **Tests (OSS)**: [`connectors/vanta/test/`](https://github.com/mindstone/mcp-servers/tree/main/connectors/vanta/test) (55 mock tests across smoke / security / auth / config)
- **Catalog entry (host)**: `resources/connector-catalog.json` (search `bundled-vanta`; `provider: rebel-oss`, `mcpConfig.args: ['-y', '@mindstone/mcp-server-vanta@0.1.0']`)
- **Catalog wiring (host)**: `mcpConfigManager.ts` (settings-migration map), `connectorIcons.ts`. The legacy `BUNDLED_MCP_CATALOG.Vanta` entry in `bundledMcpManager.ts` was removed by Phase D.
- **Original bundled plan**: `docs/plans/260508_vanta_mcp_connector.md` (historical)
- **Write-tools plan**: `docs/plans/260511_vanta_mcp_write_tools.md` (historical; the 5 write tools landed in the OSS package)
- **OSS migration plan**: [`docs/plans/finished/260519_vanta_oss_migration.md`](../../plans/finished/260519_vanta_oss_migration.md)
