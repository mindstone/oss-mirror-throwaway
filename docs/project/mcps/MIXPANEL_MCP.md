---
description: "Mixpanel MCP — product analytics (bundled, Service Account auth, read-only)"
last_updated: "2026-05-15"
status: beta
---

# Mixpanel MCP

Bundled MCP exposing Mixpanel product-analytics APIs: per-user event lookup, cohort discovery, retention, funnels, saved insights, and Engage (People) profiles. **Read-only.**

| | |
|---|---|
| **Source** | `resources/mcp/mixpanel/` |
| **Generated bundle** | `resources/mcp-generated/mixpanel/server.cjs` |
| **Catalog ID** | `bundled-mixpanel` |
| **Server name** | `Mixpanel` |
| **Transport** | stdio |
| **Auth** | HTTP Basic (Service Account username + secret) |
| **Credentials** | `MIXPANEL_USERNAME`, `MIXPANEL_SECRET`, `MIXPANEL_PROJECT_ID`, `MIXPANEL_REGION` |
| **Regions** | US (default), EU |
| **Linear** | FOX-3135 |
| **Plan** | [`docs/plans/260515_mixpanel_mcp.md`](../../plans/260515_mixpanel_mcp.md) |

## Intent & Design Rationale

### Why this MCP exists

An internal product feeds events into Mixpanel. CS leads frequently need to answer "what did this user do?", "how does this cohort retain?", and "how is the activation funnel performing?" without leaving Rebel. The pre-existing `rebel-system/help-for-humans/Mixpanel-API-access.md` documents a Python script pattern; this MCP supersedes it for agent-driven access.

PostHog is the analytics platform for Rebel's *own* product analytics (separate connector, already in catalog). Mixpanel is for the *internal product's* data — a distinct concern.

### Why bundled

The tool surface needs iteration as we learn which questions CS leads actually ask. In-repo bundled TypeScript gives us a fast dev cycle; externalising to `@mindstone-engineering/mcp-server-mixpanel` is a follow-up once the surface stabilises (the Fathom / Google Analytics migration pattern).

### Why read-only

Mixpanel write APIs (`/import`, `/track`, `/engage` profile updates, cohort edits) are deliberately not exposed. The MCP client class only exposes specific typed read methods — adding a write tool requires adding a new method to the class, which is a much more visible diff than calling a generic helper.

The read-only invariant is enforced two ways: (a) the `MixpanelClient` exposes no `request()` / `post()` / `put()` method, and (b) the test suite asserts the set of registered tool names matches an expected 10-tool allowlist and that no tool name matches write-verb patterns (`track|import|update|delete|merge|set_`).

### Why Service Account auth (not Project Secret, not Personal token)

- Service Account is Mixpanel's documented best practice for programmatic data access.
- Supports per-project scoping (`MIXPANEL_PROJECT_ID` is required and injected on every request by the client).
- Survives user offboarding (unlike Personal tokens).
- Forward-compatible (Project Secret is being deprecated for new projects).

### Region support

| Region | Query host | Export host |
|--------|------------|-------------|
| US (default) | `https://mixpanel.com` | `https://data.mixpanel.com` |
| EU | `https://eu.mixpanel.com` | `https://data-eu.mixpanel.com` |

The hosts are a **closed allowlist** — there is no `MIXPANEL_BASE_URL` env var and no code path that constructs a host from user input. Invalid `MIXPANEL_REGION` values throw `CONFIG_INVALID_REGION` at startup; there is no silent US fallback.

## API Endpoints

| Endpoint family | Mixpanel path | Tools |
|---|---|---|
| Raw Export (NDJSON) | `/api/2.0/export` | `mixpanel_list_events_for_user`, `mixpanel_query_events` |
| Events schema | `/api/2.0/events/names`, `/api/2.0/events/properties/values` | `mixpanel_list_event_names`, `mixpanel_get_event_properties` |
| Cohorts | `/api/2.0/cohorts/list` | `mixpanel_list_cohorts` |
| Retention | `/api/2.0/retention` | `mixpanel_get_retention` |
| Funnels | `/api/2.0/funnels` | `mixpanel_get_funnel` |
| Insights / Bookmarks | `/api/2.0/insights` | `mixpanel_list_insights`, `mixpanel_get_insight` |
| Engage (People) | `/api/2.0/engage` | `mixpanel_get_user_profile` (also used internally for the email→distinct_id bridge) |

JQL (`/api/2.0/jql`) is **deliberately excluded** — Mixpanel has declared it in maintenance mode and recommends discontinuing use.

## Response shape

All tools return JSON with these fields:

- `ok` — boolean
- `summary` — always present, ≤2KB. Top-line counts, date range, top events, etc.
- `count` — record count
- `data` — full payload, omitted by default. Set `return_json: true` (canonical name, not `return_full`) to include.
- `timezone_basis` — `mixpanel_project_timezone` for Export, `utc` for Query API
- `truncated` — true when the hard caps clipped the response
- `truncation_reason` — `event_cap | byte_cap | window_cap`
- `no_match` — true when a query returned zero results (with `ok: true` and `count: 0`)

## Caps & limits

| Cap | Value | Source |
|---|---|---|
| `mixpanel_list_events_for_user` events returned | 100 | DL-5 |
| `mixpanel_query_events` events scanned/returned | 500 | DL-5 |
| `mixpanel_query_events` date window | ≤ 90 days | DL-5 (returns `WINDOW_TOO_WIDE` with `suggested_ranges`) |
| Response body size | 25KB (via binary-search truncation) | DL-5 |
| Pre-parse safety cap | 4MB | client |
| Query API rate limit | 60 req/hr, 5 concurrent | Mixpanel docs |
| Export API rate limit | 30 req/hr (conservative; Mixpanel doesn't publish a hard number) | DL-7 |
| `Retry-After` fast-fail threshold | 30 seconds | DL-7 |
| Query API timeout (default) | 60s — override via `MIXPANEL_REQUEST_TIMEOUT_MS` (5_000–300_000) | DL-11 |
| Export API timeout (default) | 180s — override via `MIXPANEL_EXPORT_TIMEOUT_MS` (30_000–600_000) | DL-11 |

## Email → distinct_id bridge (DL-16)

Mixpanel events typically key on `distinct_id`. Email is stored on the Engage (People) profile, sometimes also on event properties as `$email` or `email`. `mixpanel_list_events_for_user` accepts an `email` argument:

1. If `distinct_id` is provided, use it directly.
2. If only `email` is provided, call Engage first to resolve `distinct_id`.
3. If Engage returns no profile, fall back to filtering events where `properties["$email"] == X or properties["email"] == X`.

The `bridge_used` field on the response (`direct_distinct_id` | `engage_lookup` | `event_property_fallback`) tells the agent which path was taken.

## Structured filter DSL (DL-17)

`mixpanel_query_events` accepts a **constrained** filter schema (no raw `where` strings):

```ts
filters: Array<{
  property: string;          // /^[a-zA-Z0-9_$.\-]+$/, max 100 chars
  op: '==' | '!=' | 'in' | 'not_in' | 'is_set' | 'is_not_set';
  value?: string | number | boolean | Array<string | number | boolean>;
}>
```

Filters are ANDed at the top level. The operator is an enum — never user-supplied text. Values are JSON-stringified into the Mixpanel `where` literal by `buildWhereClause()`; no template concatenation. v1 does not support OR / nesting / contains; agents needing those should use Insights or describe the question in chat for a future tool.

## URL-token redaction (DL-18)

Events from the internal product may include `$current_url` (and other URL-shaped fields) with auth tokens in query params (`?token=…`, `?session=…`, etc.). Before returning events, the client redacts query parameters whose key matches `/(token|key|secret|session|auth|password|code|api_key|access_token|refresh_token)/i` with `__REDACTED__`. The path remains intact. `$ip`, `$email`, and names are retained (same access as the user has in Mixpanel).

## Safety surface (DL-12)

Mixpanel's per-user tools (`mixpanel_list_events_for_user`, `mixpanel_query_events` when filtered to one user, `mixpanel_get_user_profile`) expose PII (emails, names, IPs, properties). The Rebel `toolSafetyService` deterministically bypasses the LLM safety prompt for tool names starting with `list`/`query`/`get` — which all of Mixpanel's tools do. The eval fixture [`evals/fixtures/safety-prompt/168_data-sharing_mixpanel-user-activity-by-email.json`](../../../evals/fixtures/safety-prompt/168_data-sharing_mixpanel-user-activity-by-email.json) documents the expected behaviour: per-user lookups should fire the safety prompt. Modelled on the existing PostHog precedent (`84_data-sharing_posthog-user-activity-by-email.json`).

Changing the deterministic readonly-verb bypass itself is out of scope for v1.

## Troubleshooting

| Symptom | Likely cause | Resolution |
|---|---|---|
| `code: AUTH`, HTTP 401 | Wrong username or secret | Re-enter the Service Account credentials in Settings → Connectors → Mixpanel. |
| `code: AUTH`, HTTP 403 | Wrong `project_id`, or Service Account lacks access to this project | Verify `MIXPANEL_PROJECT_ID` and that the Service Account is added to the project (Mixpanel → Project Settings → Service Accounts). |
| `code: CONFIG_INVALID_REGION` | `MIXPANEL_REGION` is something other than `us` / `eu` | Set the region dropdown to US or EU. |
| `code: RATE_LIMIT` with large `retry_after_seconds` | Mixpanel asked us to wait; we fast-fail rather than block the agent | Wait the indicated duration or narrow the date range. |
| `code: TIMEOUT` | Slow Mixpanel response on Export | Narrow the date range, or raise `MIXPANEL_EXPORT_TIMEOUT_MS` (max 600_000). |
| `no_match: true` (with `ok: true`) | Filters matched nothing | Different from an error — the agent should infer "no such user / events" and offer to broaden filters. |
| `code: WINDOW_TOO_WIDE` | `mixpanel_query_events` window > 90 days | Use the `suggested_ranges` field to narrow into a 30/60/90-day window. |

## Disable / removal

To disable the connector, remove it via Settings → Connectors → Mixpanel → Disconnect. This removes the entry from `super-mcp-router.json`. Removing only the catalog entry would leave orphaned router entries — don't do that without also clearing the router file.

## v1.1 additions (2026-05-15)

- **`mixpanel_get_insight`** — run a saved Mixpanel bookmark by `bookmark_id` and return its computed series (totals + latest values per series). Solves "Average Points Per User"-style saved metrics that aren't funnels. Optional `from_date` / `to_date` override the insight's saved window (90-day cap when both set).
- **`name_contains`** on `mixpanel_list_insights` and `mixpanel_list_cohorts` — optional case-insensitive substring filter applied client-side after fetch. Surfaces `name_filter` and `total_before_filter` in the response summary so the agent can see what was filtered.

### Review-driven hardening (2026-05-16)

After the Light-mode reviewer pair (gpt5.5-high + gemini3.1-pro) approved v1.1 with consensus nits, three follow-up fixes shipped:

- **Pagination warning** on `mixpanel_list_insights` / `mixpanel_list_cohorts` when `name_contains` filters out every row in a full page (`total_before_filter === limit`). The summary `warning` field tells the agent to raise `limit` rather than concluding "no such insight" — Mixpanel pages server-side, so a 0-match on a full page is ambiguous.
- **Unrecognized-shape warning** on `mixpanel_get_insight` when the response doesn't match `series` / `data.series` / `data.values`. Points the agent at the raw `data` field instead of silently reporting `series_count: 0`.
- **`bookmark_id` validation** rejects empty / whitespace strings at the Zod boundary with a clear error.

Deferred to v1.2: `mixpanel_segmentation` (ad-hoc grouped event counts) needs grouping-DSL design work first.

## Related

- [`rebel-system/help-for-humans/connectors/mixpanel.md`](../../../rebel-system/help-for-humans/connectors/mixpanel.md) — user-facing setup guide
- [`rebel-system/help-for-humans/Mixpanel-API-access.md`](../../../rebel-system/help-for-humans/Mixpanel-API-access.md) — legacy Python pattern; agent users should prefer the connector
- [`docs/project/MCP_SERVER_STANDARD.md`](../MCP_SERVER_STANDARD.md) — MCP authoring conventions
