---
description: "ProfitSage / ProfitSword Data Portal v3 MCP — hospitality BI (bundled, per-tenant subdomain)"
last_updated: "2026-04-24"
status: beta
---

# ProfitSage MCP

Bundled MCP exposing ProfitSage (ProfitSword) Data Portal v3 — a hospitality business-intelligence API used by hotel operators. Read-only.

| | |
|---|---|
| **Source** | `resources/mcp/profitsage/` |
| **Generated bundle** | `resources/mcp-generated/profitsage/server.cjs` |
| **Catalog ID** | `bundled-profitsage` |
| **Server name** | `ProfitSage` |
| **Transport** | stdio |
| **Auth** | OAuth2 password grant (RFC 6749 §4.3) with in-process token cache |
| **Credentials** | `PROFITSAGE_SUBDOMAIN`, `PROFITSAGE_USERNAME`, `PROFITSAGE_PASSWORD` |

## Intent & Design Rationale

### Why this MCP exists

Hotel operators use ProfitSage as their source of truth for financials, labor, and sales pace. Rebel needs to answer natural-language questions like "RevPAR for Embassy Suites last month" or "which properties missed labor budget" by querying ProfitSage directly.

### Why generic (not a client-specific connector)

ProfitSage is a multi-tenant SaaS: every hospitality customer gets their own `{subdomain}.profitsage.net` deployment with the same v3 Data Portal surface. Baking any particular tenant's subdomain into the connector would lock us out of every other ProfitSage customer. The connector takes `subdomain` as a first-class setup field so any tenant can plug in their own.

### Why bundled (not Direct / OSS npm)

- **No vendor MCP** — ProfitSword does not publish one.
- **No npm community implementation** found as of Apr 2026.
- The auth flow (password grant → token on every call as a query param, not a header) is unusual enough that reusing a generic OAuth MCP wasn't viable.

### Why OAuth2 password grant (and how we secure it)

ProfitSage's Data Portal v3 only exposes the RFC 6749 §4.3 password grant — there is no authorisation-code flow, refresh token, or API-key endpoint. We therefore store the raw username + password in the router env vars, exchange them for a 1-hour bearer token at first use, and cache the token in-process. Mitigations:

1. **Service accounts, not human logins.** Setup copy explicitly instructs users to use an API-only service account (e.g. `<tenant>_api`), never a personal login.
2. **Subdomain validation** (`^[a-z0-9]([a-z0-9-]*[a-z0-9])?$`) prevents credential exfiltration to an attacker-controlled host if the user types a malformed value. Credentials never leave `*.profitsage.net`.
3. **No logging of password material.** Errors redact the body; the only place the password appears is the outgoing form body to `/PS-Handlers/token`.
4. **Token cache is process-memory only** — no disk persistence, nothing written to logs.

### Rejected alternatives

- **Per-customer hard-coded connectors** — rejected: bloats the catalog, blocks future tenants.
- **Building our own OAuth-passthrough server** — rejected: password grant can't be improved by a proxy, and a custom intermediary adds a credential-theft surface.
- **Reading credentials from a file (like Zendesk's `accounts.json`)** — rejected: no multi-account pattern needed; setup is 3 fields in the UI.

### Constraints to preserve

- **Read-only.** The Data Portal v3 API is read-only; never add write tools that claim to modify ProfitSage state — they will silently fail or hit undocumented endpoints.
- **Subdomain validation.** Do not loosen the regex to accept dots, slashes, or the leading protocol. The guard's whole job is to prevent typos from exfiltrating credentials.
- **ISO dates in, MM/dd/yyyy out.** Callers pass `YYYY-MM-DD` (the Rebel-wide convention); the MCP converts at the boundary. Don't ask the agent to learn ProfitSage's format.
- **Default response shaping** (`include_zeroes=N`, `include_totals=N`, 50 KB soft cap) — P&L endpoints can return megabytes of near-zero rows and flood the agent context. Keep the defaults conservative.
- **Single tenant per install.** The MCP reads `PROFITSAGE_SUBDOMAIN` / `USERNAME` / `PASSWORD` from process env and holds **one** in-process token cache. An install talks to exactly one ProfitSage tenant. If a customer with multiple unrelated ProfitSage tenants appears, we'd need to introduce an accounts-file multi-config pattern (like Zendesk) — do **not** silently conflate tenants by swapping env vars mid-session, because the token cache would serve cross-tenant data until refreshed.
- **Sanitize upstream error bodies.** `psGet` logs full upstream responses to stderr (operator-visible) but surfaces only `HTTP <status>` plus a resolution hint to the model. Raw Data Portal v3 error text occasionally contains SQL fragments or internal stack traces; keep that out of the conversation context.

## Tools (11)

| Tool | Purpose |
|---|---|
| `list_sites` | List hotels / properties (siteTag, siteName, address). Start here. |
| `list_data_sets` | List data sets (e.g. Primary Forecast) for extended reports. |
| `list_account_classes` | List account class / department codes (for `class` / `exclude_class` filters). |
| `get_daily_labor` | Daily labor detail by employee and account (`begin_date`, `end_date`, `site_tag`). |
| `get_daily_extended` | Daily P&L detail (`site_tag`, `data_set_id`, date range). |
| `get_monthly_extended` | Monthly P&L detail (`site_tag`, `data_set_id`, year/month range). |
| `get_ledger_batches` | GL ledger batches by site + date + status + type. |
| `get_sales_bookings` | Sales bookings in a date range (site optional). |
| `get_sales_pace_events` | Sales pace at event level (as-of + date range + site). |
| `get_sales_pace_rooms` | Sales pace by room-nights. |
| `get_sales_pace_transient` | Sales pace for transient (non-group) business. |

All tools return `{ ok: true, endpoint, count, rows }` on success and `{ ok: false, error, code, resolution }` on failure. Responses larger than ~50 KB return a truncated `rows` plus a `hint` pointing the agent at narrower filters.

## Setup

1. Settings → Connectors → ProfitSage.
2. Enter:
   - **Subdomain** (e.g. `acmehotels`) — the label before `.profitsage.net` in your ProfitSage URL.
   - **API username** — use a dedicated service account provisioned by your ProfitSage administrator, never a human login.
   - **API password**.
3. Save. The MCP is now available to agents.

Credentials are stored in the router config (`super-mcp-router.json`) as env vars; they never leave your device except to make calls to your own `*.profitsage.net` tenant.

## Testing

- **Mock-API tests** (CI-safe, no credentials): `npx vitest run resources/mcp/profitsage/test-mcp.test.ts` — 6 tests covering happy path, token caching, refresh-on-401, date conversion, credential and subdomain validation.
- **Live smoke test** (requires `PROFITSAGE_SUBDOMAIN`, `PROFITSAGE_USERNAME`, `PROFITSAGE_PASSWORD` in `.env.local`): `node tmp/agent-tests/profitsage-live-smoke.mjs` — issues `list_sites` + `get_daily_labor` against the configured tenant.

## References

- **API spec:** ProfitSword Data Portal v3. ProfitSword does not publish public docs; the spec is served per-tenant at `https://<your-subdomain>.profitsage.net/PS-Handlers/dataportal/Documentation/v3/index.aspx`. This MCP implements the v3 spec as-is, so any tenant with Data Portal v3 enabled can connect without code changes.
- **Public product page:** https://actabl.com/profitsword/ (used as the card's `verifiedSource`)
- Planning doc: [`docs/plans/260424_profitsage_mcp.md`](../../plans/260424_profitsage_mcp.md)
- Connector catalog entry: `resources/connector-catalog.json` → `bundled-profitsage`
- Payload wiring: `src/main/services/bundledMcpManager.ts` → `BUNDLED_MCP_CATALOG.ProfitSage`
