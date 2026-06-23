---
description: "Guardrails for MCP connector authentication and token lifecycle changes: refresh mechanisms, storage ownership, failure handling, testing, and per-connector risk notes."
last_updated: "2026-05-29"
---

# MCP Connector Auth Token Lifecycle

Read this before changing MCP connector authentication, OAuth scopes, token storage, token refresh, reconnect UX, or connector health checks. Recent connector auth failures have mostly come from treating "OAuth connector" as one mechanism. It is not. Rebel has several token lifecycle models, and each has different failure modes.

## See Also

- [MCP_CONNECTOR_WORKFLOW](MCP_CONNECTOR_WORKFLOW.md) -- where this fits in the connector change process.
- [MCP_SERVER_STANDARD](MCP_SERVER_STANDARD.md) -- implementation standards for token file permissions, atomic writes, logging, and pre-merge checks.
- [OAUTH_CONNECTOR_EXTERNALIZATION_PRINCIPLES](OAUTH_CONNECTOR_EXTERNALIZATION_PRINCIPLES.md) -- provider-specific OAuth constraints and OSS migration policy.
- [MCP_TESTING](MCP_TESTING.md) and [MCP_REBEL_CLI_TESTING](MCP_REBEL_CLI_TESTING.md) -- deterministic harnesses and live Rebel CLI probes.
- `src/main/services/mcpService.ts` -- auth routing: bundled stdio OAuth tools vs Super-MCP HTTP OAuth.
- `super-mcp/src/auth/providers/refreshOnly.ts` and `super-mcp/src/auth/providers/simple.ts` -- generic HTTP OAuth token persistence and silent refresh.
- `src/main/services/oauthRefreshFailureStore.ts` -- current reconnect-needed failure state used by health checks.

## Non-Negotiables

Any change touching connector auth or tokens must answer these before implementation:

1. **Who owns the token file?** Rebel host service, the spawned MCP package, Super-MCP, or a bridge endpoint.
2. **Which refresh mechanism applies?** Generic Super-MCP HTTP OAuth, connector-specific refresh, client-credentials re-mint, password-grant re-mint, static API key, or no refresh.
3. **What happens when refresh fails?** Invalid/revoked refresh tokens must lead to a clear reconnect path. Transient failures must not wipe usable credentials.
4. **How is concurrent refresh handled?** Rotating or single-use refresh tokens need locking, in-flight dedupe, or a disk re-read before spending the refresh token.
5. **Are writes crash-safe and private?** Token files need `0o600`, parent dirs need `0o700`, and rotating-token writes should use temp-file + rename.
6. **What is observable?** Expected auth degradation should be logged structurally and surfaced to users as "reconnect required" where possible. Silent success is not acceptable.
7. **How is it tested?** Cover near-expiry refresh, invalid refresh token, transient refresh failure, missing refresh token, concurrent refresh, and reconnect UX. Add a live CLI probe when real provider auth is involved.

## Mechanism Classes

### 1. Direct HTTP OAuth via Super-MCP

Catalog entries with `mcpConfig.oauth: true` use Super-MCP's generic OAuth support. Rebel calls Super-MCP's `authenticate` path; Super-MCP stores OAuth client info and tokens under `~/.super-mcp/oauth-tokens/` and uses `RefreshOnlyOAuthProvider` during normal connect so saved refresh tokens can renew without opening a browser.

Examples include Notion, Linear, GitHub, Granola, Todoist, Asana, Atlassian, Box, Canva, ClickUp, Cloudflare Workers, Dropbox, Intercom, Miro, Sentry, Stripe, Supabase, Vercel, Webflow, Wix, and the other direct HTTP OAuth catalog entries.

**Do not add per-connector Rebel refresh code for these unless there is a provider-specific reason.** The main risk is observability: generic refresh may fail in Super-MCP without Rebel having a provider-specific health model. If you touch this path, verify that auth failures are visible enough for users to reconnect.

### 2. Rebel-hosted / rebel-oss stdio OAuth

These connectors have host-side auth orchestration or connector-specific token files. Rebel may start the browser and write the initial token; the spawned MCP package may refresh the token later.

Examples: Google Workspace, Microsoft 365, HubSpot, Slack, Salesforce, Outreach, Zendesk.

**Do not assume these share a token schema.** Each provider has different expiry fields, refresh-token semantics, scope behavior, and identity keys.

### 3. Credential grant / no refresh token

Some connectors do not receive OAuth refresh tokens. They store service credentials and re-mint short-lived access tokens, or they use a durable API key.

Examples: Vanta uses `client_credentials`; Workday can use either `refresh_token` or `client_credentials`; ProfitSage uses password grant because the provider offers no refresh token; Rebel Community Write uses a Discourse user API key.

These are not "refresh token" connectors. Treat the stored credential as the long-lived secret and protect it accordingly.

## Connector State

| Connector | Lifecycle | Robustness Notes |
|---|---|---|
| Google Workspace | Host writes OAuth token files; MCP refreshes using Google's `refresh_token`. | Strong. Preserves refresh token when Google omits it and distinguishes invalid/revoked refresh from transient failure. Keep scope and granular-consent behavior under test. |
| Microsoft 365 Mail | Shared `microsoft-shared` token provider. | Strong. Uses 5-minute buffer, disk re-read before refresh, and shared token files. Changes affect all Microsoft connectors. |
| Microsoft 365 Calendar | Same shared Microsoft provider. | Strong, but calendar sync also has separate refresh-failure health state; keep those paths aligned. |
| OneDrive | Same shared Microsoft provider. | Strong. Same shared-account caveat. |
| Teams | Same shared Microsoft provider. | Strong. Same shared-account caveat. |
| SharePoint | Same shared Microsoft provider plus incremental SharePoint scope handling. | Good, but scope preservation is the fragile part. Reconnect and incremental-consent tests matter. |
| HubSpot | Connector-specific refresh in the HubSpot MCP. | Good. Uses refresh locking and preserves portal metadata. Scope drift and HubSpot portal permissions are the main risk. |
| Slack | Connector-specific token rotation for bot and user tokens when Slack returns refresh tokens. | Mixed but reasonable. Rotating refresh tokens are single-use, so concurrent refresh handling is load-bearing. Non-rotating Slack installs may not have refresh tokens. |
| Salesforce | Connector-specific refresh through `jsforce` using `refresh_token` / `offline_access`. | Good. Depends on client credentials being injected. Keep token filename/account-id compatibility with the OSS package. |
| Outreach | Host stores `refresh_token`; docs say MCP auto-refreshes. | Medium confidence. Refresh tokens expire after 14 days, so reconnect UX matters. Verify against the packaged MCP when changing this area. |
| Zendesk | OAuth token shape exists; docs say MCP auto-refreshes with Zendesk client credentials. | Medium. Catalog still presents this as `api-key`; global OAuth policy changes make this sensitive. Do not change without checking current provider requirements. |
| Workday | Optional refresh-token grant with rotation persistence, otherwise `client_credentials`. | Medium. Refresh-token rotation persistence is best-effort; if a rotated token is lost, an admin may need to regenerate it. |
| Vanta | `client_credentials`; no refresh token. | Solid for service auth. Re-mints short-lived bearer token from stored client credentials. Protect the client secret. |
| ProfitSage | Password grant; no refresh token. | Weakest model, provider-constrained. Stores service username/password and caches short-lived bearer token in memory. Avoid personal credentials. |
| Rebel Community Write | Discourse user API key. | No refresh lifecycle. Stays connected while the user API key remains valid. |
| Direct HTTP OAuth connectors | Super-MCP generic OAuth and refresh. | Good long-term architecture, but provider-specific observability is thin. Confirm refresh-token presence and reconnect behavior with live probes for risky changes. |

## Change Checklist

Before merging an auth/token change:

- [ ] Identify the connector's mechanism class and token owner.
- [ ] Preserve existing refresh tokens when a provider's refresh response omits a new one, unless provider docs explicitly say otherwise.
- [ ] Never wipe token files on network errors, 5xx, malformed JSON, or generic 4xx responses. Wipe only on a classified unrecoverable refresh-token error.
- [ ] Do not log access tokens, refresh tokens, auth codes, client secrets, or raw token endpoint response bodies.
- [ ] Use atomic writes for token updates, especially rotating refresh-token providers.
- [ ] Re-read disk before refresh when multiple MCP processes may share a token file.
- [ ] Add or update tests for success, invalid refresh token, transient failure, missing refresh token, and concurrent refresh.
- [ ] Verify the user-visible reconnect path: Settings card, auth-required message, health check, or setup tool response.
- [ ] Run a live read-only connector probe with [MCP_REBEL_CLI_TESTING](MCP_REBEL_CLI_TESTING.md) when provider auth is available.

## Current Gap

The generic Super-MCP HTTP OAuth path refreshes tokens, but Rebel's provider-specific reconnect health is currently much narrower than the set of OAuth connectors. Google and some Microsoft paths have richer reconnect state; many direct HTTP OAuth connectors rely on generic Super-MCP errors. If auth issues continue, the likely next investment is a common "OAuth refresh degraded" event contract from Super-MCP into Rebel's health/reconnect UI.
