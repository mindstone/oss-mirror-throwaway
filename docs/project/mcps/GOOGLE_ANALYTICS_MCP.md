---
description: "Google Analytics 4 MCP connector — schema discovery, GA4 reporting, admin visibility, ADC auth, catalog wiring"
last_updated: "2026-04-30"
---

# Google Analytics MCP

Google Analytics 4 reporting, schema discovery, and admin visibility, exposed via MCP.

## See Also

- [MCP_ARCHITECTURE.md](../MCP_ARCHITECTURE.md) — how MCPs are configured
- [MCP_OSS_CONNECTORS.md](../MCP_OSS_CONNECTORS.md) — rebel-oss connector pipeline
- [Connector source](https://github.com/mindstone/mcp-servers/tree/main/connectors/google-analytics) — `mindstone/mcp-servers` (rebel-oss)
- [Google Analytics Data API v1beta](https://developers.google.com/analytics/devguides/reporting/data/v1) — official reference
- [Google Analytics Admin API v1beta](https://developers.google.com/analytics/devguides/config/admin/v1) — official reference

## Overview

| Attribute | Value |
|-----------|-------|
| **Provider** | `rebel-oss` |
| **Catalog ID** | `bundled-google-analytics` |
| **Source repo** | [`mindstone/mcp-servers`](https://github.com/mindstone/mcp-servers/tree/main/connectors/google-analytics) |
| **npm package** | `@mindstone-engineering/mcp-server-google-analytics` |
| **Transport** | stdio (`npx -y …`) |
| **Auth** | Google Application Default Credentials (ADC) |
| **Tool count** | 25 (`ga_*` prefix) |
| **Scope** | `https://www.googleapis.com/auth/analytics.readonly` |

## Why this exists

GA4 is a hard schema to navigate by hand. The MCP gives Rebel users:

1. **Schema discovery** — `ga_search_schema`, `ga_list_*_categories`, `ga_check_compatibility` so the agent can find the right `apiName` before calling `ga_run_report`.
2. **Reporting with row-volume safety** — `ga_run_report` estimates row count first, returns a warning above `row_warning_threshold` (default 2500), and supports automatic aggregation suggestions (e.g. swap `date` for `month`) so users don't accidentally pull millions of rows.
3. **Admin visibility** — read-only views into custom dimensions, key events, data streams, BigQuery / Firebase / Google Ads links, retention settings, and change history.

Every tool is `readOnlyHint: true` — this connector cannot mutate GA4 configuration.

## Authentication decision (Option A — ADC, deferred B)

**Shipped (Option A — standard ADC).** The user installs the Google Cloud CLI, runs `gcloud auth application-default login --scopes=https://www.googleapis.com/auth/analytics.readonly,https://www.googleapis.com/auth/cloud-platform`, and pastes the resulting `application_default_credentials.json` path into the connector setup. This is the standard Google approach; documented setup, no Rebel involvement in the OAuth flow.

**Deferred (Option B — bundled OAuth).** A future iteration could mint OAuth tokens inside Rebel using a dedicated client ID with `analytics.readonly`. Two sub-options were considered:

- **B1**: Reuse the existing Google OAuth project; add `analytics.readonly` to the consent screen and re-verify against Google's verification process.
- **B2**: Spin up a separate Google Cloud project with its own OAuth client; full re-verification.

B1 is the lower-friction path but couples GA to the existing Google OAuth state. Both paths require Google verification before broad rollout. Tracked as future work; the rebel-oss server already accepts a service-account JSON via `GOOGLE_APPLICATION_CREDENTIALS`, so a host-managed token file can be wired in without changing the connector.

## Why a Node port (and not Google's Python MCP)

Google Analytics ships an official Python MCP at [googleanalytics/google-analytics-mcp](https://github.com/googleanalytics/google-analytics-mcp). It works but adds a Python/uvx runtime dependency for end users. The Node port (originally written by Peter; ported and cleaned up here) is direct REST against `analyticsadmin.googleapis.com` (v1beta + narrow v1alpha) and `analyticsdata.googleapis.com` (v1beta), with `google-auth-library` for token minting. This keeps the connector inside the Node/npx footprint Rebel already supports.

## API surface

- **Default base URLs:** `analyticsadmin.googleapis.com/v1beta` and `analyticsdata.googleapis.com/v1beta`. v1beta is generally available.
- **v1alpha is opted into narrowly** — only `searchChangeHistoryEvents`, which is not yet promoted to v1beta. Alpha endpoints can change without notice.
- **Pagination:** the admin paginate helper iterates `nextPageToken` for full enumeration; intended for the smaller admin collections (account summaries, properties, links).

## Friendly error mapping

`utils.ts` `mapAuthError` translates common google-auth-library errors into structured `{ ok: false, code, resolution }` JSON:

| Error pattern | Code | Resolution |
|---------------|------|------------|
| `invalid_grant`, `reauth`, `expired` | `CREDENTIALS_EXPIRED` | Re-run `gcloud auth application-default login` |
| `ENOENT` / `no such file` | `CREDENTIALS_FILE_MISSING` | Re-check the absolute path; `~` and `%APPDATA%` are not expanded |
| `PERMISSION_DENIED` | `PERMISSION_DENIED` | Verify GA4 access + APIs enabled in the credential's Cloud project |

`auth.ts` performs path-validation up front: env var must be set, must be absolute, and must point to a readable file — failures surface immediately with structured codes (`CREDENTIALS_NOT_CONFIGURED`, `CREDENTIALS_PATH_NOT_ABSOLUTE`, `CREDENTIALS_FILE_UNREADABLE`).

## Tool inventory (25 total)

### Account & property (3)
`ga_list_account_summaries`, `ga_list_properties`, `ga_get_property_details`

### Schema discovery (8)
`ga_get_metadata`, `ga_get_property_schema`, `ga_search_schema`, `ga_list_dimension_categories`, `ga_list_metric_categories`, `ga_get_dimensions_by_category`, `ga_get_metrics_by_category`, `ga_check_compatibility`

### Reporting (5)
`ga_run_report`, `ga_run_pivot_report`, `ga_batch_run_reports`, `ga_run_realtime_report`, `ga_get_property_quotas_snapshot`

### Admin visibility (9)
`ga_get_custom_dimensions_and_metrics`, `ga_list_google_ads_links`, `ga_list_key_events`, `ga_list_data_streams`, `ga_get_global_site_tag`, `ga_list_bigquery_links`, `ga_get_data_retention_settings`, `ga_list_firebase_links`, `ga_search_change_history_events`

## Catalog wiring

Entry lives at `resources/connector-catalog.json` under `bundled-google-analytics`. Wires:
- `mcpConfig.command: "npx"`, `args: ["-y", "@mindstone-engineering/mcp-server-google-analytics@0.1.0"]`
- Two `setupFields`:
  - `credentialsPath` (text) → `GOOGLE_APPLICATION_CREDENTIALS`
  - `propertyId` (text, optional) → `GA4_PROPERTY_ID`

The npm package must be published before the catalog entry resolves at runtime. Until publish, install locally via `cd connectors/google-analytics && npm install && npm run build` and point the catalog at the local `dist/index.js`.

## Tests

Vitest + msw + the shared `@mindstone-engineering/mcp-test-harness`:
- `test/smoke.test.ts` — tool registration count + read-only annotations
- `test/tools.test.ts` — happy-path calls (account summaries, property details, run_report, search_schema, check_compatibility) and three credential-failure paths

`google-auth-library` is mocked at module load via `test/helpers/mock-auth.ts` so tests never touch real OAuth.
